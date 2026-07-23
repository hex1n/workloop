import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  BUDGET_DIMENSIONS,
  CRITERION_TIMEOUT_SECONDS,
  CRITERION_ADAPTER_PROTOCOL_VERSION,
  RUNTIME_CONTRACT,
  EVENT_STORE_FILE,
  LEGACY_EVENT_STORE_FILE,
  OUTCOME_PROJECTION_FILE,
  V3_EVENT_RECORD_SCHEMA_VERSION,
  V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  V3_TASK_SNAPSHOT_SCHEMA_VERSION,
  cloneJson,
  fnv1aHex,
  isPlainObject,
  isSyntheticTouchedFile,
  localTimestamp,
  sha256Hex,
  userHome,
  utcTimestamp,
  outputTail,
  outputHead,
  repoRelative,
} from "./prims.mjs";
import { CRITERION_OPERATION_CLEANUP_MS, artifactCheckpointDelta, artifactCheckpointFromSnapshot, changedSnapshotPaths, criterionDrift, criterionMessage, criterionMetadata, repoSnapshot, resolveCriterionFile, resolveSubject, runCriterionSource, validateRepoSnapshot } from "./criterion.mjs";
import { buildRecord, commitRecord, eventStoreNameState, eventStorePath, makeSourceCursor, migrateLegacyEventStoreName, readEventStore, readEventStoreTail, verifyEventStoreSourceCursor } from "./event-store.mjs";
import { analyzeToolCall, commandExecutionViews, commandSafetyFailure, commandValues, controlPlaneWriteFailure, envelopeDirty, envelopeOverlap, foreignWriteDecision, insideEnvelope, joinedFileOffender, joinedFilesMessage, looksLikeWrite, ownerExternalTargetDenial, ownerGitDenial, scopedDestructiveAttribution, siblingWorktreeOpenTasks, warnZeroMatchEnvelope, writeFileTargets } from "./supervision.mjs";
import { assertV3TaskProjection, closureProjection, constructAssurance, constructPolicy, criterionDefinitionHash, decide, evolveAll, evolveAllCurrentAuthority, machineRiskFloor, policyName, projectBudgetExhaustion, projectProofAssurance, projectReviewRequirement, validateAssurance } from "./task-engine.mjs";
import { archiveIncompatibleState, buildTaskSnapshot, inspectTaskSnapshot, quarantineDamagedTaskSnapshot, readCriterionLease, saveTaskSnapshot, taskPath, withCriterionLease, withTaskLock } from "./task-store.mjs";
import { auditOutcomeProjection, migrateLegacyOutcomeNames, syncOutcomeRecords } from "./outcome-projector.mjs";
import { clearUntracked, observeUntracked } from "./untracked.mjs";
import { appendEvidence, evidencePath, foldEvidence, pretooluseEvidenceState, readEvidence } from "./evidence-ledger.mjs";
import { EXPLICIT_PROFILES, PRE_TOOL_USE_RECIPE_TIMEOUT_SECONDS, POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS, STOP_INLINE_CRITERION_SECONDS, STOP_RUNTIME_DEADLINE_SECONDS, buildHookRecipe, decodeHook, encodeHook, hostProfileCapability } from "./host-hooks.mjs";
import { createLockManager, runAuthorityTransaction } from "./authority-transaction.mjs";
import { openCurrentGitTask, queryCurrentGit, recordCurrentGitHook } from "./git-authority-provider.mjs";

const OPTION = { type: "string" };
const BOOL = { type: "boolean" };
const WRITE_COMMAND_SHAPES = new Set(["publish", "git_push", "destructive", "install", "network_write", "dynamic_exec"]);
const OBSERVATION_COMMIT_VALIDATION_MS = 50;
const ASSURANCE_OPTIONS = { risk: OPTION, "risk-reason": OPTION, "change-class": { type: "string", multiple: true }, "review-policy": OPTION, "required-review-level": OPTION, "review-waiver-reason": OPTION };
// Deny text per budget dimension; the dimension labels come from the shared
// BUDGET_DIMENSIONS map so the deny and the suspension name the same thing.
const BUDGET_DENIALS = Object.freeze({
  rounds: ({ spent, limit }) => `${BUDGET_DIMENSIONS.rounds.label} budget exhausted (${spent}/${limit}); reads and verification remain free`,
  writes: ({ spent, limit }) => `${BUDGET_DIMENSIONS.writes.label} budget exhausted (${spent}/${limit}); reads and verification remain free`,
  wall_clock: ({ limit }) => `${BUDGET_DIMENSIONS.wall_clock.label} budget exhausted (${limit / 60_000}m)`,
  output_tokens: ({ spent, limit }) => `${BUDGET_DIMENSIONS.output_tokens.label} budget exhausted (${spent}/${limit})`,
});
const OPTIONS = {
  open: { repo: OPTION, goal: OPTION, criterion: OPTION, "criterion-file": OPTION, "criterion-protocol": OPTION, "criterion-policy": OPTION, "criterion-authored-by": OPTION, "history-requirement": OPTION, reason: OPTION, "alignment-because": OPTION, "not-covered": { type: "string", multiple: true }, files: { type: "string", multiple: true }, "criterion-subject": { type: "string", multiple: true }, ...ASSURANCE_OPTIONS, rounds: OPTION, writes: OPTION, "wall-clock-minutes": OPTION, "token-budget": OPTION, "criterion-timeout-seconds": OPTION, "git-allowed": { type: "string", multiple: true }, "git-reason": OPTION, "destructive-allowed": BOOL, "destructive-scope": { type: "string", multiple: true }, "network-allowed": BOOL, "install-scripts-allowed": BOOL, "publish-allowed": BOOL, "granted-by": OPTION },
  status: { repo: OPTION }, verify: { repo: OPTION, record: BOOL }, achieve: { repo: OPTION }, report: { repo: OPTION, json: BOOL, markdown: BOOL },
  "accept-proof-gap": { repo: OPTION, reason: OPTION, "granted-by": OPTION },
  "not-needed": { repo: OPTION, evidence: OPTION }, abandon: { repo: OPTION, reason: OPTION },
  suspend: { repo: OPTION, reason: OPTION, remaining: OPTION, failure: OPTION, "next-action": OPTION },
  resume: { repo: OPTION, reason: OPTION },
  join: { repo: OPTION, reason: OPTION },
  review: { repo: OPTION, level: OPTION, reviewer: OPTION, "blocking-findings": OPTION, "advisory-findings": OPTION },
  amend: { repo: OPTION, reason: OPTION, goal: OPTION, criterion: OPTION, "criterion-file": OPTION, "criterion-protocol": OPTION, "criterion-policy": OPTION, "criterion-authored-by": OPTION, "history-requirement": OPTION, "alignment-because": OPTION, "not-covered": { type: "string", multiple: true }, files: { type: "string", multiple: true }, "criterion-subject": { type: "string", multiple: true }, ...ASSURANCE_OPTIONS, rounds: OPTION, writes: OPTION, "wall-clock-minutes": OPTION, "token-budget": OPTION, "git-allowed": { type: "string", multiple: true }, "git-reason": OPTION, "destructive-allowed": BOOL, "destructive-scope": { type: "string", multiple: true }, "network-allowed": BOOL, "install-scripts-allowed": BOOL, "publish-allowed": BOOL, "granted-by": OPTION },
  "archive-incompatible-state": { repo: OPTION, reason: OPTION, "granted-by": OPTION },
  "migrate-artifact-names": { repo: OPTION, reason: OPTION, "granted-by": OPTION },
  audit: { repo: OPTION }, ledger: { repo: OPTION, json: BOOL }, "sync-outcomes": { repo: OPTION }, "audit-outcomes": {}, info: {}, hooks: { repo: OPTION, profile: OPTION, mode: OPTION, action: OPTION }, hook: { profile: OPTION, mode: OPTION }, help: {},
  "current-open": { target: OPTION, goal: OPTION, files: { type: "string", multiple: true }, "command-id": OPTION, reason: OPTION, "granted-by": OPTION },
  "current-status": { target: OPTION },
  "current-audit": { target: OPTION },
  "current-ledger": { target: OPTION },
  "current-tasks": { target: OPTION },
  "current-hook": { profile: OPTION, mode: OPTION },
};

function now() { return utcTimestamp(Date.now()); }
function contractDescriptor() {
  return {
    runtime_contract: RUNTIME_CONTRACT,
    criterion_adapter_protocol_version: CRITERION_ADAPTER_PROTOCOL_VERSION,
    task_snapshot_schema_version: V3_TASK_SNAPSHOT_SCHEMA_VERSION,
    event_record_schema_version: V3_EVENT_RECORD_SCHEMA_VERSION,
    outcome_projection_schema_version: V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  };
}
function normalizedIdentity(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function hasWriteCommandShape(shapes) { return shapes.some((shape) => WRITE_COMMAND_SHAPES.has(shape)); }
function artifactEvidenceTask(task) { return Number(task?.runtime_contract) >= 6; }
function taskPreExecutionCoverage(task) { return task?.runtime_contract === 7 ? task.authority.pre_execution_observation : task.authority.prewrite_enforcement; }

function historyRequirementFrom(values, current = null) {
  const explicit = values["history-requirement"]?.replaceAll("-", "_");
  if (explicit !== undefined && !new Set(["artifact_only", "complete"]).has(explicit)) throw new Error("--history-requirement must be artifact-only or complete");
  const effectiveRisk = values.risk ?? current?.assurance?.declared_risk;
  const finiteWrites = values.writes !== undefined || current?.budget?.writes !== null && current?.budget?.writes !== undefined;
  if (explicit === "artifact_only" && current?.history_requirement === "complete") throw new Error("cannot relax complete mutation history to artifact-only");
  if (explicit === "artifact_only" && effectiveRisk === "critical") throw new Error("critical risk requires complete mutation history");
  const finiteWritesRequireComplete = (current?.runtime_contract ?? RUNTIME_CONTRACT) === 6;
  if (explicit === "artifact_only" && finiteWrites && finiteWritesRequireComplete) throw new Error("finite write budget requires complete mutation history");
  if (explicit) return explicit;
  if (effectiveRisk === "critical" || finiteWrites && finiteWritesRequireComplete) return "complete";
  return current?.history_requirement ?? "artifact_only";
}

function currentScopeViolations(task, checkpoint) {
  if (!artifactEvidenceTask(task)) return [];
  return artifactCheckpointDelta(task.artifact_baseline, checkpoint).changed_paths
    .filter((entryPath) => !insideEnvelope(entryPath, task.envelope.files));
}

function hasCommandWriteTarget(tool, mapping, callAnalysis) {
  return callAnalysis.commands.length > 0 && writeFileTargets(tool, mapping, callAnalysis).length > 0;
}

// The one definition of "this tool call is write-shaped" for the hook paths.
// Every gate that needs the answer calls this; a second inline composition is
// how the gates drift apart.
function writeShapedCall(tool, mapping, callAnalysis) {
  return callAnalysis.git.ops.length > 0
    || looksLikeWrite(tool, mapping, callAnalysis)
    || hasCommandWriteTarget(tool, mapping, callAnalysis)
    || hasWriteCommandShape(callAnalysis.shapes);
}

// MCP servers expose an open-ended tool namespace. Contract 7 treats unknown
// MCP actions as possible side effects so host-approved mutations still get an
// intent and completion receipt, while a conservative read-verb allowlist
// avoids charging obvious queries as operations.
const MCP_READ_VERBS = new Set(["get", "list", "read", "search", "find", "fetch", "query", "view", "inspect", "lookup", "describe", "check", "validate", "preview", "status", "count"]);
const MCP_AMBIGUOUS_OR_MUTATING_TOKENS = new Set([
  "and", "or", "then", "with", "create", "update", "edit", "write", "set", "mark", "resolve", "delete", "remove",
  "archive", "close", "open", "submit", "publish", "send", "post", "add", "move", "rename", "merge", "approve",
  "reject", "cancel", "retry", "run", "execute", "trigger", "sync", "upload", "import", "install", "apply", "ack",
]);
function opaqueMcpOperation(tool) {
  const normalized = String(tool ?? "").toLowerCase();
  if (!normalized.startsWith("mcp__")) return false;
  const action = normalized.split("__").slice(2).join("_");
  const tokens = action.split("_").filter(Boolean);
  return !MCP_READ_VERBS.has(tokens[0]) || tokens.slice(1).some((token) => MCP_AMBIGUOUS_OR_MUTATING_TOKENS.has(token));
}

function contract7OperationShaped(tool, mapping, callAnalysis) {
  return writeShapedCall(tool, mapping, callAnalysis) || opaqueMcpOperation(tool);
}
function persistedOperationTargets(repo, rawTargets) {
  return [...new Set(rawTargets.map((value) => repoRelative(repo, value)).filter(Boolean).map((value) => {
    const portable = String(value).replaceAll("\\", "/");
    const normalized = path.posix.normalize(portable);
    return path.posix.isAbsolute(portable) || path.win32.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")
      ? "<external-target>"
      : portable;
  }))];
}
function canonicalToolFamily(tool) {
  const normalized = String(tool ?? "").toLowerCase();
  if (normalized.includes("apply_patch") || normalized === "edit" || normalized === "multiedit" || normalized === "write") return "direct_write";
  if (normalized === "bash" || normalized === "powershell" || normalized.includes("shell")) return "shell";
  if (normalized.startsWith("mcp__")) return "mcp";
  return normalized || "unknown";
}
function hostSessionId() {
  return normalizedIdentity(process.env.WORKLOOP_SESSION_ID)
    ?? normalizedIdentity(process.env.CLAUDE_CODE_SESSION_ID)
    ?? "cli";
}
function actingSessionId() { return normalizedIdentity(process.env.WORKLOOP_ACTING_SESSION_ID) ?? hostSessionId(); }
function taskOwnerSessionId(task) {
  const value = normalizedIdentity(task?.episodes?.at(-1)?.host_session_id);
  return value && value !== "cli" ? value : null;
}
function isForeignSession(task, sessionId) {
  const owner = taskOwnerSessionId(task);
  return Boolean(owner && sessionId && owner !== sessionId);
}
function hookActor(invocation) { return isSafeHookSessionId(invocation?.agentId) ? invocation.agentId : normalizedIdentity(invocation?.sessionId); }
function appendHookEvidence(repo, invocation, row, options = undefined) {
  const actingSession = hookActor(invocation);
  return appendEvidence(repo, {
    at: utcTimestamp(Date.now()), sequence_session: normalizedIdentity(invocation?.sessionId) ?? "<unbound>", acting_session: actingSession,
    agent_id: normalizedIdentity(invocation?.agentId), permission_mode_raw: normalizedIdentity(invocation?.permissionModeRaw), ...row,
  }, options);
}
function ownerHookContact(task, replay) {
  const episode = task?.episodes?.at(-1);
  const episodeId = normalizedIdentity(episode?.episode_id);
  const owner = taskOwnerSessionId(task);
  if (!episodeId || !owner || !replay) return null;
  for (let index = replay.records.length - 1; index >= 0; index -= 1) {
    const record = replay.records[index];
    if (
      record.actor.kind === "hook" && record.actor.session_id === owner &&
      Date.parse(record.occurred_at) >= Date.parse(episode.started_at) &&
      record.events.some((event) => event.task_id === task.task_id)
    ) return { episode_id: episodeId, at: record.occurred_at };
  }
  return null;
}
function repoOf(value) { return path.resolve(value?.repo ?? "."); }
function error(message) { process.stderr.write(`workloop: ${message}\n`); return 2; }
function deny(message) { return { event: "pre_tool_use", action: "deny", reason: message }; }
function isSafeHookSessionId(value) { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value); }
function workloopPrefix(command, tool) {
  if (!/^(?:bash|powershell)$/i.test(tool)) return null;
  let invocation = command.trim(); let explicit = null; let explicitActor = null; let hasForeignAssignment = false; let unsafeValue = false;
  if (!/powershell/i.test(tool)) invocation = invocation.replace(/^(?:[^\s]+\/)?env\s+/, "");
  for (;;) {
    const prefix = /powershell/i.test(tool)
      ? invocation.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))(?:\s*;\s*|$)/i)
      : invocation.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))(?:\s+|;\s*|$)/i);
    if (!prefix) break;
    const value = prefix[2] ?? prefix[3] ?? prefix[4];
    const name = prefix[1].toUpperCase();
    if (name === "WORKLOOP_SESSION_ID") explicit = value;
    else if (name === "WORKLOOP_ACTING_SESSION_ID") explicitActor = value;
    else hasForeignAssignment = true;
    invocation = invocation.slice(prefix[0].length);
    if (/[$`;&|\r\n]/.test(value)) unsafeValue = true;
  }
  return { invocation, explicit, explicitActor, hasForeignAssignment, unsafeValue };
}
function workloopExecutable(invocation) {
  return /^(?:(?:[^\s]+\/)?node(?:\.exe)?\s+(?:"[^"\n]*workloop\.mjs"|'[^'\n]*workloop\.mjs'|[^\s]*workloop\.mjs)|(?:[^\s]+\/)?workloop)(?=\s|$)/i.test(invocation);
}
function directWorkloopInvocation(command, tool) {
  const parsed = workloopPrefix(command, tool);
  if (!parsed || parsed.unsafeValue) return null;
  const { invocation, explicit, explicitActor, hasForeignAssignment } = parsed;
  if (/[;&|`\n\r]/.test(invocation) || invocation.includes("$(")) return null;
  return workloopExecutable(invocation) ? { explicit, explicitActor, hasForeignAssignment } : null;
}
function foldShellContinuations(command) {
  // POSIX line splicing: backslash-newline disappears outside single quotes
  // (double-quoted text splices too; single-quoted text keeps it literal).
  // Folding lets a multi-line workloop invocation rewrite for session binding
  // instead of degrading the task owner to "cli" and disarming foreign policy.
  let result = ""; let single = false; let double_ = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "'" && !double_) { single = !single; result += char; continue; }
    if (char === '"' && !single) { double_ = !double_; result += char; continue; }
    if (char === "\\" && !single) {
      const next = command[index + 1];
      if (next === "\n") { index += 1; continue; }
      if (next === "\r" && command[index + 2] === "\n") { index += 2; continue; }
      if (next !== undefined) { result += char + next; index += 1; continue; }
    }
    result += char;
  }
  return result;
}
function workloopCommandCandidates(command, tool, analysis = null) {
  const raw = String(command);
  const views = analysis?.execution?.views ?? commandExecutionViews(raw, { tool });
  const nested = /powershell/i.test(tool) ? [] : views.slice(1);
  return [/powershell/i.test(tool) ? raw : foldShellContinuations(raw), ...nested];
}
function workloopInvocations(command, tool, analysis = null) {
  if (!/^(?:bash|powershell)$/i.test(tool)) return [];
  const seen = new Set(); const invocations = [];
  for (const candidate of workloopCommandCandidates(command, tool, analysis)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const invocation = directWorkloopInvocation(candidate, tool);
    if (invocation) invocations.push(invocation);
  }
  return invocations;
}
function workloopIdentityAssignments(command, tool, analysis = null) {
  // Identity injection only exists in a shell command; non-shell tools (a Codex
  // apply_patch, an Edit) carry no env-assignment prefix. Guard as workloopInvocations
  // does — without it workloopPrefix returns null for every segment and the null?.
  // check reads true (undefined !== null), pushing null and crashing on item.invocation.
  if (!/^(?:bash|powershell)$/i.test(tool)) return [];
  const assignments = [];
  for (const candidate of workloopCommandCandidates(command, tool, analysis)) {
    for (const segment of candidate.split(/[;&|\n\r]+/)) {
      const parsed = workloopPrefix(segment.trim().replace(/^\(\s*/, ""), tool);
      if (parsed && (parsed.explicit !== null || parsed.explicitActor !== null)) assignments.push(parsed);
    }
  }
  return assignments;
}
function workloopInvocation(command, tool, analysis = null) {
  const invocations = workloopInvocations(command, tool, analysis);
  return invocations.length === 1 ? invocations[0] : null;
}
function workloopFrictionCandidate(command, tool, analysis = null) {
  if (!/^(?:bash|powershell)$/i.test(tool)) return false;
  const invocations = workloopInvocations(command, tool, analysis);
  if (invocations.length > 1) return true;
  return workloopCommandCandidates(command, tool, analysis).some((candidate) => (
    candidate.split(/[;&|\n\r]+/).some((segment) => directWorkloopInvocation(segment.trim().replace(/^\(\s*/, ""), tool))
  ));
}
function allowWorkloopCommand(sessionId, mapping, tool, agentId = null, callAnalysis = null) {
  const commands = commandValues(mapping);
  if (commands.length !== 1) return 0;
  const analysis = callAnalysis?.commands.find((item) => item.command === commands[0])?.analysis ?? null;
  const assignments = workloopIdentityAssignments(commands[0], tool, analysis);
  const workloopShaped = workloopFrictionCandidate(commands[0], tool, analysis) || assignments.some((item) => workloopExecutable(item.invocation));
  if (workloopShaped && assignments.some((item) => item.explicitActor !== null)) return deny("WORKLOOP_ACTING_SESSION_ID is host-managed and cannot be supplied by the command");
  if (workloopShaped && assignments.some((item) => item.explicit !== null && item.explicit !== sessionId)) return deny("WORKLOOP_SESSION_ID conflicts with the host hook session id");
  const invocations = workloopInvocations(commands[0], tool, analysis);
  if (!invocations.length) return 0;
  if (!isSafeHookSessionId(sessionId)) return 0;
  if (invocations.some((invocation) => invocation.explicit !== null && invocation.explicit !== sessionId)) return deny("WORKLOOP_SESSION_ID conflicts with the host hook session id");
  if (invocations.some((invocation) => invocation.explicitActor !== null)) return deny("WORKLOOP_ACTING_SESSION_ID is host-managed and cannot be supplied by the command");
  if (invocations.length !== 1) return 0;
  const [invocation] = invocations;
  if (invocation.hasForeignAssignment) return 0;
  const actor = isSafeHookSessionId(agentId) ? agentId : sessionId;
  const assignment = /powershell/i.test(tool)
    ? `${invocation.explicit === null ? `$env:WORKLOOP_SESSION_ID='${sessionId}'; ` : ""}$env:WORKLOOP_ACTING_SESSION_ID='${actor}'; `
    : `export ${invocation.explicit === null ? `WORKLOOP_SESSION_ID='${sessionId}' ` : ""}WORKLOOP_ACTING_SESSION_ID='${actor}'; `;
  return { event: "pre_tool_use", action: "rewrite", updatedInput: { ...mapping, command: assignment + commands[0] } };
}
function holdDisposition(code, message) { return { event: "stop", action: "hold", code, reason: message }; }
function closureReasonCode(closure, verdict) { return closure?.reasons?.[0] ?? closure?.reason ?? `criterion_${verdict}`; }

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

function criterionAuthorship(value) {
  const authoredBy = String(value ?? "self").trim() || "self";
  if (!new Set(["self", "user"]).has(authoredBy)) throw new Error('--criterion-authored-by must be "self" or "user"');
  return authoredBy;
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
  const destructiveScopes = (values["destructive-scope"] ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  if (destructiveScopes.length && values["destructive-allowed"]) throw new Error("provide either --destructive-allowed or --destructive-scope, not both");
  for (const entry of destructiveScopes) {
    if (/[,;]/.test(entry)) throw new Error(`--destructive-scope "${entry}" contains a list delimiter; repeat --destructive-scope per root`);
    if (/^~|[*?[\]{}$`]/.test(entry)) throw new Error(`--destructive-scope "${entry}" must be a literal path root (no globs, variables, or ~)`);
  }
  if (destructiveScopes.length) grants.push(grant("destructive", destructiveScopes, reason, grantedBy, revision));
  if (values["network-allowed"]) grants.push(grant("network", ["commands"], reason, grantedBy, revision));
  if (values["install-scripts-allowed"]) grants.push(grant("install", ["commands"], reason, grantedBy, revision));
  if (values["publish-allowed"]) grants.push(grant("publish", ["commands"], reason, grantedBy, revision));
  return { git, destructive: Boolean(values["destructive-allowed"]), network: Boolean(values["network-allowed"]), grants };
}

function assuranceFrom(values, current = null) {
  const next = current ? cloneJson(current) : constructAssurance();
  if (values.risk !== undefined) next.declared_risk = String(values.risk).replaceAll("-", "_");
  if (values["risk-reason"] !== undefined) next.risk_reason = String(values["risk-reason"]);
  if (values.risk !== undefined || values["risk-reason"] !== undefined) next.risk_declared_by = grantProvenance(values["granted-by"]);
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

// Schema-v3 snapshot recovery. The event stream is always authority;
// this helper may refresh or rebuild only the disposable projection.
function recoverV3TaskSnapshotFromReplay(repo, replay, { eventFsOps = fs, snapshotFsOps = fs, onSnapshotSeam = null, recoveryEpochMs = Date.now(), recoverTail = false } = {}) {
  const inspected = inspectTaskSnapshot(repo, { fsOps: snapshotFsOps, validateProjection: assertV3TaskProjection });
  if (inspected.status === "valid") {
    try { assertV3TaskProjection(inspected.snapshot.projection); }
    catch (cause) {
      throw Object.assign(new Error("task snapshot conflicts with schema-v3 event authority; archive only the incompatible snapshot"), { code: "MIXED_OR_INVALID_AUTHORITY", cause });
    }
    let verified;
    try { verified = verifyEventStoreSourceCursor(repo, inspected.snapshot.source_cursor, { fsOps: eventFsOps }); }
    catch (cause) {
      throw Object.assign(new Error("task snapshot conflicts with schema-v3 event authority; archive only the incompatible snapshot"), { code: "MIXED_OR_INVALID_AUTHORITY", cause });
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
    } catch (cause) {
      warning = `schema-v3 event transaction is committed but snapshot refresh failed: ${cause?.message ?? cause}`;
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
    } catch (cause) {
      warning = `schema-v3 snapshot diagnostic quarantine failed: ${cause?.message ?? cause}`;
    }
  }
  const projection = evolveAll(null, replay.events);
  const snapshot = buildTaskSnapshot({ sourceCursor: replay.source_cursor, projection, validateProjection: assertV3TaskProjection });
  let snapshotSaved = false;
  try {
    saveTaskSnapshot(repo, snapshot, { fsOps: snapshotFsOps, onSeam: onSnapshotSeam, validateProjection: assertV3TaskProjection });
    snapshotSaved = true;
  } catch (cause) {
    const refreshWarning = `schema-v3 event transaction is committed but snapshot refresh failed: ${cause?.message ?? cause}`;
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
  catch (cause) {
    throw Object.assign(new Error("schema-v3 event authority is corrupt; refusing snapshot fallback"), { code: "CORRUPT_EVENT_AUTHORITY", cause });
  }
  return recoverV3TaskSnapshotFromReplay(repo, replay, { eventFsOps, snapshotFsOps, onSnapshotSeam, recoveryEpochMs, recoverTail });
}

function authorityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function loadV3Authority(repo, { allowEmpty = true, recoverTail = false } = {}) {
  const names = eventStoreNameState(repo);
  if (names.current_exists && names.legacy_exists) {
    throw authorityError("ARTIFACT_NAME_CONFLICT", `both ${EVENT_STORE_FILE} and ${LEGACY_EVENT_STORE_FILE} exist; refusing to choose an authority`);
  }
  if (!names.current_exists && names.legacy_exists) {
    throw authorityError("ARTIFACT_NAME_MIGRATION_REQUIRED", `legacy event authority ${LEGACY_EVENT_STORE_FILE} requires migrate-artifact-names --granted-by user`);
  }
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
    // Diagnostics ride as error.field (AGENTS.md Conventions): the message
    // stays free of field paths, and the failing field survives on the thrown
    // error for any caller that wants to surface it.
    const failure = authorityError("CORRUPT_EVENT_AUTHORITY", `schema-v3 event authority is corrupt: ${cause?.message ?? cause}`);
    if (cause?.field) failure.field = cause.field;
    throw failure;
  }
  const recovered = recoverV3TaskSnapshotFromReplay(repo, replay, { recoverTail });
  if (recovered.warning) process.stderr.write(`warning: ${recovered.warning}\n`);
  return { status: "event_authority", projection: recovered.projection, replay };
}

function commitTaskCommand(repo, command, { actorKind = "cli", commandId = null, openNewTask = false, onEventSeam = null, onSnapshotSeam = null, authority = null } = {}) {
  // Every production caller holds the repo task lock. Recovery is destructive
  // only to an uncommitted tail, so it is enabled exclusively on this path.
  // A caller may reuse authority only while continuously holding that lock and
  // only if no external command or callback has run since it was loaded.
  const currentAuthority = authority ?? loadV3Authority(repo, { recoverTail: true });
  const current = openNewTask ? null : currentAuthority.projection;
  if (
    RUNTIME_CONTRACT >= 6 && !openNewTask && current?.runtime_contract !== RUNTIME_CONTRACT &&
    current?.lifecycle?.state !== "terminal" && command.type !== "abandon"
  ) {
    throw authorityError(
      "ACTIVE_OLDER_CONTRACT_READ_ONLY",
      `active Contract ${current?.runtime_contract ?? 5} task is read-only under runtime ${RUNTIME_CONTRACT}; use the pinned compatible runtime to finish it, or explicitly abandon it`,
    );
  }
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
  const persistedEvents = record.events.map((event) => ({ ...event, at: record.occurred_at, atEpochMs: record.occurred_at_epoch_ms }));
  // The event ledger is authority and cannot be rolled back. Validate the
  // exact persisted event shapes, timestamps, and sequences before appending
  // any bytes so a reducer rejection can never wedge replay after commit.
  const projection = evolveAll(current, persistedEvents);
  assertV3TaskProjection(projection);
  const committed = commitRecord(repo, record, { cursor: replay?.cursor ?? null, onSeam: onEventSeam });
  const sourceCursor = makeSourceCursor(record, committed.cursor.valid_end_offset);
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

function hookTaskStateUnavailable(cause) {
  return Object.assign(new Error(cause?.message ?? String(cause), { cause }), {
    code: cause?.code,
    hook_task_state_unavailable: true,
  });
}

function observationAuthorityToken(authority, task, intent) {
  const replay = authority?.replay;
  const episode = task?.episodes?.at(-1) ?? null;
  return {
    intent,
    authority_status: authority?.status ?? null,
    repo_sequence: replay?.last_repo_sequence ?? 0,
    record_digest: replay?.last_record_digest ?? null,
    valid_end_offset: replay?.valid_end_offset ?? 0,
    task_id: task?.task_id ?? null,
    task_revision: task?.task_revision ?? null,
    artifact_revision: task?.artifact_revision ?? null,
    criterion_generation_id: task?.criterion?.criterion_generation_id ?? null,
    criterion_definition_hash: task?.criterion?.criterion_definition_hash ?? null,
    owner_episode_id: episode?.episode_id ?? null,
    owner_session_id: episode?.host_session_id ?? null,
  };
}

function sameObservationAuthority(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function activeCriterionLease(repo, atEpochMs = Date.now()) {
  const lease = readCriterionLease(repo);
  return Number.isSafeInteger(lease?.deadline_epoch_ms) && lease.deadline_epoch_ms >= atEpochMs ? lease : null;
}

function taskObservationCandidate(repo, {
  intent,
  stop = false,
  sessionId = null,
  transcriptPath = null,
  inlineCriterionBudgetSeconds = null,
  requireActive = true,
} = {}, readiness = null) {
  const authority = loadV3Authority(repo, { recoverTail: true });
  if (readiness) readiness.taskStateReady = true;
  const task = authority.projection;
  if (!task) return { status: "no_task" };
  if (requireActive && task.lifecycle.state === "suspended") return { status: "task_suspended" };
  if (requireActive && task.lifecycle.state === "terminal") return { status: "terminal" };
  if (stop && isForeignSession(task, sessionId)) return { status: "foreign_session" };
  if (stop && task.criterion.timeout_seconds > inlineCriterionBudgetSeconds) {
    const explicitCommand = task.policy.close_policy === "explicit" ? "workloop achieve" : "workloop verify --record";
    return {
      status: "hold",
      code: "criterion_requires_explicit_verification",
      message: `criterion_requires_explicit_verification: criterion timeout ${task.criterion.timeout_seconds}s exceeds the ${inlineCriterionBudgetSeconds}s inline Stop budget; run ${explicitCommand}`,
    };
  }
  const lease = activeCriterionLease(repo);
  if (lease) {
    const message = criterionInProgressMessage(lease);
    return stop ? { status: "hold", code: "criterion_in_progress", message } : { status: "criterion_in_progress", lease };
  }
  return {
    status: "ready",
    intent,
    authority,
    task: cloneJson(task),
    token: observationAuthorityToken(authority, task, intent),
    transcript_range: stop ? transcriptRange(task, transcriptPath) : null,
  };
}

function bindTaskObservationSnapshot(repo, candidate, options, readiness, repositorySnapshot, deadlineEpochMs) {
  const current = taskObservationCandidate(repo, options, readiness);
  if (current.status !== "ready") return current;
  if (!sameObservationAuthority(candidate.token, current.token)) return { status: "retry" };
  if (artifactEvidenceTask(current.task)) {
    const checkpoint = artifactCheckpointFromSnapshot(repositorySnapshot);
    if (checkpoint.checkpoint_id !== current.task.artifact_checkpoint.checkpoint_id) {
      const validation = validateRepoSnapshot(repo, repositorySnapshot, { deadlineEpochMs: Math.min(deadlineEpochMs, Date.now() + OBSERVATION_COMMIT_VALIDATION_MS) });
      if (!validation.matches) return { status: "retry" };
      const delta = artifactCheckpointDelta(current.task.artifact_checkpoint, checkpoint);
      const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
      const mutationHistory = current.task.evidence.mutation_history_coverage === "full" ? "partial" : current.task.evidence.mutation_history_coverage;
      const prewriteEnforcement = taskPreExecutionCoverage(current.task) === "full" ? "partial" : taskPreExecutionCoverage(current.task);
      commitTaskCommand(repo, {
        type: "reconcile-artifacts", taskId: current.task.task_id, at, atEpochMs, actingSession: actingSessionId(),
        checkpointId: checkpoint.checkpoint_id,
        capturedAtMs: checkpoint.captured_at_ms,
        fromCheckpoint: current.task.artifact_checkpoint.checkpoint_id,
        toCheckpoint: checkpoint.checkpoint_id,
        changedEntries: delta.changed_entries,
        changedPaths: delta.changed_paths,
        currentScopeViolations: currentScopeViolations(current.task, checkpoint),
        coverage: "full",
        reason: "pre-criterion repository reconciliation",
        coverageChange: {
          artifactState: "full", mutationHistory, prewriteEnforcement,
          episodeId: current.task.episodes.at(-1).episode_id,
          hostProfile: "repository", surface: "unhooked-reconcile", exhaustiveSurface: false,
          effectiveFromCheckpoint: current.task.artifact_checkpoint.checkpoint_id,
          intervalFromCheckpoint: current.task.artifact_checkpoint.checkpoint_id,
          intervalToCheckpoint: checkpoint.checkpoint_id,
          reason: "artifact delta was not owned by an operation lease",
        },
      }, { actorKind: "cli", authority: current.authority });
      return { status: "reconciled" };
    }
  }
  return { ...current, repository_snapshot: repositorySnapshot, deadline_epoch_ms: deadlineEpochMs };
}

function prepareTaskObservation(repo, options = {}, readiness = null) {
  const { intent, deadlineEpochMs = null } = options;
  if (typeof intent !== "string" || intent.length === 0) throw new Error("observation intent is required");
  let observationDeadlineEpochMs = deadlineEpochMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = withTaskLock(repo, () => taskObservationCandidate(repo, options, readiness));
    if (candidate.status !== "ready") return candidate;
    // Explicit CLI observations are allowed to use the task's full timeout,
    // but repository preparation is still part of that same bounded
    // operation. Stop supplies its shorter runtime-owned deadline here.
    observationDeadlineEpochMs ??= Date.now()
      + candidate.task.criterion.timeout_seconds * 1000
      + CRITERION_OPERATION_CLEANUP_MS;
    // The full prepared fingerprint is captured outside the task lock, then
    // bound by a second short authority check. A direct write after this point
    // differs from the runner's first snapshot; a supervised write forces a
    // retry because its authority token changed.
    const repositorySnapshot = repoSnapshot(repo, null, { deadlineEpochMs: observationDeadlineEpochMs });
    const bound = withTaskLock(repo, () => bindTaskObservationSnapshot(
      repo,
      candidate,
      options,
      readiness,
      repositorySnapshot,
      observationDeadlineEpochMs,
    ));
    if (!new Set(["retry", "reconciled"]).has(bound.status)) return bound;
  }
  return {
    status: "hold",
    code: "criterion_observation_stale",
    message: "criterion_observation_stale: task authority did not stabilize while preparing the repository fingerprint",
  };
}

function executePreparedObservation(repo, prepared, { intent, runtimeDeadlineSeconds = null, runtimeDeadlineEpochMs = null } = {}) {
  if (prepared.intent !== intent || prepared.token?.intent !== intent) throw new Error(`observation intent mismatch: prepared ${prepared.intent ?? "missing"}, executed ${intent ?? "missing"}`);
  const startedAtEpochMs = Date.now();
  const deadlineSeconds = runtimeDeadlineSeconds ?? prepared.task.criterion.timeout_seconds;
  const deadlineEpochMs = runtimeDeadlineEpochMs
    ?? prepared.deadline_epoch_ms
    ?? startedAtEpochMs + deadlineSeconds * 1000 + CRITERION_OPERATION_CLEANUP_MS;
  const lease = withCriterionLease(repo, {
    intent,
    task_id: prepared.task.task_id,
    criterion_generation_id: prepared.task.criterion.criterion_generation_id,
    started_at_epoch_ms: startedAtEpochMs,
    deadline_epoch_ms: deadlineEpochMs,
  }, () => {
    let snapshots = null;
    const observation = runCriterionSource(
      prepared.task.criterion.source,
      repo,
      prepared.task.criterion.timeout_seconds,
      prepared.task.criterion.protocol,
      { deadlineEpochMs, onSnapshots: (value) => { snapshots = value; } },
    );
    observation.criterion_generation_id = prepared.task.criterion.criterion_generation_id;
    observation.observed_artifact_revision = prepared.task.artifact_revision;
    return { observation, snapshots };
  });
  if (lease.status === "busy") return { status: "busy", lease: lease.lease };
  return { status: "executed", deadline_epoch_ms: deadlineEpochMs, ...lease.value };
}

function markRepositoryRace(prepared, executed, currentSnapshot) {
  const preparedSnapshot = prepared.repository_snapshot;
  const before = executed.snapshots?.before;
  const after = executed.snapshots?.after;
  if (preparedSnapshot?.hash === null || preparedSnapshot?.hash === undefined || before?.hash === null || before?.hash === undefined || after?.hash === null || after?.hash === undefined || currentSnapshot?.hash === null || currentSnapshot?.hash === undefined) {
    return { stable: false, attributable: false };
  }
  if (preparedSnapshot.hash === before.hash && before.hash === after.hash && after.hash === currentSnapshot.hash) return { stable: true, attributable: false };
  const changedPaths = new Set([
    ...changedSnapshotPaths(preparedSnapshot, before),
    ...changedSnapshotPaths(before, after),
    ...changedSnapshotPaths(after, currentSnapshot),
    ...changedSnapshotPaths(before, currentSnapshot),
  ]);
  if (changedPaths.size === 0) return { stable: false, attributable: false };
  markObservationSideEffect(executed, changedPaths);
  return { stable: false, attributable: true };
}

function markObservationSideEffect(executed, changedPaths) {
  executed.observation.verdict = "indeterminate";
  executed.observation.execution.execution_error = "criterion_side_effect";
  executed.observation.changed_paths = [...new Set(changedPaths)].sort();
}

function commitPreparedObservation(repo, prepared, executed, action, { recordSideEffect = true } = {}) {
  // Full content hashing is deliberately outside the authority lock. The
  // resulting snapshot is the repository-content linearization point; the
  // short locked section below only checks task authority and commits events.
  const currentSnapshot = repoSnapshot(repo, executed.snapshots?.after ?? null, { deadlineEpochMs: executed.deadline_epoch_ms });
  const repository = markRepositoryRace(prepared, executed, currentSnapshot);
  return withTaskLock(repo, () => {
    const authority = loadV3Authority(repo, { recoverTail: true });
    const current = authority.projection;
    const validationDeadline = Math.min(executed.deadline_epoch_ms, Date.now() + OBSERVATION_COMMIT_VALIDATION_MS);
    const validation = validateRepoSnapshot(repo, currentSnapshot, { deadlineEpochMs: validationDeadline });
    const evidenceSnapshot = validation.matches ? currentSnapshot : null;
    const authorityMatches = sameObservationAuthority(prepared.token, observationAuthorityToken(authority, current, prepared.intent));
    const sideEffect = executed.observation.execution.execution_error === "criterion_side_effect" || repository.attributable;
    if (!authorityMatches) {
      // A concurrent task mutation makes the criterion verdict stale, but it
      // must not erase a repository mutation discovered by the runner. Retain
      // that evidence only on the same nonterminal task; a replacement or
      // closed task is a different authority domain.
      const sameMutableTask = current?.task_id === prepared.task.task_id
        && new Set(["active", "suspended"]).has(current.lifecycle?.state);
      return {
        status: "stale",
        evidence: sideEffect && recordSideEffect && sameMutableTask
          ? action({ authority, task: current, authorityChanged: true, repositorySnapshot: evidenceSnapshot })
          : null,
      };
    }
    if (sideEffect) {
      // The execution result cannot safely attribute a concurrent direct write
      // to the child, so it is never accepted as a closure observation. Keep
      // the existing side-effect evidence event solely to advance artifact
      // revision and expire reviews, then report the observation itself stale.
      return { status: "stale", evidence: recordSideEffect ? action({ authority, task: current, authorityChanged: false, repositorySnapshot: evidenceSnapshot }) : null };
    }
    if (!repository.stable) return { status: "stale" };
    if (validation.changed_paths.length) {
      markObservationSideEffect(executed, validation.changed_paths);
      return { status: "stale", evidence: recordSideEffect ? action({ authority, task: current, authorityChanged: false, repositorySnapshot: null }) : null };
    }
    if (!validation.matches) return { status: "stale" };
    return { status: "committed", value: action({ authority, task: current, repositorySnapshot: currentSnapshot }) };
  });
}

function criterionInProgressMessage(lease) {
  const deadline = Number.isSafeInteger(lease?.deadline_epoch_ms) ? ` until ${utcTimestamp(lease.deadline_epoch_ms)}` : "";
  return `criterion_in_progress: another ${lease?.intent ?? "criterion"} observation owns the criterion lease${deadline}`;
}

function staleObservationMessage(executed = null, { sideEffectRecorded = false } = {}) {
  const changedPaths = executed?.observation?.changed_paths ?? [];
  const evidenceSuffix = sideEffectRecorded ? "; side-effect evidence recorded" : "";
  const changedSuffix = changedPaths.length ? `; changed paths: ${changedPaths.join(", ")}` : "";
  return `criterion_observation_stale: task authority or repository content changed while the criterion was running; observation discarded${evidenceSuffix}${changedSuffix}`;
}

function commitCriterionSideEffect(repo, {
  authority, task, observation, repositorySnapshot = null, transcriptRange = null,
  actingSession = null, actorKind = "cli", at, atEpochMs,
}) {
  const trusted = artifactEvidenceTask(task) && repositorySnapshot !== null;
  const checkpoint = trusted ? artifactCheckpointFromSnapshot(repositorySnapshot) : task.artifact_checkpoint;
  const delta = artifactEvidenceTask(task) && trusted
    ? artifactCheckpointDelta(task.artifact_checkpoint, checkpoint)
    : { changed_entries: [], changed_paths: [] };
  const mutationHistory = !trusted ? "unknown"
    : task.evidence.mutation_history_coverage === "full" ? "partial" : task.evidence.mutation_history_coverage;
  const prewriteEnforcement = !trusted ? "unknown"
    : taskPreExecutionCoverage(task) === "full" ? "partial" : taskPreExecutionCoverage(task);
  return commitTaskCommand(repo, {
    type: "criterion-side-effect", taskId: task.task_id, observation, transcriptRange, actingSession, at, atEpochMs,
    ...(artifactEvidenceTask(task) ? { reconciliation: {
      checkpointId: checkpoint.checkpoint_id, capturedAtMs: checkpoint.captured_at_ms,
      fromCheckpoint: task.artifact_checkpoint.checkpoint_id, toCheckpoint: checkpoint.checkpoint_id,
      changedEntries: delta.changed_entries, changedPaths: delta.changed_paths,
      currentScopeViolations: trusted ? currentScopeViolations(task, checkpoint) : task.evidence.current_scope_violations,
      coverage: trusted ? "full" : "unknown",
      reason: trusted ? "criterion side effect artifact reconciliation" : "criterion side effect artifact reconciliation unavailable",
      coverageChange: {
        artifactState: trusted ? "full" : "unknown", mutationHistory, prewriteEnforcement,
        episodeId: task.episodes.at(-1).episode_id, operationId: null, capabilityId: null,
        hostProfile: "repository", surface: "criterion-side-effect", exhaustiveSurface: false,
        effectiveFromCheckpoint: task.artifact_checkpoint.checkpoint_id,
        intervalFromCheckpoint: task.artifact_checkpoint.checkpoint_id, intervalToCheckpoint: checkpoint.checkpoint_id,
        reason: trusted ? "criterion mutated repository outside a write operation lease" : "criterion mutation snapshot was not stable",
      },
    } } : {}),
  }, { actorKind, authority });
}

function cmdOpen(values) {
  const repo = repoOf(values);
  const goal = String(values.goal ?? "").trim();
  const because = String(values["alignment-because"] ?? "").trim();
  const files = values.files ?? [];
  if (!goal || !because || !files.length) return error("open requires --goal, --alignment-because, and at least one --files");
  let historyRequirement;
  try { historyRequirement = historyRequirementFrom(values); }
  catch (cause) { return error(cause.message); }
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
  const authorityGrant = authorityFrom(values, 1, goal);
  for (const subject of subjects) authorityGrant.grants.push(grant("criterion_subject", [subject], values.reason ?? "criterion subject declared at open", grantProvenance(values["granted-by"]), 1));
  if (files.some((pattern) => /^\*\*(?:\/\*)?$/.test(pattern))) authorityGrant.grants.push(grant("whole_repo", files.filter((pattern) => /^\*\*(?:\/\*)?$/.test(pattern)), values.reason ?? "whole-repository envelope declared at open", grantProvenance(values["granted-by"]), 1));
  const criterion = criterionMetadata({ source, protocol, timeoutSeconds: timeout, subjects, authoredBy: criterionAuthorship(values["criterion-authored-by"]), repo });
  criterion.criterion_definition_hash = criterionDefinitionHash(criterion);
  const taskId = randomUUID();
  const intent = "open";
  const prepareCandidate = () => withTaskLock(repo, () => {
    const authority = loadV3Authority(repo, { recoverTail: true });
    const existing = authority.projection;
    if (existing && existing.lifecycle.state !== "terminal") return { status: "conflict" };
    const lease = activeCriterionLease(repo);
    if (lease) return { status: "criterion_in_progress", lease };
    return {
      status: "ready",
      intent,
      task: { task_id: taskId, artifact_revision: 0, criterion },
      token: observationAuthorityToken(authority, existing, intent),
    };
  });
  const candidate = prepareCandidate();
  if (candidate.status === "conflict") return error("an active or suspended task already exists");
  if (candidate.status === "criterion_in_progress") return error(criterionInProgressMessage(candidate.lease));
  const openDeadlineEpochMs = Date.now() + timeout * 1000 + CRITERION_OPERATION_CLEANUP_MS;
  const repositorySnapshot = repoSnapshot(repo, null, { deadlineEpochMs: openDeadlineEpochMs });
  const rebound = prepareCandidate();
  const prepared = rebound.status === "ready" && sameObservationAuthority(candidate.token, rebound.token)
    ? { ...rebound, repository_snapshot: repositorySnapshot, deadline_epoch_ms: openDeadlineEpochMs }
    : rebound.status === "ready" ? { status: "stale" } : rebound;
  if (prepared.status === "conflict") return error("an active or suspended task already exists");
  if (prepared.status === "criterion_in_progress") return error(criterionInProgressMessage(prepared.lease));
  if (prepared.status !== "ready") return error("repository or task authority changed while preparing the birth observation; retry open");
  const executed = executePreparedObservation(repo, prepared, { intent, runtimeDeadlineEpochMs: openDeadlineEpochMs });
  if (executed.status === "busy") return error(criterionInProgressMessage(executed.lease));
  const observation = executed.observation;
  if (observation.changed_paths.length) return error(`criterion has side effects: ${observation.changed_paths.join(", ")}`);
  const committed = commitPreparedObservation(repo, prepared, executed, ({ authority, repositorySnapshot: stableSnapshot }) => {
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    observation.observed_at = at;
    const artifactBaseline = RUNTIME_CONTRACT >= 6 ? artifactCheckpointFromSnapshot(stableSnapshot) : undefined;
    return commitTaskCommand(repo, {
      type: "open", runtimeContract: RUNTIME_CONTRACT, taskId, at, atEpochMs, actingSession: actingSessionId(),
      goal, criterion, observation, policyName: internalPolicy, policyRationale: values.reason ?? null,
      alignment: { because, not_covered: values["not-covered"] ?? [] },
      envelope: { files, git: authorityGrant.git, destructive: authorityGrant.destructive, network: authorityGrant.network },
      grants: authorityGrant.grants,
      assurance: assuranceFrom(values),
      budget: { rounds: parseInteger(values.rounds, "rounds", { minimum: 1 }) ?? 8, writes: parseInteger(values.writes, "writes"), wall_clock_minutes: parseInteger(values["wall-clock-minutes"], "wall-clock-minutes"), output_tokens: parseInteger(values["token-budget"], "token-budget") },
      episodes: [{ episode_id: randomUUID(), host_session_id: hostSessionId(), started_at: at, ended_at: null, start_task_revision: 1, end_task_revision: null, output_tokens_estimate: 0 }],
      artifactBaseline,
      coverageBasis: RUNTIME_CONTRACT >= 6 ? {
        history_requirement: historyRequirement,
        artifact_state: "full",
        mutation_history: "unknown",
        prewrite_enforcement: "unknown",
      } : undefined,
    }, { openNewTask: true, authority });
  }, { recordSideEffect: false });
  if (committed.status === "stale") return error(staleObservationMessage(executed));
  clearUntracked(repo);
  const executionDiagnostic = observation.execution.execution_error ? `; execution ${observation.execution.execution_error}` : "";
  process.stdout.write(`workloop: opened ${taskPath(repo)}; criterion ${observation.verdict}${executionDiagnostic}; policy ${cliPolicy}\n`);
  return 0;
}

function formatClosure(closure) {
  if (!closure) return "null";
  if (closure.state === "held") return `held(${closure.reasons.join(",")})`;
  if (closure.state === "not_ready") return `not_ready(${closure.reason})`;
  return closure.state;
}

function writeEvidenceProjection(task) {
  if (!artifactEvidenceTask(task)) return null;
  const contract7 = task.runtime_contract === 7;
  const operationEvidenceCount = contract7 ? task.authority.operation_intents_observed : task.authority.write_operations_authorized;
  const policyDeviationsObserved = contract7
    ? Object.values(task.operations).filter((operation) => operation.intent?.policy_disposition === "deviation").length
    : undefined;
  return {
    history_requirement: task.history_requirement,
    write_count_basis: task.spent.write_count_basis,
    ...(contract7 ? {
      execution_authority: "host",
      operation_intents_observed: operationEvidenceCount,
      policy_deviations_observed: policyDeviationsObserved,
      pre_execution_observation: task.authority.pre_execution_observation,
    } : {
      write_operations_authorized: operationEvidenceCount,
      prewrite_enforcement: task.authority.prewrite_enforcement,
    }),
    tool_completions_observed: task.evidence.tool_completions_observed,
    artifact_revision: task.artifact_revision,
    evidence_revision: task.evidence.evidence_revision,
    artifact_state_coverage: task.evidence.artifact_state_coverage,
    mutation_history_coverage: task.evidence.mutation_history_coverage,
    baseline_checkpoint: task.artifact_baseline.checkpoint_id,
    current_checkpoint: task.artifact_checkpoint.checkpoint_id,
    current_scope_violations: task.evidence.current_scope_violations,
    open_operation_leases: task.capability_leases.filter((lease) => lease.status === "open").map((lease) => lease.operation_id),
    authority: task.authority,
    evidence: task.evidence,
    artifact_checkpoint: task.artifact_checkpoint,
    capability_leases: task.capability_leases,
    coverage_intervals: task.coverage_intervals,
  };
}

function writeBudgetCompliance(task) {
  if (!artifactEvidenceTask(task)) return null;
  if (task.budget.writes === null) return "not_applicable";
  const count = task.runtime_contract === 7 ? task.authority.operation_intents_observed : task.authority.write_operations_authorized;
  if (count > task.budget.writes) return "exceeded";
  return taskPreExecutionCoverage(task) === "full" && task.evidence.mutation_history_coverage === "full"
    ? "compliant"
    : "unknown";
}

function budgetProjection(task) {
  return artifactEvidenceTask(task)
    ? { ...task.budget, write_compliance: writeBudgetCompliance(task) }
    : task.budget;
}

function cmdStatus(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const authority = loadV3Authority(repo, { recoverTail: true });
    const task = authority.projection;
    if (!task) return error("no task");
    const drift = criterionDrift(task.criterion, repo).length > 0;
    const closure = closureProjection(task, { drift });
    const owner = taskOwnerSessionId(task);
    const cliIdentity = hostSessionId();
    const contact = ownerHookContact(task, authority.replay);
    const bindingNextAction = task.lifecycle.state === "terminal" ? null
      : task.lifecycle.state === "suspended" ? "resume --reason R in the continuing host session"
        : owner && cliIdentity !== owner ? "workloop join --reason R to continue this task; use a separate worktree for parallel work"
          : null;
    const sessionBinding = {
      bound: Boolean(owner),
      cli_identity_matches_owner: owner && cliIdentity !== "cli" ? cliIdentity === owner : null,
      last_observed_owner_hook_contact: contact,
      next_action: bindingNextAction,
    };
    process.stdout.write(JSON.stringify({
      ...contractDescriptor(),
      task_schema_version: task.schema_version,
      task_id: task.task_id,
      lifecycle: task.lifecycle,
      goal: task.goal,
      policy: task.policy,
      criterion: task.criterion,
      proof_assurance: projectProofAssurance(task, { drift }),
      review_requirement: projectReviewRequirement(task),
      machine_risk_floor: machineRiskFloor(task),
      next_actions: assuranceNextActions(task, { drift }),
      closure,
      alignment: task.alignment,
      assurance: task.assurance,
      budget: budgetProjection(task),
      spent: task.spent,
      artifact_revision: task.artifact_revision,
      ...(artifactEvidenceTask(task) ? { write_evidence: writeEvidenceProjection(task) } : {}),
      last_substantive_task_revision: task.last_substantive_task_revision,
      session_binding: sessionBinding,
    }, null, 2) + "\n");
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
  const deviations = task.evidence.touched_files.filter((file) => !isSyntheticTouchedFile(file) && !insideEnvelope(file, task.envelope.files));
  const payload = {
    ...contractDescriptor(),
    generated_at: localTimestamp(atEpochMs),
    generated_by: "workloop report — machine transcription of task state, not testimony",
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
    budget: budgetProjection(task),
    spent: task.spent,
    ...(artifactEvidenceTask(task) ? { write_evidence: writeEvidenceProjection(task) } : {}),
  };
  if (values.json) { process.stdout.write(JSON.stringify(payload, null, 2) + "\n"); return 0; }
  const lifecycleLabel = task.lifecycle.state + (task.lifecycle.outcome ? `(${task.lifecycle.outcome})` : task.lifecycle.reason ? `(${task.lifecycle.reason})` : "");
  const lines = [`# workloop report — ${task.task_id}`, "", `_${payload.generated_by}; generated at ${payload.generated_at}_`, "", "## Outcome", "", `- lifecycle: ${lifecycleLabel}`];
  if (closure) lines.push(`- closure: ${closure.state}${closure.reason ? ` (${closure.reason})` : ""}${closure.reasons?.length ? ` (${closure.reasons.join(", ")})` : ""}`);
  lines.push("", "## Goal", "", task.goal, "", "## Criterion", "", `- source: \`${task.criterion.source.value}\``, `- policy: ${payload.criterion.policy}`, `- generation: ${task.criterion.criterion_generation_id}`, `- proof assurance: ${payload.proof_assurance.state}`);
  lines.push("", "## Alignment", "", `- because: ${task.alignment.because}`);
  for (const item of task.alignment.not_covered) lines.push(`- not covered: ${item}`);
  lines.push("", "## Reviews", "");
  if (!task.reviews.length) lines.push("- none recorded");
  for (const review of task.reviews) lines.push(`- ${review.level}${review.reviewer ? ` by ${review.reviewer}` : ""}: blocking ${review.blocking_findings_count ?? "?"}, advisory ${review.advisory_findings_count ?? "?"}`);
  lines.push("", "## Envelope and touched files", "", `- declared: ${task.envelope.files.join(", ")}`, `- touched: ${task.evidence.touched_files.length ? task.evidence.touched_files.join(", ") : "none recorded"}`, `- deviations: ${deviations.length ? deviations.join(", ") : "none"}`);
  if (artifactEvidenceTask(task)) {
    const operationLine = task.runtime_contract === 7
      ? `- observed operation intents: ${task.authority.operation_intents_observed} (${task.spent.write_count_basis}; execution authority: host)`
      : `- authorized operations: ${task.authority.write_operations_authorized} (${task.spent.write_count_basis})`;
    const preExecutionLine = task.runtime_contract === 7
      ? `- pre-execution observation: ${task.authority.pre_execution_observation}`
      : `- prewrite enforcement: ${task.authority.prewrite_enforcement}`;
    lines.push("", "## Write evidence", "", operationLine, `- completion receipts: ${task.evidence.tool_completions_observed}`, `- artifact revisions: ${task.artifact_revision}`, `- artifact state coverage: ${task.evidence.artifact_state_coverage}`, `- mutation history coverage: ${task.evidence.mutation_history_coverage}`, preExecutionLine, `- history requirement: ${task.history_requirement}`);
  }
  lines.push("", "## Assurance", "", `- declared risk: ${task.assurance.declared_risk} (${task.assurance.risk_reason})`, `- machine risk floor: ${JSON.stringify(payload.machine_risk_floor)}`);
  for (const acceptance of task.assurance.proof_gap_acceptances ?? []) lines.push(`- accepted proof gap (${acceptance.granted_by}): ${acceptance.reason}`);
  lines.push("", "## Budget", "", artifactEvidenceTask(task)
    ? `- rounds ${task.spent.rounds}/${task.budget.rounds}; ${task.runtime_contract === 7 ? "intent" : "authorization"} budget ${task.runtime_contract === 7 ? task.authority.operation_intents_observed : task.authority.write_operations_authorized}/${reportBudgetLimit(task.budget.writes)} (${writeBudgetCompliance(task)}); wall clock ${Math.round(projectedWallClockMs / 1000)}s/${reportBudgetLimit(task.budget.wall_clock_minutes, "m")}; output tokens estimate ${task.spent.output_tokens_estimate}/${reportBudgetLimit(task.budget.output_tokens)} (best effort)`
    : `- rounds ${task.spent.rounds}/${task.budget.rounds}; writes ${task.spent.writes}/${reportBudgetLimit(task.budget.writes)}; wall clock ${Math.round(projectedWallClockMs / 1000)}s/${reportBudgetLimit(task.budget.wall_clock_minutes, "m")}; output tokens estimate ${task.spent.output_tokens_estimate}/${reportBudgetLimit(task.budget.output_tokens)} (best effort)`);
  if (task.lifecycle.state === "suspended") lines.push("", "## Judgment", "", `- remaining: ${task.lifecycle.judgment.remaining}`, `- failure: ${task.lifecycle.judgment.failure}`, `- next action: ${task.lifecycle.judgment.next_action}`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
  });
}

// verify --record persists the observation the read-only path only reports:
// a first-class criterion_observed event with cli_verify provenance, so a
// continuous session that never stops mid-work still feeds rounds, the
// attempt streak, and stuck detection. It shares the same prepare/execute/
// compare-and-commit transaction as Stop; the episode stays open because the
// session continues.
function cmdVerifyRecord(repo) {
  const prepared = prepareTaskObservation(repo, { intent: "verify_record" });
  if (prepared.status === "no_task") return error("no task");
  if (prepared.status === "criterion_in_progress") return error(criterionInProgressMessage(prepared.lease));
  if (prepared.status !== "ready") return error(prepared.message ?? "verify --record requires an active task; resume first");
  const executed = executePreparedObservation(repo, prepared, { intent: "verify_record" });
  if (executed.status === "busy") return error(criterionInProgressMessage(executed.lease));
  const observation = executed.observation;
  const committed = commitPreparedObservation(repo, prepared, executed, ({ authority, task, repositorySnapshot }) => {
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    observation.observed_at = at;
    if (observation.execution.execution_error === "criterion_side_effect") {
      return { kind: "side_effect", committed: commitCriterionSideEffect(repo, { authority, task, observation, repositorySnapshot, actingSession: actingSessionId(), at, atEpochMs }) };
    }
    const drift = criterionDrift(task.criterion, repo);
    const feedback = criterionMessage(observation.execution.output_tail) ?? outputHead(observation.execution.output_tail, 160);
    return {
      kind: "observed",
      committed: commitTaskCommand(repo, {
        type: "observe", taskId: task.task_id, source: "cli_verify",
        actingSession: actingSessionId(), observation, drift, transcriptRange: null,
        attemptId: observation.verdict === "unsatisfied" ? randomUUID() : null,
        signature: observation.verdict === "unsatisfied" && criterionMessage(observation.execution.output_tail) ? fnv1aHex(criterionMessage(observation.execution.output_tail)) : null,
        failureSummary: feedback, autoSuspend: true,
        remaining: `criterion must become satisfied${feedback ? `: ${feedback}` : ""}`,
        closeEpisode: false, at, atEpochMs,
      }, { authority }),
    };
  });
  if (committed.status === "stale") {
    process.stdout.write(JSON.stringify({ ...contractDescriptor(), observation, recorded: false, side_effect_recorded: Boolean(committed.evidence?.committed?.committed), status: "criterion_observation_stale" }) + "\n");
    return 2;
  }
  const outcome = committed.value;
  if (outcome.kind === "side_effect") {
    process.stdout.write(JSON.stringify({ ...contractDescriptor(), observation, recorded: outcome.committed.committed, status: outcome.committed.result.status }) + "\n");
    return 2;
  }
  const result = outcome.committed.result;
  process.stdout.write(JSON.stringify({
    ...contractDescriptor(), observation, recorded: true, status: result.status,
    ...(result.status === "suspended" ? { reason: result.reason } : {}),
    ...(result.status === "terminal" ? { outcome: result.outcome } : {}),
  }) + "\n");
  return observation.verdict === "satisfied" ? 0 : observation.verdict === "unsatisfied" ? 1 : 2;
}

function cmdVerify(values) {
  const repo = repoOf(values);
  if (values.record) return cmdVerifyRecord(repo);
  const prepared = prepareTaskObservation(repo, { intent: "verify", requireActive: false });
  if (prepared.status === "no_task") return error("no task");
  if (prepared.status === "criterion_in_progress") return error(criterionInProgressMessage(prepared.lease));
  if (prepared.status !== "ready") return error(prepared.message ?? "criterion observation could not be prepared");
  const executed = executePreparedObservation(repo, prepared, { intent: "verify" });
  if (executed.status === "busy") return error(criterionInProgressMessage(executed.lease));
  const beforeArtifact = prepared.task.artifact_revision;
  const observation = executed.observation;
  let persisted = false;
  let afterArtifact = beforeArtifact;
  const finalized = commitPreparedObservation(repo, prepared, executed, ({ authority, task, repositorySnapshot }) => {
    if (observation.execution.execution_error !== "criterion_side_effect" || task.lifecycle.state === "terminal") return null;
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    observation.observed_at = at;
    return commitCriterionSideEffect(repo, { authority, task, observation, repositorySnapshot, actingSession: hostSessionId(), at, atEpochMs });
  });
  if (finalized.status === "stale") {
    const sideEffectCommit = finalized.evidence?.projection ? finalized.evidence : finalized.evidence?.committed ?? null;
    persisted = Boolean(sideEffectCommit?.committed);
    afterArtifact = sideEffectCommit?.projection?.artifact_revision ?? afterArtifact;
    process.stdout.write(JSON.stringify({ ...contractDescriptor(), observation, persisted, stale: true, artifact_revision_before: beforeArtifact, artifact_revision_after: afterArtifact }) + "\n");
    return 2;
  }
  const committed = finalized.value;
  persisted = Boolean(committed?.committed);
  afterArtifact = committed?.projection?.artifact_revision ?? beforeArtifact;
  process.stdout.write(JSON.stringify({ ...contractDescriptor(), observation, persisted, artifact_revision_before: beforeArtifact, artifact_revision_after: afterArtifact }) + "\n");
  return observation.verdict === "satisfied" ? 0 : observation.verdict === "unsatisfied" ? 1 : 2;
}

function adjudicateClosure(repo, { explicit, stop, sessionId, actorSession = null, transcriptPath, inlineCriterionBudgetSeconds = null }, readiness) {
  const intent = explicit ? "achieve" : "stop";
  const runtimeDeadlineEpochMs = stop ? Date.now() + STOP_RUNTIME_DEADLINE_SECONDS * 1000 : null;
  const prepared = prepareTaskObservation(repo, { intent, stop, sessionId, transcriptPath, inlineCriterionBudgetSeconds, deadlineEpochMs: runtimeDeadlineEpochMs }, readiness);
  if (prepared.status !== "ready") return prepared;
  const executed = executePreparedObservation(repo, prepared, {
    intent,
    runtimeDeadlineSeconds: stop ? STOP_RUNTIME_DEADLINE_SECONDS : null,
    runtimeDeadlineEpochMs,
  });
  if (executed.status === "busy") return { status: "hold", code: "criterion_in_progress", message: criterionInProgressMessage(executed.lease) };
  const observation = executed.observation;
  const finalized = commitPreparedObservation(repo, prepared, executed, ({ authority, task, authorityChanged = false, repositorySnapshot }) => {
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    observation.observed_at = at;
    if (observation.execution.execution_error === "criterion_side_effect") {
      return {
        kind: "side_effect",
        committed: commitCriterionSideEffect(repo, {
          authority, task, observation, repositorySnapshot,
          transcriptRange: authorityChanged ? null : prepared.transcript_range,
          actingSession: stop ? sessionId : hostSessionId(), actorKind: stop ? "hook" : "cli", at, atEpochMs,
        }),
      };
    }
    const drift = criterionDrift(task.criterion, repo);
    const actingSession = stop ? (actorSession ?? sessionId) : actingSessionId();
    const feedback = criterionMessage(observation.execution.output_tail) ?? outputHead(observation.execution.output_tail, 160);
    const committed = commitTaskCommand(repo, {
      type: explicit ? "achieve" : "observe", taskId: task.task_id, source: explicit ? "achieve" : "stop",
      actingSession, observation, drift, transcriptRange: prepared.transcript_range,
      attemptId: observation.verdict === "unsatisfied" ? randomUUID() : null,
      signature: observation.verdict === "unsatisfied" && criterionMessage(observation.execution.output_tail) ? fnv1aHex(criterionMessage(observation.execution.output_tail)) : null,
      failureSummary: feedback, autoSuspend: true,
      remaining: `criterion must become satisfied${feedback ? `: ${feedback}` : ""}`,
      closeEpisode: true, at, atEpochMs,
    }, { actorKind: stop ? "hook" : "cli", authority });
    return { kind: "observed", committed, drift };
  });
  if (finalized.status === "stale") return {
    status: "hold",
    code: "criterion_observation_stale",
    message: staleObservationMessage(executed, { sideEffectRecorded: Boolean(finalized.evidence?.committed?.committed) }),
  };
  const outcome = finalized.value;
  if (outcome.kind === "side_effect") {
    const message = `criterion_observation_stale: repository content changed while the criterion was running; observation discarded and side-effect evidence recorded; changed paths: ${observation.changed_paths.join(", ")}`;
    return { status: "hold", code: "criterion_observation_stale", message };
  }
  const task = prepared.task;
  const committed = outcome.committed;
  const drift = outcome.drift;
  const next = committed.projection;
  if (committed.result.status === "suspended") {
    const judgment = committed.result.judgment ?? next.lifecycle.judgment;
    const message = `criterion ${observation.verdict}; task suspended(${committed.result.reason}): ${judgment.failure}; ${judgment.remaining}`;
    return { status: "hold", code: "task_suspended", message };
  }
  if (next.lifecycle.state === "terminal") {
    const advisoryFindings = projectReviewRequirement(task).advisory_findings_count ?? 0;
    const waiver = next.assurance.review_policy === "waived" ? `; review waived: ${next.assurance.review_waiver_reason} (${next.assurance.review_waiver_granted_by})` : "";
    return { status: "achieved", notice: `terminal(achieved); criterion satisfied; advisory findings: ${advisoryFindings}${waiver}; not covered: ${(next.alignment.not_covered ?? []).join(", ") || "none"}` };
  }
  const closure = committed.result.closure ?? closureProjection(next, { drift: drift.length > 0 });
  const explicitSuffix = !explicit && next.policy.close_policy === "explicit" && observation.verdict === "satisfied" ? "; explicit achieve required" : "";
  const executionDiagnostic = observation.execution.execution_error ? `; execution ${observation.execution.execution_error}` : "";
  const message = `criterion ${observation.verdict}; closure ${formatClosure(closure)}${explicitSuffix}${executionDiagnostic}${observation.execution.output_tail ? `; ${outputTail(observation.execution.output_tail, 300)}` : ""}`;
  return { status: "hold", code: closureReasonCode(closure, observation.verdict), message };
}

function presentHookClosure(result) {
  if (result.status === "hold") return holdDisposition(result.code, result.message);
  return { event: "stop", action: "release", notice: result.status === "achieved" ? result.notice : null };
}

function presentCliClosure(result) {
  if (result.status === "no_task") return error("no task");
  if (result.status === "task_suspended") return error("task is suspended; resume first");
  if (result.status === "hold") return error(result.message);
  if (result.status === "achieved") process.stdout.write(`workloop: ${result.notice}\n`);
  return 0;
}

function closeAttempt(repo, { explicit, stop = false, sessionId = null, actorSession = null, transcriptPath = null, inlineCriterionBudgetSeconds = null }) {
  const readiness = { taskStateReady: false };
  try {
    const result = adjudicateClosure(repo, { explicit, stop, sessionId, actorSession, transcriptPath, inlineCriterionBudgetSeconds }, readiness);
    return stop ? presentHookClosure(result) : presentCliClosure(result);
  }
  catch (cause) {
    if (stop && !readiness.taskStateReady) throw hookTaskStateUnavailable(cause);
    throw cause;
  }
}

function terminalNotNeededArtifactEvidence(repo, evidence) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = withTaskLock(repo, () => {
      const authority = loadV3Authority(repo, { recoverTail: true });
      const task = authority.projection;
      if (!task) return { status: "no_task" };
      if (!artifactEvidenceTask(task)) return { status: "legacy" };
      if (task.lifecycle.state !== "active") return { status: "inactive", state: task.lifecycle.state };
      return { status: "ready", task: cloneJson(task), token: observationAuthorityToken(authority, task, "not-needed") };
    });
    if (candidate.status !== "ready") return candidate;
    const deadlineEpochMs = Date.now() + 30_000;
    const repositorySnapshot = repoSnapshot(repo, null, { deadlineEpochMs });
    const checkpoint = artifactCheckpointFromSnapshot(repositorySnapshot);
    const committed = withTaskLock(repo, () => {
      const authority = loadV3Authority(repo, { recoverTail: true });
      const current = authority.projection;
      if (!sameObservationAuthority(candidate.token, observationAuthorityToken(authority, current, "not-needed"))) return { status: "retry" };
      const validation = validateRepoSnapshot(repo, repositorySnapshot, { deadlineEpochMs: Math.min(deadlineEpochMs, Date.now() + OBSERVATION_COMMIT_VALIDATION_MS) });
      if (!validation.matches) return { status: "retry" };
      const delta = artifactCheckpointDelta(current.artifact_checkpoint, checkpoint);
      const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
      const mutationHistory = current.evidence.mutation_history_coverage === "full" && delta.changed_paths.length
        ? "partial" : current.evidence.mutation_history_coverage;
      const prewriteEnforcement = taskPreExecutionCoverage(current) === "full" && delta.changed_paths.length
        ? "partial" : taskPreExecutionCoverage(current);
      const reconciled = commitTaskCommand(repo, {
        type: "reconcile-artifacts", taskId: current.task_id, at, atEpochMs, actingSession: actingSessionId(),
        checkpointId: checkpoint.checkpoint_id, capturedAtMs: checkpoint.captured_at_ms, fromCheckpoint: current.artifact_checkpoint.checkpoint_id,
        toCheckpoint: checkpoint.checkpoint_id, changedEntries: delta.changed_entries, changedPaths: delta.changed_paths,
        currentScopeViolations: currentScopeViolations(current, checkpoint), coverage: "full",
        reason: "not-needed terminal reconciliation",
        coverageChange: delta.changed_paths.length ? {
          artifactState: "full", mutationHistory, prewriteEnforcement,
          episodeId: current.episodes.at(-1).episode_id, hostProfile: "repository", surface: "unhooked-reconcile", exhaustiveSurface: false,
          effectiveFromCheckpoint: current.artifact_checkpoint.checkpoint_id,
          intervalFromCheckpoint: current.artifact_checkpoint.checkpoint_id, intervalToCheckpoint: checkpoint.checkpoint_id,
          reason: "artifact delta was not owned by an operation lease",
        } : null,
      }, { actorKind: "cli", authority });
      const terminalAtEpochMs = Date.now(); const terminalAt = utcTimestamp(terminalAtEpochMs);
      try {
        const terminal = commitTaskCommand(repo, {
          type: "not-needed", taskId: reconciled.projection.task_id, evidence,
          actingSession: actingSessionId(), at: terminalAt, atEpochMs: terminalAtEpochMs,
        });
        return { status: "terminal", projection: terminal.projection };
      } catch (cause) { return { status: "held", message: cause.message }; }
    });
    if (committed.status !== "retry") return committed;
  }
  return { status: "stale" };
}

function terminalCommand(values, type) {
  const repo = repoOf(values);
  if (type === "not-needed") {
    if (!String(values.evidence ?? "").trim()) return error("not-needed requires evidence");
    const artifactEvidence = terminalNotNeededArtifactEvidence(repo, values.evidence);
    if (artifactEvidence.status !== "legacy") {
      if (artifactEvidence.status === "terminal") {
        process.stdout.write(`workloop: terminal(${artifactEvidence.projection.lifecycle.outcome})\n`);
        return 0;
      }
      if (artifactEvidence.status === "no_task") return error("no task");
      if (artifactEvidence.status === "inactive") return error(`task is ${artifactEvidence.state}`);
      if (artifactEvidence.status === "held") return error(artifactEvidence.message);
      return error("repository or task authority changed while reconciling not-needed; retry");
    }
  }
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return error("no task");
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    let result;
    try {
      result = commitTaskCommand(repo, type === "not-needed"
        ? { type, taskId: task.task_id, evidence: values.evidence, actingSession: actingSessionId(), at, atEpochMs }
        : { type, taskId: task.task_id, reason: values.reason, actingSession: actingSessionId(), at, atEpochMs });
    } catch (err) { return error(err.message); }
    process.stdout.write(`workloop: terminal(${result.projection.lifecycle.outcome})\n`);
    return 0;
  });
}

function cmdSuspend(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return error("no task");
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    const reason = String(values.reason ?? "").replaceAll("-", "_");
    try {
      commitTaskCommand(repo, { type: "suspend", taskId: task.task_id, reason, judgment: { remaining: values.remaining, failure: values.failure, next_action: values["next-action"] }, closeEpisode: true, source: "cli", actingSession: hostSessionId(), at, atEpochMs });
    } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdResume(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return error("no task");
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    const episode = { episode_id: randomUUID(), host_session_id: hostSessionId(), started_at: at, ended_at: null, start_task_revision: task.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0 };
    try {
      commitTaskCommand(repo, { type: "resume", taskId: task.task_id, reason: values.reason, episode, actingSession: episode.host_session_id, at, atEpochMs });
    } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdJoin(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return error("no task");
    const sessionId = hostSessionId();
    if (sessionId === "cli") return error("join requires a real host identity; set WORKLOOP_SESSION_ID to the host payload-domain session id or run inside a host that exports one");
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    const episode = { episode_id: randomUUID(), host_session_id: sessionId, started_at: at, ended_at: null, start_task_revision: task.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0 };
    try {
      commitTaskCommand(repo, { type: "join", taskId: task.task_id, reason: values.reason, episode, actingSession: sessionId, at, atEpochMs });
    } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdReview(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return error("no task");
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    const level = String(values.level ?? "").replaceAll("-", "_");
    const record = {
      review_id: randomUUID(),
      criterion_generation_id: task.criterion.criterion_generation_id,
      reviewed_task_revision: task.last_substantive_task_revision,
      reviewed_artifact_revision: task.artifact_revision,
      level,
      reviewer: String(values.reviewer ?? "").trim(),
      blocking_findings_count: parseInteger(values["blocking-findings"], "blocking-findings", { minimum: 0, nullable: false }),
      advisory_findings_count: parseInteger(values["advisory-findings"], "advisory-findings", { minimum: 0, nullable: false }),
      reviewed_at: at,
      acting_session: normalizedIdentity(actingSessionId()) === "cli" ? null : actingSessionId(),
    };
    if (!record.reviewer) return error("review requires --reviewer");
    try {
      commitTaskCommand(repo, { type: "review", taskId: task.task_id, record, actingSession: actingSessionId(), at, atEpochMs });
    } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdAcceptProofGap(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return error("no task");
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    const record = { acceptance_id: randomUUID(), reason: String(values.reason ?? "").trim(), granted_by: grantProvenance(values["granted-by"]), accepted_at: at, criterion_generation_id: task.criterion.criterion_generation_id, accepted_at_task_revision: task.task_revision + 1 };
    try {
      commitTaskCommand(repo, { type: "accept-proof-gap", taskId: task.task_id, record, actingSession: actingSessionId(), at, atEpochMs });
    } catch (err) { return error(err.message); }
    return 0;
  });
}

function cmdAmend(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    const task = readTask(repo, { recoverTail: true });
    if (!task) return error("no task");
    const atEpochMs = Date.now();
    const at = utcTimestamp(atEpochMs);
    const event = { type: "amend", taskId: task.task_id, actingSession: actingSessionId(), reason: values.reason, at, atEpochMs };
    let historyRequirement;
    try { historyRequirement = historyRequirementFrom(values, task); }
    catch (cause) { return error(cause.message); }
    if (historyRequirement !== task.history_requirement) event.historyRequirement = historyRequirement;
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
    const changesCriterion = values.criterion !== undefined || values["criterion-file"] !== undefined || values["criterion-protocol"] !== undefined || values["criterion-subject"] !== undefined || values["criterion-authored-by"] !== undefined;
    if (changesCriterion) {
      const source = sourceFrom(values, repo, task.criterion.source);
      const protocol = values["criterion-protocol"] ?? task.criterion.protocol;
      const subjects = values["criterion-subject"] ? values["criterion-subject"].map((item) => resolveSubject(repo, item)) : task.criterion.subjects;
      const effectiveFiles = event.envelope?.files ?? task.envelope.files;
      for (const subject of subjects) {
        if (!insideEnvelope(subject, effectiveFiles)) return error(`criterion subject is outside the envelope: ${subject}`);
        if (source.kind === "file" && subject === source.value) return error(`criterion subject cannot be the criterion file itself: ${subject}`);
      }
      const authoredBy = values["criterion-authored-by"] !== undefined
        ? criterionAuthorship(values["criterion-authored-by"])
        : task.criterion.authored_by;
      event.criterion = criterionMetadata({ source, protocol, timeoutSeconds: task.criterion.timeout_seconds, subjects, authoredBy, repo });
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
      event.assurance.risk_floor_events = [...new Set([...(event.assurance.risk_floor_events ?? []), ...(changesCriterion && task.artifact_revision > 0 ? ["criterion_amended_after_write"] : []), ...(values["criterion-policy"] !== undefined && task.artifact_revision > 0 ? ["policy_amended_after_write"] : [])])];
    }
    if (newGrants.length) event.grants = newGrants;
    if (event.envelope && artifactEvidenceTask(task)) {
      const checkpoint = task.artifact_checkpoint;
      event.scopeReclassification = {
        checkpointId: checkpoint.checkpoint_id,
        capturedAtMs: checkpoint.captured_at_ms,
        currentScopeViolations: currentScopeViolations({ ...task, envelope: event.envelope }, checkpoint),
        coverage: task.evidence.artifact_state_coverage,
        reason: "envelope amendment reclassified the current artifact checkpoint",
      };
    }
    try {
      commitTaskCommand(repo, event);
    } catch (err) { return error(err.message); }
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

function cmdMigrateArtifactNames(values) {
  const repo = repoOf(values);
  return withTaskLock(repo, () => {
    if (values["granted-by"] !== "user") return error("migrate-artifact-names requires --granted-by user");
    if (!String(values.reason ?? "").trim()) return error("migrate-artifact-names requires --reason");
    const names = eventStoreNameState(repo);
    if (names.current_exists && names.legacy_exists) {
      return error(`both ${EVENT_STORE_FILE} and ${LEGACY_EVENT_STORE_FILE} exist; refusing to choose an authority`);
    }
    let eventStore;
    try {
      eventStore = migrateLegacyEventStoreName(repo, {
        reason: values.reason,
        grantedBy: values["granted-by"],
      });
    } catch (migrationError) { return error(migrationError.message); }
    let snapshotRefreshed = false;
    if (fs.existsSync(eventStorePath(repo))) {
      let replay;
      try { replay = readEventStore(repo); }
      catch (readError) { return error(`renamed event authority is invalid: ${readError.message}`); }
      const projection = evolveAll(null, replay.events);
      const snapshot = buildTaskSnapshot({ sourceCursor: replay.source_cursor, projection, validateProjection: assertV3TaskProjection });
      try {
        saveTaskSnapshot(repo, snapshot, { validateProjection: assertV3TaskProjection });
        snapshotRefreshed = true;
      } catch (snapshotError) { return error(`artifact names migrated but snapshot refresh failed: ${snapshotError.message}`); }
    }
    let outcomes;
    try { outcomes = migrateLegacyOutcomeNames({ home: userHome() }); }
    catch (migrationError) {
      const prefix = eventStore.migrated ? "event artifact name migrated but outcome migration failed" : "outcome migration failed";
      return error(`${prefix}: ${migrationError.message}`);
    }
    process.stdout.write(JSON.stringify({
      ...contractDescriptor(),
      reason: String(values.reason).trim(),
      granted_by: values["granted-by"],
      event_store: eventStore,
      ...outcomes,
      snapshot_refreshed: snapshotRefreshed,
    }, null, 2) + "\n");
    return 0;
  });
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
    } catch (cause) {
      report = {
        ...contractDescriptor(), valid: false, record_count: 0, event_count: 0, valid_end_offset: 0,
        last_repo_sequence: 0, last_record_digest: null, recovered_tail: null,
        error: { code: cause?.code ?? "EVENT_STORE_AUDIT_FAILED", message: cause?.message ?? String(cause) },
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

function userClaimBase(record, event) {
  return {
    task_id: event.task_id,
    repo_sequence: record.repo_sequence,
    task_event_sequence: event.task_event_sequence,
    actor_session: normalizedIdentity(record.actor?.session_id),
  };
}

function appendUnanchoredUserClaims(rows, record, event, previousAssuranceByTask) {
  const base = userClaimBase(record, event);
  const criterion = event.payload?.criterion;
  if (isPlainObject(criterion) && criterion.authored_by === "user") {
    rows.push({ ...base, claim: "criterion_authorship", criterion_generation_id: criterion.criterion_generation_id, source_kind: criterion.source?.kind, source: criterion.source?.value });
  }
  for (const grant of event.payload?.grants ?? []) {
    if (grant?.granted_by === "user") rows.push({ ...base, claim: "grant", grant_id: grant.grant_id, grant_kind: grant.kind, scope: grant.scope, reason: grant.reason });
  }
  const assurance = event.payload?.assurance;
  const previous = previousAssuranceByTask.get(event.task_id) ?? null;
  if (isPlainObject(assurance)) {
    if (assurance.risk_declared_by === "user" && (!previous || previous.risk_declared_by !== "user" || assurance.declared_risk !== previous.declared_risk || assurance.risk_reason !== previous.risk_reason)) {
      rows.push({ ...base, claim: "risk_declaration", declared_risk: assurance.declared_risk, reason: assurance.risk_reason });
    }
    if (assurance.review_policy === "waived" && assurance.review_waiver_granted_by === "user" && (!previous || previous.review_policy !== "waived" || previous.review_waiver_granted_by !== "user" || assurance.review_waiver_reason !== previous.review_waiver_reason)) {
      rows.push({ ...base, claim: "review_waiver", reason: assurance.review_waiver_reason });
    }
    previousAssuranceByTask.set(event.task_id, cloneJson(assurance));
  }
  const acceptance = event.payload?.record;
  if (event.kind === "proof_gap_accepted" && acceptance?.granted_by === "user") rows.push({ ...base, claim: "proof_gap_acceptance", acceptance_id: acceptance.acceptance_id, reason: acceptance.reason });
}

function cmdLedger(values) {
  const repo = repoOf(values);
  let authority;
  let authorityFailure = null;
  try { authority = withTaskLock(repo, () => loadV3Authority(repo, { allowEmpty: true, recoverTail: false })); }
  catch (cause) { authorityFailure = cause?.message ?? String(cause); authority = { replay: { events: [], records: [] } }; }
  let evidenceRows = [];
  let evidenceError = null;
  try { evidenceRows = readEvidence(repo); } catch (cause) { evidenceError = cause?.message ?? String(cause); }
  const tasks = new Set(); const terminals = { achieved: 0, not_needed: 0, abandoned: 0 };
  let rounds = 0; let writes = 0; let reviews = 0; const touched = new Set(); const reviewRows = [];
  const userClaimRows = []; const previousAssuranceByTask = new Map();
  // One record walk serves the user-claim rows, the grant timeline the
  // authority-friction join reads, and the terminal write sets; grants and
  // terminal close times take the record's occurred_at because event-level
  // timestamps are unset.
  const grantEvents = [];
  const writeSetByTask = new Map(); const terminalByTask = new Map();
  for (const record of authority.replay?.records ?? []) {
    for (const event of record.events ?? []) {
      appendUnanchoredUserClaims(userClaimRows, record, event, previousAssuranceByTask);
      const kinds = (event.payload?.grants ?? []).map((item) => item?.kind).filter(Boolean);
      if (kinds.length) grantEvents.push({ task_id: event.task_id, at: record.occurred_at, kinds });
      if (event.kind === "write_authorized") {
        if (event.payload_version === 1) {
          let set = writeSetByTask.get(event.task_id);
          if (!set) writeSetByTask.set(event.task_id, set = new Set());
          for (const file of event.payload?.files ?? []) if (!isSyntheticTouchedFile(file)) set.add(file);
        }
      }
      if (event.kind === "artifact_reconciled") {
        let set = writeSetByTask.get(event.task_id);
        if (!set) writeSetByTask.set(event.task_id, set = new Set());
        for (const file of event.payload?.changed_paths ?? []) if (!isSyntheticTouchedFile(file)) set.add(file);
      }
      if (event.kind === "task_terminal" && event.payload?.outcome) {
        terminalByTask.set(event.task_id, { outcome: event.payload.outcome, closed_at: record.occurred_at });
      }
    }
  }
  let toolCompletions = 0; let artifactReconciliations = 0; let artifactChanges = 0;
  const coverageByTask = new Map();
  const contractByTask = new Map();
  for (const event of authority.replay?.events ?? []) {
    if (event.task_id) tasks.add(event.task_id);
    if (event.kind === "criterion_observed" && event.payload?.observation?.verdict === "unsatisfied") rounds += 1;
    if (event.kind === "task_opened") contractByTask.set(event.task_id, event.payload_version >= 2 ? event.payload.runtime_contract : 5);
    if (event.kind === "task_opened" && event.payload_version >= 2) coverageByTask.set(event.task_id, {
      artifact_state: event.payload.coverage_basis.artifact_state,
      mutation_history: event.payload.coverage_basis.mutation_history,
      prewrite_enforcement: event.payload.coverage_basis.prewrite_enforcement,
      history_requirement: event.payload.coverage_basis.history_requirement,
    });
    if (event.kind === "write_authorized") {
      writes += 1;
      if (event.payload_version === 1) for (const file of event.payload?.files ?? []) touched.add(file);
    }
    if (event.kind === "operation_intent_recorded") writes += 1;
    if (event.kind === "tool_completed") toolCompletions += 1;
    if (event.kind === "artifact_reconciled") {
      artifactReconciliations += 1;
      if (event.payload.from_checkpoint !== event.payload.to_checkpoint) {
        artifactChanges += 1;
        if ((contractByTask.get(event.task_id) ?? 0) >= 6) {
          const current = coverageByTask.get(event.task_id) ?? {
            artifact_state: "unknown", mutation_history: "unknown", prewrite_enforcement: "unknown", history_requirement: "unknown",
          };
          coverageByTask.set(event.task_id, { ...current, mutation_history: "unknown", prewrite_enforcement: "unknown" });
        }
      }
      for (const file of event.payload.changed_paths ?? []) touched.add(file);
    }
    if (event.kind === "coverage_changed") coverageByTask.set(event.task_id, {
      artifact_state: event.payload.artifact_state,
      mutation_history: event.payload.mutation_history,
      prewrite_enforcement: event.payload.prewrite_enforcement,
      history_requirement: coverageByTask.get(event.task_id)?.history_requirement ?? "unknown",
    });
    if ((event.kind === "task_joined" || event.kind === "task_resumed") && (contractByTask.get(event.task_id) ?? 0) >= 6) {
      const current = coverageByTask.get(event.task_id) ?? {
        artifact_state: "unknown", mutation_history: "unknown", prewrite_enforcement: "unknown", history_requirement: "unknown",
      };
      coverageByTask.set(event.task_id, { ...current, mutation_history: "unknown", prewrite_enforcement: "unknown" });
    }
    if (event.kind === "review_recorded") { reviews += 1; reviewRows.push({ task_id: event.task_id, ...event.payload.record }); }
    if (event.kind === "task_terminal" && Object.hasOwn(terminals, event.payload?.outcome)) terminals[event.payload.outcome] += 1;
  }
  const evidence = foldEvidence(evidenceRows);
  const evidenceLossy = Boolean(evidenceError || evidence.coverage !== "covered");
  const anchoredActors = new Set(evidenceRows.filter((row) => row.kind === "actor_anchor" && row.agent_id).map((row) => row.acting_session));
  const unanchored = evidenceLossy ? "unknown" : reviewRows.filter((row) => !row.acting_session || !anchoredActors.has(row.acting_session)).map((row) => ({ task_id: row.task_id, review_id: row.review_id, reviewer: row.reviewer, acting_session: row.acting_session }));
  const bypassSeen = evidenceRows.some((row) => row.kind === "pretooluse_observation" && row.permission_mode_raw === "bypassPermissions");
  const otherKeySeen = evidenceRows.some((row) => row.kind === "pretooluse_observation" && typeof row.permission_mode_raw === "string" && row.permission_mode_raw !== "bypassPermissions");
  const observedShapes = [...new Set(evidenceRows.filter((row) => row.kind === "pretooluse_observation").flatMap((row) => row.command_shapes ?? []))];
  // Authority friction: every persisted owner-path deny, joined to the first
  // grant the same task recorded afterwards. A deny answered by an immediate
  // grant is the loop self-serving through the vocabulary; recurring clusters
  // are the review's vocabulary candidates. Corrupt authority empties the
  // grant timeline, so it must degrade to "unknown" rather than letting every
  // join read as "no grant ever followed".
  const denyRows = evidenceRows.filter((row) => row.kind === "write_denied");
  const authorityFriction = authorityFailure
    ? "unknown"
    : denyRows.length
      ? denyRows.map((row) => {
        const next = grantEvents.find((item) => item.task_id === row.during_task && Date.parse(item.at) >= Date.parse(row.at));
        return {
          at: row.at, task_id: row.during_task, reason: row.reason,
          followed_by_grant: next ? { kinds: [...new Set(next.kinds)], minutes_later: Math.max(0, Math.round((Date.parse(next.at) - Date.parse(row.at)) / 60000)) } : null,
        };
      })
      : evidenceLossy ? "unknown" : [];
  const policyDeviationRows = evidenceRows.filter((row) => row.kind === "policy_deviation");
  const policyDeviations = authorityFailure
    ? "unknown"
    : policyDeviationRows.map((row) => {
      const next = grantEvents.find((item) => item.task_id === row.during_task && Date.parse(item.at) >= Date.parse(row.at));
      return {
        at: row.at, task_id: row.during_task, acting_session: row.acting_session,
        mode: row.gate, reason: row.reason, targets: row.targets_parsed,
        followed_by_grant: next ? { kinds: [...new Set(next.kinds)], minutes_later: Math.max(0, Math.round((Date.parse(next.at) - Date.parse(row.at)) / 60000)) } : null,
      };
    });
  // Terminal write sets exist for the attended post-close join: this fold
  // stops observing at the terminal event, so whether landed work survived
  // afterwards is answered by joining these rows against repository history
  // in the meta-loop review. Rows record observations — outcome, close time,
  // non-synthetic write set — never survival verdicts.
  const terminalWriteSets = authorityFailure ? "unknown" : [...terminalByTask.entries()].map(([taskId, terminal]) => ({
    task_id: taskId, outcome: terminal.outcome, closed_at: terminal.closed_at,
    files: [...(writeSetByTask.get(taskId) ?? [])].sort(),
    write_count_basis: contractByTask.get(taskId) === 7 ? "intent" : contractByTask.get(taskId) === 6 ? "authorized" : "preauthorization_legacy",
    artifact_state_coverage: coverageByTask.get(taskId)?.artifact_state ?? "unknown",
    mutation_history_coverage: coverageByTask.get(taskId)?.mutation_history ?? "unknown",
  }));
  // Recorded reviews with their finding counts. Advisory findings are persisted
  // on every review event but no other query surfaces them, so the meta-loop
  // review — which reads only this ledger — cannot mine advisory clusters
  // without this row. Counts are observations, never verdicts; interpreting a
  // cluster stays attended, like authority_friction above.
  const reviewFindings = authorityFailure ? "unknown" : reviewRows.map((row) => ({
    task_id: row.task_id, review_id: row.review_id, level: row.level, reviewer: row.reviewer,
    blocking_findings_count: row.blocking_findings_count, advisory_findings_count: row.advisory_findings_count,
    reviewed_at: row.reviewed_at,
  }));
  const payload = {
    schema_version: 1, scope: { repo },
    metrics: {
      tasks: tasks.size, terminal: Object.values(terminals).reduce((sum, count) => sum + count, 0), terminal_outcomes: terminals,
      rounds, writes, write_count_basis: new Set(contractByTask.values()).size > 1 ? "mixed" : [...contractByTask.values()][0] === 7 ? "intent" : [...contractByTask.values()][0] === 6 ? "authorized" : "preauthorization_legacy", tool_completions: toolCompletions,
      artifact_reconciliations: artifactReconciliations, artifact_changes: artifactChanges,
      reviews, touched_files: [...touched].filter((file) => !isSyntheticTouchedFile(file)).length,
    },
    authority_use: {
      host_key_bypass_seen: bypassSeen ? true : evidenceLossy ? "unknown" : false,
      host_key_other_seen: otherKeySeen ? true : evidenceLossy ? "unknown" : false,
      command_shapes: observedShapes.length ? observedShapes : evidenceLossy ? "unknown" : [],
    },
    queries: {
      reviews: reviewFindings,
      unanchored_review_claims: unanchored,
      unanchored_user_claims: authorityFailure ? "unknown" : userClaimRows,
      control_plane_friction_candidates: evidenceRows.filter((row) => row.kind === "control_plane_friction_candidate").map((row) => ({ at: row.at, acting_session: row.acting_session, reason: row.reason })),
      policy_deviations: policyDeviations,
      authority_friction: authorityFriction,
      terminal_write_sets: terminalWriteSets,
      write_evidence_coverage: authorityFailure ? "unknown" : [...coverageByTask.entries()].map(([taskId, coverage]) => ({ task_id: taskId, ...coverage })),
    },
    integrity: { authority: authorityFailure ? "invalid" : "valid", authority_error: authorityFailure, evidence: evidenceError ? "invalid" : evidence.coverage, evidence_error: evidenceError, ...evidence },
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  return authorityFailure || evidenceError ? 2 : 0;
}
function cmdInfo() { process.stdout.write(JSON.stringify({ name: "workloop", ...contractDescriptor(), event_store: `.workloop/${EVENT_STORE_FILE}`, outcome_projection: `~/.workloop/${OUTCOME_PROJECTION_FILE}`, distribution_owner: "workloop" }) + "\n"); return 0; }
const CURRENT_AUTHORITY_RUNTIME = Object.freeze({ createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority });

function printCurrent(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return 0; }

function cmdCurrentOpen(values) {
  return printCurrent(openCurrentGitTask({
    target: values.target, goal: values.goal, files: values.files, commandId: values["command-id"],
    sessionId: hostSessionId(), grantedBy: values["granted-by"], reason: values.reason,
  }, CURRENT_AUTHORITY_RUNTIME));
}

function cmdCurrentQuery(values, kind) {
  if (!normalizedIdentity(values.target)) return error(`${kind} requires --target`);
  return printCurrent(queryCurrentGit(values.target, kind, CURRENT_AUTHORITY_RUNTIME));
}

function currentHookTargets(invocation) {
  return [...new Set(writeFileTargets(invocation.toolName, invocation.toolInput, analyzeToolCall(invocation.toolName, invocation.toolInput))
    .map((value) => path.resolve(invocation.repo, value)))];
}

function cmdCurrentHook(values) {
  if (!EXPLICIT_PROFILES.includes(values.profile)) return error(`unsupported hook profile; expected ${EXPLICIT_PROFILES.join("|")}`);
  const mode = values.mode ?? "nudge";
  if (!new Set(["observe", "nudge", "deny"]).has(mode)) return error("--mode must be observe, nudge, or deny");
  const invocation = { ...decodeHook({ profile: values.profile, payload: loadPayload() }), mode };
  const disposition = invocation.event === "pre_tool_use"
    ? { event: invocation.event, action: "pass" }
    : new Set(["post_tool_use", "post_tool_use_failure"]).has(invocation.event)
      ? { event: invocation.event, action: "record" }
      : { event: "stop", action: "release" };
  if (invocation.event === "stop" || invocation.event === "unknown") return emitHookResult(invocation, disposition);
  try {
    const targets = currentHookTargets(invocation);
    if (targets.length !== 1) throw Object.assign(new Error("current authority Hook requires one canonical target"), { code: "TARGET_ROUTING_UNAVAILABLE" });
    recordCurrentGitHook({ target: targets[0], invocation }, CURRENT_AUTHORITY_RUNTIME);
  } catch (cause) {
    const diagnostic = boundedHookDiagnostic(cause);
    if (mode === "deny" && invocation.event === "pre_tool_use") {
      return emitHookResult(invocation, { event: invocation.event, action: "deny", reason: `current authority evidence unavailable (${diagnostic})` });
    }
    process.stderr.write(`workloop: current authority evidence unavailable; host retains execution authority: ${diagnostic}\n`);
  }
  return emitHookResult(invocation, disposition);
}

function cmdHooks(values) {
  if (!EXPLICIT_PROFILES.includes(values.profile)) return error(`unsupported hooks profile; expected ${EXPLICIT_PROFILES.join("|")}`);
  const mode = values.mode ?? "nudge";
  if (!new Set(["observe", "nudge", "deny"]).has(mode)) return error("--mode must be observe, nudge, or deny");
  const action = values.action ?? "recipe";
  if (!new Set(["recipe", "record-install", "record-uninstall", "record-mode"]).has(action)) return error("--action must be recipe, record-install, record-uninstall, or record-mode");
  const repo = repoOf(values);
  if (action !== "recipe") appendEvidence(repo, { at: utcTimestamp(Date.now()), kind: "hook_transition", sequence_session: "<control>", acting_session: null, agent_id: null, permission_mode_raw: null, action: action.slice("record-".length), profile: values.profile, mode, foreign: false, targets_parsed: [], during_task: null });
  const script = path.resolve(process.argv[1] ?? "workloop.mjs");
  const quotedScript = process.platform === "win32" ? `"${script}"` : JSON.stringify(script);
  const command = `node ${quotedScript}`;
  const generatedRecipe = buildHookRecipe({ profile: values.profile, command, mode });
  const recipe = action === "record-uninstall"
    ? { hooks: Object.fromEntries(Object.keys(generatedRecipe.hooks).map((event) => [event, []])) }
    : generatedRecipe;
  process.stdout.write(JSON.stringify(recipe, null, 2) + "\n"); return 0;
}
function cmdHelp() { process.stdout.write(`workloop — criterion-driven work supervisor\n\nopen --goal G (--criterion C|--criterion-file F) --criterion-policy default|deferred-witness|steady-satisfied --alignment-because B [--not-covered N] --files GLOB\n     [--criterion-authored-by self|user] [--history-requirement artifact-only|complete] [--risk routine|substantial|critical] [--risk-reason R] [--change-class CLASS]\n     [--review-policy risk-based|required|waived] [--required-review-level fresh-context|second-model] [--review-waiver-reason R]\n     [--rounds N] [--writes N] [--wall-clock-minutes N] [--token-budget N]\n     [--git-allowed OP --git-reason R] [--destructive-allowed | --destructive-scope ROOT] [--network-allowed] [--install-scripts-allowed] [--publish-allowed] [--granted-by self|user] --reason R\nstatus | verify [--record] | report [--json|--markdown] | achieve | accept-proof-gap --reason R --granted-by user|self | not-needed --evidence E | abandon --reason R\nsuspend --reason needs-input|stuck|out-of-budget --remaining R --failure F --next-action N\nresume --reason R | join --reason R | amend ... [--criterion-authored-by self|user] [--history-requirement artifact-only|complete] --reason R\nreview --level fresh-context|second-model|self-reread --reviewer ID --blocking-findings N --advisory-findings N\narchive-incompatible-state --reason R --granted-by user\nmigrate-artifact-names --reason R --granted-by user\naudit --repo PATH | ledger --json [--repo PATH] | sync-outcomes --repo PATH | audit-outcomes | info\ncurrent-open --target PATH --goal G --files GLOB --command-id ID --reason R --granted-by self|user | current-status|current-audit|current-ledger|current-tasks --target PATH\ncurrent-hook --profile claude|codex-safe|codex-cli-legacy --mode observe|nudge|deny\nhook --profile claude|codex-safe|codex-cli-legacy --mode observe|nudge|deny | hooks --profile ... --mode ... --action recipe|record-install|record-mode|record-uninstall\n\nhook authority: observe/nudge record and fail open; deny is explicit enforcement\nexecution approval always belongs to the host; workloop certifies task closure\n\ncriterion observations: unsatisfied | satisfied | indeterminate\nlifecycle: active | suspended(reason) | terminal(outcome)\n`); return 0; }

const HOOK_STDIN_WAIT = new Int32Array(new SharedArrayBuffer(4));

function readHookPayloadText({ timeoutMs = 5000 } = {}) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const deadline = Date.now() + timeoutMs;
  let lastNonWhitespaceByte = null;
  for (;;) {
    let count;
    try {
      count = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (cause) {
      if (cause?.code === "EINTR") continue;
      if ((cause?.code === "EAGAIN" || cause?.code === "EWOULDBLOCK") && Date.now() < deadline) {
        Atomics.wait(HOOK_STDIN_WAIT, 0, 0, 5);
        continue;
      }
      throw cause;
    }
    if (count === 0) return Buffer.concat(chunks).toString("utf8");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    for (let index = count - 1; index >= 0; index -= 1) {
      const byte = buffer[index];
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
      lastNonWhitespaceByte = byte;
      break;
    }
    if (lastNonWhitespaceByte === 0x7d) {
      const candidate = Buffer.concat(chunks).toString("utf8");
      try { JSON.parse(candidate); return candidate; }
      catch { /* incomplete object; keep reading until it parses or the input ends */ }
    }
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

function contract7Pretool(invocation, repo, callAnalysis, authority, current) {
  const mapping = invocation.toolInput;
  const tool = invocation.toolName;
  const sessionId = invocation.sessionId;
  const actingSession = hookActor(invocation);
  const writeTargets = writeFileTargets(tool, mapping, callAnalysis);
  const writeShaped = contract7OperationShaped(tool, mapping, callAnalysis);
  const targets = writeTargets.map((value) => repoRelative(repo, value)).filter(Boolean);
  const range = transcriptRange(current, invocation.transcriptPath);
  const commandId = invocation.commandId ?? null;
  const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
  const findings = [];
  const addFinding = (code, message) => {
    if (!findings.some((finding) => finding.code === code)) findings.push({ code, message });
  };
  const owner = taskOwnerSessionId(current);
  const sessionRelation = owner && !sessionId ? "unbound" : isForeignSession(current, sessionId) ? "foreign" : "owner";

  const controlFailure = controlPlaneWriteFailure(repo, tool, mapping, userHome(), callAnalysis);
  if (controlFailure) addFinding("control_plane", controlFailure);
  if (sessionRelation !== "owner") {
    const decision = foreignWriteDecision(repo, current, tool, mapping, callAnalysis, userHome(), sessionId);
    if (decision.kind === "deny") addFinding("foreign_session", decision.message);
  }
  if (current.lifecycle.state === "suspended" && writeShaped) {
    addFinding("suspended", `task suspended (${current.lifecycle.reason}); resume before writing`);
  }
  const shapes = callAnalysis.shapes;
  if (shapes.some((shape) => shape === "publish" || shape.endsWith("_push"))) {
    const permissionMode = normalizedIdentity(invocation.permissionModeRaw);
    if (!permissionMode) addFinding("host_approval_unavailable", "host approval key capability unavailable: this host did not expose permission_mode");
    else if (permissionMode === "bypassPermissions") addFinding("host_approval_bypassed", "host approval key was explicitly bypassed");
  }
  const gitDenial = ownerGitDenial(repo, current, callAnalysis, sessionId);
  if (gitDenial) addFinding("git_grant_missing", gitDenial);
  for (const { command, analysis } of callAnalysis.commands) {
    const failure = commandSafetyFailure(current, command, { tool, analysis, repo });
    if (failure) addFinding("safety_grant_missing", failure);
  }
  if (writeShaped) {
    const budgetState = range
      ? evolveAll(current, decide(current, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession, at, atEpochMs }).events)
      : current;
    const exhausted = projectBudgetExhaustion(budgetState, atEpochMs);
    if (exhausted.length) addFinding("budget_exhausted", BUDGET_DENIALS[exhausted[0].dimension](exhausted[0]));
    const capability = hostProfileCapability(invocation.profile);
    if (current.history_requirement === "complete" && !capability.exhaustive_surface) {
      addFinding("history_unavailable", `complete mutation history is unavailable for ${invocation.profile}; this host surface is non-exhaustive`);
    }
    if (sessionRelation === "owner") {
      const externalDenial = ownerExternalTargetDenial(repo, tool, mapping, callAnalysis, userHome(), sessionId);
      if (externalDenial) addFinding("external_target", externalDenial);
      for (const target of targets) if (!insideEnvelope(target, current.envelope.files)) addFinding("outside_envelope", `write outside envelope: ${target}`);
    }
  }

  const persistPolicyEvidence = () => {
    for (const finding of findings) appendHookEvidence(repo, invocation, {
      kind: "policy_deviation", at, gate: invocation.mode, foreign: sessionRelation === "foreign",
      targets_parsed: targets, during_task: current.task_id, reason: `${finding.code}: ${finding.message}`,
    });
  };
  if (invocation.mode === "deny" && findings.length) {
    persistPolicyEvidence();
    if (range) commitTaskCommand(repo, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession, at, atEpochMs }, { actorKind: "hook", authority, commandId });
    return deny(findings[0].message);
  }
  if (!writeShaped || current.lifecycle.state !== "active") {
    if (findings.length) {
      persistPolicyEvidence();
      if (invocation.mode === "nudge") process.stderr.write(`workloop: policy deviation observed (${findings.map((finding) => finding.code).join(",")}); host retains execution authority\n`);
    }
    if (range) commitTaskCommand(repo, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession, at, atEpochMs }, { actorKind: "hook", authority, commandId });
    return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
  }

  const scopedDestructive = shapes.includes("destructive") ? scopedDestructiveAttribution(repo, current, callAnalysis) : null;
  const commandMarkers = [...new Set(shapes.map((shape) => `<command:${scopedDestructive && shape === "destructive" ? "destructive_scoped" : shape}>`))];
  const scopedEntries = (scopedDestructive?.targets ?? []).map((target) => `<destructive-scoped:${target}>`);
  const persistedTargets = persistedOperationTargets(repo, writeTargets);
  const declaredTargets = [...(persistedTargets.length ? persistedTargets : scopedDestructive?.exclusive ? [] : ["<command>"]), ...scopedEntries, ...commandMarkers];
  const hostCapability = hostProfileCapability(invocation.profile);
  commitTaskCommand(repo, {
    type: "record-operation-intent", taskId: current.task_id, transcriptRange: range,
    files: declaredTargets, operationId: commandId ?? `unmatched-pre:${randomUUID()}`,
    toolFamily: canonicalToolFamily(tool), hostProfile: invocation.profile,
    targetCoverage: persistedTargets.length ? "exact" : "unknown",
    receiptExpectation: hostCapability.completion_events.includes("PostToolUse") ? "post" : "reconcile",
    policyMode: invocation.mode,
    policyDisposition: findings.length ? "deviation" : "conformant",
    policyReasons: findings.map((finding) => finding.code),
    sessionRelation,
    actingSession, at, atEpochMs,
  }, { actorKind: "hook", authority, commandId });
  if (findings.length) {
    persistPolicyEvidence();
    if (invocation.mode === "nudge") process.stderr.write(`workloop: policy deviation observed (${findings.map((finding) => finding.code).join(",")}); host retains execution authority\n`);
  }
  return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
}

function hookPretool(invocation, repo, callAnalysis) {
  const mapping = invocation.toolInput;
  const tool = invocation.toolName;
  const sessionId = invocation.sessionId;
  const actingSession = hookActor(invocation);
  const payload = { session_id: sessionId };
  const writeTargets = writeFileTargets(tool, mapping, callAnalysis);
  const writeShaped = writeShapedCall(tool, mapping, callAnalysis);
  const hostCapability = hostProfileCapability(invocation.profile);
  if (callAnalysis.commands.some(({ command, analysis }) => workloopInvocation(command, tool, analysis))) {
    appendHookEvidence(repo, invocation, { kind: "actor_anchor", foreign: false, gate: invocation.mode, targets_parsed: [], during_task: null });
  } else if (callAnalysis.commands.some(({ command, analysis }) => workloopFrictionCandidate(command, tool, analysis))) {
    appendHookEvidence(repo, invocation, { kind: "control_plane_friction_candidate", foreign: false, gate: invocation.mode, targets_parsed: [], during_task: null, reason: "workloop-shaped shell text was not safely rewritable" });
    process.stderr.write("workloop: a workloop invocation is mixed into compound shell text, so session binding cannot be injected; run workloop alone as a single command to keep the task bound to this session\n");
  }
  let taskStateReady = false;
  let strictPrepared = null;
  try {
    if (writeShaped && hostCapability.exhaustive_surface) {
      const candidate = withTaskLock(repo, () => {
        const authority = loadV3Authority(repo, { recoverTail: true });
        taskStateReady = true;
        const current = authority.projection;
        if (
          current?.runtime_contract !== 6 || current.lifecycle.state !== "active" ||
          current.history_requirement !== "complete" || isForeignSession(current, sessionId)
        ) return null;
        return { token: observationAuthorityToken(authority, current, "strict-pre"), checkpoint_id: current.artifact_checkpoint.checkpoint_id };
      });
      if (candidate) {
        const deadlineEpochMs = Date.now() + PRE_TOOL_USE_RECIPE_TIMEOUT_SECONDS * 1000;
        const repositorySnapshot = repoSnapshot(repo, null, { deadlineEpochMs });
        let checkpoint = null; let snapshotFailure = repositorySnapshot.error ?? null;
        if (!snapshotFailure) {
          try { checkpoint = artifactCheckpointFromSnapshot(repositorySnapshot); }
          catch (cause) { snapshotFailure = cause; }
        }
        strictPrepared = { ...candidate, repositorySnapshot, checkpoint, snapshotFailure, deadlineEpochMs };
      }
    }
    return withTaskLock(repo, () => {
    const authority = loadV3Authority(repo, { recoverTail: true });
    taskStateReady = true;
    const current = authority.projection;
    if (!current) {
      const result = observeUntracked({ payload, sessionId, mode: invocation.mode, repo, writeShaped, writeTargets, scriptPath: process.argv[1] ?? "workloop.mjs" });
      if (result.evidence) appendHookEvidence(repo, invocation, { kind: "untracked_write", ...result.evidence, foreign: false, during_task: null });
      if (result.kind === "deny") return deny(result.message.replace(/^workloop:\s*/, ""));
      if (result.kind === "notice") process.stderr.write(result.message + "\n");
      return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
    }
    if (current.lifecycle.state === "terminal") return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
    const shapes = callAnalysis.shapes;
    const operationShaped = current.runtime_contract === 7
      ? contract7OperationShaped(tool, mapping, callAnalysis)
      : writeShaped;
    if (operationShaped) appendHookEvidence(repo, invocation, {
      kind: "pretooluse_observation", gate: invocation.mode, foreign: isForeignSession(current, sessionId),
      targets_parsed: writeTargets.map((value) => repoRelative(repo, value)).filter(Boolean),
      command_shapes: [...new Set(shapes)], during_task: current.task_id,
    });
    if (current.runtime_contract === 7) return contract7Pretool(invocation, repo, callAnalysis, authority, current);
    const controlFailure = controlPlaneWriteFailure(repo, tool, mapping, userHome(), callAnalysis);
    if (controlFailure) return deny(controlFailure);
    if (isForeignSession(current, sessionId)) {
      const decision = foreignWriteDecision(repo, current, tool, mapping, callAnalysis, userHome(), sessionId);
      if (decision.kind === "deny") return deny(decision.message);
      if (decision.kind === "untracked") {
        const result = observeUntracked({ payload, sessionId, foreign: true, mode: invocation.mode, repo, writeShaped: decision.writeShaped, writeTargets: decision.targets, scriptPath: process.argv[1] ?? "workloop.mjs" });
        if (result.evidence) appendHookEvidence(repo, invocation, { kind: "untracked_write", ...result.evidence, foreign: true, during_task: current.task_id });
        if (result.kind === "deny") return deny(result.message.replace(/^workloop:\s*/, ""));
        if (result.kind === "notice") process.stderr.write(result.message + "\n");
      }
      return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
    }
    const range = transcriptRange(current, invocation.transcriptPath);
    const commandId = invocation.commandId ?? null;
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    const persistDeny = (reason) => {
      // The engine's deny path emits no event, so the reason would otherwise
      // survive only in the host transcript; this telemetry row is what lets
      // the meta-loop review mine authority friction after the fact.
      appendHookEvidence(repo, invocation, { kind: "write_denied", at, gate: invocation.mode, foreign: false, targets_parsed: writeTargets.map((value) => repoRelative(repo, value)).filter(Boolean), during_task: current.task_id, reason });
      commitTaskCommand(repo, { type: "authorize-write", taskId: current.task_id, decision: "deny", reason, transcriptRange: range, actingSession, at, atEpochMs }, { actorKind: "hook", authority, commandId });
      return deny(reason);
    };
    if (current.lifecycle.state === "suspended") {
      if (writeShaped) return persistDeny(`task suspended (${current.lifecycle.reason}); resume before writing`);
      if (range) commitTaskCommand(repo, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession, at, atEpochMs }, { actorKind: "hook", authority, commandId });
      return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
    }
    if (shapes.some((shape) => shape === "publish" || shape.endsWith("_push"))) {
      const permissionMode = normalizedIdentity(invocation.permissionModeRaw);
      if (!permissionMode) return persistDeny("host approval key capability unavailable: this host did not expose permission_mode, so irreversible authority is unsupported");
      if (permissionMode === "bypassPermissions") return persistDeny("host approval key was explicitly bypassed; irreversible authority cannot be authorized");
    }
    const gitDenial = ownerGitDenial(repo, current, callAnalysis, sessionId);
    if (gitDenial) return persistDeny(gitDenial);
    for (const { command, analysis } of callAnalysis.commands) {
      const failure = commandSafetyFailure(current, command, { tool, analysis, repo });
      if (failure) return persistDeny(failure);
    }
    if (!writeShaped) {
      if (range) commitTaskCommand(repo, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession, at, atEpochMs }, { actorKind: "hook", authority, commandId });
      return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
    }
    const budgetState = range
      ? evolveAll(current, decide(current, { type: "tally-transcript", taskId: current.task_id, transcriptRange: range, actingSession, at, atEpochMs }).events)
      : current;
    const exhausted = projectBudgetExhaustion(budgetState, atEpochMs);
    if (exhausted.length) {
      const first = exhausted[0];
      return persistDeny(BUDGET_DENIALS[first.dimension](first));
    }
    if (current.runtime_contract === 6 && current.history_requirement === "complete" && !hostCapability.exhaustive_surface) {
      return persistDeny(`complete mutation history is unavailable for ${invocation.profile}; this host surface is non-exhaustive, so open a new task with --history-requirement artifact-only only if partial history is acceptable`);
    }
    let strictCoverageChange = null;
    if (current.runtime_contract === 6 && current.history_requirement === "complete") {
      if (!invocation.commandId) return persistDeny("complete mutation history requires a stable host tool_use_id for the operation lease");
      if (!strictPrepared || strictPrepared.snapshotFailure || !strictPrepared.checkpoint) {
        return persistDeny(`complete mutation history pre-reconciliation unavailable (${strictPrepared?.snapshotFailure?.code ?? "snapshot_unavailable"})`);
      }
      if (!sameObservationAuthority(strictPrepared.token, observationAuthorityToken(authority, current, "strict-pre"))) {
        return persistDeny("complete mutation history pre-reconciliation became stale; retry the tool call");
      }
      const validation = validateRepoSnapshot(repo, strictPrepared.repositorySnapshot, {
        deadlineEpochMs: Math.min(strictPrepared.deadlineEpochMs, Date.now() + OBSERVATION_COMMIT_VALIDATION_MS),
      });
      if (!validation.matches) return persistDeny(`complete mutation history pre-reconciliation unavailable (${validation.error?.code ?? "snapshot_stale"})`);
      if (current.episodes.length !== 1) {
        return persistDeny("complete mutation history cannot cross a host episode boundary; open a new task to establish a new complete-history chain");
      }
      const checkpoint = strictPrepared.checkpoint;
      const delta = artifactCheckpointDelta(current.artifact_checkpoint, checkpoint);
      const openLease = current.capability_leases.find((lease) => lease.status === "open") ?? null;
      if (openLease || checkpoint.checkpoint_id !== current.artifact_checkpoint.checkpoint_id) {
        const coverageChange = openLease ? {
          artifactState: "full", mutationHistory: "unknown", prewriteEnforcement: "unknown",
          episodeId: current.episodes.at(-1).episode_id, operationId: openLease.operation_id, capabilityId: openLease.capability_id,
          hostProfile: openLease.host_profile, surface: openLease.surface, exhaustiveSurface: true,
          effectiveFromCheckpoint: openLease.effective_from_checkpoint, intervalFromCheckpoint: openLease.effective_from_checkpoint,
          intervalToCheckpoint: checkpoint.checkpoint_id, reason: "next Pre observed a missing completion receipt",
        } : {
          artifactState: "full", mutationHistory: "unknown", prewriteEnforcement: "unknown",
          episodeId: current.episodes.at(-1).episode_id, operationId: null, capabilityId: null,
          hostProfile: "repository", surface: "unhooked-reconcile", exhaustiveSurface: false,
          effectiveFromCheckpoint: current.artifact_checkpoint.checkpoint_id,
          intervalFromCheckpoint: current.artifact_checkpoint.checkpoint_id, intervalToCheckpoint: checkpoint.checkpoint_id,
          reason: "strict Pre discovered an unowned artifact delta",
        };
        const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
        commitTaskCommand(repo, {
          type: "reconcile-artifacts", taskId: current.task_id, at, atEpochMs, actingSession,
          checkpointId: checkpoint.checkpoint_id, capturedAtMs: checkpoint.captured_at_ms, fromCheckpoint: current.artifact_checkpoint.checkpoint_id,
          toCheckpoint: checkpoint.checkpoint_id, changedEntries: delta.changed_entries, changedPaths: delta.changed_paths,
          currentScopeViolations: currentScopeViolations(current, checkpoint), coverage: "full",
          reason: openLease ? "missing PostToolUse reconciled at the next Pre" : "strict Pre reconciled an unowned delta",
          coverageChange,
        }, { actorKind: "hook", authority, commandId: invocation.commandId });
        return deny(openLease
          ? "previous exhaustive operation is missing its completion receipt; mutation history was downgraded"
          : "an unowned artifact delta was found before this exhaustive operation; mutation history is incomplete");
      }
      if (current.coverage_intervals.some((interval) => interval.mutation_history !== "full")) {
        return persistDeny("complete mutation history was previously degraded and cannot be restored by a later operation");
      }
      strictCoverageChange = {
        artifactState: "full", mutationHistory: "full", prewriteEnforcement: "full",
        episodeId: current.episodes.at(-1).episode_id, operationId: invocation.commandId, capabilityId: hostCapability.capability_id,
        hostProfile: invocation.profile, surface: "direct-hook", exhaustiveSurface: true,
        effectiveFromCheckpoint: current.artifact_checkpoint.checkpoint_id,
        intervalFromCheckpoint: current.artifact_checkpoint.checkpoint_id, intervalToCheckpoint: null,
        reason: "strict Pre reconciled the current checkpoint and opened an exhaustive operation lease",
      };
    }
    const externalDenial = ownerExternalTargetDenial(repo, tool, mapping, callAnalysis, userHome(), sessionId);
    if (externalDenial) return persistDeny(externalDenial);
    const targets = writeTargets.map((value) => repoRelative(repo, value)).filter(Boolean);
    for (const target of targets) if (!insideEnvelope(target, current.envelope.files)) return persistDeny(`write outside envelope: ${target}`);
    const scopedDestructive = shapes.includes("destructive") ? scopedDestructiveAttribution(repo, current, callAnalysis) : null;
    const commandMarkers = [...new Set(shapes.map((shape) => `<command:${scopedDestructive && shape === "destructive" ? "destructive_scoped" : shape}>`))];
    const scopedEntries = (scopedDestructive?.targets ?? []).map((target) => `<destructive-scoped:${target}>`);
    const authorizedFiles = [...(targets.length ? targets : scopedDestructive?.exclusive ? [] : ["<command>"]), ...scopedEntries, ...commandMarkers];
    commitTaskCommand(repo, {
      type: "authorize-write", taskId: current.task_id, decision: "allow", reason: "", transcriptRange: range,
      files: authorizedFiles, operationId: commandId ?? `unmatched-pre:${randomUUID()}`,
      toolFamily: canonicalToolFamily(tool), hostProfile: invocation.profile,
      targetCoverage: targets.length ? "exact" : "unknown",
      receiptExpectation: hostCapability.completion_events.includes("PostToolUse") ? "post" : "reconcile",
      coverageChange: strictCoverageChange,
      actingSession, at, atEpochMs,
    }, { actorKind: "hook", authority, commandId });
    return allowWorkloopCommand(sessionId, mapping, tool, invocation.agentId, callAnalysis);
    });
  }
  catch (cause) {
    if (!taskStateReady) throw hookTaskStateUnavailable(cause);
    throw cause;
  }
}

function hookPosttool(invocation, repo, callAnalysis) {
  const event = invocation.event;
  const disposition = { event, action: "record" };
  const legacyWriteShaped = writeShapedCall(invocation.toolName, invocation.toolInput, callAnalysis);
  if (!legacyWriteShaped) {
    if (!opaqueMcpOperation(invocation.toolName)) return disposition;
    const contract7Task = withTaskLock(repo, () => {
      const current = loadV3Authority(repo, { recoverTail: true }).projection;
      return current?.runtime_contract === 7 && current.lifecycle.state !== "terminal";
    });
    if (!contract7Task) return disposition;
  }
  const configuredDeadlineMs = Number.parseInt(process.env.WORKLOOP_POST_SNAPSHOT_DEADLINE_MS ?? "", 10);
  const scanBudgetMs = Number.isSafeInteger(configuredDeadlineMs) && configuredDeadlineMs >= 0
    ? configuredDeadlineMs
    : POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS * 1000;
  const deadlineEpochMs = Date.now() + scanBudgetMs;
  const repositorySnapshot = repoSnapshot(repo, null, { deadlineEpochMs });
  let checkpoint = null; let snapshotFailure = null;
  try { checkpoint = artifactCheckpointFromSnapshot(repositorySnapshot); }
  catch (cause) { snapshotFailure = cause; }
  return withTaskLock(repo, () => {
    const authority = loadV3Authority(repo, { recoverTail: true });
    const current = authority.projection;
    if (!current || !artifactEvidenceTask(current) || current.lifecycle.state === "terminal") return disposition;
    const validation = snapshotFailure ? null : validateRepoSnapshot(repo, repositorySnapshot, { deadlineEpochMs: Math.min(deadlineEpochMs, Date.now() + OBSERVATION_COMMIT_VALIDATION_MS) });
    const scanTrusted = !snapshotFailure && validation?.matches;
    const currentCheckpoint = current.artifact_checkpoint;
    const reconciledCheckpoint = scanTrusted ? checkpoint : currentCheckpoint;
    const delta = scanTrusted ? artifactCheckpointDelta(currentCheckpoint, reconciledCheckpoint) : { changed_entries: [], changed_paths: [] };
    const operationId = invocation.commandId ?? `orphan-post:${randomUUID()}`;
    const capability = hostProfileCapability(invocation.profile);
    const operationEvidence = current.runtime_contract === 7
      ? current.operations[operationId]?.intent
      : current.operations[operationId]?.authorization;
    const evidenced = operationEvidence !== null && operationEvidence !== undefined;
    const mutationHistory = !scanTrusted || !evidenced ? "unknown"
      : !capability.exhaustive_surface && current.evidence.mutation_history_coverage === "full" ? "partial"
        : current.evidence.mutation_history_coverage;
    const prewriteEnforcement = !scanTrusted || !evidenced ? "unknown"
      : !capability.exhaustive_surface && taskPreExecutionCoverage(current) === "full" ? "partial"
        : taskPreExecutionCoverage(current);
    const targets = persistedOperationTargets(repo, writeFileTargets(invocation.toolName, invocation.toolInput, callAnalysis));
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    if (current.runtime_contract === 6 && isForeignSession(current, invocation.sessionId)) {
      commitTaskCommand(repo, {
        type: "reconcile-artifacts", taskId: current.task_id,
        checkpointId: reconciledCheckpoint.checkpoint_id, capturedAtMs: reconciledCheckpoint.captured_at_ms, fromCheckpoint: currentCheckpoint.checkpoint_id,
        toCheckpoint: reconciledCheckpoint.checkpoint_id, changedEntries: delta.changed_entries, changedPaths: delta.changed_paths,
        currentScopeViolations: scanTrusted ? currentScopeViolations(current, reconciledCheckpoint) : current.evidence.current_scope_violations,
        coverage: scanTrusted ? "full" : "unknown",
        reason: !scanTrusted ? "foreign PostToolUse reconciliation unavailable" : "foreign PostToolUse reconciled without accepting its receipt",
        coverageChange: {
          artifactState: scanTrusted ? "full" : "unknown", mutationHistory: "unknown", prewriteEnforcement: "unknown",
          episodeId: current.episodes.at(-1).episode_id, operationId: null, capabilityId: null,
          hostProfile: invocation.profile, surface: "foreign-post-hook", exhaustiveSurface: false,
          effectiveFromCheckpoint: currentCheckpoint.checkpoint_id,
          intervalFromCheckpoint: currentCheckpoint.checkpoint_id, intervalToCheckpoint: reconciledCheckpoint.checkpoint_id,
          reason: "foreign completion receipt rejected; repository state reconciled as unowned",
        },
        actingSession: hookActor(invocation), at, atEpochMs,
      }, { actorKind: "hook", authority, commandId: invocation.commandId });
      return disposition;
    }
    if (process.env.WORKLOOP_POST_COMMIT_FAILPOINT === "before-authority-commit") {
      throw new Error("injected PostToolUse authority commit failure");
    }
    commitTaskCommand(repo, {
      type: "complete-operation", taskId: current.task_id, operationId,
      toolFamily: canonicalToolFamily(invocation.toolName), outcome: invocation.completionOutcome,
      reportedTargets: targets, receiptQuality: invocation.receiptQuality, hostProfile: invocation.profile,
      checkpointId: reconciledCheckpoint.checkpoint_id, capturedAtMs: reconciledCheckpoint.captured_at_ms, fromCheckpoint: currentCheckpoint.checkpoint_id,
      toCheckpoint: reconciledCheckpoint.checkpoint_id, changedEntries: delta.changed_entries, changedPaths: delta.changed_paths,
      currentScopeViolations: scanTrusted ? currentScopeViolations(current, reconciledCheckpoint) : current.evidence.current_scope_violations,
      coverage: scanTrusted ? "full" : "unknown",
      reason: !scanTrusted ? `PostToolUse reconciliation unavailable: ${snapshotFailure?.code ?? (validation?.error?.code ?? "snapshot_stale")}`
        : event === "post_tool_use_failure" ? "PostToolUseFailure reconciliation" : "PostToolUse reconciliation",
      coverageChange: {
        artifactState: scanTrusted ? "full" : "unknown", mutationHistory, prewriteEnforcement,
        episodeId: current.episodes.at(-1).episode_id, operationId, capabilityId: capability.capability_id,
        hostProfile: invocation.profile, surface: "unresolved-direct-hook", exhaustiveSurface: capability.exhaustive_surface,
        effectiveFromCheckpoint: currentCheckpoint.checkpoint_id,
        intervalFromCheckpoint: currentCheckpoint.checkpoint_id, intervalToCheckpoint: reconciledCheckpoint.checkpoint_id,
        reason: !scanTrusted ? "operation receipt observed but repository snapshot was unavailable"
          : evidenced ? "operation completion receipt" : "orphan operation completion receipt",
      },
      actingSession: hookActor(invocation), at, atEpochMs,
    }, { actorKind: "hook", authority, commandId: invocation.commandId });
    return disposition;
  });
}

function persistPostCommitFailure(repo, invocation, cause) {
  return withTaskLock(repo, () => {
    if (process.env.WORKLOOP_POST_DEGRADE_FAILPOINT === "task-unavailable") return false;
    const authority = loadV3Authority(repo, { recoverTail: true });
    const current = authority.projection;
    if (!current || !artifactEvidenceTask(current) || current.lifecycle.state === "terminal") return false;
    const atEpochMs = Date.now(); const at = utcTimestamp(atEpochMs);
    const operationId = invocation.commandId ?? null;
    const capability = hostProfileCapability(invocation.profile);
    const checkpointId = current.artifact_checkpoint.checkpoint_id;
    const diagnostic = boundedHookDiagnostic(cause);
    commitTaskCommand(repo, {
      type: "change-coverage", taskId: current.task_id,
      artifactState: "unknown", mutationHistory: "unknown", prewriteEnforcement: "unknown",
      episodeId: current.episodes.at(-1).episode_id, operationId,
      capabilityId: operationId ? capability.capability_id : null,
      hostProfile: invocation.profile, surface: "post-authority-commit-failure", exhaustiveSurface: false,
      effectiveFromCheckpoint: checkpointId, intervalFromCheckpoint: checkpointId,
      intervalToCheckpoint: checkpointId,
      reason: `PostToolUse authority commit failed: ${diagnostic}`,
      actingSession: hookActor(invocation), at, atEpochMs,
    }, { actorKind: "hook", authority, commandId: invocation.commandId });
    return true;
  });
}

function boundedHookDiagnostic(cause) {
  return String(cause?.code ?? cause?.message ?? cause).split("\n")[0].slice(0, 300) || "unknown";
}

function hookStop(repo, invocation) {
  const owner = normalizedIdentity(invocation?.sessionId) ?? "<unbound>";
  const capability = hostProfileCapability(invocation.profile);
  const shouldRecordCensus = fs.existsSync(evidencePath(repo)) || fs.existsSync(eventStorePath(repo));
  if (shouldRecordCensus) {
    const pretooluseArmed = pretooluseEvidenceState(repo, owner);
    appendHookEvidence(
      repo,
      invocation,
      { kind: "stop_census", pretooluse_armed: pretooluseArmed, mode: invocation.mode, foreign: false, targets_parsed: [], during_task: null },
      capability.stop_control === "release_only" || invocation.mode !== "deny" ? { timeoutMs: 25 } : undefined,
    );
  }
  if (invocation.mode !== "deny" || capability.stop_control === "release_only") return { event: "stop", action: "release" };
  return closeAttempt(repo, {
    explicit: false,
    stop: true,
    sessionId: invocation.sessionId,
    actorSession: hookActor(invocation),
    transcriptPath: invocation.transcriptPath,
    inlineCriterionBudgetSeconds: capability.inline_criterion_budget_seconds,
  });
}

function emitHookResult(invocation, result) {
  const disposition = isPlainObject(result) && typeof result.event === "string"
    ? result
    : invocation.event === "pre_tool_use"
      ? { event: "pre_tool_use", action: "pass" }
      : new Set(["post_tool_use", "post_tool_use_failure"]).has(invocation.event)
        ? { event: invocation.event, action: "record" }
        : { event: "stop", action: "release" };
  const encoded = encodeHook({ invocation, disposition });
  if (encoded.stdout) process.stdout.write(encoded.stdout);
  if (encoded.stderr) process.stderr.write(encoded.stderr);
  return encoded.exitCode;
}

function dispatchHook(profile = "unknown", mode = "nudge") {
  if (!new Set(["observe", "nudge", "deny"]).has(mode)) return error("--mode must be observe, nudge, or deny");
  const payload = loadPayload(); const invocation = { ...decodeHook({ profile, payload }), mode }; const event = invocation.event; const repo = path.resolve(invocation.repo);
  const mapping = invocation.toolInput;
  const callAnalysis = analyzeToolCall(invocation.toolName, mapping);
  const writeShaped = contract7OperationShaped(invocation.toolName, mapping, callAnalysis);
  let result;
  try {
    if (event === "pre_tool_use") result = hookPretool(invocation, repo, callAnalysis);
    else if (new Set(["post_tool_use", "post_tool_use_failure"]).has(event)) result = hookPosttool(invocation, repo, callAnalysis);
    else if (event === "stop") result = hookStop(repo, invocation);
    else return 0;
  }
  catch (err) {
    if (new Set(["post_tool_use", "post_tool_use_failure"]).has(event)) {
      try {
        const persisted = persistPostCommitFailure(repo, invocation, err);
        if (!persisted) throw new Error("PostToolUse task state no longer accepts coverage degradation");
        process.stderr.write(`workloop: completion receipt degraded and unknown coverage persisted: ${boundedHookDiagnostic(err)}\n`);
        return emitHookResult(invocation, { event, action: "record" });
      } catch (degradeError) {
        process.stderr.write(`workloop: completion receipt degradation could not be persisted: ${boundedHookDiagnostic(degradeError)}; original error: ${boundedHookDiagnostic(err)}\n`);
        return mode === "deny" ? 2 : emitHookResult(invocation, { event, action: "record" });
      }
    }
    if (mode !== "deny") {
      process.stderr.write(`workloop: hook evidence unavailable; host retains execution authority: ${boundedHookDiagnostic(err)}\n`);
      if (event === "pre_tool_use") return emitHookResult(invocation, { event, action: "pass" });
      if (event === "stop") return emitHookResult(invocation, { event, action: "release" });
      return emitHookResult(invocation, { event, action: "record" });
    }
    if (event === "stop" && hostProfileCapability(invocation.profile).stop_control === "release_only") {
      return emitHookResult(invocation, { event: "stop", action: "release" });
    }
    // Surface the real cause in the host-visible reason, not only stderr: the
    // host relays just the deny/hold reason, so a bare "supervisor unavailable"
    // leaves the operator blind to whether it was lock contention, unreadable
    // state, or a bug. err.code is preserved through hookTaskStateUnavailable.
    const cause = err?.code || String(err?.message ?? err).split("\n")[0] || "unknown";
    if (err?.hook_task_state_unavailable === true) {
      process.stderr.write(`${err.message}\n`);
      if (event === "pre_tool_use" && writeShaped) result = deny(`supervisor unavailable (${cause}); refusing a write whose artifact revision cannot be recorded`);
      else if (event === "stop") result = holdDisposition("task_state_unavailable", `task state unavailable (${cause}); refusing to adjudicate Stop`);
    }
    else {
      process.stderr.write(`workloop: supervisor error: ${err?.message ?? err}\n`);
      if (event === "pre_tool_use" && writeShaped) result = deny(`supervisor unavailable (${cause}); refusing a write whose artifact revision cannot be recorded`);
      else if (event === "stop") result = holdDisposition("supervisor_unavailable", `supervisor unavailable (${cause}); refusing to adjudicate Stop`);
    }
  }
  return emitHookResult(invocation, result);
}

function cmdHook(values) {
  if (!EXPLICIT_PROFILES.includes(values.profile)) return error(`unsupported hook profile; expected ${EXPLICIT_PROFILES.join("|")}`);
  return dispatchHook(values.profile, values.mode ?? "nudge");
}

// One handler per OPTIONS verb; adding a verb means adding its OPTIONS entry
// and its row here.
const COMMANDS = {
  help: () => {
    process.stdout.write("note: --change-class is an audit declaration only; it does not independently raise a review gate\n");
    process.stdout.write(`note: claude can hard-block only in explicit --mode deny with a ${STOP_INLINE_CRITERION_SECONDS}s inline criterion budget; observe/nudge Stop is release-only on every profile\n`);
    process.stdout.write("note: long criteria use workloop verify --record for automatic policy or workloop achieve for explicit policy\n\n");
    return cmdHelp();
  },
  info: cmdInfo,
  hook: cmdHook,
  hooks: cmdHooks,
  audit: cmdAudit,
  ledger: cmdLedger,
  "sync-outcomes": cmdSyncOutcomes,
  "audit-outcomes": cmdAuditOutcomes,
  open: cmdOpen,
  status: cmdStatus,
  verify: cmdVerify,
  report: cmdReport,
  achieve: (values) => closeAttempt(repoOf(values), { explicit: true }),
  "accept-proof-gap": cmdAcceptProofGap,
  "not-needed": (values) => terminalCommand(values, "not-needed"),
  abandon: (values) => terminalCommand(values, "abandon"),
  suspend: cmdSuspend,
  resume: cmdResume,
  join: cmdJoin,
  review: cmdReview,
  amend: cmdAmend,
  "migrate-artifact-names": cmdMigrateArtifactNames,
  "archive-incompatible-state": cmdArchive,
  "current-open": cmdCurrentOpen,
  "current-status": (values) => cmdCurrentQuery(values, "status"),
  "current-audit": (values) => cmdCurrentQuery(values, "audit"),
  "current-ledger": (values) => cmdCurrentQuery(values, "ledger"),
  "current-tasks": (values) => cmdCurrentQuery(values, "tasks"),
  "current-hook": cmdCurrentHook,
};

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) return dispatchHook("unknown");
  const verb = ["--help", "-h"].includes(argv[0]) ? "help" : argv[0];
  if (!Object.hasOwn(OPTIONS, verb)) return error(`unknown command: ${verb}`);
  let values;
  try { ({ values } = parseArgs({ args: argv.slice(1), options: OPTIONS[verb], allowPositionals: false })); } catch (err) { return error(err.message); }
  try {
    return COMMANDS[verb](values);
  } catch (err) { return error(err?.message ?? err); }
}

export { main, recoverV3TaskSnapshot };
