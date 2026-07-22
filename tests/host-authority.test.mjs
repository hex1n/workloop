import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { artifactCheckpointFromSnapshot, repoSnapshot } from "../lib/criterion.mjs";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "workloop.mjs");

function run(args, { cwd = ROOT, env = process.env, input = "" } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, env, input, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
  });
}

function fixture(t, { writes = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-host-authority-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.existsSync('done') ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: repo });
  const env = {
    ...process.env,
    TZ: "UTC",
    HOME: home,
    USERPROFILE: home,
    WORKLOOP_SESSION_ID: "owner",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "",
  };
  const opened = run([
    "open", "--repo", repo,
    "--goal", "exercise host-owned execution authority",
    "--criterion-file", "check.mjs",
    "--criterion-timeout-seconds", "5",
    "--alignment-because", "the fixture observes hook authority semantics",
    "--files", "work.txt", "--files", "done",
    "--risk", "routine", "--risk-reason", "isolated reversible fixture",
    ...(writes === null ? [] : ["--writes", String(writes)]),
  ], { env });
  assert.equal(opened.status, 0, opened.stderr);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, home, env };
}

function prePayload(fx, overrides = {}) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "owner",
    tool_use_id: "operation-1",
    permission_mode: "bypassPermissions",
    tool_name: "Write",
    tool_input: { file_path: path.join(fx.repo, "outside.txt"), content: "outside\n" },
    ...overrides,
  });
}

function authorityEvents(repo) {
  return authorityRecords(repo).flatMap((record) => record.events);
}

function authorityRecords(repo) {
  return fs.readFileSync(path.join(repo, ".workloop", "events.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("artifact checkpoints use the persisted byte-order contract", () => {
  const paths = artifactCheckpointFromSnapshot(repoSnapshot(ROOT)).entries.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort());
});

test("observe and nudge record policy deviations without exercising host permission authority", (t) => {
  for (const mode of ["observe", "nudge"]) {
    const fx = fixture(t);
    const invoked = run(["hook", "--profile", "codex-safe", "--mode", mode], {
      cwd: fx.repo,
      env: fx.env,
      input: prePayload(fx, { tool_use_id: `outside-${mode}` }),
    });
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.equal(invoked.stdout, "", `${mode} must leave the host permission decision untouched`);
    if (mode === "observe") assert.equal(invoked.stderr, "");
    else assert.match(invoked.stderr, /outside.*envelope|policy deviation/i);

    const events = authorityEvents(fx.repo);
    const intent = events.find((event) => event.kind === "operation_intent_recorded");
    assert.ok(intent, JSON.stringify(events.map((event) => event.kind)));
    assert.equal(intent.payload.policy_disposition, "deviation");
    assert.ok(intent.payload.policy_reasons.includes("outside_envelope"));
    assert.equal(events.some((event) => event.kind === "write_authorized"), false, "telemetry must not be named authorization");

    const status = JSON.parse(run(["status", "--repo", fx.repo], { env: fx.env }).stdout);
    assert.equal(status.spent.write_count_basis, "intent");
    assert.equal(status.write_evidence.operation_intents_observed, 1);
    assert.equal(status.write_evidence.execution_authority, "host");
  }
});

test("omitted Hook mode defaults to non-blocking nudge for Pre and Stop", (t) => {
  const fx = fixture(t);
  const pre = run(["hook", "--profile", "claude"], {
    cwd: fx.repo, env: fx.env, input: prePayload(fx, { tool_use_id: "default-nudge" }),
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, "");
  assert.match(pre.stderr, /policy deviation/i);
  const intent = authorityEvents(fx.repo).find((event) => event.kind === "operation_intent_recorded");
  assert.equal(intent.payload.policy_mode, "nudge");

  const stop = run(["hook", "--profile", "claude"], {
    cwd: fx.repo, env: fx.env,
    input: JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo, session_id: "owner" }),
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, "");
});

test("opaque MCP side effects receive intent and completion receipts while known reads stay free", (t) => {
  const fx = fixture(t);
  const mutation = {
    cwd: fx.repo, session_id: "owner", tool_use_id: "mcp-create-issue",
    tool_name: "mcp__github__create_issue", tool_input: { owner: "hex1n", repo: "workloop", title: "receipt probe" },
  };
  const pre = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: fx.repo, env: fx.env, input: JSON.stringify({ ...mutation, hook_event_name: "PreToolUse" }),
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, "");
  let events = authorityEvents(fx.repo);
  const intent = events.find((event) => event.kind === "operation_intent_recorded");
  assert.ok(intent);
  assert.equal(intent.payload.tool_family, "mcp");
  assert.equal(intent.payload.target_coverage, "unknown");
  assert.deepEqual(intent.payload.declared_targets, ["<command>"]);

  const post = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: fx.repo, env: fx.env,
    input: JSON.stringify({ ...mutation, hook_event_name: "PostToolUse", tool_response: { success: true } }),
  });
  assert.equal(post.status, 0, post.stderr);
  assert.equal(post.stdout, "");
  events = authorityEvents(fx.repo);
  assert.equal(events.find((event) => event.kind === "tool_completed")?.payload.operation_id, "mcp-create-issue");

  const intentCount = events.filter((event) => event.kind === "operation_intent_recorded").length;
  const read = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: fx.repo, env: fx.env,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner", tool_use_id: "mcp-get-issue",
      tool_name: "mcp__github__get_issue", tool_input: { owner: "hex1n", repo: "workloop", issue_number: 1 },
    }),
  });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(authorityEvents(fx.repo).filter((event) => event.kind === "operation_intent_recorded").length, intentCount);

  for (const [toolName, toolUseId] of [
    ["mcp__review__resolve_thread", "mcp-resolve-thread"],
    ["mcp__mail__read_and_mark_seen", "mcp-read-and-mark"],
  ]) {
    const ambiguous = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
      cwd: fx.repo, env: fx.env,
      input: JSON.stringify({
        hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner", tool_use_id: toolUseId,
        tool_name: toolName, tool_input: { id: "subject" },
      }),
    });
    assert.equal(ambiguous.status, 0, ambiguous.stderr);
  }
  assert.equal(authorityEvents(fx.repo).filter((event) => event.kind === "operation_intent_recorded").length, intentCount + 2);
});

test("deny remains the explicit Workloop enforcement mode", (t) => {
  const fx = fixture(t);
  const invoked = run(["hook", "--profile", "codex-safe", "--mode", "deny"], {
    cwd: fx.repo,
    env: fx.env,
    input: prePayload(fx),
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.match(invoked.stdout, /"permissionDecision":"deny"/);
  assert.equal(authorityEvents(fx.repo).some((event) => event.kind === "operation_intent_recorded"), false);
});

test("external operation targets remain replayable without leaking absolute authority paths", (t) => {
  const fx = fixture(t);
  const external = path.join(fx.root, "external.txt");
  const payload = {
    hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "foreign",
    tool_use_id: "external-operation", tool_name: "Write", tool_input: { file_path: external },
  };
  const pre = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: fx.repo, env: fx.env, input: JSON.stringify(payload),
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, "");
  const intent = authorityEvents(fx.repo).find((event) => event.kind === "operation_intent_recorded");
  assert.deepEqual(intent.payload.declared_targets, ["<external-target>"]);
  assert.equal(JSON.stringify(intent).includes(external), false);

  const post = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: fx.repo, env: fx.env,
    input: JSON.stringify({ ...payload, hook_event_name: "PostToolUse", tool_response: { success: true } }),
  });
  assert.equal(post.status, 0, post.stderr);
  assert.equal(post.stdout, "");
  const completion = authorityEvents(fx.repo).find((event) => event.kind === "tool_completed");
  assert.deepEqual(completion.payload.reported_targets, ["<external-target>"]);
});

test("host-authority intent overruns affect certification instead of tool execution", (t) => {
  const fx = fixture(t, { writes: 0 });
  const invoked = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: fx.repo,
    env: fx.env,
    input: prePayload(fx, {
      tool_use_id: "budget-overrun",
      tool_input: { file_path: path.join(fx.repo, "work.txt"), content: "changed\n" },
    }),
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(invoked.stdout, "");
  assert.match(invoked.stderr, /budget|policy deviation/i);

  fs.writeFileSync(path.join(fx.repo, "done"), "satisfied\n");
  const achieved = run(["achieve", "--repo", fx.repo], { env: fx.env });
  assert.equal(achieved.status, 2);
  assert.match(achieved.stderr, /write_budget_exceeded/);
  const status = JSON.parse(run(["status", "--repo", fx.repo], { env: fx.env }).stdout);
  assert.equal(status.write_evidence.operation_intents_observed, 1);
  assert.ok(status.closure?.reasons?.includes("write_budget_exceeded"), JSON.stringify(status.closure));
});

test("envelope amendments immediately reclassify persisted scope violations", (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "outside.txt"), "outside\n");
  const observed = run(["achieve", "--repo", fx.repo], { env: fx.env });
  assert.equal(observed.status, 2);
  let status = JSON.parse(run(["status", "--repo", fx.repo], { env: fx.env }).stdout);
  assert.deepEqual(status.write_evidence.current_scope_violations, ["outside.txt"]);
  const before = JSON.parse(fs.readFileSync(path.join(fx.repo, ".workloop", "task.json"), "utf8")).projection;

  const amended = run([
    "amend", "--repo", fx.repo, "--files", "outside.txt",
    "--reason", "the approved work now includes the observed fixture output",
  ], { env: fx.env });
  assert.equal(amended.status, 0, amended.stderr);
  status = JSON.parse(run(["status", "--repo", fx.repo], { env: fx.env }).stdout);
  assert.deepEqual(status.write_evidence.current_scope_violations, []);
  const after = JSON.parse(fs.readFileSync(path.join(fx.repo, ".workloop", "task.json"), "utf8")).projection;
  assert.deepEqual(authorityRecords(fx.repo).at(-1).events.map((event) => event.kind), ["task_amended", "artifact_reconciled"]);
  assert.equal(after.artifact_checkpoint.checkpoint_id, before.artifact_checkpoint.checkpoint_id);
  assert.equal(after.artifact_checkpoint.captured_at_ms, before.artifact_checkpoint.captured_at_ms);
  assert.equal(after.artifact_revision, before.artifact_revision);
});

test("nudge never blocks Claude Stop while deny preserves the opt-in hard gate", (t) => {
  const fx = fixture(t);
  const payload = JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo, session_id: "owner" });
  const observed = run(["hook", "--profile", "claude", "--mode", "nudge"], { cwd: fx.repo, env: fx.env, input: payload });
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(observed.stdout, "");

  const enforced = run(["hook", "--profile", "claude", "--mode", "deny"], { cwd: fx.repo, env: fx.env, input: payload });
  assert.equal(enforced.status, 0, enforced.stderr);
  assert.match(enforced.stdout, /"decision":"block"/);
});

test("host-authority hook failures fail open while enforcement failures stay closed", (t) => {
  const observed = fixture(t);
  fs.appendFileSync(path.join(observed.repo, ".workloop", "events.jsonl"), "corrupt\n");
  const openResult = run(["hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: observed.repo, env: observed.env, input: prePayload(observed),
  });
  assert.equal(openResult.status, 0, openResult.stderr);
  assert.equal(openResult.stdout, "");
  assert.match(openResult.stderr, /unavailable|evidence|supervisor/i);

  const enforced = fixture(t);
  fs.appendFileSync(path.join(enforced.repo, ".workloop", "events.jsonl"), "corrupt\n");
  const closedResult = run(["hook", "--profile", "codex-safe", "--mode", "deny"], {
    cwd: enforced.repo, env: enforced.env, input: prePayload(enforced),
  });
  assert.equal(closedResult.status, 0, closedResult.stderr);
  assert.match(closedResult.stdout, /"permissionDecision":"deny"/);
});
