import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRecord, readEventStore } from "../lib/event-store.mjs";
import { syncOutcomeRecords } from "../lib/outcome-projector.mjs";
import { canonicalJson, sha256Hex } from "../lib/prims.mjs";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "workloop.mjs");

function run(args, { cwd = ROOT, env = process.env, input = "" } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8" });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v5-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.existsSync('done') ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: repo });
  const env = { ...process.env, TZ: "UTC", HOME: home, USERPROFILE: home, WORKLOOP_SESSION_ID: "owner-v5" };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, home, env };
}

function open(fx, extra = []) {
  return run(["open", "--repo", fx.repo, "--goal", "finish", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "the checker exercises the result", "--files", "work.txt", "--risk", "routine", "--risk-reason", "isolated", ...extra], { env: fx.env });
}

function projection(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
}

test("runtime contract 5 describes independent repository and HOME schemas", () => {
  const info = JSON.parse(run(["info"]).stdout);
  assert.deepEqual(info, {
    name: "workloop", runtime_contract: 5, criterion_adapter_protocol_version: 2, task_snapshot_schema_version: 3,
    event_record_schema_version: 2, outcome_projection_schema_version: 3,
    event_store: ".workloop/events.jsonl", outcome_projection: "~/.workloop/outcomes.jsonl",
    distribution_owner: "workloop",
  });
});

test("status, verify, report, and audit self-describe the active storage contracts", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const commands = [
    ["status", "--repo", fx.repo],
    ["verify", "--repo", fx.repo],
    ["report", "--repo", fx.repo, "--json"],
    ["audit", "--repo", fx.repo],
  ];
  for (const args of commands) {
    const result = run(args, { env: fx.env });
    assert.ok(new Set([0, 1]).has(result.status), `${args[0]}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual({
      runtime: payload.runtime_contract,
      snapshot: payload.task_snapshot_schema_version,
      record: payload.event_record_schema_version,
      outcome: payload.outcome_projection_schema_version,
    }, { runtime: 5, snapshot: 3, record: 2, outcome: 3 }, args[0]);
  }

  fs.appendFileSync(path.join(fx.repo, ".workloop", "events.jsonl"), "{broken}\n");
  const corrupt = run(["audit", "--repo", fx.repo], { env: fx.env });
  assert.equal(corrupt.status, 2);
  const report = JSON.parse(corrupt.stdout);
  assert.equal(report.valid, false);
  assert.equal(typeof report.error.code, "string");
  assert.equal(typeof report.error.message, "string");
});

test("CLI mutations commit one authority record and a disposable snapshot", (t) => {
  const fx = fixture(t);
  assert.equal(open(fx).status, 0);
  const first = readEventStore(fx.repo);
  assert.equal(first.records.length, 1);
  assert.deepEqual(first.events.map((event) => event.kind), ["task_opened"]);
  const before = projection(fx.repo);
  fs.rmSync(path.join(fx.repo, ".workloop", "task.json"));
  const status = run(["status", "--repo", fx.repo], { env: fx.env });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(projection(fx.repo), before);

  const hook = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  assert.equal(run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: hook }).status, 0);
  assert.equal(run(["suspend", "--repo", fx.repo, "--reason", "needs-input", "--remaining", "r", "--failure", "f", "--next-action", "n"], { env: fx.env }).status, 0);
  assert.equal(run(["resume", "--repo", fx.repo, "--reason", "continue"], { env: fx.env }).status, 0);
  assert.equal(run(["review", "--repo", fx.repo, "--level", "fresh-context", "--reviewer", "peer", "--blocking-findings", "0", "--advisory-findings", "1"], { env: fx.env }).status, 0);
  assert.equal(run(["amend", "--repo", fx.repo, "--reason", "raise cap", "--writes", "5"], { env: fx.env }).status, 0);
  assert.equal(run(["abandon", "--repo", fx.repo, "--reason", "done"], { env: fx.env }).status, 0);
  assert.deepEqual(readEventStore(fx.repo).events.map((event) => event.kind), [
    "task_opened", "write_authorized", "task_suspended", "task_resumed",
    "review_recorded", "task_amended", "task_terminal",
  ]);
});

test("PreToolUse validates repository authority once before its commit", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const countFile = path.join(fx.root, "event-read-count.txt");
  const preload = path.join(ROOT, "tests", "helpers", "fs-read-counter.cjs");
  const env = {
    ...fx.env,
    NODE_OPTIONS: [fx.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" "),
    WORKLOOP_EVENT_READ_COUNT_FILE: countFile,
  };
  const hook = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  const result = run(["hook", "--profile", "claude"], { cwd: fx.repo, env, input: hook });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(Number.parseInt(fs.readFileSync(countFile, "utf8"), 10), 1);
});

test("Stop preserves the task-state failure protocol for unclassified lock errors", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const preload = path.join(ROOT, "tests", "helpers", "fs-lock-failure.cjs");
  const env = {
    ...fx.env,
    NODE_OPTIONS: [fx.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" "),
    WORKLOOP_FAIL_TASK_LOCK: "1",
  };
  const payload = JSON.stringify({ hook_event_name: "Stop", cwd: fx.repo, session_id: "owner-v5" });
  const result = run(["hook", "--profile", "claude"], { cwd: fx.repo, env, input: payload });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "synthetic task lock failure\n");
  assert.equal(result.stdout, '{"decision":"block","reason":"workloop: task state unavailable (EACCES); refusing to adjudicate Stop"}\n');

  const safe = run(["hook", "--profile", "codex-safe"], { cwd: fx.repo, env, input: payload });
  assert.equal(safe.status, 0);
  assert.equal(safe.stdout, "");
  assert.match(safe.stderr, /^synthetic task lock failure\nworkloop: task state unavailable \(EACCES\); refusing to adjudicate Stop; Codex safe profile cannot resume this session;/);
});

test("authority guard rejects legacy, orphan, mixed, and corrupt state without overwriting events", (t) => {
  const fx = fixture(t);
  const stateDir = path.join(fx.repo, ".workloop"); fs.mkdirSync(stateDir, { recursive: true });
  const taskFile = path.join(stateDir, "task.json");
  const legacy = Buffer.from('{"schema_version":2,"opaque":"bytes"}\n');
  fs.writeFileSync(taskFile, legacy);
  let result = run(["status", "--repo", fx.repo], { env: fx.env });
  assert.equal(result.status, 2); assert.match(result.stderr, /legacy schema-2/);
  const legacyAudit = run(["audit", "--repo", fx.repo], { env: fx.env });
  assert.equal(legacyAudit.status, 2); assert.equal(JSON.parse(legacyAudit.stdout).error.code, "LEGACY_STATE_UNSUPPORTED");
  const legacySync = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(legacySync.status, 2); assert.match(legacySync.stderr, /legacy schema-2/);
  result = run(["archive-incompatible-state", "--repo", fx.repo, "--reason", "hard cutover", "--granted-by", "user"], { env: fx.env });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.raw_sha256, sha256Hex(legacy));
  assert.deepEqual(fs.readFileSync(path.join(fx.repo, receipt.archive_path)), legacy);

  assert.equal(open(fx).status, 0);
  const eventPath = path.join(stateDir, "events.jsonl");
  const authorityBytes = fs.readFileSync(eventPath);
  fs.writeFileSync(taskFile, '{"schema_version":2}\n');
  result = run(["status", "--repo", fx.repo], { env: fx.env });
  assert.equal(result.status, 2); assert.match(result.stderr, /snapshot conflicts/);
  const mixedAudit = run(["audit", "--repo", fx.repo], { env: fx.env });
  assert.equal(mixedAudit.status, 2); assert.equal(JSON.parse(mixedAudit.stdout).error.code, "MIXED_OR_INVALID_AUTHORITY");
  const mixedSync = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(mixedSync.status, 2); assert.match(mixedSync.stderr, /snapshot conflicts/);
  assert.deepEqual(fs.readFileSync(eventPath), authorityBytes);

  fs.writeFileSync(eventPath, Buffer.concat([authorityBytes.subarray(0, Math.max(1, authorityBytes.length - 8)), Buffer.from("damage\n")]));
  result = run(["status", "--repo", fx.repo], { env: fx.env });
  assert.equal(result.status, 2); assert.match(result.stderr, /event authority is corrupt/);
});

test("artifact-name migration adopts legacy authority and derived HOME paths without changing bytes", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const stateDir = path.join(fx.repo, ".workloop");
  const currentEvent = path.join(stateDir, "events.jsonl");
  const legacyEvent = path.join(stateDir, "events-v3.jsonl");
  if (fs.existsSync(currentEvent)) fs.renameSync(currentEvent, legacyEvent);

  const taskFile = path.join(stateDir, "task.json");
  const snapshot = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  snapshot.source_cursor.event_store_file = "events-v3.jsonl";
  const { snapshot_digest: _priorDigest, ...snapshotPreimage } = snapshot;
  snapshot.snapshot_digest = sha256Hex(canonicalJson(snapshotPreimage));
  fs.writeFileSync(taskFile, `${JSON.stringify(snapshot, null, 2)}\n`);

  const homeState = path.join(fx.home, ".workloop");
  const currentOutcome = path.join(homeState, "outcomes.jsonl");
  const legacyOutcome = path.join(homeState, "outcomes-v3.jsonl");
  if (fs.existsSync(currentOutcome)) fs.renameSync(currentOutcome, legacyOutcome);
  const displacedOutcomeBytes = Buffer.from('{"state":"open","kind":"task"}\n');
  fs.writeFileSync(currentOutcome, displacedOutcomeBytes);
  const currentCursors = path.join(homeState, "outcomes-cursors");
  const legacyCursors = path.join(homeState, "outcomes-v3-cursors");
  if (fs.existsSync(currentCursors)) fs.renameSync(currentCursors, legacyCursors);

  const eventBytes = fs.readFileSync(legacyEvent);
  const outcomeBytes = fs.readFileSync(legacyOutcome);
  const blocked = run(["status", "--repo", fx.repo], { env: fx.env });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /migrate-artifact-names/);

  const unauthorized = run([
    "migrate-artifact-names", "--repo", fx.repo,
    "--reason", "adopt stable artifact names", "--granted-by", "self",
  ], { env: fx.env });
  assert.equal(unauthorized.status, 2);
  assert.equal(fs.existsSync(legacyEvent), true);
  assert.equal(fs.existsSync(legacyOutcome), true);
  assert.equal(fs.existsSync(legacyCursors), true);

  const migrated = run([
    "migrate-artifact-names", "--repo", fx.repo,
    "--reason", "adopt stable artifact names", "--granted-by", "user",
  ], { env: fx.env });
  assert.equal(migrated.status, 0, migrated.stderr);
  const receipt = JSON.parse(migrated.stdout);
  assert.equal(receipt.event_store.migrated, true);
  assert.equal(receipt.outcome_projection.migrated, true);
  assert.equal(receipt.outcome_cursors.migrated, true);
  assert.equal(receipt.reason, "adopt stable artifact names");
  assert.equal(receipt.granted_by, "user");
  assert.deepEqual(fs.readFileSync(currentEvent), eventBytes);
  assert.deepEqual(fs.readFileSync(currentOutcome), outcomeBytes);
  const preservedOutcome = receipt.outcome_projection.preserved_existing;
  assert.equal(preservedOutcome.raw_sha256, sha256Hex(displacedOutcomeBytes));
  assert.deepEqual(fs.readFileSync(path.join(fx.home, preservedOutcome.archive_path.replace(/^~\//, ""))), displacedOutcomeBytes);
  assert.equal(fs.existsSync(legacyEvent), false);
  assert.equal(fs.existsSync(legacyOutcome), false);
  assert.equal(fs.existsSync(legacyCursors), false);
  assert.equal(fs.existsSync(currentCursors), true);
  assert.equal(JSON.parse(fs.readFileSync(taskFile, "utf8")).source_cursor.event_store_file, "events.jsonl");
  assert.equal(run(["status", "--repo", fx.repo], { env: fx.env }).status, 0);
});

test("artifact-name migration fails closed when both authority names exist", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const stateDir = path.join(fx.repo, ".workloop");
  const currentEvent = path.join(stateDir, "events.jsonl");
  const legacyEvent = path.join(stateDir, "events-v3.jsonl");
  if (fs.existsSync(currentEvent)) fs.copyFileSync(currentEvent, legacyEvent);
  else fs.copyFileSync(legacyEvent, currentEvent);
  const currentBytes = fs.readFileSync(currentEvent);
  const legacyBytes = fs.readFileSync(legacyEvent);

  const migrated = run([
    "migrate-artifact-names", "--repo", fx.repo,
    "--reason", "must reject conflicting authority names", "--granted-by", "user",
  ], { env: fx.env });
  assert.equal(migrated.status, 2);
  assert.match(migrated.stderr, /both events\.jsonl and events-v3\.jsonl exist/);
  assert.deepEqual(fs.readFileSync(currentEvent), currentBytes);
  assert.deepEqual(fs.readFileSync(legacyEvent), legacyBytes);
});

test("artifact-name migration refuses two current-schema outcome projections", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const homeState = path.join(fx.home, ".workloop");
  const currentOutcome = path.join(homeState, "outcomes.jsonl");
  const legacyOutcome = path.join(homeState, "outcomes-v3.jsonl");
  fs.copyFileSync(currentOutcome, legacyOutcome);
  const currentBytes = fs.readFileSync(currentOutcome);
  const legacyBytes = fs.readFileSync(legacyOutcome);

  const migrated = run([
    "migrate-artifact-names", "--repo", fx.repo,
    "--reason", "must not choose between current projections", "--granted-by", "user",
  ], { env: fx.env });
  assert.equal(migrated.status, 2);
  assert.match(migrated.stderr, /contain current-schema projections/);
  assert.deepEqual(fs.readFileSync(currentOutcome), currentBytes);
  assert.deepEqual(fs.readFileSync(legacyOutcome), legacyBytes);
});

test("transcript baseline and increment are in authority and a denied retry cannot double tally", (t) => {
  const fx = fixture(t); assert.equal(open(fx, ["--token-budget", "3"]).status, 0);
  const transcript = path.join(fx.root, "transcript.jsonl");
  fs.writeFileSync(transcript, '{"usage":{"output_tokens":99}}\n');
  const payload = (toolInput) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", transcript_path: transcript, tool_name: "Write", tool_input: toolInput });
  let response = run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload({ file_path: path.join(fx.repo, "work.txt") }) });
  assert.equal(response.status, 0); assert.equal(response.stdout, "");
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 0);
  fs.appendFileSync(transcript, '{"usage":{"output_tokens":3}}\n');
  response = run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload({ file_path: path.join(fx.repo, "outside.txt") }) });
  assert.equal(response.status, 0); assert.match(response.stdout, /output-token budget exhausted \(3\/3\)/);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 3);
  const tallyCount = readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied").length;
  response = run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload({ file_path: path.join(fx.repo, "outside.txt") }) });
  assert.match(response.stdout, /output-token budget exhausted \(3\/3\)/);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 3);
  assert.equal(readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied").length, tallyCount);
  assert.equal(fs.existsSync(path.join(fx.repo, ".workloop", "transcript-cursors.json")), false);
});

test("[W07] transcript ranges use UTF-8 byte offsets, CRLF, partial records, and replacement generations", (t) => {
  const fx = fixture(t); assert.equal(open(fx, ["--token-budget", "20"]).status, 0);
  const transcript = path.join(fx.root, "unicode transcript.jsonl");
  const complete = Buffer.from('{"note":"雪","output_tokens":99}\r\n', "utf8");
  const partial = Buffer.from('{"output_tokens":7}', "utf8");
  fs.writeFileSync(transcript, Buffer.concat([complete, partial]));
  const payload = () => JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", transcript_path: transcript, tool_name: "Read", tool_input: { file_path: path.join(fx.repo, "work.txt") } });

  assert.equal(run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  let tallies = readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied");
  assert.equal(tallies.length, 1);
  assert.equal(tallies[0].payload.to_offset, complete.length);
  assert.equal(tallies[0].payload.output_tokens_delta, 0);
  const firstGeneration = tallies[0].payload.source_generation_id;

  fs.appendFileSync(transcript, "\r\n");
  assert.equal(run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 7);

  fs.writeFileSync(transcript, '{"replacement":"不同","output_tokens":100}\r\n');
  assert.equal(run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  tallies = readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied");
  assert.notEqual(tallies.at(-1).payload.source_generation_id, firstGeneration);
  assert.equal(tallies.at(-1).payload.mode, "baseline");
  assert.equal(tallies.at(-1).payload.output_tokens_delta, 0);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 7);

  fs.appendFileSync(transcript, '{"output_tokens":2}\n');
  assert.equal(run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 9);
});

test("the outcome projection is best-effort, idempotent, and rebuildable from repository authority", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const projectionFile = path.join(fx.home, ".workloop", "outcomes.jsonl");
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 1);
  assert.equal(run(["sync-outcomes", "--repo", fx.repo], { env: fx.env }).status, 0);
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 1);
  fs.rmSync(projectionFile);
  const rebuilt = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout).added, 1);
  assert.equal(run(["audit-outcomes"], { env: fx.env }).status, 0);

  const cursorDir = path.join(fx.home, ".workloop", "outcomes-cursors");
  const cursorFile = path.join(cursorDir, fs.readdirSync(cursorDir)[0]);
  fs.writeFileSync(cursorFile, "{damaged cursor}\n");
  const rescanned = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(rescanned.status, 0, rescanned.stderr);
  assert.equal(JSON.parse(rescanned.stdout).added, 0);
  const cursorBytes = fs.readFileSync(cursorFile, "utf8");
  const cursor = JSON.parse(cursorBytes);
  assert.equal(cursor.last_repo_sequence, 1);
  assert.equal(cursorBytes, `${JSON.stringify(JSON.parse(canonicalJson(cursor)), null, 2)}\n`);

  const completeWithoutNewline = fs.readFileSync(projectionFile).subarray(0, fs.statSync(projectionFile).size - 1);
  fs.writeFileSync(projectionFile, completeWithoutNewline);
  const completed = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(fs.readFileSync(projectionFile).at(-1), 0x0a);

  fs.appendFileSync(projectionFile, '{"projection_schema_version":3');
  assert.equal(run(["audit-outcomes"], { env: fx.env }).status, 2);
  const recovered = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).added, 0);
  assert.equal(run(["audit-outcomes"], { env: fx.env }).status, 0);
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 1);
});

test("outcome cursor makes the normal commit path incremental", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const replay = readEventStore(fx.repo);
  const first = replay.records[0];
  const projectionFile = path.join(fx.home, ".workloop", "outcomes.jsonl");
  const repoIdentity = JSON.parse(fs.readFileSync(projectionFile, "utf8")).repo_identity;
  const second = buildRecord({
    transactionId: "818af0be-e1c7-4cf2-8177-d605e10175f4",
    commandId: null,
    repoSequence: 2,
    occurredAtEpochMs: first.occurred_at_epoch_ms + 1,
    actor: first.actor,
    previousRecordDigest: first.record_digest,
    events: [{
      task_id: first.events[0].task_id,
      task_event_sequence: 2,
      kind: "write_authorized",
      payload_version: 1,
      payload: { files: ["work.txt"] },
    }],
  });
  let projectionReads = 0;
  const fsOps = new Proxy(fs, { get(target, property) {
    if (property !== "readFileSync") return target[property];
    return (file, ...args) => {
      if (path.resolve(file) === projectionFile) projectionReads += 1;
      return target.readFileSync(file, ...args);
    };
  } });
  const report = syncOutcomeRecords({ repoIdentity, records: [second], home: fx.home, fsOps, incremental: true });
  assert.deepEqual({ valid: report.valid, added: report.added, total: report.total }, { valid: true, added: 1, total: null });
  assert.equal(projectionReads, 0);
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 2);
});

test("a stale repo cursor cannot omit history after the shared projection is rebuilt by another repo", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const first = readEventStore(fx.repo).records[0];
  const projectionFile = path.join(fx.home, ".workloop", "outcomes.jsonl");
  const repoIdentity = JSON.parse(fs.readFileSync(projectionFile, "utf8")).repo_identity;
  const otherRepoIdentity = `sha256:${"b".repeat(64)}`;
  const other = buildRecord({
    transactionId: "f79e8c8a-f405-49b9-b78f-417437e5fe6c",
    commandId: null,
    repoSequence: 1,
    occurredAtEpochMs: first.occurred_at_epoch_ms + 1,
    actor: first.actor,
    previousRecordDigest: null,
    events: [{
      task_id: "f68c6346-850e-4be2-a99b-ce3687097253",
      task_event_sequence: 1,
      kind: "task_opened",
      payload_version: 1,
      payload: first.events[0].payload,
    }],
  });
  const second = buildRecord({
    transactionId: "1c3f3d37-f605-4128-af8d-5893c8f0eec0",
    commandId: null,
    repoSequence: 2,
    occurredAtEpochMs: first.occurred_at_epoch_ms + 2,
    actor: first.actor,
    previousRecordDigest: first.record_digest,
    events: [{
      task_id: first.events[0].task_id,
      task_event_sequence: 2,
      kind: "write_authorized",
      payload_version: 1,
      payload: { files: ["work.txt"] },
    }],
  });

  fs.rmSync(projectionFile);
  syncOutcomeRecords({ repoIdentity: otherRepoIdentity, records: [other], home: fx.home });
  const repaired = syncOutcomeRecords({ repoIdentity, records: [second], priorRecords: [first], home: fx.home, incremental: true });
  assert.equal(repaired.added, 2);
  const rows = fs.readFileSync(projectionFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((row) => [row.repo_identity, row.repo_sequence]), [
    [otherRepoIdentity, 1],
    [repoIdentity, 1],
    [repoIdentity, 2],
  ]);
});

test("a normal commit repairs a prior torn outcome tail from repository authority", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const projectionFile = path.join(fx.home, ".workloop", "outcomes.jsonl");
  fs.appendFileSync(projectionFile, '{"projection_schema_version":3');
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  const committed = run(["hook", "--profile", "claude"], { cwd: fx.repo, env: fx.env, input: payload });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(run(["audit-outcomes"], { env: fx.env }).status, 0);
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 2);
});

test("HOME projection and cursor failures never roll back repository authority", (t) => {
  const cursorFx = fixture(t);
  const homeState = path.join(cursorFx.home, ".workloop");
  fs.mkdirSync(homeState, { recursive: true });
  const blockedCursorDir = path.join(homeState, "outcomes-cursors");
  fs.writeFileSync(blockedCursorDir, "blocks cursor directory creation\n");
  let opened = open(cursorFx);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /outcome-v3 projection deferred/);
  assert.equal(readEventStore(cursorFx.repo).records.length, 1);
  assert.equal(projection(cursorFx.repo).schema_version, 3);
  const projectionFile = path.join(homeState, "outcomes.jsonl");
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 1);
  fs.unlinkSync(blockedCursorDir);
  const converged = run(["sync-outcomes", "--repo", cursorFx.repo], { env: cursorFx.env });
  assert.equal(converged.status, 0, converged.stderr);
  assert.equal(JSON.parse(converged.stdout).added, 0);
  assert.equal(fs.readdirSync(blockedCursorDir).length, 1);

  const homeFx = fixture(t);
  const unusableHome = path.join(homeFx.root, "home-is-a-file");
  fs.writeFileSync(unusableHome, "not a directory\n");
  const unusableEnv = { ...homeFx.env, HOME: unusableHome, USERPROFILE: unusableHome };
  opened = open({ ...homeFx, env: unusableEnv });
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /outcome-v3 projection deferred/);
  assert.equal(readEventStore(homeFx.repo).records.length, 1);
  assert.equal(projection(homeFx.repo).schema_version, 3);
  const status = run(["status", "--repo", homeFx.repo], { env: unusableEnv });
  assert.equal(status.status, 0, status.stderr);
});

test("[W05] twenty concurrent mutations serialize without sequence gaps or lost writes", async (t) => {
  const concurrency = Number.parseInt(process.env.WORKLOOP_W05_CONCURRENCY ?? "20", 10);
  assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0);
  const fx = fixture(t); assert.equal(open(fx, ["--writes", String(concurrency)]).status, 0);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { cwd: fx.repo, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (status) => resolve({ status, stdout, stderr })); child.stdin.end(payload);
  });
  const results = await Promise.all(Array.from({ length: concurrency }, invoke));
  for (const result of results) { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "", JSON.stringify(result)); }
  const replay = readEventStore(fx.repo);
  assert.equal(replay.records.length, concurrency + 1, JSON.stringify(results, null, 2));
  assert.deepEqual(replay.records.map((record) => record.repo_sequence), Array.from({ length: concurrency + 1 }, (_, index) => index + 1));
  assert.equal(replay.events.filter((event) => event.kind === "write_authorized").length, concurrency);
  assert.equal(projection(fx.repo).spent.writes, concurrency);
});

test("[W05] hook payload reading waits through a temporarily empty nonblocking stdin pipe", async (t) => {
  const fx = fixture(t); assert.equal(open(fx, ["--writes", "1"]).status, 0);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { cwd: fx.repo, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => child.stdin.end(payload), 50);
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(readEventStore(fx.repo).records.length, 2, JSON.stringify(result));
});

test("[W05] hook payload reading accepts one complete JSON object without waiting for EOF", async (t) => {
  const fx = fixture(t); assert.equal(open(fx, ["--writes", "1"]).status, 0);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { cwd: fx.repo, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {}); child.stdin.write(payload);
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ status: "timeout", stdout, stderr }); }, 2000);
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});

test("[W05] hook payload reading waits when an intermediate chunk ends with a closing brace", async (t) => {
  const fx = fixture(t); assert.equal(open(fx, ["--writes", "1"]).status, 0);
  const prefix = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v5", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } }).slice(0, -1);
  const payload = `${prefix},"ignored_tail":true}`;
  const splitAt = prefix.length;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { cwd: fx.repo, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {}); child.stdin.write(payload.slice(0, splitAt));
    const secondChunk = setTimeout(() => child.stdin.write(payload.slice(splitAt)), 50);
    const deadline = setTimeout(() => { child.kill("SIGKILL"); resolve({ status: "timeout", stdout, stderr }); }, 2000);
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(secondChunk); clearTimeout(deadline); resolve({ status, stdout, stderr }); });
  });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  assert.equal(readEventStore(fx.repo).events.filter((event) => event.kind === "write_authorized").length, 1);
});
