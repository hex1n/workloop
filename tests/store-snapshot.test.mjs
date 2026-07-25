// Properties P2, P2b and P9 from greenfield/slices/01-log-kernel.md §5, §5.1:
// a snapshot is a cache. It must never change the answer, and it must never be
// able to stop the store from opening.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestOf } from "../src/canonical.mjs";
import { createStore, openStore } from "../src/store.mjs";

const REQ = (value) => digestOf({ request: value });
const counter = (state, record) => ({ ...state, count: (state?.count ?? 0) + 1, last: record.kind, seq: record.seq });

function fixture(t, options = {}) {
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-snapshot-"));
  t.after(() => fs.rmSync(location, { recursive: true, force: true }));
  createStore({ location, commandId: "genesis" });
  const open = (extra = {}) => openStore(location, { reduce: counter, initial: {}, snapshotEvery: 5, ...options, ...extra });
  const store = open();
  for (let index = 0; index < 24; index += 1) {
    store.append({ commandId: `cmd-${index}`, requestDigest: REQ(index), prepare: () => [{ kind: `k${index}`, payload: { index } }] });
  }
  return { location, store, open };
}

const snapshotFiles = (location) => fs.readdirSync(path.join(location, "snapshots")).sort();

test("snapshots are written as the log grows, and none is left half-written", (t) => {
  const { location } = fixture(t);
  const files = snapshotFiles(location);
  assert.ok(files.length >= 4, `expected several snapshots, got ${files.join(",")}`);
  assert.equal(files.some((name) => name.endsWith(".partial")), false, "no staging file survives");
});

test("P2: a snapshot never changes the answer", (t) => {
  const { store, open } = fixture(t);
  const withSnapshot = store.replay({ useSnapshot: true });
  const fromGenesis = store.replay({ useSnapshot: false });
  assert.ok(withSnapshot.snapshotUsed > 0, "a snapshot was actually used");
  assert.equal(fromGenesis.snapshotUsed, null);
  assert.deepEqual(withSnapshot.state, fromGenesis.state);
  assert.equal(withSnapshot.headDigest, fromGenesis.headDigest);
  assert.equal(withSnapshot.seq, fromGenesis.seq);
  // And the same holds for a process that never saw the writes happen.
  assert.deepEqual(open().replay().state, fromGenesis.state);
});

test("P9: deleting every snapshot changes nothing but the work done", (t) => {
  const { location, store, open } = fixture(t);
  const expected = store.replay({ useSnapshot: false }).state;
  fs.rmSync(path.join(location, "snapshots"), { recursive: true, force: true });
  const reopened = open();
  assert.deepEqual(reopened.replay().state, expected);
  assert.equal(reopened.replay().snapshotUsed, null);
  // The store keeps working, and takes a fresh snapshot when it next crosses
  // the interval rather than resurrecting the deleted ones.
  reopened.append({ commandId: "after-delete", requestDigest: REQ("after-delete"), prepare: () => [{ kind: "later", payload: {} }] });
  assert.deepEqual(reopened.replay({ useSnapshot: false }).state.count, 26);
});

test("P9: a corrupt snapshot is ignored, not fatal, and is left untouched", (t) => {
  const { location, store, open } = fixture(t);
  const expected = store.replay({ useSnapshot: false }).state;
  const victim = path.join(location, "snapshots", snapshotFiles(location).at(-1));
  fs.writeFileSync(victim, "not json at all");
  const reopened = open();
  assert.deepEqual(reopened.replay().state, expected, "the answer is unchanged");
  assert.equal(fs.readFileSync(victim, "utf8"), "not json at all", "a read never rewrites the damaged cache");
});

test("P2b: a snapshot that does not match the chain is ignored rather than obeyed", (t) => {
  const { location, store, open } = fixture(t);
  const expected = store.replay({ useSnapshot: false }).state;
  const victim = path.join(location, "snapshots", snapshotFiles(location).at(-1));
  const snapshot = JSON.parse(fs.readFileSync(victim, "utf8"));

  // Re-digested so the file is internally consistent: only its claim about
  // where it sits on the chain is false.
  const body = { store_id: snapshot.store_id, seq: snapshot.seq, head_digest: digestOf({ not: "the chain" }), state: { count: 999 } };
  fs.writeFileSync(victim, JSON.stringify({ ...body, digest: digestOf(body) }));
  assert.deepEqual(open().replay().state, expected);

  // A snapshot from another store is likewise ignored, not adopted.
  const foreign = { store_id: "0000000000000000", seq: snapshot.seq, head_digest: snapshot.head_digest, state: { count: 999 } };
  fs.writeFileSync(victim, JSON.stringify({ ...foreign, digest: digestOf(foreign) }));
  assert.deepEqual(open().replay().state, expected);
});

test("an older valid snapshot is used when the newest one is unusable", (t) => {
  const { location, store, open } = fixture(t);
  const expected = store.replay({ useSnapshot: false }).state;
  const files = snapshotFiles(location);
  assert.ok(files.length >= 2);
  fs.writeFileSync(path.join(location, "snapshots", files.at(-1)), "broken");
  const replayed = open().replay();
  assert.deepEqual(replayed.state, expected);
  assert.equal(replayed.snapshotUsed, Number(files.at(-2).slice(0, -5)), "it fell back to the previous snapshot rather than to genesis");
});

test("a snapshot cannot hide later damage to the log", (t) => {
  const { location, open } = fixture(t);
  // Damage a record that lies after the newest snapshot: the snapshot must not
  // let the store skip past a tail it cannot verify.
  const segment = path.join(location, "segments", fs.readdirSync(path.join(location, "segments")).sort().at(-1));
  const bytes = fs.readFileSync(segment);
  bytes[bytes.length - 6] ^= 0xff;
  fs.writeFileSync(segment, bytes);
  assert.throws(() => open().replay(), (error) => error.code === "STORE_DAMAGED");
});
