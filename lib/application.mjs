import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  CRITERION_TIMEOUT_SECONDS,
  RUNTIME_CONTRACT,
  STATE_DIR,
  EVENT_STORE_FILE,
  OUTCOME_PROJECTION_FILE,
  V3_EVENT_RECORD_SCHEMA_VERSION,
  V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  V3_TASK_SNAPSHOT_SCHEMA_VERSION,
  fnv1aHex,
  isPlainObject,
  localTimestamp,
  sha256Hex,
  utcTimestamp,
  outputTail,
  repoRelative,
} from "./prims.mjs";
import { criterionDrift, criterionMetadata, resolveCriterionFile, resolveSubject, runCriterionSource } from "./criterion.mjs";
import { buildRecord, commitRecord, eventStorePath, readEventStore, readEventStoreTail, verifyEventStoreSourceCursor } from "./event-store.mjs";
import { commandSafetyFailure, commandValues, controlPlaneWriteFailure, envelopeDirty, envelopeOverlap, foreignWriteDecision, gitOps, insideEnvelope, joinedFileOffender, joinedFilesMessage, looksLikeWrite, siblingWorktreeOpenTasks, warnZeroMatchEnvelope, writeFileTargets } from "./supervision.mjs";
import { assertV3TaskProjection, closureProjection, constructAssurance, constructPolicy, criterionDefinitionHash, decide, evolveAll, machineRiskFloor, policyName, projectBudgetExhaustion, projectProofAssurance, projectReviewRequirement, validateAssurance } from "./task-engine.mjs";
import { archiveIncompatibleState, buildTaskSnapshot, inspectTaskSnapshot, quarantineDamagedTaskSnapshot, saveTaskSnapshot, taskPath, withTaskLock } from "./task-store.mjs";
import { auditOutcomeProjection, syncOutcomeRecords } from "./outcome-projector.mjs";
import { clearUntracked, observeUntracked } from "./untracked.mjs";

const OPTION = { type: "string" };
const BOOL = { type: "boolean" };
const ASSURANCE_OPTIONS = { risk: OPTION, "risk-reason": OPTION, "change-class": { type: "string", multiple: true }, "review-policy": OPTION, "required-review-level": OPTION, "review-waiver-reason": OPTION };
const BUDGET_DIMENSION_PRESENTATION = Object.freeze({
  rounds: Object.freeze({ label: "round", option: "--rounds", denial: ({ spent, limit }) => `round budget exhausted (${spent}/${limit}); reads and verification remain free` }),
  writes: Object.freeze({ label: "write", option: "--writes", denial: ({ spent, limit }) => `write budget exhausted (${spent}/${limit}); reads and verification remain free` }),
  wall_clock: Object.freeze({ label: "wall-clock", option: "--wall-clock-minutes", denial: ({ limit }) => `wall-clock budget exhausted (${limit / 60_000}m)` }),
  output_tokens: Object.freeze({ label: "output-token", option: "--token-budget", denial: ({ spent, limit }) => `output-token budget exhausted (${spent}/${limit})` }),
});
const HOOK_TASK_STATE_ERROR_CODES = new Set([
  "TASKLOCK_TIMEOUT",
  "CORRUPT_EVENT_AUTHORITY",
  "LEGACY_STATE_UNSUPPORTED",
  "ORPHAN_V3_SNAPSHOT",
  "MIXED_OR_INVALID_AUTHORITY",
  "INCOMPATIBLE_TASK_SNAPSHOT",
]);
const OPTIONS = {
  open: { repo: OPTION, goal: OPTION, criterion: OPTION, "criterion-file": OPTION, "criterion-protocol": OPTION, "criterion-policy": OPTION, reason: OPTION, "alignment-because": OPTION, "not-covered": { type: "string", multiple: true }, files: { type: "string", multiple: true }, "criterion-subject": { type: "string", multiple: true }, ...ASSURANCE_OPTIONS, rounds: OPTION, writes: OPTION, "wall-clock-minutes": OPTION, "token-budget": OPTION, "criterion-timeout-seconds": OPTION, "git-allowed": { type: "string", multiple: true }, "git-reason": OPTION, "destructive-allowed": BOOL, "network-allowed": BOOL, "install-scripts-allowed": BOOL, "publish-allowed": BOOL, "granted-by": OPTION },
  status: { repo: OPTION }, verify: { repo: OPTION }, achieve: { repo: OPTION }, report: { repo: OPTION, json: BOOL, markdown: BOOL },
  "accept-proof-gap": { repo: OPTION, reason: OPTION, "granted-by": OPTION },
  "not-needed": { repo: OPTION, evidence: OPTION }, abandon: { repo: OPTION, reason: OPTION },
  suspend: { repo: OPTION, reason: OPTION, remaining: OPTION, failure: OPTION, "next-action": OPTION },
  resume: { repo: OPTION, reason: OPTION },
  join: { repo: OPTION, reason: OPTION },
  review: { repo: OPTION, level: OPTION, reviewer: OPTION, "blocking-findings": OPTION, "advisory-findings": OPTION },
  amend: { repo: OPTION, reason: OPTION, goal: OPTION, criterion: OPTION, "criterion-file": OPTION, "criterion-protocol": OPTION, "criterion-policy": OPTION, "alignment-because": OPTION, "not-covered": { type: "string", multiple: true }, files: { type: "string", multiple: true }, "criterion-subject": { type: "string", multiple: true }, ...ASSURANCE_OPTIONS, rounds: OPTION, writes: OPTION, "wall-clock-minutes": OPTION, "token-budget": OPTION, "git-allowed": { type: "string", multiple: true }, "git-reason": OPTION, "destructive-allowed": BOOL, "network-allowed": BOOL, "install-scripts-allowed": BOOL, "publish-allowed": BOOL, "granted-by": OPTION },
  "archive-incompatible-state": { repo: OPTION, reason: OPTION, "granted-by": OPTION },
  audit: { repo: OPTION }, "sync-outcomes": { repo: OPTION }, "audit-outcomes": {}, info: {}, hooks: {}, help: {},
};

function now() { return utcTimestamp(Date.now()); }
function contractDescriptor() {
  return {
    runtime_contract: RUNTIME_CONTRACT,
    task_snapshot_schema_version: V3_TASK_SNAPSHOT_SCHEMA_VERSION,
    event_record_schema_version: V3_EVENT_RECORD_SCHEMA_VERSION,
    outcome_projection_schema_version: V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  };
}
function normalizedIdentity(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function hostSessionId() {
  return normalizedIdentity(process.env.TASKLOOP_SESSION_ID)
    ?? normalizedIdentity(process.env.CLAUDE_CODE_SESSION_ID)
    ?? "cli";
}
function payloadSessionId(payload) {
  return normalizedIdentity(payload.session_id);
}
function taskOwnerSessionId(task) {
  const value = normalizedIdentity(task?.episodes?.at(-1)?.host_session_id);
  return value && value !== "cli" ? value : null;
}
function isForeignSession(task, sessionId) {
  const owner = taskOwnerSessionId(task);
  return Boolean(owner && sessionId && owner !== sessionId);
}
function recordOwnerHookContact(task, sessionId, at) {
  const episodeId = normalizedIdentity(task?.episodes?.at(-1)?.episode_id);
  if (!episodeId || taskOwnerSessionId(task) !== sessionId) return task;
  task.last_observed_owner_hook_contact = { episode_id: episodeId, at };
  return task;
}
function repoOf(value) { return path.resolve(value?.repo ?? "."); }
function error(message) { process.stderr.write(`taskloop: ${message}\n`); return 2; }
function deny(message) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `taskloop: ${message}` } }) + "\n");
  return 0;
}
function isSafeHookSessionId(value) { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value); }
function taskloopInvocation(command, tool) {
  if (!/^(?:bash|powershell)$/i.test(tool)) return null;
  let invocation = command.trim(); let explicit = null;
  const prefix = /powershell/i.test(tool)
    ? invocation.match(/^\$env:TASKLOOP_SESSION_ID\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9._:-]+))\s*;\s*/i)
    : invocation.match(/^(?:export\s+)?TASKLOOP_SESSION_ID\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9._:-]+))\s+/i);
  if (prefix) { explicit = prefix[1] ?? prefix[2] ?? prefix[3]; invocation = invocation.slice(prefix[0].length); }
  if (/[;&|`\n\r]/.test(invocation) || invocation.includes("$(")) return null;
  const executable = /^(?:(?:[^\s]+\/)?node(?:\.exe)?\s+(?:"[^"\n]*taskloop\.mjs"|'[^'\n]*taskloop\.mjs'|[^\s]*taskloop\.mjs)|(?:[^\s]+\/)?taskloop)(?=\s|$)/i;
  return executable.test(invocation) ? { explicit } : null;
}
function allowTaskloopCommand(payload, mapping, tool) {
  const commands = commandValues(mapping);
  if (commands.length !== 1) return 0;
  const invocation = taskloopInvocation(commands[0], tool);
  if (!invocation) return 0;
  const sessionId = payloadSessionId(payload);
  if (!isSafeHookSessionId(sessionId)) return 0;
  if (invocation.explicit !== null) return invocation.explicit === sessionId ? 0 : deny("TASKLOOP_SESSION_ID conflicts with the Codex hook session_id");
  const assignment = /powershell/i.test(tool)
    ? `$env:TASKLOOP_SESSION_ID='${sessionId}'; `
    : `export TASKLOOP_SESSION_ID='${sessionId}'; `;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...mapping, command: assignment + commands[0] } } }) + "\n");
  return 0;
}
function block(message) { process.stdout.write(JSON.stringify({ decision: "block", reason: `taskloop: ${message}` }) + "\n"); return 0; }

function parseInteger(value, name, { minimum = 0, nullable = true } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

function grantProvenance(value) {
  const grantedBy = String(value ?? "self").trim() || "self";
  if (!new Set(["self", "user"]).has(grantedBy)) throw new Error('--granted-by must be "self" or "user"');
  return grantedBy;
}

function grant(kind, scope, reason, grantedBy, revision) {
  const why = String(reason ?? "").trim();
  if (!why) throw new Error(`${kind} grant requires a reason`);
  return { grant_id: randomUUID(), kind, scope: [...new Set(scope.map(String))], reason: why, granted_by: grantedBy, granted_at_task_revision: revision };
}

function authorityFrom(values, revision, fallbackReason = null) {
  const grantedBy = grantProvenance(values["granted-by"]);
  const reason = String(values.reason ?? fallbackReason ?? "").trim();
  const git = (values["git-allowed"] ?? []).map((op) => String(op).toLowerCase()).filter(Boolean);
  if (git.length && !String(values["git-reason"] ?? "").trim()) throw new Error("--git-reason is required with --git-allowed");
  const grants = [];
  if (git.length) grants.push(grant("git", git, values["git-reason"], grantedBy, revision));
  if (values["destructive-allowed"]) grants.push(grant("destructive", ["commands"], reason, grantedBy, revision));
  if (values["network-allowed"]) grants.push(grant("network", ["commands"], reason, grantedBy, revision));
  if (values["install-scripts-allowed"]) grants.push(grant("install", ["commands"], reason, grantedBy, revision));
  if (values["publish-allowed"]) grants.push(grant("publish", ["commands"], reason, grantedBy, revision));
  return { git, destructive: Boolean(values["destructive-allowed"]), network: Boolean(values["network-allowed"]), grants };
}

function assuranceFrom(values, current = null) {
  const next = current ? structuredClone(current) : constructAssurance();
  if (values.risk !== undefined) { next.declared_risk = String(values.risk).replaceAll("-", "_"); next.risk_declared_by = grantProvenance(values["granted-by"]); }
  if (values["risk-reason"] !== undefined) next.risk_reason = String(values["risk-reason"]);
  if (values["change-class"] !== undefined) next.change_classes = [...new Set(values["change-class"].map((item) => String(item).replaceAll("-", "_")))];
  if (values["review-policy"] !== undefined) next.review_policy = String(values["review-policy"]).replaceAll("-", "_");
  if (values["required-review-level"] !== undefined) next.required_review_level = String(values["required-review-level"]).replaceAll("-", "_");
  if (values["review-waiver-reason"] !== undefined) { next.review_waiver_reason = String(values["review-waiver-reason"]); next.review_waiver_granted_by = grantProvenance(values["granted-by"]); }
  return validateAssurance(next);
}

function sourceFrom(values, repo, fallback = null) {
  const haveCommand = values.criterion !== undefined;
  const haveFile = values["criterion-file"] !== undefined;
  if (haveCommand === haveFile) {
    if (fallback) return fallback;
    throw new Error("provide exactly one of --criterion or --criterion-file");
  }
  return haveFile ? { kind: "file", value: resolveCriterionFile(repo, values["criterion-file"]) } : { kind: "command", value: String(values.criterion) };
}

function repoIdentity(repo) { return `sha256:${createHash("sha256").update(path.resolve(repo)).digest("hex")}`; }

function warnEnvelopeRisks(repo, files) {
  warnZeroMatchEnvelope(repo, files);
  if (envelopeDirty(repo, files)) process.stderr.write("warning: envelope already contains dirty files; pre-existing edits are not attributed to this task\n");
  for (const sibling of siblingWorktreeOpenTasks(repo, { validateV3Projection: assertV3TaskProjection })) {
    const overlap = envelopeOverlap(files, sibling.files, repo, sibling.path);
    if (overlap) process.stderr.write(`warning: ${overlap.level} envelope overlap with open task in ${sibling.path}: ${overlap.patterns.join(", ")}\n`);
  }
}

function transcriptTokens(row) {
  const value = row?.message?.usage?.output_tokens ?? row?.usage?.output_tokens ?? row?.output_tokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function transcriptAnchor(bytes, offset) {
  return sha256Hex(bytes.subarray(Math.max(0, offset - 64), offset));
}

function transcriptRange(task, transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return null;
  const absolute = path.resolve(transcriptPath);
  let bytes;
  try { bytes = fs.readFileSync(absolute); } catch { return null; }
  const completeEnd = bytes.lastIndexOf(0x0a) + 1;
  const episode = task.episodes.at(-1);
  const episodeId = normalizedIdentity(episode?.episode_id);
  if (!episodeId) return null;
  const sourceId = sha256Hex(absolute);
  const cursor = task.transcript_cursors?.[sourceId] ?? null;
  const continuing = cursor?.episode_id === episodeId && cursor.offset <= completeEnd && transcriptAnchor(bytes, cursor.offset) === cursor.end_anchor_sha256;
  if (!continuing) {
    return {
      source_id: sourceId,
      source_generation_id: randomUUID(),
      episode_id: episodeId,
      from_offset: 0,
      to_offset: completeEnd,
      range_sha256: sha256Hex(bytes.subarray(0, completeEnd)),
      end_anchor_sha256: transcriptAnchor(bytes, completeEnd),
      output_tokens_delta: 0,
      mode: "baseline",
    };
  }
  if (completeEnd <= cursor.offset) return null;
  let delta = 0;
  for (const line of bytes.subarray(cursor.offset, completeEnd).toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { delta += transcriptTokens(JSON.parse(line)); } catch { /* corrupt complete rows carry no tokens */ }
  }
  return {
    source_id: sourceId,
    source_generation_id: cursor.source_generation_id,
    episode_id: episodeId,
    from_offset: cursor.offset,
    to_offset: completeEnd,
    range_sha256: sha256Hex(bytes.subarray(cursor.offset, completeEnd)),
    end_anchor_sha256: transcriptAnchor(bytes, completeEnd),
    output_tokens_delta: delta,
    mode: "increment",
  };
}

function assuranceNextActions(task, { drift = false } = {}) {
  const actions = [];
  if (projectProofAssurance(task, { drift }).state === "gap") actions.push("strengthen criterion or accept-proof-gap --reason R --granted-by user|self");
  const review = projectReviewRequirement(task);
  if (!review.accepted) actions.push(`obtain and record ${review.level.replaceAll("_", "-")} review with zero blocking findings`);
  return actions;
}

// Runtime-contract-4 snapshot recovery. The event stream is always authority;
// this helper may refresh or rebuild only the disposable projection.
function recoverV3TaskSnapshotFromReplay(repo, replay, { eventFsOps = fs, snapshotFsOps = fs, onSnapshotSeam = null, recoveryEpochMs = Date.now(), recoverTail = false } = {}) {
  const inspected = inspectTaskSnapshot(repo, { fsOps: snapshotFsOps, validateProjection: assertV3TaskProjection });
  if (inspected.status === "valid") {
    try { assertV3TaskProjection(inspected.snapshot.projection); }
    catch (error) {
      throw Object.assign(new Error("task snapshot conflicts with schema-v3 event authority; archive only the incompatible snapshot"), { code: "MIXED_OR_INVALID_AUTHORITY", cause: error });
    }
    let verified;
    try { verified = verifyEventStoreSourceCursor(repo, inspected.snapshot.source_cursor, { fsOps: eventFsOps }); }
    catch (error) {
      throw Object.assign(new Error("task snapshot conflicts with schema-v3 event authority; archive only the incompatible snapshot"), { code: "MIXED_OR_INVALID_AUTHORITY", cause: error });
    }
    if (
      verified.event.task_id !== inspected.snapshot.projection.task_id ||
      verified.event.task_event_sequence !== inspected.snapshot.projection.task_event_sequence
    ) throw Object.assign(new Error("task snapshot conflicts with schema-v3 event authority; archive only the incompatible snapshot"), { code: "MIXED_OR_INVALID_AUTHORITY" });
    if (inspected.snapshot.source_cursor.valid_end_offset === replay.valid_end_offset) {
      return {
        status: "current", reason: "snapshot_current", projection: inspected.snapshot.projection,
        source_cursor: inspected.snapshot.source_cursor, snapshot: inspected.snapshot,
        snapshot_saved: false, warning: null,
      };
    }
    const tail = readEventStoreTail(repo, verified.cursor, { fsOps: eventFsOps, recoveryEpochMs, recoverTornTail: recoverTail });
    const projection = evolveAll(inspected.snapshot.projection, tail.events);
    const snapshot = buildTaskSnapshot({ sourceCursor: tail.source_cursor, projection, validateProjection: assertV3TaskProjection });
    let snapshotSaved = false;
    let warning = null;
    try {
      saveTaskSnapshot(repo, snapshot, { fsOps: snapshotFsOps, onSeam: onSnapshotSeam, validateProjection: assertV3TaskProjection });
      snapshotSaved = true;
    } catch (error) {
      warning = `schema-v3 event transaction is committed but snapshot refresh failed: ${error?.message ?? error}`;
    }
    return {
      status: "replayed", reason: "snapshot_behind", projection, source_cursor: tail.source_cursor,
      snapshot, snapshot_saved: snapshotSaved, warning,
    };
  }
  if (!new Set(["missing", "damaged"]).has(inspected.status)) {
    throw Object.assign(new Error("task snapshot conflicts with schema-v3 event authority; archive only the incompatible snapshot"), { code: "MIXED_OR_INVALID_AUTHORITY" });
  }
  let diagnostic = null;
  let warning = null;
  if (inspected.status === "damaged") {
    try {
      diagnostic = quarantineDamagedTaskSnapshot(repo, { reason: inspected.reason, fsOps: snapshotFsOps, atEpochMs: recoveryEpochMs });
    } catch (error) {
      warning = `schema-v3 snapshot diagnostic quarantine failed: ${error?.message ?? error}`;
    }
  }
  const projection = evolveAll(null, replay.events);
  const snapshot = buildTaskSnapshot({ sourceCursor: replay.source_cursor, projection, validateProjection: assertV3TaskProjection });
  let snapshotSaved = false;
  try {
    saveTaskSnapshot(repo, snapshot, { fsOps: snapshotFsOps, onSeam: onSnapshotSeam, validateProjection: assertV3TaskProjection });
    snapshotSaved = true;
  } catch (error) {
    const refreshWarning = `schema-v3 event transaction is committed but snapshot refresh failed: ${error?.message ?? error}`;
    warning = warning ? `${warning}; ${refreshWarning}` : refreshWarning;
  }
  return {
    status: "rebuilt",
    reason: inspected.status === "missing" ? "missing" : inspected.reason,
    projection,
    source_cursor: replay.source_cursor,
    snapshot,
    snapshot_saved: snapshotSaved,
    warning,
    diagnostic,
  };
}

function recoverV3TaskSnapshot(repo, { eventFsOps = fs, snapshotFsOps = fs, onSnapshotSeam = null, recoveryEpochMs = Date.now(), recoverTail = false } = {}) {
  let replay;
  try { replay = readEventStore(repo, { fsOps: eventFsOps, recoveryEpochMs, recoverTornTail: recoverTail }); }
  catch (error) {
    throw Object.assign(new Error("schema-v3 event authority is corrupt; refusing snapshot fallback"), { code: "CORRUPT_EVENT_AUTHORITY", cause: error });
  }
  return recoverV3TaskSnapshotFromReplay(repo, replay, { eventFsOps, snapshotFsOps, onSnapshotSeam, recoveryEpochMs, recoverTail });
}

function authorityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function loadV3Authority(repo, { allowEmpty = true, recoverTail = false } = {}) {
  if (!fs.existsSync(eventStorePath(repo))) {
    const inspected = inspectTaskSnapshot(repo, { validateProjection: assertV3TaskProjection });
    if (inspected.status === "missing") {
      if (allowEmpty) return { status: "empty", projection: null, replay: null };
      throw authorityError("NO_TASK", "no task");
    }
    if (inspected.status === "incompatible" && inspected.schema_version === 2) {
      throw authorityError("LEGACY_STATE_UNSUPPORTED", "legacy schema-2 task state is unsupported; archive it with explicit user authorization");
    }
    if (inspected.status === "valid") {
      throw authorityError("ORPHAN_V3_SNAPSHOT", "orphan schema-v3 snapshot has no event authority; archive it with explicit user authorization");
    }
    throw authorityError("ORPHAN_V3_SNAPSHOT", "task snapshot exists without a valid schema-v3 event authority; archive it with explicit user authorization");
  }
  let replay;
  try { replay = readEventStore(repo, { recoverTornTail: recoverTail }); }
  catch (cause) {
    throw authorityError("CORRUPT_EVENT_AUTHORITY", `schema-v3 event authority is corrupt: ${cause?.message ?? cause}`);
  }
  const recovered = recoverV3TaskSnapshotFromReplay(repo, replay, { recoverTail });
  if (recovered.warning) process.stderr.write(`warning: ${recovered.warning}\n`);
  return { status: "event_authority", projection: recovered.projection, replay };
}

function sourceCursorFromCommit(record, commit) {
  const event = record.events.at(-1);
  return {
    event_store_file: EVENT_STORE_FILE,
    repo_sequence: record.repo_sequence,
    task_event_sequence: event.task_event_sequence,
    record_digest: record.record_digest,
    event_id: event.event_id,
    valid_end_offset: commit.cursor.valid_end_offset,
  };
}

function commitTaskCommand(repo, command, { actorKind = "cli", commandId = null, openNewTask = false, onEventSeam = null, onSnapshotSeam = null, authority = null } = {}) {
  // Every production caller holds the repo task lock. Recovery is destructive
  // only to an uncommitted tail, so it is enabled exclusively on this path.
  // A caller may reuse authority only while continuously holding that lock and
  // only if no external command or callback has run since it was loaded.
  const currentAuthority = authority ?? loadV3Authority(repo, { recoverTail: true });
  const current = openNewTask ? null : currentAuthority.projection;
  const outcome = decide(current, command);
  if (!outcome.events.length) return { ...outcome, projection: currentAuthority.projection, committed: false, warning: null };
  const replay = currentAuthority.replay;
  const taskSequences = replay?.task_sequences ?? {};
  const nextTaskSequences = { ...taskSequences };
  const sequenced = outcome.events.map((event) => ({
    ...event,
    task_event_sequence: (nextTaskSequences[event.task_id] = (nextTaskSequences[event.task_id] ?? 0) + 1),
  }));
  const occurredAtEpochMs = command.atEpochMs;
  if (!Number.isSafeInteger(occurredAtEpochMs) || utcTimestamp(occurredAtEpochMs) !== command.at) {
    throw new Error("schema-v3 command requires matching at and atEpochMs");
  }
  const record = buildRecord({
    transactionId: command.transactionId ?? randomUUID(),
    commandId,
    repoSequence: (replay?.last_repo_sequence ?? 0) + 1,
    occurredAtEpochMs,
    actor: { kind: actorKind, session_id: normalizedIdentity(command.actingSession) === "cli" ? null : normalizedIdentity(command.actingSession) },
    previousRecordDigest: replay?.last_record_digest ?? null,
    events: sequenced,
  });
  const committed = commitRecord(repo, record, { cursor: replay?.cursor ?? null, onSeam: onEventSeam });
  const persistedEvents = record.events.map((event) => ({ ...event, at: record.occurred_at, atEpochMs: record.occurred_at_epoch_ms }));
  const projection = evolveAll(current, persistedEvents);
  const sourceCursor = sourceCursorFromCommit(record, committed);
  const snapshot = buildTaskSnapshot({ sourceCursor, projection, validateProjection: assertV3TaskProjection });
  let warning = null;
  try { saveTaskSnapshot(repo, snapshot, { onSeam: onSnapshotSeam, validateProjection: assertV3TaskProjection }); }
  catch (cause) {
    warning = `schema-v3 event transaction is committed but snapshot refresh failed: ${cause?.message ?? cause}`;
    process.stderr.write(`warning: ${warning}\n`);
  }
  try { syncOutcomeRecords({ repoIdentity: repoIdentity(repo), records: [record], priorRecords: replay?.records ?? [], incremental: true }); }
  catch (cause) { process.stderr.write(`warning: outcome-v3 projection deferred: ${cause?.message ?? cause}\n`); }
  return { ...outcome, projection, committed: true, record, source_cursor: sourceCursor, warning };
}

function readTask(repo, { recoverTail = false } = {}) {
  const authority = loadV3Authority(repo, { recoverTail });
  return authority.projection;
}

function runObservation(task, repo) {
  const observation = runCriterionSource(task.criterion.source, repo, task.criterion.timeout_seconds, task.criterion.protocol);
  observation.criterion_generation_id = task.criterion.criterion_generation_id;
  observation.observed_artifact_revision = task.artifact_revision;
  return observation;
}

function cmdOpen(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const authorityState = loadV3Authority(repo, { recoverTail: true });
    const existing = authorityState.projection;
    if (existing && existing.lifecycle.state !== "terminal") return error("an active or suspended task already exists");
    const goal = String(values.goal ?? "").trim();
    const because = String(values["alignment-because"] ?? "").trim();
    const files = values.files ?? [];
    if (!goal || !because || !files.length) return error("open requires --goal, --alignment-because, and at least one --files");
    const joined = joinedFileOffender(files);
    if (joined) return error(joinedFilesMessage(joined));
    warnEnvelopeRisks(repo, files);
    const source = sourceFrom(values, repo);
    const protocol = values["criterion-protocol"] ?? "binary";
    if (!new Set(["binary", "tri-state"]).has(protocol)) return error("--criterion-protocol must be binary or tri-state");
    const cliPolicy = values["criterion-policy"] ?? "default";
    const internalPolicy = cliPolicy.replaceAll("-", "_");
    constructPolicy(internalPolicy);
    const timeout = parseInteger(values["criterion-timeout-seconds"], "criterion-timeout-seconds", { minimum: 1 }) ?? CRITERION_TIMEOUT_SECONDS;
    const subjects = (values["criterion-subject"] ?? []).map((item) => resolveSubject(repo, item));
    for (const subject of subjects) {
      if (!insideEnvelope(subject, files)) return error(`criterion subject is outside the envelope: ${subject}`);
      if (source.kind === "file" && subject === source.value) return error(`criterion subject cannot be the criterion file itself: ${subject}`);
    }
    const authority = authorityFrom(values, 1, goal);
    for (const subject of subjects) authority.grants.push(grant("criterion_subject", [subject], values.reason ?? "criterion subject declared at open", grantProvenance(values["granted-by"]), 1));
    if (files.some((pattern) => /^\*\*(?:\/\*)?$/.test(pattern))) authority.grants.push(grant("whole_repo", files.filter((pattern) => /^\*\*(?:\/\*)?$/.test(pattern)), values.reason ?? "whole-repository envelope declared at open", grantProvenance(values["granted-by"]), 1));
    const criterion = criterionMetadata({ source, protocol, timeoutSeconds: timeout, subjects, repo });
    criterion.criterion_definition_hash = criterionDefinitionHash(criterion);
    const observation = runCriterionSource(source, repo, timeout, protocol);
    if (observation.changed_paths.length) return error(`criterion has side effects: ${observation.changed_paths.join(", ")}`);
    observation.criterion_generation_id = criterion.criterion_generation_id;
    observation.observed_artifact_revision = 0;
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    observation.observed_at = at;
    const actingSession = hostSessionId();
    const taskId = randomUUID();
    let committed;
    try {
      committed = commitTaskCommand(repo, {
        type: "open", taskId, at, atEpochMs, actingSession,
        goal, criterion, observation, policyName: internalPolicy, policyRationale: values.reason ?? null,
        alignment: { because, not_covered: values["not-covered"] ?? [] },
        envelope: { files, git: authority.git, destructive: authority.destructive, network: authority.network },
        grants: authority.grants,
        assurance: assuranceFrom(values),
        budget: { rounds: parseInteger(values.rounds, "rounds", { minimum: 1 }) ?? 8, writes: parseInteger(values.writes, "writes"), wall_clock_minutes: parseInteger(values["wall-clock-minutes"], "wall-clock-minutes"), output_tokens: parseInteger(values["token-budget"], "token-budget") },
        episodes: [{ episode_id: randomUUID(), host_session_id: actingSession, started_at: at, ended_at: null, start_task_revision: 1, end_task_revision: null, output_tokens_estimate: 0 }],
      }, { openNewTask: true });
    } catch (err) { return error(err.message); }
    clearUntracked(repo);
    process.stdout.write(`taskloop: opened ${taskPath(repo)}; criterion ${observation.verdict}; policy ${cliPolicy}\n`);
    return 0;
  });
}

function formatClosure(closure) {
  if (!closure) return "null";
  if (closure.state === "held") return `held(${closure.reasons.join(",")})`;
  if (closure.state === "not_ready") return `not_ready(${closure.reason})`;
  return closure.state;
}

function cmdStatus(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
  const task = readTask(repo, { recoverTail: true });
  if (!task) return error("no task");
  const drift = criterionDrift(task.criterion, repo).length > 0;
  const closure = closureProjection(task, { drift });
  const owner = taskOwnerSessionId(task); const cliIdentity = hostSessionId(); const episodeId = normalizedIdentity(task.episodes.at(-1)?.episode_id);
  const contact = task.last_observed_owner_hook_contact?.episode_id === episodeId ? task.last_observed_owner_hook_contact : null;
  const bindingNextAction = task.lifecycle.state === "terminal" ? null : task.lifecycle.state === "suspended" ? "resume --reason R in the continuing host session" : owner && cliIdentity !== owner ? "taskloop join --reason R to continue this task; use a separate worktree for parallel work" : null;
  const sessionBinding = { bound: Boolean(owner), cli_identity_matches_owner: owner && cliIdentity !== "cli" ? cliIdentity === owner : null, last_observed_owner_hook_contact: contact, next_action: bindingNextAction };
  process.stdout.write(JSON.stringify({ ...contractDescriptor(), task_schema_version: task.schema_version, task_id: task.task_id, lifecycle: task.lifecycle, goal: task.goal, policy: task.policy, criterion: task.criterion, proof_assurance: projectProofAssurance(task, { drift }), review_requirement: projectReviewRequirement(task), machine_risk_floor: machineRiskFloor(task), next_actions: assuranceNextActions(task, { drift }), closure, alignment: task.alignment, assurance: task.assurance, budget: task.budget, spent: task.spent, artifact_revision: task.artifact_revision, last_substantive_task_revision: task.last_substantive_task_revision, session_binding: sessionBinding }, null, 2) + "\n");
  return 0;
  });
}

function reportBudgetLimit(value, suffix = "") {
  return value === null ? "unbounded" : `${value}${suffix}`;
}

function cmdReport(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
  const task = readTask(repo, { recoverTail: true });
  if (!task) return error("no task");
  if (values.json && values.markdown) return error("choose one of --json or --markdown");
  const atEpochMs = Date.now();
  const projectedWallClockMs = task.lifecycle.state === "terminal" ? task.spent.wall_clock_ms : Math.max(task.spent.wall_clock_ms, atEpochMs - Date.parse(task.created_at));
  const drift = criterionDrift(task.criterion, repo).length > 0;
  const closure = task.lifecycle.state === "active" ? closureProjection(task, { drift }) : null;
  const deviations = task.evidence.touched_files.filter((file) => !insideEnvelope(file, task.envelope.files));
  const payload = {
    ...contractDescriptor(),
    generated_at: localTimestamp(atEpochMs),
    generated_by: "taskloop report — machine transcription of task state, not testimony",
    task_id: task.task_id,
    lifecycle: task.lifecycle,
    closure,
    goal: task.goal,
    criterion: { source: task.criterion.source, protocol: task.criterion.protocol, policy: policyName(task.policy), criterion_generation_id: task.criterion.criterion_generation_id, provenance: task.criterion.provenance, input_coverage: task.criterion.input_coverage, witness: task.witness ?? null },
    proof_assurance: projectProofAssurance(task, { drift }),
    alignment: task.alignment,
    reviews: task.reviews,
    review_requirement: projectReviewRequirement(task),
    grants: task.grants.map((item) => ({ kind: item.kind, scope: item.scope, granted_by: item.granted_by, reason: item.reason })),
    envelope: task.envelope,
    touched_files: task.evidence.touched_files,
    envelope_deviations: deviations,
    assurance: task.assurance,
    machine_risk_floor: machineRiskFloor(task),
    budget: task.budget,
    spent: task.spent,
  };
  if (values.json) { process.stdout.write(JSON.stringify(payload, null, 2) + "\n"); return 0; }
  const lifecycleLabel = task.lifecycle.state + (task.lifecycle.outcome ? `(${task.lifecycle.outcome})` : task.lifecycle.reason ? `(${task.lifecycle.reason})` : "");
  const lines = [`# taskloop report — ${task.task_id}`, "", `_${payload.generated_by}; generated at ${payload.generated_at}_`, "", "## Outcome", "", `- lifecycle: ${lifecycleLabel}`];
  if (closure) lines.push(`- closure: ${closure.state}${closure.reason ? ` (${closure.reason})` : ""}${closure.reasons?.length ? ` (${closure.reasons.join(", ")})` : ""}`);
  lines.push("", "## Goal", "", task.goal, "", "## Criterion", "", `- source: \`${task.criterion.source.value}\``, `- policy: ${payload.criterion.policy}`, `- generation: ${task.criterion.criterion_generation_id}`, `- proof assurance: ${payload.proof_assurance.state}`);
  lines.push("", "## Alignment", "", `- because: ${task.alignment.because}`);
  for (const item of task.alignment.not_covered) lines.push(`- not covered: ${item}`);
  lines.push("", "## Reviews", "");
  if (!task.reviews.length) lines.push("- none recorded");
  for (const review of task.reviews) lines.push(`- ${review.level}${review.reviewer ? ` by ${review.reviewer}` : ""}: blocking ${review.blocking_findings_count ?? "?"}, advisory ${review.advisory_findings_count ?? "?"}`);
  lines.push("", "## Envelope and touched files", "", `- declared: ${task.envelope.files.join(", ")}`, `- touched: ${task.evidence.touched_files.length ? task.evidence.touched_files.join(", ") : "none recorded"}`, `- deviations: ${deviations.length ? deviations.join(", ") : "none"}`);
  lines.push("", "## Assurance", "", `- declared risk: ${task.assurance.declared_risk} (${task.assurance.risk_reason})`, `- machine risk floor: ${JSON.stringify(payload.machine_risk_floor)}`);
  for (const acceptance of task.assurance.proof_gap_acceptances ?? []) lines.push(`- accepted proof gap (${acceptance.granted_by}): ${acceptance.reason}`);
  lines.push("", "## Budget", "", `- rounds ${task.spent.rounds}/${task.budget.rounds}; writes ${task.spent.writes}/${reportBudgetLimit(task.budget.writes)}; wall clock ${Math.round(projectedWallClockMs / 1000)}s/${reportBudgetLimit(task.budget.wall_clock_minutes, "m")}; output tokens estimate ${task.spent.output_tokens_estimate}/${reportBudgetLimit(task.budget.output_tokens)} (best effort)`);
  if (task.lifecycle.state === "suspended") lines.push("", "## Judgment", "", `- remaining: ${task.lifecycle.judgment.remaining}`, `- failure: ${task.lifecycle.judgment.failure}`, `- next action: ${task.lifecycle.judgment.next_action}`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
  });
}

function cmdVerify(values) {
  const repo = repoOf(values);
  const task = withTaskLock(repo, () => readTask(repo, { recoverTail: true }));
  if (!task) return error("no task");
  const beforeArtifact = task.artifact_revision;
  const observation = runObservation(task, repo);
  let persisted = false;
  let afterArtifact = beforeArtifact;
  if (observation.execution.execution_error === "criterion_side_effect") {
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    observation.observed_at = at;
    const committed = withTaskLock(repo, () => {
      const current = readTask(repo, { recoverTail: true });
      if (!current || current.lifecycle.state === "terminal") return null;
      return commitTaskCommand(repo, { type: "criterion-side-effect", taskId: current.task_id, observation, actingSession: hostSessionId(), at, atEpochMs });
    });
    persisted = Boolean(committed?.committed);
    afterArtifact = committed?.projection?.artifact_revision ?? beforeArtifact;
  }
  process.stdout.write(JSON.stringify({ ...contractDescriptor(), observation, persisted, artifact_revision_before: beforeArtifact, artifact_revision_after: afterArtifact }) + "\n");
  return observation.verdict === "satisfied" ? 0 : observation.verdict === "unsatisfied" ? 1 : 2;
}

function closeAttempt(repo, { explicit, stop = false, sessionId = null, transcriptPath = null }) {
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return stop ? 0 : error("no task");
    if (task.lifecycle.state === "suspended") return stop ? 0 : error("task is suspended; resume first");
    if (task.lifecycle.state === "terminal") return 0;
    if (stop && isForeignSession(task, sessionId)) return 0;
    const range = stop ? transcriptRange(task, transcriptPath) : null;
    const observation = runObservation(task, repo);
    if (observation.execution.execution_error === "criterion_side_effect") {
      const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
      observation.observed_at = at;
      commitTaskCommand(repo, { type: "criterion-side-effect", taskId: task.task_id, observation, transcriptRange: range, actingSession: stop ? sessionId : hostSessionId(), at, atEpochMs }, { actorKind: stop ? "hook" : "cli" });
      const message = `criterion indeterminate; closure not_ready(criterion_indeterminate); criterion side effect: ${observation.changed_paths.join(", ")}`;
      return stop ? block(message) : error(message);
    }
    const drift = criterionDrift(task.criterion, repo);
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    observation.observed_at = at;
    const actingSession = stop ? sessionId : hostSessionId();
    const committed = commitTaskCommand(repo, {
      type: explicit ? "achieve" : "observe", taskId: task.task_id, source: explicit ? "achieve" : "stop",
      actingSession, observation, drift, transcriptRange: range,
      attemptId: observation.verdict === "unsatisfied" ? randomUUID() : null,
      signature: observation.verdict === "unsatisfied" ? fnv1aHex(observation.execution.output_tail) : null,
      failureSummary: outputTail(observation.execution.output_tail, 160), autoSuspend: true,
      remaining: `criterion must become satisfied: ${task.criterion.source.value}`,
      closeEpisode: true, at, atEpochMs,
    }, { actorKind: stop ? "hook" : "cli" });
    const next = committed.projection;
    if (committed.result.status === "suspended") {
      const judgment = committed.result.judgment ?? next.lifecycle.judgment;
      return stop ? block(`criterion unsatisfied; task suspended(${committed.result.reason}): ${judgment.failure}`) : error(`criterion unsatisfied; task suspended(${committed.result.reason}): ${judgment.failure}`);
    }
    if (next.lifecycle.state === "terminal") {
      const advisoryFindings = projectReviewRequirement(task).advisory_findings_count ?? 0;
      const waiver = next.assurance.review_policy === "waived" ? `; review waived: ${next.assurance.review_waiver_reason} (${next.assurance.review_waiver_granted_by})` : "";
      const closeout = `taskloop: terminal(achieved); criterion satisfied; advisory findings: ${advisoryFindings}${waiver}; not covered: ${(next.alignment.not_covered ?? []).join(", ") || "none"}\n`;
      if (stop) process.stderr.write(closeout); else process.stdout.write(closeout);
      return 0;
    }
    const closure = committed.result.closure ?? closureProjection(next, { drift: drift.length > 0 });
    const explicitSuffix = !explicit && next.policy.close_policy === "explicit" && observation.verdict === "satisfied" ? "; explicit achieve required" : "";
    const message = `criterion ${observation.verdict}; closure ${formatClosure(closure)}${explicitSuffix}${observation.execution.output_tail ? `; ${outputTail(observation.execution.output_tail, 300)}` : ""}`;
    return stop ? block(message) : error(message);
  });
}

function terminalCommand(values, type) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true }); if (!task) return error("no task");
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    let result;
    try { result = commitTaskCommand(repo, type === "not-needed" ? { type, taskId: task.task_id, evidence: values.evidence, actingSession: hostSessionId(), at, atEpochMs } : { type, taskId: task.task_id, reason: values.reason, actingSession: hostSessionId(), at, atEpochMs }); }
    catch (err) { return error(err.message); }
    const next = result.projection;
    process.stdout.write(`taskloop: terminal(${next.lifecycle.outcome})\n`); return 0;
  });
}

function cmdSuspend(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true }); if (!task) return error("no task");
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs); let next;
    const reason = String(values.reason ?? "").replaceAll("-", "_");
    try { next = commitTaskCommand(repo, { type: "suspend", taskId: task.task_id, reason, judgment: { remaining: values.remaining, failure: values.failure, next_action: values["next-action"] }, closeEpisode: true, source: "cli", actingSession: hostSessionId(), at, atEpochMs }).projection; }
    catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdResume(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true }); if (!task) return error("no task"); const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    let next; const episode = { episode_id: randomUUID(), host_session_id: hostSessionId(), started_at: at, ended_at: null, start_task_revision: task.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0 };
    try { next = commitTaskCommand(repo, { type: "resume", taskId: task.task_id, reason: values.reason, episode, actingSession: episode.host_session_id, at, atEpochMs }).projection; } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdJoin(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true }); if (!task) return error("no task");
    const sessionId = hostSessionId();
    if (sessionId === "cli") return error("join requires a real host identity; set TASKLOOP_SESSION_ID to the host payload-domain session id or run inside a host that exports one");
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    const episode = { episode_id: randomUUID(), host_session_id: sessionId, started_at: at, ended_at: null, start_task_revision: task.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0 };
    let next; try { next = commitTaskCommand(repo, { type: "join", taskId: task.task_id, reason: values.reason, episode, actingSession: sessionId, at, atEpochMs }).projection; } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdReview(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true }); if (!task) return error("no task"); const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    const level = String(values.level ?? "").replaceAll("-", "_");
    const record = { review_id: randomUUID(), criterion_generation_id: task.criterion.criterion_generation_id, reviewed_task_revision: task.last_substantive_task_revision, reviewed_artifact_revision: task.artifact_revision, level, reviewer: String(values.reviewer ?? "").trim(), blocking_findings_count: parseInteger(values["blocking-findings"], "blocking-findings", { minimum: 0, nullable: false }), advisory_findings_count: parseInteger(values["advisory-findings"], "advisory-findings", { minimum: 0, nullable: false }), reviewed_at: at, acting_session: normalizedIdentity(hostSessionId()) === "cli" ? null : hostSessionId() };
    if (!record.reviewer) return error("review requires --reviewer");
    let next; try { next = commitTaskCommand(repo, { type: "review", taskId: task.task_id, record, actingSession: hostSessionId(), at, atEpochMs }).projection; } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdAcceptProofGap(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true }); if (!task) return error("no task");
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs); const record = { acceptance_id: randomUUID(), reason: String(values.reason ?? "").trim(), granted_by: grantProvenance(values["granted-by"]), accepted_at: at, criterion_generation_id: task.criterion.criterion_generation_id, accepted_at_task_revision: task.task_revision + 1 };
    let next; try { next = commitTaskCommand(repo, { type: "accept-proof-gap", taskId: task.task_id, record, actingSession: hostSessionId(), at, atEpochMs }).projection; } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdAmend(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true }); if (!task) return error("no task");
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs); const event = { type: "amend", taskId: task.task_id, actingSession: hostSessionId(), reason: values.reason, at, atEpochMs };
    if (values.goal !== undefined) event.goal = values.goal;
    if (values["alignment-because"] !== undefined || values["not-covered"] !== undefined) event.alignment = { because: values["alignment-because"] ?? task.alignment.because, not_covered: values["not-covered"] ?? task.alignment.not_covered };
    const authority = authorityFrom(values, task.task_revision + 1, values.reason);
    const newFiles = values.files ?? [];
    const joined = joinedFileOffender(newFiles);
    if (joined) return error(joinedFilesMessage(joined));
    if (newFiles.length) warnEnvelopeRisks(repo, newFiles);
    if (newFiles.length || authority.git.length || authority.destructive || authority.network) event.envelope = {
      ...task.envelope,
      files: [...new Set([...task.envelope.files, ...newFiles])],
      git: [...new Set([...(task.envelope.git ?? []), ...authority.git])],
      destructive: Boolean(task.envelope.destructive || authority.destructive),
      network: Boolean(task.envelope.network || authority.network),
    };
    const newGrants = authority.grants;
    for (const pattern of newFiles.filter((item) => /^\*\*(?:\/\*)?$/.test(item))) newGrants.push(grant("whole_repo", [pattern], values.reason, grantProvenance(values["granted-by"]), task.task_revision + 1));
    if (values.rounds !== undefined) event.rounds = parseInteger(values.rounds, "rounds", { minimum: 1, nullable: false });
    if (values.writes !== undefined) event.writes = parseInteger(values.writes, "writes", { minimum: 0, nullable: false });
    if (values["wall-clock-minutes"] !== undefined) event.wallClockMinutes = parseInteger(values["wall-clock-minutes"], "wall-clock-minutes", { minimum: 0, nullable: false });
    if (values["token-budget"] !== undefined) event.outputTokens = parseInteger(values["token-budget"], "token-budget", { minimum: 0, nullable: false });
    if (["risk", "risk-reason", "change-class", "review-policy", "required-review-level", "review-waiver-reason"].some((key) => values[key] !== undefined)) event.assurance = assuranceFrom(values, task.assurance);
    const changesCriterion = values.criterion !== undefined || values["criterion-file"] !== undefined || values["criterion-protocol"] !== undefined || values["criterion-subject"] !== undefined;
    if (changesCriterion) {
      const source = sourceFrom(values, repo, task.criterion.source);
      const protocol = values["criterion-protocol"] ?? task.criterion.protocol;
      const subjects = values["criterion-subject"] ? values["criterion-subject"].map((item) => resolveSubject(repo, item)) : task.criterion.subjects;
      const effectiveFiles = event.envelope?.files ?? task.envelope.files;
      for (const subject of subjects) {
        if (!insideEnvelope(subject, effectiveFiles)) return error(`criterion subject is outside the envelope: ${subject}`);
        if (source.kind === "file" && subject === source.value) return error(`criterion subject cannot be the criterion file itself: ${subject}`);
      }
      event.criterion = criterionMetadata({ source, protocol, timeoutSeconds: task.criterion.timeout_seconds, subjects, repo });
      event.criterion.criterion_definition_hash = criterionDefinitionHash(event.criterion);
      for (const subject of subjects) newGrants.push(grant("criterion_subject", [subject], values.reason, grantProvenance(values["granted-by"]), task.task_revision + 1));
    }
    if (values["criterion-policy"] !== undefined) {
      event.policy = constructPolicy(values["criterion-policy"]);
      event.policyRationale = values.reason;
      if (!event.criterion) event.generationId = randomUUID();
    }
    if (changesCriterion || values["criterion-policy"] !== undefined) {
      event.assurance = event.assurance ?? assuranceFrom(values, task.assurance);
      event.assurance.risk_floor_events = [...new Set([...(event.assurance.risk_floor_events ?? []), ...(changesCriterion ? ["criterion_amend"] : []), ...(values["criterion-policy"] !== undefined ? ["policy_amend"] : [])])];
    }
    if (newGrants.length) event.grants = newGrants;
    let next; try { next = commitTaskCommand(repo, event).projection; } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdArchive(values) {
  const repo = repoOf(values);
  try { return withTaskLock(repo, () => {
    const receipt = archiveIncompatibleState(repo, { reason: values.reason, grantedBy: values["granted-by"], at: now() });
    if (fs.existsSync(eventStorePath(repo))) recoverV3TaskSnapshot(repo, { recoverTail: true });
    process.stdout.write(JSON.stringify(receipt) + "\n");
    return 0;
  }); }
  catch (err) { return error(err.message); }
}

function cmdAudit(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    let report;
    try {
      const authority = loadV3Authority(repo, { allowEmpty: false, recoverTail: true });
      const replay = authority.replay;
      report = {
        ...contractDescriptor(), valid: true, record_count: replay.records.length, event_count: replay.events.length,
        valid_end_offset: replay.valid_end_offset, last_repo_sequence: replay.last_repo_sequence,
        last_record_digest: replay.last_record_digest, recovered_tail: replay.recovered_tail, error: null,
      };
    } catch (error) {
      report = {
        ...contractDescriptor(), valid: false, record_count: 0, event_count: 0, valid_end_offset: 0,
        last_repo_sequence: 0, last_record_digest: null, recovered_tail: null,
        error: { code: error?.code ?? "EVENT_STORE_AUDIT_FAILED", message: error?.message ?? String(error) },
      };
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.valid ? 0 : 2;
  });
}
function cmdSyncOutcomes(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const authority = loadV3Authority(repo, { allowEmpty: false, recoverTail: true });
    const report = syncOutcomeRecords({ repoIdentity: repoIdentity(repo), records: authority.replay.records });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  });
}
function cmdAuditOutcomes() {
  const report = auditOutcomeProjection();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.valid ? 0 : 2;
}
function cmdInfo() { process.stdout.write(JSON.stringify({ name: "taskloop", ...contractDescriptor(), event_store: `.taskloop/${EVENT_STORE_FILE}`, outcome_projection: `~/.taskloop/${OUTCOME_PROJECTION_FILE}`, distribution_owner: "taskloop" }) + "\n"); return 0; }
function cmdHooks() {
  const script = path.resolve(process.argv[1] ?? "taskloop.mjs");
  const quotedScript = process.platform === "win32" ? `"${script}"` : JSON.stringify(script);
  const command = `node ${quotedScript}`;
  process.stdout.write(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command, timeout: 20 }] }], Stop: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 300 }] }] } }, null, 2) + "\n"); return 0;
}
function cmdHelp() { process.stdout.write(`taskloop — criterion-driven work supervisor\n\nopen --goal G (--criterion C|--criterion-file F) --criterion-policy default|deferred-witness|steady-satisfied --alignment-because B [--not-covered N] --files GLOB\n     [--risk routine|substantial|critical] [--risk-reason R] [--change-class CLASS]\n     [--review-policy risk-based|required|waived] [--required-review-level fresh-context|second-model] [--review-waiver-reason R]\n     [--rounds N] [--writes N] [--wall-clock-minutes N] [--token-budget N]\n     [--git-allowed OP --git-reason R] [--destructive-allowed] [--network-allowed] [--install-scripts-allowed] [--publish-allowed] [--granted-by self|user] --reason R\nstatus | verify | report [--json|--markdown] | achieve | accept-proof-gap --reason R --granted-by user|self | not-needed --evidence E | abandon --reason R\nsuspend --reason needs-input|stuck|out-of-budget --remaining R --failure F --next-action N\nresume --reason R | join --reason R | amend ... --reason R\nreview --level fresh-context|second-model|self-reread --reviewer ID --blocking-findings N --advisory-findings N\narchive-incompatible-state --reason R --granted-by user\naudit --repo PATH | sync-outcomes --repo PATH | audit-outcomes | info | hooks\n\ncriterion observations: unsatisfied | satisfied | indeterminate\nlifecycle: active | suspended(reason) | terminal(outcome)\n`); return 0; }

const HOOK_STDIN_WAIT = new Int32Array(new SharedArrayBuffer(4));

function readHookPayloadText({ timeoutMs = 5000 } = {}) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let count;
    try {
      count = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EINTR") continue;
      if ((error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK") && Date.now() < deadline) {
        Atomics.wait(HOOK_STDIN_WAIT, 0, 0, 5);
        continue;
      }
      throw error;
    }
    if (count === 0) return Buffer.concat(chunks).toString("utf8");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
}

function loadPayload() {
  try {
    const value = JSON.parse(readHookPayloadText());
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}
function payloadRepo(payload) { return path.resolve(payload.cwd ?? payload.tool_input?.cwd ?? process.cwd()); }

function hookPretool(payload, repo) {
  const mapping = payload.tool_input ?? {};
  const tool = String(payload.tool_name ?? "");
  const sessionId = payloadSessionId(payload);
  return withTaskLock(repo, () => {
    const authority = loadV3Authority(repo, { recoverTail: true });
    const current = authority.projection;
    if (!current) {
      const writeShaped = gitOps(mapping).length > 0 || looksLikeWrite(tool, mapping);
      const result = observeUntracked({ payload, sessionId, repo, writeShaped, writeTargets: writeFileTargets(tool, mapping), scriptPath: process.argv[1] ?? "taskloop.mjs" });
      if (result.kind === "deny") return deny(result.message.replace(/^taskloop:\s*/, ""));
      if (result.kind === "notice") process.stderr.write(result.message + "\n");
      return allowTaskloopCommand(payload, mapping, tool);
    }
    if (current.lifecycle.state === "terminal") return allowTaskloopCommand(payload, mapping, tool);
    const controlFailure = controlPlaneWriteFailure(repo, tool, mapping, process.env.HOME ?? process.env.USERPROFILE);
    if (controlFailure) return deny(controlFailure);
    if (isForeignSession(current, sessionId)) {
      const decision = foreignWriteDecision(repo, current, tool, mapping);
      if (decision.kind === "deny") return deny(decision.message);
      if (decision.kind === "untracked") {
        const result = observeUntracked({ payload, sessionId, foreign: true, repo, writeShaped: decision.writeShaped, writeTargets: decision.targets, scriptPath: process.argv[1] ?? "taskloop.mjs" });
        if (result.kind === "deny") return deny(result.message.replace(/^taskloop:\s*/, ""));
        if (result.kind === "notice") process.stderr.write(result.message + "\n");
      }
      return allowTaskloopCommand(payload, mapping, tool);
    }
    const range = transcriptRange(current, payload.transcript_path);
    const ops = gitOps(mapping);
    const writeShaped = ops.length > 0 || looksLikeWrite(tool, mapping);
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    const persistDeny = (reason) => {
      commitTaskCommand(repo, { type: "authorize-write", taskId: current.task_id, decision: "deny", reason, transcriptRange: range, actingSession: sessionId, at, atEpochMs }, { actorKind: "hook", authority });
      return deny(reason);
    };
    if (current.lifecycle.state === "suspended") {
      if (writeShaped) return persistDeny(`task suspended (${current.lifecycle.reason}); resume before writing`);
      if (range) commitTaskCommand(repo, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession: sessionId, at, atEpochMs }, { actorKind: "hook", authority });
      return allowTaskloopCommand(payload, mapping, tool);
    }
    const deniedGit = ops.filter((op) => !(current.envelope.git ?? []).includes(op));
    if (deniedGit.length) return persistDeny(`git operation(s) need envelope authorization: ${deniedGit.join(", ")}`);
    for (const command of commandValues(mapping)) {
      const failure = commandSafetyFailure(current, command);
      if (failure) return persistDeny(failure);
    }
    if (!writeShaped) {
      if (range) commitTaskCommand(repo, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession: sessionId, at, atEpochMs }, { actorKind: "hook", authority });
      return allowTaskloopCommand(payload, mapping, tool);
    }
    const budgetState = range
      ? evolveAll(current, decide(current, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession: sessionId, at, atEpochMs }).events)
      : current;
    const exhausted = projectBudgetExhaustion(budgetState, atEpochMs);
    if (exhausted.length) {
      const first = exhausted[0];
      return persistDeny(BUDGET_DIMENSION_PRESENTATION[first.dimension].denial(first));
    }
    const targets = writeFileTargets(tool, mapping).map((value) => repoRelative(repo, value)).filter(Boolean);
    for (const target of targets) if (!insideEnvelope(target, current.envelope.files)) return persistDeny(`write outside envelope: ${target}`);
    commitTaskCommand(repo, { type: "authorize-write", taskId: current.task_id, decision: "allow", reason: "", transcriptRange: range, files: targets.length ? targets : ["<command>"], actingSession: sessionId, at, atEpochMs }, { actorKind: "hook", authority });
    return allowTaskloopCommand(payload, mapping, tool);
  });
}

function hookStop(repo, payload) {
  const sessionId = payloadSessionId(payload);
  return closeAttempt(repo, { explicit: false, stop: true, sessionId, transcriptPath: payload.transcript_path });
}

function dispatchHook() {
  const payload = loadPayload(); const event = String(payload.hook_event_name ?? "").toLowerCase(); const repo = payloadRepo(payload);
  const mapping = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const writeShaped = gitOps(mapping).length > 0 || looksLikeWrite(String(payload.tool_name ?? ""), mapping);
  try { if (event === "pretooluse") return hookPretool(payload, repo); if (event === "stop") return hookStop(repo, payload); }
  catch (err) {
    if (HOOK_TASK_STATE_ERROR_CODES.has(err?.code)) {
      process.stderr.write(`${err.message}\n`);
      if (event === "pretooluse" && writeShaped) return deny("supervisor unavailable; refusing a write whose artifact revision cannot be recorded");
      if (event === "stop") return block("task state unavailable; refusing to adjudicate Stop");
      return 0;
    }
    process.stderr.write(`taskloop: supervisor error: ${err?.message ?? err}\n`);
    if (event === "pretooluse" && writeShaped) return deny("supervisor unavailable; refusing a write whose artifact revision cannot be recorded");
    if (event === "stop") return block("supervisor unavailable; refusing to adjudicate Stop");
    return 0;
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) return dispatchHook();
  const verb = ["--help", "-h"].includes(argv[0]) ? "help" : argv[0];
  if (!Object.hasOwn(OPTIONS, verb)) return error(`unknown command: ${verb}`);
  let values; try { ({ values } = parseArgs({ args: argv.slice(1), options: OPTIONS[verb], allowPositionals: false })); } catch (err) { return error(err.message); }
  try {
    if (verb === "help") return cmdHelp(); if (verb === "info") return cmdInfo(); if (verb === "hooks") return cmdHooks(); if (verb === "audit") return cmdAudit(values); if (verb === "sync-outcomes") return cmdSyncOutcomes(values); if (verb === "audit-outcomes") return cmdAuditOutcomes();
    if (verb === "open") return cmdOpen(values); if (verb === "status") return cmdStatus(values); if (verb === "verify") return cmdVerify(values); if (verb === "report") return cmdReport(values); if (verb === "achieve") return closeAttempt(repoOf(values), { explicit: true });
    if (verb === "accept-proof-gap") return cmdAcceptProofGap(values);
    if (verb === "not-needed" || verb === "abandon") return terminalCommand(values, verb); if (verb === "suspend") return cmdSuspend(values); if (verb === "resume") return cmdResume(values); if (verb === "join") return cmdJoin(values); if (verb === "review") return cmdReview(values); if (verb === "amend") return cmdAmend(values); return cmdArchive(values);
  } catch (err) { return error(err?.message ?? err); }
}

export { main, recoverV3TaskSnapshot };
