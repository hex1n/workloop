import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Hex } from "../lib/prims.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
const OPEN_PROVENANCE = ["--reason", "Ticket 03 tracer", "--granted-by", "self"];
const TEST_AUTHORITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-authority-home-"));
process.env.WORKLOOP_AUTHORITY_HOME = TEST_AUTHORITY_HOME;
process.once("exit", () => fs.rmSync(TEST_AUTHORITY_HOME, { recursive: true, force: true }));

function run(args, { cwd = ROOT, input = "", env = { ...process.env, WORKLOOP_SESSION_ID: "session-main" }, platform = null } = {}) {
  const virtualPlatform = platform ? ["--input-type=module", "--eval", [
    `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
    `process.argv = ${JSON.stringify([process.execPath, CLI, ...args])};`,
    `const { main } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "provider-application.mjs")).href)});`,
    "process.exitCode = main();",
  ].join("\n")] : [CLI, ...args];
  return spawnSync(process.execPath, virtualPlatform, { cwd, input, env, encoding: "utf8", timeout: 10_000 });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workloop-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Workloop Test"]);
  git(repo, ["config", "user.email", "workloop@example.invalid"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "tracked.txt"), "tracked\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(repo, "src", "untracked.txt"), "untracked\n");
  fs.mkdirSync(path.join(repo, "ignored"));
  fs.writeFileSync(path.join(repo, "ignored", "ignored.txt"), "ignored\n");
  return { root, repo, gitDir: path.resolve(git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"])), commonDir: path.resolve(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) };
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function openTask(fx, commandId = "open-main") {
  return json(run([
    "open", "--target", path.join(fx.repo, "src", "future.txt"), "--goal", "main tracer",
    "--write-root", "src", "--write-root", "ignored", "--command-id", commandId, ...OPEN_PROVENANCE,
  ], { cwd: fx.root, env: { ...process.env, WORKLOOP_SESSION_ID: "session-main" } }));
}

test("current Git tracer selects containment and replays after disposable projections are removed", (t) => {
  const fx = fixture(t, "replay");
  const opened = openTask(fx);
  assert.equal(opened.provider, "git_common");
  assert.equal(opened.placement, "partitioned");
  assert.equal(opened.routable, true);
  assert.equal(opened.task.goal, "main tracer");
  assert.deepEqual(opened.task.write_claims, [{ kind: "root", path: "ignored" }, { kind: "root", path: "src" }]);
  assert.equal(opened.task.coordinator_session_id, "session-main");
  assert.equal(opened.authority_root, path.join(fx.commonDir, "workloop"));
  assert.equal(opened.attachment_root, fx.gitDir);

  const targets = [
    path.join(fx.repo, "src", "tracked.txt"),
    path.join(fx.repo, "src", "untracked.txt"),
    path.join(fx.repo, "ignored", "ignored.txt"),
    path.join(fx.repo, "src", "never-created", "future.txt"),
  ];
  for (const target of targets) {
    const status = json(run(["status", "--target", target], { cwd: fx.root }));
    assert.equal(status.authority_id, opened.authority_id);
    assert.equal(status.attachment_id, opened.attachment_id);
    assert.equal(status.task.task_id, opened.task.task_id);
    assert.equal(status.routable, true);
  }

  const beforeAudit = json(run(["audit", "--target", targets[0]], { cwd: fx.root }));
  const beforeLedger = json(run(["ledger", "--target", targets[0]], { cwd: fx.root }));
  assert.equal(beforeAudit.integrity, "valid");
  assert.equal(beforeAudit.routable, true);
  assert.deepEqual(beforeLedger.records.map((record) => record.kind), ["authority_genesis", "attachment_stage_intent", "task_open_intent", "attachment_staged", "attachment_claim_pending", "attachment_claimed", "task_opened"]);
  assert.deepEqual(fs.readFileSync(opened.locator_path, "utf8").trim().split("\n").map((line) => JSON.parse(line).state), ["staged", "claimed"]);

  fs.rmSync(opened.snapshot_path, { force: true });
  fs.rmSync(opened.outcome_path, { force: true });
  const rebuilt = json(run(["status", "--target", targets[2]], { cwd: fx.root }));
  assert.equal(rebuilt.task.task_id, opened.task.task_id);
  assert.equal(rebuilt.authority_sequence, beforeLedger.records.length);
  assert.equal(fs.existsSync(opened.snapshot_path), true);
  assert.equal(fs.existsSync(opened.outcome_path), true);
  assert.deepEqual(json(run(["audit", "--target", targets[3]], { cwd: fx.root })).task, beforeAudit.task);
});

test("hard cut exposes only provider Contract verbs and never dispatches the temporary current-* aliases", (t) => {
  const fx = fixture(t, "hard-cut-command");
  const oldAlias = run(["current-open", "--target", path.join(fx.repo, "src", "future.txt")], { cwd: fx.root });
  assert.equal(oldAlias.status, 2);
  assert.match(oldAlias.stderr, /only the provider Contract/);
  const oldRuntime = run(["verify", "--repo", fx.repo], { cwd: fx.root });
  assert.equal(oldRuntime.status, 2);
  assert.match(oldRuntime.stderr, /only the provider Contract/);
  const opened = openTask(fx, "hard-cut-open");
  assert.equal(opened.provider, "git_common");
});

test("incompatible repository artifacts can only be copied opaquely with explicit user provenance", (t) => {
  const fx = fixture(t, "opaque-archive");
  const legacy = path.join(fx.repo, ".workloop");
  fs.mkdirSync(legacy);
  const bytes = "old runtime bytes are opaque\n";
  fs.writeFileSync(path.join(legacy, "events-v3.jsonl"), bytes);
  const denied = run(["archive-incompatible-state", "--target", fx.repo, "--reason", "preserve incompatible bytes", "--granted-by", "self"], { cwd: fx.root });
  assert.equal(denied.status, 2);
  assert.equal(fs.existsSync(path.join(fx.repo, ".workloop-incompatible-archive")), false);
  const archived = json(run(["archive-incompatible-state", "--target", fx.repo, "--reason", "preserve incompatible bytes", "--granted-by", "user"], { cwd: fx.root }));
  const copied = path.join(archived.archive_path, "events-v3.jsonl");
  assert.equal(fs.readFileSync(path.join(legacy, "events-v3.jsonl"), "utf8"), bytes);
  assert.equal(fs.readFileSync(copied, "utf8"), bytes);
  assert.equal(archived.artifacts[0].sha256.length, 64);

  const windowsArchive = json(run(["archive-incompatible-state", "--target", fx.repo, "--reason", "preserve incompatible bytes on Windows", "--granted-by", "user"], { cwd: fx.root, platform: "win32" }));
  assert.equal(fs.readFileSync(path.join(windowsArchive.archive_path, "events-v3.jsonl"), "utf8"), bytes);
});

test("Git outcome shards are per-authority caches: one corrupt or missing shard cannot affect another authority", (t) => {
  const left = fixture(t, "outcome-left");
  const right = fixture(t, "outcome-right");
  const leftOpen = openTask(left, "outcome-left-open");
  const rightOpen = openTask(right, "outcome-right-open");
  assert.notEqual(leftOpen.authority_id, rightOpen.authority_id);
  assert.notEqual(path.dirname(leftOpen.outcome_path), path.dirname(rightOpen.outcome_path));
  const rightLedger = json(run(["ledger", "--target", right.repo])).records;
  const rightOutcome = fs.readFileSync(rightOpen.outcome_path, "utf8");
  fs.writeFileSync(leftOpen.outcome_path, "not-json\n");
  fs.rmSync(leftOpen.outcome_cursor_path, { force: true });
  const rebuilt = json(run(["status", "--target", path.join(left.repo, "src", "future.txt")], { cwd: left.root }));
  assert.equal(JSON.parse(fs.readFileSync(rebuilt.outcome_path, "utf8")).authority_id, leftOpen.authority_id);
  assert.equal(JSON.parse(fs.readFileSync(rebuilt.outcome_cursor_path, "utf8")).source_sequence, rebuilt.authority_sequence);
  assert.deepEqual(json(run(["ledger", "--target", right.repo])).records, rightLedger);
  assert.equal(fs.readFileSync(rightOpen.outcome_path, "utf8"), rightOutcome);
  fs.rmSync(rebuilt.outcome_path, { force: true });
  const replayed = json(run(["status", "--target", path.join(left.repo, "src", "future.txt")], { cwd: left.root }));
  assert.equal(JSON.parse(fs.readFileSync(replayed.outcome_path, "utf8")).authority_id, leftOpen.authority_id);
});

test("append and locator conflicts never fabricate a successful format open", (t) => {
  const locatorFx = fixture(t, "locator-conflict");
  const locator = path.join(locatorFx.gitDir, ".workloop-root.jsonl");
  fs.writeFileSync(locator, "foreign locator\n");
  const failed = run(["open", "--target", path.join(locatorFx.repo, "src", "future.txt"), "--goal", "must fail", "--write-root", "src", "--command-id", "open-conflict", ...OPEN_PROVENANCE]);
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /LOCATOR_CONFLICT|locator/i);
  const status = json(run(["status", "--target", locatorFx.repo]));
  assert.equal(status.routable, false);
  assert.equal(status.routing_reason, "attachment_pending");
  const records = json(run(["ledger", "--target", locatorFx.repo])).records;
  assert.deepEqual(records.map((record) => record.kind), ["authority_genesis", "attachment_stage_intent", "task_open_intent"]);
  const unrelated = run(["open", "--target", path.join(locatorFx.repo, "src", "future.txt"), "--goal", "other", "--write-root", "src", "--command-id", "open-other", ...OPEN_PROVENANCE]);
  assert.equal(unrelated.status, 2);
  assert.match(unrelated.stderr, /pending|recovery/i);
  assert.equal(json(run(["ledger", "--target", locatorFx.repo])).records.length, records.length);

  fs.rmSync(locator);
  const resumed = json(run(["open", "--target", path.join(locatorFx.repo, "src", "future.txt"), "--goal", "must fail", "--write-root", "src", "--command-id", "open-conflict", ...OPEN_PROVENANCE]));
  assert.equal(resumed.routable, true);
  assert.deepEqual(json(run(["ledger", "--target", locatorFx.repo])).records.map((record) => record.kind), ["authority_genesis", "attachment_stage_intent", "task_open_intent", "attachment_staged", "attachment_claim_pending", "attachment_claimed", "task_opened"]);

  const appendFx = fixture(t, "append-failure");
  fs.writeFileSync(path.join(appendFx.commonDir, "workloop"), "blocks authority directory\n");
  const appendFailed = run(["open", "--target", path.join(appendFx.repo, "src", "future.txt"), "--goal", "must fail", "--write-root", "src", "--command-id", "open-append-fail", ...OPEN_PROVENANCE]);
  assert.equal(appendFailed.status, 2);
  assert.equal(fs.existsSync(path.join(appendFx.gitDir, ".workloop-root.jsonl")), false);
});

test("current Git Hook receipts are target-routed and default nudge stays nonblocking", (t) => {
  const fx = fixture(t, "hooks");
  const opened = openTask(fx, "open-hooks");
  const target = path.join(fx.repo, "src", "untracked.txt");
  const payload = (event, response = undefined, targetPath = target) => JSON.stringify({
    hook_event_name: event, cwd: fx.root, session_id: "session-main", permission_mode: "bypassPermissions",
    tool_use_id: "operation-1", tool_name: "Write", tool_input: { file_path: targetPath }, ...(response === undefined ? {} : { tool_response: response }),
  });
  const pre = run(["hook", "--profile", "codex", "--mode", "nudge"], { cwd: fx.root, input: payload("PreToolUse") });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, "");
  const post = run(["hook", "--profile", "codex", "--mode", "nudge"], { cwd: fx.root, input: payload("PostToolUse", { success: true }) });
  assert.equal(post.status, 0, post.stderr);
  assert.equal(post.stdout, "");
  const ledger = json(run(["ledger", "--target", target], { cwd: fx.root })).records;
  assert.deepEqual(ledger.slice(-2).map((record) => record.kind), ["operation_intent_recorded", "tool_completed"]);
  assert.equal(ledger.at(-2).payload.task_id, opened.task.task_id);
  assert.equal(ledger.at(-1).payload.operation_id, "operation-1");

  for (const profile of ["claude", "codex", "codex"]) {
    const unreadable = run(["hook", "--profile", profile, "--mode", "nudge"], { cwd: fx.root, input: payload("PreToolUse", undefined, path.join(fx.root, "outside.txt")) });
    assert.equal(unreadable.status, 0);
    assert.equal(unreadable.stdout, "");
    assert.match(unreadable.stderr, /^workloop: provider evidence unavailable; host retains execution authority:/);
  }
  const beforeRejected = json(run(["ledger", "--target", target])).records.length;
  for (const rejected of [path.join(fx.gitDir, "config"), path.join(fx.repo, ".workloop", "private")]) {
    const result = run(["hook", "--profile", "codex", "--mode", "nudge"], { cwd: fx.root, input: payload("PreToolUse", undefined, rejected) });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.match(result.stderr, /host retains execution authority/);
  }
  const multi = run(["hook", "--profile", "codex", "--mode", "nudge"], { cwd: fx.root, input: JSON.stringify({
    hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "session-main", tool_use_id: "operation-many", tool_name: "apply_patch",
    tool_input: { patch: "*** Begin Patch\n*** Update File: " + target + "\n*** Update File: " + path.join(fx.root, "outside.txt") + "\n*** End Patch" },
  }) });
  assert.equal(multi.status, 0);
  assert.equal(multi.stdout, "");
  assert.match(multi.stderr, /host retains execution authority/);
  assert.equal(json(run(["ledger", "--target", target])).records.length, beforeRejected + 1);
});

test("current open requires replayable command provenance and disposable projection failures degrade open", (t) => {
  const missing = fixture(t, "missing-command");
  const refused = run(["open", "--target", path.join(missing.repo, "src", "future.txt"), "--goal", "missing id", "--write-root", "src", ...OPEN_PROVENANCE]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /explicit command id/);
  assert.equal(fs.existsSync(path.join(missing.commonDir, "workloop", "authority.jsonl")), false);

  const replay = fixture(t, "output-retry");
  const first = openTask(replay, "stable-open");
  const sequence = json(run(["ledger", "--target", replay.repo])).records.length;
  const repeated = openTask(replay, "stable-open");
  assert.deepEqual({ authority: repeated.authority_id, attachment: repeated.attachment_id, task: repeated.task.task_id }, { authority: first.authority_id, attachment: first.attachment_id, task: first.task.task_id });
  assert.equal(json(run(["ledger", "--target", replay.repo])).records.length, sequence);

  const degraded = fixture(t, "projection-degrade");
  fs.mkdirSync(path.join(degraded.commonDir, "workloop", "snapshot.json"), { recursive: true });
  fs.rmSync(path.join(TEST_AUTHORITY_HOME, "outcomes"), { recursive: true, force: true });
  fs.writeFileSync(path.join(TEST_AUTHORITY_HOME, "outcomes"), "blocks outcome directory\n");
  t.after(() => {
    fs.rmSync(path.join(TEST_AUTHORITY_HOME, "outcomes"), { recursive: true, force: true });
    fs.mkdirSync(path.join(TEST_AUTHORITY_HOME, "outcomes"), { recursive: true });
  });
  const opened = openTask(degraded, "projection-open");
  assert.equal(opened.routable, true);
  assert.equal(opened.warnings.length, 2);
  assert.match(opened.warnings[0], /snapshot projection deferred/);
  assert.match(opened.warnings[1], /outcome projection deferred/);
  const status = json(run(["status", "--target", path.join(degraded.repo, "src", "future.txt")]));
  assert.equal(status.routable, true);
  assert.equal(status.warnings.length, 2);
});

test("target-first routing covers canonical aliases, case, nesting, external and control targets", (t) => {
  const fx = fixture(t, "routing-matrix");
  const opened = openTask(fx, "routing-open");
  const alias = path.join(fx.repo, "alias-src");
  fs.symlinkSync(path.join(fx.repo, "src"), alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(json(run(["status", "--target", path.join(alias, "tracked.txt")])).authority_id, opened.authority_id);

  const differentlyCased = path.join(fx.repo.toUpperCase(), "SRC", "TRACKED.TXT");
  const caseResult = run(["status", "--target", differentlyCased]);
  if (process.platform === "win32" || process.platform === "darwin") assert.equal(json(caseResult).authority_id, opened.authority_id);
  else assert.equal(caseResult.status, 2);

  const external = run(["status", "--target", path.join(fx.root, "outside.txt")]);
  assert.equal(external.status, 2);
  for (const control of [path.join(fx.gitDir, "config"), path.join(fx.repo, ".workloop", "private"), opened.outcome_path]) {
    const result = run(["status", "--target", control]);
    assert.equal(result.status, 2, control);
  }

  const nested = path.join(fx.repo, "nested-repo");
  fs.mkdirSync(nested);
  git(nested, ["init", "-q"]);
  const nestedStatus = json(run(["status", "--target", nested]));
  assert.equal(nestedStatus.routable, false);
  assert.equal(nestedStatus.authority_id, null);
  assert.notEqual(nestedStatus.authority_root, opened.authority_root);

  const copied = path.join(fx.root, "copied-repo");
  fs.cpSync(fx.repo, copied, { recursive: true });
  const copiedStatus = json(run(["status", "--target", copied]));
  assert.equal(copiedStatus.routable, false);
  assert.equal(copiedStatus.routing_reason, "attachment_collision");
  assert.equal(copiedStatus.authority_id, opened.authority_id);
  assert.notEqual(git(copied, ["rev-parse", "--path-format=absolute", "--git-dir"]), fx.gitDir);
});


test("replay rejects Git certification without its matching clean commit receipt", (t) => { const fx = fixture(t, "forged-certification"); const opened = openTask(fx, "forged-certification-open"); const ledger = json(run(["ledger", "--target", fx.repo])).records; const prior = ledger.at(-1); const forged = { authority_schema_version: 1, sequence: prior.sequence + 1, previous_digest: prior.record_digest, record_id: randomUUID(), command_id: "forged-certification", kind: "task_certified", payload: { task_id: opened.task.task_id, attachment_id: opened.attachment_id, session_id: "session-main", prepared_sequence: prior.sequence, attachment_final_digest: opened.task.attachment_final_digest, criterion_digest: sha256Hex("criterion"), commit_oid: "0123456789012345678901234567890123456789", reason: "forged", granted_by: "self" } }; forged.record_digest = sha256Hex(canonicalJson(forged)); fs.appendFileSync(path.join(fx.commonDir, "workloop", "authority.jsonl"), canonicalJson(forged) + "\n"); const rejected = run(["status", "--target", fx.repo]); assert.equal(rejected.status, 2); assert.match(rejected.stderr, /task certification/); });

test("persisted schema and task-engine transitions reject hash-valid invalid authority", (t) => {
  const transitionFx = fixture(t, "invalid-transition");
  const opened = openTask(transitionFx, "transition-open");
  const ledger = json(run(["ledger", "--target", transitionFx.repo])).records;
  const last = ledger.at(-1);
  const invalidTransition = {
    authority_schema_version: 1, sequence: last.sequence + 1, previous_digest: last.record_digest,
    record_id: randomUUID(), command_id: "duplicate-task-open", kind: "task_opened",
    payload: { task_id: opened.task.task_id, attachment_id: opened.attachment_id, open_intent_digest: ledger.find((record) => record.kind === "task_open_intent").record_digest, attachment_final_digest: opened.task.attachment_final_digest },
  };
  invalidTransition.record_digest = sha256Hex(canonicalJson(invalidTransition));
  fs.appendFileSync(path.join(transitionFx.commonDir, "workloop", "authority.jsonl"), `${canonicalJson(invalidTransition)}\n`);
  const rejectedTransition = run(["status", "--target", transitionFx.repo]);
  assert.equal(rejectedTransition.status, 2);
  assert.match(rejectedTransition.stderr, /invalid current authority task attachment chain|task open input/);

  const schemaFx = fixture(t, "invalid-persisted-schema");
  openTask(schemaFx, "schema-open");
  const schemaLedger = json(run(["ledger", "--target", schemaFx.repo])).records;
  const prior = schemaLedger.at(-1);
  const invalidSchema = { ...prior, sequence: prior.sequence + 1, previous_digest: prior.record_digest, record_id: randomUUID(), command_id: "extra-field", payload: { ...prior.payload, unexpected: true } };
  delete invalidSchema.record_digest;
  invalidSchema.record_digest = sha256Hex(canonicalJson(invalidSchema));
  fs.appendFileSync(path.join(schemaFx.commonDir, "workloop", "authority.jsonl"), `${canonicalJson(invalidSchema)}\n`);
  const rejectedSchema = run(["status", "--target", schemaFx.repo]);
  assert.equal(rejectedSchema.status, 2);
  assert.match(rejectedSchema.stderr, /persisted-record contract/);

  const duplicateFx = fixture(t, "duplicate-command-id");
  const duplicateOpen = openTask(duplicateFx, "duplicate-command-open");
  const duplicateLedger = json(run(["ledger", "--target", duplicateFx.repo])).records;
  const duplicatePrior = duplicateLedger.at(-1);
  const duplicateCommand = {
    authority_schema_version: 1, sequence: duplicatePrior.sequence + 1, previous_digest: duplicatePrior.record_digest,
    record_id: randomUUID(), command_id: duplicatePrior.command_id, kind: "operation_intent_recorded",
    payload: { task_id: duplicateOpen.task.task_id, operation_id: "duplicate-command", session_id: "session-main", tool: "Write", target: "src/tracked.txt", permission_mode: null },
  };
  duplicateCommand.record_digest = sha256Hex(canonicalJson(duplicateCommand));
  fs.appendFileSync(path.join(duplicateFx.commonDir, "workloop", "authority.jsonl"), `${canonicalJson(duplicateCommand)}\n`);
  const rejectedDuplicate = run(["status", "--target", duplicateFx.repo]);
  assert.equal(rejectedDuplicate.status, 2);
  assert.match(rejectedDuplicate.stderr, /command id uniqueness/);

  const locatorFx = fixture(t, "invalid-locator-audit");
  const locatorOpen = openTask(locatorFx, "locator-audit-open");
  fs.appendFileSync(locatorOpen.locator_path, "torn");
  const status = json(run(["status", "--target", locatorFx.repo]));
  const audit = json(run(["audit", "--target", locatorFx.repo]));
  assert.equal(status.routable, false);
  assert.equal(status.routing_reason, "locator_unavailable");
  assert.equal(audit.integrity, "invalid");
});

test("current Git provider is a new-Contract leaf and old authority is never an input", () => {
  const provider = fs.readFileSync(path.join(ROOT, "lib", "git-authority-provider.mjs"), "utf8");
  assert.deepEqual([...provider.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).filter((source) => source.startsWith(".")), ["./prims.mjs"]);
  assert.doesNotMatch(provider, /EVENT_STORE_FILE|task-store|event-store|\.workloop\/events|migrate|fallback|dual[-_ ]?(?:read|write)/i);
  assert.doesNotMatch(provider, /withLock\("outcome"/);
  const application = fs.readFileSync(path.join(ROOT, "lib", "provider-application.mjs"), "utf8");
  assert.match(application, /from "\.\/git-authority-provider\.mjs"/);
  assert.match(application, /from "\.\/authority-transaction\.mjs"/);
  assert.match(application, /from "\.\/authority-outcome-projection\.mjs"/);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.match(scripts.test, /tests\/git-main-authority\.test\.mjs/);
  assert.match(scripts["test:matrix"], /tests\/git-main-authority\.test\.mjs/);
  const prims = fs.readFileSync(path.join(ROOT, "lib", "prims.mjs"), "utf8");
  const engine = fs.readFileSync(path.join(ROOT, "lib", "task-engine.mjs"), "utf8");
  assert.match(prims, /CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS/);
  assert.match(engine, /function evolveCurrentAuthority/);
  assert.match(engine, /function assertCurrentAuthorityProjection/);
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(workflow, /Provider authority suite[\s\S]*npm test/);
  assert.match(workflow, /Ticket acceptance suite[\s\S]*verify-provider-tickets\.mjs/);
});
