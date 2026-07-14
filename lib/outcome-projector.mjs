// Best-effort HOME projection for schema-v3 repository events. This leaf never
// participates in repository authority and may be deleted and rebuilt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

function readProjectionRows(target, operations = fs) {
  let raw;
  try { raw = operations.readFileSync(target, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (!raw) return [];
  if (!raw.endsWith("\n")) throw new Error("outcome-v3 projection has a torn tail");
  return raw.slice(0, -1).split("\n").map((line) => validateProjectionRow(JSON.parse(line)));
}

function atomicWriteJson(target, value, operations = fs) {
  operations.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  operations.writeFileSync(temporary, `${canonicalJson(value)}\n`, "utf8");
  operations.renameSync(temporary, target);
}

function syncOutcomeRecords({ repoIdentity, records, home, fsOps = fs }) {
  const target = projectionPath(home);
  const existing = readProjectionRows(target, fsOps);
  const seen = new Set(existing.map((row) => row.event_id));
  const additions = [];
  for (const record of records) for (const row of rowsForRecord(repoIdentity, record)) if (!seen.has(row.event_id)) {
    seen.add(row.event_id);
    additions.push(row);
  }
  if (additions.length) {
    fsOps.mkdirSync(path.dirname(target), { recursive: true });
    fsOps.appendFileSync(target, additions.map((row) => canonicalJson(row)).join("\n") + "\n", "utf8");
  }
  const latest = records.at(-1) ?? null;
  if (latest) atomicWriteJson(cursorPath(repoIdentity, home), {
    projection_schema_version: V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
    repo_identity: repoIdentity,
    last_repo_sequence: latest.repo_sequence,
    last_record_digest: latest.record_digest,
    updated_at: latest.occurred_at,
  }, fsOps);
  return { valid: true, added: additions.length, total: existing.length + additions.length, projection_path: target, cursor_path: cursorPath(repoIdentity, home) };
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
