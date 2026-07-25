// The crash injection matrix C1–C8 from greenfield/slices/01-log-kernel.md §6.
//
// Every case here kills a real process with SIGKILL. A thrown exception would
// unwind cleanly through the code the test is trying to interrupt, and would
// prove only that the error path works.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestOf } from "../src/canonical.mjs";
import { encodeFrame } from "../src/frame.mjs";
import { createStore, openStore } from "../src/store.mjs";

const CHILD = path.resolve(import.meta.dirname, "helpers", "crash-child.mjs");
const REQ = (value) => digestOf({ request: value });
const counter = (state, record) => ({ ...state, count: (state?.count ?? 0) + 1, seq: record.seq });
const LEASE_MS = 300;

function fixture(t, { commands = 2, segmentMaxBytes } = {}) {
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-crash-"));
  t.after(() => fs.rmSync(location, { recursive: true, force: true }));
  createStore({ location, commandId: "genesis" });
  const open = () => openStore(location, {
    reduce: counter, initial: {}, snapshotEvery: 3, lockLeaseMs: LEASE_MS,
    ...(segmentMaxBytes === undefined ? {} : { segmentMaxBytes }),
  });
  const store = open();
  for (let index = 0; index < commands; index += 1) {
    store.append({ commandId: `seed-${index}`, requestDigest: REQ(index), prepare: () => [{ kind: "seed", payload: { index } }] });
  }
  return { location, open };
}

function crashAt(location, phase, commandId, { padding = 0, segmentMaxBytes } = {}) {
  const result = spawnSync(process.execPath, [CHILD, location, phase, commandId, REQ(commandId), String(padding)], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, LOCK_LEASE_MS: String(LEASE_MS), ...(segmentMaxBytes === undefined ? {} : { SEGMENT_MAX_BYTES: String(segmentMaxBytes) }) },
  });
  // Proves the crash was the injected one. Without this, a child that died of
  // a syntax error would satisfy every "the child did not finish" assertion
  // below and the whole matrix would pass while testing nothing.
  assert.equal(result.signal, "SIGKILL", `expected a kill at ${phase}, got signal=${result.signal} status=${result.status} stderr=${result.stderr}`);
  assert.equal(result.stderr.trim(), "", `the child must die at ${phase}, not fail: ${result.stderr}`);
  assert.equal(result.stdout.trim(), "", `the child must not have completed its append at ${phase}`);
  return result;
}

const logBytes = (location) => fs.readdirSync(path.join(location, "segments")).sort()
  .map((name) => fs.readFileSync(path.join(location, "segments", name)).toString("base64"));

// Phases at which nothing has been written yet: the log must be untouched and
// the command must be re-runnable to completion.
for (const phase of ["lock_acquired", "tail_read", "idempotence_checked", "prepared"]) {
  test(`C1: a crash at ${phase} leaves the log untouched and the command re-runnable`, (t) => {
    const { location, open } = fixture(t);
    const before = logBytes(location);
    const seqBefore = open().replay().seq;

    crashAt(location, phase, "interrupted");
    assert.deepEqual(logBytes(location), before, "no bytes were written");

    const store = open();
    assert.equal(store.replay().seq, seqBefore, "the command was not applied");
    const applied = store.append({ commandId: "interrupted", requestDigest: REQ("interrupted"), prepare: () => [{ kind: "crash", payload: {} }] });
    assert.equal(applied.replayed, false);
    assert.equal(store.replay().seq, seqBefore + 1);
  });
}

test("C3: a crash after writing but before fsync applies the command fully or not at all", (t) => {
  const { location, open } = fixture(t);
  const seqBefore = open().replay().seq;
  crashAt(location, "frames_written", "unsynced");

  // Process death does not discard the page cache, so in practice the bytes
  // are usually there. Either outcome is legal; a partial application is not.
  const store = open();
  const seqAfter = store.replay().seq;
  assert.ok(seqAfter === seqBefore || seqAfter === seqBefore + 1, `seq moved from ${seqBefore} to ${seqAfter}`);
  const records = store.read().filter((record) => record.cmd === "unsynced");
  assert.ok(records.length === 0 || records.length === 1, "the command is present whole or not at all");

  // Either way the retry is safe: it completes the command or reports it done.
  const retried = store.append({ commandId: "unsynced", requestDigest: REQ("unsynced"), prepare: () => [{ kind: "crash", payload: {} }] });
  assert.equal(retried.replayed, records.length === 1);
  assert.equal(store.replay().seq, seqBefore + 1);
});

test("C4: a crash after fsync leaves the command applied and the retry idempotent", (t) => {
  const { location, open } = fixture(t);
  const seqBefore = open().replay().seq;
  crashAt(location, "frames_fsynced", "durable");

  const store = open();
  assert.equal(store.replay().seq, seqBefore + 1, "the command is durable");
  const retried = store.append({ commandId: "durable", requestDigest: REQ("durable"), prepare: () => assert.fail("prepare must not run for a completed command") });
  assert.equal(retried.replayed, true);
  assert.equal(store.replay().seq, seqBefore + 1, "the retry adds nothing");
});

test("C6: a crash before release leaves a lock that the next process reclaims", (t) => {
  const { location, open } = fixture(t);
  const seqBefore = open().replay().seq;
  crashAt(location, "before_release", "held");

  const locks = fs.readdirSync(path.join(location, "locks"));
  assert.equal(locks.length, 1, "the dead process left its lock behind");

  // Reclaiming waits for the dead holder's declared lease, then proceeds.
  const store = open();
  assert.equal(store.replay().seq, seqBefore + 1);
  store.append({ commandId: "after-lock", requestDigest: REQ("after-lock"), prepare: () => [{ kind: "later", payload: {} }] });
  assert.equal(store.replay().seq, seqBefore + 2);
  assert.deepEqual(fs.readdirSync(path.join(location, "locks")), [], "the lock is cleaned up once reclaimed");
});

test("C8: a crash right after a new segment is created leaves a valid empty segment", (t) => {
  const { location, open } = fixture(t, { segmentMaxBytes: 400 });
  const seqBefore = open().replay().seq;
  const before = fs.readdirSync(path.join(location, "segments")).length;

  crashAt(location, "segment_created", "rotating", { padding: 200, segmentMaxBytes: 400 });
  const after = fs.readdirSync(path.join(location, "segments")).sort();
  assert.equal(after.length, before + 1, "the empty segment exists");
  assert.equal(fs.statSync(path.join(location, "segments", after.at(-1))).size, 0);

  const store = open();
  assert.equal(store.replay().seq, seqBefore, "an empty segment holds no records");
  store.append({ commandId: "rotating", requestDigest: REQ("rotating"), prepare: () => [{ kind: "crash", payload: {} }] });
  assert.equal(store.replay().seq, seqBefore + 1);
});

test("C5: a process killed while staging a snapshot leaves nothing that loads as one", (t) => {
  // Four seeds plus genesis puts the child's append on seq 6, which is the
  // boundary its snapshotEvery of 3 triggers on — otherwise the phase is never
  // reached and the kill would silently not happen.
  const { location, open } = fixture(t, { commands: 4 });
  const snapshots = path.join(location, "snapshots");
  const before = fs.readdirSync(snapshots).filter((name) => name.endsWith(".json"));

  // Killed after the staging file is written and fsynced but before it is
  // renamed into place — the one instant where a half-finished snapshot could
  // exist on disk.
  crashAt(location, "snapshot_staged", "staging");
  const after = fs.readdirSync(snapshots);
  assert.deepEqual(after.filter((name) => name.endsWith(".json")), before, "no new snapshot became visible");
  assert.ok(after.some((name) => name.endsWith(".partial")), "the staging file is what was left behind");

  // The record itself was durable before the snapshot was attempted, and the
  // orphaned staging file is not mistaken for a snapshot.
  const store = open();
  assert.deepEqual(store.replay().state, store.replay({ useSnapshot: false }).state);
  assert.equal(store.read().at(-1).cmd, "staging");
});

test("C2: an unfinished frame at any byte offset is discarded, and only that command is lost", (t) => {
  const { location, open } = fixture(t);
  const segments = path.join(location, "segments");
  const segment = path.join(segments, fs.readdirSync(segments).sort().at(-1));
  const intact = fs.readFileSync(segment);
  const seqBefore = open().replay().seq;
  const frame = encodeFrame(JSON.stringify({ pretending: "to be a record" }));

  // Every cut inside the frame, including the one that leaves the payload
  // complete and only the last checksum byte missing.
  for (const cut of [1, 3, 4, 8, 8 + Math.floor((frame.length - 8) / 2), frame.length - 1]) {
    fs.writeFileSync(segment, Buffer.concat([intact, frame.subarray(0, cut)]));
    const store = open();
    assert.throws(() => store.read(), (error) => error.code === "STORE_TORN", `cut ${cut}: a read must refuse rather than repair`);

    const applied = store.append({ commandId: `after-${cut}`, requestDigest: REQ(cut), prepare: () => [{ kind: "crash", payload: {} }] });
    const repair = store.read().find((record) => record.kind === "tail_truncated");
    assert.equal(repair.payload.bytes, cut, `cut ${cut}: the repair records how much was dropped`);
    assert.equal(applied.records[0].seq, repair.seq + 1, `cut ${cut}: the discarded bytes never held a record`);
    assert.equal(store.replay().seq, seqBefore + 2, `cut ${cut}: the repair and the command each took one seq`);
    fs.writeFileSync(segment, intact);
  }
});

test("after every crash the store is still a valid chain from genesis", (t) => {
  const { location, open } = fixture(t);
  for (const [index, phase] of ["lock_acquired", "prepared", "frames_written", "frames_fsynced", "before_release"].entries()) {
    crashAt(location, phase, `sequence-${index}`);
    const store = open();
    const records = store.read();
    assert.equal(records.at(-1).seq, records.length, "seq stays contiguous");
    assert.equal(store.replay({ useSnapshot: false }).headDigest, records.at(-1).digest);
    assert.deepEqual(store.replay().state, store.replay({ useSnapshot: false }).state);
  }
});
