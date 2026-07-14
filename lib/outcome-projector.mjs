// Best-effort HOME projection for schema-v3 repository events. This leaf never
// participates in repository authority and may be deleted and rebuilt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  OUTCOME_CURSOR_DIR,
  OUTCOME_PROJECTION_FILE,
  V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  canonicalJson,
  isPlainObject,
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

function homeRoot(home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()) {
  return path.resolve(home);
}

function projectionPath(home) {
  return path.join(homeRoot(home), ".taskloop", OUTCOME_PROJECTION_FILE);
}

function cursorPath(repoIdentity, home) {
  return path.join(homeRoot(home), ".taskloop", OUTCOME_CURSOR_DIR, `${sha256Hex(repoIdentity).slice("sha256:".length)}.json`);
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
  operations.writeFileSync(temporary, `${canonicalJson(value)}\n`, "utf8");
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

export { auditOutcomeProjection, cursorPath, projectionPath, syncOutcomeRecords, validateProjectionRow };
