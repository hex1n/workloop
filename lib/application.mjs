import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  CRITERION_TIMEOUT_SECONDS,
  LEDGER_EVENT_SCHEMA_VERSION,
  NO_PROGRESS_STOPS,
  RUNTIME_CONTRACT,
  STATE_DIR,
  STUCK_REPEATS,
  TASK_SCHEMA_VERSION,
  fnv1aHex,
  isPlainObject,
  localTimestamp,
  outputTail,
  repoRelative,
} from "./prims.mjs";
import { criterionDrift, criterionMetadata, resolveCriterionFile, resolveSubject, runCriterionSource } from "./criterion.mjs";
import { commandSafetyFailure, commandValues, controlPlaneWriteFailure, envelopeDirty, envelopeOverlap, foreignWriteDecision, gitOps, insideEnvelope, joinedFileOffender, joinedFilesMessage, looksLikeWrite, siblingWorktreeOpenTasks, warnZeroMatchEnvelope, writeFileTargets } from "./supervision.mjs";
import { assertTaskSchema, closureProjection, constructAssurance, constructPolicy, criterionDefinitionHash, createTask, machineRiskFloor, policyName, projectAssurance, projectBudgetExhaustion, projectProofAssurance, projectReviewRequirement, transition, validateAssurance } from "./task-engine.mjs";
import { archiveIncompatibleState, archiveTask, loadTask, saveTask, taskPath, withTaskLock } from "./task-store.mjs";
import { appendOutcomeEvent, auditLedger, ledgerPath, makeEvent } from "./outcome-ledger.mjs";
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
  audit: {}, info: {}, hooks: {}, help: {},
};

function now() { return localTimestamp(); }
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
  const completeEnd = content.lastIndexOf("\n") + 1;
  const episode = task.episodes.at(-1);
  const boundEpisode = taskOwnerSessionId(task) && normalizedIdentity(episode?.episode_id);
  const episodeId = boundEpisode || `legacy:${task.task_id}`;
  const cursor = isPlainObject(cursors[absolute]) ? cursors[absolute] : null;
  const legacyCompatible = !boundEpisode && cursor?.task_id === task.task_id && cursor.episode_id === undefined;
  const continuingEpisode = cursor?.task_id === task.task_id && (cursor.episode_id === episodeId || legacyCompatible);
  if (!continuingEpisode && boundEpisode) {
    cursors[absolute] = { task_id: task.task_id, episode_id: episodeId, offset: completeEnd };
    try { fs.mkdirSync(path.dirname(cursorPath), { recursive: true }); fs.writeFileSync(cursorPath, JSON.stringify(cursors, null, 2) + "\n", "utf8"); } catch { /* token telemetry is best effort */ }
    return task;
  }
  const previous = continuingEpisode || (!boundEpisode && cursor) ? cursor.offset : 0;
  const offset = Number.isSafeInteger(previous) && previous >= 0 && previous <= content.length ? previous : 0;
  if (completeEnd <= offset) return task;
  let delta = 0;
  for (const line of content.slice(offset, completeEnd).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const timestamp = transcriptTimestamp(row);
      if (continuingEpisode || timestamp === null || timestamp >= Date.parse(task.created_at)) delta += transcriptTokens(row);
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
  cursors[absolute] = { task_id: task.task_id, episode_id: episodeId, offset: completeEnd };
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
    alignment: task.alignment, envelope: task.envelope, assurance: projectAssurance(task), budget: task.budget,
  };
  return details;
}

function assuranceNextActions(task, { drift = false } = {}) {
  const actions = [];
  if (projectProofAssurance(task, { drift }).state === "gap") actions.push("strengthen criterion or accept-proof-gap --reason R --granted-by user|self");
  const review = projectReviewRequirement(task);
  if (!review.accepted) actions.push(`obtain and record ${review.level.replaceAll("_", "-")} review with zero blocking findings`);
  return actions;
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
      const actingSession = hostSessionId();
      task = createTask({ taskId: randomUUID(), goal, criterion, observation, policyName: internalPolicy, policyRationale: values.reason, at, actingSession, alignment: { because, not_covered: values["not-covered"] ?? [] }, envelope: { files, git: authority.git, destructive: authority.destructive, network: authority.network }, grants: authority.grants, assurance: assuranceFrom(values), budget: { rounds: parseInteger(values.rounds, "rounds", { minimum: 1 }) ?? 8, writes: parseInteger(values.writes, "writes"), wall_clock_minutes: parseInteger(values["wall-clock-minutes"], "wall-clock-minutes"), output_tokens: parseInteger(values["token-budget"], "token-budget") }, episodes: [{ episode_id: randomUUID(), host_session_id: actingSession, started_at: at, ended_at: null, start_task_revision: 1, end_task_revision: null, output_tokens_estimate: 0 }] });
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
  const drift = criterionDrift(task.criterion, repo).length > 0;
  const closure = closureProjection(task, { drift });
  const owner = taskOwnerSessionId(task); const cliIdentity = hostSessionId(); const episodeId = normalizedIdentity(task.episodes.at(-1)?.episode_id);
  const contact = task.last_observed_owner_hook_contact?.episode_id === episodeId ? task.last_observed_owner_hook_contact : null;
  const bindingNextAction = task.lifecycle.state === "terminal" ? null : task.lifecycle.state === "suspended" ? "resume --reason R in the continuing host session" : owner && cliIdentity !== owner ? "taskloop join --reason R to continue this task; use a separate worktree for parallel work" : null;
  const sessionBinding = { bound: Boolean(owner), cli_identity_matches_owner: owner && cliIdentity !== "cli" ? cliIdentity === owner : null, last_observed_owner_hook_contact: contact, next_action: bindingNextAction };
  process.stdout.write(JSON.stringify({ task_schema_version: task.schema_version, task_id: task.task_id, lifecycle: task.lifecycle, goal: task.goal, policy: task.policy, criterion: task.criterion, proof_assurance: projectProofAssurance(task, { drift }), review_requirement: projectReviewRequirement(task), machine_risk_floor: machineRiskFloor(task), next_actions: assuranceNextActions(task, { drift }), closure, alignment: task.alignment, assurance: task.assurance, budget: task.budget, spent: task.spent, artifact_revision: task.artifact_revision, last_substantive_task_revision: task.last_substantive_task_revision, session_binding: sessionBinding }, null, 2) + "\n");
  return 0;
}

function reportBudgetLimit(value, suffix = "") {
  return value === null ? "unbounded" : `${value}${suffix}`;
}

function cmdReport(values) {
  const repo = repoOf(values); const task = readTask(repo);
  if (!task) return error("no task");
  if (values.json && values.markdown) return error("choose one of --json or --markdown");
  const atEpochMs = Date.now();
  const projectedWallClockMs = task.lifecycle.state === "terminal" ? task.spent.wall_clock_ms : Math.max(task.spent.wall_clock_ms, atEpochMs - Date.parse(task.created_at));
  const drift = criterionDrift(task.criterion, repo).length > 0;
  const closure = task.lifecycle.state === "active" ? closureProjection(task, { drift }) : null;
  const deviations = task.evidence.touched_files.filter((file) => !insideEnvelope(file, task.envelope.files));
  const payload = {
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

function budgetSuspension(exhausted) {
  const failure = exhausted.map((item) => `${BUDGET_DIMENSION_PRESENTATION[item.dimension].label} budget exhausted (${item.spent}/${item.limit})`).join("; ");
  const options = exhausted.map((item) => BUDGET_DIMENSION_PRESENTATION[item.dimension].option).join(" and ");
  return { reason: "out_of_budget", failure, next_action: `amend ${options} with a reason, then resume` };
}

function failureSuspension(task, observation, atEpochMs) {
  if (observation.verdict !== "unsatisfied") return null;
  const exhausted = projectBudgetExhaustion(task, atEpochMs);
  if (exhausted.length) return budgetSuspension(exhausted);
  const signatures = task.attempts.slice(-STUCK_REPEATS).map((attempt) => attempt.signature);
  if (signatures.length === STUCK_REPEATS && new Set(signatures).size === 1) return { reason: "stuck", failure: `same failure repeated ${STUCK_REPEATS} times` };
  const recent = task.attempts.slice(-NO_PROGRESS_STOPS);
  if ((task.unsatisfied_streak ?? 0) >= NO_PROGRESS_STOPS && recent.length === NO_PROGRESS_STOPS && new Set(recent.map((attempt) => `${attempt.criterion_generation_id}@${attempt.artifact_revision}`)).size === 1) {
    return { reason: "stuck", failure: `no artifact progress across ${NO_PROGRESS_STOPS} attempts` };
  }
  return null;
}

function closeAttempt(repo, { explicit, stop = false, sessionId = null, transcriptPath = null }) {
  return withTaskLock(repo, () => {
    let task = readTask(repo);
    if (!task) return stop ? 0 : error("no task");
    if (task.lifecycle.state === "suspended") return stop ? 0 : error("task is suspended; resume first");
    if (task.lifecycle.state === "terminal") return 0;
    if (stop && isForeignSession(task, sessionId)) return 0;
    if (stop) task = recordOwnerHookContact(task, sessionId, now());
    if (stop) task = tallyTranscript(repo, task, transcriptPath);
    const observation = runObservation(task, repo);
    if (observation.execution.execution_error === "criterion_side_effect") {
      const at = now();
      const next = transition(task, { type: "criterion-side-effect", observation, at }).task;
      saveTask(repo, next);
      const message = `criterion indeterminate; closure not_ready(criterion_indeterminate); criterion side effect: ${observation.changed_paths.join(", ")}`;
      return stop ? block(message) : error(message);
    }
    const drift = criterionDrift(task.criterion, repo);
    const atEpochMs = Date.now(); const at = localTimestamp(atEpochMs);
    const actingSession = stop ? sessionId : hostSessionId();
    const result = transition(task, { type: explicit ? "achieve" : "observe", source: explicit ? "achieve" : "stop", actingSession, observation, drift, attemptId: randomUUID(), signature: fnv1aHex(observation.execution.output_tail), failureSummary: outputTail(observation.execution.output_tail, 160), at });
    let next = result.task;
    const suspension = failureSuspension(next, observation, atEpochMs);
    if (suspension) {
      const judgment = {
        remaining: `criterion must become satisfied: ${next.criterion.source.value}`,
        failure: suspension.failure,
        next_action: suspension.reason === "out_of_budget" ? suspension.next_action : "change the approach or inputs, then resume",
      };
      next = transition(next, { type: "suspend", reason: suspension.reason, judgment, source: stop ? "stop" : "cli", actingSession, at }).task;
      next.last_issued_event_sequence += 1;
      persistEvent(repo, next, "task_suspended", { reason: suspension.reason, judgment, spent: next.spent, artifact_revision: next.artifact_revision }, at);
      return stop ? block(`criterion unsatisfied; task suspended(${suspension.reason}): ${judgment.failure}`) : error(`criterion unsatisfied; task suspended(${suspension.reason}): ${judgment.failure}`);
    }
    if (!explicit && observation.verdict === "satisfied" && result.meta.closure?.state === "eligible" && next.policy.close_policy === "automatic") {
      next = transition(next, { type: "achieve", source: "stop", actingSession, observation: { ...observation, observation_id: randomUUID() }, drift, at }).task;
    }
    saveTask(repo, next);
    if (next.lifecycle.state === "terminal") {
      next.last_issued_event_sequence += 1;
      saveTask(repo, next);
      const advisoryFindings = projectReviewRequirement(task).advisory_findings_count ?? 0;
      appendOutcomeEvent(makeEvent({ task: next, kind: "task_terminal", payload: { outcome: "achieved", closing_observation_id: next.lifecycle.closing_observation_id, proof_provisional: next.lifecycle.proof_provisional, assurance: projectAssurance(next, { ignoreLifecycle: true }), spent: next.spent, review_level: bestReview(next), advisory_findings_count: advisoryFindings, artifact_revision: next.artifact_revision }, repoIdentity: repoIdentity(repo), at }));
      const waiver = next.assurance.review_policy === "waived" ? `; review waived: ${next.assurance.review_waiver_reason} (${next.assurance.review_waiver_granted_by})` : "";
      const closeout = `taskloop: terminal(achieved); criterion satisfied; advisory findings: ${advisoryFindings}${waiver}; not covered: ${(next.alignment.not_covered ?? []).join(", ") || "none"}\n`;
      if (stop) process.stderr.write(closeout); else process.stdout.write(closeout);
      return 0;
    }
    const closure = result.meta.closure ?? closureProjection(next, { drift: drift.length > 0 });
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
    try { result = transition(task, type === "not-needed" ? { type, evidence: values.evidence, actingSession: hostSessionId(), at } : { type, reason: values.reason, actingSession: hostSessionId(), at }); }
    catch (err) { return error(err.message); }
    const next = result.task; next.last_issued_event_sequence += 1;
    const payload = next.lifecycle.outcome === "not_needed" ? { outcome: "not_needed", evidence: next.lifecycle.evidence, verified_at_task_revision: next.lifecycle.verified_at_task_revision, assurance: projectAssurance(next, { ignoreLifecycle: true }), spent: next.spent } : { outcome: "abandoned", reason: next.lifecycle.reason, assurance: projectAssurance(next, { ignoreLifecycle: true }), spent: next.spent };
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
    try { next = transition(task, { type: "suspend", reason, judgment: { remaining: values.remaining, failure: values.failure, next_action: values["next-action"] }, closeEpisode: true, source: "cli", actingSession: hostSessionId(), at }).task; }
    catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1; persistEvent(repo, next, "task_suspended", { reason: next.lifecycle.reason, judgment: next.lifecycle.judgment, spent: next.spent, artifact_revision: next.artifact_revision }, at); return 0;
  });
}

function cmdResume(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task"); const atEpochMs = Date.now(); const at = localTimestamp(atEpochMs);
    let next; const episode = { episode_id: randomUUID(), host_session_id: hostSessionId(), started_at: at, ended_at: null, start_task_revision: task.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0 };
    try { next = transition(task, { type: "resume", reason: values.reason, episode, actingSession: episode.host_session_id, at, atEpochMs }).task; } catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1; persistEvent(repo, next, "task_resumed", { reason: values.reason, new_episode_id: episode.episode_id, spent: next.spent }, at); return 0;
  });
}

function cmdJoin(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task");
    const sessionId = hostSessionId();
    if (sessionId === "cli") return error("join requires a real host identity; set TASKLOOP_SESSION_ID to the host payload-domain session id or run inside a host that exports one");
    const at = now();
    const episode = { episode_id: randomUUID(), host_session_id: sessionId, started_at: at, ended_at: null, start_task_revision: task.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0 };
    let next; try { next = transition(task, { type: "join", reason: values.reason, episode, actingSession: sessionId, at }).task; } catch (err) { return error(err.message); }
    saveTask(repo, next);
    return 0;
  });
}

function cmdReview(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task"); const at = now();
    const level = String(values.level ?? "").replaceAll("-", "_");
    const record = { review_id: randomUUID(), criterion_generation_id: task.criterion.criterion_generation_id, reviewed_task_revision: task.last_substantive_task_revision, reviewed_artifact_revision: task.artifact_revision, level, reviewer: String(values.reviewer ?? "").trim(), blocking_findings_count: parseInteger(values["blocking-findings"], "blocking-findings", { minimum: 0, nullable: false }), advisory_findings_count: parseInteger(values["advisory-findings"], "advisory-findings", { minimum: 0, nullable: false }), reviewed_at: at, acting_session: normalizedIdentity(hostSessionId()) === "cli" ? null : hostSessionId() };
    if (!record.reviewer) return error("review requires --reviewer");
    let next; try { next = transition(task, { type: "review", record, at }).task; } catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1;
    const { review_id: _reviewId, acting_session: _actingSession, ...ledgerReview } = record;
    persistEvent(repo, next, "task_reviewed", { ...ledgerReview, assurance: projectAssurance(next) }, at); return 0;
  });
}

function cmdAcceptProofGap(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo); if (!task) return error("no task");
    const at = now(); const record = { acceptance_id: randomUUID(), reason: String(values.reason ?? "").trim(), granted_by: grantProvenance(values["granted-by"]), accepted_at: at };
    let next; try { next = transition(task, { type: "accept-proof-gap", record, at }).task; } catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1;
    persistEvent(repo, next, "proof_gap_accepted", { ...record, criterion_generation_id: next.criterion.criterion_generation_id, accepted_at_task_revision: next.task_revision, assurance: projectAssurance(next) }, at);
    return 0;
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
    let next; try { next = transition(task, event).task; } catch (err) { return error(err.message); }
    next.last_issued_event_sequence += 1;
    const payload = {
      changed_fields: Object.keys(event).filter((k) => !new Set(["type", "reason", "at"]).has(k)),
      reason: values.reason,
      before_substantive_revision: task.last_substantive_task_revision,
      after_substantive_revision: next.last_substantive_task_revision,
      ...(event.grants?.length ? { grants: event.grants } : {}),
      ...((event.assurance || event.grants?.length) ? { assurance: projectAssurance(next) } : {}),
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
  const script = path.resolve(process.argv[1] ?? "taskloop.mjs");
  const quotedScript = process.platform === "win32" ? `"${script}"` : JSON.stringify(script);
  const command = `node ${quotedScript}`;
  process.stdout.write(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command, timeout: 20 }] }], Stop: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 300 }] }] } }, null, 2) + "\n"); return 0;
}
function cmdHelp() { process.stdout.write(`taskloop — criterion-driven work supervisor\n\nopen --goal G (--criterion C|--criterion-file F) --criterion-policy default|deferred-witness|steady-satisfied --alignment-because B [--not-covered N] --files GLOB\n     [--risk routine|substantial|critical] [--risk-reason R] [--change-class CLASS]\n     [--review-policy risk-based|required|waived] [--required-review-level fresh-context|second-model] [--review-waiver-reason R]\n     [--rounds N] [--writes N] [--wall-clock-minutes N] [--token-budget N]\n     [--git-allowed OP --git-reason R] [--destructive-allowed] [--network-allowed] [--install-scripts-allowed] [--publish-allowed] [--granted-by self|user] --reason R\nstatus | verify | report [--json|--markdown] | achieve | accept-proof-gap --reason R --granted-by user|self | not-needed --evidence E | abandon --reason R\nsuspend --reason needs-input|stuck|out-of-budget --remaining R --failure F --next-action N\nresume --reason R | join --reason R | amend ... --reason R\nreview --level fresh-context|second-model|self-reread --reviewer ID --blocking-findings N --advisory-findings N\narchive-incompatible-state --reason R --granted-by user\naudit | info | hooks\n\ncriterion observations: unsatisfied | satisfied | indeterminate\nlifecycle: active | suspended(reason) | terminal(outcome)\n`); return 0; }

function loadPayload() { try { const value = JSON.parse(fs.readFileSync(0, "utf8")); return isPlainObject(value) ? value : {}; } catch { return {}; } }
function payloadRepo(payload) { return path.resolve(payload.cwd ?? payload.tool_input?.cwd ?? process.cwd()); }

function hookPretool(payload, repo, task) {
  const mapping = payload.tool_input ?? {};
  const tool = String(payload.tool_name ?? "");
  const sessionId = payloadSessionId(payload);
  return withTaskLock(repo, () => {
    let current = readTask(repo);
    if (!current || current.lifecycle.state === "terminal") return allowTaskloopCommand(payload, mapping, tool);
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
    current = tallyTranscript(repo, current, payload.transcript_path);
    const ops = gitOps(mapping);
    const writeShaped = ops.length > 0 || looksLikeWrite(tool, mapping);
    if (current.lifecycle.state === "suspended") return writeShaped ? deny(`task suspended (${current.lifecycle.reason}); resume before writing`) : allowTaskloopCommand(payload, mapping, tool);
    const deniedGit = ops.filter((op) => !(current.envelope.git ?? []).includes(op));
    if (deniedGit.length) return deny(`git operation(s) need envelope authorization: ${deniedGit.join(", ")}`);
    for (const command of commandValues(mapping)) {
      const failure = commandSafetyFailure(current, command);
      if (failure) return deny(failure);
    }
    if (!writeShaped) return allowTaskloopCommand(payload, mapping, tool);
    const atEpochMs = Date.now(); const at = localTimestamp(atEpochMs);
    const exhausted = projectBudgetExhaustion(current, atEpochMs);
    if (exhausted.length) {
      const first = exhausted[0];
      return deny(BUDGET_DIMENSION_PRESENTATION[first.dimension].denial(first));
    }
    const targets = writeFileTargets(tool, mapping).map((value) => repoRelative(repo, value)).filter(Boolean);
    for (const target of targets) if (!insideEnvelope(target, current.envelope.files)) return deny(`write outside envelope: ${target}`);
    const next = transition(current, { type: "record-write", files: targets, at }).task;
    recordOwnerHookContact(next, sessionId, at);
    saveTask(repo, next);
    return allowTaskloopCommand(payload, mapping, tool);
  });
}

function hookStop(repo, task, payload) {
  if (task.lifecycle.state === "suspended" || task.lifecycle.state === "terminal") return 0;
  const sessionId = payloadSessionId(payload);
  if (isForeignSession(task, sessionId)) return 0;
  return closeAttempt(repo, { explicit: false, stop: true, sessionId, transcriptPath: payload.transcript_path });
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
    const result = observeUntracked({ payload, sessionId: payloadSessionId(payload), repo, writeShaped, writeTargets: writeFileTargets(String(payload.tool_name ?? ""), mapping), scriptPath: process.argv[1] ?? "taskloop.mjs" });
    if (result.kind === "deny") return deny(result.message.replace(/^taskloop:\s*/, ""));
    if (result.kind === "notice") process.stderr.write(result.message + "\n");
    return allowTaskloopCommand(payload, mapping, String(payload.tool_name ?? ""));
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
    if (verb === "open") return cmdOpen(values); if (verb === "status") return cmdStatus(values); if (verb === "verify") return cmdVerify(values); if (verb === "report") return cmdReport(values); if (verb === "achieve") return closeAttempt(repoOf(values), { explicit: true });
    if (verb === "accept-proof-gap") return cmdAcceptProofGap(values);
    if (verb === "not-needed" || verb === "abandon") return terminalCommand(values, verb); if (verb === "suspend") return cmdSuspend(values); if (verb === "resume") return cmdResume(values); if (verb === "join") return cmdJoin(values); if (verb === "review") return cmdReview(values); if (verb === "amend") return cmdAmend(values); return cmdArchive(values);
  } catch (err) { return error(err?.message ?? err); }
}

export { main };
