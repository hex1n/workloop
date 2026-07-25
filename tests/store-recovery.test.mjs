// recoverTail (greenfield/slices/01-log-kernel.md §7) — the way back from
// damage the runtime refused to judge on its own, and the P12 boundary around
// a repair that happens inside a call that then refuses.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestOf, sha256Hex } from "../src/canonical.mjs";
import { encodeFrame } from "../src/frame.mjs";
import { createStore, openStore } from "../src/store.mjs";

const REQ = (value) => digestOf({ request: value });
const counter = (state, record) => ({ ...state, count: (state?.count ?? 0) + 1, seq: record.seq });

function fixture(t) {
  const location = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-recovery-"));
  t.after(() => fs.rmSync(location, { recursive: true, force: true }));
  createStore({ location, commandId: "genesis" });
  const open = () => openStore(location, { reduce: counter, initial: {} });
  const store = open();
  store.append({ commandId: "seed", requestDigest: REQ("seed"), prepare: () => [{ kind: "seed", payload: {} }] });
  const segment = path.join(location, "segments", "000001.log");
  return { location, open, store, segment, intact: fs.readFileSync(segment) };
}

// Damage that is not an unfinished write: a whole frame whose checksum is
// wrong. The kernel refuses to judge this on its own.
function damage(segment) {
  const bytes = fs.readFileSync(segment);
  const extra = encodeFrame(JSON.stringify({ looks: "complete" }));
  extra[extra.length - 1] ^= 0xff;
  fs.writeFileSync(segment, Buffer.concat([bytes, extra]));
  return { validEnd: bytes.length, tail: extra };
}

test("damage stays fatal until a person supplies both halves of the proof", (t) => {
  const { open, segment } = fixture(t);
  const { validEnd, tail } = damage(segment);
  assert.throws(() => open().read(), (error) => error.code === "STORE_DAMAGED");

  const store = open();
  const attempts = [
    [{ expectValidEndOffset: validEnd, expectTailDigest: sha256Hex(tail), grantedBy: "self", reason: "r" }, "PROVENANCE_REQUIRED"],
    [{ expectValidEndOffset: validEnd, expectTailDigest: sha256Hex(tail), grantedBy: "user", reason: "  " }, "REASON_REQUIRED"],
    [{ expectValidEndOffset: -1, expectTailDigest: sha256Hex(tail), grantedBy: "user", reason: "r" }, "INVALID_OFFSET"],
    // The offset is right but the digest is not: this is a stale instruction,
    // and obeying it would discard bytes nobody looked at.
    [{ expectValidEndOffset: validEnd, expectTailDigest: sha256Hex(Buffer.from("other")), grantedBy: "user", reason: "r" }, "RECOVERY_PROOF_MISMATCH"],
    // The digest is right but the offset is not.
    [{ expectValidEndOffset: validEnd - 4, expectTailDigest: sha256Hex(tail), grantedBy: "user", reason: "r" }, "RECOVERY_PROOF_MISMATCH"],
  ];
  const before = fs.readFileSync(segment);
  for (const [input, code] of attempts) {
    assert.throws(() => store.recoverTail(input), (error) => error.code === code, code);
    assert.deepEqual(fs.readFileSync(segment), before, `${code} must not touch a byte`);
  }
});

test("a proven recovery restores the store and records what it discarded", (t) => {
  const { open, segment } = fixture(t);
  const { validEnd, tail } = damage(segment);
  const store = open();
  const result = store.recoverTail({
    expectValidEndOffset: validEnd,
    expectTailDigest: sha256Hex(tail),
    grantedBy: "user",
    reason: "operator inspected the tail and accepted the loss",
  });
  assert.equal(result.recovered, true);
  assert.equal(result.discarded, tail.length);

  const records = open().read();
  const recovery = records.at(-1);
  assert.equal(recovery.kind, "tail_recovered");
  assert.equal(recovery.payload.bytes, tail.length);
  assert.equal(recovery.payload.digest, sha256Hex(tail));
  assert.equal(recovery.payload.reason, "operator inspected the tail and accepted the loss");
  // The store works again, and the recovery is part of its history rather than
  // an edit nobody can see.
  open().append({ commandId: "after", requestDigest: REQ("after"), prepare: () => [{ kind: "later", payload: {} }] });
  assert.equal(open().replay().seq, records.length + 1);
});

test("recovery is idempotent in effect: a second identical attempt is refused, not repeated", (t) => {
  const { open, segment } = fixture(t);
  const { validEnd, tail } = damage(segment);
  const proof = { expectValidEndOffset: validEnd, expectTailDigest: sha256Hex(tail), grantedBy: "user", reason: "accepted" };
  open().recoverTail(proof);
  const after = fs.readFileSync(segment);
  // The same instruction no longer describes the file: the bytes it names are
  // gone and the recovery record now sits there instead.
  assert.throws(() => open().recoverTail(proof), (error) => error.code === "RECOVERY_PROOF_MISMATCH");
  assert.deepEqual(fs.readFileSync(segment), after);
});

test("recovery that does not make the store readable refuses and says so", (t) => {
  const { open, segment, intact } = fixture(t);
  // Truncate into the middle of an existing record's frame, so the chain is
  // still broken after the named bytes are dropped.
  const cut = intact.length - 20;
  const tail = intact.subarray(cut);
  fs.writeFileSync(segment, intact);
  assert.throws(
    () => open().recoverTail({ expectValidEndOffset: cut, expectTailDigest: sha256Hex(tail), grantedBy: "user", reason: "wrong offset" }),
    (error) => error.code === "RECOVERY_INSUFFICIENT",
  );
});

test("P12 boundary: a repair inside a refused append survives, and is recorded", (t) => {
  const { location, open, segment } = fixture(t);
  const store = open();
  store.append({ commandId: "taken", requestDigest: REQ("taken"), prepare: () => [{ kind: "x", payload: {} }] });
  const half = encodeFrame('{"unfinished":true}').subarray(0, 9);
  fs.appendFileSync(segment, half);

  // The append refuses (the command id is already used with another request),
  // but the torn tail it repaired on the way in stays repaired. The log is not
  // byte-identical — and that is correct: the repair is its own recorded act,
  // not part of the refused command.
  assert.throws(
    () => store.append({ commandId: "taken", requestDigest: REQ("different"), prepare: () => [{ kind: "y", payload: {} }] }),
    (error) => error.code === "COMMAND_CONFLICT",
  );
  const records = open().read();
  assert.equal(records.at(-1).kind, "tail_truncated", "the repair is recorded");
  assert.equal(records.filter((record) => record.cmd === "taken").length, 1, "the refused command applied nothing");
  assert.equal(records.filter((record) => record.kind === "y").length, 0);
  assert.equal(fs.readdirSync(path.join(location, "locks")).length, 0, "the lock was released despite the refusal");
});
