// Internal workloop module. Its public seam is the export list at the end.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  EVENT_STORE_FILE,
  SOURCE_CURSOR_FIELDS,
  STATE_DIR,
  TASK_FILE,
  V3_RUNTIME_CONTRACT,
  V3_TASK_SNAPSHOT_SCHEMA_VERSION,
  artifactTimestamp,
  canonicalJson,
  cloneJson,
  hasExactKeys,
  isPlainObject,
  isSha256Digest,
  localTimestamp,
  prettyCanonicalJson,
  sha256Hex,
  withOwnedDirectoryLock,
} from "./prims.mjs";

// A mutation spans authority load, command decision, event commit, and snapshot
// projection. Concurrent hooks can otherwise derive from the same sequence.
// The cross-process mkdir lock serializes that transaction, and every repo-local
// entry takes it while applying the shared hard-cutover authority discriminator.

const TASK_LOCK_STALE_MS = 5000;

function resolveLockTimeoutMs(timeoutMs) {
  // An explicit arg wins, then WORKLOOP_LOCK_TIMEOUT_MS, else 15s — but only a
  // finite, positive value counts. NaN is the dangerous one: an unchecked NaN
  // deadline makes the acquire loop's `Date.now() >= deadline` forever false, so
  // the lock could never fail closed and would spin indefinitely. Negative and
  // zero would flip it the other way (instant timeout). Reject all three and
  // fall through to the next real bound.
  const envMs = Number.parseInt(process.env.WORKLOOP_LOCK_TIMEOUT_MS ?? "", 10);
  for (const candidate of [timeoutMs, envMs]) {
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return 15000;
}

function withTaskLock(repo, action, { timeoutMs } = {}) {
  const limitMs = resolveLockTimeoutMs(timeoutMs);
  const dir = path.join(repo, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return withOwnedDirectoryLock(path.join(dir, ".task.lock"), action, {
    timeoutMs: limitMs,
    staleMs: TASK_LOCK_STALE_MS,
    ownerExtra: { at: localTimestamp() },
    // Fail closed, not open: never run the mutating callback without the
    // lock, or we reopen the very lost-update window this lock exists to
    // close. Throw so a hook releases (main's supervisor catch returns 0)
    // and a verb reports a clean error — neither touches task state. A
    // missed record-write undercounts; it never corrupts a concurrent update.
    timeoutError: (limit) => Object.assign(
      new Error(`workloop: task lock unavailable after ${limit}ms; released without mutating task state`),
      { code: "TASKLOCK_TIMEOUT" },
    ),
  });
}

function taskPath(repo) {
  return path.join(repo, STATE_DIR, TASK_FILE);
}

const SNAPSHOT_FIELDS = ["schema_version", "runtime_contract", "source_cursor", "projection", "snapshot_digest"];

function validateSnapshotSourceCursor(cursor) {
  if (
    !hasExactKeys(cursor, SOURCE_CURSOR_FIELDS) || cursor.event_store_file !== EVENT_STORE_FILE ||
    !Number.isSafeInteger(cursor.repo_sequence) || cursor.repo_sequence < 1 ||
    !Number.isSafeInteger(cursor.task_event_sequence) || cursor.task_event_sequence < 1 ||
    !isSha256Digest(cursor.record_digest) || !isSha256Digest(cursor.event_id) ||
    !Number.isSafeInteger(cursor.valid_end_offset) || cursor.valid_end_offset < 1
  ) throw new Error("invalid schema-v3 snapshot source cursor");
  return cursor;
}

function snapshotPreimage(sourceCursor, projection) {
  return {
    schema_version: V3_TASK_SNAPSHOT_SCHEMA_VERSION,
    runtime_contract: V3_RUNTIME_CONTRACT,
    source_cursor: cloneJson(sourceCursor),
    projection: cloneJson(projection),
  };
}

function requireProjectionValidator(validateProjection, projection) {
  if (typeof validateProjection !== "function") throw new Error("schema-v3 projection validator is required");
  validateProjection(projection);
}

function buildTaskSnapshot({ sourceCursor, projection, validateProjection }) {
  validateSnapshotSourceCursor(sourceCursor);
  requireProjectionValidator(validateProjection, projection);
  if (projection.task_event_sequence !== sourceCursor.task_event_sequence) throw new Error("schema-v3 snapshot projection does not match its source cursor");
  const preimage = snapshotPreimage(sourceCursor, projection);
  return { ...preimage, snapshot_digest: sha256Hex(canonicalJson(preimage)) };
}

function validateTaskSnapshot(snapshot, { validateProjection } = {}) {
  if (!hasExactKeys(snapshot, SNAPSHOT_FIELDS)) throw new Error("invalid schema-v3 snapshot fields");
  if (snapshot.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION || snapshot.runtime_contract !== V3_RUNTIME_CONTRACT) throw new Error("invalid schema-v3 snapshot contract");
  validateSnapshotSourceCursor(snapshot.source_cursor);
  requireProjectionValidator(validateProjection, snapshot.projection);
  if (snapshot.projection.task_event_sequence !== snapshot.source_cursor.task_event_sequence) throw new Error("schema-v3 snapshot projection does not match its source cursor");
  const preimage = snapshotPreimage(snapshot.source_cursor, snapshot.projection);
  if (!isSha256Digest(snapshot.snapshot_digest) || sha256Hex(canonicalJson(preimage)) !== snapshot.snapshot_digest) throw new Error("snapshot_digest_mismatch");
  return snapshot;
}

function inspectTaskSnapshot(repo, { fsOps = fs, validateProjection = null } = {}) {
  let raw;
  try { raw = fsOps.readFileSync(taskPath(repo), "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  let snapshot;
  try { snapshot = JSON.parse(raw); }
  catch { return { status: "damaged", reason: "invalid_json" }; }
  if (!isPlainObject(snapshot)) return { status: "damaged", reason: "invalid_root" };
  if (snapshot.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION) return { status: "incompatible", schema_version: snapshot.schema_version ?? null };
  try {
    const expected = sha256Hex(canonicalJson(snapshotPreimage(snapshot.source_cursor, snapshot.projection)));
    if (!isSha256Digest(snapshot.snapshot_digest) || snapshot.snapshot_digest !== expected) return { status: "damaged", reason: "snapshot_digest_mismatch" };
  } catch {
    return { status: "damaged", reason: "snapshot_digest_mismatch" };
  }
  try { validateTaskSnapshot(snapshot, { validateProjection }); }
  catch (error) {
    const criterion = snapshot?.projection?.criterion;
    const legacyCriterionFields = ["source", "protocol", "timeout_seconds", "declared_inputs", "subjects", "criterion_definition_hash", "criterion_generation_id", "criterion_input_fingerprint", "input_coverage", "provenance", "last_observation"].sort();
    if (hasExactKeys(criterion, legacyCriterionFields) && criterion.authored_by === undefined) {
      return { status: "damaged", reason: "legacy_v3_criterion_authorship" };
    }
    return { status: "invalid", reason: error.message };
  }
  return { status: "valid", snapshot };
}

function quarantineDamagedTaskSnapshot(repo, { reason, fsOps = fs, atEpochMs = Date.now() } = {}) {
  const source = taskPath(repo);
  const raw = fsOps.readFileSync(source);
  const rawDigest = sha256Hex(raw);
  const directory = path.join(repo, STATE_DIR, "quarantine");
  fsOps.mkdirSync(directory, { recursive: true });
  const suffix = `${rawDigest.slice("sha256:".length)}-${randomUUID()}`;
  const quarantinePath = path.join(directory, `task-snapshot-${suffix}.bin`);
  const receiptPath = path.join(directory, `task-snapshot-${suffix}.json`);
  fsOps.renameSync(source, quarantinePath);
  const receipt = {
    source_path: source,
    quarantine_path: quarantinePath,
    receipt_path: receiptPath,
    reason,
    raw_sha256: rawDigest,
    quarantined_at_epoch_ms: atEpochMs,
  };
  fsOps.writeFileSync(receiptPath, `${prettyCanonicalJson(receipt)}\n`, "utf8");
  return receipt;
}

function saveTaskSnapshot(repo, snapshot, { fsOps = fs, onSeam = null, validateProjection = null } = {}) {
  validateTaskSnapshot(snapshot, { validateProjection });
  const dir = path.join(repo, STATE_DIR);
  fsOps.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fsOps.existsSync(ignore)) {
    try { fsOps.writeFileSync(ignore, "*\n", "utf8"); }
    catch { /* advisory: snapshot authority remains the event stream */ }
  }
  const target = taskPath(repo);
  const temporary = path.join(dir, `.${TASK_FILE}.snapshot.${process.pid}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${prettyCanonicalJson(snapshot)}\n`, "utf8");
  let fd;
  try {
    fd = fsOps.openSync(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsOps.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error("snapshot write made no valid progress");
      offset += written;
      onSeam?.("during-snapshot-write");
    }
    fsOps.fsyncSync(fd);
    fsOps.closeSync(fd);
    fd = undefined;
    fsOps.renameSync(temporary, target);
    onSeam?.("after-snapshot-rename");
    return { saved: true, path: target, snapshot_digest: snapshot.snapshot_digest };
  } catch (error) {
    if (fd !== undefined) {
      try { fsOps.closeSync(fd); } catch { /* preserve original failure */ }
    }
    try { fsOps.rmSync(temporary, { force: true }); } catch { /* preserve original failure */ }
    throw error;
  }
}

function loadTask(repo, { validateProjection = () => {} } = {}) {
  const inspected = inspectTaskSnapshot(repo, { validateProjection });
  if (inspected.status === "missing") return null;
  if (inspected.status === "valid") return cloneJson(inspected.snapshot.projection);
  throw Object.assign(
    new Error(`workloop: incompatible task snapshot at ${taskPath(repo)}; schema-v3 event authority is required`),
    { code: "INCOMPATIBLE_TASK_SNAPSHOT", file: taskPath(repo), status: inspected.status },
  );
}

function archiveIncompatibleState(repo, { reason, grantedBy, at }) {
  if (grantedBy !== "user") throw new Error("archive-incompatible-state requires --granted-by user");
  if (!String(reason ?? "").trim()) throw new Error("archive-incompatible-state requires --reason");
  const source = taskPath(repo);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("incompatible task state must be a regular non-symlink file");
  const raw = fs.readFileSync(source);
  const digest = sha256Hex(raw);
  const dir = path.join(repo, STATE_DIR, "archive");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = artifactTimestamp(at);
  const archive = path.join(dir, `incompatible-${stamp}-${digest.slice("sha256:".length)}-${randomUUID()}.json`);
  fs.renameSync(source, archive);
  const receipt = {
    source_path: path.relative(repo, source).replaceAll("\\", "/"),
    archive_path: path.relative(repo, archive).replaceAll("\\", "/"),
    raw_sha256: digest,
    reason,
    granted_by: grantedBy,
    archived_at: at,
  };
  fs.writeFileSync(`${archive}.receipt.json`, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return receipt;
}

export {
  taskPath,
  buildTaskSnapshot,
  inspectTaskSnapshot,
  quarantineDamagedTaskSnapshot,
  saveTaskSnapshot,
  validateTaskSnapshot,
  loadTask,
  archiveIncompatibleState,
  withTaskLock,
};
