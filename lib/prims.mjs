// Internal workloop module. Its public seam is the export list at the end.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = ".workloop";

const TASK_FILE = "task.json";

const RUNTIME_CONTRACT = 7;
const CRITERION_ADAPTER_PROTOCOL_VERSION = 2;

// Runtime contract 7 separates host execution authority from Workloop's
// operation-intent and policy-deviation evidence. Contract 6 remains fully
// replayable; new tasks use a distinct genesis payload and event vocabulary.
// Keep these persisted schema versions independent from append-only record
// framing, and retain the Contract 5 readers in task-store/outcome-projector.
const V3_RUNTIME_CONTRACT = 5;

const V3_TASK_SNAPSHOT_SCHEMA_VERSION = 3;

const V3_EVENT_RECORD_SCHEMA_VERSION = 2;

const V3_OUTCOME_PROJECTION_SCHEMA_VERSION = 5;

const EVENT_STORE_FILE = "events.jsonl";
const LEGACY_EVENT_STORE_FILE = "events-v3.jsonl";

const OUTCOME_PROJECTION_FILE = "outcomes.jsonl";
const LEGACY_OUTCOME_PROJECTION_FILE = "outcomes-v3.jsonl";

const OUTCOME_CURSOR_DIR = "outcomes-cursors";
const LEGACY_OUTCOME_CURSOR_DIR = "outcomes-v3-cursors";

// One of the three deliberate schema definition sites (with event-store's
// persisted contracts and task-engine's assertV3* validators); a schema change
// updates all three together. See AGENTS.md Conventions.
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

// Current multi-root authority payload contract. The persisted journal validates
// these exact fields before task-engine receives an event, and task-engine then
// validates transition semantics and the resulting projection independently.
const CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS = Object.freeze({
  authority_genesis: Object.freeze(["authority_id", "provider"]),
  attachment_stage_intent: Object.freeze(["authority_id", "attachment_id", "claim_token", "claim_epoch", "anchor_id", "staged_locator_digest", "claimed_locator_digest", "worktree_root", "git_dir", "granted_by", "reason"]),
  attachment_staged: Object.freeze(["authority_id", "attachment_id", "stage_intent_digest", "staged_locator_digest", "granted_by", "reason"]),
  attachment_claim_pending: Object.freeze(["authority_id", "attachment_id", "staged_receipt_digest", "claimed_locator_digest"]),
  attachment_claimed: Object.freeze(["authority_id", "attachment_id", "pending_record_digest", "locator_digest"]),
  exclusive_worktree_intent: Object.freeze(["authority_id", "action", "worktree_path", "branch_intent", "base_oid", "source_anchor_id", "session_id", "request_digest", "granted_by", "reason"]),
  exclusive_worktree_ready: Object.freeze(["intent_record_digest", "worktree_path", "branch_ref", "head_oid", "anchor_id"]),
  task_open_intent: Object.freeze(["task_id", "attachment_id", "goal", "write_claims", "placement", "branch_intent", "base_oid", "placement_intent_digest", "coordinator_session_id", "participant_session_ids"]),
  task_opened: Object.freeze(["task_id", "attachment_id", "open_intent_digest", "attachment_final_digest"]),
  task_joined: Object.freeze(["task_id", "session_id", "reason", "granted_by"]),
  task_suspended: Object.freeze(["task_id", "session_id", "reason", "granted_by"]),
  task_resumed: Object.freeze(["task_id", "session_id", "reason", "granted_by"]),
  task_terminal: Object.freeze(["task_id", "session_id", "outcome", "reason", "granted_by"]),
  operation_intent_recorded: Object.freeze(["task_id", "operation_id", "session_id", "tool", "target", "permission_mode"]),
  tool_completed: Object.freeze(["task_id", "operation_id", "session_id", "tool", "target", "permission_mode", "outcome", "receipt_quality"]),
});

const V3_EVENT_KINDS = Object.freeze(Object.keys(V3_EVENT_PAYLOAD_FIELDS));

// Runtime Contract 6 keeps Contract 5 payloads replayable and dispatches new
// meanings by the pair {kind, payload_version}. V3_EVENT_PAYLOAD_FIELDS stays
// the frozen Contract 5/v1 map for compatibility consumers; all new code uses
// this versioned registry.
const EVENT_PAYLOAD_FIELDS_BY_VERSION = Object.freeze({
  task_opened: Object.freeze({
    1: V3_EVENT_PAYLOAD_FIELDS.task_opened,
    2: Object.freeze([...V3_EVENT_PAYLOAD_FIELDS.task_opened, "runtime_contract", "artifact_baseline", "coverage_basis"]),
    3: Object.freeze([...V3_EVENT_PAYLOAD_FIELDS.task_opened, "runtime_contract", "artifact_baseline", "coverage_basis"]),
  }),
  task_suspended: Object.freeze({ 1: V3_EVENT_PAYLOAD_FIELDS.task_suspended }),
  task_resumed: Object.freeze({ 1: V3_EVENT_PAYLOAD_FIELDS.task_resumed }),
  task_joined: Object.freeze({ 1: V3_EVENT_PAYLOAD_FIELDS.task_joined }),
  task_terminal: Object.freeze({ 1: V3_EVENT_PAYLOAD_FIELDS.task_terminal }),
  write_authorized: Object.freeze({
    1: V3_EVENT_PAYLOAD_FIELDS.write_authorized,
    2: Object.freeze(["operation_id", "tool_family", "declared_targets", "target_coverage", "host_profile", "receipt_expectation"]),
  }),
  criterion_observed: Object.freeze({
    1: V3_EVENT_PAYLOAD_FIELDS.criterion_observed,
    2: Object.freeze([...V3_EVENT_PAYLOAD_FIELDS.criterion_observed, "checkpoint_id", "evidence_revision", "event_cursor"]),
  }),
  criterion_side_effect_recorded: Object.freeze({
    1: V3_EVENT_PAYLOAD_FIELDS.criterion_side_effect_recorded,
    2: Object.freeze([...V3_EVENT_PAYLOAD_FIELDS.criterion_side_effect_recorded, "checkpoint_id", "evidence_revision", "event_cursor"]),
  }),
  output_tokens_tallied: Object.freeze({ 1: V3_EVENT_PAYLOAD_FIELDS.output_tokens_tallied }),
  task_amended: Object.freeze({
    1: V3_EVENT_PAYLOAD_FIELDS.task_amended,
    2: Object.freeze([...V3_EVENT_PAYLOAD_FIELDS.task_amended, "history_requirement"]),
  }),
  review_recorded: Object.freeze({ 1: V3_EVENT_PAYLOAD_FIELDS.review_recorded, 2: V3_EVENT_PAYLOAD_FIELDS.review_recorded }),
  proof_gap_accepted: Object.freeze({ 1: V3_EVENT_PAYLOAD_FIELDS.proof_gap_accepted }),
  tool_completed: Object.freeze({
    1: Object.freeze(["operation_id", "tool_family", "outcome", "reported_targets", "receipt_quality", "host_profile"]),
  }),
  artifact_reconciled: Object.freeze({
    1: Object.freeze(["checkpoint_id", "from_checkpoint", "to_checkpoint", "captured_at_ms", "changed_entries", "changed_paths", "current_scope_violations", "coverage", "reason"]),
  }),
  coverage_changed: Object.freeze({
    1: Object.freeze(["artifact_state", "mutation_history", "prewrite_enforcement", "episode_id", "operation_id", "capability_id", "host_profile", "surface", "exhaustive_surface", "effective_from_checkpoint", "interval_from_checkpoint", "interval_to_checkpoint", "reason"]),
  }),
  operation_intent_recorded: Object.freeze({
    1: Object.freeze(["operation_id", "tool_family", "declared_targets", "target_coverage", "host_profile", "receipt_expectation", "policy_mode", "policy_disposition", "policy_reasons", "session_relation"]),
  }),
});

const EVENT_KINDS = Object.freeze(Object.keys(EVENT_PAYLOAD_FIELDS_BY_VERSION));

function eventPayloadFields(kind, payloadVersion) {
  return EVENT_PAYLOAD_FIELDS_BY_VERSION[kind]?.[payloadVersion] ?? null;
}

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

// The persisted source-cursor shape shared by the event store (which mints and
// verifies cursors) and the task snapshot (which embeds one). One field list,
// or the two validators drift.
const SOURCE_CURSOR_FIELDS = ["event_store_file", "repo_sequence", "task_event_sequence", "record_digest", "event_id", "valid_end_offset"];

// The budget dimensions' presentation vocabulary: the suspension text
// (task-engine) and the deny text (application) must name the same label and
// the same amend flag for each dimension.
const BUDGET_DIMENSIONS = Object.freeze({
  rounds: Object.freeze({ label: "round", option: "--rounds" }),
  writes: Object.freeze({ label: "write", option: "--writes" }),
  wall_clock: Object.freeze({ label: "wall-clock", option: "--wall-clock-minutes" }),
  output_tokens: Object.freeze({ label: "output-token", option: "--token-budget" }),
});

// ---------- small helpers ----------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Deep clone via JSON round-trip on purpose, not the host's structured clone
// API: persisted task state must stay pure JSON, and this clone throws on
// anything (a Date, a Map, a cycle) that would silently smuggle a non-JSON
// value into an event or snapshot.
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isSha256Digest(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value ?? ""));
}

function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value ?? ""));
}

function hasExactKeys(value, fields) {
  return isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function pathEntryExists(target, fsOps = fs) {
  try {
    fsOps.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// Case folding for path comparison on the platforms whose default filesystems
// are case-insensitive.
const foldCasePath = process.platform === "win32" || process.platform === "darwin" ? (value) => value.toLowerCase() : (value) => value;

function compareCodeUnits(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// The one home-directory resolution: explicit HOME/USERPROFILE first so tests
// and hosts can redirect it, os.homedir() as the fallback when neither is set.
function userHome() {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
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

function prettyCanonicalJson(value) {
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
}

function sha256Hex(input) {
  if (!(typeof input === "string" || Buffer.isBuffer(input) || ArrayBuffer.isView(input))) throw new Error("sha256 input must be text or bytes");
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function artifactCheckpointId(entries) {
  if (!Array.isArray(entries)) throw new Error("artifact checkpoint entries must be an array");
  return sha256Hex(canonicalJson(entries));
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
const LOCK_CLAIM_LINK_FALLBACK_CODES = new Set(["EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);

// One shared slot for the synchronous, CPU-friendly backoff every lock retry
// loop uses (Node offers no other synchronous sleep).
const DIRECTORY_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function directoryLockBackoff(ms = 5) {
  Atomics.wait(DIRECTORY_LOCK_WAIT, 0, 0, ms);
}

function readJsonLockOwner(lock, fsOps = fs) {
  try {
    return JSON.parse(fsOps.readFileSync(path.join(lock, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function lockClaimPath(lock) {
  return `${lock}.claim`;
}

function readJsonFile(target, fsOps = fs) {
  try { return JSON.parse(fsOps.readFileSync(target, "utf8")); }
  catch { return null; }
}

// A recorded lock owner is presumed alive unless its pid provably exited:
// EPERM means the process exists under another user, and an unexpected probe
// error must never justify stealing a lock. Only ESRCH proves absence. This is
// the single liveness semantic; the per-module copies it replaced had drifted
// (one treated unknown probe errors as dead).
function directoryLockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function directoryLockPathPresent(target, fsOps = fs) {
  try { fsOps.lstatSync(target); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function directoryLockReleaseUnproven(lock) {
  return Object.assign(new Error(`directory lock release could not be proven: ${lock}`), { code: "DIRECTORY_LOCK_RELEASE_UNPROVEN" });
}

function releaseOwnedDirectoryLock(lock, token, { attempts = 20, fsOps = fs, pathExists = null, readOwner = null, wait = () => {} } = {}) {
  const lockExists = pathExists ?? ((target) => directoryLockPathPresent(target, fsOps));
  const ownerOf = readOwner ?? ((target) => readJsonLockOwner(target, fsOps));
  let directoryReleased = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!lockExists(lock)) { directoryReleased = true; break; }
    const owner = ownerOf(lock);
    if (owner?.token !== token) {
      if (owner) { directoryReleased = true; break; }
      if (attempt === attempts - 1) break;
      wait();
      continue;
    }
    const released = `${lock}.released.${process.pid}.${randomUUID()}`;
    try {
      fsOps.renameSync(lock, released);
      try { fsOps.rmSync(released, { recursive: true, force: true }); } catch { /* lock path is already released */ }
      directoryReleased = true;
      break;
    } catch (error) {
      if (error?.code === "ENOENT") { directoryReleased = true; break; }
      if (!DIRECTORY_LOCK_RELEASE_RETRY_CODES.has(error?.code) || attempt === attempts - 1) throw error;
      wait();
    }
  }
  if (!directoryReleased) return false;
  const claim = lockClaimPath(lock);
  if (!directoryLockPathPresent(claim, fsOps)) return true;
  const owner = readJsonFile(claim, fsOps);
  if (owner?.token !== token) return owner !== null;
  const released = `${claim}.released.${process.pid}.${randomUUID()}`;
  try {
    fsOps.renameSync(claim, released);
    try { fsOps.rmSync(released, { force: true }); } catch { /* claim path is already released */ }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return true;
}

// Ownership is normally published as one complete inode before the directory
// appears. Filesystems without hard-link support fall back to an exclusive
// copy; a contender treats its short partial-copy window as live until the
// stale grace elapses. The sibling reaper serializes stale claim removal;
// legacy directory-only locks remain recoverable below.
function reapStaleLockClaim(lock, { staleMs, staleOwner = null, fsOps = fs, now = Date.now } = {}) {
  const claim = lockClaimPath(lock);
  const reaper = `${claim}.reaper`;
  const reaperToken = randomUUID();
  try {
    fsOps.mkdirSync(reaper);
  } catch (error) {
    const windowsDirectoryContention = process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES");
    if (error?.code !== "EEXIST" && !windowsDirectoryContention) throw error;
    if (!windowsDirectoryContention) {
      try {
        if (now() - fsOps.statSync(reaper).mtimeMs > staleMs) fsOps.rmSync(reaper, { recursive: true, force: true });
      } catch { /* a live or vanished reaper is ordinary contention */ }
    }
    return false;
  }
  try {
    fsOps.writeFileSync(path.join(reaper, "owner.json"), JSON.stringify({ pid: process.pid, token: reaperToken }));
    let stat;
    try { stat = fsOps.statSync(claim); }
    catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    const parsedOwner = readJsonFile(claim, fsOps);
    const owner = isPlainObject(parsedOwner)
      && Number.isInteger(parsedOwner.pid)
      && parsedOwner.pid > 0
      && typeof parsedOwner.token === "string"
      && parsedOwner.token.length > 0
      ? parsedOwner
      : null;
    // A complete claim has no ownerless publication window: once its process
    // is provably gone it is safe to apply caller policy immediately. Keep the
    // age grace only for corrupt/foreign partial claim files, where ownership
    // cannot be established.
    if (!owner && now() - stat.mtimeMs <= staleMs) return false;
    if (staleOwner && !staleOwner(owner, { nowEpochMs: now(), mtimeMs: stat.mtimeMs })) return false;
    if (owner && directoryLockOwnerAlive(owner.pid)) return false;
    const quarantine = `${claim}.stale.${process.pid}.${randomUUID()}`;
    try { fsOps.renameSync(claim, quarantine); }
    catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    fsOps.rmSync(quarantine, { force: true });
    return true;
  } finally {
    if (readJsonLockOwner(reaper, fsOps)?.token === reaperToken) {
      try { fsOps.rmSync(reaper, { recursive: true, force: true }); }
      catch { /* a stuck reaper makes contenders retry rather than steal */ }
    }
  }
}

// Reclaim a lock whose owner process is gone (crashed mid-hold). A nested
// reaper lock lets only one process reap at a time, so two reapers cannot both
// "win" the same stale lock and rename it out from under each other. Returns
// true when the caller should immediately retry its own acquire.
function reapStaleDirectoryLock(lock, { staleMs, staleOwner = null, fsOps = fs, now = Date.now } = {}) {
  const reaper = `${lock}.reaper`;
  const reaperToken = randomUUID();
  try {
    fsOps.mkdirSync(reaper);
  } catch (error) {
    // Windows can report EPERM/EACCES instead of EEXIST while another process
    // is creating or removing this short-lived directory. Reaping is only an
    // opportunistic aid to acquiring the real lock, so treat that result as
    // contention and let the bounded outer acquire loop retry.
    const windowsDirectoryContention = process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES");
    if (error?.code !== "EEXIST" && !windowsDirectoryContention) throw error;
    if (windowsDirectoryContention) return false;
    // A reaper lock orphaned by a crash would otherwise force every future
    // contender to degrade forever. Reclaim it once it is clearly stale, then
    // let this attempt retry; a live reaper (held for microseconds) is never
    // this old.
    try {
      if (now() - fsOps.statSync(reaper).mtimeMs > staleMs) {
        fsOps.rmSync(reaper, { recursive: true, force: true });
      }
    } catch {
      /* reaper vanished under us: the next acquire attempt retries cleanly */
    }
    return false;
  }
  try {
    fsOps.writeFileSync(path.join(reaper, "owner.json"), JSON.stringify({ pid: process.pid, token: reaperToken }));
    let stat;
    try {
      stat = fsOps.statSync(lock);
    } catch (error) {
      if (error?.code === "ENOENT") return true; // already gone; retry the acquire
      throw error;
    }
    // A just-created lock has not written owner.json yet. Without this grace
    // window a contender would read no owner, call it stale, and steal a live
    // lock mid-acquire — exactly the race that leaked concurrent write updates.
    if (now() - stat.mtimeMs <= staleMs) return false;
    const owner = readJsonLockOwner(lock, fsOps);
    if (staleOwner && !staleOwner(owner, { nowEpochMs: now(), mtimeMs: stat.mtimeMs })) return false;
    if (owner && directoryLockOwnerAlive(owner.pid)) return false;
    const quarantine = `${lock}.stale.${process.pid}.${randomUUID()}`;
    try {
      fsOps.renameSync(lock, quarantine);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    fsOps.rmSync(quarantine, { recursive: true, force: true });
    return true;
  } finally {
    // Release only our own reaper: one reclaimed after a long pause must not
    // delete the successor reaper now holding the path.
    const mine = readJsonLockOwner(reaper, fsOps)?.token === reaperToken;
    if (mine) {
      try {
        fsOps.rmSync(reaper, { recursive: true, force: true });
      } catch {
        /* a stuck reaper lock just makes the next contender retry, never steal */
      }
    }
  }
}

// The one cross-process directory-lock implementation. Callers own only policy:
// stale window, timeout, the timeout error, owner metadata, and whether a
// failed owner write removes the half-acquired lock (telemetry ledgers do, so
// they degrade open; authority locks leave it for the stale reaper).
function withOwnedDirectoryLock(lock, action, {
  timeoutMs, staleMs, fsOps = fs, now = Date.now, wait = directoryLockBackoff,
  staleOwner = null,
  ownerExtra = null, removeOnOwnerWriteFailure = false,
  timeoutError = (limitMs) => new Error(`directory lock unavailable after ${limitMs}ms: ${lock}`),
  onAcquireError = null, onReleaseError = null,
} = {}) {
  const token = randomUUID();
  const owner = { pid: process.pid, token, ...(ownerExtra ?? {}) };
  const claim = lockClaimPath(lock);
  const deadline = now() + timeoutMs;
  for (;;) {
    const candidate = `${claim}.candidate.${process.pid}.${token}`;
    try {
      fsOps.writeFileSync(candidate, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
      if (fsOps.existsSync(`${claim}.reaper`)) throw Object.assign(new Error("lock claim reaper active"), { code: "EEXIST" });
      try {
        fsOps.linkSync(candidate, claim); // atomic publication of complete owner metadata
      } catch (error) {
        if (!LOCK_CLAIM_LINK_FALLBACK_CODES.has(error?.code)) throw error;
        // COPYFILE_EXCL preserves no-steal acquisition on filesystems (for
        // example exFAT) that cannot create hard links. A crash mid-copy leaves
        // an invalid claim which the age-gated reaper safely handles.
        fsOps.copyFileSync(candidate, claim, fs.constants.COPYFILE_EXCL);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try { fsOps.rmSync(candidate, { force: true }); } catch { /* candidate cleanup is best effort */ }
      if (reapStaleLockClaim(lock, { staleMs, staleOwner, fsOps, now })) continue;
      if (now() >= deadline) throw timeoutError(timeoutMs);
      wait();
      continue;
    } finally {
      try { fsOps.rmSync(candidate, { force: true }); } catch { /* linked claim remains authoritative */ }
    }
    try {
      try {
        fsOps.mkdirSync(lock);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!reapStaleDirectoryLock(lock, { staleMs, staleOwner, fsOps, now })) {
          if (!releaseOwnedDirectoryLock(lock, token, { fsOps, wait, pathExists: () => false })) throw directoryLockReleaseUnproven(lock);
          if (now() >= deadline) throw timeoutError(timeoutMs);
          wait();
          continue;
        }
        fsOps.mkdirSync(lock);
      }
      fsOps.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
    } catch (error) {
      let directoryRemoved = false;
      if (removeOnOwnerWriteFailure) {
        try { fsOps.rmSync(lock, { recursive: true, force: true }); directoryRemoved = !directoryLockPathPresent(lock, fsOps); } catch { /* preserve the original acquisition error */ }
      }
      let claimReleased = false;
      try {
        releaseOwnedDirectoryLock(lock, token, { fsOps, wait, pathExists: () => false });
        try { claimReleased = !directoryLockPathPresent(claim, fsOps); } catch { /* unprovable cleanup stays false */ }
      } catch { /* preserve acquisition error */ }
      let lockDirectoryRemains = true;
      if (directoryRemoved) lockDirectoryRemains = false;
      else try { lockDirectoryRemains = directoryLockPathPresent(lock, fsOps); } catch { /* unknown cleanup is conservatively unreleased */ }
      const state = Object.freeze({ claim_released: claimReleased, lock_directory_remains: lockDirectoryRemains, lock_released: claimReleased && !lockDirectoryRemains });
      try { onAcquireError?.(error, state); } catch { /* preserve acquisition error */ }
      throw error;
    }
    try {
      return action();
    } finally {
      try {
        const released = releaseOwnedDirectoryLock(lock, token, { fsOps, wait });
        if (!released) throw directoryLockReleaseUnproven(lock);
      } catch (error) {
        if (!onReleaseError) throw error;
        onReleaseError(error);
      }
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
  LEGACY_EVENT_STORE_FILE,
  OUTCOME_PROJECTION_FILE,
  LEGACY_OUTCOME_PROJECTION_FILE,
  OUTCOME_CURSOR_DIR,
  LEGACY_OUTCOME_CURSOR_DIR,
  CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS,
  V3_EVENT_KINDS,
  V3_EVENT_PAYLOAD_FIELDS,
  EVENT_KINDS,
  EVENT_PAYLOAD_FIELDS_BY_VERSION,
  eventPayloadFields,
  DEFAULT_ROUNDS,
  STUCK_REPEATS,
  NO_PROGRESS_STOPS,
  CRITERION_TIMEOUT_SECONDS,
  TOUCHED_FILES_CAP,
  VALID_SUSPEND_OUTCOMES,
  OBSERVATION_VERDICTS,
  TERMINAL_OUTCOMES,
  REVIEW_LEVELS,
  SOURCE_CURSOR_FIELDS,
  BUDGET_DIMENSIONS,
  isPlainObject,
  cloneJson,
  isSha256Digest,
  isUuidV4,
  hasExactKeys,
  pathEntryExists,
  foldCasePath,
  compareCodeUnits,
  userHome,
  canonicalJson,
  prettyCanonicalJson,
  sha256Hex,
  artifactCheckpointId,
  utcTimestamp,
  fnv1aHex,
  outputTail,
  outputHead,
  localTimestamp,
  directoryLockBackoff,
  releaseOwnedDirectoryLock,
  reapStaleDirectoryLock,
  withOwnedDirectoryLock,
  artifactTimestamp,
  repoRelative,
  isSyntheticTouchedFile,
  globToRegExp,
};
