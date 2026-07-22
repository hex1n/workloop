// Authoritative schema-v3 JSONL event storage. This leaf owns durable record
// framing and integrity; application.mjs remains responsible for orchestration
// and task-engine replay.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  EVENT_STORE_FILE,
  EVENT_KINDS,
  LEGACY_EVENT_STORE_FILE,
  SOURCE_CURSOR_FIELDS,
  V3_EVENT_RECORD_SCHEMA_VERSION,
  canonicalJson,
  cloneJson,
  hasExactKeys,
  isPlainObject,
  isSha256Digest,
  isUuidV4,
  eventPayloadFields,
  pathEntryExists,
  prettyCanonicalJson,
  sha256Hex,
  utcTimestamp,
} from "./prims.mjs";

const RECORD_FIELDS = [
  "record_schema_version", "transaction_id", "command_id", "repo_sequence",
  "occurred_at_epoch_ms", "occurred_at", "actor", "previous_record_digest",
  "events", "record_digest",
];

const EVENT_FIELDS = ["event_id", "task_id", "task_event_sequence", "kind", "payload_version", "payload"];

const TRUSTED_CURSORS = new WeakSet();
const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED = Object.freeze({
  open: Object.freeze(["EISDIR", "EPERM"]),
  fsync: Object.freeze(["EINVAL", "EPERM"]),
});

// Persisted-record validation, deliberately separate from the in-memory
// projection validation (task-engine assertV3*) and the payload field lists
// (prims V3_EVENT_PAYLOAD_FIELDS): the record layer must reject bytes the
// reducer would never see. Defense in depth — a schema change updates all
// three sites together (see AGENTS.md Conventions).
const NESTED_CONTRACTS = Object.freeze({
  "criterion-source": { kind: "enum:file|command", value: "non-empty-string" },
  "declared-input": { path: "repo-relative-path", hash: "sha256-digest" },
  "artifact-change": { path: "repo-relative-path", before: "null|sha256-digest", after: "null|sha256-digest" },
  "criterion-definition": {
    source: "object:criterion-source", authored_by: "enum:self|user", protocol: "enum:binary|tri-state", timeout_seconds: "positive-safe-integer",
    declared_inputs: "array<object:declared-input>", subjects: "array<repo-relative-path>", criterion_definition_hash: "sha256-digest",
    criterion_generation_id: "uuid", criterion_input_fingerprint: "null|sha256-digest", input_coverage: "enum:full|unknown",
    provenance: "enum:repo|state_dir|unresolved",
  },
  execution: {
    exit_code: "null|integer", signal: "null|non-empty-string", duration_ms: "non-negative-safe-integer",
    execution_error: "null|non-empty-string", output_tail: "string:max-4096-utf8-bytes", timeout_seconds: "positive-safe-integer",
  },
  observation: {
    observation_id: "uuid", verdict: "enum:satisfied|unsatisfied|indeterminate", criterion_generation_id: "null|uuid",
    observed_artifact_revision: "null|non-negative-safe-integer", observed_at: "utc-iso-milliseconds",
    execution: "object:execution", changed_paths: "array<repo-relative-path>",
  },
  policy: { open_requirement: "enum:unsatisfied|determinate", witness_requirement: "enum:required|none", close_policy: "enum:automatic|explicit" },
  alignment: { because: "non-empty-string", not_covered: "array<non-empty-string>" },
  envelope: { files: "non-empty-array<repo-relative-path-or-glob>", git: "array<non-empty-string>", destructive: "boolean", network: "boolean" },
  grant: {
    grant_id: "uuid", kind: "enum:git|destructive|network|install|whole_repo|criterion_subject|publish",
    scope: "non-empty-array<non-empty-string>", reason: "non-empty-string", granted_by: "enum:user|self",
    granted_at_task_revision: "positive-safe-integer",
  },
  "proof-gap-record": {
    acceptance_id: "uuid", reason: "non-empty-string", granted_by: "enum:user|self", accepted_at: "utc-iso-milliseconds",
    criterion_generation_id: "uuid", accepted_at_task_revision: "positive-safe-integer",
  },
  assurance: {
    declared_risk: "enum:routine|substantial|critical", risk_reason: "string", risk_declared_by: "enum:default|self|user",
    change_classes: "array<enum:internal|public_contract|schema|security|permissions|migration>", review_policy: "enum:risk_based|required|waived",
    required_review_level: "null|enum:fresh_context|second_model", review_waiver_reason: "null|non-empty-string",
    review_waiver_granted_by: "null|enum:self|user", proof_gap_acceptances: "array<object:proof-gap-record>",
    risk_floor_events: "array<enum:criterion_amend|policy_amend|criterion_amended_after_write|policy_amended_after_write>",
  },
  budget: { rounds: "positive-safe-integer", writes: "null|non-negative-safe-integer", wall_clock_minutes: "null|non-negative-safe-integer", output_tokens: "null|non-negative-safe-integer" },
  episode: {
    episode_id: "uuid", host_session_id: "non-empty-string", started_at: "utc-iso-milliseconds", ended_at: "null|utc-iso-milliseconds",
    start_task_revision: "positive-safe-integer", end_task_revision: "null|positive-safe-integer", output_tokens_estimate: "non-negative-safe-integer",
  },
  judgment: { remaining: "non-empty-string", failure: "non-empty-string", next_action: "non-empty-string" },
  "review-record": {
    review_id: "uuid", criterion_generation_id: "uuid", reviewed_task_revision: "positive-safe-integer",
    reviewed_artifact_revision: "non-negative-safe-integer", level: "enum:fresh_context|second_model", reviewer: "non-empty-string",
    blocking_findings_count: "non-negative-safe-integer", advisory_findings_count: "non-negative-safe-integer",
    reviewed_at: "utc-iso-milliseconds", acting_session: "null|non-empty-string",
  },
});

const PAYLOAD_CONTRACTS = Object.freeze({
  task_opened: {
    goal: "non-empty-string", criterion: "object:criterion-definition", observation: "object:observation",
    policy_name: "enum:default|deferred_witness|steady_satisfied", policy_rationale: "null|non-empty-string",
    alignment: "object:alignment", envelope: "object:envelope", grants: "array<object:grant>", assurance: "object:assurance",
    budget: "object:budget", episodes: "non-empty-array<object:episode>",
  },
  task_suspended: { reason: "enum:needs_input|stuck|out_of_budget", judgment: "object:judgment", close_episode: "boolean", source: "enum:cli|stop", acting_session: "null|non-empty-string" },
  task_resumed: { reason: "non-empty-string", episode: "object:episode", acting_session: "null|non-empty-string" },
  task_joined: { reason: "non-empty-string", episode: "object:episode", acting_session: "non-empty-string" },
  task_terminal: { outcome: "enum:achieved|not_needed|abandoned", evidence: "null|non-empty-string", reason: "null|non-empty-string", source: "enum:cli|stop", acting_session: "null|non-empty-string" },
  write_authorized: { files: "non-empty-array<repo-relative-path>" },
  criterion_observed: { observation: "object:observation", attempt_id: "null|uuid", signature: "null|non-empty-string", failure_summary: "string:max-160-utf8-bytes", drift: "array<repo-relative-path>", source: "enum:open|stop|achieve|cli_verify" },
  criterion_side_effect_recorded: { observation: "object:observation" },
  output_tokens_tallied: {
    source_id: "sha256-digest", source_generation_id: "uuid", episode_id: "uuid", from_offset: "non-negative-safe-integer",
    to_offset: "non-negative-safe-integer", range_sha256: "sha256-digest", end_anchor_sha256: "sha256-digest",
    output_tokens_delta: "non-negative-safe-integer", mode: "enum:baseline|increment",
  },
  task_amended: {
    reason: "non-empty-string", goal: "null|non-empty-string", alignment: "null|object:alignment", envelope: "null|object:envelope",
    grants: "null|non-empty-array<object:grant>", rounds: "null|positive-safe-integer", writes: "null|non-negative-safe-integer",
    wall_clock_minutes: "null|non-negative-safe-integer", output_tokens: "null|non-negative-safe-integer", assurance: "null|object:assurance",
    criterion: "null|object:criterion-definition", policy: "null|object:policy", policy_rationale: "null|non-empty-string", generation_id: "null|uuid", artifact_revision: "non-negative-safe-integer",
  },
  review_recorded: { record: "object:review-record" },
  proof_gap_accepted: { record: "object:proof-gap-record" },
  tool_completed: {
    operation_id: "non-empty-string", tool_family: "non-empty-string", outcome: "enum:success|failure|nonzero|unknown",
    reported_targets: "array<repo-relative-path>", receipt_quality: "enum:exact|tool_specific|reconciled|unknown", host_profile: "non-empty-string",
  },
  artifact_reconciled: {
    checkpoint_id: "sha256-digest", from_checkpoint: "sha256-digest", to_checkpoint: "sha256-digest",
    changed_entries: "array<object:artifact-change>", changed_paths: "array<repo-relative-path>",
    current_scope_violations: "array<repo-relative-path>", coverage: "enum:full|unknown", reason: "non-empty-string",
  },
  coverage_changed: {
    artifact_state: "enum:full|unknown", mutation_history: "enum:full|partial|unknown", prewrite_enforcement: "enum:full|partial|unknown",
    episode_id: "uuid", operation_id: "null|non-empty-string", capability_id: "null|non-empty-string", host_profile: "non-empty-string",
    surface: "non-empty-string", exhaustive_surface: "boolean", effective_from_checkpoint: "sha256-digest",
    interval_from_checkpoint: "sha256-digest", interval_to_checkpoint: "null|sha256-digest", reason: "non-empty-string",
  },
});

const PAYLOAD_CONTRACTS_V2 = Object.freeze({
  write_authorized: {
    operation_id: "non-empty-string", tool_family: "non-empty-string", declared_targets: "non-empty-array<repo-relative-path>",
    target_coverage: "enum:exact|partial|unknown", host_profile: "non-empty-string", receipt_expectation: "enum:post|failure|reconcile|unknown",
  },
  criterion_observed: {
    ...PAYLOAD_CONTRACTS.criterion_observed,
    checkpoint_id: "sha256-digest", evidence_revision: "non-negative-safe-integer", event_cursor: "positive-safe-integer",
  },
  criterion_side_effect_recorded: {
    ...PAYLOAD_CONTRACTS.criterion_side_effect_recorded,
    checkpoint_id: "sha256-digest", evidence_revision: "non-negative-safe-integer", event_cursor: "positive-safe-integer",
  },
  review_recorded: { record: "object:review-record" },
});

const ERROR_MESSAGES = Object.freeze({
  UNKNOWN_RECORD_FIELD: "event record contains an unknown field",
  UNKNOWN_EVENT_FIELD: "domain event contains an unknown field",
  UNKNOWN_EVENT_KIND: "domain event kind is unsupported",
  UNSUPPORTED_RECORD_VERSION: "event record schema version is unsupported",
  UNSUPPORTED_PAYLOAD_VERSION: "domain event payload version is unsupported",
  CORRUPT_RECORD_DIGEST: "event record digest does not match canonical bytes",
  CORRUPT_EVENT_DIGEST: "domain event id does not match canonical bytes",
  REPO_SEQUENCE_GAP: "repository event sequence is not contiguous",
  TASK_SEQUENCE_GAP: "task event sequence is not contiguous",
  HASH_CHAIN_MISMATCH: "previous record digest does not match the event hash chain",
  TORN_TAIL_RECOVERY_REQUIRED: "event store has a torn tail that requires locked recovery",
});

// The message stays the frozen contract text; the failing field path rides as
// error.field so a corrupt record is diagnosable without loosening the frozen
// message set.
function eventStoreError(code, field = null) {
  return Object.assign(new Error(ERROR_MESSAGES[code] ?? code), { code, ...(field ? { field } : {}) });
}

function makeCursor({ validEndOffset, lastRepoSequence, lastRecordDigest, taskSequences }) {
  const cursor = Object.freeze({
    valid_end_offset: validEndOffset,
    last_repo_sequence: lastRepoSequence,
    last_record_digest: lastRecordDigest,
    task_sequences: Object.freeze({ ...taskSequences }),
  });
  TRUSTED_CURSORS.add(cursor);
  return cursor;
}

function makeSourceCursor(record, validEndOffset) {
  const event = record.events.at(-1);
  return {
    event_store_file: EVENT_STORE_FILE,
    repo_sequence: record.repo_sequence,
    task_event_sequence: event.task_event_sequence,
    record_digest: record.record_digest,
    event_id: event.event_id,
    valid_end_offset: validEndOffset,
  };
}

function readRecordEndingAt(target, endOffset, operations = fs) {
  if (!Number.isSafeInteger(endOffset) || endOffset < 1) throw new Error("event-store cursor does not identify a committed record");
  const fd = operations.openSync(target, "r");
  try {
    const finalByte = Buffer.allocUnsafe(1);
    if (operations.readSync(fd, finalByte, 0, 1, endOffset - 1) !== 1 || finalByte[0] !== 0x0a) {
      throw new Error("event-store cursor does not identify a committed record");
    }
    const chunks = [];
    let position = endOffset - 1;
    while (position > 0) {
      const start = Math.max(0, position - 4096);
      const chunk = Buffer.allocUnsafe(position - start);
      let read = 0;
      while (read < chunk.length) {
        const count = operations.readSync(fd, chunk, read, chunk.length - read, start + read);
        if (!Number.isSafeInteger(count) || count <= 0) throw new Error("event-store cursor read made no valid progress");
        read += count;
      }
      const previousNewline = chunk.lastIndexOf(0x0a);
      chunks.unshift(previousNewline === -1 ? chunk : chunk.subarray(previousNewline + 1));
      if (previousNewline !== -1) break;
      position = start;
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("event-store cursor cannot verify its source record"); }
  } finally { operations.closeSync(fd); }
}

function cursorMatchesRecord(cursor, record) {
  if (record.repo_sequence !== cursor.last_repo_sequence || record.record_digest !== cursor.last_record_digest) return false;
  const latestInRecord = {};
  for (const event of record.events) latestInRecord[event.task_id] = event.task_event_sequence;
  return Object.entries(latestInRecord).every(([taskId, sequence]) => cursor.task_sequences[taskId] === sequence);
}

function verifyAppendCursor(target, cursor, operations = fs) {
  if (!TRUSTED_CURSORS.has(cursor)) throw new Error("event-store append requires a trusted replay cursor");
  if (cursor.valid_end_offset !== operations.statSync(target).size) throw new Error("event-store append cursor is stale or invalid");
  const last = readRecordEndingAt(target, cursor.valid_end_offset, operations);
  validateRecord(last);
  if (!cursorMatchesRecord(cursor, last)) throw new Error("event-store append cursor does not match the disk tail");
  return cursor;
}

function verifyEventStoreSourceCursor(repo, sourceCursor, { fsOps = fs } = {}) {
  if (
    !hasExactKeys(sourceCursor, SOURCE_CURSOR_FIELDS) ||
    sourceCursor.event_store_file !== EVENT_STORE_FILE ||
    !Number.isSafeInteger(sourceCursor.repo_sequence) || sourceCursor.repo_sequence < 1 ||
    !Number.isSafeInteger(sourceCursor.task_event_sequence) || sourceCursor.task_event_sequence < 1 ||
    !isSha256Digest(sourceCursor.record_digest) || !isSha256Digest(sourceCursor.event_id) ||
    !Number.isSafeInteger(sourceCursor.valid_end_offset) || sourceCursor.valid_end_offset < 1
  ) throw new Error("event-store source cursor is invalid");
  const target = eventStorePath(repo);
  if (sourceCursor.valid_end_offset > fsOps.statSync(target).size) throw new Error("event-store source cursor is ahead of authority");
  const record = readRecordEndingAt(target, sourceCursor.valid_end_offset, fsOps);
  validateRecord(record);
  const event = record.events.at(-1);
  if (
    record.repo_sequence !== sourceCursor.repo_sequence || record.record_digest !== sourceCursor.record_digest ||
    event.task_event_sequence !== sourceCursor.task_event_sequence || event.event_id !== sourceCursor.event_id
  ) throw new Error("event-store source cursor does not match authority");
  return {
    record,
    event,
    cursor: makeCursor({
      validEndOffset: sourceCursor.valid_end_offset,
      lastRepoSequence: sourceCursor.repo_sequence,
      lastRecordDigest: sourceCursor.record_digest,
      taskSequences: { [event.task_id]: event.task_event_sequence },
    }),
  };
}

function exactKeys(value, expected, code, field = null) {
  if (!hasExactKeys(value, expected)) throw eventStoreError(code, field);
}

function validateDescriptor(value, descriptor, { allowLegacy = false, path: fieldPath = null } = {}) {
  if (descriptor.startsWith("null|")) {
    if (value === null) return;
    return validateDescriptor(value, descriptor.slice(5), { allowLegacy, path: fieldPath });
  }
  if (descriptor.startsWith("object:")) {
    const contractName = descriptor.slice(7);
    const contract = NESTED_CONTRACTS[contractName];
    if (!contract) throw new Error(`unknown persisted descriptor: ${descriptor}`);
    const expected = Object.keys(contract);
    const legacyCriterion = allowLegacy && contractName === "criterion-definition" && isPlainObject(value) && value.authored_by === undefined;
    exactKeys(value, legacyCriterion ? expected.filter((field) => field !== "authored_by") : expected, "UNKNOWN_EVENT_FIELD", fieldPath);
    for (const [field, child] of Object.entries(contract)) {
      if (!(legacyCriterion && field === "authored_by")) validateDescriptor(value[field], child, { allowLegacy, path: fieldPath ? `${fieldPath}.${field}` : field });
    }
    return;
  }
  const array = descriptor.match(/^(non-empty-)?array<(.+)>$/);
  if (array) {
    if (!Array.isArray(value) || (array[1] && value.length === 0)) throw eventStoreError("UNKNOWN_EVENT_FIELD", fieldPath);
    for (let index = 0; index < value.length; index += 1) validateDescriptor(value[index], array[2], { allowLegacy, path: fieldPath ? `${fieldPath}[${index}]` : `[${index}]` });
    return;
  }
  if (descriptor.startsWith("enum:")) {
    if (!descriptor.slice(5).split("|").includes(value)) throw eventStoreError("UNKNOWN_EVENT_FIELD", fieldPath);
    return;
  }
  let valid = false;
  if (descriptor === "uuid") valid = isUuidV4(value);
  else if (descriptor === "sha256-digest") valid = isSha256Digest(value);
  else if (descriptor === "positive-safe-integer") valid = Number.isSafeInteger(value) && value > 0;
  else if (descriptor === "non-negative-safe-integer") valid = Number.isSafeInteger(value) && value >= 0;
  else if (descriptor === "integer") valid = Number.isSafeInteger(value);
  else if (descriptor === "boolean") valid = typeof value === "boolean";
  else if (descriptor === "non-empty-string") valid = typeof value === "string" && value.length > 0;
  else if (descriptor.startsWith("string")) {
    valid = typeof value === "string";
    const limit = descriptor.match(/^string:max-(\d+)-utf8-bytes$/)?.[1];
    if (valid && limit) valid = Buffer.byteLength(value, "utf8") <= Number(limit);
  } else if (descriptor === "utc-iso-milliseconds") {
    valid = typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
  } else if (descriptor === "repo-relative-path" || descriptor === "repo-relative-path-or-glob") {
    const portable = typeof value === "string" ? value.replaceAll("\\", "/") : "";
    const normalized = path.posix.normalize(portable);
    valid = portable.length > 0 && !path.posix.isAbsolute(portable) && !path.win32.isAbsolute(value) && normalized !== ".." && !normalized.startsWith("../");
  } else throw new Error(`unknown persisted descriptor: ${descriptor}`);
  if (!valid) throw eventStoreError("UNKNOWN_EVENT_FIELD", fieldPath);
}

function validateEventPayload(kind, payload, { allowLegacy = false, payloadVersion = 1 } = {}) {
  const contract = payloadVersion === 1 ? PAYLOAD_CONTRACTS[kind] : PAYLOAD_CONTRACTS_V2[kind];
  if (!contract) throw eventStoreError("UNSUPPORTED_PAYLOAD_VERSION");
  const expected = Object.keys(contract);
  const legacyAmend = allowLegacy && kind === "task_amended" && isPlainObject(payload) && payload.artifact_revision === undefined;
  exactKeys(payload, legacyAmend ? expected.filter((field) => field !== "artifact_revision") : expected, "UNKNOWN_EVENT_FIELD", "payload");
  for (const [field, descriptor] of Object.entries(contract)) {
    if (!(legacyAmend && field === "artifact_revision")) validateDescriptor(payload[field], descriptor, { allowLegacy, path: `payload.${field}` });
  }
  if (kind === "output_tokens_tallied") {
    if (payload.mode === "baseline" && (payload.output_tokens_delta !== 0 || payload.to_offset < payload.from_offset)) throw eventStoreError("UNKNOWN_EVENT_FIELD", "payload.output_tokens_delta");
    if (payload.mode === "increment" && payload.to_offset <= payload.from_offset) throw eventStoreError("UNKNOWN_EVENT_FIELD", "payload.to_offset");
  }
  if (kind === "task_terminal") {
    if (payload.outcome === "not_needed" && payload.evidence === null) throw eventStoreError("UNKNOWN_EVENT_FIELD", "payload.evidence");
    if (payload.outcome === "abandoned" && payload.reason === null) throw eventStoreError("UNKNOWN_EVENT_FIELD", "payload.reason");
  }
  if (kind === "task_amended" && payload.policy !== null && payload.criterion === null && payload.generation_id === null) throw eventStoreError("UNKNOWN_EVENT_FIELD", "payload.generation_id");
}

function eventPreimage(event) {
  return {
    task_id: event.task_id,
    task_event_sequence: event.task_event_sequence,
    kind: event.kind,
    payload_version: event.payload_version,
    payload: event.payload,
  };
}

function recordPreimage(record) {
  return {
    record_schema_version: record.record_schema_version,
    transaction_id: record.transaction_id,
    command_id: record.command_id,
    repo_sequence: record.repo_sequence,
    occurred_at_epoch_ms: record.occurred_at_epoch_ms,
    occurred_at: record.occurred_at,
    actor: record.actor,
    previous_record_digest: record.previous_record_digest,
    events: record.events,
  };
}

function validateEvent(event, { allowLegacy = false } = {}) {
  exactKeys(event, EVENT_FIELDS, "UNKNOWN_EVENT_FIELD");
  if (!EVENT_KINDS.includes(event.kind)) throw eventStoreError("UNKNOWN_EVENT_KIND");
  const payloadFields = eventPayloadFields(event.kind, event.payload_version);
  if (!payloadFields) throw eventStoreError("UNSUPPORTED_PAYLOAD_VERSION");
  if (!isUuidV4(event.task_id) || !Number.isSafeInteger(event.task_event_sequence) || event.task_event_sequence < 1) throw eventStoreError("TASK_SEQUENCE_GAP");
  const legacyPayloadFields = allowLegacy && event.kind === "task_amended" && event.payload?.artifact_revision === undefined
    ? payloadFields.filter((field) => field !== "artifact_revision") : payloadFields;
  exactKeys(event.payload, legacyPayloadFields, "UNKNOWN_EVENT_FIELD");
  validateEventPayload(event.kind, event.payload, { allowLegacy, payloadVersion: event.payload_version });
  if (!isSha256Digest(event.event_id) || sha256Hex(canonicalJson(eventPreimage(event))) !== event.event_id) throw eventStoreError("CORRUPT_EVENT_DIGEST");
  return event;
}

function validateRecord(record, { expectedRepoSequence = null, previousRecordDigest = undefined, taskSequences = null } = {}) {
  exactKeys(record, RECORD_FIELDS, "UNKNOWN_RECORD_FIELD");
  if (!new Set([1, V3_EVENT_RECORD_SCHEMA_VERSION]).has(record.record_schema_version)) throw eventStoreError("UNSUPPORTED_RECORD_VERSION");
  if (!isUuidV4(record.transaction_id) || !(record.command_id === null || (typeof record.command_id === "string" && record.command_id.length > 0))) throw eventStoreError("UNKNOWN_RECORD_FIELD");
  if (!Number.isSafeInteger(record.repo_sequence) || record.repo_sequence < 1 || (expectedRepoSequence !== null && record.repo_sequence !== expectedRepoSequence)) throw eventStoreError("REPO_SEQUENCE_GAP");
  if (!Number.isSafeInteger(record.occurred_at_epoch_ms) || record.occurred_at_epoch_ms < 0 || utcTimestamp(record.occurred_at_epoch_ms) !== record.occurred_at) throw eventStoreError("UNKNOWN_RECORD_FIELD");
  exactKeys(record.actor, ["kind", "session_id"], "UNKNOWN_RECORD_FIELD");
  if (!new Set(["cli", "hook"]).has(record.actor.kind) || !(record.actor.session_id === null || (typeof record.actor.session_id === "string" && record.actor.session_id.length > 0))) throw eventStoreError("UNKNOWN_RECORD_FIELD");
  if (!(record.previous_record_digest === null || isSha256Digest(record.previous_record_digest))) throw eventStoreError("HASH_CHAIN_MISMATCH");
  if ((record.repo_sequence === 1) !== (record.previous_record_digest === null)) throw eventStoreError("HASH_CHAIN_MISMATCH");
  if (previousRecordDigest !== undefined && record.previous_record_digest !== previousRecordDigest) throw eventStoreError("HASH_CHAIN_MISMATCH");
  if (!Array.isArray(record.events) || !record.events.length) throw eventStoreError("UNKNOWN_RECORD_FIELD");
  for (const event of record.events) {
    validateEvent(event, { allowLegacy: record.record_schema_version === 1 });
    if (taskSequences) {
      const expected = (taskSequences[event.task_id] ?? 0) + 1;
      if (event.task_event_sequence !== expected) throw eventStoreError("TASK_SEQUENCE_GAP");
      taskSequences[event.task_id] = expected;
    }
  }
  if (record.repo_sequence === 1 && (record.events.length !== 1 || record.events[0].kind !== "task_opened" || record.events[0].task_event_sequence !== 1)) {
    throw new Error("event-store genesis must contain exactly one task_opened event");
  }
  if (!isSha256Digest(record.record_digest) || sha256Hex(canonicalJson(recordPreimage(record))) !== record.record_digest) throw eventStoreError("CORRUPT_RECORD_DIGEST");
  return record;
}

function buildRecord({ transactionId, commandId = null, repoSequence, occurredAtEpochMs, actor, previousRecordDigest, events }) {
  const persistedEvents = events.map((event) => {
    const persisted = {
      task_id: event.task_id,
      task_event_sequence: event.task_event_sequence,
      kind: event.kind,
      payload_version: event.payload_version,
      payload: cloneJson(event.payload),
    };
    return { event_id: sha256Hex(canonicalJson(persisted)), ...persisted };
  });
  const preimage = {
    record_schema_version: V3_EVENT_RECORD_SCHEMA_VERSION,
    transaction_id: transactionId,
    command_id: commandId,
    repo_sequence: repoSequence,
    occurred_at_epoch_ms: occurredAtEpochMs,
    occurred_at: utcTimestamp(occurredAtEpochMs),
    actor: cloneJson(actor),
    previous_record_digest: previousRecordDigest,
    events: persistedEvents,
  };
  const record = { ...preimage, record_digest: sha256Hex(canonicalJson(preimage)) };
  return validateRecord(record);
}

function eventStorePath(repo) {
  return path.join(path.resolve(repo), ".workloop", EVENT_STORE_FILE);
}

function legacyEventStorePath(repo) {
  return path.join(path.resolve(repo), ".workloop", LEGACY_EVENT_STORE_FILE);
}

function eventStoreNameState(repo, { fsOps = fs } = {}) {
  const current = eventStorePath(repo);
  const legacy = legacyEventStorePath(repo);
  return {
    current,
    legacy,
    current_exists: pathEntryExists(current, fsOps),
    legacy_exists: pathEntryExists(legacy, fsOps),
  };
}

function migrateLegacyEventStoreName(repo, { reason, grantedBy, fsOps = fs } = {}) {
  if (grantedBy !== "user") throw new Error("migrate-artifact-names requires --granted-by user");
  if (!String(reason ?? "").trim()) throw new Error("migrate-artifact-names requires --reason");
  const state = eventStoreNameState(repo, { fsOps });
  if (state.current_exists && state.legacy_exists) {
    throw Object.assign(
      new Error(`both ${EVENT_STORE_FILE} and ${LEGACY_EVENT_STORE_FILE} exist; refusing to choose an authority`),
      { code: "ARTIFACT_NAME_CONFLICT" },
    );
  }
  const result = {
    migrated: false,
    from: `.workloop/${LEGACY_EVENT_STORE_FILE}`,
    to: `.workloop/${EVENT_STORE_FILE}`,
    raw_sha256: null,
    directory_fsync: "not_required",
  };
  if (!state.legacy_exists) return result;
  const stat = fsOps.lstatSync(state.legacy);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`legacy event authority must be a regular non-symlink file: ${state.legacy}`);
  const raw = fsOps.readFileSync(state.legacy);
  parseCompleteRecords(raw);
  fsOps.renameSync(state.legacy, state.current);
  return {
    ...result,
    migrated: true,
    raw_sha256: sha256Hex(raw),
    directory_fsync: syncDirectory(path.dirname(state.current), fsOps),
  };
}

function writeAllSync(fd, bytes, operations = fs, onProgress = null) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = operations.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error("event store write made no valid progress");
    offset += written;
    onProgress?.(offset, bytes.length);
  }
  return offset;
}

function syncDirectory(directory, operations = fs, platform = process.platform) {
  let fd;
  try {
    fd = operations.openSync(directory, "r");
  } catch (error) {
    if (platform === "win32" && WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.open.includes(error?.code)) return `unsupported:${error.code}`;
    throw error;
  }
  try {
    operations.fsyncSync(fd);
  } catch (error) {
    if (platform === "win32" && WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.fsync.includes(error?.code)) return `unsupported:${error.code}`;
    throw error;
  } finally {
    operations.closeSync(fd);
  }
  return "supported";
}

function durableReplace(target, bytes, operations = fs) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = operations.openSync(temporary, "wx", 0o600);
    writeAllSync(fd, bytes, operations);
    operations.fsyncSync(fd);
    operations.closeSync(fd);
    fd = undefined;
    operations.renameSync(temporary, target);
  } catch (error) {
    if (fd !== undefined) {
      try { operations.closeSync(fd); } catch { /* preserve original failure */ }
    }
    throw error;
  }
}

function existingTailReceipt(quarantineDirectory, match, operations = fs) {
  if (!operations.existsSync(quarantineDirectory)) return null;
  for (const name of operations.readdirSync(quarantineDirectory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(operations.readFileSync(path.join(quarantineDirectory, name), "utf8"));
      if (
        receipt.valid_end_offset === match.valid_end_offset &&
        receipt.original_file_length === match.original_file_length &&
        receipt.tail_sha256 === match.tail_sha256 &&
        operations.existsSync(receipt.quarantine_path) &&
        sha256Hex(operations.readFileSync(receipt.quarantine_path)) === match.tail_sha256
      ) return receipt;
    } catch { /* an unrelated broken receipt is not reusable */ }
  }
  return null;
}

function recoverTornTail(target, bytes, { fsOps = fs, onSeam = null, recoveryEpochMs = Date.now() } = {}) {
  const lastNewline = bytes.lastIndexOf(0x0a);
  const validEndOffset = lastNewline + 1;
  const tail = bytes.subarray(validEndOffset);
  const tailDigest = sha256Hex(tail);
  const quarantineDirectory = path.join(path.dirname(target), "quarantine");
  fsOps.mkdirSync(quarantineDirectory, { recursive: true });
  const match = { valid_end_offset: validEndOffset, original_file_length: bytes.length, tail_sha256: tailDigest };
  let receipt = existingTailReceipt(quarantineDirectory, match, fsOps);
  if (!receipt) {
    const suffix = `${validEndOffset}-${tailDigest.slice("sha256:".length)}-${randomUUID()}`;
    const quarantinePath = path.join(quarantineDirectory, `events-tail-${suffix}.bin`);
    const receiptPath = path.join(quarantineDirectory, `events-tail-${suffix}.json`);
    durableReplace(quarantinePath, tail, fsOps);
    receipt = {
      source_path: target,
      valid_end_offset: validEndOffset,
      original_file_length: bytes.length,
      tail_sha256: tailDigest,
      quarantine_path: quarantinePath,
      receipt_path: receiptPath,
      recovered_at: utcTimestamp(recoveryEpochMs),
    };
    durableReplace(receiptPath, Buffer.from(`${prettyCanonicalJson(receipt)}\n`, "utf8"), fsOps);
    syncDirectory(quarantineDirectory, fsOps);
  }
  onSeam?.("after-quarantine-receipt-fsync");
  fsOps.truncateSync(target, validEndOffset);
  const fd = fsOps.openSync(target, "r+");
  try { fsOps.fsyncSync(fd); } finally { fsOps.closeSync(fd); }
  return receipt;
}

function commitRecord(repo, record, { fsOps = fs, onSeam = null, cursor = null, platform = process.platform } = {}) {
  validateRecord(record);
  const target = eventStorePath(repo);
  const directory = path.dirname(target);
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
  if (fsOps.existsSync(target)) {
    const current = cursor === null ? readEventStore(repo, { fsOps, recoverTornTail: true }).cursor : verifyAppendCursor(target, cursor, fsOps);
    const lastRepoSequence = current.last_repo_sequence;
    const validEndOffset = current.valid_end_offset;
    const taskSequences = { ...current.task_sequences };
    validateRecord(record, {
      expectedRepoSequence: lastRepoSequence + 1,
      previousRecordDigest: current.last_record_digest,
      taskSequences,
    });
    onSeam?.("before-append");
    const fd = fsOps.openSync(target, "a");
    try {
      writeAllSync(fd, bytes, fsOps, () => onSeam?.("during-append"));
      onSeam?.("after-record-write");
      fsOps.fsyncSync(fd);
      onSeam?.("after-event-fsync");
    } finally {
      fsOps.closeSync(fd);
    }
    return {
      committed: true,
      genesis: false,
      repo_sequence: record.repo_sequence,
      record_digest: record.record_digest,
      bytes_written: bytes.length,
      directory_fsync: "not_required",
      cursor: makeCursor({ validEndOffset: validEndOffset + bytes.length, lastRepoSequence: record.repo_sequence, lastRecordDigest: record.record_digest, taskSequences }),
    };
  }
  if (record.repo_sequence !== 1 || record.previous_record_digest !== null) throw eventStoreError("REPO_SEQUENCE_GAP");
  const genesisTaskSequences = {};
  validateRecord(record, { expectedRepoSequence: 1, previousRecordDigest: null, taskSequences: genesisTaskSequences });
  fsOps.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${EVENT_STORE_FILE}.genesis.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    onSeam?.("before-genesis-temp-create");
    fd = fsOps.openSync(temporary, "wx", 0o600);
    writeAllSync(fd, bytes, fsOps, () => onSeam?.("during-genesis-write"));
    fsOps.fsyncSync(fd);
    onSeam?.("after-genesis-temp-fsync");
    fsOps.closeSync(fd);
    fd = undefined;
    fsOps.renameSync(temporary, target);
    onSeam?.("after-genesis-rename");
    const directoryFsync = syncDirectory(directory, fsOps, platform);
    return {
      committed: true,
      genesis: true,
      repo_sequence: record.repo_sequence,
      record_digest: record.record_digest,
      bytes_written: bytes.length,
      directory_fsync: directoryFsync,
      cursor: makeCursor({ validEndOffset: bytes.length, lastRepoSequence: record.repo_sequence, lastRecordDigest: record.record_digest, taskSequences: genesisTaskSequences }),
    };
  } catch (error) {
    if (fd !== undefined) {
      try { fsOps.closeSync(fd); } catch { /* preserve original failure */ }
    }
    throw error;
  }
}

function parseCompleteRecords(bytes, { firstRepoSequence = 1, previousRecordDigest = null, taskSequences = {} } = {}) {
  if (!bytes.length || bytes.at(-1) !== 0x0a) throw new Error("event-store parser requires complete newline-terminated bytes");
  const lines = bytes.toString("utf8").slice(0, -1).split("\n");
  const records = [];
  const events = [];
  let previous = previousRecordDigest;
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try { record = JSON.parse(lines[index]); } catch { throw eventStoreError("UNKNOWN_RECORD_FIELD"); }
    validateRecord(record, { expectedRepoSequence: firstRepoSequence + index, previousRecordDigest: previous, taskSequences });
    records.push(record);
    for (const event of record.events) events.push({ ...cloneJson(event), at: record.occurred_at, atEpochMs: record.occurred_at_epoch_ms });
    previous = record.record_digest;
  }
  return { records, events, last_record_digest: previous, task_sequences: taskSequences };
}

function readEventStore(repo, { fsOps = fs, onSeam = null, recoveryEpochMs = Date.now(), recoverTornTail: mayRecoverTornTail = false } = {}) {
  const target = eventStorePath(repo);
  let bytes = fsOps.readFileSync(target);
  let recoveredTail = null;
  if (bytes.length && bytes.at(-1) !== 0x0a) {
    const prefixEnd = bytes.lastIndexOf(0x0a) + 1;
    if (prefixEnd === 0) throw new Error("event store contains no committed record");
    parseCompleteRecords(bytes.subarray(0, prefixEnd));
    if (!mayRecoverTornTail) throw eventStoreError("TORN_TAIL_RECOVERY_REQUIRED");
    recoveredTail = recoverTornTail(target, bytes, { fsOps, onSeam, recoveryEpochMs });
    bytes = fsOps.readFileSync(target);
  }
  if (!bytes.length) throw new Error("event store contains no committed record");
  const parsed = parseCompleteRecords(bytes);
  const cursor = makeCursor({
    validEndOffset: bytes.length,
    lastRepoSequence: parsed.records.at(-1).repo_sequence,
    lastRecordDigest: parsed.last_record_digest,
    taskSequences: parsed.task_sequences,
  });
  return {
    records: parsed.records,
    events: parsed.events,
    valid_end_offset: bytes.length,
    last_repo_sequence: parsed.records.at(-1).repo_sequence,
    last_record_digest: parsed.last_record_digest,
    task_sequences: parsed.task_sequences,
    recovered_tail: recoveredTail,
    cursor,
    source_cursor: makeSourceCursor(parsed.records.at(-1), bytes.length),
  };
}

function readEventStoreTail(repo, cursor, { fsOps = fs, onSeam = null, recoveryEpochMs = Date.now(), recoverTornTail: mayRecoverTornTail = false } = {}) {
  if (
    !isPlainObject(cursor) || !Number.isSafeInteger(cursor.valid_end_offset) || cursor.valid_end_offset < 0 ||
    !Number.isSafeInteger(cursor.last_repo_sequence) || cursor.last_repo_sequence < 0 ||
    !(cursor.last_record_digest === null || isSha256Digest(cursor.last_record_digest)) || !isPlainObject(cursor.task_sequences)
  ) throw new Error("event-store tail replay requires a valid cursor");
  const target = eventStorePath(repo);
  const size = fsOps.statSync(target).size;
  if (cursor.valid_end_offset > size) throw new Error("event-store tail cursor is not a record boundary");
  const fd = fsOps.openSync(target, "r");
  let boundary = null;
  let finalByte = null;
  let tail = Buffer.alloc(0);
  try {
    if (cursor.valid_end_offset > 0) {
      boundary = Buffer.allocUnsafe(1);
      fsOps.readSync(fd, boundary, 0, 1, cursor.valid_end_offset - 1);
    }
    if (size > 0) {
      finalByte = Buffer.allocUnsafe(1);
      fsOps.readSync(fd, finalByte, 0, 1, size - 1);
    }
    tail = Buffer.allocUnsafe(size - cursor.valid_end_offset);
    let offset = 0;
    while (offset < tail.length) {
      const count = fsOps.readSync(fd, tail, offset, tail.length - offset, cursor.valid_end_offset + offset);
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error("event-store tail read made no valid progress");
      offset += count;
    }
  } finally { fsOps.closeSync(fd); }
  let recoveredTail = null;
  let validEndOffset = size;
  if (size > 0 && finalByte[0] !== 0x0a) {
    let bytes = fsOps.readFileSync(target);
    const prefixEnd = bytes.lastIndexOf(0x0a) + 1;
    if (prefixEnd === 0) throw new Error("event store contains no committed record");
    if (cursor.valid_end_offset > prefixEnd || (cursor.valid_end_offset > 0 && boundary[0] !== 0x0a)) {
      throw new Error("event-store tail cursor is not a record boundary");
    }
    parseCompleteRecords(bytes.subarray(0, prefixEnd));
    if (!mayRecoverTornTail) throw eventStoreError("TORN_TAIL_RECOVERY_REQUIRED");
    recoveredTail = recoverTornTail(target, bytes, { fsOps, onSeam, recoveryEpochMs });
    bytes = fsOps.readFileSync(target);
    validEndOffset = bytes.length;
    tail = bytes.subarray(cursor.valid_end_offset);
  }
  if (cursor.valid_end_offset > validEndOffset || (cursor.valid_end_offset > 0 && boundary[0] !== 0x0a)) throw new Error("event-store tail cursor is not a record boundary");
  let sourceRecord = null;
  if (cursor.valid_end_offset > 0) {
    sourceRecord = readRecordEndingAt(target, cursor.valid_end_offset, fsOps);
    validateRecord(sourceRecord);
    if (!cursorMatchesRecord(cursor, sourceRecord)) {
      throw new Error("event-store tail cursor does not match its source record");
    }
  } else if (cursor.last_repo_sequence !== 0 || cursor.last_record_digest !== null || Object.keys(cursor.task_sequences).length !== 0) {
    throw new Error("event-store tail cursor does not match an empty source");
  }
  const taskSequences = { ...cursor.task_sequences };
  const parsed = tail.length
    ? parseCompleteRecords(tail, { firstRepoSequence: cursor.last_repo_sequence + 1, previousRecordDigest: cursor.last_record_digest, taskSequences })
    : { records: [], events: [], last_record_digest: cursor.last_record_digest, task_sequences: taskSequences };
  const nextCursor = makeCursor({
    validEndOffset,
    lastRepoSequence: cursor.last_repo_sequence + parsed.records.length,
    lastRecordDigest: parsed.last_record_digest,
    taskSequences: parsed.task_sequences,
  });
  return {
    records: parsed.records,
    events: parsed.events,
    start_offset: cursor.valid_end_offset,
    valid_end_offset: validEndOffset,
    last_repo_sequence: cursor.last_repo_sequence + parsed.records.length,
    last_record_digest: parsed.last_record_digest,
    task_sequences: parsed.task_sequences,
    recovered_tail: recoveredTail,
    cursor: nextCursor,
    source_cursor: parsed.records.length
      ? makeSourceCursor(parsed.records.at(-1), validEndOffset)
      : makeSourceCursor(sourceRecord, cursor.valid_end_offset),
  };
}

function auditEventStore(repo) {
  try {
    const replay = readEventStore(repo);
    return {
      valid: true,
      record_count: replay.records.length,
      event_count: replay.events.length,
      valid_end_offset: replay.valid_end_offset,
      last_repo_sequence: replay.records.at(-1)?.repo_sequence ?? 0,
      last_record_digest: replay.last_record_digest,
      recovered_tail: replay.recovered_tail,
      error: null,
    };
  } catch (error) {
    return {
      valid: false,
      record_count: 0,
      event_count: 0,
      valid_end_offset: 0,
      last_repo_sequence: 0,
      last_record_digest: null,
      recovered_tail: null,
      error: { code: error?.code ?? "EVENT_STORE_AUDIT_FAILED", message: error?.message ?? String(error) },
    };
  }
}

export {
  auditEventStore,
  buildRecord,
  commitRecord,
  eventStoreNameState,
  eventStorePath,
  makeSourceCursor,
  migrateLegacyEventStoreName,
  readEventStore,
  readEventStoreTail,
  syncDirectory,
  verifyEventStoreSourceCursor,
  WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED,
  validateRecord,
};
