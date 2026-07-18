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
  assert.equal(snapshot.snapshot_digest, "sha256:7b11875e800051cf3fdbbfde823af4e63370eede6c579af22d88bbfb90d042e5");

  saveSnapshot(repo, snapshot);
  assert.deepEqual(inspectSnapshot(repo), { status: "valid", snapshot });
  const snapshotBytes = fs.readFileSync(taskPath(repo), "utf8");
  assert.deepEqual(JSON.parse(snapshotBytes), snapshot);
  assert.equal(snapshotBytes, `${JSON.stringify(JSON.parse(canonicalJson(snapshot)), null, 2)}\n`);
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
  const quarantineReceiptBytes = fs.readFileSync(invalidJson.diagnostic.receipt_path, "utf8");
  assert.deepEqual(JSON.parse(quarantineReceiptBytes), invalidJson.diagnostic);
  assert.equal(quarantineReceiptBytes, `${JSON.stringify(JSON.parse(canonicalJson(invalidJson.diagnostic)), null, 2)}\n`);

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

test("legacy criterion amendments rebuild with authored_by backfilled", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-legacy-amend-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const seed = "legacy-criterion-amend";
  const opened = makeTaskOpenedCommand({ seed, index: 1, atEpochMs: 1_784_000_000_000 });
  const openEvent = { ...decide(null, opened).events[0], task_event_sequence: 1 };
  const makeLegacy = (record, mutateEvent) => {
    const legacy = structuredClone(record);
    legacy.record_schema_version = 1;
    mutateEvent(legacy.events[0]);
    const eventPreimage = Object.fromEntries(Object.entries(legacy.events[0]).filter(([key]) => key !== "event_id"));
    legacy.events[0].event_id = sha256Hex(canonicalJson(eventPreimage));
    const recordPreimage = Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "record_digest"));
    legacy.record_digest = sha256Hex(canonicalJson(recordPreimage));
    return legacy;
  };
  const first = makeLegacy(buildRecord({
    transactionId: deterministicId(seed, "transaction", 1), commandId: null, repoSequence: 1,
    occurredAtEpochMs: opened.atEpochMs, actor: { kind: "cli", session_id: opened.actingSession }, previousRecordDigest: null, events: [openEvent],
  }), (event) => { delete event.payload.criterion.authored_by; });
  commitRecord(repo, first);
  const openedReplay = readEventStore(repo);
  const initial = evolveAll(null, openedReplay.events);
  assert.equal(initial.criterion.authored_by, "self");

  const criterion = structuredClone(opened.criterion);
  criterion.source.value = "node revised-check.mjs";
  criterion.criterion_generation_id = deterministicId(seed, "criterion-generation", 2);
  criterion.criterion_definition_hash = sha256Hex("legacy revised criterion");
  const legacyAssurance = structuredClone(initial.assurance);
  legacyAssurance.risk_floor_events = ["criterion_amend", "policy_amend"];
  const amendedAt = 1_784_000_001_000;
  const amendEvent = {
    ...decide(initial, { type: "amend", taskId: opened.taskId, at: new Date(amendedAt).toISOString(), reason: "legacy criterion revision", criterion, assurance: legacyAssurance }).events[0],
    task_event_sequence: 2,
  };
  const second = makeLegacy(buildRecord({
    transactionId: deterministicId(seed, "transaction", 2), commandId: null, repoSequence: 2,
    occurredAtEpochMs: amendedAt, actor: { kind: "cli", session_id: opened.actingSession }, previousRecordDigest: first.record_digest, events: [amendEvent],
  }), (event) => { delete event.payload.criterion.authored_by; delete event.payload.artifact_revision; });
  commitRecord(repo, second, { cursor: openedReplay.cursor });

  const replay = readEventStore(repo);
  const legacyProjection = evolveAll(null, replay.events);
  delete legacyProjection.criterion.authored_by;
  const snapshotPreimage = { schema_version: 3, runtime_contract: 4, source_cursor: replay.source_cursor, projection: legacyProjection };
  fs.writeFileSync(taskPath(repo), `${canonicalJson({ ...snapshotPreimage, snapshot_digest: sha256Hex(canonicalJson(snapshotPreimage)) })}\n`);
  assert.deepEqual(inspectSnapshot(repo), { status: "damaged", reason: "legacy_v3_criterion_authorship" });

  const recovered = recoverV3TaskSnapshot(repo);
  assert.equal(recovered.status, "rebuilt");
  assert.equal(recovered.reason, "legacy_v3_criterion_authorship");
  assert.equal(recovered.projection.criterion.authored_by, "self");
  assert.equal(recovered.projection.criterion.criterion_generation_id, criterion.criterion_generation_id);
  assert.equal(recovered.projection.criterion.criterion_definition_hash, criterion.criterion_definition_hash);
  assert.deepEqual(recovered.projection.assurance.risk_floor_events, ["criterion_amend", "policy_amend"]);
  assert.equal(inspectSnapshot(repo).status, "valid");
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
