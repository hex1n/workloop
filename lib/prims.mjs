// Internal taskloop module. Its public seam is the export list at the end.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = ".taskloop";

const TASK_FILE = "task.json";

const RUNTIME_CONTRACT = 4;
const CRITERION_ADAPTER_PROTOCOL_VERSION = 2;

// Runtime contract 4 is built behind test-only seams until the final atomic
// activation. Keep these versions independent: snapshots and HOME projections
// may evolve without changing the append-only record framing.
const V3_RUNTIME_CONTRACT = 4;

const V3_TASK_SNAPSHOT_SCHEMA_VERSION = 3;

const V3_EVENT_RECORD_SCHEMA_VERSION = 2;

const V3_OUTCOME_PROJECTION_SCHEMA_VERSION = 3;

const EVENT_STORE_FILE = "events-v3.jsonl";

const OUTCOME_PROJECTION_FILE = "outcomes-v3.jsonl";

const OUTCOME_CURSOR_DIR = "outcomes-v3-cursors";

const V3_EVENT_PAYLOAD_FIELDS = Object.freeze({
  task_opened: Object.freeze(["goal", "criterion", "observation", "policy_name", "policy_rationale", "alignment", "envelope", "grants", "assurance", "budget", "episodes"]),
  task_suspended: Object.freeze(["reason", "judgment", "close_episode", "source", "acting_session"]),
  task_resumed: Object.freeze(["reason", "episode", "acting_session"]),
  task_joined: Object.freeze(["reason", "episode", "acting_session"]),
  task_terminal: Object.freeze(["outcome", "evidence", "reason", "source", "acting_session"]),
  write_authorized: Object.freeze(["files"]),
  criterion_observed: Object.freeze(["observation", "attempt_id", "signature", "failure_summary", "drift", "source"]),
  criterion_side_effect_recorded: Object.freeze(["observation"]),
  output_tokens_tallied: Object.freeze(["source_id", "source_generation_id", "episode_id", "from_offset", "to_offset", "range_sha256", "end_anchor_sha256", "output_tokens_delta", "mode"]),
  task_amended: Object.freeze(["reason", "goal", "alignment", "envelope", "grants", "rounds", "writes", "wall_clock_minutes", "output_tokens", "assurance", "criterion", "policy", "policy_rationale", "generation_id", "artifact_revision"]),
  review_recorded: Object.freeze(["record"]),
  proof_gap_accepted: Object.freeze(["record"]),
});

const V3_EVENT_KINDS = Object.freeze(Object.keys(V3_EVENT_PAYLOAD_FIELDS));

const DEFAULT_ROUNDS = 8;

const STUCK_REPEATS = 3;

// Below the live-probed Claude Code force-release point (nine metered stops,
// 2026-07-13); hosts reset their consecutive-block counter on intervening
// tool use, so this only fires on pure spinning.
const NO_PROGRESS_STOPS = 7;

const CRITERION_TIMEOUT_SECONDS = 120;

const TOUCHED_FILES_CAP = 50;

const VALID_SUSPEND_OUTCOMES = new Set(["needs_input", "stuck", "out_of_budget"]);

const OBSERVATION_VERDICTS = new Set(["unsatisfied", "satisfied", "indeterminate"]);

const TERMINAL_OUTCOMES = new Set(["achieved", "not_needed", "abandoned"]);
// The independence ladder, weakest → strongest. A review's value comes from
// how independent the reviewer's failure modes are from the author's:
// self-reread shares everything; fresh-context washes session-state
// contamination (optimism, sunk cost, tunnel vision) but not model-level blind
// spots; second-model washes those too (uncorrelated weights). The engine
// records which level a task got — provenance, not a verdict — so the outcome
// ledger makes "closed without independent review" visible; it never gates
// `done` on it (a review is a probabilistic signal fed back into the loop
// body, not an objective criterion).

const REVIEW_LEVELS = ["self_reread", "fresh_context", "second_model"];

// ---------- small helpers ----------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("canonical JSON supports only plain JSON values");
  const entries = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new Error(`canonical JSON does not allow undefined at ${key}`);
    entries.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  }
  return `{${entries.join(",")}}`;
}

function sha256Hex(input) {
  if (!(typeof input === "string" || Buffer.isBuffer(input) || ArrayBuffer.isView(input))) throw new Error("sha256 input must be text or bytes");
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function utcTimestamp(epochMs) {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) throw new Error("timestamp requires non-negative integer epoch milliseconds");
  return new Date(epochMs).toISOString();
}

function fnv1aHex(input) {
  const s = String(input ?? "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function outputTail(text, limit = 2000) {
  const trimmed = String(text ?? "").trim();
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("output tail limit must be a non-negative integer byte count");
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.length <= limit) return trimmed;
  const prefix = Buffer.from("...", "utf8");
  if (limit <= prefix.length) return prefix.subarray(0, limit).toString("utf8");
  let start = bytes.length - (limit - prefix.length);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return prefix.toString("utf8") + bytes.subarray(start).toString("utf8");
}

function outputHead(text, limit = 2000) {
  const trimmed = String(text ?? "").trim();
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("output head limit must be a non-negative integer byte count");
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.length <= limit) return trimmed;
  const suffix = Buffer.from("...", "utf8");
  if (limit <= suffix.length) return suffix.subarray(0, limit).toString("utf8");
  let end = limit - suffix.length;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + suffix.toString("utf8");
}

function localTimestamp(when = new Date()) {
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

const DIRECTORY_LOCK_RELEASE_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

function readJsonLockOwner(lock) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function releaseOwnedDirectoryLock(lock, token, { attempts = 20, pathExists = fs.existsSync, readOwner = readJsonLockOwner, wait = () => {} } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!pathExists(lock)) return;
    const owner = readOwner(lock);
    if (owner?.token !== token) {
      if (owner || attempt === attempts - 1) return;
      wait();
      continue;
    }
    const released = `${lock}.released.${process.pid}.${randomUUID()}`;
    try {
      fs.renameSync(lock, released);
      try { fs.rmSync(released, { recursive: true, force: true }); } catch { /* lock path is already released */ }
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (!DIRECTORY_LOCK_RELEASE_RETRY_CODES.has(error?.code) || attempt === attempts - 1) throw error;
      wait();
    }
  }
}

function artifactTimestamp(when = new Date()) {
  return localTimestamp(when).replaceAll("-", "").replace(" ", "-").replaceAll(":", "");
}

function repoRelative(repo, raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const root = path.resolve(String(repo));
  const abs = path.resolve(root, s.replace(/\\/g, "/"));
  if (abs === root) return null;
  if (abs.startsWith(root + path.sep)) return abs.slice(root.length + 1).replace(/\\/g, "/");
  return s;
}

function isSyntheticTouchedFile(value) {
  return String(value).startsWith("<");
}

function globToRegExp(pattern) {
  let out = "^";
  const p = String(pattern).replace(/\\/g, "/");
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (p[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$");
}

export {
  STATE_DIR,
  TASK_FILE,
  RUNTIME_CONTRACT,
  CRITERION_ADAPTER_PROTOCOL_VERSION,
  V3_RUNTIME_CONTRACT,
  V3_TASK_SNAPSHOT_SCHEMA_VERSION,
  V3_EVENT_RECORD_SCHEMA_VERSION,
  V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  EVENT_STORE_FILE,
  OUTCOME_PROJECTION_FILE,
  OUTCOME_CURSOR_DIR,
  V3_EVENT_KINDS,
  V3_EVENT_PAYLOAD_FIELDS,
  DEFAULT_ROUNDS,
  STUCK_REPEATS,
  NO_PROGRESS_STOPS,
  CRITERION_TIMEOUT_SECONDS,
  TOUCHED_FILES_CAP,
  VALID_SUSPEND_OUTCOMES,
  OBSERVATION_VERDICTS,
  TERMINAL_OUTCOMES,
  REVIEW_LEVELS,
  isPlainObject,
  canonicalJson,
  sha256Hex,
  utcTimestamp,
  fnv1aHex,
  outputTail,
  outputHead,
  localTimestamp,
  releaseOwnedDirectoryLock,
  artifactTimestamp,
  repoRelative,
  isSyntheticTouchedFile,
  globToRegExp,
};
