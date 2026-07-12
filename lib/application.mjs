import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  CRITERION_TIMEOUT_SECONDS,
  LEDGER_EVENT_SCHEMA_VERSION,
  RUNTIME_CONTRACT,
  STATE_DIR,
  STUCK_REPEATS,
  TASK_SCHEMA_VERSION,
  fnv1aHex,
  isPlainObject,
  outputTail,
  repoRelative,
} from "./prims.mjs";
import { criterionDrift, criterionMetadata, resolveCriterionFile, resolveSubject, runCriterionSource } from "./criterion.mjs";
import { commandSafetyFailure, commandValues, envelopeDirty, envelopeOverlap, gitOps, insideEnvelope, joinedFileOffender, joinedFilesMessage, looksLikeWrite, siblingWorktreeOpenTasks, warnZeroMatchEnvelope, writeFileTargets } from "./supervision.mjs";
import { assertTaskSchema, closureProjection, constructPolicy, criterionDefinitionHash, createTask, policyName, transition } from "./task-engine.mjs";
import { archiveIncompatibleState, archiveTask, loadTask, saveTask, taskPath, withTaskLock } from "./task-store.mjs";
import { appendOutcomeEvent, auditLedger, ledgerPath, makeEvent } from "./outcome-ledger.mjs";
import { clearUntracked, observeUntracked } from "./untracked.mjs";

const OPTION = { type: "string" };
const BOOL = { type: "boolean" };
const OPTIONS = {
  open: { repo: OPTION, goal: OPTION, criterion: OPTION, "criterion-file": OPTION, "criterion-protocol": OPTION, "criterion-policy": OPTION, reason: OPTION, "alignment-because": OPTION, "not-covered": { type: "string", multiple: true }, files: { type: "string", multiple: true }, "criterion-subject": { type: "string", multiple: true }, rounds: OPTION, writes: OPTION, "wall-clock-minutes": OPTION, "token-budget": OPTION, "criterion-timeout-seconds": OPTION, "git-allowed": { type: "string", multiple: true }, "git-reason": OPTION, "destructive-allowed": BOOL, "network-allowed": BOOL, "install-scripts-allowed": BOOL, "granted-by": OPTION },
  status: { repo: OPTION }, verify: { repo: OPTION }, achieve: { repo: OPTION, provisional: BOOL },
  "not-needed": { repo: OPTION, evidence: OPTION }, abandon: { repo: OPTION, reason: OPTION },
  suspend: { repo: OPTION, reason: OPTION, remaining: OPTION, failure: OPTION, "next-action": OPTION },
  resume: { repo: OPTION, reason: OPTION },
  review: { repo: OPTION, level: OPTION, reviewer: OPTION, "blocking-findings": OPTION, "advisory-findings": OPTION },
  amend: { repo: OPTION, reason: OPTION, goal: OPTION, criterion: OPTION, "criterion-file": OPTION, "criterion-protocol": OPTION, "criterion-policy": OPTION, "alignment-because": OPTION, "not-covered": { type: "string", multiple: true }, files: { type: "string", multiple: true }, "criterion-subject": { type: "string", multiple: true }, rounds: OPTION, writes: OPTION, "wall-clock-minutes": OPTION, "token-budget": OPTION, "git-allowed": { type: "string", multiple: true }, "git-reason": OPTION, "destructive-allowed": BOOL, "network-allowed": BOOL, "install-scripts-allowed": BOOL, "granted-by": OPTION },
  "archive-incompatible-state": { repo: OPTION, reason: OPTION, "granted-by": OPTION },
  audit: {}, info: {}, hooks: {}, help: {},
};

function now() { return new Date().toISOString(); }
function repoOf(value) { return path.resolve(value?.repo ?? "."); }
function error(message) { process.stderr.write(`taskloop: ${message}\n`); return 2; }
function deny(message) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `taskloop: ${message}` } }) + "\n");
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
  return { git, destructive: Boolean(values["destructive-allowed"]), network: Boolean(values["network-allowed"]), grants };
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
  for (const sibling of siblingWorktreeOpenTasks(repo)) {
    const overlap = envelopeOverlap(files, sibling.files, repo, sibling.path);
    if (overlap) process.stderr.write(`warning: ${overlap.level} envelope overlap with open task in ${sibling.path}: ${overlap.patterns.join(", ")}\n`);
  }
}

const TOKEN_CURSOR_FILE = "transcript-cursors.json";

function transcriptTokens(row) {
  const value = row?.message?.usage?.output_tokens ?? row?.usage?.output_tokens ?? row?.output_tokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function transcriptTimestamp(row) {
  const value = row?.timestamp ?? row?.created_at;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function tallyTranscript(repo, task, transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return task;
  const absolute = path.resolve(transcriptPath);
  let content;
  try { content = fs.readFileSync(absolute, "utf8"); } catch { return task; }
  const cursorPath = path.join(repo, STATE_DIR, TOKEN_CURSOR_FILE);
  let cursors = {};
  try { const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8")); if (isPlainObject(parsed)) cursors = parsed; } catch { /* first sample */ }
  const continuingTask = isPlainObject(cursors[absolute]) && cursors[absolute].task_id === task.task_id;
  const previous = continuingTask ? cursors[absolute].offset : 0;
  const offset = Number.isSafeInteger(previous) && previous >= 0 && previous <= content.length ? previous : 0;
  const completeEnd = content.lastIndexOf("\n") + 1;
  if (completeEnd <= offset) return task;
  let delta = 0;
  for (const line of content.slice(offset, completeEnd).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const timestamp = transcriptTimestamp(row);
      if (continuingTask || timestamp === null || timestamp >= Date.parse(task.created_at)) delta += transcriptTokens(row);
    } catch { /* incomplete/corrupt rows carry no telemetry */ }
  }
  const next = structuredClone(task);
  if (delta > 0) {
    next.spent.output_tokens_estimate += delta;
    const episode = next.episodes.at(-1);
    if (episode && episode.ended_at === null) episode.output_tokens_estimate += delta;
    next.updated_at = now();
    saveTask(repo, next);
  }
  cursors[absolute] = { task_id: task.task_id, offset: completeEnd };
  try {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(cursorPath, JSON.stringify(cursors, null, 2) + "\n", "utf8");
  } catch { /* token telemetry is best effort */ }
  return next;
}

function eventPayload(task, kind, details = {}) {
  if (kind === "task_opened") return {
    goal: task.goal, policy: task.policy, policy_rationale: task.policy_rationale,
    criterion: {
      source: task.criterion.source,
      protocol: task.criterion.protocol,
      criterion_definition_hash: task.criterion.criterion_definition_hash,
      criterion_generation_id: task.criterion.criterion_generation_id,
      initial_observation: task.criterion.last_observation,
    },
    alignment: task.alignment, envelope: task.envelope, budget: task.budget,
  };
  return details;
}

function persistEvent(repo, task, kind, payload, at) {
  saveTask(repo, task);
  appendOutcomeEvent(makeEvent({ task, kind, payload, repoIdentity: repoIdentity(repo), at }));
}

function readTask(repo) { const task = loadTask(repo); return task ? assertTaskSchema(task) : null; }

function runObservation(task, repo) {
  const observation = runCriterionSource(task.criterion.source, repo, task.criterion.timeout_seconds, task.criterion.protocol);
  observation.criterion_generation_id = task.criterion.criterion_generation_id;
  observation.observed_artifact_revision = task.artifact_revision;
  return observation;
}

function cmdOpen(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const existing = loadTask(repo);
    if (existing) {
      assertTaskSchema(existing);
      if (existing.lifecycle.state !== "terminal") return error("an active or suspended task already exists");
    }
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
    const at = now();
    let task;
    try {
      task = createTask({ taskId: randomUUID(), goal, criterion, observation, policyName: internalPolicy, policyRationale: values.reason, at, alignment: { because, not_covered: values["not-covered"] ?? [] }, envelope: { files, git: authority.git, destructive: authority.destructive, network: authority.network }, grants: authority.grants, budget: { rounds: parseInteger(values.rounds, "rounds", { minimum: 1 }) ?? 8, writes: parseInteger(values.writes, "writes"), wall_clock_minutes: parseInteger(values["wall-clock-minutes"], "wall-clock-minutes"), output_tokens: parseInteger(values["token-budget"], "token-budget") }, episodes: [{ episode_id: randomUUID(), host_session_id: process.env.TASKLOOP_SESSION_ID ?? "cli", started_at: at, ended_at: null, start_task_revision: 1, end_task_revision: null, output_tokens_estimate: 0 }] });
    } catch (err) { return error(err.message); }
    if (existing) archiveTask(repo, existing, at);
    persistEvent(repo, task, "task_opened", eventPayload(task, "task_opened"), at);
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
  const repo = repoOf(values); const task = readTask(repo);
  if (!task) return error("no task");
  const closure = closureProjection(task, { drift: criterionDrift(task.criterion, repo).length > 0 });
  process.stdout.write(JSON.stringify({ task_schema_version: task.schema_version, task_id: task.task_id, lifecycle: task.lifecycle, goal: task.goal, policy: task.policy, criterion: task.criterion, closure, alignment: task.alignment, budget: task.budget, spent: task.spent, artifact_revision: task.artifact_revision, last_substantive_task_revision: task.last_substantive_task_revision }, null, 2) + "\n");
  return 0;
}

function cmdVerify(values) {
  const repo = repoOf(values); const task = readTask(repo);
  if (!task) return error("no task");
  const beforeArtifact = task.artifact_revision;
  const observation = runObservation(task, repo);
  if (observation.execution.execution_error === "criterion_side_effect") {
    const at = now();
    withTaskLock(repo, () => {
      const current = readTask(repo);
      if (!current || current.lifecycle.state === "terminal") return;
      const changed = transition(current, { type: "criterion-side-effect", observation, at }).task;
      saveTask(repo, changed);
    });
  }
  process.stdout.write(JSON.stringify({ observation, persisted: false, artifact_revision_before: beforeArtifact }) + "\n");
  return observation.verdict === "satisfied" ? 0 : observation.verdict === "unsatisfied" ? 1 : 2;
}

function failureSuspension(task, observation) {
  if (observation.verdict !== "unsatisfied") return null;
  if (task.spent.rounds >= task.budget.rounds) return "out_of_budget";
  const signatures = task.attempts.slice(-STUCK_REPEATS).map((attempt) => attempt.signature);
  if (signatures.length === STUCK_REPEATS && new Set(signatures).size === 1) return "stuck";
  return null;
}

function closeAttempt(repo, { explicit, provisional = false, stop = false }) {
  return withTaskLock(repo, () => {
    const task = readTask(repo);
    if (!task) return stop ? 0 : error("no task");
    if (task.lifecycle.state === "suspended") return stop ? 0 : error("task is suspended; resume first");
    if (task.lifecycle.state === "terminal") return 0;
    const observation = runObservation(task, repo);
    if (observation.execution.execution_error === "criterion_side_effect") {
      const at = now();
      const next = transition(task, { type: "criterion-side-effect", observation, at }).task;
      saveTask(repo, next);
      const message = `criterion indeterminate; closure not_ready(criterion_indeterminate); criterion side effect: ${observation.changed_paths.join(", ")}`;
      return stop ? block(message) : error(message);
    }
    const drift = criterionDrift(task.criterion, repo);
    const at = now();
    const result = transition(task, { type: explicit ? "achieve" : "observe", source: explicit ? "achieve" : "stop", observation, drift, provisional, attemptId: randomUUID(), signature: fnv1aHex(observation.execution.output_tail), failureSummary: outputTail(observation.execution.output_tail, 160), at });
    let next = result.task;
    const suspensionReason = failureSuspension(next, observation);
    if (suspensionReason) {
      const judgment = {
        remaining: `criterion must become satisfied: ${next.criterion.source.value}`,
        failure: suspensionReason === "out_of_budget" ? `round budget exhausted (${next.spent.rounds}/${next.budget.rounds})` : `same failure repeated ${STUCK_REPEATS} times`,
        next_action: suspensionReason === "out_of_budget" ? "amend --rounds with a reason, then resume" : "change the approach or inputs, then resume",
      };
      next = transition(next, { type: "suspend", reason: suspensionReason, judgment, at }).task;
      next.last_issued_event_sequence += 1;
      persistEvent(repo, next, "task_suspended", { reason: suspensionReason, judgment, spent: next.spent, artifact_revision: next.artifact_revision }, at);
      return stop ? block(`criterion unsatisfied; task suspended(${suspensionReason}): ${judgment.failure}`) : error(`criterion unsatisfied; task suspended(${suspensionReason}): ${judgment.failure}`);
    }
    if (!explicit && observation.verdict === "satisfied" && result.meta.closure?.state === "eligible" && next.policy.close_policy === "automatic") {
      next = transition(next, { type: "achieve", source: "stop", observation: { ...observation, observation_id: randomUUID() }, drift, provisional, at }).task;
    }
    saveTask(repo, next);
    if (next.lifecycle.state === "terminal") {
      next.last_issued_event_sequence += 1;
      saveTask(repo, next);
      appendOutcomeEvent(makeEvent({ task: next, kind: "task_terminal", payload: { outcome: "achieved", closing_observation_id: next.lifecycle.closing_observation_id, provisional: next.lifecycle.provisional, spent: next.spent, review_level: bestReview(next), artifact_revision: next.artifact_revision }, repoIdentity: repoIdentity(repo), at }));
      if (!stop) process.stdout.write(`taskloop: terminal(achieved); criterion satisfied; not covered: ${(next.alignment.not_covered ?? []).join(", ") || "none"}\n`);
      return 0;
    }
    const closure = result.meta.closure ?? closureProjection(next, { drift: drift.length > 0, provisional });
    const explicitSuffix = !explicit && next.policy.close_policy === "explicit" && observation.verdict === "satisfied" ? "; explicit achieve required" : "";
    const message = `criterion ${observation.verdict}; closure ${formatClosure(closure)}${explicitSuffix}${observation.execution.output_tail ? `; ${outputTail(observation.execution.output_tail, 300)}` : ""}`;
    return stop ? block(message) : error(message);
  });
}

function bestReview(task) {
  const order = ["self_reread", "fresh_context", "second_model"];
  return (task.reviews ?? []).reduce((best, row) => order.indexOf(row.level) > order.indexOf(best) ? row.level : best, "none");
}

function terminalCommand(values, type) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task");
    const at = now();
    let result;
    try { result = transition(task, type === "not-needed" ? { type, evidence: values.evidence, at } : { type, reason: values.reason, at }); }
    catch (err) { return error(err.message); }
    const next = result.task; next.last_issued_event_sequence += 1;
    const payload = next.lifecycle.outcome === "not_needed" ? { outcome: "not_needed", evidence: next.lifecycle.evidence, verified_at_task_revision: next.lifecycle.verified_at_task_revision, spent: next.spent } : { outcome: "abandoned", reason: next.lifecycle.reason, spent: next.spent };
    persistEvent(repo, next, "task_terminal", payload, at);
    process.stdout.write(`taskloop: terminal(${next.lifecycle.outcome})\n`); return 0;
  });
}

function cmdSuspend(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task");
    const at = now(); let next;
    const reason = String(values.reason ?? "").replaceAll("-", "_");
    try { next = transition(task, { type: "suspend", reason, judgment: { remaining: values.remaining, failure: values.failure, next_action: values["next-action"] }, closeEpisode: true, at }).task; }
    catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1; persistEvent(repo, next, "task_suspended", { reason: next.lifecycle.reason, judgment: next.lifecycle.judgment, spent: next.spent, artifact_revision: next.artifact_revision }, at); return 0;
  });
}

function cmdResume(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task"); const at = now();
    let next; const episode = { episode_id: randomUUID(), host_session_id: process.env.TASKLOOP_SESSION_ID ?? "cli", started_at: at, ended_at: null, start_task_revision: task.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0 };
    try { next = transition(task, { type: "resume", reason: values.reason, episode, at }).task; } catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1; persistEvent(repo, next, "task_resumed", { reason: values.reason, new_episode_id: episode.episode_id, spent: next.spent }, at); return 0;
  });
}

function cmdReview(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task"); const at = now();
    const level = String(values.level ?? "").replaceAll("-", "_");
    const record = { review_id: randomUUID(), criterion_generation_id: task.criterion.criterion_generation_id, reviewed_task_revision: task.last_substantive_task_revision, reviewed_artifact_revision: task.artifact_revision, level, reviewer: String(values.reviewer ?? "").trim(), blocking_findings_count: parseInteger(values["blocking-findings"], "blocking-findings", { minimum: 0, nullable: false }), advisory_findings_count: parseInteger(values["advisory-findings"], "advisory-findings", { minimum: 0, nullable: false }), reviewed_at: at };
    if (!record.reviewer) return error("review requires --reviewer");
    let next; try { next = transition(task, { type: "review", record, at }).task; } catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1;
    const { review_id: _reviewId, ...ledgerReview } = record;
    persistEvent(repo, next, "task_reviewed", ledgerReview, at); return 0;
  });
}

function cmdAmend(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task");
    const at = now(); const event = { type: "amend", reason: values.reason, at };
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
    if (newGrants.length) event.grants = newGrants;
    let next; try { next = transition(task, event).task; } catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1;
    const payload = {
      changed_fields: Object.keys(event).filter((k) => !new Set(["type", "reason", "at"]).has(k)),
      reason: values.reason,
      before_substantive_revision: task.last_substantive_task_revision,
      after_substantive_revision: next.last_substantive_task_revision,
      ...(event.grants?.length ? { grants: event.grants } : {}),
      ...((event.criterion || event.policy) ? {
        before_generation: task.criterion.criterion_generation_id,
        after_generation: next.criterion.criterion_generation_id,
        before_definition_hash: task.criterion.criterion_definition_hash,
        after_definition_hash: next.criterion.criterion_definition_hash,
      } : {}),
    };
    persistEvent(repo, next, "task_amended", payload, at); return 0;
  });
}

function cmdArchive(values) {
  try { const receipt = archiveIncompatibleState(repoOf(values), { reason: values.reason, grantedBy: values["granted-by"], at: now() }); process.stdout.write(JSON.stringify(receipt) + "\n"); return 0; }
  catch (err) { return error(err.message); }
}

function cmdAudit() { const report = auditLedger(); process.stdout.write(JSON.stringify(report, null, 2) + "\n"); return report.exit; }
function cmdInfo() { process.stdout.write(JSON.stringify({ name: "taskloop", runtime_contract: RUNTIME_CONTRACT, task_schema_version: TASK_SCHEMA_VERSION, ledger_event_schema_version: LEDGER_EVENT_SCHEMA_VERSION, ledger_path: ledgerPath(), distribution_owner: "taskloop" }) + "\n"); return 0; }
function cmdHooks() {
  const command = `node ${JSON.stringify(path.resolve(process.argv[1] ?? "taskloop.mjs"))}`;
  process.stdout.write(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command, timeout: 20 }] }], Stop: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 300 }] }] } }, null, 2) + "\n"); return 0;
}
function cmdHelp() { process.stdout.write(`taskloop — criterion-driven work supervisor\n\nopen --goal G (--criterion C|--criterion-file F) --criterion-policy default|deferred-witness|steady-satisfied --alignment-because B [--not-covered N] --files GLOB\n     [--rounds N] [--writes N] [--wall-clock-minutes N] [--token-budget N]\n     [--git-allowed OP --git-reason R] [--destructive-allowed] [--network-allowed] [--install-scripts-allowed] [--granted-by self|user] --reason R\nstatus | verify | achieve [--provisional] | not-needed --evidence E | abandon --reason R\nsuspend --reason needs-input|stuck|out-of-budget --remaining R --failure F --next-action N\nresume --reason R | amend ... --reason R\nreview --level fresh-context|second-model|self-reread --reviewer ID --blocking-findings N --advisory-findings N\narchive-incompatible-state --reason R --granted-by user\naudit | info | hooks\n\ncriterion observations: unsatisfied | satisfied | indeterminate\nlifecycle: active | suspended(reason) | terminal(outcome)\n`); return 0; }

function loadPayload() { try { const value = JSON.parse(fs.readFileSync(0, "utf8")); return isPlainObject(value) ? value : {}; } catch { return {}; } }
function payloadRepo(payload) { return path.resolve(payload.cwd ?? payload.tool_input?.cwd ?? process.cwd()); }

function hookPretool(payload, repo, task) {
  const mapping = payload.tool_input ?? {};
  const tool = String(payload.tool_name ?? "");
  return withTaskLock(repo, () => {
    let current = readTask(repo);
    if (!current || current.lifecycle.state === "terminal") return 0;
    current = tallyTranscript(repo, current, payload.transcript_path);
    const ops = gitOps(mapping);
    const writeShaped = ops.length > 0 || looksLikeWrite(tool, mapping);
    if (current.lifecycle.state === "suspended") return writeShaped ? deny(`task suspended (${current.lifecycle.reason}); resume before writing`) : 0;
    const deniedGit = ops.filter((op) => !(current.envelope.git ?? []).includes(op));
    if (deniedGit.length) return deny(`git operation(s) need envelope authorization: ${deniedGit.join(", ")}`);
    for (const command of commandValues(mapping)) {
      const failure = commandSafetyFailure(current, command);
      if (failure) return deny(failure);
    }
    if (!writeShaped) return 0;
    if (current.spent.rounds >= current.budget.rounds) return deny(`round budget exhausted (${current.spent.rounds}/${current.budget.rounds}); reads and verification remain free`);
    if (current.budget.writes !== null && current.spent.writes >= current.budget.writes) return deny(`write budget exhausted (${current.spent.writes}/${current.budget.writes}); reads and verification remain free`);
    if (current.budget.wall_clock_minutes !== null && Date.now() - Date.parse(current.created_at) >= current.budget.wall_clock_minutes * 60_000) return deny(`wall-clock budget exhausted (${current.budget.wall_clock_minutes}m)`);
    if (current.budget.output_tokens !== null && current.spent.output_tokens_estimate >= current.budget.output_tokens) return deny(`output-token budget exhausted (${current.spent.output_tokens_estimate}/${current.budget.output_tokens})`);
    const targets = writeFileTargets(tool, mapping).map((value) => repoRelative(repo, value)).filter(Boolean);
    for (const target of targets) if (!insideEnvelope(target, current.envelope.files)) return deny(`write outside envelope: ${target}`);
    const next = transition(current, { type: "record-write", files: targets, at: now() }).task;
    saveTask(repo, next);
    return 0;
  });
}

function hookStop(repo, task, payload) {
  if (task.lifecycle.state === "suspended" || task.lifecycle.state === "terminal") return 0;
  withTaskLock(repo, () => {
    const current = readTask(repo);
    if (current) tallyTranscript(repo, current, payload.transcript_path);
  });
  return closeAttempt(repo, { explicit: false, stop: true });
}

function dispatchHook() {
  const payload = loadPayload(); const event = String(payload.hook_event_name ?? "").toLowerCase(); const repo = payloadRepo(payload);
  const mapping = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const writeShaped = gitOps(mapping).length > 0 || looksLikeWrite(String(payload.tool_name ?? ""), mapping);
  let task;
  try { task = readTask(repo); }
  catch (err) {
    process.stderr.write(`${err.message}\n`);
    if (event === "pretooluse" && writeShaped) return deny("task state unavailable; refusing an untracked write");
    if (event === "stop") return block("task state unavailable; refusing to adjudicate Stop");
    return 0;
  }
  if (!task) {
    if (event !== "pretooluse") return 0;
    const result = observeUntracked({ payload, repo, writeShaped, writeTargets: writeFileTargets(String(payload.tool_name ?? ""), mapping), scriptPath: process.argv[1] ?? "taskloop.mjs" });
    if (result.kind === "deny") return deny(result.message.replace(/^taskloop:\s*/, ""));
    if (result.kind === "notice") process.stderr.write(result.message + "\n");
    return 0;
  }
  try { if (event === "pretooluse") return hookPretool(payload, repo, task); if (event === "stop") return hookStop(repo, task, payload); }
  catch (err) {
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
    if (verb === "help") return cmdHelp(); if (verb === "info") return cmdInfo(); if (verb === "hooks") return cmdHooks(); if (verb === "audit") return cmdAudit();
    if (verb === "open") return cmdOpen(values); if (verb === "status") return cmdStatus(values); if (verb === "verify") return cmdVerify(values); if (verb === "achieve") return closeAttempt(repoOf(values), { explicit: true, provisional: values.provisional });
    if (verb === "not-needed" || verb === "abandon") return terminalCommand(values, verb); if (verb === "suspend") return cmdSuspend(values); if (verb === "resume") return cmdResume(values); if (verb === "review") return cmdReview(values); if (verb === "amend") return cmdAmend(values); return cmdArchive(values);
  } catch (err) { return error(err?.message ?? err); }
}

export { main };
