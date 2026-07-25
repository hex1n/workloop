// The store: segmented append-only log, replay, idempotence, and the recovery
// policy that decides when damage is survivable.
//
// The store knows nothing about loops, rounds, or judgments. It appends opaque
// records, replays them through a reducer the caller supplies, and refuses
// anything it cannot prove. Domain meaning arrives in slice 2 and must not
// leak backwards into this file.
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, digestOf, isPlainObject } from "./canonical.mjs";
import { TRAILING, encodeFrame, scanFrames } from "./frame.mjs";
import { assertChain, buildRecord } from "./record.mjs";
import { CLASSES, createLockManager } from "./locks.mjs";

export const STORE_SCHEMA = 1;
export const DEFAULT_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST = "manifest.json";
const SEGMENTS = "segments";
const LOCKS = "locks";
const SEGMENT_DIGITS = 6;

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
  fs.mkdirSync(path.join(location, LOCKS), { recursive: true });
  const manifest = {
    store_schema: STORE_SCHEMA,
    store_id: digestOf({ created: location, entropy: [...crypto.getRandomValues(new Uint32Array(4))] }).slice("sha256:".length, "sha256:".length + 32),
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

export function openStore(location, { reduce = (state) => state, initial = null, segmentMaxBytes = DEFAULT_SEGMENT_MAX_BYTES, verifyAnchor = true } = {}) {
  const manifest = readManifest(location);
  if (verifyAnchor && physicalAnchor(location) !== manifest.anchor) {
    refuse("STORE_COLLISION", "this store's identity belongs to a different location; it looks like a copy");
  }
  const locks = createLockManager({
    resolveLockPath: ({ lockClass, resourceId }) => path.join(location, LOCKS, `${lockClass}-${encodeURIComponent(resourceId)}.lock`),
    defaults: { timeoutMs: 10_000, leaseMs: 60_000 },
  });

  // Reads the whole log and decides what to do about anything at the end of it
  // that is not a complete frame. `repair` is only ever true under the store
  // lock: truncation is a write.
  function load({ repair = false } = {}) {
    const segments = listSegments(location);
    const records = [];
    const commands = new Map();
    let bytes = 0;
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
      // loses nothing that was ever promised.
      fs.truncateSync(segment.file, trailing.offset);
      bytes = trailing.offset;
    }
    const { nextSeq, headDigest } = assertChain(records, { anchorDigest: manifest.genesis_digest });
    for (const record of records) {
      const seen = commands.get(record.cmd);
      if (seen === undefined) commands.set(record.cmd, { req: record.req, seqs: [record.seq] });
      else {
        if (seen.req !== record.req) refuse("COMMAND_INCONSISTENT", `command ${record.cmd} appears with two different requests`);
        seen.seqs.push(record.seq);
      }
    }
    let state = initial;
    for (const record of records) state = reduce(state, record);
    const last = segments.at(-1);
    return { records, commands, state, nextSeq, headDigest, segment: last.index, segmentFile: last.file, segmentBytes: bytes };
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

    replay() {
      const loaded = load();
      return { state: loaded.state, seq: loaded.nextSeq - 1, headDigest: loaded.headDigest };
    },

    append({ commandId, requestDigest, prepare }) {
      if (typeof commandId !== "string" || commandId.length === 0) refuse("INVALID_COMMAND_ID", "append needs a command id");
      if (typeof requestDigest !== "string") refuse("INVALID_REQUEST_DIGEST", "append needs a request digest");
      if (typeof prepare !== "function") refuse("INVALID_PREPARE", "append needs a prepare function");
      return locks.withLock(CLASSES.STORE, location, () => {
        const loaded = load({ repair: true });
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
        const drafts = prepare(loaded.state, { seq: loaded.nextSeq });
        if (!Array.isArray(drafts) || drafts.length === 0) refuse("EMPTY_APPEND", "prepare must return at least one record");

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
        }
        const handle = fs.openSync(file, "a");
        try {
          fs.writeSync(handle, Buffer.concat(frames));
          fs.fsyncSync(handle);
        } finally {
          fs.closeSync(handle);
        }
        return { seq: records.at(-1).seq, records, replayed: false };
      });
    },
  };
  return api;
}
