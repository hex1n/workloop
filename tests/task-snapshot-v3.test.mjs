import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRecord, commitRecord, readEventStore } from "../lib/event-store.mjs";
import { recoverV3TaskSnapshot } from "../lib/application.mjs";
import { assertV3TaskProjection, decide, evolveAll } from "../lib/task-engine.mjs";
import {
  buildTaskSnapshot,
  inspectTaskSnapshot,
  saveTaskSnapshot,
  taskPath,
} from "../lib/task-store.mjs";
import { canonicalJson, sha256Hex } from "../lib/prims.mjs";
import { siblingWorktreeOpenTasks } from "../lib/supervision.mjs";
import { deterministicId, makeTaskOpenedCommand } from "./helpers/event-v3-fixture.mjs";

const buildSnapshot = (options) => buildTaskSnapshot({ ...options, validateProjection: assertV3TaskProjection });
const inspectSnapshot = (repo, options = {}) => inspectTaskSnapshot(repo, { ...options, validateProjection: assertV3TaskProjection });
const saveSnapshot = (repo, snapshot, options = {}) => saveTaskSnapshot(repo, snapshot, { ...options, validateProjection: assertV3TaskProjection });
const siblingSnapshots = (repo) => siblingWorktreeOpenTasks(repo, { validateV3Projection: assertV3TaskProjection });

function terminateCrashChildAtSeam(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("tests/helpers/event-store-crash-child.mjs"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let frame = null;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`snapshot crash child timeout: ${stderr}`)); }, 10_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0 || frame) return;
      try { frame = JSON.parse(stdout.slice(0, newline)); } catch (error) { reject(error); child.kill("SIGKILL"); return; }
      child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!frame) reject(new Error(`snapshot crash child exited before seam (${code}/${signal}): ${stderr}`));
      else resolve({ frame, code, signal });
    });
  });
}

function openV3Repo(t, seed = "snapshot-v3") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-snapshot-v3-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const command = makeTaskOpenedCommand({ seed, index: 1, atEpochMs: 1_784_000_000_000 });
  const event = { ...decide(null, command).events[0], task_event_sequence: 1 };
  const record = buildRecord({
    transactionId: deterministicId(seed, "transaction", 1),
    commandId: deterministicId(seed, "command", 1),
    repoSequence: 1,
    occurredAtEpochMs: command.atEpochMs,
    actor: { kind: "cli", session_id: command.actingSession },
    previousRecordDigest: null,
    events: [event],
  });
  commitRecord(repo, record);
  const replay = readEventStore(repo);
  return { repo, command, record, replay, projection: evolveAll(null, replay.events) };
}

test("schema-v3 task snapshots are disposable digest-checked projection wrappers", (t) => {
  const { repo, replay, projection } = openV3Repo(t);
  const snapshot = buildSnapshot({ sourceCursor: replay.source_cursor, projection });
  assert.deepEqual(Object.keys(snapshot), ["schema_version", "runtime_contract", "source_cursor", "projection", "snapshot_digest"]);
  assert.equal(snapshot.schema_version, 3);
  assert.equal(snapshot.runtime_contract, 4);
  assert.deepEqual(snapshot.source_cursor, replay.source_cursor);
  assert.deepEqual(snapshot.projection, projection);
  assert.match(snapshot.snapshot_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snapshot.snapshot_digest, "sha256:3a0f0c9dcbe2443c1253a01d8b7e979e675cf03cfacdeab3144c13153ffeb947");

  saveSnapshot(repo, snapshot);
  assert.deepEqual(inspectSnapshot(repo), { status: "valid", snapshot });
  assert.equal(fs.readFileSync(taskPath(repo), "utf8"), `${canonicalJson(snapshot)}\n`);
  assert.equal(fs.readFileSync(path.join(repo, ".taskloop", ".gitignore"), "utf8"), "*\n");

  const tampered = structuredClone(snapshot);
  tampered.projection.goal = "tampered";
  fs.writeFileSync(taskPath(repo), `${canonicalJson(tampered)}\n`);
  const damaged = inspectSnapshot(repo);
  assert.equal(damaged.status, "damaged");
  assert.equal(damaged.reason, "snapshot_digest_mismatch");
});

test("missing or damaged schema-v3 snapshots rebuild from authoritative events", (t) => {
  const { repo, replay, projection } = openV3Repo(t, "snapshot-rebuild");
  assert.deepEqual(inspectSnapshot(repo), { status: "missing" });

  const missing = recoverV3TaskSnapshot(repo);
  assert.equal(missing.status, "rebuilt");
  assert.equal(missing.reason, "missing");
  assert.deepEqual(missing.projection, projection);
  assert.deepEqual(missing.source_cursor, replay.source_cursor);
  assert.equal(missing.snapshot_saved, true);
  assert.equal(missing.warning, null);
  assert.equal(missing.diagnostic, null);

  const brokenBytes = Buffer.from("{broken\n");
  fs.writeFileSync(taskPath(repo), brokenBytes);
  const invalidJson = recoverV3TaskSnapshot(repo);
  assert.equal(invalidJson.status, "rebuilt");
  assert.equal(invalidJson.reason, "invalid_json");
  assert.deepEqual(invalidJson.projection, projection);
  assert.equal(invalidJson.diagnostic.reason, "invalid_json");
  assert.equal(invalidJson.diagnostic.raw_sha256, sha256Hex(brokenBytes));
  assert.deepEqual(fs.readFileSync(invalidJson.diagnostic.quarantine_path), brokenBytes);

  const valid = inspectSnapshot(repo).snapshot;
  valid.snapshot_digest = `sha256:${"0".repeat(64)}`;
  fs.writeFileSync(taskPath(repo), `${canonicalJson(valid)}\n`);
  const badDigest = recoverV3TaskSnapshot(repo);
  assert.equal(badDigest.status, "rebuilt");
  assert.equal(badDigest.reason, "snapshot_digest_mismatch");
  assert.deepEqual(badDigest.projection, projection);
  assert.equal(badDigest.diagnostic.reason, "snapshot_digest_mismatch");
  assert.equal(fs.existsSync(badDigest.diagnostic.quarantine_path), true);
});

test("[W04] a terminal task A snapshot replays through a committed task B open", (t) => {
  const { repo, command: openedA, record: first, replay: openedReplay, projection: openedProjection } = openV3Repo(t, "snapshot-tail-switch");
  const terminalAt = "2026-07-14T04:00:00.000Z";
  const terminalEvent = {
    ...decide(openedProjection, {
      type: "not-needed",
      taskId: openedProjection.task_id,
      at: terminalAt,
      evidence: "task A is already unnecessary",
      actingSession: openedA.actingSession,
    }).events[0],
    task_event_sequence: 2,
  };
  const second = buildRecord({
    transactionId: deterministicId("snapshot-tail-switch", "transaction", 2),
    commandId: deterministicId("snapshot-tail-switch", "command", 2),
    repoSequence: 2,
    occurredAtEpochMs: Date.parse(terminalAt),
    actor: { kind: "cli", session_id: openedA.actingSession },
    previousRecordDigest: first.record_digest,
    events: [terminalEvent],
  });
  commitRecord(repo, second, { cursor: openedReplay.cursor });
  const terminalReplay = readEventStore(repo);
  const terminalProjection = evolveAll(openedProjection, terminalReplay.events.slice(1));
  saveSnapshot(repo, buildSnapshot({ sourceCursor: terminalReplay.source_cursor, projection: terminalProjection }));

  const openedB = makeTaskOpenedCommand({ seed: "snapshot-tail-switch-b", index: 1, atEpochMs: Date.parse(terminalAt) + 1 });
  const openedBEvent = { ...decide(null, openedB).events[0], task_event_sequence: 1 };
  const third = buildRecord({
    transactionId: deterministicId("snapshot-tail-switch", "transaction", 3),
    commandId: deterministicId("snapshot-tail-switch", "command", 3),
    repoSequence: 3,
    occurredAtEpochMs: openedB.atEpochMs,
    actor: { kind: "cli", session_id: openedB.actingSession },
    previousRecordDigest: second.record_digest,
    events: [openedBEvent],
  });
  commitRecord(repo, third, { cursor: terminalReplay.cursor });

  const recovered = recoverV3TaskSnapshot(repo);
  assert.equal(recovered.status, "replayed");
  assert.equal(recovered.reason, "snapshot_behind");
  assert.equal(recovered.projection.task_id, openedB.taskId);
  assert.equal(recovered.projection.lifecycle.state, "active");
  assert.equal(recovered.projection.task_event_sequence, 1);
  assert.deepEqual(recovered.source_cursor, readEventStore(repo).source_cursor);
  assert.equal(recovered.snapshot_saved, true);
  assert.equal(recovered.warning, null);
});

test("snapshot write and rename failures never roll back committed events", async (t) => {
  for (const failure of ["writeSync", "renameSync"]) {
    await t.test(failure, (t) => {
      const { repo, record, projection } = openV3Repo(t, `snapshot-failure-${failure}`);
      const eventBytes = fs.readFileSync(path.join(repo, ".taskloop", "events-v3.jsonl"));
      const snapshotFsOps = new Proxy(fs, {
        get(target, property) {
          if (property !== failure) return target[property];
          return () => { throw new Error(`injected snapshot ${failure} failure`); };
        },
      });
      const recovered = recoverV3TaskSnapshot(repo, { snapshotFsOps });
      assert.equal(recovered.status, "rebuilt");
      assert.deepEqual(recovered.projection, projection);
      assert.equal(recovered.snapshot_saved, false);
      assert.match(recovered.warning, new RegExp(`committed.*${failure} failure`));
      assert.deepEqual(fs.readFileSync(path.join(repo, ".taskloop", "events-v3.jsonl")), eventBytes);
      assert.deepEqual(readEventStore(repo).records, [record]);

      const retry = recoverV3TaskSnapshot(repo);
      assert.equal(retry.snapshot_saved, true);
      assert.deepEqual(retry.projection, projection);
    });
  }
});

test("[W02] process termination after event commit and during snapshot replacement preserves authority", async (t) => {
  const { repo, replay, projection } = openV3Repo(t, "snapshot-process-crash");
  const snapshot = buildSnapshot({ sourceCursor: replay.source_cursor, projection });
  const commandFile = path.join(repo, "snapshot-command.json");
  fs.writeFileSync(commandFile, canonicalJson(snapshot));
  const authorityBefore = fs.readFileSync(path.join(repo, ".taskloop", "events-v3.jsonl"));
  for (const [seam, targetExists] of [["during-snapshot-write", false], ["after-snapshot-rename", true]]) {
    fs.rmSync(taskPath(repo), { force: true });
    const crashed = await terminateCrashChildAtSeam([
      "--repo", repo, "--command-file", commandFile, "--operation", "write-snapshot", "--seam", seam,
    ]);
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(crashed.frame.seam, seam);
    assert.equal(fs.existsSync(taskPath(repo)), targetExists);
    assert.deepEqual(fs.readFileSync(path.join(repo, ".taskloop", "events-v3.jsonl")), authorityBefore);
    const recovered = recoverV3TaskSnapshot(repo);
    assert.deepEqual(recovered.projection, projection);
    assert.ok(new Set(["rebuilt", "current"]).has(recovered.status));
  }
});

test("ahead or mismatched snapshots fail closed without changing event authority", async (t) => {
  const { repo, replay, projection } = openV3Repo(t, "snapshot-invalid-authority");
  const authorityBefore = fs.readFileSync(path.join(repo, ".taskloop", "events-v3.jsonl"));
  const valid = buildSnapshot({ sourceCursor: replay.source_cursor, projection });
  const cases = [
    ["cursor ahead", buildSnapshot({
      sourceCursor: { ...replay.source_cursor, repo_sequence: 2, valid_end_offset: replay.source_cursor.valid_end_offset + 1 },
      projection,
    })],
    ["source digest", buildSnapshot({
      sourceCursor: { ...replay.source_cursor, record_digest: `sha256:${"0".repeat(64)}` },
      projection,
    })],
    ["event identity", buildSnapshot({
      sourceCursor: { ...replay.source_cursor, event_id: `sha256:${"1".repeat(64)}` },
      projection,
    })],
    ["task identity", buildSnapshot({
      sourceCursor: replay.source_cursor,
      projection: { ...structuredClone(projection), task_id: deterministicId("snapshot-invalid-authority", "other-task", 1) },
    })],
  ];
  for (const [name, snapshot] of cases) {
    await t.test(name, () => {
      fs.writeFileSync(taskPath(repo), `${canonicalJson(snapshot)}\n`);
      const snapshotBefore = fs.readFileSync(taskPath(repo));
      assert.throws(
        () => recoverV3TaskSnapshot(repo),
        (error) => error.code === "MIXED_OR_INVALID_AUTHORITY" && /conflicts with schema-v3 event authority/.test(error.message),
      );
      assert.deepEqual(fs.readFileSync(path.join(repo, ".taskloop", "events-v3.jsonl")), authorityBefore);
      assert.deepEqual(fs.readFileSync(taskPath(repo)), snapshotBefore);
    });
  }
  for (const [name, raw] of [["legacy schema", { schema_version: 2 }], ["unknown schema", { schema_version: 99 }]]) {
    await t.test(name, () => {
      fs.writeFileSync(taskPath(repo), `${canonicalJson(raw)}\n`);
      assert.throws(() => recoverV3TaskSnapshot(repo), (error) => error.code === "MIXED_OR_INVALID_AUTHORITY");
      assert.deepEqual(fs.readFileSync(path.join(repo, ".taskloop", "events-v3.jsonl")), authorityBefore);
    });
  }
  saveSnapshot(repo, valid);
});

test("self-digested but invalid projections are never trusted as snapshots", async (t) => {
  const { repo, replay, projection } = openV3Repo(t, "snapshot-invalid-projection");
  const resign = (candidate) => {
    const preimage = {
      schema_version: 3,
      runtime_contract: 4,
      source_cursor: structuredClone(replay.source_cursor),
      projection: candidate,
    };
    return { ...preimage, snapshot_digest: sha256Hex(canonicalJson(preimage)) };
  };
  const cases = [
    ["unknown projection field", { ...structuredClone(projection), unexpected: true }],
    ["invalid goal scalar", { ...structuredClone(projection), goal: null }],
    ["unknown nested field", { ...structuredClone(projection), envelope: { ...structuredClone(projection.envelope), unexpected: true } }],
  ];
  for (const [name, candidate] of cases) {
    await t.test(name, () => {
      const snapshot = resign(candidate);
      assert.throws(() => saveSnapshot(repo, snapshot), /invalid schema-v3/);
      fs.writeFileSync(taskPath(repo), `${canonicalJson(snapshot)}\n`);
      const bytesBefore = fs.readFileSync(taskPath(repo));
      assert.throws(() => recoverV3TaskSnapshot(repo), (error) => error.code === "MIXED_OR_INVALID_AUTHORITY");
      assert.deepEqual(fs.readFileSync(taskPath(repo)), bytesBefore);
    });
  }
});

test("a corrupt event authority never falls back to a valid snapshot", (t) => {
  const { repo, replay, projection } = openV3Repo(t, "snapshot-corrupt-authority");
  saveSnapshot(repo, buildSnapshot({ sourceCursor: replay.source_cursor, projection }));
  const snapshotBefore = fs.readFileSync(taskPath(repo));
  const authorityPath = path.join(repo, ".taskloop", "events-v3.jsonl");
  const record = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  record.record_digest = `sha256:${"0".repeat(64)}`;
  fs.writeFileSync(authorityPath, `${canonicalJson(record)}\n`);
  const authorityBefore = fs.readFileSync(authorityPath);

  assert.throws(
    () => recoverV3TaskSnapshot(repo),
    (error) => error.code === "CORRUPT_EVENT_AUTHORITY" && error.message === "schema-v3 event authority is corrupt; refusing snapshot fallback",
  );
  assert.deepEqual(fs.readFileSync(authorityPath), authorityBefore);
  assert.deepEqual(fs.readFileSync(taskPath(repo)), snapshotBefore);
});

test("sibling worktree advisory reads only digest-valid schema-v3 wrappers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-snapshot-sibling-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(primary);
  execFileSync("git", ["init", "-q"], { cwd: primary });
  execFileSync("git", ["config", "user.name", "Taskloop Test"], { cwd: primary });
  execFileSync("git", ["config", "user.email", "taskloop@example.invalid"], { cwd: primary });
  fs.writeFileSync(path.join(primary, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: primary });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: primary });
  execFileSync("git", ["worktree", "add", "-q", "-b", "snapshot-sibling", sibling], { cwd: primary });

  const source = openV3Repo(t, "snapshot-sibling-source");
  const snapshot = buildSnapshot({ sourceCursor: source.replay.source_cursor, projection: source.projection });
  saveSnapshot(sibling, snapshot);
  assert.deepEqual(siblingSnapshots(primary), [{
    path: fs.realpathSync(sibling),
    goal: source.projection.goal,
    files: source.projection.envelope.files,
    opened_at: source.projection.created_at,
    suspended: null,
  }]);

  const invalidProjection = { ...structuredClone(source.projection), goal: null };
  const invalidPreimage = { schema_version: 3, runtime_contract: 4, source_cursor: snapshot.source_cursor, projection: invalidProjection };
  const selfDigestedInvalid = { ...invalidPreimage, snapshot_digest: sha256Hex(canonicalJson(invalidPreimage)) };
  fs.writeFileSync(taskPath(sibling), `${canonicalJson(selfDigestedInvalid)}\n`);
  assert.deepEqual(siblingSnapshots(primary), []);

  snapshot.snapshot_digest = `sha256:${"0".repeat(64)}`;
  fs.writeFileSync(taskPath(sibling), `${canonicalJson(snapshot)}\n`);
  assert.deepEqual(siblingSnapshots(primary), []);
});
