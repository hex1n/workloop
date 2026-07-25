// Property P5 (chain integrity) from greenfield/slices/01-log-kernel.md, and
// the LK-08 family: a record whose bytes are internally consistent is still
// refused when it does not belong to this history.
import assert from "node:assert/strict";
import test from "node:test";
import { digestOf } from "../src/canonical.mjs";
import { RecordError, assertChain, assertRecordShape, buildRecord, digestBody } from "../src/record.mjs";

const GENESIS = digestOf({ genesis: true });
const REQ = digestOf({ request: "example" });

function chainOf(count, anchor = GENESIS) {
  const records = [];
  let prev = anchor;
  for (let index = 0; index < count; index += 1) {
    const record = buildRecord({ seq: index + 1, prev, cmd: `cmd-${index}`, req: REQ, kind: "example", payload: { index } });
    records.push(record);
    prev = record.digest;
  }
  return records;
}

// Rebuilds a valid-looking record around edited content, the way a forger with
// write access to the file would: every digest recomputes, so only the chain
// itself can reject it.
const forge = (record, changes) => {
  const body = { ...record, ...changes };
  delete body.digest;
  return { ...body, digest: digestOf(body) };
};

test("a built chain verifies and reports where the next record goes", () => {
  const records = chainOf(5);
  const { nextSeq, headDigest } = assertChain(records, { anchorDigest: GENESIS });
  assert.equal(nextSeq, 6);
  assert.equal(headDigest, records.at(-1).digest);
});

test("an empty chain verifies and leaves the anchor as the head", () => {
  assert.deepEqual(assertChain([], { anchorDigest: GENESIS }), { nextSeq: 1, headDigest: GENESIS });
});

test("every prefix of a valid chain is a valid chain", () => {
  const records = chainOf(6);
  for (let length = 0; length <= records.length; length += 1) {
    assert.equal(assertChain(records.slice(0, length), { anchorDigest: GENESIS }).nextSeq, length + 1);
  }
});

test("a tail verifies against the digest it hangs from, without replaying the head", () => {
  const records = chainOf(6);
  const { nextSeq } = assertChain(records.slice(3), { anchorDigest: records[2].digest, fromSeq: 4 });
  assert.equal(nextSeq, 7);
});

test("editing content breaks the digest", () => {
  const [record] = chainOf(1);
  assert.throws(
    () => assertRecordShape({ ...record, payload: { index: 99 } }),
    (error) => error instanceof RecordError && error.code === "DIGEST_MISMATCH",
  );
});

test("a re-digested forgery still cannot join the chain", () => {
  const records = chainOf(3);
  const forged = forge(records[1], { payload: { index: 99 } });
  assert.equal(digestBody(forged), forged.digest, "the forgery is internally consistent");
  assert.throws(
    () => assertChain([records[0], forged, records[2]], { anchorDigest: GENESIS }),
    (error) => error.code === "CHAIN_BREAK" && error.seq === 3,
  );
});

test("dropping a record is a sequence gap, not a shorter history", () => {
  const records = chainOf(4);
  assert.throws(
    () => assertChain([records[0], records[2], records[3]], { anchorDigest: GENESIS }),
    (error) => error.code === "SEQUENCE_GAP" && error.seq === 3,
  );
});

test("reordering records is refused", () => {
  const records = chainOf(3);
  assert.throws(
    () => assertChain([records[1], records[0], records[2]], { anchorDigest: GENESIS }),
    (error) => error.code === "SEQUENCE_GAP",
  );
});

test("a chain from another store cannot be adopted", () => {
  assert.throws(
    () => assertChain(chainOf(2), { anchorDigest: digestOf({ genesis: "other" }) }),
    (error) => error.code === "CHAIN_BREAK" && error.seq === 1,
  );
});

test("unknown schema generations fail closed rather than being read optimistically", () => {
  const [record] = chainOf(1);
  assert.throws(
    () => assertRecordShape(forge(record, { v: 2 })),
    (error) => error.code === "UNKNOWN_SCHEMA",
  );
});

test("records with missing or extra fields are refused", () => {
  const [record] = chainOf(1);
  assert.throws(() => assertRecordShape(forge(record, { extra: true })), (error) => error.code === "RECORD_FIELDS");
  const { payload, ...missing } = record;
  void payload;
  assert.throws(() => assertRecordShape(missing), (error) => error.code === "RECORD_FIELDS");
});

test("a record carries the request that produced it, so a retry is decidable", () => {
  const [record] = chainOf(1);
  assert.equal(record.req, REQ);
  // Without a durable copy of the request, a later process could not tell a
  // retry of the same command from a different command reusing its id.
  const { req, ...without } = record;
  void req;
  assert.throws(() => assertRecordShape(without), (error) => error.code === "RECORD_FIELDS");
});

test("building refuses inputs that could never be replayed", () => {
  const valid = { seq: 1, prev: GENESIS, cmd: "c", req: REQ, kind: "k", payload: {} };
  const cases = [
    [{ seq: 0 }, "INVALID_SEQ"],
    [{ seq: 1.5 }, "INVALID_SEQ"],
    [{ prev: "nope" }, "INVALID_PREV"],
    [{ cmd: "" }, "INVALID_COMMAND_ID"],
    [{ req: "nope" }, "INVALID_REQUEST_DIGEST"],
    [{ kind: "" }, "INVALID_KIND"],
    [{ payload: [] }, "INVALID_PAYLOAD"],
    [{ payload: null }, "INVALID_PAYLOAD"],
  ];
  for (const [changes, code] of cases) {
    assert.throws(() => buildRecord({ ...valid, ...changes }), (error) => error.code === code, JSON.stringify(changes));
  }
  // An unrepresentable payload is caught while the caller can still act on it,
  // not at write time when half the transaction has run.
  assert.throws(() => buildRecord({ ...valid, payload: { n: Number.NaN } }), (error) => error.code === "NON_FINITE_NUMBER");
});

test("built records are frozen so a caller cannot invalidate a digest in place", () => {
  const [record] = chainOf(1);
  assert.throws(() => { record.seq = 2; }, TypeError);
});
