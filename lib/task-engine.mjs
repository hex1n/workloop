// Canonical task state model. This leaf is deliberately pure: application.mjs
// owns I/O, while every lifecycle mutation and closure decision lives here.

import {
  DEFAULT_ROUNDS,
  NO_PROGRESS_STOPS,
  OBSERVATION_VERDICTS,
  REVIEW_LEVELS,
  STUCK_REPEATS,
  TERMINAL_OUTCOMES,
  VALID_SUSPEND_OUTCOMES,
  V3_EVENT_KINDS,
  V3_EVENT_PAYLOAD_FIELDS,
  V3_TASK_SNAPSHOT_SCHEMA_VERSION,
  fnv1aHex,
  isPlainObject,
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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
  if (task.criterion.provenance !== "repo") reasons.push("criterion_provenance");
  if (task.criterion.input_coverage !== "full") reasons.push("criterion_input_coverage");
  if (drift) reasons.push("criterion_input_drift");
  if (!reasons.length) return { state: "adequate", reasons: [], acceptance: null };
  const acceptance = !drift ? (task.assurance?.proof_gap_acceptances ?? []).find((row) =>
    row.criterion_generation_id === task.criterion.criterion_generation_id && String(row.reason ?? "").trim()
  ) ?? null : null;
  return { state: acceptance ? "provisional" : "gap", reasons, acceptance };
}

function machineRiskFloor(task) {
  let risk = "routine";
  const reasons = [];
  const criticalGrants = new Set(["destructive", "whole_repo", "publish"]);
  const substantialGrants = new Set(["network", "install", "git", "criterion_subject"]);
  for (const grant of task.grants ?? []) {
    if (criticalGrants.has(grant.kind)) { risk = "critical"; reasons.push(`${grant.kind}_grant`); }
    else if (substantialGrants.has(grant.kind)) { risk = riskMax(risk, "substantial"); reasons.push(`${grant.kind}_grant`); }
  }
  const criticalClasses = new Set(["public_contract", "schema", "security", "permissions", "migration"]);
  for (const item of task.assurance?.change_classes ?? []) {
    if (criticalClasses.has(item)) { risk = "critical"; reasons.push(item); }
  }
  if ((task.assurance?.proof_gap_acceptances ?? []).length) { risk = riskMax(risk, "substantial"); reasons.push("proof_gap_acceptance"); }
  for (const item of task.assurance?.risk_floor_events ?? []) {
    risk = riskMax(risk, "substantial"); reasons.push(item);
  }
  const roots = new Set((task.envelope?.files ?? []).map((item) => String(item).split("/")[0]).filter((item) => item && !item.includes("*")));
  if (roots.size > 1 && risk === "routine") { risk = "substantial"; reasons.push("multiple_envelope_roots"); }
  if ((task.evidence?.touched_files ?? []).length > 10 && risk === "routine") { risk = "substantial"; reasons.push("many_touched_files"); }
  return { risk, reasons: [...new Set(reasons)] };
}

function acceptedReview(task, level) {
  const minimum = REVIEW_ORDER.indexOf(level);
  return (task.reviews ?? []).find((review) =>
    review.criterion_generation_id === task.criterion.criterion_generation_id &&
    review.reviewed_task_revision === task.last_substantive_task_revision &&
    review.reviewed_artifact_revision === task.artifact_revision &&
    REVIEW_ORDER.indexOf(review.level) >= minimum && review.blocking_findings_count === 0
  ) ?? null;
}

function projectReviewRequirement(task, { ignoreLifecycle = false } = {}) {
  if (!ignoreLifecycle && task.lifecycle?.state !== "active") return { level: null, reasons: ["lifecycle_not_active"], accepted: true, waived: false, applicable: false };
  const assurance = task.assurance;
  if (assurance.review_policy === "waived") return { level: null, reasons: ["review_waived"], accepted: true, waived: true };
  const floor = machineRiskFloor(task);
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

function closureProjection(task, { drift = false } = {}) {
  if (task.lifecycle?.state !== "active") return null;
  const observation = task.criterion?.last_observation;
  if (!observation || observation.criterion_generation_id !== task.criterion.criterion_generation_id) {
    return { state: "not_ready", reason: "criterion_unobserved" };
  }
  if (observation.verdict === "unsatisfied") return { state: "not_ready", reason: "criterion_unsatisfied" };
  if (observation.verdict === "indeterminate") return { state: "not_ready", reason: "criterion_indeterminate" };
  const holds = [];
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
const V3_TASK_PROJECTION_FIELDS = [
  "schema_version", "task_id", "task_revision", "last_substantive_task_revision", "artifact_revision",
  "created_at", "updated_at", "lifecycle", "goal", "criterion", "policy", "policy_rationale", "witness",
  "alignment", "envelope", "grants", "assurance", "budget", "spent", "evidence", "reviews", "attempts",
  "unsatisfied_streak", "episodes", "lifecycle_log", "task_event_sequence", "transcript_cursors",
];

function exactV3Object(value, fields, label) {
  if (!isPlainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`invalid schema-v3 ${label} fields`);
  }
  return value;
}

function v3Uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value ?? "")); }
function v3Digest(value) { return /^sha256:[0-9a-f]{64}$/.test(String(value ?? "")); }
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

function assertV3Observation(value) {
  exactV3Object(value, ["observation_id", "verdict", "criterion_generation_id", "observed_artifact_revision", "observed_at", "execution", "changed_paths"], "observation");
  if (!v3Uuid(value.observation_id) || !OBSERVATION_VERDICTS.has(value.verdict) || !v3Nullable(value.criterion_generation_id, v3Uuid) || !v3Nullable(value.observed_artifact_revision, (item) => v3Integer(item)) || !v3Utc(value.observed_at) || !v3Array(value.changed_paths, v3RepoPath)) throw new Error("invalid schema-v3 observation");
  exactV3Object(value.execution, ["exit_code", "signal", "duration_ms", "execution_error", "output_tail", "timeout_seconds"], "observation execution");
  if (!v3Nullable(value.execution.exit_code, (item) => Number.isSafeInteger(item)) || !v3Nullable(value.execution.signal, v3NonEmpty) || !v3Integer(value.execution.duration_ms) || !v3Nullable(value.execution.execution_error, v3NonEmpty) || typeof value.execution.output_tail !== "string" || Buffer.byteLength(value.execution.output_tail, "utf8") > 4096 || !v3Integer(value.execution.timeout_seconds, 1)) throw new Error("invalid schema-v3 observation execution");
}

function assertV3Criterion(value) {
  exactV3Object(value, ["source", "protocol", "timeout_seconds", "declared_inputs", "subjects", "criterion_definition_hash", "criterion_generation_id", "criterion_input_fingerprint", "input_coverage", "provenance", "last_observation"], "criterion");
  exactV3Object(value.source, ["kind", "value"], "criterion source");
  if (!new Set(["file", "command"]).has(value.source.kind) || !v3NonEmpty(value.source.value) || !new Set(["binary", "tri-state"]).has(value.protocol) || !v3Integer(value.timeout_seconds, 1) || !v3Digest(value.criterion_definition_hash) || !v3Uuid(value.criterion_generation_id) || !v3Nullable(value.criterion_input_fingerprint, v3Digest) || !new Set(["full", "unknown"]).has(value.input_coverage) || !new Set(["repo", "state_dir", "unresolved"]).has(value.provenance)) throw new Error("invalid schema-v3 criterion");
  if (!v3Array(value.declared_inputs, (item) => {
    try { exactV3Object(item, ["path", "hash"], "declared input"); return v3RepoPath(item.path) && v3Digest(item.hash); } catch { return false; }
  }) || !v3Array(value.subjects, v3RepoPath)) throw new Error("invalid schema-v3 criterion inputs");
  if (value.last_observation !== null) assertV3Observation(value.last_observation);
}

function assertV3Lifecycle(value) {
  if (value?.state === "active") exactV3Object(value, ["state"], "active lifecycle");
  else if (value?.state === "suspended") {
    exactV3Object(value, ["state", "reason", "suspended_at", "judgment"], "suspended lifecycle");
    exactV3Object(value.judgment, ["remaining", "failure", "next_action"], "suspension judgment");
    if (!VALID_SUSPEND_OUTCOMES.has(value.reason) || !v3Utc(value.suspended_at) || !Object.values(value.judgment).every(v3NonEmpty)) throw new Error("invalid schema-v3 suspended lifecycle");
  } else if (value?.state === "terminal") {
    exactV3Object(value, ["state", "outcome", "terminal_at", "closing_observation_id", "proof_provisional", "evidence", "verified_at_task_revision", "reason"], "terminal lifecycle");
    if (!TERMINAL_OUTCOMES.has(value.outcome) || !v3Utc(value.terminal_at) || !v3Nullable(value.closing_observation_id, v3Uuid) || !v3Nullable(value.proof_provisional, (item) => typeof item === "boolean") || !v3Nullable(value.evidence, v3NonEmpty) || !v3Nullable(value.verified_at_task_revision, (item) => v3Integer(item, 1)) || !v3Nullable(value.reason, v3NonEmpty)) throw new Error("invalid schema-v3 terminal lifecycle");
    if (value.outcome === "achieved" && (!v3Uuid(value.closing_observation_id) || typeof value.proof_provisional !== "boolean" || value.evidence !== null || value.verified_at_task_revision !== null || value.reason !== null)) throw new Error("invalid achieved schema-v3 lifecycle");
    if (value.outcome === "not_needed" && (value.closing_observation_id !== null || value.proof_provisional !== null || !v3NonEmpty(value.evidence) || !v3Integer(value.verified_at_task_revision, 1) || value.reason !== null)) throw new Error("invalid not-needed schema-v3 lifecycle");
    if (value.outcome === "abandoned" && (value.closing_observation_id !== null || value.proof_provisional !== null || value.evidence !== null || value.verified_at_task_revision !== null || !v3NonEmpty(value.reason))) throw new Error("invalid abandoned schema-v3 lifecycle");
  } else throw new Error("invalid schema-v3 task projection lifecycle");
}

function assertV3TaskProjection(task) {
  exactV3Object(task, V3_TASK_PROJECTION_FIELDS, "task projection");
  if (task.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION || !v3Uuid(task.task_id)) throw new Error("invalid schema-v3 task projection identity");
  for (const field of ["task_revision", "last_substantive_task_revision", "task_event_sequence"]) if (!v3Integer(task[field], 1)) throw new Error(`invalid schema-v3 task projection ${field}`);
  for (const field of ["artifact_revision", "unsatisfied_streak"]) if (!v3Integer(task[field])) throw new Error(`invalid schema-v3 task projection ${field}`);
  if (task.last_substantive_task_revision > task.task_revision || !v3Utc(task.created_at) || !v3Utc(task.updated_at) || Date.parse(task.updated_at) < Date.parse(task.created_at) || !v3NonEmpty(task.goal)) throw new Error("invalid schema-v3 task projection core values");
  assertV3Lifecycle(task.lifecycle);
  assertV3Criterion(task.criterion);
  exactV3Object(task.policy, ["open_requirement", "witness_requirement", "close_policy"], "policy");
  validatePolicy(task.policy);
  if (!v3Nullable(task.policy_rationale, v3NonEmpty)) throw new Error("invalid schema-v3 policy rationale");
  if (task.witness !== null) {
    exactV3Object(task.witness, ["criterion_generation_id", "observed_at", "source_event"], "witness");
    if (!v3Uuid(task.witness.criterion_generation_id) || !v3Utc(task.witness.observed_at) || !new Set(["open", "stop", "achieve"]).has(task.witness.source_event)) throw new Error("invalid schema-v3 witness");
  }
  exactV3Object(task.alignment, ["because", "not_covered"], "alignment");
  if (!v3NonEmpty(task.alignment.because) || !v3Array(task.alignment.not_covered, v3NonEmpty)) throw new Error("invalid schema-v3 alignment");
  exactV3Object(task.envelope, ["files", "git", "destructive", "network"], "envelope");
  if (!v3Array(task.envelope.files, v3RepoPath, { nonEmpty: true }) || !v3Array(task.envelope.git, v3NonEmpty) || typeof task.envelope.destructive !== "boolean" || typeof task.envelope.network !== "boolean") throw new Error("invalid schema-v3 task projection envelope");
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
  exactV3Object(task.spent, ["rounds", "writes", "wall_clock_ms", "output_tokens_estimate"], "spent");
  if (!Object.values(task.spent).every((item) => v3Integer(item))) throw new Error("invalid schema-v3 spent");
  exactV3Object(task.evidence, ["touched_files", "criterion_input_drift"], "evidence");
  if (!v3Array(task.evidence.touched_files, v3RepoPath) || !v3Array(task.evidence.criterion_input_drift, v3RepoPath)) throw new Error("invalid schema-v3 evidence");
  if (!v3Array(task.reviews, (record) => {
    try { exactV3Object(record, ["review_id", "criterion_generation_id", "reviewed_task_revision", "reviewed_artifact_revision", "level", "reviewer", "blocking_findings_count", "advisory_findings_count", "reviewed_at", "acting_session"], "review record"); assertV3ReviewRecord(record); return v3Uuid(record.review_id) && v3Uuid(record.criterion_generation_id) && v3NonEmpty(record.reviewer) && v3Utc(record.reviewed_at) && v3Nullable(record.acting_session, v3NonEmpty); } catch { return false; }
  })) throw new Error("invalid schema-v3 reviews");
  if (!v3Array(task.attempts, (attempt) => {
    try { exactV3Object(attempt, ["attempt_id", "criterion_generation_id", "artifact_revision", "signature", "failure_summary", "observed_at"], "attempt"); return v3Uuid(attempt.attempt_id) && v3Uuid(attempt.criterion_generation_id) && v3Integer(attempt.artifact_revision) && v3NonEmpty(attempt.signature) && typeof attempt.failure_summary === "string" && Buffer.byteLength(attempt.failure_summary, "utf8") <= 160 && v3Utc(attempt.observed_at); } catch { return false; }
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
  return task;
}

function appendLifecycle(task, event, source, actingSession, at, reason = null) {
  task.lifecycle_log ??= [];
  const row = { event, source, acting_session: typeof actingSession === "string" && actingSession.trim() ? actingSession.trim() : null, at, task_revision: task.task_revision };
  if (typeof reason === "string" && reason.trim()) row.reason = reason.trim();
  task.lifecycle_log.push(row);
}

function createTask(facts) {
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
  return {
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
    criterion: { ...clone(facts.criterion), last_observation: clone(facts.observation) },
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
}

function exactV3Payload(kind, values) {
  const fields = V3_EVENT_PAYLOAD_FIELDS[kind];
  if (!fields) throw new Error(`unknown schema-v3 event kind: ${kind}`);
  const payload = {};
  for (const field of fields) payload[field] = clone(values[field] ?? null);
  return payload;
}

function v3Event(command, kind, values, taskId = command.taskId) {
  if (!String(taskId ?? "").trim()) throw new Error(`${kind} requires taskId`);
  if (!String(command.at ?? "").trim() || !Number.isFinite(Date.parse(command.at))) throw new Error(`${kind} requires command.at`);
  return {
    kind,
    payload_version: 1,
    task_id: taskId,
    at: command.at,
    payload: exactV3Payload(kind, values),
  };
}

function assertV3CommandState(state, command, { active = false } = {}) {
  if (!isPlainObject(state) || state.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION) throw new Error(`${command.type} requires schema-v3 state`);
  if (state.task_id !== command.taskId) throw new Error(`${command.type} taskId does not match current task`);
  if (active && state.lifecycle?.state !== "active") throw new Error(`${command.type} requires an active task`);
  return state;
}

function validateDigest(value, field) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value ?? ""))) throw new Error(`invalid transcript ${field}`);
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
  if (observation.verdict !== "unsatisfied") return null;
  const exhausted = projectBudgetExhaustion(task, atEpochMs);
  if (exhausted.length) {
    const labels = { rounds: "round", writes: "write", wall_clock: "wall-clock", output_tokens: "output-token" };
    const options = { rounds: "--rounds", writes: "--writes", wall_clock: "--wall-clock-minutes", output_tokens: "--token-budget" };
    return {
      reason: "out_of_budget",
      failure: exhausted.map((item) => `${labels[item.dimension]} budget exhausted (${item.spent}/${item.limit})`).join("; "),
      next_action: `amend ${exhausted.map((item) => options[item.dimension]).join(" and ")} with a reason, then resume`,
    };
  }
  const signatures = task.attempts.slice(-STUCK_REPEATS).map((attempt) => attempt.signature);
  if (signatures.length === STUCK_REPEATS && new Set(signatures).size === 1) {
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

function assertV3ReviewRecord(record) {
  if (!isPlainObject(record) || !new Set(["fresh_context", "second_model"]).has(record.level)) throw new Error("review requires a valid independent review record");
  for (const field of ["review_id", "criterion_generation_id", "reviewer", "reviewed_at"]) if (!String(record[field] ?? "").trim()) throw new Error(`review record requires ${field}`);
  for (const field of ["reviewed_task_revision", "reviewed_artifact_revision", "blocking_findings_count", "advisory_findings_count"]) {
    if (!Number.isSafeInteger(record[field]) || record[field] < (field === "reviewed_task_revision" ? 1 : 0)) throw new Error(`review record has invalid ${field}`);
  }
  if (!(record.acting_session === null || String(record.acting_session ?? "").trim())) throw new Error("review record has invalid acting_session");
  return clone(record);
}

function decide(state, command) {
  if (!isPlainObject(command)) throw new Error("schema-v3 command must be an object");
  if (command.type === "open") {
    if (state !== null) throw new Error("open requires empty schema-v3 state");
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
    });
    return { events: [event], result: { status: "opened" } };
  }
  if (command.type === "tally-transcript") {
    assertV3CommandState(state, command);
    if (state.lifecycle?.state === "terminal") throw new Error("tally-transcript does not mutate a terminal task");
    const range = validateTranscriptRange(state, command.transcriptRange);
    return { events: [v3Event(command, "output_tokens_tallied", range, state.task_id)], result: { status: "tallied" } };
  }
  if (command.type === "authorize-write") {
    assertV3CommandState(state, command);
    if (!new Set(["allow", "deny"]).has(command.decision)) throw new Error("authorize-write requires allow or deny decision");
    const events = [];
    if (command.transcriptRange) {
      const range = validateTranscriptRange(state, command.transcriptRange);
      events.push(v3Event(command, "output_tokens_tallied", range, state.task_id));
    }
    if (command.decision === "deny") return { events, result: { status: "deny", reason: String(command.reason ?? "") } };
    if (state.lifecycle?.state !== "active") throw new Error("write authorization requires an active task");
    if (!Array.isArray(command.files) || !command.files.length || command.files.some((file) => !String(file ?? "").trim())) throw new Error("authorize-write requires files");
    events.push(v3Event(command, "write_authorized", { files: [...new Set(command.files)] }, state.task_id));
    return { events, result: { status: "allow" } };
  }
  if (command.type === "observe") {
    assertV3CommandState(state, command, { active: true });
    if (!isPlainObject(command.observation) || !OBSERVATION_VERDICTS.has(command.observation.verdict)) throw new Error("observe requires a valid observation");
    if (command.suspension !== undefined) throw new Error("observe suspension is derived, not injected");
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
      source: command.source ?? "stop",
    }, state.task_id);
    events.push(observed);
    projected = evolve(projected, observed);
    if (command.observation.verdict === "satisfied") {
      const closure = closureProjection(projected, { drift: Boolean(command.drift?.length) });
      if (projected.policy.close_policy === "automatic" && closure?.state === "eligible") {
        events.push(v3Event(command, "task_terminal", {
          outcome: "achieved", evidence: null, reason: null, source: command.source ?? "stop",
          acting_session: command.actingSession ?? null,
        }, state.task_id));
        return { events, result: { status: "terminal", outcome: "achieved" } };
      }
    }
    if (command.autoSuspend) {
      if (!Number.isSafeInteger(command.atEpochMs) || command.atEpochMs < 0 || new Date(command.atEpochMs).toISOString() !== command.at) throw new Error("automatic suspension requires matching atEpochMs");
      const suspension = v3FailureSuspension(projected, command.observation, command.atEpochMs);
      if (suspension) {
        const judgment = {
          remaining: String(command.remaining ?? "criterion must become satisfied"),
          failure: suspension.failure,
          next_action: suspension.next_action,
        };
        events.push(v3Event(command, "task_suspended", {
          reason: suspension.reason,
          judgment,
          close_episode: command.closeEpisode !== false,
          source: command.source ?? "stop",
          acting_session: command.actingSession ?? null,
        }, state.task_id));
        return { events, result: { status: "suspended", reason: suspension.reason, judgment } };
      }
    }
    return { events, result: { status: "observed" } };
  }
  if (command.type === "suspend") {
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
  }
  if (command.type === "resume") {
    assertV3CommandState(state, command);
    if (state.lifecycle?.state !== "suspended" || !String(command.reason ?? "").trim()) throw new Error("resume requires a suspended task and reason");
    if (!Number.isSafeInteger(command.atEpochMs) || command.atEpochMs < 0 || new Date(command.atEpochMs).toISOString() !== command.at) throw new Error("resume requires matching atEpochMs");
    if (state.lifecycle.reason === "out_of_budget") {
      const exhausted = projectBudgetExhaustion(state, command.atEpochMs);
      if (exhausted.length) throw new Error(`increase exhausted budgets before resuming: ${exhausted.map((item) => item.dimension).join(", ")}`);
    }
    const episode = assertV3Episode(command.episode, "resume");
    if (episode.start_task_revision !== state.task_revision + 1) throw new Error("resume episode revision is not contiguous");
    return { events: [v3Event(command, "task_resumed", { reason: command.reason, episode, acting_session: command.actingSession ?? null }, state.task_id)], result: { status: "resumed" } };
  }
  if (command.type === "join") {
    assertV3CommandState(state, command, { active: true });
    if (!String(command.reason ?? "").trim() || !String(command.actingSession ?? "").trim()) throw new Error("join requires a reason and acting session");
    const episode = assertV3Episode(command.episode, "join");
    if (episode.host_session_id !== command.actingSession || episode.start_task_revision !== state.task_revision + 1) throw new Error("join episode does not bind the acting session and next revision");
    return { events: [v3Event(command, "task_joined", { reason: command.reason, episode, acting_session: command.actingSession }, state.task_id)], result: { status: "joined" } };
  }
  if (command.type === "review") {
    assertV3CommandState(state, command);
    if (state.lifecycle?.state === "terminal") throw new Error("review does not mutate a terminal task");
    const record = assertV3ReviewRecord(command.record);
    if (record.criterion_generation_id !== state.criterion.criterion_generation_id) throw new Error("review must bind the current criterion generation");
    return { events: [v3Event(command, "review_recorded", { record }, state.task_id)], result: { status: "reviewed" } };
  }
  if (command.type === "accept-proof-gap") {
    assertV3CommandState(state, command, { active: true });
    const record = command.record;
    if (projectProofAssurance(state).state === "adequate") throw new Error("criterion proof is already adequate");
    if (!isPlainObject(record) || !String(record.acceptance_id ?? "").trim() || !String(record.reason ?? "").trim() || !new Set(["user", "self"]).has(record.granted_by)) throw new Error("proof-gap acceptance requires a valid record");
    if (record.criterion_generation_id !== state.criterion.criterion_generation_id || record.accepted_at_task_revision !== state.task_revision + 1 || record.accepted_at !== command.at) throw new Error("proof-gap acceptance must bind the next task revision");
    return { events: [v3Event(command, "proof_gap_accepted", { record: clone(record) }, state.task_id)], result: { status: "proof_gap_accepted" } };
  }
  if (command.type === "amend") {
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
      assurance: command.assurance, criterion: command.criterion, policy: command.policy,
      policy_rationale: policyRationale, generation_id: command.generationId,
    };
    return { events: [v3Event(command, "task_amended", values, state.task_id)], result: { status: "amended" } };
  }
  if (command.type === "criterion-side-effect") {
    assertV3CommandState(state, command, { active: true });
    if (!isPlainObject(command.observation) || command.observation.verdict !== "indeterminate" || !command.observation.changed_paths?.length) throw new Error("criterion-side-effect requires an indeterminate mutation observation");
    const events = [];
    if (command.transcriptRange) {
      const range = validateTranscriptRange(state, command.transcriptRange);
      events.push(v3Event(command, "output_tokens_tallied", range, state.task_id));
    }
    events.push(v3Event(command, "criterion_side_effect_recorded", { observation: command.observation }, state.task_id));
    return { events, result: { status: "criterion_side_effect_recorded" } };
  }
  if (command.type === "achieve") {
    assertV3CommandState(state, command, { active: true });
    if (!isPlainObject(command.observation) || !OBSERVATION_VERDICTS.has(command.observation.verdict)) throw new Error("achieve requires a valid observation");
    const observed = v3Event(command, "criterion_observed", {
      observation: command.observation, attempt_id: command.attemptId, signature: command.signature,
      failure_summary: command.failureSummary ?? "", drift: command.drift ?? [], source: "achieve",
    }, state.task_id);
    const projected = evolve(state, observed);
    const closure = closureProjection(projected, { drift: Boolean(command.drift?.length) });
    if (command.observation.verdict !== "satisfied" || closure?.state !== "eligible") {
      const events = [observed];
      if (command.autoSuspend) {
        if (!Number.isSafeInteger(command.atEpochMs) || command.atEpochMs < 0 || new Date(command.atEpochMs).toISOString() !== command.at) throw new Error("automatic suspension requires matching atEpochMs");
        const suspension = v3FailureSuspension(projected, command.observation, command.atEpochMs);
        if (suspension) {
          const judgment = {
            remaining: String(command.remaining ?? "criterion must become satisfied"),
            failure: suspension.failure,
            next_action: suspension.next_action,
          };
          events.push(v3Event(command, "task_suspended", {
            reason: suspension.reason, judgment, close_episode: command.closeEpisode !== false,
            source: "cli", acting_session: command.actingSession ?? null,
          }, state.task_id));
          return { events, result: { status: "suspended", reason: suspension.reason, judgment } };
        }
      }
      return { events, result: { status: "observed", closure } };
    }
    const terminal = v3Event(command, "task_terminal", { outcome: "achieved", evidence: null, reason: null, source: "cli", acting_session: command.actingSession ?? null }, state.task_id);
    return { events: [observed, terminal], result: { status: "terminal", outcome: "achieved" } };
  }
  if (command.type === "not-needed") {
    assertV3CommandState(state, command, { active: true });
    if (state.spent.writes !== 0 || !String(command.evidence ?? "").trim()) throw new Error("not-needed requires no writes and evidence");
    const event = v3Event(command, "task_terminal", { outcome: "not_needed", evidence: command.evidence, reason: null, source: "cli", acting_session: command.actingSession ?? null }, state.task_id);
    return { events: [event], result: { status: "terminal", outcome: "not_needed" } };
  }
  if (command.type === "abandon") {
    assertV3CommandState(state, command, { active: true });
    if (!String(command.reason ?? "").trim()) throw new Error("abandon requires reason");
    const event = v3Event(command, "task_terminal", { outcome: "abandoned", evidence: null, reason: command.reason, source: "cli", acting_session: command.actingSession ?? null }, state.task_id);
    return { events: [event], result: { status: "terminal", outcome: "abandoned" } };
  }
  throw new Error(`unknown schema-v3 command: ${command.type ?? "unknown"}`);
}

function assertV3DomainEvent(event) {
  if (!isPlainObject(event) || !V3_EVENT_KINDS.includes(event.kind)) throw new Error("invalid schema-v3 domain event");
  if (event.payload_version !== 1) throw new Error(`unsupported ${event.kind} payload version`);
  if (!String(event.task_id ?? "").trim()) throw new Error(`${event.kind} requires task_id`);
  if (!String(event.at ?? "").trim() || !Number.isFinite(Date.parse(event.at))) throw new Error(`${event.kind} requires event.at`);
  if (!isPlainObject(event.payload)) throw new Error(`${event.kind} requires payload`);
  const actual = Object.keys(event.payload).sort();
  const expected = [...V3_EVENT_PAYLOAD_FIELDS[event.kind]].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${event.kind} payload fields do not match schema`);
  return event;
}

function applyWriteMutation(next, files) {
  nextRevision(next, { artifact: true });
  next.spent.writes += 1;
  for (const file of files ?? []) if (!next.evidence.touched_files.includes(file)) next.evidence.touched_files.push(file);
}

function applyObservationMutation(next, { observation, at, source, attemptId, signature, failureSummary }) {
  if (!isPlainObject(observation) || !OBSERVATION_VERDICTS.has(observation.verdict)) throw new Error("observation mutation requires a valid observation");
  const applied = observe(next, { observation, at, source });
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

function evolveInto(state, event) {
  assertV3DomainEvent(event);
  if (event.kind === "task_opened") {
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
    });
    if (event.task_event_sequence !== undefined && event.task_event_sequence !== 1) throw new Error("task_opened must have task event sequence 1");
    return next;
  }
  if (state === null) throw new Error(`${event.kind} requires schema-v3 state`);
  if (state.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION || state.task_id !== event.task_id) throw new Error(`${event.kind} does not match schema-v3 state`);
  const expectedSequence = state.task_event_sequence + 1;
  if (event.task_event_sequence !== undefined && event.task_event_sequence !== expectedSequence) throw new Error(`${event.kind} task event sequence is not contiguous`);
  if (event.kind === "output_tokens_tallied") {
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
    state.updated_at = event.at;
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "write_authorized") {
    if (state.lifecycle?.state !== "active") throw new Error("write_authorized requires an active task");
    if (!Array.isArray(event.payload.files) || !event.payload.files.length || event.payload.files.some((file) => !String(file ?? "").trim())) throw new Error("write_authorized requires files");
    applyWriteMutation(state, event.payload.files);
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "criterion_observed") {
    if (state.lifecycle?.state !== "active") throw new Error("criterion_observed requires an active task");
    const payload = event.payload;
    if (payload.observation?.verdict === "unsatisfied" && (!String(payload.attempt_id ?? "").trim() || !String(payload.signature ?? "").trim())) {
      throw new Error("unsatisfied criterion_observed requires attempt identity and signature");
    }
    applyObservationMutation(state, { observation: payload.observation, at: event.at, source: payload.source, attemptId: payload.attempt_id, signature: payload.signature, failureSummary: payload.failure_summary });
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "task_suspended") {
    if (state.lifecycle?.state !== "active") throw new Error("task_suspended requires an active task");
    const payload = event.payload;
    applySuspensionMutation(state, { reason: payload.reason, judgment: payload.judgment, closeEpisode: payload.close_episode, source: payload.source, actingSession: payload.acting_session, at: event.at });
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "task_resumed") {
    if (state.lifecycle?.state !== "suspended" || !String(event.payload.reason ?? "").trim()) throw new Error("task_resumed requires a suspended task and reason");
    if (state.lifecycle.reason === "out_of_budget") {
      const exhausted = projectBudgetExhaustion(state, Date.parse(event.at));
      if (exhausted.length) throw new Error(`task_resumed has exhausted budgets: ${exhausted.map((item) => item.dimension).join(", ")}`);
    }
    const episode = assertV3Episode(event.payload.episode, "task_resumed");
    if (episode.start_task_revision !== state.task_revision + 1) throw new Error("task_resumed episode revision is not contiguous");
    nextRevision(state);
    closeCurrentEpisode(state, event.at);
    state.lifecycle = { state: "active" };
    state.episodes.push(episode);
    appendLifecycle(state, "resume", "cli", event.payload.acting_session, event.at, event.payload.reason);
    state.lifecycle_log.at(-1).reason ??= null;
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "task_joined") {
    if (state.lifecycle?.state !== "active" || !String(event.payload.reason ?? "").trim() || !String(event.payload.acting_session ?? "").trim()) throw new Error("task_joined requires an active task, reason, and session");
    const episode = assertV3Episode(event.payload.episode, "task_joined");
    if (episode.host_session_id !== event.payload.acting_session || episode.start_task_revision !== state.task_revision + 1) throw new Error("task_joined episode binding is invalid");
    nextRevision(state);
    closeCurrentEpisode(state, event.at);
    state.episodes.push(episode);
    appendLifecycle(state, "join", "cli", event.payload.acting_session, event.at, event.payload.reason);
    state.lifecycle_log.at(-1).reason ??= null;
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "review_recorded") {
    if (state.lifecycle?.state === "terminal") throw new Error("review_recorded does not mutate a terminal task");
    const record = assertV3ReviewRecord(event.payload.record);
    if (record.criterion_generation_id !== state.criterion.criterion_generation_id) throw new Error("review_recorded does not bind the current criterion");
    nextRevision(state);
    state.reviews.push(record);
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "proof_gap_accepted") {
    if (state.lifecycle?.state !== "active" || projectProofAssurance(state).state === "adequate") throw new Error("proof_gap_accepted requires an active proof gap");
    const record = event.payload.record;
    if (!isPlainObject(record) || !String(record.reason ?? "").trim() || record.criterion_generation_id !== state.criterion.criterion_generation_id || record.accepted_at_task_revision !== state.task_revision + 1) throw new Error("proof_gap_accepted record binding is invalid");
    nextRevision(state, { substantive: true });
    state.assurance.proof_gap_acceptances.push(clone(record));
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "task_amended") {
    if (!new Set(["active", "suspended"]).has(state.lifecycle?.state) || !String(event.payload.reason ?? "").trim()) throw new Error("task_amended requires an active or suspended task and reason");
    const payload = event.payload;
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
    if (payload.criterion !== null || payload.policy !== null) {
      if (payload.criterion !== null) state.criterion = { ...clone(payload.criterion), last_observation: null };
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
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "criterion_side_effect_recorded") {
    if (state.lifecycle?.state !== "active" || event.payload.observation?.verdict !== "indeterminate" || !event.payload.observation?.changed_paths?.length) throw new Error("criterion_side_effect_recorded requires an active task and mutation observation");
    nextRevision(state, { artifact: true });
    state.criterion.last_observation = {
      ...clone(event.payload.observation),
      criterion_generation_id: state.criterion.criterion_generation_id,
      observed_artifact_revision: state.artifact_revision,
    };
    for (const file of event.payload.observation.changed_paths) if (!state.evidence.touched_files.includes(file)) state.evidence.touched_files.push(file);
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  if (event.kind === "task_terminal") {
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
      if (state.spent.writes !== 0 || !String(payload.evidence ?? "").trim()) throw new Error("not_needed task_terminal requires no writes and evidence");
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
    state.lifecycle_log.at(-1).reason ??= null;
    advanceTaskClock(state, event.at);
    state.task_event_sequence = expectedSequence;
    return state;
  }
  throw new Error(`schema-v3 reducer does not yet support ${event.kind}`);
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
  if (value.risk_floor_events.some((item) => !new Set(["criterion_amend", "policy_amend"]).has(item))) throw new Error("invalid risk floor event");
  return value;
}

export {
  POLICY_PRESETS,
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
