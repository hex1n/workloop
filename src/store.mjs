// The store: segmented append-only log, replay, idempotence, and the recovery
// policy that decides when damage is survivable.
//
// The store knows nothing about loops, rounds, or judgments. It appends opaque
// records, replays them through a reducer the caller supplies, and refuses
// anything it cannot prove. Domain meaning arrives in slice 2 and must not
// leak backwards into this file.
import { getRandomValues } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, digestOf, isPlainObject, sha256Hex } from "./canonical.mjs";
import { TRAILING, encodeFrame, scanFrames } from "./frame.mjs";
import { assertChain, buildRecord } from "./record.mjs";
import { CLASSES, createLockManager } from "./locks.mjs";
import { readNewestSnapshot, snapshotFits, writeSnapshot } from "./snapshot.mjs";

export const STORE_SCHEMA = 1;
export const DEFAULT_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST = "manifest.json";
const SEGMENTS = "segments";
const SNAPSHOTS = "snapshots";
const LOCKS = "locks";
const SEGMENT_DIGITS = 6;

// Named so a crash-injection test can stop the process at an exact point. The
// hook is inert in production; it exists because "survives a crash here" is
// only credible when "here" can be pointed at.
export const PHASES = Object.freeze([
  "lock_acquired",
  "tail_repaired",
  "tail_read",
  "idempotence_checked",
  "prepared",
  "segment_created",
  "frames_written",
  "frames_fsynced",
  "snapshot_staged",
  "snapshot_written",
  "before_release",
]);

// Kinds the kernel writes about the log itself. They are not domain vocabulary
// — they record what happened to the file, which is exactly the kind of fact a
// caller must never have to take on trust.
export const KERNEL_KINDS = Object.freeze({ TAIL_TRUNCATED: "tail_truncated", TAIL_RECOVERED: "tail_recovered" });

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new StoreError(code, message);
};

const segmentName = (index) => `${String(index).padStart(SEGMENT_DIGITS, "0")}.log`;
const segmentIndex = (name) => (/^\d{6}\.log$/u.test(name) ? Number(name.slice(0, SEGMENT_DIGITS)) : null);

function listSegments(location) {
  const directory = path.join(location, SEGMENTS);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") refuse("STORE_INCOMPLETE", `${directory} is missing`);
    throw error;
  }
  const indexes = names.map(segmentIndex).filter((index) => index !== null).sort((left, right) => left - right);
  if (indexes.length === 0) refuse("STORE_INCOMPLETE", "the store has no segments");
  // A gap would mean a segment was deleted; replaying across it would silently
  // invent a history that skips whatever it held.
  for (const [position, index] of indexes.entries()) {
    if (index !== position + 1) refuse("SEGMENT_GAP", `segment ${position + 1} is missing`);
  }
  return indexes.map((index) => ({ index, file: path.join(directory, segmentName(index)) }));
}

function readManifest(location) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(location, MANIFEST), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") refuse("NOT_A_STORE", `${location} is not a store`);
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    refuse("MANIFEST_UNREADABLE", "the manifest is not valid JSON");
  }
  if (!isPlainObject(manifest)) refuse("MANIFEST_UNREADABLE", "the manifest is not an object");
  if (manifest.store_schema !== STORE_SCHEMA) refuse("UNKNOWN_STORE_SCHEMA", `store schema ${manifest.store_schema} is not readable by this runtime`);
  return manifest;
}

// Physical identity of the place the store lives. A copied store carries the
// same store_id but lands on a different object, which is the only thing that
// tells a copy apart from the original.
export function physicalAnchor(target) {
  const stat = fs.statSync(fs.realpathSync.native(target));
  return digestOf({
    platform: process.platform,
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime_ns: String(stat.birthtimeMs),
  });
}

function writeFileDurably(file, bytes) {
  const handle = fs.openSync(file, "w");
  try {
    fs.writeSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

export function createStore({ location, commandId, requestDigest = digestOf({ genesis: true }), kind = "store_created", payload = {} }) {
  if (fs.existsSync(path.join(location, MANIFEST))) refuse("STORE_EXISTS", `${location} already holds a store`);
  fs.mkdirSync(path.join(location, SEGMENTS), { recursive: true });
  fs.mkdirSync(path.join(location, SNAPSHOTS), { recursive: true });
  fs.mkdirSync(path.join(location, LOCKS), { recursive: true });
  const manifest = {
    store_schema: STORE_SCHEMA,
    store_id: digestOf({ created: location, entropy: [...getRandomValues(new Uint32Array(4))] }).slice("sha256:".length, "sha256:".length + 32),
    anchor: physicalAnchor(location),
    genesis_digest: null,
  };
  // The genesis digest anchors the chain and is derived from the manifest's
  // own immutable facts, so a store cannot adopt another store's history.
  manifest.genesis_digest = digestOf({ store_schema: manifest.store_schema, store_id: manifest.store_id, anchor: manifest.anchor });
  writeFileDurably(path.join(location, MANIFEST), Buffer.from(`${canonicalJson(manifest)}\n`, "utf8"));
  fs.writeFileSync(path.join(location, SEGMENTS, segmentName(1)), Buffer.alloc(0));
  const store = openStore(location);
  store.append({ commandId, requestDigest, prepare: () => [{ kind, payload }] });
  return store;
}

export function openStore(location, {
  reduce = (state) => state,
  initial = null,
  segmentMaxBytes = DEFAULT_SEGMENT_MAX_BYTES,
  snapshotEvery = 500,
  verifyAnchor = true,
  lockTimeoutMs = 10_000,
  lockLeaseMs = 60_000,
  onPhase = () => {},
} = {}) {
  const manifest = readManifest(location);
  if (verifyAnchor && physicalAnchor(location) !== manifest.anchor) {
    refuse("STORE_COLLISION", "this store's identity belongs to a different location; it looks like a copy");
  }
  const locks = createLockManager({
    resolveLockPath: ({ lockClass, resourceId }) => path.join(location, LOCKS, `${lockClass}-${encodeURIComponent(resourceId)}.lock`),
    defaults: { timeoutMs: lockTimeoutMs, leaseMs: lockLeaseMs },
  });

  const snapshotDirectory = path.join(location, SNAPSHOTS);

  // Writes one record of the kernel's own, describing something that happened
  // to the log itself. Used by tail repair, which must leave a trace: bytes
  // that vanish without a record are exactly the kind of silent change this
  // runtime exists to make impossible.
  function appendKernelRecord(target, { records, headDigest, nextSeq }, { kind, payload, commandId, requestDigest }) {
    const record = buildRecord({ seq: nextSeq, prev: headDigest, cmd: commandId, req: requestDigest, kind, payload });
    const handle = fs.openSync(target, "a");
    try {
      fs.writeSync(handle, encodeFrame(canonicalJson(record)));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    records.push(record);
    return record;
  }

  // Reads the whole log and decides what to do about anything at the end of it
  // that is not a complete frame. `repair` is only ever true under the store
  // lock: truncation is a write.
  function load({ repair = false, useSnapshot = false } = {}) {
    const segments = listSegments(location);
    const records = [];
    const commands = new Map();
    const snapshot = useSnapshot ? readNewestSnapshot(snapshotDirectory, manifest.store_id) : null;
    let bytes = 0;
    let truncated = null;
    for (const segment of segments) {
      const content = fs.readFileSync(segment.file);
      const { frames, trailing } = scanFrames(content);
      for (const frame of frames) {
        let parsed;
        try {
          parsed = JSON.parse(frame.payload.toString("utf8"));
        } catch {
          refuse("RECORD_UNREADABLE", `a frame in ${path.basename(segment.file)} is not valid JSON`);
        }
        records.push(parsed);
      }
      bytes = content.length;
      if (trailing.kind === TRAILING.NONE) continue;
      const isLastSegment = segment.index === segments.at(-1).index;
      if (!isLastSegment || trailing.kind === TRAILING.CORRUPT) {
        // Corruption, or damage anywhere but the very end, cannot be shown to
        // be an unfinished write, so it is never discarded automatically.
        refuse("STORE_DAMAGED", `${path.basename(segment.file)} is damaged at byte ${trailing.offset}: ${trailing.reason}`);
      }
      if (!repair) refuse("STORE_TORN", `${path.basename(segment.file)} ends with an unfinished write at byte ${trailing.offset}`);
      // An unfinished write was never acknowledged to anyone, so discarding it
      // loses nothing that was ever promised. It is still recorded below: the
      // bytes may be worthless, but the fact that they were dropped is not.
      const discarded = content.subarray(trailing.offset);
      fs.truncateSync(segment.file, trailing.offset);
      bytes = trailing.offset;
      truncated = { segment: segment.index, offset: trailing.offset, bytes: discarded.length, digest: sha256Hex(discarded) };
    }
    // A usable snapshot lets the chain be verified from where it left off; an
    // unusable one simply is not used. Either way the records themselves are
    // the authority.
    const usable = snapshotFits(snapshot, records);
    const from = usable ? snapshot.seq : 0;
    let { nextSeq, headDigest } = assertChain(records.slice(from), {
      anchorDigest: usable ? snapshot.head_digest : manifest.genesis_digest,
      fromSeq: from + 1,
    });
    if (truncated !== null) {
      // The repair becomes part of the history, so a later reader can see that
      // bytes were discarded, how many, and what they hashed to.
      const record = appendKernelRecord(segments.at(-1).file, { records, headDigest, nextSeq }, {
        kind: KERNEL_KINDS.TAIL_TRUNCATED,
        payload: truncated,
        commandId: `kernel:tail-truncated:${truncated.digest}`,
        requestDigest: digestOf(truncated),
      });
      nextSeq = record.seq + 1;
      headDigest = record.digest;
      bytes = fs.statSync(segments.at(-1).file).size;
    }
    for (const record of records) {
      const seen = commands.get(record.cmd);
      if (seen === undefined) commands.set(record.cmd, { req: record.req, seqs: [record.seq] });
      else {
        if (seen.req !== record.req) refuse("COMMAND_INCONSISTENT", `command ${record.cmd} appears with two different requests`);
        seen.seqs.push(record.seq);
      }
    }
    let state = usable ? snapshot.state : initial;
    for (const record of records.slice(from)) state = reduce(state, record);
    const last = segments.at(-1);
    return { records, commands, state, nextSeq, headDigest, truncated, snapshotUsed: usable ? snapshot.seq : null, segment: last.index, segmentFile: last.file, segmentBytes: bytes };
  }

  const api = {
    location,
    manifest: Object.freeze({ ...manifest }),
    get poisoned() { return locks.poisoned; },

    // Read-only: never repairs, so a torn tail is reported rather than silently
    // rewritten by something the caller believed was a query.
    read({ fromSeq = 1 } = {}) {
      return load().records.filter((record) => record.seq >= fromSeq);
    },

    // The records a command already wrote, or null if it never ran. Lets a
    // caller recognise its own retry before doing expensive work that the log
    // would only refuse afterwards.
    commandRecords(commandId) {
      const loaded = load();
      const seen = loaded.commands.get(commandId);
      if (seen === undefined) return null;
      return loaded.records.filter((record) => seen.seqs.includes(record.seq));
    },

    replay({ useSnapshot = true } = {}) {
      const loaded = load({ useSnapshot });
      return { state: loaded.state, seq: loaded.nextSeq - 1, headDigest: loaded.headDigest, snapshotUsed: loaded.snapshotUsed };
    },

    append({ commandId, requestDigest, prepare }) {
      if (typeof commandId !== "string" || commandId.length === 0) refuse("INVALID_COMMAND_ID", "append needs a command id");
      if (typeof requestDigest !== "string") refuse("INVALID_REQUEST_DIGEST", "append needs a request digest");
      if (typeof prepare !== "function") refuse("INVALID_PREPARE", "append needs a prepare function");
      return locks.withLock(CLASSES.STORE, location, () => {
        onPhase("lock_acquired");
        const loaded = load({ repair: true, useSnapshot: true });
        if (loaded.truncated !== null) onPhase("tail_repaired");
        onPhase("tail_read");
        const seen = loaded.commands.get(commandId);
        if (seen) {
          // A retry of a command that already landed. Comparing the request
          // rather than the records is what makes this decidable: replaying
          // `prepare` now would run against a state that already contains the
          // command's own effects.
          if (seen.req !== requestDigest) {
            refuse("COMMAND_CONFLICT", `command ${commandId} was already applied with a different request`);
          }
          return { seq: loaded.nextSeq - 1, records: loaded.records.filter((record) => record.seq >= seen.seqs[0] && seen.seqs.includes(record.seq)), replayed: true };
        }
        onPhase("idempotence_checked");
        const drafts = prepare(loaded.state, { seq: loaded.nextSeq });
        if (!Array.isArray(drafts) || drafts.length === 0) refuse("EMPTY_APPEND", "prepare must return at least one record");
        onPhase("prepared");

        // Everything below is built before a single byte is written, so a
        // refusal cannot leave the log half-changed.
        const records = [];
        let prev = loaded.headDigest;
        let seq = loaded.nextSeq;
        for (const draft of drafts) {
          const record = buildRecord({ seq, prev, cmd: commandId, req: requestDigest, kind: draft.kind, payload: draft.payload });
          records.push(record);
          prev = record.digest;
          seq += 1;
        }
        const frames = records.map((record) => encodeFrame(canonicalJson(record)));
        const total = frames.reduce((sum, frame) => sum + frame.length, 0);

        let file = loaded.segmentFile;
        if (loaded.segmentBytes > 0 && loaded.segmentBytes + total > segmentMaxBytes) {
          // Rotation happens between commands, never inside one: a command's
          // records stay together, so a torn tail can only ever cost the tail
          // of one command.
          file = path.join(location, SEGMENTS, segmentName(loaded.segment + 1));
          fs.writeFileSync(file, Buffer.alloc(0));
          onPhase("segment_created");
        }
        const handle = fs.openSync(file, "a");
        try {
          fs.writeSync(handle, Buffer.concat(frames));
          onPhase("frames_written");
          fs.fsyncSync(handle);
        } finally {
          fs.closeSync(handle);
        }
        onPhase("frames_fsynced");

        const head = records.at(-1);
        if (snapshotEvery > 0 && Math.floor(head.seq / snapshotEvery) > Math.floor((loaded.nextSeq - 1) / snapshotEvery)) {
          // The snapshot is taken after the records are durable, never before:
          // a snapshot that ran ahead of the log would describe a history that
          // does not exist yet.
          let state = loaded.state;
          for (const record of records) state = reduce(state, record);
          writeSnapshot(snapshotDirectory, { storeId: manifest.store_id, seq: head.seq, headDigest: head.digest, state }, onPhase);
          onPhase("snapshot_written");
        }
        onPhase("before_release");
        return { seq: head.seq, records, replayed: false };
      });
    },

    // The way back from damage that cannot be shown to be an unfinished write.
    // It is deliberately hard to invoke: the caller must state exactly where
    // the good bytes end and what the bytes being discarded hash to, and must
    // say that a person decided this. Anything less would be the runtime
    // guessing about data it already said it could not judge.
    recoverTail({ expectValidEndOffset, expectTailDigest, grantedBy, reason }) {
      if (grantedBy !== "user") refuse("PROVENANCE_REQUIRED", "recovering a damaged tail is a person's decision, not the runtime's");
      if (typeof reason !== "string" || reason.trim().length === 0) refuse("REASON_REQUIRED", "recovery must record why it was done");
      if (!Number.isSafeInteger(expectValidEndOffset) || expectValidEndOffset < 0) refuse("INVALID_OFFSET", "recovery needs the byte offset where the good bytes end");
      return locks.withLock(CLASSES.STORE, location, () => {
        const segments = listSegments(location);
        const target = segments.at(-1);
        const content = fs.readFileSync(target.file);
        if (expectValidEndOffset > content.length) refuse("RECOVERY_PROOF_MISMATCH", "the declared end offset is past the end of the segment");
        const discarded = content.subarray(expectValidEndOffset);
        const digest = sha256Hex(discarded);
        // Both halves of the proof must hold. Matching only the offset would
        // let a stale instruction truncate bytes written since it was issued.
        if (digest !== expectTailDigest) refuse("RECOVERY_PROOF_MISMATCH", `the bytes after ${expectValidEndOffset} hash to ${digest}, not ${expectTailDigest}`);
        fs.truncateSync(target.file, expectValidEndOffset);

        let loaded;
        try {
          loaded = load();
        } catch (error) {
          // Refusing here leaves the truncation in place, which is the honest
          // outcome: the caller proved which bytes to drop, and dropping them
          // did not produce a readable store. Re-adding them would discard a
          // decision a person already made.
          refuse("RECOVERY_INSUFFICIENT", `the store is still unreadable after recovery: ${error.message}`);
        }
        const payload = { segment: target.index, offset: expectValidEndOffset, bytes: discarded.length, digest, reason };
        appendKernelRecord(target.file, loaded, {
          kind: KERNEL_KINDS.TAIL_RECOVERED,
          payload,
          commandId: `kernel:tail-recovered:${digest}`,
          requestDigest: digestOf(payload),
        });
        return { recovered: true, discarded: discarded.length, digest };
      });
    },
  };
  return api;
}
