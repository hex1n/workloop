import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { LEDGER_DIR, LEDGER_EVENT_SCHEMA_VERSION, LEDGER_FILE, TASK_SCHEMA_VERSION, isPlainObject } from "./prims.mjs";

const EVENT_KINDS = new Set(["task_opened", "task_amended", "task_reviewed", "task_suspended", "task_resumed", "task_terminal"]);

const PAYLOAD_FIELDS = {
  task_opened: new Set(["goal", "policy", "policy_rationale", "criterion", "alignment", "envelope", "budget"]),
  task_amended: new Set(["changed_fields", "reason", "before_substantive_revision", "after_substantive_revision", "before_generation", "after_generation", "before_definition_hash", "after_definition_hash", "grants"]),
  task_reviewed: new Set(["level", "reviewer", "criterion_generation_id", "reviewed_task_revision", "reviewed_artifact_revision", "blocking_findings_count", "advisory_findings_count", "reviewed_at"]),
  task_suspended: new Set(["reason", "judgment", "spent", "artifact_revision"]),
  task_resumed: new Set(["reason", "new_episode_id", "spent"]),
  task_terminal: new Set(["outcome", "closing_observation_id", "provisional", "spent", "review_level", "artifact_revision", "evidence", "verified_at_task_revision", "reason"]),
};

const REQUIRED_PAYLOAD_FIELDS = {
  task_opened: ["goal", "policy", "policy_rationale", "criterion", "alignment", "envelope", "budget"],
  task_amended: ["changed_fields", "reason", "before_substantive_revision", "after_substantive_revision"],
  task_reviewed: ["level", "reviewer", "criterion_generation_id", "reviewed_task_revision", "reviewed_artifact_revision", "blocking_findings_count", "advisory_findings_count", "reviewed_at"],
  task_suspended: ["reason", "judgment", "spent", "artifact_revision"],
  task_resumed: ["reason", "new_episode_id", "spent"],
  task_terminal: ["outcome", "spent"],
};

function ledgerPath() {
  return path.join(path.resolve(process.env.USERPROFILE || process.env.HOME || os.homedir()), LEDGER_DIR, LEDGER_FILE);
}

function eventId(taskId, revision, kind) {
  const hex = createHash("sha256").update(`${taskId}\0${revision}\0${kind}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function makeEvent({ task, kind, payload, repoIdentity, at }) {
  if (!EVENT_KINDS.has(kind)) throw new Error(`unknown ledger event kind: ${kind}`);
  if (!isPlainObject(payload)) throw new Error("ledger payload must be an object");
  return {
    event_schema_version: LEDGER_EVENT_SCHEMA_VERSION,
    event_id: eventId(task.task_id, task.task_revision, kind),
    task_id: task.task_id,
    task_schema_version: TASK_SCHEMA_VERSION,
    task_revision: task.task_revision,
    task_event_sequence: task.last_issued_event_sequence,
    kind,
    occurred_at: at,
    repo_identity: repoIdentity,
    payload,
  };
}

function validateEvent(row) {
  if (!isPlainObject(row) || row.event_schema_version !== 1 || row.task_schema_version !== 1) return "unsupported schema";
  if (!EVENT_KINDS.has(row.kind)) return "unknown kind";
  for (const key of ["event_id", "task_id", "occurred_at", "repo_identity"]) if (!String(row[key] ?? "")) return `missing ${key}`;
  for (const key of ["task_revision", "task_event_sequence"]) if (!Number.isInteger(row[key]) || row[key] < 1) return `invalid ${key}`;
  if (!isPlainObject(row.payload)) return "invalid payload";
  const allowed = PAYLOAD_FIELDS[row.kind];
  for (const key of Object.keys(row.payload)) if (!allowed.has(key)) return `unknown payload field ${key}`;
  for (const key of REQUIRED_PAYLOAD_FIELDS[row.kind]) if (!Object.hasOwn(row.payload, key)) return `missing payload field ${key}`;
  if (row.kind === "task_terminal" && !new Set(["achieved", "not_needed", "abandoned"]).has(row.payload.outcome)) return "invalid terminal outcome";
  if (row.kind === "task_suspended" && !new Set(["needs_input", "stuck", "out_of_budget"]).has(row.payload.reason)) return "invalid suspension reason";
  return null;
}

function appendOutcomeEvent(row) {
  try {
    const error = validateEvent(row);
    if (error) throw new Error(error);
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch (err) {
    process.stderr.write(`taskloop: outcome ledger append failed; task=${row?.task_id ?? "unknown"} revision=${row?.task_revision ?? "unknown"} sequence=${row?.task_event_sequence ?? "unknown"}: ${err?.message ?? err}\n`);
    return false;
  }
}

function auditLedger() {
  const file = ledgerPath();
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (err) {
    if (err?.code === "ENOENT") return { file, exit: 0, events: [], warnings: [], corruptions: [] };
    return { file, exit: 2, events: [], warnings: [], corruptions: [String(err?.message ?? err)] };
  }
  const events = [];
  const warnings = [];
  const corruptions = [];
  const byId = new Map();
  const lastSequence = new Map();
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line) return;
    let row;
    try { row = JSON.parse(line); } catch { corruptions.push(`line ${index + 1}: invalid JSON`); return; }
    const invalid = validateEvent(row);
    if (invalid) { corruptions.push(`line ${index + 1}: ${invalid}`); return; }
    const bytes = JSON.stringify(row);
    if (byId.has(row.event_id)) {
      if (byId.get(row.event_id) === bytes) warnings.push(`line ${index + 1}: duplicate event ${row.event_id}`);
      else corruptions.push(`line ${index + 1}: conflicting event ${row.event_id}`);
      return;
    }
    byId.set(row.event_id, bytes);
    const previous = lastSequence.get(row.task_id) ?? 0;
    if (row.task_event_sequence <= previous) corruptions.push(`line ${index + 1}: sequence regression for ${row.task_id}`);
    else if (row.task_event_sequence > previous + 1) warnings.push(`task ${row.task_id}: sequence gap ${previous + 1}-${row.task_event_sequence - 1}`);
    lastSequence.set(row.task_id, row.task_event_sequence);
    events.push(row);
  });
  return { file, exit: corruptions.length ? 2 : warnings.some((w) => w.includes("sequence gap")) ? 1 : 0, events, warnings, corruptions };
}

export { EVENT_KINDS, PAYLOAD_FIELDS, appendOutcomeEvent, auditLedger, eventId, ledgerPath, makeEvent, validateEvent };
