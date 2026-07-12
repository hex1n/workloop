import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { criterionMetadata, expandWindowsGlobs, mapExecution, runCriterionSource } from "../lib/criterion.mjs";
import { auditLedger, eventId, makeEvent, validateEvent } from "../lib/outcome-ledger.mjs";
import { POLICY_PRESETS, assertTaskSchema, closureProjection, constructPolicy, createTask, criterionDefinitionHash, transition, validatePolicy } from "../lib/task-engine.mjs";
import { archiveIncompatibleState, archiveTask, loadTask, saveTask } from "../lib/task-store.mjs";
import { envelopeOverlap, siblingWorktreeOpenTasks } from "../lib/supervision.mjs";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "taskloop.mjs");
const AT = "2026-07-11T00:00:00.000Z";

function run(args, { cwd = ROOT, env = process.env, input = "" } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8" });
}

function runAsync(args, { cwd = ROOT, env = process.env, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-v1-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.existsSync('done') ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: repo });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, home, env };
}

function open(fx, policy = "default", extra = []) {
  return run(["open", "--repo", fx.repo, "--goal", "finish", "--criterion-file", "check.mjs", "--criterion-policy", policy, ...(policy === "default" ? [] : ["--reason", "policy reason"]), "--alignment-because", "the checker exercises the result", "--not-covered", "deployment", "--files", "work.txt", ...extra], { env: fx.env });
}

function observation(verdict, generation = "g1", artifact = 0) {
  return { observation_id: `o-${Math.random()}`, verdict, criterion_generation_id: generation, observed_artifact_revision: artifact, observed_at: AT, execution: { exit_code: verdict === "satisfied" ? 0 : verdict === "unsatisfied" ? 1 : 2, signal: null, duration_ms: 1, execution_error: verdict === "indeterminate" ? "adapter_indeterminate" : null, output_tail: "" } };
}

function task(overrides = {}) {
  const criterion = { source: { kind: "file", value: "check.mjs" }, protocol: "binary", timeout_seconds: 10, declared_inputs: [{ path: "check.mjs", hash: "h" }], subjects: [], criterion_definition_hash: "sha256:h", criterion_generation_id: "g1", criterion_input_fingerprint: "f", input_coverage: "full", provenance: "repo" };
  return createTask({ taskId: "t1", goal: "g", criterion, observation: observation("unsatisfied"), policyName: "default", at: AT, alignment: { because: "b", not_covered: [] }, envelope: { files: ["**"], git: [], destructive: false, network: false }, budget: { rounds: 8 }, ...overrides });
}

test("policy constructor accepts exactly the three named tuples", () => {
  assert.deepEqual(Object.keys(POLICY_PRESETS), ["default", "deferred_witness", "steady_satisfied"]);
  for (const preset of Object.values(POLICY_PRESETS)) assert.ok(validatePolicy(preset));
  const opens = ["unsatisfied", "determinate"], witnesses = ["required", "none"], closes = ["automatic", "explicit"];
  let accepted = 0;
  for (const open_requirement of opens) for (const witness_requirement of witnesses) for (const close_policy of closes) {
    try { validatePolicy({ open_requirement, witness_requirement, close_policy }); accepted += 1; } catch { /* rejected */ }
  }
  assert.equal(accepted, 3);
  assert.throws(() => validatePolicy({ open_requirement: "determinate", witness_requirement: "none", close_policy: "automatic" }));
});

test("default open witnesses unsatisfied and later satisfied is eligible", () => {
  const initial = task();
  assert.equal(initial.lifecycle.state, "active");
  assert.equal(initial.witness.source_event, "open");
  const next = transition(initial, { type: "observe", source: "stop", observation: observation("satisfied"), drift: [], at: AT }).task;
  assert.deepEqual(closureProjection(next), { state: "eligible" });
});

test("deferred witness holds satisfied until unsatisfied is witnessed", () => {
  const deferred = task({ policyName: "deferred_witness", policyRationale: "test first", observation: observation("satisfied") });
  assert.deepEqual(closureProjection(deferred), { state: "held", reasons: ["unsatisfied_not_witnessed"] });
  const red = transition(deferred, { type: "observe", source: "stop", observation: observation("unsatisfied"), at: AT }).task;
  const green = transition(red, { type: "observe", source: "stop", observation: observation("satisfied"), at: AT }).task;
  assert.deepEqual(closureProjection(green), { state: "eligible" });
});

test("steady satisfied is eligible but explicit", () => {
  const steady = task({ policyName: "steady_satisfied", policyRationale: "guard", observation: observation("satisfied") });
  assert.deepEqual(closureProjection(steady), { state: "eligible" });
  assert.equal(steady.policy.close_policy, "explicit");
});

test("closure projects unobserved, unsatisfied, indeterminate, drift and suspended", () => {
  const base = task();
  base.criterion.last_observation = null;
  assert.deepEqual(closureProjection(base), { state: "not_ready", reason: "criterion_unobserved" });
  base.criterion.last_observation = observation("unsatisfied");
  assert.deepEqual(closureProjection(base), { state: "not_ready", reason: "criterion_unsatisfied" });
  base.criterion.last_observation = observation("indeterminate");
  assert.deepEqual(closureProjection(base), { state: "not_ready", reason: "criterion_indeterminate" });
  base.criterion.last_observation = observation("satisfied");
  assert.deepEqual(closureProjection(base, { drift: true }), { state: "held", reasons: ["sensor_drift"] });
  base.lifecycle = { state: "suspended", reason: "stuck", suspended_at: AT, judgment: { remaining: "r", failure: "f", next_action: "n" } };
  assert.equal(closureProjection(base), null);
});

test("weak sensor requires a fresh accepted independent review or provisional", () => {
  const weak = task(); weak.criterion.input_coverage = "unknown"; weak.criterion.provenance = "unresolved"; weak.criterion.last_observation = observation("satisfied");
  assert.deepEqual(closureProjection(weak), { state: "held", reasons: ["weak_sensor_unreviewed"] });
  weak.reviews.push({ criterion_generation_id: "g1", reviewed_task_revision: weak.last_substantive_task_revision, reviewed_artifact_revision: 0, level: "fresh_context", blocking_findings_count: 0 });
  assert.deepEqual(closureProjection(weak), { state: "eligible" });
  assert.deepEqual(closureProjection({ ...weak, reviews: [] }, { provisional: true }), { state: "eligible" });
});

test("review freshness expires after writes and substantive amendments", () => {
  let value = task(); value.criterion.input_coverage = "unknown"; value.criterion.provenance = "unresolved"; value.criterion.last_observation = observation("satisfied");
  const record = { review_id: "r", criterion_generation_id: "g1", reviewed_task_revision: value.last_substantive_task_revision, reviewed_artifact_revision: 0, level: "second_model", reviewer: "other", blocking_findings_count: 0, advisory_findings_count: 1, reviewed_at: AT };
  value = transition(value, { type: "review", record, at: AT }).task;
  assert.equal(closureProjection(value).state, "eligible");
  value = transition(value, { type: "record-write", files: ["x"], at: AT }).task;
  assert.deepEqual(closureProjection(value).reasons, ["weak_sensor_unreviewed"]);
  value = transition(value, { type: "amend", goal: "new", reason: "pivot", at: AT }).task;
  assert.equal(value.last_substantive_task_revision, value.task_revision);
});

test("criterion amend always creates a generation boundary and clears proof", () => {
  const before = task(); before.reviews.push({ level: "fresh_context" });
  const same = { ...before.criterion, criterion_generation_id: "g2", last_observation: undefined };
  const after = transition(before, { type: "amend", criterion: same, reason: "rebind", at: AT }).task;
  assert.equal(after.criterion.criterion_definition_hash, before.criterion.criterion_definition_hash);
  assert.equal(after.criterion.last_observation, null);
  assert.equal(after.witness, null); assert.deepEqual(after.reviews, []);
  assert.deepEqual(closureProjection(after), { state: "not_ready", reason: "criterion_unobserved" });
});

test("only open, stop and achieve observations can witness; verify is inert", () => {
  const deferred = task({ policyName: "deferred_witness", policyRationale: "r", observation: observation("satisfied") });
  assert.equal(transition(deferred, { type: "verify", at: AT }).task.witness, null);
  assert.equal(transition(deferred, { type: "observe", source: "stop", observation: observation("unsatisfied"), at: AT }).task.witness.source_event, "stop");
  assert.equal(transition(deferred, { type: "achieve", observation: observation("unsatisfied"), at: AT }).task.witness.source_event, "achieve");
});

test("achieved binds a fresh satisfied observation; other terminals bypass criterion", () => {
  let value = task();
  value = transition(value, { type: "achieve", observation: observation("satisfied"), drift: [], at: AT }).task;
  assert.equal(value.lifecycle.outcome, "achieved");
  assert.equal(value.lifecycle.closing_observation_id, value.criterion.last_observation.observation_id);
  assert.throws(() => transition(value, { type: "abandon", reason: "x", at: AT }), /immutable/);
  const noNeed = transition(task(), { type: "not-needed", evidence: "read-only proof", at: AT }).task;
  assert.equal(noNeed.lifecycle.outcome, "not_needed");
  const abandoned = transition(task(), { type: "abandon", reason: "superseded", at: AT }).task;
  assert.equal(abandoned.lifecycle.outcome, "abandoned");
});

test("not-needed refuses after a write", () => {
  const written = transition(task(), { type: "record-write", files: ["x"], at: AT }).task;
  assert.throws(() => transition(written, { type: "not-needed", evidence: "x", at: AT }), /writes == 0/);
});

test("lifecycle transition table enforces suspension and terminal guards", () => {
  let value = transition(task(), { type: "suspend", reason: "needs_input", judgment: { remaining: "credential", failure: "auth", next_action: "supply" }, at: AT }).task;
  assert.equal(value.lifecycle.state, "suspended");
  assert.throws(() => transition(value, { type: "record-write", files: [], at: AT }));
  value = transition(value, { type: "resume", reason: "provided", episode: { episode_id: "e", host_session_id: "s", started_at: AT, ended_at: null, start_task_revision: 3, end_task_revision: null, output_tokens_estimate: 0 }, at: AT }).task;
  assert.equal(value.lifecycle.state, "active");
});

test("binary and tri-state execution mapping is exhaustive", () => {
  const result = (status, signal = null, error = null) => ({ status, signal, error, stdout: "", stderr: "", duration_ms: 1 });
  assert.equal(mapExecution(result(0), "binary", 1).verdict, "satisfied");
  assert.equal(mapExecution(result(2), "binary", 1).verdict, "unsatisfied");
  assert.equal(mapExecution(result(0), "tri-state", 1).verdict, "satisfied");
  assert.equal(mapExecution(result(1), "tri-state", 1).verdict, "unsatisfied");
  assert.equal(mapExecution(result(2), "tri-state", 1).execution.execution_error, "adapter_indeterminate");
  assert.equal(mapExecution(result(3), "tri-state", 1).execution.execution_error, "invalid_adapter_exit");
  assert.equal(mapExecution(result(null, null, { code: "ENOENT" }), "binary", 1).execution.execution_error, "command_not_found");
  assert.equal(mapExecution(result(null, "SIGKILL"), "binary", 1).execution.execution_error, "signal:SIGKILL");
  assert.equal(mapExecution(result(null, null, { code: "ETIMEDOUT" }), "binary", 1).execution.execution_error, "timeout");
  assert.equal(mapExecution(result(127), "binary", 1, { shell: true }).execution.execution_error, "command_not_found");
  assert.equal(mapExecution(result(9009), "binary", 1, { shell: true, platform: "win32" }).execution.execution_error, "command_not_found");
});

test("command criteria refuse missing executables as indeterminate", (t) => {
  const fx = fixture(t);
  const opened = run(["open", "--repo", fx.repo, "--goal", "typo", "--criterion", "definitely-not-a-command-xyz", "--criterion-policy", "default", "--alignment-because", "probe", "--files", "work.txt"], { env: fx.env });
  assert.equal(opened.status, 2); assert.match(opened.stderr, /criterion indeterminate|command.not.found/i);
  assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop", "task.json")), false);
});

test("criterion subjects stay inside the envelope and cannot name the checker", (t) => {
  const checker = fixture(t);
  const self = open(checker, "default", ["--criterion-subject", "check.mjs", "--files", "check.mjs"]);
  assert.equal(self.status, 2); assert.match(self.stderr, /cannot be the criterion file/);
  const outside = fixture(t);
  const escaped = open(outside, "default", ["--criterion-subject", "other.txt"]);
  assert.equal(escaped.status, 2); assert.match(escaped.stderr, /outside the envelope/);
});

test("state-directory criterion files are weak sensors, not repository provenance", (t) => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.repo, ".taskloop"), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, ".taskloop", "check.mjs"), "process.exit(0);\n");
  const metadata = criterionMetadata({ source: { kind: "file", value: ".taskloop/check.mjs" }, protocol: "binary", timeoutSeconds: 5, repo: fx.repo });
  assert.equal(metadata.provenance, "state_dir");
  const opened = run(["open", "--repo", fx.repo, "--goal", "guard", "--criterion-file", ".taskloop/check.mjs", "--criterion-policy", "steady-satisfied", "--reason", "guard", "--alignment-because", "probe", "--files", "work.txt"], { env: fx.env });
  assert.equal(opened.status, 0, opened.stderr);
  const achieved = run(["achieve", "--repo", fx.repo], { env: fx.env });
  assert.equal(achieved.status, 2); assert.match(achieved.stderr, /weak_sensor_unreviewed/);
});

test("Windows command preparation expands repository globs without a shell wildcard dependency", (t) => {
  const fx = fixture(t); fs.writeFileSync(path.join(fx.repo, "second.mjs"), "process.exit(0);\n");
  const expanded = expandWindowsGlobs("node *.mjs", fx.repo);
  assert.match(expanded, /check\.mjs/); assert.match(expanded, /second\.mjs/); assert.doesNotMatch(expanded, /\*\.mjs/);
  assert.equal(expandWindowsGlobs("node '*.mjs'", fx.repo), "node '*.mjs'");
});

test("criterion side effects become indeterminate", (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "side.mjs"), "import fs from 'node:fs'; fs.writeFileSync('mutated','x'); process.exit(0);\n");
  const seen = runCriterionSource({ kind: "file", value: "side.mjs" }, fx.repo, 5, "binary");
  assert.equal(seen.verdict, "indeterminate");
  assert.equal(seen.execution.execution_error, "criterion_side_effect");
  assert.deepEqual(seen.changed_paths, ["mutated"]);
});

test("schema v1 rejects every other task shape", () => {
  assert.equal(assertTaskSchema(task()).schema_version, 1);
  assert.throws(() => assertTaskSchema({ version: 1, state: "open" }), /incompatible task schema/);
});

test("incompatible state archival preserves bytes and records a receipt", (t) => {
  const fx = fixture(t); fs.mkdirSync(path.join(fx.repo, ".taskloop")); const raw = '{"version":0,"x":1}\n'; fs.writeFileSync(path.join(fx.repo, ".taskloop", "task.json"), raw);
  assert.throws(() => loadTask(fx.repo), /incompatible/);
  assert.throws(() => archiveIncompatibleState(fx.repo, { reason: "upgrade", grantedBy: "self", at: AT }), /user/);
  const receipt = archiveIncompatibleState(fx.repo, { reason: "upgrade", grantedBy: "user", at: AT });
  assert.equal(fs.readFileSync(path.join(fx.repo, receipt.archive_path), "utf8"), raw);
  assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop", "task.json")), false);
});

test("ledger events use deterministic ids and audit gaps/duplicates/corruption", (t) => {
  const fx = fixture(t); const value = task();
  const payload = { goal: value.goal, policy: value.policy, policy_rationale: null, criterion: {}, alignment: value.alignment, envelope: value.envelope, budget: value.budget };
  const row = makeEvent({ task: value, kind: "task_opened", payload, repoIdentity: "sha256:r", at: AT });
  assert.equal(row.event_id, eventId(value.task_id, value.task_revision, "task_opened"));
  assert.match(row.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(validateEvent(row), null);
  assert.match(validateEvent({ ...row, payload: { ...payload, surprise: true } }), /unknown payload field/);
  const dir = path.join(fx.home, ".taskloop"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "outcomes-v1.jsonl"), JSON.stringify(row) + "\n" + JSON.stringify(row) + "\n{bad\n");
  const oldHome = process.env.HOME; process.env.HOME = fx.home;
  try { const report = auditLedger(); assert.equal(report.exit, 2); assert.equal(report.warnings.length, 1); assert.equal(report.corruptions.length, 1); } finally { process.env.HOME = oldHome; }
});

test("CLI default chain opens unsatisfied and Stop closes only after satisfied", (t) => {
  const fx = fixture(t); const opened = open(fx); assert.equal(opened.status, 0, opened.stderr); assert.match(opened.stdout, /criterion unsatisfied/);
  const stopRed = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) });
  assert.equal(stopRed.status, 0); assert.match(stopRed.stdout, /"decision":"block"/);
  fs.writeFileSync(path.join(fx.repo, "done"), "yes\n");
  const stopGreen = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) });
  assert.equal(stopGreen.status, 0, stopGreen.stderr); assert.equal(stopGreen.stdout, "");
  assert.equal(loadTask(fx.repo).lifecycle.outcome, "achieved");
});

test("CLI deferred-witness chain holds, witnesses, then achieves", (t) => {
  const fx = fixture(t); fs.writeFileSync(path.join(fx.repo, "done"), "yes\n");
  assert.equal(open(fx, "deferred-witness").status, 0);
  let result = run(["achieve", "--repo", fx.repo], { env: fx.env }); assert.equal(result.status, 2); assert.match(result.stderr, /unsatisfied_not_witnessed/);
  fs.rmSync(path.join(fx.repo, "done")); result = run(["achieve", "--repo", fx.repo], { env: fx.env }); assert.equal(result.status, 2);
  fs.writeFileSync(path.join(fx.repo, "done"), "yes\n"); result = run(["achieve", "--repo", fx.repo], { env: fx.env }); assert.equal(result.status, 0, result.stderr);
});

test("CLI steady-satisfied Stop never auto closes and achieve does", (t) => {
  const fx = fixture(t); fs.writeFileSync(path.join(fx.repo, "done"), "yes\n"); assert.equal(open(fx, "steady-satisfied").status, 0);
  const stop = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) }); assert.match(stop.stdout, /explicit achieve required/); assert.equal(loadTask(fx.repo).lifecycle.state, "active");
  assert.equal(run(["achieve", "--repo", fx.repo], { env: fx.env }).status, 0);
});

test("CLI public vocabulary is clean break and info is contract 2", () => {
  const help = run(["help"]); assert.equal(help.status, 0); assert.doesNotMatch(help.stdout, /earn-red|keep-green|\bdone\b|\bred\b|\bgreen\b/);
  const info = JSON.parse(run(["info"]).stdout); assert.equal(info.runtime_contract, 2); assert.equal(info.task_schema_version, 1); assert.equal(info.ledger_event_schema_version, 1); assert.match(info.ledger_path, /outcomes-v1\.jsonl$/);
  assert.notEqual(run(["open", "--earn-red"]).status, 0); assert.notEqual(run(["done"]).status, 0);
});

test("CLI review maps kebab enums and enforces finding counts", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const reviewed = run(["review", "--repo", fx.repo, "--level", "fresh-context", "--reviewer", "peer", "--blocking-findings", "0", "--advisory-findings", "2"], { env: fx.env });
  assert.equal(reviewed.status, 0, reviewed.stderr); assert.equal(loadTask(fx.repo).reviews.at(-1).level, "fresh_context");
  assert.notEqual(run(["review", "--repo", fx.repo, "--level", "fresh-context", "--reviewer", "peer", "--blocking-findings", "-1", "--advisory-findings", "0"], { env: fx.env }).status, 0);
});

test("hook contract is byte-exact for deny, block, and release", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const denied = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "outside.txt") } }) });
  assert.equal(denied.stdout, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"taskloop: write outside envelope: outside.txt"}}\n');
  const blocked = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) }); assert.match(blocked.stdout, /^\{"decision":"block","reason":"taskloop: criterion unsatisfied;/);
  const read = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, tool_name: "Read", tool_input: {} }) }); assert.equal(read.stdout, "");
});

test("round and write budgets deny further writes while reads remain free", (t) => {
  const rounds = fixture(t); assert.equal(open(rounds, "default", ["--rounds", "1"]).status, 0);
  run([], { cwd: rounds.repo, env: rounds.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: rounds.repo }) });
  const roundDenied = run([], { cwd: rounds.repo, env: rounds.env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: rounds.repo, tool_name: "Write", tool_input: { file_path: path.join(rounds.repo, "work.txt") } }) });
  assert.match(roundDenied.stdout, /permissionDecision.*deny/); assert.match(roundDenied.stdout, /round budget exhausted|suspended.*out_of_budget/);
  assert.equal(loadTask(rounds.repo).lifecycle.reason, "out_of_budget");
  const read = run([], { cwd: rounds.repo, env: rounds.env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: rounds.repo, tool_name: "Read", tool_input: {} }) }); assert.equal(read.stdout, "");

  const writes = fixture(t); assert.equal(open(writes, "default", ["--writes", "1"]).status, 0);
  const payload = (name) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: writes.repo, tool_name: "Write", tool_input: { file_path: path.join(writes.repo, name) } });
  assert.equal(run([], { cwd: writes.repo, env: writes.env, input: payload("work.txt") }).stdout, "");
  const writeDenied = run([], { cwd: writes.repo, env: writes.env, input: payload("work.txt") });
  assert.match(writeDenied.stdout, /write budget exhausted/);
});

test("transcript output tokens are counted once and enforce the token budget", (t) => {
  const fx = fixture(t); assert.equal(open(fx, "default", ["--token-budget", "3"]).status, 0);
  const transcript = path.join(fx.root, "transcript.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ message: { usage: { output_tokens: 3 } } }) + "\n");
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, transcript_path: transcript, tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  const denied = run([], { cwd: fx.repo, env: fx.env, input: payload });
  assert.match(denied.stdout, /output-token budget exhausted \(3\/3\)/);
  assert.equal(loadTask(fx.repo).spent.output_tokens_estimate, 3);
  assert.equal(loadTask(fx.repo).episodes.at(-1).output_tokens_estimate, 3);
  run([], { cwd: fx.repo, env: fx.env, input: payload });
  assert.equal(loadTask(fx.repo).spent.output_tokens_estimate, 3);
});

test("token accounting excludes transcript history before open and before a later task", (t) => {
  const fx = fixture(t); assert.equal(open(fx, "default", ["--token-budget", "10"]).status, 0);
  const firstCreated = Date.parse(loadTask(fx.repo).created_at);
  const transcript = path.join(fx.root, "session.jsonl");
  const row = (output_tokens, timestamp) => JSON.stringify({ timestamp, message: { usage: { output_tokens } } }) + "\n";
  fs.writeFileSync(transcript, row(500, new Date(firstCreated - 1000).toISOString()) + row(3, new Date(firstCreated + 1).toISOString()));
  const payload = () => JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, transcript_path: transcript, tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: payload() }).stdout, "");
  assert.equal(loadTask(fx.repo).spent.output_tokens_estimate, 3);
  assert.equal(run(["abandon", "--repo", fx.repo, "--reason", "next"], { env: fx.env }).status, 0);
  assert.equal(open(fx, "default", ["--token-budget", "10"]).status, 0);
  const secondCreated = Date.parse(loadTask(fx.repo).created_at);
  fs.appendFileSync(transcript, row(2, new Date(secondCreated + 1).toISOString()));
  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: payload() }).stdout, "");
  assert.equal(loadTask(fx.repo).spent.output_tokens_estimate, 2);
});

test("joined envelope arguments are rejected and zero-match patterns warn", (t) => {
  const joined = fixture(t);
  const rejected = open(joined, "default", ["--files", "lib/**,tests/**"]);
  assert.equal(rejected.status, 2); assert.match(rejected.stderr, /Repeat --files/);
  const zero = fixture(t);
  const opened = open(zero, "default", ["--files", "future-generated/**"]);
  assert.equal(opened.status, 0, opened.stderr); assert.match(opened.stderr, /matches no current files/);
});

test("sibling worktree tasks are discovered and overlapping envelopes warn", (t) => {
  const fx = fixture(t); const sibling = path.join(fx.root, "sibling");
  assert.equal(spawnSync("git", ["worktree", "add", "-q", "-b", "sibling-test", sibling], { cwd: fx.repo }).status, 0);
  const siblingOpen = run(["open", "--repo", sibling, "--goal", "sibling", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "probe", "--files", "work.txt"], { env: fx.env });
  assert.equal(siblingOpen.status, 0, siblingOpen.stderr);
  const siblings = siblingWorktreeOpenTasks(fx.repo);
  assert.equal(siblings.length, 1); assert.equal(fs.realpathSync(siblings[0].path), fs.realpathSync(sibling)); assert.deepEqual(siblings[0].files, ["work.txt"]);
  assert.deepEqual(envelopeOverlap(["work.txt"], siblings[0].files, fx.repo, sibling), { level: "definite", patterns: ["work.txt"] });
  const primaryOpen = open(fx);
  assert.equal(primaryOpen.status, 0, primaryOpen.stderr); assert.match(primaryOpen.stderr, /definite envelope overlap/);
});

test("wall-clock telemetry advances and user suspension and terminal close episodes", () => {
  const episode = { episode_id: "e", host_session_id: "s", started_at: AT, ended_at: null, start_task_revision: 1, end_task_revision: null, output_tokens_estimate: 0 };
  let value = task({ episodes: [episode] });
  value = transition(value, { type: "record-write", files: ["x"], at: "2026-07-11T00:00:01.000Z" }).task;
  assert.equal(value.spent.wall_clock_ms, 1000);
  value = transition(value, { type: "suspend", reason: "needs_input", judgment: { remaining: "r", failure: "f", next_action: "n" }, closeEpisode: true, at: "2026-07-11T00:00:02.000Z" }).task;
  assert.equal(value.episodes[0].ended_at, "2026-07-11T00:00:02.000Z");
  assert.equal(value.episodes[0].end_task_revision, value.task_revision);
  value = transition(value, { type: "resume", reason: "ready", episode: { ...episode, episode_id: "e2", started_at: "2026-07-11T00:00:03.000Z", start_task_revision: value.task_revision + 1 }, at: "2026-07-11T00:00:03.000Z" }).task;
  value = transition(value, { type: "abandon", reason: "done", at: "2026-07-11T00:00:04.000Z" }).task;
  assert.equal(value.episodes[1].ended_at, "2026-07-11T00:00:04.000Z");
});

test("repeated equivalent failures suspend as stuck before the round cap", (t) => {
  const fx = fixture(t); assert.equal(open(fx, "default", ["--rounds", "8"]).status, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) });
  const state = loadTask(fx.repo); assert.equal(state.lifecycle.state, "suspended"); assert.equal(state.lifecycle.reason, "stuck"); assert.equal(state.spent.rounds, 3);
});

test("command safety and git operations require explicit recorded grants", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const hook = (command) => run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, tool_name: "Bash", tool_input: { command } }) });
  assert.match(hook("rm -rf ./never-executed").stdout, /permissionDecision.*deny/);
  assert.match(hook("git add work.txt").stdout, /git operation.*authorization/i);
  const granted = run(["amend", "--repo", fx.repo, "--git-allowed", "add", "--git-reason", "user requested staging", "--granted-by", "user", "--reason", "authorize git add"], { env: fx.env });
  assert.equal(granted.status, 0, granted.stderr);
  assert.equal(hook("git add work.txt").stdout, "");
  const state = loadTask(fx.repo); assert.ok(state.grants.some((grant) => grant.kind === "git" && grant.scope.includes("add") && grant.granted_by === "user"));
});

test("destructive, network, and install commands require their matching grants", (t) => {
  const denied = fixture(t); assert.equal(open(denied).status, 0);
  const hook = (fx, command) => run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, tool_name: "Bash", tool_input: { command } }) });
  assert.match(hook(denied, "rm -rf ./never-executed").stdout, /destructive grant/);
  assert.match(hook(denied, "curl https://example.invalid/file").stdout, /network grant/);
  assert.match(hook(denied, "npm install never-executed").stdout, /install grant/);

  const allowed = fixture(t);
  const opened = open(allowed, "default", ["--destructive-allowed", "--network-allowed", "--install-scripts-allowed", "--granted-by", "user", "--reason", "explicit test authority"]); assert.equal(opened.status, 0, opened.stderr);
  assert.equal(hook(allowed, "rm -rf ./never-executed").stdout, "");
  assert.equal(hook(allowed, "curl https://example.invalid/file").stdout, "");
  assert.equal(hook(allowed, "npm install never-executed").stdout, "");
  assert.deepEqual(new Set(loadTask(allowed.repo).grants.map((item) => item.kind)), new Set(["destructive", "network", "install"]));
});

test("explicit-policy Stop cannot overwrite a concurrent recorded write", async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "slow.mjs"), "import fs from 'node:fs'; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300); process.exit(fs.existsSync('done') ? 0 : 1);\n");
  fs.writeFileSync(path.join(fx.repo, "done"), "yes\n");
  const opened = run(["open", "--repo", fx.repo, "--goal", "steady", "--criterion-file", "slow.mjs", "--criterion-policy", "steady-satisfied", "--reason", "guard", "--alignment-because", "probe", "--files", "work.txt"], { env: fx.env }); assert.equal(opened.status, 0, opened.stderr);
  const stop = runAsync([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const write = await runAsync([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } }) });
  await stop; assert.equal(write.status, 0); assert.equal(loadTask(fx.repo).artifact_revision, 1);
});

test("no-task multi-file writes retain the untracked task-opening nudge", (t) => {
  const fx = fixture(t); const payload = (file) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "nudge", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, file) } });
  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: payload("one.txt") }).stdout, "");
  fs.writeFileSync(path.join(fx.repo, "one.txt"), "first\n");
  assert.match(run([], { cwd: fx.repo, env: fx.env, input: payload("two.txt") }).stdout, /permissionDecision.*deny/);
});

test("verify never persists ordinary observations or burns rounds", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0); const before = fs.readFileSync(path.join(fx.repo, ".taskloop", "task.json"), "utf8");
  const verified = run(["verify", "--repo", fx.repo], { env: fx.env }); assert.equal(verified.status, 1); assert.equal(fs.readFileSync(path.join(fx.repo, ".taskloop", "task.json"), "utf8"), before);
});

test("CLI side-effect criteria are indeterminate at open, verify, Stop, and achieve", (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "side.mjs"), "import fs from 'node:fs'; fs.writeFileSync('mutation',String(Date.now())); process.exit(0);\n");
  const rejected = run(["open", "--repo", fx.repo, "--goal", "x", "--criterion-file", "side.mjs", "--criterion-policy", "steady-satisfied", "--reason", "guard", "--alignment-because", "x", "--files", "work.txt"], { env: fx.env });
  assert.equal(rejected.status, 2); assert.match(rejected.stderr, /side effects/);
  fs.rmSync(path.join(fx.repo, "mutation"));
  assert.equal(open(fx).status, 0);
  const statePath = path.join(fx.repo, ".taskloop", "task.json"); const active = loadTask(fx.repo); active.criterion.source = { kind: "file", value: "side.mjs" }; active.criterion.declared_inputs = [{ path: "side.mjs", hash: active.criterion.declared_inputs[0].hash }]; saveTask(fx.repo, active);
  const verified = run(["verify", "--repo", fx.repo], { env: fx.env }); assert.equal(verified.status, 2); assert.equal(loadTask(fx.repo).artifact_revision, 1);
  fs.rmSync(path.join(fx.repo, "mutation"));
  const achieved = run(["achieve", "--repo", fx.repo], { env: fx.env }); assert.equal(achieved.status, 2); assert.equal(loadTask(fx.repo).artifact_revision, 2);
  fs.rmSync(path.join(fx.repo, "mutation"));
  const stopped = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) }); assert.match(stopped.stdout, /criterion indeterminate/); assert.equal(loadTask(fx.repo).artifact_revision, 3);
});

test("CLI suspend uses kebab enums while storage uses snake case and Stop releases", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const suspended = run(["suspend", "--repo", fx.repo, "--reason", "needs-input", "--remaining", "credential", "--failure", "auth", "--next-action", "provide"], { env: fx.env });
  assert.equal(suspended.status, 0, suspended.stderr); assert.equal(loadTask(fx.repo).lifecycle.reason, "needs_input");
  const before = fs.readFileSync(path.join(fx.repo, ".taskloop", "task.json"), "utf8");
  const stop = run([], { cwd: fx.repo, env: fx.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo }) }); assert.equal(stop.stdout, ""); assert.equal(fs.readFileSync(path.join(fx.repo, ".taskloop", "task.json"), "utf8"), before);
  assert.equal(run(["resume", "--repo", fx.repo, "--reason", "provided"], { env: fx.env }).status, 0);
});

test("criterion definition hash is stable while generation ids are not", () => {
  const value = task().criterion; assert.equal(criterionDefinitionHash(value), criterionDefinitionHash({ ...value }));
  assert.notEqual(constructPolicy("default"), POLICY_PRESETS.default);
});

test("normal task history archives use task_id rather than legacy and never overwrite", (t) => {
  const fx = fixture(t); const value = task(); archiveTask(fx.repo, value, AT); archiveTask(fx.repo, value, AT);
  const names = fs.readdirSync(path.join(fx.repo, ".taskloop", "history"));
  assert.equal(names.length, 2); assert.ok(names.every((name) => name.includes(value.task_id))); assert.ok(names.every((name) => !name.includes("legacy")));
});
