// Properties P2, P2b and P9 from greenfield/slices/01-log-kernel.md §5, §5.1:
// a snapshot is a cache. It must never change the answer, and it must never be
// able to stop the store from opening.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { digestOf } from "../src/canonical.mjs";
import { readNewestSnapshot, writeSnapshot } from "../src/snapshot.mjs";
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

test("a snapshot is one reducer's output, and another reducer must not read it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-shape-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const written = { storeId: "s", seq: 3, headDigest: `sha256:${"a".repeat(64)}`, state: { kept: true } };

  writeSnapshot(directory, { ...written, reducer: "shape-one" });
  assert.ok(readNewestSnapshot(directory, "s", "shape-one"), "its own reducer reads it back");
  // A reducer that writes different fields would read this one's missing keys
  // as `undefined` and quietly lose whatever they meant. Skipping it costs a
  // replay; reading it costs an answer nobody can tell is wrong.
  assert.equal(readNewestSnapshot(directory, "s", "shape-two"), null);
  assert.equal(readNewestSnapshot(directory, "s", null), null, "and one that was stamped by nobody is not a match either");
});

test("the projection cannot change shape without saying so", () => {
  // The stamp is only a guard if it moves when the state does. Editing the
  // projection without bumping it would hand the next version snapshots whose
  // fields it does not have — which is exactly how a loop's retired judgments
  // once came back to life, silently.
  // Line endings normalised before anything else. Git checks out with CRLF on
  // Windows by default, and a line ending is not a change in the shape of the
  // state — so left alone this gate goes red on every Windows run for a reason
  // it does not name. It fails twice over, in fact: `";$"` does not match
  // `";\r\n"`, so the stamp line the digest is supposed to exclude stays in the
  // string being hashed.
  const source = fs.readFileSync(new URL("../src/domain/projection.mjs", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
  const body = source.replace(/^export const PROJECTION_SHAPE = "[^"]*";$/mu, "");
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  assert.equal(digest, "79e69ba999e84481",
    `src/domain/projection.mjs changed. Bump PROJECTION_SHAPE if the shape of the state changed, then set this digest to ${digest}.`);
});
