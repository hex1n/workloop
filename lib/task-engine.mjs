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
  if (!name) throw new Error("policy tuple is not a named schema-v1 policy");
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

function freshIndependentReview(task) {
  return (task.reviews ?? []).find((review) =>
    review.criterion_generation_id === task.criterion.criterion_generation_id &&
    review.reviewed_task_revision === task.last_substantive_task_revision &&
    review.reviewed_artifact_revision === task.artifact_revision &&
    new Set(["fresh_context", "second_model"]).has(review.level) &&
    review.blocking_findings_count === 0
  ) ?? null;
}

function weakSensor(task) {
  return task.criterion.provenance !== "repo" || task.criterion.input_coverage !== "full";
}

function closureProjection(task, { drift = false, provisional = false } = {}) {
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
  if (weakSensor(task) && !provisional && !freshIndependentReview(task)) holds.push("weak_sensor_unreviewed");
  return holds.length ? { state: "held", reasons: holds } : { state: "eligible" };
}

function nextRevision(task, { substantive = false, artifact = false } = {}) {
  task.task_revision += 1;
  if (artifact) task.artifact_revision += 1;
  if (substantive || artifact) task.last_substantive_task_revision = task.task_revision;
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
    episodes: facts.episodes ? clone(facts.episodes) : [],
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
      meta.closure = closureProjection(next, { drift: Boolean(event.drift?.length), provisional: event.provisional });
      break;
    }
    case "achieve": {
      if (lifecycle !== "active") throw new Error("achieve requires an active task");
      const observation = observe(next, { ...event, source: "achieve" });
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
      const closure = closureProjection(next, { drift: Boolean(event.drift?.length), provisional: event.provisional });
      meta.closure = closure;
      if (observation.verdict !== "satisfied" || closure?.state !== "eligible") break;
      nextRevision(next);
      next.lifecycle = {
        state: "terminal",
        outcome: "achieved",
        terminal_at: event.at,
        closing_observation_id: observation.observation_id,
        provisional: Boolean(event.provisional),
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
    case "review": {
      if (!REVIEW_LEVELS.includes(event.record.level)) throw new Error("invalid review level");
      for (const key of ["blocking_findings_count", "advisory_findings_count"]) {
        if (!Number.isInteger(event.record[key]) || event.record[key] < 0) throw new Error(`${key} must be a non-negative integer`);
      }
      nextRevision(next);
      next.reviews.push(clone(event.record));
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
  return { task: next, meta };
}

function assertTaskSchema(task) {
  if (!isPlainObject(task) || task.schema_version !== TASK_SCHEMA_VERSION) {
    throw Object.assign(new Error("incompatible task schema; archive it, then open a new task"), { code: "INCOMPATIBLE_TASK_SCHEMA" });
  }
  validatePolicy(task.policy);
  for (const key of ["task_id", "created_at", "updated_at", "goal"]) if (!String(task[key] ?? "")) throw new Error(`invalid task field: ${key}`);
  for (const key of ["task_revision", "last_substantive_task_revision", "artifact_revision", "last_issued_event_sequence"]) if (!Number.isInteger(task[key]) || task[key] < (key === "artifact_revision" ? 0 : 1)) throw new Error(`invalid task field: ${key}`);
  for (const key of ["grants", "reviews", "attempts", "episodes"]) if (!Array.isArray(task[key])) throw new Error(`invalid task field: ${key}`);
  for (const grant of task.grants) {
    if (!isPlainObject(grant) || !String(grant.grant_id ?? "") || !new Set(["git", "destructive", "network", "install", "whole_repo", "criterion_subject"]).has(grant.kind) || !Array.isArray(grant.scope) || !grant.scope.length || !String(grant.reason ?? "") || !new Set(["user", "self"]).has(grant.granted_by) || !Number.isInteger(grant.granted_at_task_revision)) throw new Error("invalid grant");
  }
  if (!isPlainObject(task.criterion) || !isPlainObject(task.alignment) || !isPlainObject(task.envelope) || !isPlainObject(task.budget) || !isPlainObject(task.spent) || !isPlainObject(task.evidence)) throw new Error("invalid task object field");
  if (!new Set(["active", "suspended", "terminal"]).has(task.lifecycle?.state)) throw new Error("invalid lifecycle state");
  if (task.lifecycle.state === "suspended" && !VALID_SUSPEND_OUTCOMES.has(task.lifecycle.reason)) throw new Error("invalid suspension reason");
  if (task.lifecycle.state === "terminal" && !TERMINAL_OUTCOMES.has(task.lifecycle.outcome)) throw new Error("invalid terminal outcome");
  if (task.lifecycle.state === "terminal" && task.lifecycle.outcome === "achieved") {
    const seen = task.criterion.last_observation;
    if (!seen || seen.verdict !== "satisfied" || seen.observation_id !== task.lifecycle.closing_observation_id || seen.criterion_generation_id !== task.criterion.criterion_generation_id || seen.observed_artifact_revision !== task.artifact_revision) throw new Error("achieved terminal does not bind the current fresh satisfied observation");
  }
  if (task.lifecycle.state === "terminal" && task.lifecycle.outcome === "not_needed" && task.spent.writes !== 0) throw new Error("not_needed task contains writes");
  return task;
}

export {
  POLICY_PRESETS,
  assertTaskSchema,
  closureProjection,
  constructPolicy,
  criterionDefinitionHash,
  createTask,
  freshIndependentReview,
  policyName,
  transition,
  validatePolicy,
  weakSensor,
};
