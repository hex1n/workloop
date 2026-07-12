// Canonical task state model. This leaf is deliberately pure: application.mjs
// owns I/O, while every lifecycle mutation and closure decision lives here.

import {
  DEFAULT_ROUNDS,
  OBSERVATION_VERDICTS,
  REVIEW_LEVELS,
  TASK_SCHEMA_VERSION,
  TERMINAL_OUTCOMES,
  VALID_SUSPEND_OUTCOMES,
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

const LIFECYCLE_EVENTS = new Set(["open", "suspend", "resume", "join", "achieve", "not_needed", "abandon"]);

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
    schema_version: TASK_SCHEMA_VERSION,
    task_id: facts.taskId,
    task_revision: 1,
    last_substantive_task_revision: 1,
    artifact_revision: 0,
    last_issued_event_sequence: 1,
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
    lifecycle_log: [{ event: "open", source: "cli", acting_session: typeof facts.actingSession === "string" && facts.actingSession.trim() ? facts.actingSession.trim() : null, at: facts.at, task_revision: 1 }],
  };
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

function transition(task, event) {
  if (!event?.at) throw new Error(`task transition ${event?.type ?? "unknown"} requires event.at`);
  const next = clone(task);
  const meta = {};
  const lifecycle = next.lifecycle?.state;
  const mutating = !new Set(["verify"]).has(event.type);
  if (lifecycle === "terminal" && mutating) throw new Error("terminal task is immutable; open a new task");
  switch (event.type) {
    case "record-write":
      if (lifecycle !== "active") throw new Error("writes require an active task");
      nextRevision(next, { artifact: true });
      next.spent.writes += 1;
      for (const file of event.files ?? []) if (!next.evidence.touched_files.includes(file)) next.evidence.touched_files.push(file);
      break;
    case "observe": {
      if (lifecycle !== "active") throw new Error("observation mutation requires an active task");
      const observation = observe(next, event);
      next.unsatisfied_streak = observation.verdict === "unsatisfied" ? (next.unsatisfied_streak ?? 0) + 1 : 0;
      if (observation.verdict === "unsatisfied") {
        next.spent.rounds = Math.min(next.budget.rounds, next.spent.rounds + 1);
        next.attempts.push({
          attempt_id: event.attemptId,
          criterion_generation_id: next.criterion.criterion_generation_id,
          artifact_revision: next.artifact_revision,
          signature: event.signature,
          failure_summary: event.failureSummary ?? "",
          observed_at: event.at,
        });
      }
      meta.closure = closureProjection(next, { drift: Boolean(event.drift?.length) });
      break;
    }
    case "achieve": {
      if (lifecycle !== "active") throw new Error("achieve requires an active task");
      const observation = observe(next, { ...event, source: "achieve" });
      next.unsatisfied_streak = observation.verdict === "unsatisfied" ? (next.unsatisfied_streak ?? 0) + 1 : 0;
      if (observation.verdict === "unsatisfied") {
        next.spent.rounds = Math.min(next.budget.rounds, next.spent.rounds + 1);
        next.attempts.push({
          attempt_id: event.attemptId,
          criterion_generation_id: next.criterion.criterion_generation_id,
          artifact_revision: next.artifact_revision,
          signature: event.signature,
          failure_summary: event.failureSummary ?? "",
          observed_at: event.at,
        });
      }
      const closure = closureProjection(next, { drift: Boolean(event.drift?.length) });
      meta.closure = closure;
      if (observation.verdict !== "satisfied" || closure?.state !== "eligible") break;
      nextRevision(next);
      next.lifecycle = {
        state: "terminal",
        outcome: "achieved",
        terminal_at: event.at,
        closing_observation_id: observation.observation_id,
        proof_provisional: projectProofAssurance(next).state === "provisional",
      };
      closeCurrentEpisode(next, event.at);
      meta.terminal = true;
      break;
    }
    case "not-needed":
      if (lifecycle !== "active") throw new Error("not-needed requires an active task");
      if (next.spent.writes !== 0) throw new Error("not-needed requires spent.writes == 0");
      if (!String(event.evidence ?? "").trim()) throw new Error("not-needed requires evidence");
      nextRevision(next);
      next.lifecycle = { state: "terminal", outcome: "not_needed", terminal_at: event.at, evidence: event.evidence, verified_at_task_revision: next.task_revision };
      closeCurrentEpisode(next, event.at);
      break;
    case "abandon":
      if (!String(event.reason ?? "").trim()) throw new Error("abandon requires reason");
      nextRevision(next);
      next.lifecycle = { state: "terminal", outcome: "abandoned", terminal_at: event.at, reason: event.reason };
      closeCurrentEpisode(next, event.at);
      break;
    case "suspend":
      if (lifecycle !== "active") throw new Error("suspend requires an active task");
      if (!VALID_SUSPEND_OUTCOMES.has(event.reason) || !isPlainObject(event.judgment)) throw new Error("invalid suspension");
      for (const key of ["remaining", "failure", "next_action"]) if (!String(event.judgment[key] ?? "").trim()) throw new Error(`suspension judgment requires ${key}`);
      nextRevision(next);
      next.lifecycle = { state: "suspended", reason: event.reason, suspended_at: event.at, judgment: clone(event.judgment) };
      if (event.closeEpisode) closeCurrentEpisode(next, event.at);
      break;
    case "resume":
      if (lifecycle !== "suspended") throw new Error("resume requires a suspended task");
      if (!String(event.reason ?? "").trim()) throw new Error("resume requires reason");
      if (next.lifecycle.reason === "out_of_budget" && next.spent.rounds >= next.budget.rounds) throw new Error("increase rounds before resuming an out-of-budget task");
      nextRevision(next);
      closeCurrentEpisode(next, event.at);
      next.lifecycle = { state: "active" };
      next.episodes.push(event.episode);
      break;
    case "join":
      if (lifecycle !== "active") throw new Error("join requires an active task");
      if (!String(event.reason ?? "").trim()) throw new Error("join requires reason");
      nextRevision(next);
      closeCurrentEpisode(next, event.at);
      next.episodes.push(clone(event.episode));
      break;
    case "review": {
      if (!REVIEW_LEVELS.includes(event.record.level)) throw new Error("invalid review level");
      for (const key of ["blocking_findings_count", "advisory_findings_count"]) {
        if (!Number.isInteger(event.record[key]) || event.record[key] < 0) throw new Error(`${key} must be a non-negative integer`);
      }
      nextRevision(next);
      next.reviews.push(clone(event.record));
      break;
    }
    case "accept-proof-gap": {
      if (lifecycle !== "active") throw new Error("proof-gap acceptance requires an active task");
      if (projectProofAssurance(next).state === "adequate") throw new Error("criterion proof is already adequate");
      if (!String(event.record?.reason ?? "").trim()) throw new Error("proof-gap acceptance requires reason");
      nextRevision(next, { substantive: true });
      next.assurance.proof_gap_acceptances.push({ ...clone(event.record), criterion_generation_id: next.criterion.criterion_generation_id, accepted_at_task_revision: next.task_revision });
      break;
    }
    case "amend": {
      if (!new Set(["active", "suspended"]).has(lifecycle)) throw new Error("amend requires an active or suspended task");
      if (!String(event.reason ?? "").trim()) throw new Error("amend requires reason");
      nextRevision(next, { substantive: true });
      if (event.goal !== undefined) next.goal = event.goal;
      if (event.alignment !== undefined) next.alignment = clone(event.alignment);
      if (event.envelope !== undefined) next.envelope = clone(event.envelope);
      if (event.grants?.length) next.grants.push(...clone(event.grants));
      if (event.rounds !== undefined) next.budget.rounds = event.rounds;
      if (event.writes !== undefined) next.budget.writes = event.writes;
      if (event.wallClockMinutes !== undefined) next.budget.wall_clock_minutes = event.wallClockMinutes;
      if (event.outputTokens !== undefined) next.budget.output_tokens = event.outputTokens;
      if (event.assurance !== undefined) next.assurance = clone(event.assurance);
      if (event.criterion || event.policy) {
        if (event.criterion) next.criterion = { ...clone(event.criterion), last_observation: null };
        else {
          next.criterion.criterion_generation_id = event.generationId;
          next.criterion.last_observation = null;
        }
        if (event.policy) {
          next.policy = clone(event.policy);
          const name = validatePolicy(next.policy);
          if (name !== "default" && !String(event.policyRationale ?? event.reason ?? "").trim()) throw new Error("non-default policy requires a rationale");
          next.policy_rationale = name === "default" ? null : String(event.policyRationale ?? event.reason);
        }
        validatePolicy(next.policy);
        next.witness = null;
        next.reviews = [];
      }
      break;
    }
    case "criterion-side-effect":
      nextRevision(next, { artifact: true });
      next.criterion.last_observation = {
        ...clone(event.observation),
        criterion_generation_id: next.criterion.criterion_generation_id,
        observed_artifact_revision: next.artifact_revision,
      };
      break;
    case "verify":
      break;
    default:
      throw new Error(`unknown task transition: ${event.type}`);
  }
  if (mutating) {
    next.updated_at = event.at;
    next.spent.wall_clock_ms = Math.max(next.spent.wall_clock_ms, Date.parse(event.at) - Date.parse(next.created_at));
  }
  if (event.type === "suspend") appendLifecycle(next, "suspend", event.source ?? "cli", event.actingSession, event.at, event.reason);
  if (event.type === "resume") appendLifecycle(next, "resume", "cli", event.actingSession, event.at, event.reason);
  if (event.type === "join") appendLifecycle(next, "join", "cli", event.actingSession, event.at, event.reason);
  if (event.type === "achieve" && meta.terminal) appendLifecycle(next, "achieve", event.source === "stop" ? "stop" : "cli", event.actingSession, event.at);
  if (event.type === "not-needed") appendLifecycle(next, "not_needed", "cli", event.actingSession, event.at);
  if (event.type === "abandon") appendLifecycle(next, "abandon", "cli", event.actingSession, event.at, event.reason);
  return { task: next, meta };
}

function assertTaskSchema(task) {
  if (!isPlainObject(task) || task.schema_version !== TASK_SCHEMA_VERSION) {
    throw Object.assign(new Error("incompatible task schema; archive it, then open a new task"), { code: "INCOMPATIBLE_TASK_SCHEMA" });
  }
  validatePolicy(task.policy);
  for (const key of ["task_id", "created_at", "updated_at", "goal"]) if (!String(task[key] ?? "")) throw new Error(`invalid task field: ${key}`);
  for (const key of ["task_revision", "last_substantive_task_revision", "artifact_revision", "last_issued_event_sequence"]) if (!Number.isInteger(task[key]) || task[key] < (key === "artifact_revision" ? 0 : 1)) throw new Error(`invalid task field: ${key}`);
  if (task.unsatisfied_streak !== undefined && (!Number.isInteger(task.unsatisfied_streak) || task.unsatisfied_streak < 0)) throw new Error("invalid task field: unsatisfied_streak");
  for (const key of ["grants", "reviews", "attempts", "episodes"]) if (!Array.isArray(task[key])) throw new Error(`invalid task field: ${key}`);
  for (const grant of task.grants) {
    if (!isPlainObject(grant) || !String(grant.grant_id ?? "") || !new Set(["git", "destructive", "network", "install", "whole_repo", "criterion_subject", "publish"]).has(grant.kind) || !Array.isArray(grant.scope) || !grant.scope.length || !String(grant.reason ?? "") || !new Set(["user", "self"]).has(grant.granted_by) || !Number.isInteger(grant.granted_at_task_revision)) throw new Error("invalid grant");
  }
  if (!isPlainObject(task.criterion) || !isPlainObject(task.alignment) || !isPlainObject(task.envelope) || !isPlainObject(task.budget) || !isPlainObject(task.spent) || !isPlainObject(task.evidence) || !isPlainObject(task.assurance)) throw new Error("invalid task object field");
  validateAssurance(task.assurance);
  if (!new Set(["active", "suspended", "terminal"]).has(task.lifecycle?.state)) throw new Error("invalid lifecycle state");
  if (task.lifecycle.state === "suspended" && !VALID_SUSPEND_OUTCOMES.has(task.lifecycle.reason)) throw new Error("invalid suspension reason");
  if (task.lifecycle.state === "terminal" && !TERMINAL_OUTCOMES.has(task.lifecycle.outcome)) throw new Error("invalid terminal outcome");
  if (task.lifecycle.state === "terminal" && task.lifecycle.outcome === "achieved") {
    const seen = task.criterion.last_observation;
    if (!seen || seen.verdict !== "satisfied" || seen.observation_id !== task.lifecycle.closing_observation_id || seen.criterion_generation_id !== task.criterion.criterion_generation_id || seen.observed_artifact_revision !== task.artifact_revision) throw new Error("achieved terminal does not bind the current fresh satisfied observation");
  }
  if (task.lifecycle.state === "terminal" && task.lifecycle.outcome === "not_needed" && task.spent.writes !== 0) throw new Error("not_needed task contains writes");
  if (task.lifecycle_log !== undefined) {
    if (!Array.isArray(task.lifecycle_log)) throw new Error("invalid lifecycle_log");
    let revision = 0; let timestamp = -Infinity;
    for (const row of task.lifecycle_log) {
      const parsed = Date.parse(row?.at ?? "");
      if (!isPlainObject(row) || !LIFECYCLE_EVENTS.has(row.event) || !new Set(["cli", "stop"]).has(row.source) || !(row.acting_session === null || typeof row.acting_session === "string") || !Number.isInteger(row.task_revision) || row.task_revision < revision || !Number.isFinite(parsed) || parsed < timestamp) throw new Error("invalid lifecycle_log row");
      revision = row.task_revision; timestamp = parsed;
    }
  }
  return task;
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
  assertTaskSchema,
  closureProjection,
  constructAssurance,
  constructPolicy,
  criterionDefinitionHash,
  createTask,
  machineRiskFloor,
  policyName,
  projectAssurance,
  projectProofAssurance,
  projectReviewRequirement,
  transition,
  validateAssurance,
  validatePolicy,
};
