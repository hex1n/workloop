import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readEventStore } from "../lib/event-store.mjs";
import { sha256Hex } from "../lib/prims.mjs";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "taskloop.mjs");

function run(args, { cwd = ROOT, env = process.env, input = "" } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8" });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-v4-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.existsSync('done') ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: repo });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_SESSION_ID: "owner-v4" };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, home, env };
}

function open(fx, extra = []) {
  return run(["open", "--repo", fx.repo, "--goal", "finish", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "the checker exercises the result", "--files", "work.txt", "--risk", "routine", "--risk-reason", "isolated", ...extra], { env: fx.env });
}

function projection(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".taskloop", "task.json"), "utf8")).projection;
}

test("runtime contract 4 describes independent repository and HOME schemas", () => {
  const info = JSON.parse(run(["info"]).stdout);
  assert.deepEqual(info, {
    name: "taskloop", runtime_contract: 4, task_snapshot_schema_version: 3,
    event_record_schema_version: 1, outcome_projection_schema_version: 3,
    event_store: ".taskloop/events-v3.jsonl", outcome_projection: "~/.taskloop/outcomes-v3.jsonl",
    distribution_owner: "taskloop",
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
    }, { runtime: 4, snapshot: 3, record: 1, outcome: 3 }, args[0]);
  }

  fs.appendFileSync(path.join(fx.repo, ".taskloop", "events-v3.jsonl"), "{broken}\n");
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
  fs.rmSync(path.join(fx.repo, ".taskloop", "task.json"));
  const status = run(["status", "--repo", fx.repo], { env: fx.env });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(projection(fx.repo), before);

  const hook = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v4", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: hook }).status, 0);
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

test("authority guard rejects legacy, orphan, mixed, and corrupt state without overwriting events", (t) => {
  const fx = fixture(t);
  const stateDir = path.join(fx.repo, ".taskloop"); fs.mkdirSync(stateDir, { recursive: true });
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
  const eventPath = path.join(stateDir, "events-v3.jsonl");
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

test("transcript baseline and increment are in authority and a denied retry cannot double tally", (t) => {
  const fx = fixture(t); assert.equal(open(fx, ["--token-budget", "3"]).status, 0);
  const transcript = path.join(fx.root, "transcript.jsonl");
  fs.writeFileSync(transcript, '{"usage":{"output_tokens":99}}\n');
  const payload = (toolInput) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v4", transcript_path: transcript, tool_name: "Write", tool_input: toolInput });
  let response = run([], { cwd: fx.repo, env: fx.env, input: payload({ file_path: path.join(fx.repo, "work.txt") }) });
  assert.equal(response.status, 0); assert.equal(response.stdout, "");
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 0);
  fs.appendFileSync(transcript, '{"usage":{"output_tokens":3}}\n');
  response = run([], { cwd: fx.repo, env: fx.env, input: payload({ file_path: path.join(fx.repo, "outside.txt") }) });
  assert.equal(response.status, 0); assert.match(response.stdout, /output-token budget exhausted \(3\/3\)/);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 3);
  const tallyCount = readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied").length;
  response = run([], { cwd: fx.repo, env: fx.env, input: payload({ file_path: path.join(fx.repo, "outside.txt") }) });
  assert.match(response.stdout, /output-token budget exhausted \(3\/3\)/);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 3);
  assert.equal(readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied").length, tallyCount);
  assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop", "transcript-cursors.json")), false);
});

test("[W07] transcript ranges use UTF-8 byte offsets, CRLF, partial records, and replacement generations", (t) => {
  const fx = fixture(t); assert.equal(open(fx, ["--token-budget", "20"]).status, 0);
  const transcript = path.join(fx.root, "unicode transcript.jsonl");
  const complete = Buffer.from('{"note":"雪","output_tokens":99}\r\n', "utf8");
  const partial = Buffer.from('{"output_tokens":7}', "utf8");
  fs.writeFileSync(transcript, Buffer.concat([complete, partial]));
  const payload = () => JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v4", transcript_path: transcript, tool_name: "Read", tool_input: { file_path: path.join(fx.repo, "work.txt") } });

  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  let tallies = readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied");
  assert.equal(tallies.length, 1);
  assert.equal(tallies[0].payload.to_offset, complete.length);
  assert.equal(tallies[0].payload.output_tokens_delta, 0);
  const firstGeneration = tallies[0].payload.source_generation_id;

  fs.appendFileSync(transcript, "\r\n");
  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 7);

  fs.writeFileSync(transcript, '{"replacement":"不同","output_tokens":100}\r\n');
  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  tallies = readEventStore(fx.repo).events.filter((event) => event.kind === "output_tokens_tallied");
  assert.notEqual(tallies.at(-1).payload.source_generation_id, firstGeneration);
  assert.equal(tallies.at(-1).payload.mode, "baseline");
  assert.equal(tallies.at(-1).payload.output_tokens_delta, 0);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 7);

  fs.appendFileSync(transcript, '{"output_tokens":2}\n');
  assert.equal(run([], { cwd: fx.repo, env: fx.env, input: payload() }).status, 0);
  assert.equal(projection(fx.repo).spent.output_tokens_estimate, 9);
});

test("outcomes-v3 is best-effort, idempotent, and rebuildable from repository authority", (t) => {
  const fx = fixture(t); assert.equal(open(fx).status, 0);
  const projectionFile = path.join(fx.home, ".taskloop", "outcomes-v3.jsonl");
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 1);
  assert.equal(run(["sync-outcomes", "--repo", fx.repo], { env: fx.env }).status, 0);
  assert.equal(fs.readFileSync(projectionFile, "utf8").trim().split("\n").length, 1);
  fs.rmSync(projectionFile);
  const rebuilt = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout).added, 1);
  assert.equal(run(["audit-outcomes"], { env: fx.env }).status, 0);

  const cursorDir = path.join(fx.home, ".taskloop", "outcomes-v3-cursors");
  const cursorFile = path.join(cursorDir, fs.readdirSync(cursorDir)[0]);
  fs.writeFileSync(cursorFile, "{damaged cursor}\n");
  const rescanned = run(["sync-outcomes", "--repo", fx.repo], { env: fx.env });
  assert.equal(rescanned.status, 0, rescanned.stderr);
  assert.equal(JSON.parse(rescanned.stdout).added, 0);
  assert.equal(JSON.parse(fs.readFileSync(cursorFile, "utf8")).last_repo_sequence, 1);
});

test("HOME projection and cursor failures never roll back repository authority", (t) => {
  const cursorFx = fixture(t);
  const homeState = path.join(cursorFx.home, ".taskloop");
  fs.mkdirSync(homeState, { recursive: true });
  const blockedCursorDir = path.join(homeState, "outcomes-v3-cursors");
  fs.writeFileSync(blockedCursorDir, "blocks cursor directory creation\n");
  let opened = open(cursorFx);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /outcome-v3 projection deferred/);
  assert.equal(readEventStore(cursorFx.repo).records.length, 1);
  assert.equal(projection(cursorFx.repo).schema_version, 3);
  const projectionFile = path.join(homeState, "outcomes-v3.jsonl");
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
  const fx = fixture(t); assert.equal(open(fx, ["--writes", "20"]).status, 0);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "owner-v4", tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "work.txt") } });
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { cwd: fx.repo, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (status) => resolve({ status, stdout, stderr })); child.stdin.end(payload);
  });
  const results = await Promise.all(Array.from({ length: 20 }, invoke));
  for (const result of results) { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); }
  const replay = readEventStore(fx.repo);
  assert.equal(replay.records.length, 21);
  assert.deepEqual(replay.records.map((record) => record.repo_sequence), Array.from({ length: 21 }, (_, index) => index + 1));
  assert.equal(replay.events.filter((event) => event.kind === "write_authorized").length, 20);
  assert.equal(projection(fx.repo).spent.writes, 20);
});
