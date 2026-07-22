// Canonical task state model. This leaf is deliberately pure: application.mjs
// owns I/O, while every lifecycle mutation and closure decision lives here.

import {
  BUDGET_DIMENSIONS,
  DEFAULT_ROUNDS,
  EVENT_KINDS,
  NO_PROGRESS_STOPS,
  OBSERVATION_VERDICTS,
  STUCK_REPEATS,
  TERMINAL_OUTCOMES,
  VALID_SUSPEND_OUTCOMES,
  V3_EVENT_KINDS,
  V3_TASK_SNAPSHOT_SCHEMA_VERSION,
  artifactCheckpointId,
  cloneJson,
  hasExactKeys,
  isPlainObject,
  isSha256Digest,
  isSyntheticTouchedFile,
  isUuidV4,
  eventPayloadFields,
} from "./prims.mjs";
import { createHash } from "node:crypto";

const POLICY_PRESETS = Object.freeze({
  default: Object.freeze({
    open_requirement: "unsatisfied",
    witness_requirement: "required",
    close_policy: "automatic",
  }),
  deferred_witness: Object.freeze({
    open_requirement: "determinate",
    witness_requirement: "required",
    close_policy: "automatic",
  }),
  steady_satisfied: Object.freeze({
    open_requirement: "determinate",
    witness_requirement: "none",
    close_policy: "explicit",
  }),
});

const clone = cloneJson;

function policyName(value) {
  for (const [name, policy] of Object.entries(POLICY_PRESETS)) {
    if (
      value?.open_requirement === policy.open_requirement &&
      value?.witness_requirement === policy.witness_requirement &&
      value?.close_policy === policy.close_policy
    ) return name;
  }
  return null;
}

function constructPolicy(name) {
  const normalized = String(name ?? "default").replaceAll("-", "_");
  const policy = POLICY_PRESETS[normalized];
  if (!policy) throw new Error(`unknown criterion policy: ${name}`);
  return clone(policy);
}

function validatePolicy(policy) {
  const name = policyName(policy);
  if (!name) throw new Error("policy tuple is not a named schema-v2 policy");
  return name;
}

function criterionDefinitionHash(criterion) {
  const stable = JSON.stringify({
    source: criterion.source,
    authored_by: criterion.authored_by,
    protocol: criterion.protocol,
    timeout_seconds: criterion.timeout_seconds,
    declared_inputs: criterion.declared_inputs,
    subjects: criterion.subjects,
  });
  return `sha256:${createHash("sha256").update(stable).digest("hex")}`;
}

const RISK_ORDER = ["routine", "substantial", "critical"];
const REVIEW_ORDER = ["fresh_context", "second_model"];

function riskMax(a, b) {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))];
}

function constructAssurance(overrides = {}) {
  return {
    declared_risk: "substantial",
    risk_reason: "",
    risk_declared_by: "default",
    change_classes: ["internal"],
    review_policy: "risk_based",
    required_review_level: null,
    review_waiver_reason: null,
    review_waiver_granted_by: null,
    proof_gap_acceptances: [],
    risk_floor_events: [],
    ...clone(overrides),
  };
}

function projectProofAssurance(task, { drift = false } = {}) {
  const reasons = [];
  if ((task.assurance?.risk_floor_events ?? []).includes("criterion_amended_after_write")) reasons.push("criterion_amended_after_write");
  if ((task.assurance?.risk_floor_events ?? []).includes("policy_amended_after_write")) reasons.push("policy_amended_after_write");
  if (drift) reasons.push("criterion_input_drift");
  if (!reasons.length) return { state: "adequate", reasons: [], acceptance: null };
  const acceptance = !drift ? (task.assurance?.proof_gap_acceptances ?? []).find((row) =>
    row.criterion_generation_id === task.criterion.criterion_generation_id && String(row.reason ?? "").trim()
  ) ?? null : null;
  return { state: acceptance ? "provisional" : "gap", reasons, acceptance };
}

function machineRiskFloor(task) {
  // This floor prices observed use, not available grants. Sensor coverage lives
  // in the auxiliary ledger and cannot prove that authority was used; without
  // PreToolUse, declared risk and explicit review policy remain the controls.
  let risk = "routine";
  const reasons = [];
  if ((task.assurance?.proof_gap_acceptances ?? []).length) { risk = riskMax(risk, "substantial"); reasons.push("proof_gap_acceptance"); }
  for (const item of task.assurance?.risk_floor_events ?? []) {
    risk = riskMax(risk, "substantial"); reasons.push(item);
  }
  const touched = task.evidence?.touched_files ?? [];
  const authorityTargets = artifactEvidenceContract(task)
    ? Object.values(task.operations ?? {}).flatMap((operation) => operationEvidence(operation, task)?.declared_targets ?? [])
    : touched;
  const actualTouched = touched.filter((item) => !isSyntheticTouchedFile(item));
  const roots = new Set(actualTouched.map((item) => String(item).split("/")[0]).filter(Boolean));
  if (roots.size > 1) { risk = riskMax(risk, "substantial"); reasons.push("multiple_actual_write_roots"); }
  if (actualTouched.length > 10) { risk = riskMax(risk, "substantial"); reasons.push("many_touched_files"); }
  if (authorityTargets.includes("<command>")) { risk = riskMax(risk, "substantial"); reasons.push("unattributed_write"); }
  if (authorityTargets.includes("<command:publish>") || authorityTargets.includes("<command:git_push>")) { risk = "critical"; reasons.push("irreversible_authority_used"); }
  if (authorityTargets.includes("<command:destructive>")) { risk = riskMax(risk, "substantial"); reasons.push("destructive_command_used"); }
  if (taskRuntimeContract(task) === 7) {
    const intents = Object.values(task.operations ?? {}).map((operation) => operation.intent).filter(Boolean);
    const deviations = intents.flatMap((intent) => intent.policy_reasons ?? []);
    if (intents.some((intent) => intent.session_relation === "foreign")) { risk = riskMax(risk, "substantial"); reasons.push("foreign_session_intent"); }
    if (deviations.some((reason) => new Set(["control_plane", "host_approval_bypassed", "host_approval_unavailable"]).has(reason))) {
      risk = "critical"; reasons.push("host_authority_policy_deviation");
    } else if (deviations.some((reason) => new Set(["external_target", "outside_envelope", "safety_grant_missing", "git_grant_missing"]).has(reason))) {
      risk = riskMax(risk, "substantial"); reasons.push("host_authority_policy_deviation");
    }
  }
  return { risk, reasons: [...new Set(reasons)] };
}

function acceptedReview(task, level) {
  const minimum = REVIEW_ORDER.indexOf(level);
  return (task.reviews ?? []).find((review) =>
    review.criterion_generation_id === task.criterion.criterion_generation_id &&
    review.reviewed_task_revision === task.last_substantive_task_revision &&
    review.reviewed_artifact_revision === task.artifact_revision &&
    (!artifactEvidenceContract(task) || review.reviewed_evidence_revision === task.evidence.evidence_revision) &&
    REVIEW_ORDER.indexOf(review.level) >= minimum && review.blocking_findings_count === 0
  ) ?? null;
}

function projectReviewRequirement(task, { ignoreLifecycle = false } = {}) {
  if (!ignoreLifecycle && task.lifecycle?.state !== "active") return { level: null, reasons: ["lifecycle_not_active"], accepted: true, waived: false, applicable: false };
  const assurance = task.assurance;
  const floor = machineRiskFloor(task);
  if (assurance.review_policy === "waived" && floor.risk === "routine") return { level: null, reasons: ["review_waived"], accepted: true, waived: true };
  const effective = riskMax(assurance.declared_risk, floor.risk);
  let level = null;
  if (assurance.review_policy === "required") level = assurance.required_review_level;
  else if (effective === "substantial") level = "fresh_context";
  else if (effective === "critical") level = "second_model";
  const reasons = [];
  if (assurance.review_policy === "required") reasons.push("review_required");
  else if (assurance.declared_risk !== "routine") reasons.push(`declared_${assurance.declared_risk}`);
  reasons.push(...floor.reasons);
  if (!level) return { level: null, reasons: [], accepted: true, waived: false };
  const review = acceptedReview(task, level);
  return { level, reasons: [...new Set(reasons)], accepted: Boolean(review), waived: false, ...(review ? { advisory_findings_count: review.advisory_findings_count } : {}) };
}

function projectAssurance(task, options = {}) {
  const floor = machineRiskFloor(task);
  const declared = task.assurance.declared_risk;
  return {
    declared_risk: declared,
    effective_risk: riskMax(declared, floor.risk),
    risk_reason: task.assurance.risk_reason,
    risk_declared_by: task.assurance.risk_declared_by,
    policy: task.assurance.review_policy,
    review_waiver_reason: task.assurance.review_waiver_reason,
    review_waiver_granted_by: task.assurance.review_waiver_granted_by,
    proof: projectProofAssurance(task, options),
    review: projectReviewRequirement(task, options),
    floor,
  };
}

function artifactAssuranceHolds(task) {
  if (!artifactEvidenceContract(task)) return [];
  const holds = [];
  if (task.evidence.artifact_state_coverage !== "full") holds.push("artifact_state_unreconciled");
  if (task.evidence.current_scope_violations.length) holds.push("artifact_scope_violation");
  if (task.capability_leases.some((lease) => lease.status === "open")) holds.push("operation_receipt_pending");
  if (taskRuntimeContract(task) === 7 && task.spent.rounds > task.budget.rounds) holds.push("round_budget_exceeded");
  if (task.budget.writes !== null && operationEvidenceCount(task) > task.budget.writes) holds.push("write_budget_exceeded");
  if (taskRuntimeContract(task) === 7 && task.budget.wall_clock_minutes !== null && task.spent.wall_clock_ms > task.budget.wall_clock_minutes * 60_000) holds.push("wall_clock_budget_exceeded");
  if (taskRuntimeContract(task) === 7 && task.budget.output_tokens !== null && task.spent.output_tokens_estimate > task.budget.output_tokens) holds.push("output_token_budget_exceeded");
  if (task.history_requirement === "complete") {
    if (task.evidence.mutation_history_coverage !== "full") holds.push("mutation_history_incomplete");
    if (preExecutionCoverage(task) !== "full") holds.push(taskRuntimeContract(task) === 7 ? "pre_execution_observation_incomplete" : "prewrite_enforcement_incomplete");
  }
  return holds;
}

function hasSuccessfulCompletion(task) {
  return Object.values(task.operations ?? {}).some((operation) => operation?.completion?.outcome === "success");
}

function closureProjection(task, { drift = false } = {}) {
  if (task.lifecycle?.state !== "active") return null;
  const observation = task.criterion?.last_observation;
  if (!observation || observation.criterion_generation_id !== task.criterion.criterion_generation_id) {
    return { state: "not_ready", reason: "criterion_unobserved" };
  }
  if (observation.verdict === "unsatisfied") return { state: "not_ready", reason: "criterion_unsatisfied" };
  if (observation.verdict === "indeterminate") return { state: "not_ready", reason: "criterion_indeterminate" };
  const holds = [];
  if (artifactEvidenceContract(task) && (
    observation.observed_checkpoint_id !== task.artifact_checkpoint.checkpoint_id ||
    observation.observed_evidence_revision !== task.evidence.evidence_revision ||
    observation.observed_event_cursor !== task.task_event_sequence
  )) holds.push("artifact_evidence_changed");
  holds.push(...artifactAssuranceHolds(task));
  if (drift) holds.push("sensor_drift");
  if (
    task.policy.witness_requirement === "required" &&
    task.witness?.criterion_generation_id !== task.criterion.criterion_generation_id
  ) holds.push("unsatisfied_not_witnessed");
  if (projectProofAssurance(task, { drift }).state === "gap") holds.push("criterion_assurance_gap");
  if (!projectReviewRequirement(task).accepted) holds.push("change_review_unaccepted");
  return holds.length ? { state: "held", reasons: holds } : { state: "eligible" };
}

function nextRevision(task, { substantive = false, artifact = false } = {}) {
  task.task_revision += 1;
  if (artifact) task.artifact_revision += 1;
  if (substantive || artifact) task.last_substantive_task_revision = task.task_revision;
}

function projectBudgetExhaustion(task, atEpochMs) {
  if (!Number.isSafeInteger(atEpochMs) || atEpochMs < 0) throw new Error("budget projection requires a non-negative integer atEpochMs");
  const exhausted = [];
  if (task.spent.rounds >= task.budget.rounds) exhausted.push({ dimension: "rounds", spent: task.spent.rounds, limit: task.budget.rounds });
  if (task.budget.writes !== null && task.spent.writes >= task.budget.writes) exhausted.push({ dimension: "writes", spent: task.spent.writes, limit: task.budget.writes });
  if (task.budget.wall_clock_minutes !== null) {
    const createdAtMs = Date.parse(task.created_at);
    if (!Number.isFinite(createdAtMs)) throw new Error("budget projection requires a valid task.created_at");
    const spent = Math.max(task.spent.wall_clock_ms, atEpochMs - createdAtMs);
    const limit = task.budget.wall_clock_minutes * 60_000;
    if (spent >= limit) exhausted.push({ dimension: "wall_clock", spent, limit });
  }
  if (task.budget.output_tokens !== null && task.spent.output_tokens_estimate >= task.budget.output_tokens) {
    exhausted.push({ dimension: "output_tokens", spent: task.spent.output_tokens_estimate, limit: task.budget.output_tokens });
  }
  return exhausted;
}

const LIFECYCLE_EVENTS = new Set(["open", "suspend", "resume", "join", "achieve", "not_needed", "abandon"]);
const POLICY_DEVIATION_REASONS = new Set([
  "control_plane", "foreign_session", "suspended", "host_approval_unavailable", "host_approval_bypassed",
  "git_grant_missing", "safety_grant_missing", "budget_exhausted", "history_unavailable", "history_gap",
  "external_target", "outside_envelope",
]);
const V3_TASK_PROJECTION_FIELDS = [
  "schema_version", "task_id", "task_revision", "last_substantive_task_revision", "artifact_revision",
  "created_at", "updated_at", "lifecycle", "goal", "criterion", "policy", "policy_rationale", "witness",
  "alignment", "envelope", "grants", "assurance", "budget", "spent", "evidence", "reviews", "attempts",
  "unsatisfied_streak", "episodes", "lifecycle_log", "task_event_sequence", "transcript_cursors",
];
const CONTRACT6_TASK_PROJECTION_FIELDS = [
  ...V3_TASK_PROJECTION_FIELDS,
  "runtime_contract", "authority", "artifact_baseline", "artifact_checkpoint",
  "capability_leases", "coverage_intervals", "history_requirement", "operations",
];

function taskRuntimeContract(task) {
  return task?.runtime_contract ?? 5;
}

function artifactEvidenceContract(task) {
  return taskRuntimeContract(task) >= 6;
}

function operationEvidence(operation, task) {
  return taskRuntimeContract(task) === 7 ? operation?.intent ?? null : operation?.authorization ?? null;
}

function operationEvidenceCount(task) {
  return taskRuntimeContract(task) === 7 ? task.authority.operation_intents_observed : task.authority.write_operations_authorized;
}

function preExecutionCoverage(task) {
  return taskRuntimeContract(task) === 7 ? task.authority.pre_execution_observation : task.authority.prewrite_enforcement;
}

function setPreExecutionCoverage(task, value) {
  if (taskRuntimeContract(task) === 7) task.authority.pre_execution_observation = value;
  else task.authority.prewrite_enforcement = value;
}

function exactV3Object(value, fields, label) {
  if (!hasExactKeys(value, fields)) {
    throw new Error(`invalid schema-v3 ${label} fields`);
  }
  return value;
}

// Names a failing field so a rejected projection is diagnosable; the message
// keeps the `invalid schema-v3 <label>` prefix the callers and tests match on.
function v3Require(condition, label) {
  if (!condition) throw new Error(`invalid schema-v3 ${label}`);
}

const v3Uuid = isUuidV4;
const v3Digest = isSha256Digest;
function v3NonEmpty(value) { return typeof value === "string" && value.length > 0; }
function v3Integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function v3Utc(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function v3Nullable(value, predicate) { return value === null || predicate(value); }
function v3Array(value, predicate, { nonEmpty = false } = {}) { return Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every(predicate); }
function v3RepoPath(value) {
  if (!v3NonEmpty(value)) return false;
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) return false;
  let depth = 0;
  for (const part of portable.split("/")) {
    if (part === "..") { depth -= 1; if (depth < 0) return false; }
    else if (part && part !== ".") depth += 1;
  }
  return true;
}

// In-memory projection validation — one of the three deliberate schema
// definition sites (with prims V3_EVENT_PAYLOAD_FIELDS and event-store's
// persisted contracts); a schema change updates all three together. See
// AGENTS.md Conventions.
function assertV3Observation(value, { runtimeContract = 5 } = {}) {
  const fields = ["observation_id", "verdict", "criterion_generation_id", "observed_artifact_revision", "observed_at", "execution", "changed_paths"];
  if (runtimeContract >= 6) fields.push("observed_checkpoint_id", "observed_evidence_revision", "observed_event_cursor");
  exactV3Object(value, fields, "observation");
  v3Require(v3Uuid(value.observation_id), "observation observation_id");
  v3Require(OBSERVATION_VERDICTS.has(value.verdict), "observation verdict");
  v3Require(v3Nullable(value.criterion_generation_id, v3Uuid), "observation criterion_generation_id");
  v3Require(v3Nullable(value.observed_artifact_revision, (item) => v3Integer(item)), "observation observed_artifact_revision");
  v3Require(v3Utc(value.observed_at), "observation observed_at");
  v3Require(v3Array(value.changed_paths, v3RepoPath), "observation changed_paths");
  if (runtimeContract >= 6) {
    v3Require(v3Digest(value.observed_checkpoint_id), "observation observed_checkpoint_id");
    v3Require(v3Integer(value.observed_evidence_revision), "observation observed_evidence_revision");
    v3Require(v3Integer(value.observed_event_cursor, 1), "observation observed_event_cursor");
  }
  exactV3Object(value.execution, ["exit_code", "signal", "duration_ms", "execution_error", "output_tail", "timeout_seconds"], "observation execution");
  v3Require(v3Nullable(value.execution.exit_code, (item) => Number.isSafeInteger(item)), "observation execution exit_code");
  v3Require(v3Nullable(value.execution.signal, v3NonEmpty), "observation execution signal");
  v3Require(v3Integer(value.execution.duration_ms), "observation execution duration_ms");
  v3Require(v3Nullable(value.execution.execution_error, v3NonEmpty), "observation execution execution_error");
  v3Require(typeof value.execution.output_tail === "string" && Buffer.byteLength(value.execution.output_tail, "utf8") <= 4096, "observation execution output_tail");
  v3Require(v3Integer(value.execution.timeout_seconds, 1), "observation execution timeout_seconds");
}

function assertV3Criterion(value, { runtimeContract = 5 } = {}) {
  exactV3Object(value, ["source", "authored_by", "protocol", "timeout_seconds", "declared_inputs", "subjects", "criterion_definition_hash", "criterion_generation_id", "criterion_input_fingerprint", "input_coverage", "provenance", "last_observation"], "criterion");
  exactV3Object(value.source, ["kind", "value"], "criterion source");
  v3Require(new Set(["file", "command"]).has(value.source.kind), "criterion source kind");
  v3Require(v3NonEmpty(value.source.value), "criterion source value");
  v3Require(new Set(["self", "user"]).has(value.authored_by), "criterion authored_by");
  v3Require(new Set(["binary", "tri-state"]).has(value.protocol), "criterion protocol");
  v3Require(v3Integer(value.timeout_seconds, 1), "criterion timeout_seconds");
  v3Require(v3Digest(value.criterion_definition_hash), "criterion criterion_definition_hash");
  v3Require(v3Uuid(value.criterion_generation_id), "criterion criterion_generation_id");
  v3Require(v3Nullable(value.criterion_input_fingerprint, v3Digest), "criterion criterion_input_fingerprint");
  v3Require(new Set(["full", "unknown"]).has(value.input_coverage), "criterion input_coverage");
  v3Require(new Set(["repo", "state_dir", "unresolved"]).has(value.provenance), "criterion provenance");
  if (!v3Array(value.declared_inputs, (item) => {
    try { exactV3Object(item, ["path", "hash"], "declared input"); return v3RepoPath(item.path) && v3Digest(item.hash); } catch { return false; }
  }) || !v3Array(value.subjects, v3RepoPath)) throw new Error("invalid schema-v3 criterion inputs");
  if (value.last_observation !== null) assertV3Observation(value.last_observation, { runtimeContract });
}

function assertArtifactCheckpoint(value, label) {
  exactV3Object(value, ["checkpoint_id", "captured_at_ms", "entries"], label);
  v3Require(v3Digest(value.checkpoint_id), `${label} checkpoint_id`);
  v3Require(v3Integer(value.captured_at_ms), `${label} captured_at_ms`);
  v3Require(v3Array(value.entries, (entry) => {
    try {
      exactV3Object(entry, ["path", "kind", "hash"], `${label} entry`);
      return v3RepoPath(entry.path) && new Set(["file", "symlink"]).has(entry.kind) && v3Digest(entry.hash);
    } catch { return false; }
  }), `${label} entries`);
  const paths = value.entries.map((entry) => entry.path);
  v3Require(new Set(paths).size === paths.length && JSON.stringify(paths) === JSON.stringify([...paths].sort()), `${label} entry order`);
  v3Require(value.checkpoint_id === artifactCheckpointId(value.entries), `${label} digest`);
}

function assertHistoryRequirementInvariant(task) {
  if (!artifactEvidenceContract(task)) return;
  if (task.assurance.declared_risk === "critical" && task.history_requirement !== "complete") {
    throw new Error("critical task requires complete mutation history");
  }
  if (taskRuntimeContract(task) === 6 && task.budget.writes !== null && task.history_requirement !== "complete") {
    throw new Error("finite write budget requires complete mutation history");
  }
}

function assertWriteBudgetInvariant(task) {
  if (taskRuntimeContract(task) !== 6 || task.budget.writes === null) return;
  if (task.authority.write_operations_authorized > task.budget.writes) {
    throw new Error("write budget cannot be lower than already authorized operations");
  }
}

function assertFullMutationHistoryInvariant(task) {
  if (!artifactEvidenceContract(task) || task.evidence.mutation_history_coverage !== "full") return;
  if (task.episodes.length !== 1) throw new Error("full mutation history cannot span an episode boundary");
  if (Object.values(task.operations).some((operation) => operationEvidence(operation, task) === null && operation.completion !== null)) {
    throw new Error("full mutation history cannot coexist with an orphan completion receipt");
  }
  if (task.coverage_intervals.some((interval) => interval.mutation_history !== "full")) {
    throw new Error("full mutation history cannot coexist with a degraded coverage interval");
  }
  const currentEpisodeId = task.episodes.at(-1)?.episode_id ?? null;
  const intervals = task.coverage_intervals.filter((interval) => interval.episode_id === currentEpisodeId && (
    interval.mutation_history === "full" &&
    interval.artifact_state === "full" &&
    interval.prewrite_enforcement === "full" &&
    interval.exhaustive_surface === true &&
    interval.operation_id !== null &&
    interval.capability_id !== null
  ));
  if (!intervals.length) throw new Error("full mutation history requires an exhaustive operation-scoped capability lease");
  for (const interval of intervals) {
    const lease = task.capability_leases.find((candidate) => (
      candidate.episode_id === interval.episode_id &&
      candidate.operation_id === interval.operation_id &&
      candidate.capability_id === interval.capability_id &&
      candidate.host_profile === interval.host_profile &&
      candidate.surface === interval.surface &&
      candidate.exhaustive_surface === interval.exhaustive_surface &&
      candidate.effective_from_checkpoint === interval.effective_from_checkpoint &&
      interval.effective_from_checkpoint === interval.interval_from_checkpoint
    ));
    if (!lease || (interval.interval_to_checkpoint !== null && (
      lease.status !== "closed" || lease.closed_at_checkpoint !== interval.interval_to_checkpoint
    ))) throw new Error("full mutation history interval does not match its capability lease");
  }
  let cursor = task.artifact_baseline.checkpoint_id;
  let closedCount = 0;
  for (const interval of intervals.filter((item) => item.interval_to_checkpoint !== null)) {
    if (interval.interval_from_checkpoint !== cursor) throw new Error("full mutation history intervals are not a continuous baseline chain");
    cursor = interval.interval_to_checkpoint;
    closedCount += 1;
  }
  const openAtCurrent = intervals.some((interval) => interval.interval_to_checkpoint === null &&
    interval.interval_from_checkpoint === task.artifact_checkpoint.checkpoint_id &&
    task.capability_leases.some((lease) => lease.episode_id === interval.episode_id &&
      lease.operation_id === interval.operation_id && lease.capability_id === interval.capability_id &&
      lease.host_profile === interval.host_profile && lease.surface === interval.surface &&
      lease.exhaustive_surface === interval.exhaustive_surface &&
      lease.effective_from_checkpoint === interval.effective_from_checkpoint && lease.status === "open"));
  if (cursor !== task.artifact_checkpoint.checkpoint_id || (closedCount === 0 && !openAtCurrent)) {
    throw new Error("full mutation history does not cover baseline through the current checkpoint");
  }
}

function assertFullOperationReceiptInvariant(task) {
  if (!artifactEvidenceContract(task) || task.evidence.mutation_history_coverage !== "full") return;
  for (const interval of task.coverage_intervals.filter((item) => item.mutation_history === "full")) {
    const operation = task.operations[interval.operation_id];
    const evidence = operationEvidence(operation, task);
    if (!evidence || evidence.host_profile !== interval.host_profile ||
      (operation.completion !== null && operation.completion.host_profile !== interval.host_profile) ||
      (interval.interval_to_checkpoint !== null && operation.completion === null)) {
      throw new Error("full mutation history lease does not match its authorized operation receipts");
    }
  }
}

function invalidateEpisodeCoverage(task) {
  if (!artifactEvidenceContract(task)) return;
  const changed = task.evidence.mutation_history_coverage !== "unknown" || preExecutionCoverage(task) !== "unknown";
  task.evidence.mutation_history_coverage = "unknown";
  setPreExecutionCoverage(task, "unknown");
  if (changed) task.evidence.evidence_revision += 1;
}

function assertContract6Operation(value, operationId) {
  exactV3Object(value, ["operation_id", "authorization", "completion"], "operation");
  v3Require(value.operation_id === operationId && v3NonEmpty(operationId), "operation id");
  if (value.authorization !== null) {
    exactV3Object(value.authorization, ["tool_family", "declared_targets", "target_coverage", "host_profile", "receipt_expectation"], "operation authorization");
    v3Require(v3NonEmpty(value.authorization.tool_family), "operation tool_family");
    v3Require(v3Array(value.authorization.declared_targets, v3RepoPath, { nonEmpty: true }), "operation declared_targets");
    v3Require(new Set(["exact", "partial", "unknown"]).has(value.authorization.target_coverage), "operation target_coverage");
    v3Require(v3NonEmpty(value.authorization.host_profile), "operation host_profile");
    v3Require(new Set(["post", "failure", "reconcile", "unknown"]).has(value.authorization.receipt_expectation), "operation receipt_expectation");
  }
  if (value.completion !== null) {
    exactV3Object(value.completion, ["tool_family", "outcome", "reported_targets", "receipt_quality", "host_profile"], "operation completion");
    v3Require(v3NonEmpty(value.completion.tool_family), "operation completion tool_family");
    v3Require(new Set(["success", "failure", "nonzero", "unknown"]).has(value.completion.outcome), "operation completion outcome");
    v3Require(v3Array(value.completion.reported_targets, v3RepoPath), "operation completion targets");
    v3Require(new Set(["exact", "tool_specific", "reconciled", "unknown"]).has(value.completion.receipt_quality), "operation completion quality");
    v3Require(v3NonEmpty(value.completion.host_profile), "operation completion host_profile");
  }
  if (value.authorization !== null && value.completion !== null) {
    v3Require(value.authorization.tool_family === value.completion.tool_family && value.authorization.host_profile === value.completion.host_profile, "operation authorization completion binding");
  }
}

function assertContract7Operation(value, operationId) {
  exactV3Object(value, ["operation_id", "intent", "completion"], "operation");
  v3Require(value.operation_id === operationId && v3NonEmpty(operationId), "operation id");
  if (value.intent !== null) {
    exactV3Object(value.intent, ["tool_family", "declared_targets", "target_coverage", "host_profile", "receipt_expectation", "policy_mode", "policy_disposition", "policy_reasons", "session_relation"], "operation intent");
    v3Require(v3NonEmpty(value.intent.tool_family), "operation intent tool_family");
    v3Require(v3Array(value.intent.declared_targets, v3RepoPath, { nonEmpty: true }), "operation intent declared_targets");
    v3Require(new Set(["exact", "partial", "unknown"]).has(value.intent.target_coverage), "operation intent target_coverage");
    v3Require(v3NonEmpty(value.intent.host_profile), "operation intent host_profile");
    v3Require(new Set(["post", "failure", "reconcile", "unknown"]).has(value.intent.receipt_expectation), "operation intent receipt_expectation");
    v3Require(new Set(["observe", "nudge", "deny"]).has(value.intent.policy_mode), "operation intent policy_mode");
    v3Require(new Set(["conformant", "deviation"]).has(value.intent.policy_disposition), "operation intent policy_disposition");
    v3Require(v3Array(value.intent.policy_reasons, (reason) => POLICY_DEVIATION_REASONS.has(reason)), "operation intent policy_reasons");
    v3Require((value.intent.policy_disposition === "deviation") === (value.intent.policy_reasons.length > 0), "operation intent policy disposition binding");
    v3Require(new Set(["owner", "foreign", "unbound"]).has(value.intent.session_relation), "operation intent session_relation");
  }
  if (value.completion !== null) {
    exactV3Object(value.completion, ["tool_family", "outcome", "reported_targets", "receipt_quality", "host_profile"], "operation completion");
    v3Require(v3NonEmpty(value.completion.tool_family), "operation completion tool_family");
    v3Require(new Set(["success", "failure", "nonzero", "unknown"]).has(value.completion.outcome), "operation completion outcome");
    v3Require(v3Array(value.completion.reported_targets, v3RepoPath), "operation completion targets");
    v3Require(new Set(["exact", "tool_specific", "reconciled", "unknown"]).has(value.completion.receipt_quality), "operation completion quality");
    v3Require(v3NonEmpty(value.completion.host_profile), "operation completion host_profile");
  }
  if (value.intent !== null && value.completion !== null) {
    v3Require(value.intent.tool_family === value.completion.tool_family && value.intent.host_profile === value.completion.host_profile, "operation intent completion binding");
  }
}

function assertCapabilityLease(value) {
  exactV3Object(value, ["episode_id", "operation_id", "capability_id", "host_profile", "surface", "exhaustive_surface", "effective_from_checkpoint", "closed_at_checkpoint", "status"], "capability lease");
  v3Require(v3Uuid(value.episode_id), "capability lease episode_id");
  v3Require(v3NonEmpty(value.operation_id) && v3NonEmpty(value.capability_id), "capability lease identity");
  v3Require(v3NonEmpty(value.host_profile) && v3NonEmpty(value.surface), "capability lease host surface");
  v3Require(typeof value.exhaustive_surface === "boolean", "capability lease exhaustive_surface");
  v3Require(v3Digest(value.effective_from_checkpoint), "capability lease effective checkpoint");
  v3Require(v3Nullable(value.closed_at_checkpoint, v3Digest), "capability lease closed checkpoint");
  v3Require(new Set(["open", "closed"]).has(value.status) && (value.status === "open") === (value.closed_at_checkpoint === null), "capability lease status");
}

function assertCoverageInterval(value) {
  const fields = eventPayloadFields("coverage_changed", 1);
  exactV3Object(value, fields, "coverage interval");
  v3Require(new Set(["full", "unknown"]).has(value.artifact_state), "coverage interval artifact state");
  v3Require(new Set(["full", "partial", "unknown"]).has(value.mutation_history), "coverage interval mutation history");
  v3Require(new Set(["full", "partial", "unknown"]).has(value.prewrite_enforcement), "coverage interval prewrite enforcement");
  v3Require(v3Uuid(value.episode_id), "coverage interval episode");
  v3Require(v3Nullable(value.operation_id, v3NonEmpty) && v3Nullable(value.capability_id, v3NonEmpty), "coverage interval operation");
  v3Require(v3NonEmpty(value.host_profile) && v3NonEmpty(value.surface), "coverage interval host surface");
  v3Require(typeof value.exhaustive_surface === "boolean", "coverage interval exhaustive surface");
  v3Require(v3Digest(value.effective_from_checkpoint) && v3Digest(value.interval_from_checkpoint), "coverage interval start");
  v3Require(value.effective_from_checkpoint === value.interval_from_checkpoint, "coverage interval effective checkpoint");
  v3Require(v3Nullable(value.interval_to_checkpoint, v3Digest), "coverage interval end");
  v3Require(v3NonEmpty(value.reason), "coverage interval reason");
}

function assertV3Lifecycle(value) {
  if (value?.state === "active") exactV3Object(value, ["state"], "active lifecycle");
  else if (value?.state === "suspended") {
    exactV3Object(value, ["state", "reason", "suspended_at", "judgment"], "suspended lifecycle");
    exactV3Object(value.judgment, ["remaining", "failure", "next_action"], "suspension judgment");
    v3Require(VALID_SUSPEND_OUTCOMES.has(value.reason), "suspended lifecycle reason");
    v3Require(v3Utc(value.suspended_at), "suspended lifecycle suspended_at");
    v3Require(Object.values(value.judgment).every(v3NonEmpty), "suspended lifecycle judgment");
  } else if (value?.state === "terminal") {
    exactV3Object(value, ["state", "outcome", "terminal_at", "closing_observation_id", "proof_provisional", "evidence", "verified_at_task_revision", "reason"], "terminal lifecycle");
    v3Require(TERMINAL_OUTCOMES.has(value.outcome), "terminal lifecycle outcome");
    v3Require(v3Utc(value.terminal_at), "terminal lifecycle terminal_at");
    v3Require(v3Nullable(value.closing_observation_id, v3Uuid), "terminal lifecycle closing_observation_id");
    v3Require(v3Nullable(value.proof_provisional, (item) => typeof item === "boolean"), "terminal lifecycle proof_provisional");
    v3Require(v3Nullable(value.evidence, v3NonEmpty), "terminal lifecycle evidence");
    v3Require(v3Nullable(value.verified_at_task_revision, (item) => v3Integer(item, 1)), "terminal lifecycle verified_at_task_revision");
    v3Require(v3Nullable(value.reason, v3NonEmpty), "terminal lifecycle reason");
    if (value.outcome === "achieved" && (!v3Uuid(value.closing_observation_id) || typeof value.proof_provisional !== "boolean" || value.evidence !== null || value.verified_at_task_revision !== null || value.reason !== null)) throw new Error("invalid achieved schema-v3 lifecycle");
    if (value.outcome === "not_needed" && (value.closing_observation_id !== null || value.proof_provisional !== null || !v3NonEmpty(value.evidence) || !v3Integer(value.verified_at_task_revision, 1) || value.reason !== null)) throw new Error("invalid not-needed schema-v3 lifecycle");
    if (value.outcome === "abandoned" && (value.closing_observation_id !== null || value.proof_provisional !== null || value.evidence !== null || value.verified_at_task_revision !== null || !v3NonEmpty(value.reason))) throw new Error("invalid abandoned schema-v3 lifecycle");
  } else throw new Error("invalid schema-v3 task projection lifecycle");
}

function assertV3TaskProjection(task) {
  const runtimeContract = taskRuntimeContract(task);
  if (!new Set([5, 6, 7]).has(runtimeContract)) throw new Error("invalid schema-v3 task runtime contract");
  exactV3Object(task, runtimeContract >= 6 ? CONTRACT6_TASK_PROJECTION_FIELDS : V3_TASK_PROJECTION_FIELDS, "task projection");
  if (task.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION || !v3Uuid(task.task_id)) throw new Error("invalid schema-v3 task projection identity");
  for (const field of ["task_revision", "last_substantive_task_revision", "task_event_sequence"]) if (!v3Integer(task[field], 1)) throw new Error(`invalid schema-v3 task projection ${field}`);
  for (const field of ["artifact_revision", "unsatisfied_streak"]) if (!v3Integer(task[field])) throw new Error(`invalid schema-v3 task projection ${field}`);
  v3Require(task.last_substantive_task_revision <= task.task_revision, "task projection last_substantive_task_revision");
  v3Require(v3Utc(task.created_at), "task projection created_at");
  v3Require(v3Utc(task.updated_at) && Date.parse(task.updated_at) >= Date.parse(task.created_at), "task projection updated_at");
  v3Require(v3NonEmpty(task.goal), "task projection goal");
  assertV3Lifecycle(task.lifecycle);
  assertV3Criterion(task.criterion, { runtimeContract });
  exactV3Object(task.policy, ["open_requirement", "witness_requirement", "close_policy"], "policy");
  validatePolicy(task.policy);
  if (!v3Nullable(task.policy_rationale, v3NonEmpty)) throw new Error("invalid schema-v3 policy rationale");
  if (task.witness !== null) {
    exactV3Object(task.witness, ["criterion_generation_id", "observed_at", "source_event"], "witness");
    v3Require(v3Uuid(task.witness.criterion_generation_id), "witness criterion_generation_id");
    v3Require(v3Utc(task.witness.observed_at), "witness observed_at");
    v3Require(new Set(["open", "stop", "achieve", "cli_verify"]).has(task.witness.source_event), "witness source_event");
  }
  exactV3Object(task.alignment, ["because", "not_covered"], "alignment");
  if (!v3NonEmpty(task.alignment.because) || !v3Array(task.alignment.not_covered, v3NonEmpty)) throw new Error("invalid schema-v3 alignment");
  exactV3Object(task.envelope, ["files", "git", "destructive", "network"], "envelope");
  v3Require(v3Array(task.envelope.files, v3RepoPath, { nonEmpty: true }), "task projection envelope files");
  v3Require(v3Array(task.envelope.git, v3NonEmpty), "task projection envelope git");
  v3Require(typeof task.envelope.destructive === "boolean", "task projection envelope destructive");
  v3Require(typeof task.envelope.network === "boolean", "task projection envelope network");
  if (!v3Array(task.grants, (grant) => {
    try {
      exactV3Object(grant, ["grant_id", "kind", "scope", "reason", "granted_by", "granted_at_task_revision"], "grant");
      return v3Uuid(grant.grant_id) && new Set(["git", "destructive", "network", "install", "whole_repo", "criterion_subject", "publish"]).has(grant.kind) && v3Array(grant.scope, v3NonEmpty, { nonEmpty: true }) && v3NonEmpty(grant.reason) && new Set(["user", "self"]).has(grant.granted_by) && v3Integer(grant.granted_at_task_revision, 1);
    } catch { return false; }
  })) throw new Error("invalid schema-v3 grants");
  exactV3Object(task.assurance, ["declared_risk", "risk_reason", "risk_declared_by", "change_classes", "review_policy", "required_review_level", "review_waiver_reason", "review_waiver_granted_by", "proof_gap_acceptances", "risk_floor_events"], "assurance");
  if (
    typeof task.assurance.risk_reason !== "string" ||
    !v3Nullable(task.assurance.required_review_level, (item) => new Set(["fresh_context", "second_model"]).has(item)) ||
    !v3Nullable(task.assurance.review_waiver_reason, v3NonEmpty) ||
    !v3Nullable(task.assurance.review_waiver_granted_by, (item) => new Set(["self", "user"]).has(item))
  ) throw new Error("invalid schema-v3 assurance values");
  if (!v3Array(task.assurance.proof_gap_acceptances, (record) => {
    try {
      exactV3Object(record, ["acceptance_id", "reason", "granted_by", "accepted_at", "criterion_generation_id", "accepted_at_task_revision"], "proof-gap record");
      return v3Uuid(record.acceptance_id) && v3NonEmpty(record.reason) && new Set(["user", "self"]).has(record.granted_by) && v3Utc(record.accepted_at) && v3Uuid(record.criterion_generation_id) && v3Integer(record.accepted_at_task_revision, 1);
    } catch { return false; }
  })) throw new Error("invalid schema-v3 proof-gap records");
  validateAssurance(task.assurance);
  exactV3Object(task.budget, ["rounds", "writes", "wall_clock_minutes", "output_tokens"], "budget");
  if (!v3Integer(task.budget.rounds, 1) || !v3Nullable(task.budget.writes, v3Integer) || !v3Nullable(task.budget.wall_clock_minutes, v3Integer) || !v3Nullable(task.budget.output_tokens, v3Integer)) throw new Error("invalid schema-v3 budget");
  exactV3Object(task.spent, runtimeContract >= 6
    ? ["rounds", "writes", "write_count_basis", "wall_clock_ms", "output_tokens_estimate"]
    : ["rounds", "writes", "wall_clock_ms", "output_tokens_estimate"], "spent");
  if (![task.spent.rounds, task.spent.writes, task.spent.wall_clock_ms, task.spent.output_tokens_estimate].every((item) => v3Integer(item))) throw new Error("invalid schema-v3 spent");
  if (runtimeContract === 6) v3Require(task.spent.write_count_basis === "authorized", "spent write_count_basis");
  if (runtimeContract === 7) v3Require(task.spent.write_count_basis === "intent", "spent write_count_basis");
  exactV3Object(task.evidence, runtimeContract >= 6
    ? ["evidence_revision", "tool_completions_observed", "artifact_state_coverage", "mutation_history_coverage", "touched_files", "current_scope_violations", "criterion_input_drift"]
    : ["touched_files", "criterion_input_drift"], "evidence");
  if (!v3Array(task.evidence.touched_files, v3RepoPath) || !v3Array(task.evidence.criterion_input_drift, v3RepoPath)) throw new Error("invalid schema-v3 evidence");
  if (runtimeContract >= 6) {
    v3Require(v3Integer(task.evidence.evidence_revision), "evidence revision");
    v3Require(v3Integer(task.evidence.tool_completions_observed), "evidence tool completions");
    v3Require(new Set(["full", "unknown"]).has(task.evidence.artifact_state_coverage), "evidence artifact state coverage");
    v3Require(new Set(["full", "partial", "unknown"]).has(task.evidence.mutation_history_coverage), "evidence mutation history coverage");
    v3Require(v3Array(task.evidence.current_scope_violations, v3RepoPath), "evidence current scope violations");
  }
  if (!v3Array(task.reviews, (record) => {
    try {
      const fields = ["review_id", "criterion_generation_id", "reviewed_task_revision", "reviewed_artifact_revision", "level", "reviewer", "blocking_findings_count", "advisory_findings_count", "reviewed_at", "acting_session"];
      if (runtimeContract >= 6) fields.push("reviewed_evidence_revision");
      exactV3Object(record, fields, "review record");
      assertV3ReviewRecord(record, { runtimeContract });
      return v3Uuid(record.review_id) && v3Uuid(record.criterion_generation_id) && v3NonEmpty(record.reviewer) && v3Utc(record.reviewed_at) && v3Nullable(record.acting_session, v3NonEmpty);
    } catch { return false; }
  })) throw new Error("invalid schema-v3 reviews");
  if (!v3Array(task.attempts, (attempt) => {
    try { exactV3Object(attempt, ["attempt_id", "criterion_generation_id", "artifact_revision", "signature", "failure_summary", "observed_at"], "attempt"); return v3Uuid(attempt.attempt_id) && v3Uuid(attempt.criterion_generation_id) && v3Integer(attempt.artifact_revision) && v3Nullable(attempt.signature, v3NonEmpty) && typeof attempt.failure_summary === "string" && Buffer.byteLength(attempt.failure_summary, "utf8") <= 160 && v3Utc(attempt.observed_at); } catch { return false; }
  })) throw new Error("invalid schema-v3 attempts");
  if (!v3Array(task.episodes, (episode) => {
    try { exactV3Object(episode, ["episode_id", "host_session_id", "started_at", "ended_at", "start_task_revision", "end_task_revision", "output_tokens_estimate"], "episode"); return v3Uuid(episode.episode_id) && v3NonEmpty(episode.host_session_id) && v3Utc(episode.started_at) && v3Nullable(episode.ended_at, v3Utc) && v3Integer(episode.start_task_revision, 1) && v3Nullable(episode.end_task_revision, (item) => v3Integer(item, 1)) && (episode.ended_at === null) === (episode.end_task_revision === null) && (episode.end_task_revision === null || episode.end_task_revision >= episode.start_task_revision) && (episode.ended_at === null || Date.parse(episode.ended_at) >= Date.parse(episode.started_at)) && v3Integer(episode.output_tokens_estimate); } catch { return false; }
  }, { nonEmpty: true })) throw new Error("invalid schema-v3 episodes");
  if (!v3Array(task.lifecycle_log, (row) => {
    try { exactV3Object(row, ["event", "source", "acting_session", "at", "task_revision", "reason"], "lifecycle row"); return LIFECYCLE_EVENTS.has(row.event) && new Set(["cli", "stop"]).has(row.source) && v3Nullable(row.acting_session, v3NonEmpty) && v3Utc(row.at) && v3Integer(row.task_revision, 1) && v3Nullable(row.reason, v3NonEmpty); } catch { return false; }
  }, { nonEmpty: true })) throw new Error("invalid schema-v3 lifecycle log");
  for (let index = 1; index < task.lifecycle_log.length; index += 1) {
    const previous = task.lifecycle_log[index - 1]; const current = task.lifecycle_log[index];
    if (current.task_revision < previous.task_revision || Date.parse(current.at) < Date.parse(previous.at)) throw new Error("schema-v3 lifecycle log is not monotonic");
  }
  if (!isPlainObject(task.transcript_cursors)) throw new Error("invalid schema-v3 task projection transcript cursors");
  for (const [sourceId, cursor] of Object.entries(task.transcript_cursors)) {
    exactV3Object(cursor, ["source_generation_id", "episode_id", "offset", "range_sha256", "end_anchor_sha256"], "transcript cursor");
    if (!v3Digest(sourceId) || !v3Uuid(cursor.source_generation_id) || !v3Uuid(cursor.episode_id) || !v3Integer(cursor.offset) || !v3Digest(cursor.range_sha256) || !v3Digest(cursor.end_anchor_sha256)) throw new Error("invalid schema-v3 transcript cursor");
  }
  if (runtimeContract >= 6) {
    if (runtimeContract === 6) {
      exactV3Object(task.authority, ["write_operations_authorized", "prewrite_enforcement"], "authority");
      v3Require(v3Integer(task.authority.write_operations_authorized), "authority write_operations_authorized");
      v3Require(new Set(["full", "partial", "unknown"]).has(task.authority.prewrite_enforcement), "authority prewrite_enforcement");
    } else {
      exactV3Object(task.authority, ["execution_authority", "operation_intents_observed", "pre_execution_observation"], "authority");
      v3Require(task.authority.execution_authority === "host", "authority execution_authority");
      v3Require(v3Integer(task.authority.operation_intents_observed), "authority operation_intents_observed");
      v3Require(new Set(["full", "partial", "unknown"]).has(task.authority.pre_execution_observation), "authority pre_execution_observation");
    }
    assertArtifactCheckpoint(task.artifact_baseline, "artifact baseline");
    assertArtifactCheckpoint(task.artifact_checkpoint, "artifact checkpoint");
    v3Require(v3Array(task.capability_leases, (lease) => { try { assertCapabilityLease(lease); return true; } catch { return false; } }), "capability leases");
    v3Require(new Set(task.capability_leases.map((lease) => lease.operation_id)).size === task.capability_leases.length, "capability lease operation identity");
    v3Require(v3Array(task.coverage_intervals, (interval) => { try { assertCoverageInterval(interval); return true; } catch { return false; } }), "coverage intervals");
    v3Require(new Set(["artifact_only", "complete"]).has(task.history_requirement), "history requirement");
    assertHistoryRequirementInvariant(task);
    v3Require(isPlainObject(task.operations), "operations");
    for (const [operationId, operation] of Object.entries(task.operations)) {
      if (runtimeContract === 7) assertContract7Operation(operation, operationId);
      else assertContract6Operation(operation, operationId);
    }
    assertWriteBudgetInvariant(task);
    assertFullMutationHistoryInvariant(task);
    assertFullOperationReceiptInvariant(task);
  }
  return task;
}

function appendLifecycle(task, event, source, actingSession, at, reason = null) {
  task.lifecycle_log ??= [];
  task.lifecycle_log.push({
    event,
    source,
    acting_session: typeof actingSession === "string" && actingSession.trim() ? actingSession.trim() : null,
    at,
    task_revision: task.task_revision,
    reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
  });
}

function createTask(facts) {
  const runtimeContract = facts.runtimeContract ?? 5;
  if (!new Set([5, 6, 7]).has(runtimeContract)) throw new Error("unsupported task runtime contract");
  const policy = constructPolicy(facts.policyName);
  validatePolicy(policy);
  if (facts.observation.verdict === "indeterminate") throw new Error("criterion indeterminate; task not opened");
  if (policy.open_requirement === "unsatisfied" && facts.observation.verdict !== "unsatisfied") {
    throw new Error("default policy requires criterion unsatisfied at open");
  }
  if (facts.policyName !== "default" && !String(facts.policyRationale ?? "").trim()) {
    throw new Error(`${String(facts.policyName).replaceAll("_", "-")} requires --reason`);
  }
  const witness = policy.witness_requirement === "required" && facts.observation.verdict === "unsatisfied"
    ? { criterion_generation_id: facts.criterion.criterion_generation_id, observed_at: facts.at, source_event: "open" }
    : null;
  const assurance = constructAssurance(facts.assurance);
  validateAssurance(assurance);
  const initialObservation = clone(facts.observation);
  if (runtimeContract >= 6) {
    assertArtifactCheckpoint(facts.artifactBaseline, "artifact baseline");
    exactV3Object(facts.coverageBasis, ["history_requirement", "artifact_state", "mutation_history", "prewrite_enforcement"], "coverage basis");
    initialObservation.observed_checkpoint_id = facts.artifactBaseline.checkpoint_id;
    initialObservation.observed_evidence_revision = 0;
    initialObservation.observed_event_cursor = 1;
  }
  const task = {
    schema_version: V3_TASK_SNAPSHOT_SCHEMA_VERSION,
    task_id: facts.taskId,
    task_revision: 1,
    last_substantive_task_revision: 1,
    artifact_revision: 0,
    task_event_sequence: 1,
    created_at: facts.at,
    updated_at: facts.at,
    lifecycle: { state: "active" },
    goal: facts.goal,
    criterion: { ...clone(facts.criterion), authored_by: facts.criterion.authored_by ?? "self", last_observation: initialObservation },
    policy,
    policy_rationale: facts.policyName === "default" ? null : facts.policyRationale,
    witness,
    alignment: clone(facts.alignment),
    envelope: clone(facts.envelope),
    grants: clone(facts.grants ?? []),
    assurance,
    budget: {
      rounds: facts.budget?.rounds ?? DEFAULT_ROUNDS,
      writes: facts.budget?.writes ?? null,
      wall_clock_minutes: facts.budget?.wall_clock_minutes ?? null,
      output_tokens: facts.budget?.output_tokens ?? null,
    },
    spent: { rounds: 0, writes: 0, wall_clock_ms: 0, output_tokens_estimate: 0 },
    evidence: { touched_files: [], criterion_input_drift: [] },
    reviews: [],
    attempts: [],
    unsatisfied_streak: 0,
    episodes: facts.episodes ? clone(facts.episodes) : [],
    lifecycle_log: [{ event: "open", source: "cli", acting_session: typeof facts.actingSession === "string" && facts.actingSession.trim() ? facts.actingSession.trim() : null, at: facts.at, task_revision: 1, reason: null }],
    transcript_cursors: {},
  };
  if (runtimeContract >= 6) {
    task.runtime_contract = runtimeContract;
    task.authority = runtimeContract === 7
      ? { execution_authority: "host", operation_intents_observed: 0, pre_execution_observation: facts.coverageBasis.prewrite_enforcement }
      : { write_operations_authorized: 0, prewrite_enforcement: facts.coverageBasis.prewrite_enforcement };
    task.artifact_baseline = clone(facts.artifactBaseline);
    task.artifact_checkpoint = clone(facts.artifactBaseline);
    task.capability_leases = [];
    task.coverage_intervals = [];
    task.history_requirement = facts.coverageBasis.history_requirement;
    task.operations = {};
    task.spent.write_count_basis = runtimeContract === 7 ? "intent" : "authorized";
    task.evidence = {
      evidence_revision: 0,
      tool_completions_observed: 0,
      artifact_state_coverage: facts.coverageBasis.artifact_state,
      mutation_history_coverage: facts.coverageBasis.mutation_history,
      touched_files: [],
      current_scope_violations: [],
      criterion_input_drift: [],
    };
    assertHistoryRequirementInvariant(task);
    assertWriteBudgetInvariant(task);
    if (task.evidence.mutation_history_coverage === "full") {
      throw new Error("task genesis cannot claim full mutation history without an operation-scoped capability lease");
    }
  }
  return task;
}

function exactV3Payload(kind, values, payloadVersion = 1) {
  const fields = eventPayloadFields(kind, payloadVersion);
  if (!fields) throw new Error(`unknown schema-v3 event kind: ${kind}`);
  const payload = {};
  for (const field of fields) payload[field] = clone(values[field] ?? null);
  return payload;
}

function v3Event(command, kind, values, taskId = command.taskId, payloadVersion = 1) {
  if (!String(taskId ?? "").trim()) throw new Error(`${kind} requires taskId`);
  if (!String(command.at ?? "").trim() || !Number.isFinite(Date.parse(command.at))) throw new Error(`${kind} requires command.at`);
  return {
    kind,
    payload_version: payloadVersion,
    task_id: taskId,
    at: command.at,
    payload: exactV3Payload(kind, values, payloadVersion),
  };
}

function coverageChangedEvent(command, coverage, taskId, overrides = {}) {
  return v3Event(command, "coverage_changed", {
    artifact_state: coverage.artifactState,
    mutation_history: coverage.mutationHistory,
    prewrite_enforcement: coverage.prewriteEnforcement,
    episode_id: coverage.episodeId,
    operation_id: coverage.operationId ?? null,
    capability_id: coverage.capabilityId ?? null,
    host_profile: coverage.hostProfile,
    surface: coverage.surface,
    exhaustive_surface: coverage.exhaustiveSurface,
    effective_from_checkpoint: coverage.effectiveFromCheckpoint,
    interval_from_checkpoint: coverage.intervalFromCheckpoint,
    interval_to_checkpoint: coverage.intervalToCheckpoint ?? null,
    reason: coverage.reason,
    ...overrides,
  }, taskId);
}

function episodeCoverageBoundaryEvent(state, command, episode) {
  const checkpointId = state.artifact_checkpoint.checkpoint_id;
  return coverageChangedEvent(command, {
    artifactState: state.evidence.artifact_state_coverage,
    mutationHistory: "unknown",
    prewriteEnforcement: "unknown",
    episodeId: episode.episode_id,
    operationId: null,
    capabilityId: null,
    hostProfile: `runtime-contract-${taskRuntimeContract(state)}`,
    surface: "episode-boundary",
    exhaustiveSurface: false,
    effectiveFromCheckpoint: checkpointId,
    intervalFromCheckpoint: checkpointId,
    intervalToCheckpoint: checkpointId,
    reason: `${command.type} rotated the host episode; continuous mutation coverage cannot cross the boundary`,
  }, state.task_id);
}

function assertV3CommandState(state, command, { active = false } = {}) {
  if (!isPlainObject(state) || state.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION) throw new Error(`${command.type} requires schema-v3 state`);
  if (state.task_id !== command.taskId) throw new Error(`${command.type} taskId does not match current task`);
  if (active && state.lifecycle?.state !== "active") throw new Error(`${command.type} requires an active task`);
  return state;
}

function validateDigest(value, field) {
  if (!v3Digest(value)) throw new Error(`invalid transcript ${field}`);
}

function validateTranscriptRange(state, range) {
  if (!isPlainObject(range)) throw new Error("transcript range must be an object");
  for (const field of ["source_id", "range_sha256", "end_anchor_sha256"]) validateDigest(range[field], field);
  for (const field of ["source_generation_id", "episode_id"]) if (!String(range[field] ?? "").trim()) throw new Error(`invalid transcript ${field}`);
  for (const field of ["from_offset", "to_offset", "output_tokens_delta"]) {
    if (!Number.isSafeInteger(range[field]) || range[field] < 0) throw new Error(`invalid transcript ${field}`);
  }
  const currentEpisode = state.episodes?.at(-1);
  if (!currentEpisode || currentEpisode.episode_id !== range.episode_id) throw new Error("transcript range must bind the current episode");
  const cursor = state.transcript_cursors?.[range.source_id] ?? null;
  if (range.mode === "baseline") {
    if (range.output_tokens_delta !== 0) throw new Error("transcript baseline delta must be zero");
    if (range.to_offset < range.from_offset) throw new Error("transcript baseline offsets regress");
    if (cursor?.source_generation_id === range.source_generation_id) throw new Error("transcript generation already has a baseline");
  } else if (range.mode === "increment") {
    if (!cursor || cursor.source_generation_id !== range.source_generation_id || cursor.episode_id !== range.episode_id) throw new Error("transcript increment requires the current generation and episode");
    if (range.from_offset !== cursor.offset || range.to_offset <= range.from_offset) throw new Error("transcript increment must continue at the authoritative cursor");
  } else {
    throw new Error("invalid transcript mode");
  }
  return range;
}

function v3FailureSuspension(task, observation, atEpochMs) {
  const adapterError = observation.execution?.execution_error;
  if (observation.verdict === "indeterminate" && new Set(["adapter_silent", "invalid_adapter_exit"]).has(adapterError)) {
    return {
      reason: "needs_input",
      failure: `criterion adapter protocol 2 rejected the adapter exit (${adapterError})`,
      next_action: "update the tri-state adapter to exit 4 (satisfied), 3 (unsatisfied), or 2 (indeterminate), then resume",
    };
  }
  if (observation.verdict !== "unsatisfied") return null;
  const exhausted = projectBudgetExhaustion(task, atEpochMs);
  if (exhausted.length) {
    return {
      reason: "out_of_budget",
      failure: exhausted.map((item) => `${BUDGET_DIMENSIONS[item.dimension].label} budget exhausted (${item.spent}/${item.limit})`).join("; "),
      next_action: `amend ${exhausted.map((item) => BUDGET_DIMENSIONS[item.dimension].option).join(" and ")} with a reason, then resume`,
    };
  }
  const signatures = task.attempts.slice(-STUCK_REPEATS).map((attempt) => attempt.signature);
  if (signatures.length === STUCK_REPEATS && signatures.every(Boolean) && new Set(signatures).size === 1) {
    return { reason: "stuck", failure: `same failure repeated ${STUCK_REPEATS} times`, next_action: "change the approach or inputs, then resume" };
  }
  const recent = task.attempts.slice(-NO_PROGRESS_STOPS);
  if ((task.unsatisfied_streak ?? 0) >= NO_PROGRESS_STOPS && recent.length === NO_PROGRESS_STOPS && new Set(recent.map((attempt) => `${attempt.criterion_generation_id}@${attempt.artifact_revision}`)).size === 1) {
    return { reason: "stuck", failure: `no artifact progress across ${NO_PROGRESS_STOPS} attempts`, next_action: "change the approach or inputs, then resume" };
  }
  return null;
}

function assertV3Episode(episode, commandType) {
  if (!isPlainObject(episode)) throw new Error(`${commandType} requires an episode`);
  for (const field of ["episode_id", "host_session_id", "started_at"]) {
    if (!String(episode[field] ?? "").trim()) throw new Error(`${commandType} episode requires ${field}`);
  }
  if (!Number.isFinite(Date.parse(episode.started_at)) || episode.ended_at !== null || episode.end_task_revision !== null) {
    throw new Error(`${commandType} requires a fresh open episode`);
  }
  if (!Number.isSafeInteger(episode.start_task_revision) || episode.start_task_revision < 1 || episode.output_tokens_estimate !== 0) {
    throw new Error(`${commandType} episode has invalid revision or token state`);
  }
  return clone(episode);
}

function assertV3ReviewRecord(record, { runtimeContract = 5 } = {}) {
  if (!isPlainObject(record) || !new Set(["fresh_context", "second_model"]).has(record.level)) throw new Error("review requires a valid independent review record");
  for (const field of ["review_id", "criterion_generation_id", "reviewer", "reviewed_at"]) if (!String(record[field] ?? "").trim()) throw new Error(`review record requires ${field}`);
  for (const field of ["reviewed_task_revision", "reviewed_artifact_revision", "blocking_findings_count", "advisory_findings_count"]) {
    if (!Number.isSafeInteger(record[field]) || record[field] < (field === "reviewed_task_revision" ? 1 : 0)) throw new Error(`review record has invalid ${field}`);
  }
  if (runtimeContract >= 6 && (!Number.isSafeInteger(record.reviewed_evidence_revision) || record.reviewed_evidence_revision < 0)) throw new Error("review record has invalid reviewed_evidence_revision");
  if (!(record.acting_session === null || String(record.acting_session ?? "").trim())) throw new Error("review record has invalid acting_session");
  return clone(record);
}

function requireMatchingEpoch(command, label) {
  if (!Number.isSafeInteger(command.atEpochMs) || command.atEpochMs < 0 || new Date(command.atEpochMs).toISOString() !== command.at) throw new Error(`${label} requires matching atEpochMs`);
}

// The one derivation of an automatic failure suspension, shared by observe and
// achieve. Appends the task_suspended event and returns the suspended result,
// or null when the command does not auto-suspend or no suspension applies.
function deriveAutoSuspension(command, projected, events, source) {
  if (!command.autoSuspend) return null;
  requireMatchingEpoch(command, "automatic suspension");
  const suspension = v3FailureSuspension(projected, command.observation, command.atEpochMs);
  if (!suspension) return null;
  const judgment = {
    remaining: String(command.remaining ?? "criterion must become satisfied"),
    failure: suspension.failure,
    next_action: suspension.next_action,
  };
  events.push(v3Event(command, "task_suspended", {
    reason: suspension.reason,
    judgment,
    close_episode: command.closeEpisode !== false,
    source,
    acting_session: command.actingSession ?? null,
  }, command.taskId));
  return { status: "suspended", reason: suspension.reason, judgment };
}

const V3_DECIDERS = {
  open(state, command) {
    if (state !== null) throw new Error("open requires empty schema-v3 state");
    const payloadVersion = command.runtimeContract === 7 ? 3 : command.runtimeContract === 6 ? 2 : 1;
    const event = v3Event(command, "task_opened", {
      goal: command.goal,
      criterion: command.criterion,
      observation: command.observation,
      policy_name: command.policyName,
      policy_rationale: command.policyRationale,
      alignment: command.alignment,
      envelope: command.envelope,
      grants: command.grants,
      assurance: command.assurance,
      budget: command.budget,
      episodes: command.episodes,
      runtime_contract: payloadVersion >= 2 ? command.runtimeContract : undefined,
      artifact_baseline: command.artifactBaseline,
      coverage_basis: command.coverageBasis,
    }, command.taskId, payloadVersion);
    // The reducer decides whether this task can exist at all — indeterminate
    // criterion, policy open-requirement, assurance shape. Run it here, on the
    // same empty state a commit would, so a rejection happens before the event
    // can be persisted. Emitting an event our own reducer always rejects wedges
    // the repository: the record is well-formed, so it replays forever, and
    // every read path (status, audit, Stop) throws while open and abandon
    // cannot escape it. Calling the reducer rather than restating its checks
    // keeps the two from drifting apart.
    V3_REDUCERS.task_opened(null, event);
    return { events: [event], result: { status: "opened" } };
  },
  "tally-transcript"(state, command) {
    assertV3CommandState(state, command);
    if (state.lifecycle?.state === "terminal") throw new Error("tally-transcript does not mutate a terminal task");
    const range = validateTranscriptRange(state, command.transcriptRange);
    return { events: [v3Event(command, "output_tokens_tallied", range, state.task_id)], result: { status: "tallied" } };
  },
  "authorize-write"(state, command) {
    assertV3CommandState(state, command);
    if (!new Set(["allow", "deny"]).has(command.decision)) throw new Error("authorize-write requires allow or deny decision");
    if (command.decision === "deny") {
      const events = command.transcriptRange
        ? [v3Event(command, "output_tokens_tallied", validateTranscriptRange(state, command.transcriptRange), state.task_id)]
        : [];
      return { events, result: { status: "deny", reason: String(command.reason ?? "") } };
    }
    if (state.lifecycle?.state !== "active") throw new Error("write authorization requires an active task");
    if (!Array.isArray(command.files) || !command.files.length || command.files.some((file) => !String(file ?? "").trim())) throw new Error("authorize-write requires files");
    const contract6 = taskRuntimeContract(state) === 6;
    let authorization = null;
    if (contract6) {
      for (const field of ["operationId", "toolFamily", "hostProfile", "targetCoverage", "receiptExpectation"]) {
        if (!String(command[field] ?? "").trim()) throw new Error(`authorize-write requires ${field}`);
      }
      authorization = {
        tool_family: command.toolFamily,
        declared_targets: [...new Set(command.files)],
        target_coverage: command.targetCoverage,
        host_profile: command.hostProfile,
        receipt_expectation: command.receiptExpectation,
      };
      const existing = state.operations[command.operationId];
      if (existing?.authorization !== null && existing?.authorization !== undefined) {
        if (JSON.stringify(existing.authorization) !== JSON.stringify(authorization)) throw new Error("conflicting write authorization for operation identity");
        return { events: [], result: { status: "duplicate" } };
      }
      if (existing?.completion !== null && existing?.completion !== undefined) throw new Error("cannot authorize an operation identity that already completed without authorization");
    }
    const events = [];
    if (command.transcriptRange) events.push(v3Event(command, "output_tokens_tallied", validateTranscriptRange(state, command.transcriptRange), state.task_id));
    const projected = events.length ? evolveAll(state, events) : state;
    const atEpochMs = command.atEpochMs ?? Date.parse(command.at);
    const exhausted = projectBudgetExhaustion(projected, atEpochMs);
    if (exhausted.length) {
      const first = exhausted[0];
      throw new Error(`${BUDGET_DIMENSIONS[first.dimension].label} budget exhausted (${first.spent}/${first.limit})`);
    }
    if (contract6) {
      if (command.coverageChange) events.push(coverageChangedEvent(command, command.coverageChange, state.task_id));
      events.push(v3Event(command, "write_authorized", {
        operation_id: command.operationId,
        tool_family: command.toolFamily,
        declared_targets: [...new Set(command.files)],
        target_coverage: command.targetCoverage,
        host_profile: command.hostProfile,
        receipt_expectation: command.receiptExpectation,
      }, state.task_id, 2));
    } else events.push(v3Event(command, "write_authorized", { files: [...new Set(command.files)] }, state.task_id));
    return { events, result: { status: "allow" } };
  },
  "record-operation-intent"(state, command) {
    assertV3CommandState(state, command);
    if (taskRuntimeContract(state) !== 7 || state.lifecycle?.state !== "active") throw new Error("operation intent requires an active Contract 7 task");
    for (const field of ["operationId", "toolFamily", "hostProfile", "targetCoverage", "receiptExpectation", "policyMode", "policyDisposition", "sessionRelation"]) {
      if (!String(command[field] ?? "").trim()) throw new Error(`operation intent requires ${field}`);
    }
    if (!Array.isArray(command.files) || !command.files.length || command.files.some((file) => !String(file ?? "").trim())) throw new Error("operation intent requires files");
    const policyReasons = [...new Set(command.policyReasons ?? [])].sort();
    if (policyReasons.some((reason) => !POLICY_DEVIATION_REASONS.has(reason))) throw new Error("operation intent has an invalid policy reason");
    if ((command.policyDisposition === "deviation") !== (policyReasons.length > 0)) throw new Error("operation intent policy disposition does not match its reasons");
    const intent = {
      tool_family: command.toolFamily,
      declared_targets: [...new Set(command.files)],
      target_coverage: command.targetCoverage,
      host_profile: command.hostProfile,
      receipt_expectation: command.receiptExpectation,
      policy_mode: command.policyMode,
      policy_disposition: command.policyDisposition,
      policy_reasons: policyReasons,
      session_relation: command.sessionRelation,
    };
    const existing = state.operations[command.operationId];
    if (existing?.intent !== null && existing?.intent !== undefined) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) throw new Error("conflicting operation intent identity");
      return { events: [], result: { status: "duplicate" } };
    }
    if (existing?.completion !== null && existing?.completion !== undefined) throw new Error("cannot record intent for an operation identity that already completed without intent evidence");
    const events = [];
    if (command.transcriptRange) events.push(v3Event(command, "output_tokens_tallied", validateTranscriptRange(state, command.transcriptRange), state.task_id));
    if (command.coverageChange) events.push(coverageChangedEvent(command, command.coverageChange, state.task_id));
    events.push(v3Event(command, "operation_intent_recorded", {
      operation_id: command.operationId,
      ...intent,
    }, state.task_id));
    return { events, result: { status: "recorded" } };
  },
  "complete-tool"(state, command) {
    assertV3CommandState(state, command);
    if (!artifactEvidenceContract(state) || state.lifecycle?.state === "terminal") throw new Error("complete-tool requires a live artifact-evidence task");
    const values = {
      operation_id: command.operationId,
      tool_family: command.toolFamily,
      outcome: command.outcome,
      reported_targets: [...new Set(command.reportedTargets ?? [])],
      receipt_quality: command.receiptQuality,
      host_profile: command.hostProfile,
    };
    return { events: [v3Event(command, "tool_completed", values, state.task_id)], result: { status: "completed" } };
  },
  "complete-operation"(state, command) {
    assertV3CommandState(state, command);
    if (!artifactEvidenceContract(state) || state.lifecycle?.state === "terminal") throw new Error("complete-operation requires a live artifact-evidence task");
    const completion = {
      tool_family: command.toolFamily,
      outcome: command.outcome,
      reported_targets: [...new Set(command.reportedTargets ?? [])],
      receipt_quality: command.receiptQuality,
      host_profile: command.hostProfile,
    };
    const operation = state.operations[command.operationId] ?? null;
    const conflicting = operation?.completion !== null && operation?.completion !== undefined
      && JSON.stringify(operation.completion) !== JSON.stringify(completion);
    const duplicate = operation?.completion !== null && operation?.completion !== undefined && !conflicting;
    if (duplicate) return { events: [], result: { status: "duplicate" } };
    const events = [];
    if (!conflicting) events.push(v3Event(command, "tool_completed", {
      operation_id: command.operationId,
      tool_family: command.toolFamily,
      ...completion,
    }, state.task_id));
    events.push(v3Event(command, "artifact_reconciled", {
      checkpoint_id: command.checkpointId,
      from_checkpoint: command.fromCheckpoint,
      to_checkpoint: command.toCheckpoint,
      captured_at_ms: command.capturedAtMs,
      changed_entries: command.changedEntries ?? [],
      changed_paths: command.changedPaths ?? [],
      current_scope_violations: command.currentScopeViolations ?? [],
      coverage: command.coverage,
      reason: command.reason,
    }, state.task_id));
    const coverage = command.coverageChange;
    if (coverage) events.push(coverageChangedEvent(command, coverage, state.task_id, conflicting ? {
      mutation_history: "unknown",
      prewrite_enforcement: "unknown",
      operation_id: null,
      capability_id: null,
      exhaustive_surface: false,
      reason: `operation receipt conflict: ${coverage.reason}`,
    } : {}));
    return { events, result: { status: conflicting ? "conflict" : "completed" } };
  },
  "reconcile-artifacts"(state, command) {
    assertV3CommandState(state, command);
    if (!artifactEvidenceContract(state) || state.lifecycle?.state === "terminal") throw new Error("reconcile-artifacts requires a live artifact-evidence task");
    const values = {
      checkpoint_id: command.checkpointId,
      from_checkpoint: command.fromCheckpoint,
      to_checkpoint: command.toCheckpoint,
      captured_at_ms: command.capturedAtMs,
      changed_entries: command.changedEntries ?? [],
      changed_paths: command.changedPaths ?? [],
      current_scope_violations: command.currentScopeViolations ?? [],
      coverage: command.coverage,
      reason: command.reason,
    };
    const events = [v3Event(command, "artifact_reconciled", values, state.task_id)];
    if (command.coverageChange) events.push(coverageChangedEvent(command, command.coverageChange, state.task_id));
    return { events, result: { status: "reconciled" } };
  },
  "change-coverage"(state, command) {
    assertV3CommandState(state, command);
    if (!artifactEvidenceContract(state) || state.lifecycle?.state === "terminal") throw new Error("change-coverage requires a live artifact-evidence task");
    return { events: [coverageChangedEvent(command, command, state.task_id)], result: { status: "coverage_changed" } };
  },
  observe(state, command) {
    assertV3CommandState(state, command, { active: true });
    if (!isPlainObject(command.observation) || !OBSERVATION_VERDICTS.has(command.observation.verdict)) throw new Error("observe requires a valid observation");
    if (command.suspension !== undefined) throw new Error("observe suspension is derived, not injected");
    // The observation source (open|stop|achieve|cli_verify) and the lifecycle
    // source (cli|stop) answer different questions: a cli_verify observation's
    // suspension or closure is a CLI-initiated transition.
    const observationSource = command.source ?? "stop";
    const lifecycleSource = observationSource === "stop" ? "stop" : "cli";
    const events = [];
    let projected = state;
    if (command.transcriptRange) {
      const range = validateTranscriptRange(projected, command.transcriptRange);
      const tally = v3Event(command, "output_tokens_tallied", range, state.task_id);
      events.push(tally);
      projected = evolve(projected, tally);
    }
    const observed = v3Event(command, "criterion_observed", {
      observation: command.observation,
      attempt_id: command.attemptId,
      signature: command.signature,
      failure_summary: command.failureSummary ?? "",
      drift: command.drift ?? [],
      source: observationSource,
      checkpoint_id: artifactEvidenceContract(projected) ? projected.artifact_checkpoint.checkpoint_id : undefined,
      evidence_revision: artifactEvidenceContract(projected) ? projected.evidence.evidence_revision : undefined,
      event_cursor: artifactEvidenceContract(projected) ? projected.task_event_sequence + 1 : undefined,
    }, state.task_id, artifactEvidenceContract(projected) ? 2 : 1);
    events.push(observed);
    projected = evolve(projected, observed);
    if (command.observation.verdict === "satisfied") {
      const closure = closureProjection(projected, { drift: Boolean(command.drift?.length) });
      if (projected.policy.close_policy === "automatic" && closure?.state === "eligible") {
        events.push(v3Event(command, "task_terminal", {
          outcome: "achieved", evidence: null, reason: null, source: lifecycleSource,
          acting_session: command.actingSession ?? null,
        }, state.task_id));
        return { events, result: { status: "terminal", outcome: "achieved" } };
      }
    }
    const suspended = deriveAutoSuspension(command, projected, events, lifecycleSource);
    if (suspended) return { events, result: suspended };
    return { events, result: { status: "observed" } };
  },
  suspend(state, command) {
    assertV3CommandState(state, command, { active: true });
    if (!VALID_SUSPEND_OUTCOMES.has(command.reason) || !isPlainObject(command.judgment)) throw new Error("suspend requires a valid reason and judgment");
    const event = v3Event(command, "task_suspended", {
      reason: command.reason,
      judgment: command.judgment,
      close_episode: Boolean(command.closeEpisode),
      source: command.source ?? "cli",
      acting_session: command.actingSession ?? null,
    }, state.task_id);
    return { events: [event], result: { status: "suspended", reason: command.reason } };
  },
  resume(state, command) {
    assertV3CommandState(state, command);
    if (state.lifecycle?.state !== "suspended" || !String(command.reason ?? "").trim()) throw new Error("resume requires a suspended task and reason");
    requireMatchingEpoch(command, "resume");
    if (state.lifecycle.reason === "out_of_budget") {
      const exhausted = projectBudgetExhaustion(state, command.atEpochMs);
      if (exhausted.length) throw new Error(`increase exhausted budgets before resuming: ${exhausted.map((item) => item.dimension).join(", ")}`);
    }
    if (artifactEvidenceContract(state) && state.capability_leases.some((lease) => lease.status === "open")) throw new Error("resume cannot rotate an episode with an open operation lease");
    const episode = assertV3Episode(command.episode, "resume");
    if (episode.start_task_revision !== state.task_revision + 1) throw new Error("resume episode revision is not contiguous");
    const events = [v3Event(command, "task_resumed", { reason: command.reason, episode, acting_session: command.actingSession ?? null }, state.task_id)];
    if (artifactEvidenceContract(state)) events.push(episodeCoverageBoundaryEvent(state, command, episode));
    return { events, result: { status: "resumed" } };
  },
  join(state, command) {
    assertV3CommandState(state, command, { active: true });
    if (!String(command.reason ?? "").trim() || !String(command.actingSession ?? "").trim()) throw new Error("join requires a reason and acting session");
    if (artifactEvidenceContract(state) && state.capability_leases.some((lease) => lease.status === "open")) throw new Error("join cannot rotate an episode with an open operation lease");
    const episode = assertV3Episode(command.episode, "join");
    if (episode.host_session_id !== command.actingSession || episode.start_task_revision !== state.task_revision + 1) throw new Error("join episode does not bind the acting session and next revision");
    const events = [v3Event(command, "task_joined", { reason: command.reason, episode, acting_session: command.actingSession }, state.task_id)];
    if (artifactEvidenceContract(state)) events.push(episodeCoverageBoundaryEvent(state, command, episode));
    return { events, result: { status: "joined" } };
  },
  review(state, command) {
    assertV3CommandState(state, command);
    if (state.lifecycle?.state === "terminal") throw new Error("review does not mutate a terminal task");
    const runtimeContract = taskRuntimeContract(state);
    const record = assertV3ReviewRecord(runtimeContract >= 6
      ? { ...clone(command.record), reviewed_evidence_revision: state.evidence.evidence_revision }
      : command.record, { runtimeContract });
    if (record.criterion_generation_id !== state.criterion.criterion_generation_id) throw new Error("review must bind the current criterion generation");
    return { events: [v3Event(command, "review_recorded", { record }, state.task_id, runtimeContract >= 6 ? 2 : 1)], result: { status: "reviewed" } };
  },
  "accept-proof-gap"(state, command) {
    assertV3CommandState(state, command, { active: true });
    const record = command.record;
    if (projectProofAssurance(state).state === "adequate") throw new Error("criterion proof is already adequate");
    if (!isPlainObject(record) || !String(record.acceptance_id ?? "").trim() || !String(record.reason ?? "").trim() || !new Set(["user", "self"]).has(record.granted_by)) throw new Error("proof-gap acceptance requires a valid record");
    if (record.criterion_generation_id !== state.criterion.criterion_generation_id || record.accepted_at_task_revision !== state.task_revision + 1 || record.accepted_at !== command.at) throw new Error("proof-gap acceptance must bind the next task revision");
    return { events: [v3Event(command, "proof_gap_accepted", { record: clone(record) }, state.task_id)], result: { status: "proof_gap_accepted" } };
  },
  amend(state, command) {
    assertV3CommandState(state, command);
    if (!new Set(["active", "suspended"]).has(state.lifecycle?.state) || !String(command.reason ?? "").trim()) throw new Error("amend requires an active or suspended task and reason");
    let policyRationale = command.policyRationale;
    if (command.policy !== undefined) {
      const name = validatePolicy(command.policy);
      if (command.criterion === undefined && !String(command.generationId ?? "").trim()) throw new Error("policy-only amend requires a generationId");
      if (name !== "default") policyRationale = String(command.policyRationale ?? command.reason).trim();
    }
    const values = {
      reason: command.reason, goal: command.goal, alignment: command.alignment, envelope: command.envelope,
      grants: command.grants, rounds: command.rounds, writes: command.writes,
      wall_clock_minutes: command.wallClockMinutes, output_tokens: command.outputTokens,
      assurance: command.assurance, criterion: command.criterion, policy: command.policy, artifact_revision: state.artifact_revision,
      policy_rationale: policyRationale, generation_id: command.generationId,
      ...(artifactEvidenceContract(state) ? { history_requirement: command.historyRequirement ?? null } : {}),
    };
    const event = v3Event(command, "task_amended", values, state.task_id, artifactEvidenceContract(state) ? 2 : 1);
    const events = [event];
    if (artifactEvidenceContract(state) && command.envelope !== undefined) {
      const reclassification = command.scopeReclassification;
      if (!isPlainObject(reclassification)) throw new Error("artifact-evidence envelope amend requires scope reclassification");
      const checkpoint = state.artifact_checkpoint;
      if (
        reclassification.checkpointId !== checkpoint.checkpoint_id ||
        reclassification.capturedAtMs !== checkpoint.captured_at_ms ||
        reclassification.coverage !== state.evidence.artifact_state_coverage
      ) throw new Error("scope reclassification must preserve the current checkpoint evidence");
      events.push(v3Event(command, "artifact_reconciled", {
        checkpoint_id: checkpoint.checkpoint_id,
        from_checkpoint: checkpoint.checkpoint_id,
        to_checkpoint: checkpoint.checkpoint_id,
        captured_at_ms: checkpoint.captured_at_ms,
        changed_entries: [],
        changed_paths: [],
        current_scope_violations: reclassification.currentScopeViolations ?? [],
        coverage: reclassification.coverage,
        reason: reclassification.reason,
      }, state.task_id));
    } else if (command.scopeReclassification !== undefined) {
      throw new Error("scope reclassification requires an artifact-evidence envelope amend");
    }
    evolveAll(state, events);
    return { events, result: { status: "amended" } };
  },
  "criterion-side-effect"(state, command) {
    assertV3CommandState(state, command);
    if (!new Set(["active", "suspended"]).has(state.lifecycle?.state)) throw new Error("criterion-side-effect requires an active task");
    if (!isPlainObject(command.observation) || command.observation.verdict !== "indeterminate" || !command.observation.changed_paths?.length) throw new Error("criterion-side-effect requires an indeterminate mutation observation");
    const events = [];
    if (command.transcriptRange) {
      const range = validateTranscriptRange(state, command.transcriptRange);
      events.push(v3Event(command, "output_tokens_tallied", range, state.task_id));
    }
    let projected = events.length ? evolveAll(state, events) : state;
    if (artifactEvidenceContract(state)) {
      const reconciliation = command.reconciliation;
      if (!isPlainObject(reconciliation) || !isPlainObject(reconciliation.coverageChange)) throw new Error("Contract 6 criterion-side-effect requires artifact reconciliation");
      events.push(v3Event(command, "artifact_reconciled", {
        checkpoint_id: reconciliation.checkpointId,
        from_checkpoint: reconciliation.fromCheckpoint,
        to_checkpoint: reconciliation.toCheckpoint,
        captured_at_ms: reconciliation.capturedAtMs,
        changed_entries: reconciliation.changedEntries ?? [],
        changed_paths: reconciliation.changedPaths ?? [],
        current_scope_violations: reconciliation.currentScopeViolations ?? [],
        coverage: reconciliation.coverage,
        reason: reconciliation.reason,
      }, state.task_id));
      events.push(coverageChangedEvent(command, reconciliation.coverageChange, state.task_id));
      projected = evolveAll(state, events);
    }
    events.push(v3Event(command, "criterion_side_effect_recorded", {
      observation: command.observation,
      checkpoint_id: artifactEvidenceContract(state) ? projected.artifact_checkpoint.checkpoint_id : undefined,
      evidence_revision: artifactEvidenceContract(state) ? projected.evidence.evidence_revision : undefined,
      event_cursor: artifactEvidenceContract(state) ? state.task_event_sequence + events.length + 1 : undefined,
    }, state.task_id, artifactEvidenceContract(state) ? 2 : 1));
    return { events, result: { status: "criterion_side_effect_recorded" } };
  },
  achieve(state, command) {
    assertV3CommandState(state, command, { active: true });
    if (!isPlainObject(command.observation) || !OBSERVATION_VERDICTS.has(command.observation.verdict)) throw new Error("achieve requires a valid observation");
    const observed = v3Event(command, "criterion_observed", {
      observation: command.observation, attempt_id: command.attemptId, signature: command.signature,
      failure_summary: command.failureSummary ?? "", drift: command.drift ?? [], source: "achieve",
      checkpoint_id: artifactEvidenceContract(state) ? state.artifact_checkpoint.checkpoint_id : undefined,
      evidence_revision: artifactEvidenceContract(state) ? state.evidence.evidence_revision : undefined,
      event_cursor: artifactEvidenceContract(state) ? state.task_event_sequence + 1 : undefined,
    }, state.task_id, artifactEvidenceContract(state) ? 2 : 1);
    const projected = evolve(state, observed);
    const closure = closureProjection(projected, { drift: Boolean(command.drift?.length) });
    if (command.observation.verdict !== "satisfied" || closure?.state !== "eligible") {
      const events = [observed];
      const suspended = deriveAutoSuspension(command, projected, events, "cli");
      if (suspended) return { events, result: suspended };
      return { events, result: { status: "observed", closure } };
    }
    const terminal = v3Event(command, "task_terminal", { outcome: "achieved", evidence: null, reason: null, source: "cli", acting_session: command.actingSession ?? null }, state.task_id);
    return { events: [observed, terminal], result: { status: "terminal", outcome: "achieved" } };
  },
  "not-needed"(state, command) {
    assertV3CommandState(state, command, { active: true });
    if (!String(command.evidence ?? "").trim()) throw new Error("not-needed requires evidence");
    if (artifactEvidenceContract(state)) {
      const holds = [...artifactAssuranceHolds(state)];
      if (!projectReviewRequirement(state).accepted) holds.push("change_review_unaccepted");
      if (state.artifact_checkpoint.checkpoint_id !== state.artifact_baseline.checkpoint_id) holds.push("artifact_changed_since_baseline");
      if (hasSuccessfulCompletion(state)) holds.push("successful_completion_receipt_observed");
      if (holds.length) throw new Error(`not-needed assurance held: ${[...new Set(holds)].join(",")}`);
    } else if (state.spent.writes !== 0) throw new Error("not-needed requires no writes and evidence");
    const event = v3Event(command, "task_terminal", { outcome: "not_needed", evidence: command.evidence, reason: null, source: "cli", acting_session: command.actingSession ?? null }, state.task_id);
    return { events: [event], result: { status: "terminal", outcome: "not_needed" } };
  },
  abandon(state, command) {
    assertV3CommandState(state, command, { active: true });
    if (!String(command.reason ?? "").trim()) throw new Error("abandon requires reason");
    const event = v3Event(command, "task_terminal", { outcome: "abandoned", evidence: null, reason: command.reason, source: "cli", acting_session: command.actingSession ?? null }, state.task_id);
    return { events: [event], result: { status: "terminal", outcome: "abandoned" } };
  },
};

function decide(state, command) {
  if (!isPlainObject(command)) throw new Error("schema-v3 command must be an object");
  const decider = Object.hasOwn(V3_DECIDERS, command.type) ? V3_DECIDERS[command.type] : null;
  if (!decider) throw new Error(`unknown schema-v3 command: ${command.type ?? "unknown"}`);
  let projectionInputIsValid = state === null;
  if (state !== null) {
    try { assertV3TaskProjection(state); projectionInputIsValid = true; }
    catch { /* Pure domain fixtures may intentionally provide only reducer-relevant fields. */ }
  }
  const outcome = decider(state, command);
  // No caller may receive an event sequence that the authoritative reducer
  // rejects. Production persists only after a second preflight with exact
  // record timestamps and task sequences; this first pass keeps the domain
  // interface honest for every non-persisting caller too.
  if (outcome.events.length) {
    const projected = evolveAll(state, outcome.events);
    if (projectionInputIsValid) assertV3TaskProjection(projected);
  }
  return outcome;
}

function assertV3DomainEvent(event) {
  if (!isPlainObject(event) || !EVENT_KINDS.includes(event.kind)) throw new Error("invalid schema-v3 domain event");
  const fields = eventPayloadFields(event.kind, event.payload_version);
  if (!fields) throw new Error(`unsupported ${event.kind} payload version`);
  if (!String(event.task_id ?? "").trim()) throw new Error(`${event.kind} requires task_id`);
  if (!String(event.at ?? "").trim() || !Number.isFinite(Date.parse(event.at))) throw new Error(`${event.kind} requires event.at`);
  if (!isPlainObject(event.payload)) throw new Error(`${event.kind} requires payload`);
  const actual = Object.keys(event.payload).sort();
  const expected = [...fields].sort();
  const legacyExpected = event.kind === "task_amended" && event.payload_version === 1 ? expected.filter((field) => field !== "artifact_revision") : expected;
  if (JSON.stringify(actual) !== JSON.stringify(expected) && JSON.stringify(actual) !== JSON.stringify(legacyExpected)) throw new Error(`${event.kind} payload fields do not match schema`);
  return event;
}

function applyWriteMutation(next, files) {
  nextRevision(next, { artifact: true });
  next.spent.writes += 1;
  for (const file of files ?? []) if (!next.evidence.touched_files.includes(file)) next.evidence.touched_files.push(file);
}

function applyObservationMutation(next, { observation, at, source, attemptId, signature, failureSummary, checkpointId, evidenceRevision, eventCursor }) {
  if (!isPlainObject(observation) || !OBSERVATION_VERDICTS.has(observation.verdict)) throw new Error("observation mutation requires a valid observation");
  const applied = observe(next, { observation, at, source, checkpointId, evidenceRevision, eventCursor });
  next.unsatisfied_streak = applied.verdict === "unsatisfied" ? (next.unsatisfied_streak ?? 0) + 1 : 0;
  if (applied.verdict === "unsatisfied") {
    next.spent.rounds = Math.min(next.budget.rounds, next.spent.rounds + 1);
    next.attempts.push({
      attempt_id: attemptId,
      criterion_generation_id: next.criterion.criterion_generation_id,
      artifact_revision: next.artifact_revision,
      signature,
      failure_summary: failureSummary ?? "",
      observed_at: at,
    });
  }
  return applied;
}

function applySuspensionMutation(next, { reason, judgment, closeEpisode, source, actingSession, at }) {
  if (!VALID_SUSPEND_OUTCOMES.has(reason) || !isPlainObject(judgment)) throw new Error("invalid suspension");
  for (const key of ["remaining", "failure", "next_action"]) if (!String(judgment[key] ?? "").trim()) throw new Error(`suspension judgment requires ${key}`);
  nextRevision(next);
  next.lifecycle = { state: "suspended", reason, suspended_at: at, judgment: clone(judgment) };
  if (closeEpisode) closeCurrentEpisode(next, at);
  appendLifecycle(next, "suspend", source ?? "cli", actingSession, at, reason);
}

function advanceTaskClock(next, at) {
  next.updated_at = at;
  next.spent.wall_clock_ms = Math.max(next.spent.wall_clock_ms, Date.parse(at) - Date.parse(next.created_at));
}

const V3_REDUCERS = {
  task_opened(state, event) {
    if (state !== null && state.lifecycle?.state !== "terminal") throw new Error("task_opened requires empty or terminal schema-v3 state");
    const payload = event.payload;
    const next = createTask({
      taskId: event.task_id,
      goal: payload.goal,
      criterion: payload.criterion,
      observation: payload.observation,
      policyName: payload.policy_name,
      policyRationale: payload.policy_rationale,
      at: event.at,
      actingSession: payload.episodes?.[0]?.host_session_id ?? null,
      alignment: payload.alignment,
      envelope: payload.envelope,
      grants: payload.grants,
      assurance: payload.assurance,
      budget: payload.budget,
      episodes: payload.episodes,
      runtimeContract: event.payload_version >= 2 ? payload.runtime_contract : 5,
      artifactBaseline: payload.artifact_baseline,
      coverageBasis: payload.coverage_basis,
    });
    if (event.task_event_sequence !== undefined && event.task_event_sequence !== 1) throw new Error("task_opened must have task event sequence 1");
    return next;
  },
  output_tokens_tallied(state, event) {
    const range = validateTranscriptRange(state, event.payload);
    state.transcript_cursors[range.source_id] = {
      source_generation_id: range.source_generation_id,
      episode_id: range.episode_id,
      offset: range.to_offset,
      range_sha256: range.range_sha256,
      end_anchor_sha256: range.end_anchor_sha256,
    };
    state.spent.output_tokens_estimate += range.output_tokens_delta;
    const episode = state.episodes.at(-1);
    if (episode?.ended_at === null) episode.output_tokens_estimate += range.output_tokens_delta;
    // A tally moves the clock reading but is not work: it never advances the
    // wall-clock spend the way the other reducers do via advanceTaskClock.
    state.updated_at = event.at;
  },
  write_authorized(state, event) {
    if (state.lifecycle?.state !== "active") throw new Error("write_authorized requires an active task");
    if (taskRuntimeContract(state) === 6) {
      if (event.payload_version !== 2) throw new Error("Contract 6 write_authorized requires payload version 2");
      const payload = event.payload;
      if (!v3NonEmpty(payload.operation_id) || !v3Array(payload.declared_targets, v3RepoPath, { nonEmpty: true })) throw new Error("write_authorized requires operation identity and targets");
      const authorization = {
        tool_family: payload.tool_family,
        declared_targets: [...new Set(payload.declared_targets)],
        target_coverage: payload.target_coverage,
        host_profile: payload.host_profile,
        receipt_expectation: payload.receipt_expectation,
      };
      const existing = state.operations[payload.operation_id];
      if (existing?.authorization !== undefined && existing.authorization !== null) {
        if (JSON.stringify(existing.authorization) !== JSON.stringify(authorization)) throw new Error("conflicting write_authorized operation identity");
      } else {
        state.operations[payload.operation_id] = existing ?? { operation_id: payload.operation_id, authorization: null, completion: null };
        state.operations[payload.operation_id].authorization = authorization;
        state.authority.write_operations_authorized += 1;
        state.spent.writes += 1;
        nextRevision(state);
      }
    } else {
      if (event.payload_version !== 1 || !Array.isArray(event.payload.files) || !event.payload.files.length || event.payload.files.some((file) => !String(file ?? "").trim())) throw new Error("write_authorized requires files");
      applyWriteMutation(state, event.payload.files);
    }
    advanceTaskClock(state, event.at);
  },
  operation_intent_recorded(state, event) {
    if (taskRuntimeContract(state) !== 7 || state.lifecycle?.state !== "active") throw new Error("operation_intent_recorded requires an active Contract 7 task");
    const payload = event.payload;
    const intent = {
      tool_family: payload.tool_family,
      declared_targets: [...new Set(payload.declared_targets)],
      target_coverage: payload.target_coverage,
      host_profile: payload.host_profile,
      receipt_expectation: payload.receipt_expectation,
      policy_mode: payload.policy_mode,
      policy_disposition: payload.policy_disposition,
      policy_reasons: [...new Set(payload.policy_reasons)],
      session_relation: payload.session_relation,
    };
    const existing = state.operations[payload.operation_id];
    if (existing?.intent !== undefined && existing.intent !== null) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) throw new Error("conflicting operation_intent_recorded identity");
    } else {
      state.operations[payload.operation_id] = existing ?? { operation_id: payload.operation_id, intent: null, completion: null };
      state.operations[payload.operation_id].intent = intent;
      state.authority.operation_intents_observed += 1;
      state.spent.writes += 1;
      nextRevision(state);
    }
    advanceTaskClock(state, event.at);
  },
  tool_completed(state, event) {
    if (!artifactEvidenceContract(state) || state.lifecycle?.state === "terminal") throw new Error("tool_completed requires a live artifact-evidence task");
    const payload = event.payload;
    if (!v3NonEmpty(payload.operation_id)) throw new Error("tool_completed requires operation identity");
    const completion = {
      tool_family: payload.tool_family,
      outcome: payload.outcome,
      reported_targets: [...new Set(payload.reported_targets)],
      receipt_quality: payload.receipt_quality,
      host_profile: payload.host_profile,
    };
    const operation = state.operations[payload.operation_id] ?? (taskRuntimeContract(state) === 7
      ? { operation_id: payload.operation_id, intent: null, completion: null }
      : { operation_id: payload.operation_id, authorization: null, completion: null });
    const evidence = operationEvidence(operation, state);
    if (evidence !== null && (
      evidence.tool_family !== completion.tool_family || evidence.host_profile !== completion.host_profile
    )) throw new Error(taskRuntimeContract(state) === 7
      ? "tool_completed does not match its operation intent"
      : "tool_completed does not match its operation authorization");
    if (operation.completion !== null) {
      if (JSON.stringify(operation.completion) !== JSON.stringify(completion)) throw new Error("conflicting tool_completed operation identity");
    } else {
      operation.completion = completion;
      state.operations[payload.operation_id] = operation;
      state.evidence.tool_completions_observed += 1;
      if (evidence === null) {
        state.evidence.evidence_revision += 1;
        state.evidence.mutation_history_coverage = "unknown";
        setPreExecutionCoverage(state, "unknown");
      }
      nextRevision(state);
    }
    advanceTaskClock(state, event.at);
  },
  artifact_reconciled(state, event) {
    if (!artifactEvidenceContract(state) || state.lifecycle?.state === "terminal") throw new Error("artifact_reconciled requires a live artifact-evidence task");
    const payload = event.payload;
    if (payload.from_checkpoint !== state.artifact_checkpoint.checkpoint_id) throw new Error("artifact_reconciled from_checkpoint is stale");
    if (payload.checkpoint_id !== payload.to_checkpoint) throw new Error("artifact_reconciled checkpoint identity is inconsistent");
    if (!v3Integer(payload.captured_at_ms) || payload.captured_at_ms < state.artifact_checkpoint.captured_at_ms) throw new Error("artifact_reconciled capture time is invalid or regressed");
    const deltaPaths = payload.changed_entries.map((change) => change.path);
    const expectedPaths = [...new Set(deltaPaths)].sort();
    if (
      deltaPaths.length !== expectedPaths.length ||
      JSON.stringify(deltaPaths) !== JSON.stringify(expectedPaths) ||
      JSON.stringify(payload.changed_paths) !== JSON.stringify(expectedPaths)
    ) throw new Error("artifact_reconciled changed paths must exactly match its ordered delta entries");
    let evidenceRevisionChanged = false;
    if (payload.to_checkpoint !== payload.from_checkpoint) {
      const entries = new Map(state.artifact_checkpoint.entries.map((entry) => [entry.path, { kind: entry.kind, hash: entry.hash }]));
      for (const change of payload.changed_entries) {
        const before = entries.get(change.path) ?? null;
        if (JSON.stringify(before) !== JSON.stringify(change.before)) throw new Error("artifact_reconciled delta does not match current checkpoint");
        if (change.after === null) entries.delete(change.path);
        else {
          if (!new Set(["file", "symlink"]).has(change.after.kind) || !v3Digest(change.after.hash)) throw new Error("artifact_reconciled delta has invalid after state");
          entries.set(change.path, clone(change.after));
        }
      }
      const nextEntries = [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([entryPath, entry]) => ({ path: entryPath, ...entry }));
      if (artifactCheckpointId(nextEntries) !== payload.to_checkpoint) throw new Error("artifact_reconciled delta does not produce to_checkpoint");
      state.artifact_checkpoint = { checkpoint_id: payload.to_checkpoint, captured_at_ms: payload.captured_at_ms, entries: nextEntries };
      nextRevision(state, { artifact: true });
      state.evidence.evidence_revision += 1;
      evidenceRevisionChanged = true;
      if (state.evidence.mutation_history_coverage === "full") state.evidence.mutation_history_coverage = "unknown";
      if (preExecutionCoverage(state) === "full") setPreExecutionCoverage(state, "unknown");
      for (const file of payload.changed_paths) if (!state.evidence.touched_files.includes(file)) state.evidence.touched_files.push(file);
    } else if (payload.changed_entries.length || payload.changed_paths.length) throw new Error("artifact_reconciled no-op cannot contain changes");
    state.artifact_checkpoint.captured_at_ms = payload.captured_at_ms;
    const nextScopeViolations = [...new Set(payload.current_scope_violations)].sort();
    if (!evidenceRevisionChanged && (
      JSON.stringify(nextScopeViolations) !== JSON.stringify(state.evidence.current_scope_violations) ||
      payload.coverage !== state.evidence.artifact_state_coverage
    )) state.evidence.evidence_revision += 1;
    state.evidence.current_scope_violations = nextScopeViolations;
    state.evidence.artifact_state_coverage = payload.coverage;
    advanceTaskClock(state, event.at);
  },
  coverage_changed(state, event) {
    if (!artifactEvidenceContract(state) || state.lifecycle?.state === "terminal") throw new Error("coverage_changed requires a live artifact-evidence task");
    const payload = event.payload;
    const currentEpisode = state.episodes.at(-1);
    if (payload.episode_id !== currentEpisode?.episode_id) throw new Error("coverage_changed must bind the current episode");
    if (payload.effective_from_checkpoint !== payload.interval_from_checkpoint) throw new Error("coverage_changed effective checkpoint is inconsistent");
    if (payload.interval_to_checkpoint === null && payload.interval_from_checkpoint !== state.artifact_checkpoint.checkpoint_id) throw new Error("coverage_changed lease must start at the current checkpoint");
    if (payload.interval_to_checkpoint !== null && payload.interval_to_checkpoint !== state.artifact_checkpoint.checkpoint_id) throw new Error("coverage_changed interval must end at the current checkpoint");
    if (state.coverage_intervals.some((interval) => JSON.stringify(interval) === JSON.stringify(payload))) {
      advanceTaskClock(state, event.at);
      return;
    }
    if (payload.mutation_history === "full" && state.coverage_intervals.some((interval) => interval.mutation_history !== "full")) {
      throw new Error("coverage_changed cannot upgrade degraded mutation history");
    }
    if (payload.mutation_history === "full" && (!payload.exhaustive_surface || payload.artifact_state !== "full" || payload.prewrite_enforcement !== "full")) {
      throw new Error("full mutation history requires an exhaustive surface with full artifact and prewrite coverage");
    }
    if (payload.mutation_history === "full" && (payload.operation_id === null || payload.capability_id === null)) {
      throw new Error("full mutation history requires an operation-scoped capability lease");
    }
    if (payload.mutation_history === "full" && state.episodes.length !== 1) throw new Error("full mutation history cannot span an episode boundary");
    if (payload.mutation_history === "full" && payload.interval_to_checkpoint === null && state.evidence.mutation_history_coverage !== "full" && (
      state.artifact_revision !== 0 || state.artifact_checkpoint.checkpoint_id !== state.artifact_baseline.checkpoint_id
    )) throw new Error("full mutation history cannot be established after an unowned artifact revision");
    if (payload.operation_id === null && payload.capability_id !== null) throw new Error("coverage_changed capability requires an operation");
    if (payload.operation_id !== null && payload.capability_id === null) throw new Error("coverage_changed operation requires a capability");
    if (payload.operation_id !== null && payload.exhaustive_surface) {
      const existing = state.capability_leases.find((lease) => lease.operation_id === payload.operation_id);
      if (payload.interval_to_checkpoint === null) {
        if (state.capability_leases.some((lease) => lease.status === "open")) throw new Error("coverage_changed cannot open concurrent operation leases");
        if (existing) throw new Error("coverage_changed operation lease already exists");
        state.capability_leases.push({
          episode_id: payload.episode_id,
          operation_id: payload.operation_id,
          capability_id: payload.capability_id,
          host_profile: payload.host_profile,
          surface: payload.surface,
          exhaustive_surface: payload.exhaustive_surface,
          effective_from_checkpoint: payload.effective_from_checkpoint,
          closed_at_checkpoint: null,
          status: "open",
        });
      } else {
        if (!existing || existing.status !== "open" || existing.episode_id !== payload.episode_id || existing.capability_id !== payload.capability_id ||
          existing.host_profile !== payload.host_profile || existing.surface !== payload.surface || existing.exhaustive_surface !== payload.exhaustive_surface ||
          existing.effective_from_checkpoint !== payload.interval_from_checkpoint) {
          throw new Error("coverage_changed cannot close an unmatched operation lease");
        }
        existing.closed_at_checkpoint = payload.interval_to_checkpoint;
        existing.status = "closed";
      }
    }
    const prior = {
      artifact_state: state.evidence.artifact_state_coverage,
      mutation_history: state.evidence.mutation_history_coverage,
      prewrite_enforcement: preExecutionCoverage(state),
    };
    state.evidence.artifact_state_coverage = payload.artifact_state;
    state.evidence.mutation_history_coverage = payload.mutation_history;
    setPreExecutionCoverage(state, payload.prewrite_enforcement);
    state.coverage_intervals.push(clone(payload));
    if (payload.mutation_history === "full") assertFullMutationHistoryInvariant(state);
    if (prior.artifact_state !== payload.artifact_state || prior.mutation_history !== payload.mutation_history || prior.prewrite_enforcement !== payload.prewrite_enforcement) {
      state.evidence.evidence_revision += 1;
    }
    nextRevision(state);
    advanceTaskClock(state, event.at);
  },
  criterion_observed(state, event) {
    if (state.lifecycle?.state !== "active") throw new Error("criterion_observed requires an active task");
    const payload = event.payload;
    if (payload.observation?.verdict === "unsatisfied" && !String(payload.attempt_id ?? "").trim()) {
      throw new Error("unsatisfied criterion_observed requires attempt identity");
    }
    if (artifactEvidenceContract(state) && (
      payload.checkpoint_id !== state.artifact_checkpoint.checkpoint_id ||
      payload.evidence_revision !== state.evidence.evidence_revision ||
      payload.event_cursor !== state.task_event_sequence + 1
    )) throw new Error("criterion_observed assurance binding is stale");
    applyObservationMutation(state, {
      observation: payload.observation, at: event.at, source: payload.source, attemptId: payload.attempt_id,
      signature: payload.signature, failureSummary: payload.failure_summary,
      checkpointId: payload.checkpoint_id, evidenceRevision: payload.evidence_revision, eventCursor: payload.event_cursor,
    });
    advanceTaskClock(state, event.at);
  },
  task_suspended(state, event) {
    if (state.lifecycle?.state !== "active") throw new Error("task_suspended requires an active task");
    const payload = event.payload;
    applySuspensionMutation(state, { reason: payload.reason, judgment: payload.judgment, closeEpisode: payload.close_episode, source: payload.source, actingSession: payload.acting_session, at: event.at });
    advanceTaskClock(state, event.at);
  },
  task_resumed(state, event) {
    if (state.lifecycle?.state !== "suspended" || !String(event.payload.reason ?? "").trim()) throw new Error("task_resumed requires a suspended task and reason");
    if (state.lifecycle.reason === "out_of_budget") {
      const exhausted = projectBudgetExhaustion(state, Date.parse(event.at));
      if (exhausted.length) throw new Error(`task_resumed has exhausted budgets: ${exhausted.map((item) => item.dimension).join(", ")}`);
    }
    if (artifactEvidenceContract(state) && state.capability_leases.some((lease) => lease.status === "open")) throw new Error("task_resumed cannot rotate an episode with an open operation lease");
    const episode = assertV3Episode(event.payload.episode, "task_resumed");
    if (episode.start_task_revision !== state.task_revision + 1) throw new Error("task_resumed episode revision is not contiguous");
    nextRevision(state);
    closeCurrentEpisode(state, event.at);
    state.lifecycle = { state: "active" };
    state.episodes.push(episode);
    invalidateEpisodeCoverage(state);
    appendLifecycle(state, "resume", "cli", event.payload.acting_session, event.at, event.payload.reason);
    advanceTaskClock(state, event.at);
  },
  task_joined(state, event) {
    if (state.lifecycle?.state !== "active" || !String(event.payload.reason ?? "").trim() || !String(event.payload.acting_session ?? "").trim()) throw new Error("task_joined requires an active task, reason, and session");
    const episode = assertV3Episode(event.payload.episode, "task_joined");
    if (episode.host_session_id !== event.payload.acting_session || episode.start_task_revision !== state.task_revision + 1) throw new Error("task_joined episode binding is invalid");
    if (artifactEvidenceContract(state) && state.capability_leases.some((lease) => lease.status === "open")) throw new Error("task_joined cannot rotate an episode with an open operation lease");
    nextRevision(state);
    closeCurrentEpisode(state, event.at);
    state.episodes.push(episode);
    invalidateEpisodeCoverage(state);
    appendLifecycle(state, "join", "cli", event.payload.acting_session, event.at, event.payload.reason);
    advanceTaskClock(state, event.at);
  },
  review_recorded(state, event) {
    if (state.lifecycle?.state === "terminal") throw new Error("review_recorded does not mutate a terminal task");
    const runtimeContract = taskRuntimeContract(state);
    const record = assertV3ReviewRecord(event.payload.record, { runtimeContract });
    if (record.criterion_generation_id !== state.criterion.criterion_generation_id) throw new Error("review_recorded does not bind the current criterion");
    if (runtimeContract >= 6 && record.reviewed_evidence_revision !== state.evidence.evidence_revision) throw new Error("review_recorded does not bind current evidence");
    nextRevision(state);
    state.reviews.push(record);
    advanceTaskClock(state, event.at);
  },
  proof_gap_accepted(state, event) {
    if (state.lifecycle?.state !== "active") throw new Error("proof_gap_accepted requires an active task");
    const record = event.payload.record;
    if (!isPlainObject(record) || !String(record.reason ?? "").trim() || record.criterion_generation_id !== state.criterion.criterion_generation_id || record.accepted_at_task_revision !== state.task_revision + 1) throw new Error("proof_gap_accepted record binding is invalid");
    nextRevision(state, { substantive: true });
    state.assurance.proof_gap_acceptances.push(clone(record));
    advanceTaskClock(state, event.at);
  },
  task_amended(state, event) {
    if (!new Set(["active", "suspended"]).has(state.lifecycle?.state) || !String(event.payload.reason ?? "").trim()) throw new Error("task_amended requires an active or suspended task and reason");
    const payload = event.payload;
    if (payload.artifact_revision !== undefined && payload.artifact_revision !== state.artifact_revision) throw new Error("task_amended artifact_revision must bind the pre-amend artifact state");
    nextRevision(state, { substantive: true });
    if (payload.goal !== null) state.goal = payload.goal;
    if (payload.alignment !== null) state.alignment = clone(payload.alignment);
    if (payload.envelope !== null) state.envelope = clone(payload.envelope);
    if (payload.grants !== null) state.grants.push(...clone(payload.grants));
    if (payload.rounds !== null) state.budget.rounds = payload.rounds;
    if (payload.writes !== null) state.budget.writes = payload.writes;
    if (payload.wall_clock_minutes !== null) state.budget.wall_clock_minutes = payload.wall_clock_minutes;
    if (payload.output_tokens !== null) state.budget.output_tokens = payload.output_tokens;
    if (payload.assurance !== null) { validateAssurance(payload.assurance); state.assurance = clone(payload.assurance); }
    if (event.payload_version === 2 && payload.history_requirement !== null) {
      if (!new Set(["artifact_only", "complete"]).has(payload.history_requirement)) throw new Error("task_amended history_requirement is invalid");
      if (state.history_requirement === "complete" && payload.history_requirement === "artifact_only") throw new Error("cannot relax complete mutation history to artifact-only");
      state.history_requirement = payload.history_requirement;
    }
    assertHistoryRequirementInvariant(state);
    assertWriteBudgetInvariant(state);
    if (payload.criterion !== null || payload.policy !== null) {
      if (payload.criterion !== null) state.criterion = { ...clone(payload.criterion), authored_by: payload.criterion.authored_by ?? "self", last_observation: null };
      else {
        if (!String(payload.generation_id ?? "").trim()) throw new Error("policy-only task_amended requires generation_id");
        state.criterion.criterion_generation_id = payload.generation_id;
        state.criterion.last_observation = null;
      }
      if (payload.policy !== null) {
        const name = validatePolicy(payload.policy);
        if (name !== "default" && !String(payload.policy_rationale ?? "").trim()) throw new Error("non-default task_amended policy requires policy_rationale");
        state.policy = clone(payload.policy);
        state.policy_rationale = name === "default" ? null : payload.policy_rationale;
      }
      state.witness = null;
      state.reviews = [];
    }
    advanceTaskClock(state, event.at);
  },
  criterion_side_effect_recorded(state, event) {
    if (!new Set(["active", "suspended"]).has(state.lifecycle?.state) || event.payload.observation?.verdict !== "indeterminate" || !event.payload.observation?.changed_paths?.length) throw new Error("criterion_side_effect_recorded requires an active task and mutation observation");
    if (artifactEvidenceContract(state) && (
      event.payload.checkpoint_id !== state.artifact_checkpoint.checkpoint_id ||
      event.payload.evidence_revision !== state.evidence.evidence_revision ||
      event.payload.event_cursor !== state.task_event_sequence + 1
    )) throw new Error("criterion_side_effect_recorded assurance binding is stale");
    nextRevision(state, artifactEvidenceContract(state) ? { substantive: true } : { artifact: true });
    state.criterion.last_observation = {
      ...clone(event.payload.observation),
      criterion_generation_id: state.criterion.criterion_generation_id,
      observed_artifact_revision: state.artifact_revision,
      ...(artifactEvidenceContract(state) ? {
        observed_checkpoint_id: event.payload.checkpoint_id,
        observed_evidence_revision: event.payload.evidence_revision,
        observed_event_cursor: event.payload.event_cursor,
      } : {}),
    };
    for (const file of event.payload.observation.changed_paths) if (!state.evidence.touched_files.includes(file)) state.evidence.touched_files.push(file);
    advanceTaskClock(state, event.at);
  },
  task_terminal(state, event) {
    if (state.lifecycle?.state !== "active" || !TERMINAL_OUTCOMES.has(event.payload.outcome)) throw new Error("task_terminal requires an active task and valid outcome");
    const payload = event.payload;
    if (payload.outcome === "achieved") {
      const observation = state.criterion.last_observation;
      if (observation?.verdict !== "satisfied" || closureProjection(state)?.state !== "eligible") throw new Error("achieved task_terminal requires eligible satisfied evidence");
      nextRevision(state);
      state.lifecycle = {
        state: "terminal", outcome: "achieved", terminal_at: event.at,
        closing_observation_id: observation.observation_id,
        proof_provisional: projectProofAssurance(state).state === "provisional",
        evidence: null, verified_at_task_revision: null, reason: null,
      };
    } else if (payload.outcome === "not_needed") {
      if (!String(payload.evidence ?? "").trim()) throw new Error("not_needed task_terminal requires evidence");
      if (artifactEvidenceContract(state)) {
        const holds = [...artifactAssuranceHolds(state)];
        if (!projectReviewRequirement(state).accepted) holds.push("change_review_unaccepted");
        if (state.artifact_checkpoint.checkpoint_id !== state.artifact_baseline.checkpoint_id) holds.push("artifact_changed_since_baseline");
        if (hasSuccessfulCompletion(state)) holds.push("successful_completion_receipt_observed");
        if (holds.length) throw new Error(`not_needed task_terminal assurance held: ${[...new Set(holds)].join(",")}`);
      } else if (state.spent.writes !== 0) throw new Error("not_needed task_terminal requires no writes and evidence");
      nextRevision(state);
      state.lifecycle = {
        state: "terminal", outcome: "not_needed", terminal_at: event.at,
        closing_observation_id: null, proof_provisional: null, evidence: payload.evidence,
        verified_at_task_revision: state.task_revision, reason: null,
      };
    } else {
      if (!String(payload.reason ?? "").trim()) throw new Error("abandoned task_terminal requires reason");
      nextRevision(state);
      state.lifecycle = {
        state: "terminal", outcome: "abandoned", terminal_at: event.at,
        closing_observation_id: null, proof_provisional: null, evidence: null,
        verified_at_task_revision: null, reason: payload.reason,
      };
    }
    closeCurrentEpisode(state, event.at);
    appendLifecycle(state, payload.outcome === "not_needed" ? "not_needed" : payload.outcome === "abandoned" ? "abandon" : "achieve", payload.source, payload.acting_session, event.at, payload.reason);
    advanceTaskClock(state, event.at);
  },
};

function evolveInto(state, event) {
  assertV3DomainEvent(event);
  if (event.kind === "task_opened") return V3_REDUCERS.task_opened(state, event);
  if (state === null) throw new Error(`${event.kind} requires schema-v3 state`);
  if (state.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION || state.task_id !== event.task_id) throw new Error(`${event.kind} does not match schema-v3 state`);
  const runtimeContract = taskRuntimeContract(state);
  if (runtimeContract === 5 && (!V3_EVENT_KINDS.includes(event.kind) || event.payload_version !== 1)) throw new Error(`${event.kind} is incompatible with Contract 5`);
  if (runtimeContract === 6) {
    const expectedVersion = new Set(["write_authorized", "criterion_observed", "criterion_side_effect_recorded", "task_amended", "review_recorded"]).has(event.kind) ? 2 : 1;
    if (event.payload_version !== expectedVersion) throw new Error(`${event.kind} is incompatible with Contract 6`);
  }
  if (runtimeContract === 7) {
    const expectedVersion = new Set(["criterion_observed", "criterion_side_effect_recorded", "task_amended", "review_recorded"]).has(event.kind) ? 2 : 1;
    if (event.payload_version !== expectedVersion || event.kind === "write_authorized") throw new Error(`${event.kind} is incompatible with Contract 7`);
  }
  const expectedSequence = state.task_event_sequence + 1;
  if (event.task_event_sequence !== undefined && event.task_event_sequence !== expectedSequence) throw new Error(`${event.kind} task event sequence is not contiguous`);
  const reducer = Object.hasOwn(V3_REDUCERS, event.kind) ? V3_REDUCERS[event.kind] : null;
  if (!reducer) throw new Error(`schema-v3 reducer does not yet support ${event.kind}`);
  reducer(state, event);
  state.task_event_sequence = expectedSequence;
  return state;
}

function evolve(state, event) {
  return evolveInto(state === null ? null : clone(state), event);
}

function evolveAll(state, events) {
  if (!Array.isArray(events)) throw new Error("schema-v3 replay requires an event array");
  let next = state === null ? null : clone(state);
  for (const event of events) next = evolveInto(next, event);
  return next;
}

function observe(next, event) {
  const observation = clone(event.observation);
  if (!OBSERVATION_VERDICTS.has(observation.verdict)) throw new Error(`invalid observation: ${observation.verdict}`);
  observation.criterion_generation_id = next.criterion.criterion_generation_id;
  observation.observed_artifact_revision = next.artifact_revision;
  if (artifactEvidenceContract(next)) {
    observation.observed_checkpoint_id = event.checkpointId;
    observation.observed_evidence_revision = event.evidenceRevision;
    observation.observed_event_cursor = event.eventCursor;
  }
  next.criterion.last_observation = observation;
  if (observation.verdict === "unsatisfied" && next.policy.witness_requirement === "required") {
    next.witness = {
      criterion_generation_id: next.criterion.criterion_generation_id,
      observed_at: event.at,
      source_event: event.source,
    };
  }
  return observation;
}

function closeCurrentEpisode(next, at) {
  const episode = next.episodes.at(-1);
  if (!episode || episode.ended_at !== null) return;
  episode.ended_at = at;
  episode.end_task_revision = next.task_revision;
}

function validateAssurance(value) {
  if (!isPlainObject(value) || !RISK_ORDER.includes(value.declared_risk)) throw new Error("invalid assurance risk");
  if (!new Set(["default", "self", "user"]).has(value.risk_declared_by)) throw new Error("invalid risk provenance");
  if (!Array.isArray(value.change_classes) || value.change_classes.some((item) => !new Set(["internal", "public_contract", "schema", "security", "permissions", "migration"]).has(item))) throw new Error("invalid change class");
  if (!new Set(["risk_based", "required", "waived"]).has(value.review_policy)) throw new Error("invalid review policy");
  if (new Set(["routine", "critical"]).has(value.declared_risk) && !String(value.risk_reason ?? "").trim()) throw new Error(`${value.declared_risk} risk requires a reason`);
  if (value.review_policy === "required" && !REVIEW_ORDER.includes(value.required_review_level)) throw new Error("required review policy requires a level");
  if (value.review_policy === "waived" && !String(value.review_waiver_reason ?? "").trim()) throw new Error("waived review policy requires a reason");
  if (value.review_policy === "waived" && !new Set(["self", "user"]).has(value.review_waiver_granted_by)) throw new Error("invalid review waiver provenance");
  if (!Array.isArray(value.proof_gap_acceptances)) throw new Error("invalid proof gap acceptances");
  for (const row of value.proof_gap_acceptances) if (!String(row.criterion_generation_id ?? "") || !String(row.reason ?? "").trim() || !new Set(["user", "self"]).has(row.granted_by)) throw new Error("invalid proof gap acceptance");
  if (!Array.isArray(value.risk_floor_events)) throw new Error("invalid risk floor events");
  if (value.risk_floor_events.some((item) => !new Set(["criterion_amend", "policy_amend", "criterion_amended_after_write", "policy_amended_after_write"]).has(item))) throw new Error("invalid risk floor event");
  return value;
}

export {
  POLICY_PRESETS,
  artifactAssuranceHolds,
  assertV3TaskProjection,
  closureProjection,
  constructAssurance,
  constructPolicy,
  criterionDefinitionHash,
  createTask,
  decide,
  evolve,
  evolveAll,
  machineRiskFloor,
  policyName,
  projectAssurance,
  projectBudgetExhaustion,
  projectProofAssurance,
  projectReviewRequirement,
  validateAssurance,
  validatePolicy,
};
