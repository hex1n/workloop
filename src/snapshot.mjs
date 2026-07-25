// Snapshots: a cache of the projection at a point on the chain.
//
// A snapshot is never authoritative. It is bound to a chain position by
// (seq, head_digest) and carries its own digest against file damage, but its
// state cannot be proven from the chain — the chain deliberately holds no
// projection, because that would tie the log to one caller's reducer. So every
// failure here ends in "ignore this snapshot", never in "refuse to open the
// store": a cache that can stop the store from opening is not disposable.
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, digestOf } from "./canonical.mjs";

const FILE_PATTERN = /^\d+\.json$/u;
const body = (snapshot) => ({ store_id: snapshot.store_id, seq: snapshot.seq, head_digest: snapshot.head_digest, reducer: snapshot.reducer ?? null, state: snapshot.state });

/**
 * The newest snapshot this reducer may read.
 *
 * A snapshot is one reducer's output, and a different reducer must not read
 * it: the fields it wrote are the fields that reducer had. A version of this
 * runtime that added a field found the old snapshots' missing key comparing as
 * `undefined` and silently dropped a fact — the loop's retired judgments came
 * back to life, with no error anywhere. So the reducer stamps its own identity
 * on what it writes, and skips anything stamped by another.
 */
export function readNewestSnapshot(directory, storeId, reducer = null) {
  let names;
  try {
    names = fs.readdirSync(directory).filter((name) => FILE_PATTERN.test(name));
  } catch {
    return null;
  }
  for (const seq of names.map((name) => Number(name.slice(0, -5))).sort((left, right) => right - left)) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(directory, `${seq}.json`), "utf8"));
      if (snapshot.store_id !== storeId) continue;
      if (snapshot.seq !== seq) continue;
      if ((snapshot.reducer ?? null) !== reducer) continue;
      if (digestOf(body(snapshot)) !== snapshot.digest) continue;
      return snapshot;
    } catch {
      continue;
    }
  }
  return null;
}

export function writeSnapshot(directory, { storeId, seq, headDigest, reducer = null, state }, onPhase = () => {}) {
  const content = { store_id: storeId, seq, head_digest: headDigest, reducer, state };
  const snapshot = { ...content, digest: digestOf(content) };
  const target = path.join(directory, `${seq}.json`);
  // Staged then renamed, so an interrupted write can only ever exist under a
  // name the reader does not recognise as a snapshot at all.
  const staging = `${target}.partial`;
  fs.mkdirSync(directory, { recursive: true });
  const handle = fs.openSync(staging, "w");
  try {
    fs.writeSync(handle, Buffer.from(`${canonicalJson(snapshot)}\n`, "utf8"));
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  onPhase("snapshot_staged");
  fs.renameSync(staging, target);
}

// A snapshot is usable only if the record it claims to sit behind really is
// the record at that position. Anything else means the log moved on without it.
export function snapshotFits(snapshot, records) {
  if (snapshot === null) return false;
  if (snapshot.seq < 1 || snapshot.seq > records.length) return false;
  return records[snapshot.seq - 1]?.digest === snapshot.head_digest;
}
