// Records and the hash chain over them.
//
// The chain is what makes replay authoritative: given the genesis digest, a
// reader can prove that the sequence it is holding is the sequence that was
// written, in the order it was written, with nothing inserted, dropped, or
// edited. Every check here refuses rather than repairs — a chain that does not
// verify is not a chain with a problem, it is not this store's history.
import { canonicalJson, digestOf, isPlainObject } from "./canonical.mjs";

export const RECORD_SCHEMA = 1;
// `req` is the digest of the request that produced this record. It is what
// makes a retry decidable: the same command id arriving with a different
// request is a caller mistake, not a retry, and only a durable copy of the
// original request lets a later process tell those two apart.
const FIELDS = ["v", "seq", "prev", "cmd", "req", "kind", "payload", "digest"];
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export class RecordError extends Error {
  constructor(code, message, seq = null) {
    super(seq === null ? message : `${message} (seq ${seq})`);
    this.name = "RecordError";
    this.code = code;
    this.seq = seq;
  }
}

const refuse = (code, message, seq) => {
  throw new RecordError(code, message, seq);
};

// isPlainObject comes from canonical.mjs so that "can this be a payload" and
// "can this be canonicalized" cannot drift apart: a payload the canonicalizer
// would accept must not be rejected here, and vice versa.
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

// The digest covers everything except itself, so it is taken over the record
// with the field absent rather than blank: a blank field would let two records
// with different digests hash identically.
export function digestBody(record) {
  const { digest, ...body } = record;
  void digest;
  return digestOf(body);
}

export function buildRecord({ seq, prev, cmd, req, kind, payload }) {
  if (!Number.isSafeInteger(seq) || seq < 1) refuse("INVALID_SEQ", "seq must be a positive integer");
  if (!DIGEST_PATTERN.test(prev)) refuse("INVALID_PREV", "prev must be a sha256 digest", seq);
  if (!isNonEmptyString(cmd)) refuse("INVALID_COMMAND_ID", "cmd must be a non-empty string", seq);
  if (!DIGEST_PATTERN.test(req)) refuse("INVALID_REQUEST_DIGEST", "req must be a sha256 digest", seq);
  if (!isNonEmptyString(kind)) refuse("INVALID_KIND", "kind must be a non-empty string", seq);
  if (!isPlainObject(payload)) refuse("INVALID_PAYLOAD", "payload must be a plain object", seq);
  const body = { v: RECORD_SCHEMA, seq, prev, cmd, req, kind, payload };
  // Canonicalizing here rather than at write time means an unrepresentable
  // payload is refused while the caller can still do something about it.
  canonicalJson(body);
  return Object.freeze({ ...body, digest: digestOf(body) });
}

export function assertRecordShape(record) {
  if (!isPlainObject(record)) refuse("INVALID_RECORD", "record must be a plain object");
  const keys = Object.keys(record).sort();
  if (canonicalJson(keys) !== canonicalJson([...FIELDS].sort())) {
    refuse("RECORD_FIELDS", `record fields must be exactly ${FIELDS.join(", ")}`, record.seq ?? null);
  }
  if (record.v !== RECORD_SCHEMA) refuse("UNKNOWN_SCHEMA", `record schema ${record.v} is not readable by this runtime`, record.seq ?? null);
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) refuse("INVALID_SEQ", "seq must be a positive integer", null);
  if (!DIGEST_PATTERN.test(record.prev)) refuse("INVALID_PREV", "prev must be a sha256 digest", record.seq);
  if (!DIGEST_PATTERN.test(record.digest)) refuse("INVALID_DIGEST", "digest must be a sha256 digest", record.seq);
  if (!isNonEmptyString(record.cmd)) refuse("INVALID_COMMAND_ID", "cmd must be a non-empty string", record.seq);
  if (!DIGEST_PATTERN.test(record.req)) refuse("INVALID_REQUEST_DIGEST", "req must be a sha256 digest", record.seq);
  if (!isNonEmptyString(record.kind)) refuse("INVALID_KIND", "kind must be a non-empty string", record.seq);
  if (!isPlainObject(record.payload)) refuse("INVALID_PAYLOAD", "payload must be a plain object", record.seq);
  if (digestBody(record) !== record.digest) refuse("DIGEST_MISMATCH", "record digest does not match its content", record.seq);
  return record;
}

// Verifies a run of records against the digest it should hang from. `fromSeq`
// lets a caller validate the tail after a snapshot without replaying the head.
export function assertChain(records, { anchorDigest, fromSeq = 1 }) {
  if (!DIGEST_PATTERN.test(anchorDigest)) refuse("INVALID_ANCHOR", "anchor digest must be a sha256 digest");
  let expectedSeq = fromSeq;
  let expectedPrev = anchorDigest;
  for (const record of records) {
    assertRecordShape(record);
    if (record.seq !== expectedSeq) refuse("SEQUENCE_GAP", `expected seq ${expectedSeq} but found ${record.seq}`, record.seq);
    if (record.prev !== expectedPrev) refuse("CHAIN_BREAK", "record does not follow its predecessor", record.seq);
    expectedSeq += 1;
    expectedPrev = record.digest;
  }
  return { nextSeq: expectedSeq, headDigest: expectedPrev };
}
