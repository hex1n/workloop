// Properties P1, P3, P4, P6, P8, P10, P11, P12 and scenario LK-10 from
// greenfield/slices/01-log-kernel.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestOf } from "../src/canonical.mjs";
import { encodeFrame } from "../src/frame.mjs";
import { createStore, openStore } from "../src/store.mjs";

const REQ = (value) => digestOf({ request: value });
const counter = (state, record) => ({ ...state, [record.kind]: (state?.[record.kind] ?? 0) + 1, seq: record.seq });

function fixture(t, options = {}) {
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-store-"));
  t.after(() => fs.rmSync(location, { recursive: true, force: true }));
  createStore({ location, commandId: "genesis" });
  return { location, store: openStore(location, { reduce: counter, initial: {}, ...options }) };
}

const put = (store, id, kind = "example", payload = { id }) =>
  store.append({ commandId: id, requestDigest: REQ(id), prepare: () => [{ kind, payload }] });

const segmentBytes = (location) => fs.readdirSync(path.join(location, "segments")).sort()
  .map((name) => fs.readFileSync(path.join(location, "segments", name)));

test("a new store replays its own genesis and nothing else", (t) => {
  const { store } = fixture(t);
  const records = store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].seq, 1);
  assert.equal(store.replay().seq, 1);
});

test("P1: replaying the same log twice gives the same projection", (t) => {
  const { location, store } = fixture(t);
  for (let index = 0; index < 20; index += 1) put(store, `cmd-${index}`);
  const first = store.replay();
  const second = openStore(location, { reduce: counter, initial: {} }).replay();
  assert.deepEqual(first.state, second.state);
  assert.equal(first.headDigest, second.headDigest);
  assert.equal(digestOf(first.state), digestOf(second.state));
});

test("P3: a retried command changes nothing and reports itself as a replay", (t) => {
  const { location, store } = fixture(t);
  const first = store.append({ commandId: "once", requestDigest: REQ("once"), prepare: () => [{ kind: "a", payload: {} }, { kind: "b", payload: {} }] });
  const before = segmentBytes(location);
  const again = store.append({ commandId: "once", requestDigest: REQ("once"), prepare: () => assert.fail("prepare must not run for a known command") });
  assert.equal(again.replayed, true);
  assert.equal(first.replayed, false);
  assert.deepEqual(again.records.map((record) => record.seq), first.records.map((record) => record.seq));
  assert.deepEqual(segmentBytes(location), before, "a replay writes no bytes");
});

test("P4: the same command id with a different request is refused, and nothing is written", (t) => {
  const { location, store } = fixture(t);
  put(store, "cmd");
  const before = segmentBytes(location);
  assert.throws(
    () => store.append({ commandId: "cmd", requestDigest: REQ("something else"), prepare: () => [{ kind: "x", payload: {} }] }),
    (error) => error.code === "COMMAND_CONFLICT",
  );
  assert.deepEqual(segmentBytes(location), before);
});

test("P6: prepare sees fresh state under the lock, and its refusal writes nothing", (t) => {
  const { location, store } = fixture(t);
  put(store, "first");
  const seen = [];
  store.append({ commandId: "second", requestDigest: REQ("second"), prepare: (state, context) => {
    seen.push({ state, context });
    return [{ kind: "example", payload: {} }];
  } });
  assert.equal(seen[0].state.example, 1, "state includes everything committed before this command");
  assert.equal(seen[0].context.seq, 3, "the caller is told which seq its first record will take");

  const before = segmentBytes(location);
  assert.throws(
    () => store.append({ commandId: "third", requestDigest: REQ("third"), prepare: (state) => {
      // A stale expectation is the caller's own check against fresh state:
      // the kernel supplies the state, the caller supplies the meaning.
      if (state.example !== 99) throw Object.assign(new Error("stale"), { code: "STALE_EXPECTATION" });
      return [{ kind: "example", payload: {} }];
    } }),
    (error) => error.code === "STALE_EXPECTATION",
  );
  assert.deepEqual(segmentBytes(location), before);
});

test("P12: every refusal leaves the log byte-identical", (t) => {
  const { location, store } = fixture(t);
  put(store, "cmd");
  const before = segmentBytes(location);
  const refusals = [
    () => store.append({ commandId: "", requestDigest: REQ("x"), prepare: () => [] }),
    () => store.append({ commandId: "x", requestDigest: 1, prepare: () => [] }),
    () => store.append({ commandId: "x", requestDigest: REQ("x"), prepare: null }),
    () => store.append({ commandId: "x", requestDigest: REQ("x"), prepare: () => [] }),
    () => store.append({ commandId: "x", requestDigest: REQ("x"), prepare: () => [{ kind: "k", payload: { bad: Number.NaN } }] }),
    () => store.append({ commandId: "x", requestDigest: REQ("x"), prepare: () => [{ kind: "", payload: {} }] }),
  ];
  for (const [index, refusal] of refusals.entries()) {
    assert.throws(refusal, undefined, `refusal ${index}`);
    assert.deepEqual(segmentBytes(location), before, `refusal ${index} wrote bytes`);
  }
});

test("P8: reading and replaying change no bytes and no timestamps", (t) => {
  const { location, store } = fixture(t);
  put(store, "cmd");
  const files = [path.join(location, "manifest.json"), ...fs.readdirSync(path.join(location, "segments")).map((name) => path.join(location, "segments", name))];
  const snapshot = () => files.map((file) => {
    const stat = fs.statSync(file, { bigint: true });
    return { bytes: fs.readFileSync(file).toString("base64"), mtime: stat.mtimeNs.toString() };
  });
  const before = snapshot();
  store.read();
  store.replay();
  openStore(location, { reduce: counter, initial: {} }).read();
  assert.deepEqual(snapshot(), before);
});

test("P10: rotation preserves the chain and the projection", (t) => {
  const { location } = fixture(t);
  // A segment size small enough that most commands start a new one.
  const store = openStore(location, { reduce: counter, initial: {}, segmentMaxBytes: 400 });
  for (let index = 0; index < 25; index += 1) put(store, `cmd-${index}`, "example", { id: index, padding: "x".repeat(50) });
  const segments = fs.readdirSync(path.join(location, "segments")).sort();
  assert.ok(segments.length > 3, `expected several segments, got ${segments.length}`);

  const reopened = openStore(location, { reduce: counter, initial: {}, segmentMaxBytes: 400 });
  assert.equal(reopened.replay().seq, 26);
  assert.deepEqual(reopened.replay().state, store.replay().state);
  const seqs = reopened.read().map((record) => record.seq);
  assert.deepEqual(seqs, Array.from({ length: 26 }, (_, index) => index + 1), "seq stays contiguous across segment boundaries");
});

test("LK-10: an unfinished write is truncated by the next append, not by a read", (t) => {
  const { location, store } = fixture(t);
  put(store, "cmd");
  const segment = path.join(location, "segments", "000001.log");
  const intact = fs.readFileSync(segment);
  const halfFrame = encodeFrame('{"unfinished":true}').subarray(0, 9);
  fs.appendFileSync(segment, halfFrame);

  // A read must not repair: a query that silently rewrites the log would make
  // "read-only" a lie.
  assert.throws(() => store.read(), (error) => error.code === "STORE_TORN");
  assert.equal(fs.readFileSync(segment).length, intact.length + halfFrame.length);

  const appended = store.append({ commandId: "after-tear", requestDigest: REQ("after-tear"), prepare: () => [{ kind: "example", payload: {} }] });
  assert.equal(appended.records[0].seq, 3, "the discarded bytes never held a record");
  const records = store.read();
  assert.equal(records.length, 3);
  assert.equal(records.at(-1).cmd, "after-tear");
});

test("LK-10: a complete frame with a bad checksum is never repaired automatically", (t) => {
  const { location, store } = fixture(t);
  put(store, "cmd");
  const segment = path.join(location, "segments", "000001.log");
  const damaged = fs.readFileSync(segment);
  damaged[damaged.length - 6] ^= 0xff;
  fs.writeFileSync(segment, damaged);

  for (const attempt of [() => store.read(), () => put(store, "next")]) {
    assert.throws(attempt, (error) => error.code === "STORE_DAMAGED");
  }
  assert.deepEqual(fs.readFileSync(segment), damaged, "the damaged bytes are left for a human");
});

test("P11: a forged record with a recomputed digest cannot join the chain", (t) => {
  const { location, store } = fixture(t);
  put(store, "cmd");
  const segment = path.join(location, "segments", "000001.log");
  const last = store.read().at(-1);
  const forgedBody = { v: last.v, seq: last.seq + 1, prev: digestOf({ not: "the head" }), cmd: "forged", req: REQ("forged"), kind: "example", payload: {} };
  const forged = { ...forgedBody, digest: digestOf(forgedBody) };
  fs.appendFileSync(segment, encodeFrame(JSON.stringify(forged)));
  assert.throws(() => store.read(), (error) => error.code === "CHAIN_BREAK");
});

test("P11: a missing or renumbered segment fails closed", (t) => {
  const { location } = fixture(t);
  const store = openStore(location, { reduce: counter, initial: {}, segmentMaxBytes: 300 });
  for (let index = 0; index < 12; index += 1) put(store, `cmd-${index}`, "example", { padding: "y".repeat(60) });
  const segments = fs.readdirSync(path.join(location, "segments")).sort();
  assert.ok(segments.length >= 3);
  fs.rmSync(path.join(location, "segments", segments[1]));
  assert.throws(() => store.read(), (error) => error.code === "SEGMENT_GAP");
});

test("a copied store is refused because its identity belongs elsewhere", (t) => {
  const { location, store } = fixture(t);
  put(store, "cmd");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-store-copy-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(location, copy, { recursive: true });
  assert.throws(() => openStore(copy, { reduce: counter, initial: {} }), (error) => error.code === "STORE_COLLISION");
  // The original is untouched by someone else's copy.
  assert.equal(openStore(location, { reduce: counter, initial: {} }).replay().seq, 2);
});

test("creating a store where one already exists is refused", (t) => {
  const { location } = fixture(t);
  assert.throws(() => createStore({ location, commandId: "again" }), (error) => error.code === "STORE_EXISTS");
});

test("an unreadable or foreign manifest fails closed", (t) => {
  const { location } = fixture(t);
  const manifest = path.join(location, "manifest.json");
  const original = fs.readFileSync(manifest, "utf8");
  fs.writeFileSync(manifest, "not json");
  assert.throws(() => openStore(location), (error) => error.code === "MANIFEST_UNREADABLE");
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), store_schema: 99 }));
  assert.throws(() => openStore(location), (error) => error.code === "UNKNOWN_STORE_SCHEMA");
});
