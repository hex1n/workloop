// Best-effort HOME projection for schema-v3 repository events. This leaf never
// participates in repository authority and may be deleted and rebuilt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";

import {
  LEGACY_OUTCOME_CURSOR_DIR,
  LEGACY_OUTCOME_PROJECTION_FILE,
  OUTCOME_CURSOR_DIR,
  OUTCOME_PROJECTION_FILE,
  V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  canonicalJson,
  isPlainObject,
  prettyCanonicalJson,
  sha256Hex,
  utcTimestamp,
} from "./prims.mjs";

const ROW_FIELDS = [
  "projection_schema_version", "repo_identity", "repo_sequence", "event_id",
  "task_id", "task_event_sequence", "kind", "occurred_at_epoch_ms", "occurred_at", "payload",
];
const CURSOR_FIELDS = [
  "projection_schema_version", "repo_identity", "last_repo_sequence",
  "last_record_digest", "projection_from_offset", "projection_to_offset",
  "projection_range_sha256", "updated_at",
];
const OUTCOME_LOCK_STALE_MS = 5000;
const OUTCOME_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function reapDeadOutcomeLock(lock, operations = fs) {
  const reaper = `${lock}.reaper`;
  const token = randomUUID();
  try { operations.mkdirSync(reaper); }
  catch (error) {
    const windowsContention = process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES");
    if (error?.code !== "EEXIST" && !windowsContention) throw error;
    if (windowsContention) return false;
    try {
      if (Date.now() - operations.statSync(reaper).mtimeMs > OUTCOME_LOCK_STALE_MS) operations.rmSync(reaper, { recursive: true, force: true });
    } catch { /* retry after the reaper changes */ }
    return false;
  }
  try {
    operations.writeFileSync(path.join(reaper, "owner.json"), JSON.stringify({ pid: process.pid, token }));
    let stat;
    try { stat = operations.statSync(lock); }
    catch (error) { if (error?.code === "ENOENT") return true; throw error; }
    if (Date.now() - stat.mtimeMs <= OUTCOME_LOCK_STALE_MS) return false;
    let owner = null;
    try { owner = JSON.parse(operations.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch { owner = null; }
    if (owner && processAlive(owner.pid)) return false;
    const quarantine = `${lock}.stale.${process.pid}.${randomUUID()}`;
    try { operations.renameSync(lock, quarantine); }
    catch (error) { if (error?.code === "ENOENT") return true; throw error; }
    operations.rmSync(quarantine, { recursive: true, force: true });
    return true;
  } finally {
    let ours = false;
    try { ours = JSON.parse(operations.readFileSync(path.join(reaper, "owner.json"), "utf8"))?.token === token; } catch { ours = false; }
    if (ours) {
      try { operations.rmSync(reaper, { recursive: true, force: true }); } catch { /* bounded acquisition retries */ }
    }
  }
}

function withOutcomeLock(home, operations, action) {
  const directory = path.join(homeRoot(home), ".taskloop");
  operations.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".outcomes.lock");
  const token = randomUUID();
  const configured = Number.parseInt(process.env.TASKLOOP_OUTCOME_LOCK_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 15000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { operations.mkdirSync(lock); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (reapDeadOutcomeLock(lock, operations)) continue;
      if (Date.now() >= deadline) throw Object.assign(new Error(`outcome-v3 projection lock unavailable after ${timeoutMs}ms`), { code: "OUTCOME_LOCK_TIMEOUT" });
      Atomics.wait(OUTCOME_LOCK_WAIT, 0, 0, 5);
      continue;
    }
    try {
      operations.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }));
      return action();
    } finally {
      let ours = false;
      try { ours = JSON.parse(operations.readFileSync(path.join(lock, "owner.json"), "utf8"))?.token === token; } catch { ours = false; }
      if (ours) operations.rmSync(lock, { recursive: true, force: true });
    }
  }
}

function homeRoot(home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()) {
  return path.resolve(home);
}

function projectionPath(home) {
  return path.join(homeRoot(home), ".taskloop", OUTCOME_PROJECTION_FILE);
}

function cursorPath(repoIdentity, home) {
  return path.join(homeRoot(home), ".taskloop", OUTCOME_CURSOR_DIR, `${sha256Hex(repoIdentity).slice("sha256:".length)}.json`);
}

function pathEntryExists(target, operations = fs) {
  try { operations.lstatSync(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function migrateLegacyOutcomeNames({ home, fsOps = fs } = {}) {
  return withOutcomeLock(home, fsOps, () => {
    const directory = path.join(homeRoot(home), ".taskloop");
    const paths = {
      currentProjection: path.join(directory, OUTCOME_PROJECTION_FILE),
      legacyProjection: path.join(directory, LEGACY_OUTCOME_PROJECTION_FILE),
      currentCursors: path.join(directory, OUTCOME_CURSOR_DIR),
      legacyCursors: path.join(directory, LEGACY_OUTCOME_CURSOR_DIR),
    };
    const state = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, pathEntryExists(value, fsOps)]));
    if (state.currentCursors && state.legacyCursors) {
      throw new Error(`both ${OUTCOME_CURSOR_DIR} and ${LEGACY_OUTCOME_CURSOR_DIR} exist; refusing to choose outcome cursors`);
    }
    if (state.legacyProjection) {
      const stat = fsOps.lstatSync(paths.legacyProjection);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`legacy outcome projection must be a regular non-symlink file: ${paths.legacyProjection}`);
      readProjectionRows(paths.legacyProjection, fsOps);
    }
    if (state.legacyCursors) {
      const stat = fsOps.lstatSync(paths.legacyCursors);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`legacy outcome cursor path must be a non-symlink directory: ${paths.legacyCursors}`);
    }
    const outcomeProjection = {
      migrated: false,
      from: `~/.taskloop/${LEGACY_OUTCOME_PROJECTION_FILE}`,
      to: `~/.taskloop/${OUTCOME_PROJECTION_FILE}`,
      preserved_existing: null,
    };
    const outcomeCursors = {
      migrated: false,
      from: `~/.taskloop/${LEGACY_OUTCOME_CURSOR_DIR}`,
      to: `~/.taskloop/${OUTCOME_CURSOR_DIR}`,
    };
    if (state.currentProjection && state.legacyProjection) {
      const stat = fsOps.lstatSync(paths.currentProjection);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`existing stable outcome projection must be a regular non-symlink file: ${paths.currentProjection}`);
      let currentSchema = false;
      try { readProjectionRows(paths.currentProjection, fsOps); currentSchema = true; }
      catch { /* an older projection may legitimately occupy the stable name */ }
      if (currentSchema) throw new Error(`both ${OUTCOME_PROJECTION_FILE} and ${LEGACY_OUTCOME_PROJECTION_FILE} contain current-schema projections; refusing to choose one`);
      const raw = fsOps.readFileSync(paths.currentProjection);
      const digest = sha256Hex(raw);
      const archiveDirectory = path.join(directory, "archive");
      const stem = `outcomes-legacy-${digest.slice("sha256:".length)}-${randomUUID()}`;
      const archivePath = path.join(archiveDirectory, `${stem}.jsonl`);
      const receiptPath = path.join(archiveDirectory, `${stem}.receipt.json`);
      fsOps.mkdirSync(archiveDirectory, { recursive: true });
      fsOps.renameSync(paths.currentProjection, archivePath);
      const receipt = {
        source_path: `~/.taskloop/${OUTCOME_PROJECTION_FILE}`,
        archive_path: `~/.taskloop/archive/${stem}.jsonl`,
        raw_sha256: digest,
        reason: "preserved pre-contract-5 data occupying the stable outcome projection name",
      };
      atomicWriteJson(receiptPath, receipt, fsOps);
      outcomeProjection.preserved_existing = receipt;
    }
    if (state.legacyProjection) {
      fsOps.renameSync(paths.legacyProjection, paths.currentProjection);
      outcomeProjection.migrated = true;
    }
    if (state.legacyCursors) {
      fsOps.renameSync(paths.legacyCursors, paths.currentCursors);
      outcomeCursors.migrated = true;
    }
    return { outcome_projection: outcomeProjection, outcome_cursors: outcomeCursors };
  });
}

function exactKeys(value, fields) {
  return isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function validateProjectionRow(row) {
  if (!exactKeys(row, ROW_FIELDS)) throw new Error("invalid outcome-v3 projection fields");
  if (row.projection_schema_version !== V3_OUTCOME_PROJECTION_SCHEMA_VERSION) throw new Error("invalid outcome-v3 projection version");
  if (!/^sha256:[0-9a-f]{64}$/.test(row.repo_identity) || !/^sha256:[0-9a-f]{64}$/.test(row.event_id)) throw new Error("invalid outcome-v3 identity");
  if (!Number.isSafeInteger(row.repo_sequence) || row.repo_sequence < 1 || !Number.isSafeInteger(row.task_event_sequence) || row.task_event_sequence < 1) throw new Error("invalid outcome-v3 sequence");
  if (!Number.isSafeInteger(row.occurred_at_epoch_ms) || utcTimestamp(row.occurred_at_epoch_ms) !== row.occurred_at) throw new Error("invalid outcome-v3 timestamp");
  if (typeof row.task_id !== "string" || !row.task_id || typeof row.kind !== "string" || !row.kind || !isPlainObject(row.payload)) throw new Error("invalid outcome-v3 event");
  return row;
}

function rowsForRecord(repoIdentity, record) {
  return record.events.map((event) => validateProjectionRow({
    projection_schema_version: V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
    repo_identity: repoIdentity,
    repo_sequence: record.repo_sequence,
    event_id: event.event_id,
    task_id: event.task_id,
    task_event_sequence: event.task_event_sequence,
    kind: event.kind,
    occurred_at_epoch_ms: record.occurred_at_epoch_ms,
    occurred_at: record.occurred_at,
    payload: event.payload,
  }));
}

function syncFile(target, operations = fs) {
  const fd = operations.openSync(target, "r+");
  try { operations.fsyncSync(fd); } finally { operations.closeSync(fd); }
}

function projectionEndsAtRecordBoundary(target, operations = fs) {
  let size;
  try { size = operations.statSync(target).size; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (size === 0) return false;
  const fd = operations.openSync(target, "r");
  const byte = Buffer.allocUnsafe(1);
  try { operations.readSync(fd, byte, 0, 1, size - 1); } finally { operations.closeSync(fd); }
  return byte[0] === 0x0a;
}

function readOutcomeCursor(repoIdentity, home, operations = fs) {
  let cursor;
  try { cursor = JSON.parse(operations.readFileSync(cursorPath(repoIdentity, home), "utf8")); }
  catch { return null; }
  if (
    !exactKeys(cursor, CURSOR_FIELDS) ||
    cursor.projection_schema_version !== V3_OUTCOME_PROJECTION_SCHEMA_VERSION ||
    cursor.repo_identity !== repoIdentity ||
    !Number.isSafeInteger(cursor.last_repo_sequence) || cursor.last_repo_sequence < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(cursor.last_record_digest) ||
    !Number.isSafeInteger(cursor.projection_from_offset) || cursor.projection_from_offset < 0 ||
    !Number.isSafeInteger(cursor.projection_to_offset) || cursor.projection_to_offset <= cursor.projection_from_offset ||
    !/^sha256:[0-9a-f]{64}$/.test(cursor.projection_range_sha256) ||
    typeof cursor.updated_at !== "string" || !Number.isFinite(Date.parse(cursor.updated_at))
  ) return null;
  return cursor;
}

function projectionContainsCursor(target, cursor, operations = fs) {
  let size;
  try { size = operations.statSync(target).size; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (cursor.projection_to_offset > size) return false;
  const hash = createHash("sha256");
  const fd = operations.openSync(target, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = cursor.projection_from_offset;
  try {
    while (position < cursor.projection_to_offset) {
      const requested = Math.min(buffer.length, cursor.projection_to_offset - position);
      const read = operations.readSync(fd, buffer, 0, requested, position);
      if (read <= 0) return false;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally { operations.closeSync(fd); }
  return `sha256:${hash.digest("hex")}` === cursor.projection_range_sha256;
}

function incrementalAdditions(repoIdentity, records, target, home, operations = fs) {
  if (records.length !== 1 || !projectionEndsAtRecordBoundary(target, operations)) return null;
  const record = records[0];
  const cursor = readOutcomeCursor(repoIdentity, home, operations);
  if (!cursor || !projectionContainsCursor(target, cursor, operations)) return null;
  if (cursor.last_repo_sequence === record.repo_sequence && cursor.last_record_digest === record.record_digest) return { additions: [], cursor };
  if (
    record.repo_sequence !== cursor.last_repo_sequence + 1 ||
    record.previous_record_digest !== cursor.last_record_digest
  ) return null;
  return { additions: rowsForRecord(repoIdentity, record), cursor };
}

function serializedRows(rows) {
  return Buffer.from(rows.map((row) => canonicalJson(row)).join("\n") + "\n", "utf8");
}

function projectionAnchor(target, repoIdentity, record, operations = fs) {
  const needle = serializedRows(rowsForRecord(repoIdentity, record));
  let bytes;
  try { bytes = operations.readFileSync(target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const offset = bytes.indexOf(needle);
  if (offset < 0) return null;
  return {
    projection_from_offset: offset,
    projection_to_offset: offset + needle.length,
    projection_range_sha256: sha256Hex(needle),
  };
}

function readProjectionRows(target, operations = fs, { recoverTornTail = false } = {}) {
  let bytes;
  try { bytes = operations.readFileSync(target); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0x0a) {
    if (!recoverTornTail) throw new Error("outcome-v3 projection has a torn tail");
    const validEndOffset = bytes.lastIndexOf(0x0a) + 1;
    const tail = bytes.subarray(validEndOffset);
    let completeRow = false;
    try { validateProjectionRow(JSON.parse(tail.toString("utf8"))); completeRow = true; } catch { /* discard an incomplete derived row */ }
    if (completeRow) {
      operations.appendFileSync(target, "\n", "utf8");
      syncFile(target, operations);
      bytes = Buffer.concat([bytes, Buffer.from("\n")]);
    } else {
      operations.truncateSync(target, validEndOffset);
      syncFile(target, operations);
      bytes = bytes.subarray(0, validEndOffset);
    }
  }
  if (!bytes.length) return [];
  return bytes.subarray(0, bytes.length - 1).toString("utf8").split("\n").map((line) => validateProjectionRow(JSON.parse(line)));
}

function atomicWriteJson(target, value, operations = fs) {
  operations.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  operations.writeFileSync(temporary, `${prettyCanonicalJson(value)}\n`, "utf8");
  operations.renameSync(temporary, target);
}

function syncOutcomeRecords({ repoIdentity, records, priorRecords = null, home, fsOps = fs, incremental = false }) {
  const target = projectionPath(home);
  const fast = incremental ? incrementalAdditions(repoIdentity, records, target, home, fsOps) : null;
  let existing = null;
  let additions = fast?.additions ?? null;
  if (additions === null) {
    existing = readProjectionRows(target, fsOps, { recoverTornTail: true });
    const seen = new Set(existing.map((row) => row.event_id));
    additions = [];
    const fallbackRecords = priorRecords === null ? records : [...priorRecords, ...records];
    for (const record of fallbackRecords) for (const row of rowsForRecord(repoIdentity, record)) if (!seen.has(row.event_id)) {
      seen.add(row.event_id);
      additions.push(row);
    }
  }
  const latest = records.at(-1) ?? null;
  let anchor = fast && latest && fast.cursor.last_repo_sequence === latest.repo_sequence && fast.cursor.last_record_digest === latest.record_digest
    ? {
        projection_from_offset: fast.cursor.projection_from_offset,
        projection_to_offset: fast.cursor.projection_to_offset,
        projection_range_sha256: fast.cursor.projection_range_sha256,
      }
    : null;
  if (additions.length) {
    fsOps.mkdirSync(path.dirname(target), { recursive: true });
    let appendStart = 0;
    try { appendStart = fsOps.statSync(target).size; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const bytes = serializedRows(additions);
    fsOps.appendFileSync(target, bytes);
    if (latest) {
      const latestBytes = serializedRows(rowsForRecord(repoIdentity, latest));
      const relativeOffset = bytes.indexOf(latestBytes);
      if (relativeOffset >= 0) anchor = {
        projection_from_offset: appendStart + relativeOffset,
        projection_to_offset: appendStart + relativeOffset + latestBytes.length,
        projection_range_sha256: sha256Hex(latestBytes),
      };
    }
  }
  if (latest && !anchor) anchor = projectionAnchor(target, repoIdentity, latest, fsOps);
  if (latest && anchor) atomicWriteJson(cursorPath(repoIdentity, home), {
    projection_schema_version: V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
    repo_identity: repoIdentity,
    last_repo_sequence: latest.repo_sequence,
    last_record_digest: latest.record_digest,
    ...anchor,
    updated_at: latest.occurred_at,
  }, fsOps);
  return { valid: true, added: additions.length, total: existing === null ? null : existing.length + additions.length, projection_path: target, cursor_path: cursorPath(repoIdentity, home) };
}

function auditOutcomeProjection({ home, fsOps = fs } = {}) {
  const target = projectionPath(home);
  try {
    const rows = readProjectionRows(target, fsOps);
    const ids = new Set();
    for (const row of rows) {
      if (ids.has(row.event_id)) throw new Error(`duplicate event_id: ${row.event_id}`);
      ids.add(row.event_id);
    }
    return { valid: true, row_count: rows.length, projection_path: target };
  } catch (error) {
    return { valid: false, row_count: 0, projection_path: target, error: error?.message ?? String(error) };
  }
}

export { auditOutcomeProjection, cursorPath, migrateLegacyOutcomeNames, projectionPath, syncOutcomeRecords, validateProjectionRow };
