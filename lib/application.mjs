// taskloop — the self-contained task-first loop system: own state dir
// (.taskloop/), own outcome ledger (~/.taskloop/). install.mjs distributes the
// runtime to ~/bin; consumer integrations own their PreToolUse/Stop wiring.
//
// Object model: the TASK is the durable unit (goal, criterion, alignment,
// envelope, budgets, evidence, reviews); EPISODES come and go underneath it.
// Budgets live on the task and are never refilled by starting a new episode.
// Success has exactly one path: a fresh green criterion. Suspension is a
// normal intermediate state; only a human closes a task any other way
// (abandon --reason, not-needed --evidence).
//
// Trust model: collaborative fail-open supervisor. The hard guarantee is
// narrow and stated: with a healthy environment and untouched state files,
// a red criterion cannot close a task as done. Nothing here resists a
// deliberately evasive agent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { STATE_DIR, TASK_FILE, DEFAULT_ROUNDS, CRITERION_TIMEOUT_SECONDS, VALID_SUSPEND_OUTCOMES, REVIEW_LEVELS, isPlainObject, fnv1aHex, outputTail, repoRelative } from "./prims.mjs";
import { runCriterion, runCriterionFile, criterionSensorMetadata, resolveCriterionFile, resolveCriterionSubject, criterionFileSensorMetadata, runTaskCriterion, warnCriterionSensor, criterionInputDrift } from "./criterion.mjs";
import { commandValues, gitOps, commandSafetyFailure, looksLikeWrite, writeFileTargets, insideEnvelope, joinedFileOffender, joinedFilesMessage, envelopeDirty, warnZeroMatchEnvelope, envelopeOverlap, siblingWorktreeOpenTasks } from "./supervision.mjs";
import { activeEpisode, episodeOwnership, spentTokens, touchedSummary, resumeBanner, createTask, transition } from "./task-engine.mjs";
import { taskPath, loadTask, saveTask, archiveTask, withTaskLock } from "./task-store.mjs";
import { appendOutcomeRow, readOutcomeText } from "./outcome-ledger.mjs";
import { clearUntracked, observeUntracked } from "./untracked.mjs";

function utcNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function home() {
  return path.resolve(process.env.USERPROFILE || process.env.HOME || os.homedir());
}

function appendLedger(repo, task, extra = {}) {
  const row = {
      ts: utcNow(),
      repo: String(repo),
      id: task.id ?? null,
      state: task.state,
      goal: task.goal ?? null,
      criterion: task.criterion ?? null,
      rounds: task.spent?.rounds ?? 0,
      writes: task.evidence?.writes ?? 0,
      episodes: Array.isArray(task.episodes) ? task.episodes.length : 0,
      criterion_input_drift: Boolean(task.evidence?.criterion_input_drift),
      criterion_subject: Array.isArray(task.criterion_subject) ? task.criterion_subject.length : 0,
      criterion_subject_changed: Boolean(task.evidence?.criterion_subject_changed),
      // earn_red rides only tasks that opened without a birth red; a birth-red or
      // keep-green task omits it (and pre-schema rows never carry it), so audit's
      // earn-red distribution counts only genuine earn-red tasks.
      ...(task.earn_red === true ? { earn_red: true, red_witnessed: Boolean(task.red_witnessed) } : {}),
      criterion_input_coverage: task.criterion_input_coverage ?? "unknown",
      criterion_provenance: task.criterion_provenance ?? "unresolved",
      review_level: strongestReviewLevel(task),
      self_granted: (Array.isArray(task.grants) ? task.grants : []).filter((g) => g?.granted_by === "self").length,
      // Only stamp kind when the task actually carries one. A pre-schema task has
      // no kind; fabricating "task" here would let audit's explicit-kind trust
      // misread an old scratchpad probe as real. No kind → audit falls back to
      // the heuristic, which is the honest classification for a pre-schema row.
      ...(task.kind === "probe" || task.kind === "task" ? { kind: task.kind } : {}),
      // Same fidelity rule as kind: opened_dirty is a birth snapshot, so a task
      // opened before the field existed has no honest value — omit rather than
      // fabricate a "confirmed clean" false.
      ...(typeof task.opened_dirty === "boolean" ? { opened_dirty: task.opened_dirty } : {}),
      provisional: Boolean(task.provisional),
      output_tokens_estimate: spentTokens(task),
      // Each complete transcript line is counted once per persistent transcript
      // identity. The regex estimate still depends on the runtime's usage schema
      // and is not task-attributed, but session switches no longer replay tails.
      output_tokens_scope: "transcript-complete-lines-once-per-identity; regex estimate; not task-attributed",
    ...extra,
  };
  appendOutcomeRow(row);
}

function cliError(message) {
  process.stderr.write(message + "\n");
  return 2;
}

// ---------- application orchestration ----------

function loadStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tallyEpisodeTokens(task, payload) {
  const transcriptPath = String(payload?.transcript_path ?? "").trim();
  if (!transcriptPath) return;
  const episode = activeEpisode(task);
  if (!episode) return;
  try {
    let transcript;
    try {
      transcript = fs.realpathSync.native(transcriptPath);
    } catch {
      transcript = path.resolve(transcriptPath);
    }
    if (!isPlainObject(task.transcript_cursors)) task.transcript_cursors = {};
    if (!isPlainObject(task.transcript_cursors[transcript])) {
      let inheritedOffset = 0;
      for (const previous of Array.isArray(task.episodes) ? task.episodes : []) {
        if (previous?.transcript === transcript && Number.isFinite(previous.transcript_offset)) {
          inheritedOffset = Math.max(inheritedOffset, previous.transcript_offset);
        }
      }
      task.transcript_cursors[transcript] = { offset: inheritedOffset };
    }
    const cursor = task.transcript_cursors[transcript];
    episode.transcript = transcript;
    episode.output_tokens = episode.output_tokens ?? 0;
    const size = fs.statSync(transcript).size;
    if (size < cursor.offset) cursor.offset = 0; // transcript rotated or truncated
    if (size <= cursor.offset) return;
    const fd = fs.openSync(transcript, "r");
    let tail;
    try {
      const buf = Buffer.alloc(size - cursor.offset);
      fs.readSync(fd, buf, 0, buf.length, cursor.offset);
      tail = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    // Only count up to the last complete line; a partially flushed line is
    // left for the next tally instead of being skipped past.
    const lastNewline = tail.lastIndexOf("\n");
    if (lastNewline < 0) return;
    const complete = tail.slice(0, lastNewline + 1);
    let sum = 0;
    for (const m of complete.matchAll(/"output_tokens"\s*:\s*(\d+)/g)) sum += Number.parseInt(m[1], 10) || 0;
    episode.output_tokens = (episode.output_tokens ?? 0) + sum;
    cursor.offset += lastNewline + 1;
    cursor.updated_at = utcNow();
    episode.transcript_offset = cursor.offset;
  } catch {
    /* telemetry: degrade, never trap */
  }
}

function deny(message) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    }) + "\n",
  );
  process.stderr.write(message + "\n");
  return 0;
}

function block(message) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: message }) + "\n");
  process.stderr.write(message + "\n");
  return 2;
}

// P0: cross-session episode attribution. Write isolation is physically
// worktree-level, but turn adjudication is a per-session question. Recency of
// the owner's lease stands in for liveness (the only signal available without a
// session-liveness oracle); the TTL is the concurrency window, env-tunable.
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
function resolveLeaseTtlMs() {
  const raw = Number.parseInt(process.env.TASKLOOP_LEASE_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_TTL_MS;
}

// A foreign session sharing the worktree while the owner's episode is live is a
// bystander: its stop must not adjudicate, and its writes are not governed by
// the owner's envelope. Name the contention and point at the fix. Advisory only,
// fail-open — taskloop is a collaborative supervisor, not a sandbox.
function bystanderNote(owner, sink = process.stderr) {
  sink.write(
    `taskloop: another live session (${owner ?? "unknown"}) owns this worktree's active task — ` +
      "you are a bystander, not its driver. This is single-writer-per-worktree contention. " +
      "Use a separate git worktree, or have the owning session suspend the task before takeover.\n",
  );
}

// A suspended task is paused: no hook creates, refreshes, detaches, or transfers
// an episode until an explicit resume. This runs at dispatch, before ownership
// or begin-episode, so neither the owner nor a foreign session can mutate a
// paused task's episode list (a user-suspend closes the episode, and the
// "no active episode → owner" default would otherwise let the next hook drive
// or close it). Reads/verification stay free; writes are denied; a stop is
// released without adjudication. Returns a hook exit code, or null to continue.
function suspendedHookOutcome(event, payload, repo, currentTask) {
  if (!isPlainObject(currentTask.suspension)) return null;
  const outcome = currentTask.suspension.outcome ?? "unknown";
  if (event === "stop") {
    process.stderr.write(
      `taskloop: task is suspended (${outcome}); stop released — resume to continue. ` +
        "A paused task is not adjudicated or closed by a stop.\n",
    );
    return 0;
  }
  if (event === "pretooluse") {
    const mapping = isPlainObject(payload.tool_input) ? payload.tool_input : {};
    const writeShaped = gitOps(mapping).length > 0 || looksLikeWrite(String(payload.tool_name ?? ""), mapping);
    if (!writeShaped) return 0; // reads and verification stay free
    return deny(
      `taskloop: task is suspended (${outcome}); reads and verification remain free. ` +
        `Resume only after the blocker changes: node "${process.argv[1] ?? "taskloop.mjs"}" resume --repo "${repo}" --reason "<what changed>"`,
    );
  }
  return null;
}

// ---------- verbs ----------

const CLI_OPTIONS = {
  open: {
    repo: { type: "string" },
    goal: { type: "string" },
    criterion: { type: "string" },
    "criterion-file": { type: "string" },
    "criterion-protocol": { type: "string", default: "binary" },
    "criterion-subject": { type: "string", multiple: true },
    alignment: { type: "string" },
    progress: { type: "string" },
    files: { type: "string", multiple: true },
    tables: { type: "string", multiple: true },
    interfaces: { type: "string", multiple: true },
    "git-allowed": { type: "string", multiple: true },
    "git-reason": { type: "string" },
    rounds: { type: "string", default: String(DEFAULT_ROUNDS) },
    writes: { type: "string", default: "0" },
    "wall-clock-minutes": { type: "string", default: "0" },
    "token-budget": { type: "string", default: "0" },
    "criterion-timeout-seconds": { type: "string", default: String(CRITERION_TIMEOUT_SECONDS) },
    "destructive-allowed": { type: "boolean", default: false },
    "network-allowed": { type: "boolean", default: false },
    "install-scripts-allowed": { type: "boolean", default: false },
    "keep-green": { type: "boolean", default: false },
    "earn-red": { type: "boolean", default: false },
    "granted-by": { type: "string", default: "self" },
    reason: { type: "string" },
    probe: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
  status: { repo: { type: "string" } },
  verify: { repo: { type: "string" } },
  amend: {
    repo: { type: "string" },
    goal: { type: "string" },
    criterion: { type: "string" },
    "criterion-file": { type: "string" },
    "criterion-protocol": { type: "string" },
    "criterion-subject": { type: "string", multiple: true },
    files: { type: "string", multiple: true },
    rounds: { type: "string" },
    "criterion-timeout-seconds": { type: "string" },
    "git-allowed": { type: "string", multiple: true },
    "git-reason": { type: "string" },
    reason: { type: "string" },
    "granted-by": { type: "string", default: "self" },
  },
  suspend: {
    repo: { type: "string" },
    outcome: { type: "string", default: "needs_input" },
    judgment: { type: "string" },
  },
  resume: { repo: { type: "string" }, reason: { type: "string" } },
  done: { repo: { type: "string" }, provisional: { type: "boolean", default: false } },
  abandon: { repo: { type: "string" }, reason: { type: "string" } },
  "not-needed": { repo: { type: "string" }, evidence: { type: "string" } },
  review: {
    repo: { type: "string" },
    level: { type: "string" },
    reviewer: { type: "string" },
    findings: { type: "string" },
  },
  hooks: { repo: { type: "string" } },
  info: {},
  audit: { since: { type: "string" } },
};

function repoFromArg(value) {
  const raw = String(value ?? process.cwd()).trim() || process.cwd();
  const expanded = raw.startsWith("~") ? path.join(home(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

// Authority expansions are grants with provenance. The machine cannot verify
// the judgment behind an expansion — it can only record who made it, so the
// ledger shows how much of a task's authority was self-declared. A grant is a
// record, never a gate.
const GRANT_PROVENANCES = new Set(["self", "user"]);
const CRITERION_PROTOCOLS = new Set(["binary", "tri-state"]);
const WHOLE_REPO_GLOB = /^(\*\*(\/\*)?)$/;

// Explicit inputs, not the raw CLI `values` bag: flag names belong to the
// parser layer, and callers granting only one kind (amend adds files OR git
// ops) should not have to fabricate a values object to satisfy the rest.
function collectGrants({ grantedBy, flags = null, gitOps = [], gitReason = null, files = [], fileReason = null, subjects = [], subjectReason = null, sink = process.stderr }) {
  const grants = [];
  const at = utcNow();
  const push = (scope, reason = null, details = {}) => grants.push({ at, scope, granted_by: grantedBy, reason, ...details });
  if (flags?.destructive) push("destructive");
  if (flags?.network) push("network");
  if (flags?.installScripts) push("install-scripts");
  for (const op of gitOps.map((o) => String(o).toLowerCase())) {
    push(`git:${op}`, String(gitReason ?? "").trim() || null);
  }
  for (const subject of subjects) {
    push("criterion-subject", String(subjectReason ?? "").trim() || null, { path: String(subject) });
  }
  for (const glob of files) {
    const pattern = String(glob).trim();
    push("envelope", String(fileReason ?? "").trim() || null, { pattern });
    if (WHOLE_REPO_GLOB.test(pattern) && grantedBy === "self") {
      sink.write(
        `warning: whole-repo envelope "${pattern}" is self-granted breadth — ` +
          "prefer the narrowest globs, or record --granted-by user when the human granted it\n",
      );
    }
  }
  return grants;
}

// Advisory, fail-open: warn when the envelope overlaps an open task in a sibling
// worktree, so the merge conflict surfaces at open/amend instead of at merge.
// Never gates; any failure (not a git repo, single worktree, unreadable sibling)
// degrades to silence, like envelopeDirty.
function warnSiblingEnvelopeOverlap(repo, newFiles, sink = process.stderr) {
  try {
    for (const sibling of siblingWorktreeOpenTasks(repo)) {
      const overlap = envelopeOverlap(newFiles, sibling.files, repo, sibling.path);
      if (!overlap) continue;
      const goal = sibling.goal ? ` — "${sibling.goal.slice(0, 60)}"` : "";
      // Staleness context, not a verdict: opened-when and paused-or-not, so the
      // human can judge whether that sibling is live or an abandoned leftover.
      const context = [
        sibling.opened_at ? `opened ${sibling.opened_at}` : null,
        sibling.suspended ? `suspended: ${sibling.suspended}` : null,
      ].filter(Boolean);
      const contextLine = context.length ? ` (${context.join("; ")})` : "";
      sink.write(
        `warning: this envelope ${overlap.level === "definite" ? "overlaps" : "may overlap"} an open task in a ` +
          "sibling worktree, so a later merge can conflict:\n" +
          `  · ${sibling.path}${goal}${contextLine}\n` +
          `  · ${overlap.level} overlap on: ${overlap.patterns.join(", ")}\n` +
          "  re-scope to disjoint files, or coordinate the integration.\n",
      );
    }
  } catch {
    /* advisory only: a failed sibling scan is silent, never a gate */
  }
}

// A declared work subject exempts a criterion input from drift refusal — a
// trust exception, so envelope membership is a necessary condition, not a
// sufficient one (the withdrawn auto-classifier made it sufficient, and that
// conflated write permission with proof exemption). Validate each declaration
// precisely: exact repo-relative file, inside the envelope, never the checker
// itself. Returns { subjects, error } — a non-null error is a cliError code.
// The caller has already resolved criterionFile (or null for a command form).
function resolveCriterionSubjects(repo, raw, envelopeFiles, criterionFile) {
  const declared = (raw ?? []).map(String).map((s) => s.trim()).filter(Boolean);
  const subjects = [];
  const seen = new Set();
  for (const value of declared) {
    let rel;
    try {
      rel = resolveCriterionSubject(repo, value);
    } catch (err) {
      return { subjects: null, error: cliError(err?.message ?? String(err)) };
    }
    if (criterionFile && rel === criterionFile) {
      return {
        subjects: null,
        error: cliError(
          `--criterion-subject cannot name the criterion file itself (${rel}): the checker is a sensor, ` +
            "not a work subject — move a legitimately changed checker with amend --criterion --reason",
        ),
      };
    }
    if (!insideEnvelope(rel, envelopeFiles)) {
      return {
        subjects: null,
        error: cliError(
          `--criterion-subject ${rel} is outside the envelope — declare it in --files first; ` +
            "a work subject the task cannot write is not coherent",
        ),
      };
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    subjects.push(rel);
  }
  return { subjects, error: null };
}

// Advisory only: a declared subject that no current criterion input references
// exempts nothing, so say so rather than let it read as active protection.
function warnInertCriterionSubjects(task, subjects, sink = process.stderr) {
  const inputs = new Set((Array.isArray(task.criterion_inputs) ? task.criterion_inputs : []).map((e) => String(e?.path ?? "")));
  const inert = subjects.filter((s) => !inputs.has(s));
  if (inert.length) {
    sink.write(
      `note: declared work subject(s) not among the criterion's fingerprinted inputs: ${inert.join(", ")} — ` +
        "the exemption is inert until the criterion actually reads them\n",
    );
  }
}

function cmdOpen(values) {
  const repo = repoFromArg(values.repo);
  for (const [flag, label] of [
    ["goal", "--goal"],
    ["alignment", "--alignment"],
  ]) {
    if (!String(values[flag] ?? "").trim()) {
      return cliError(
        `${label} is required` +
          (flag === "alignment"
            ? ': "green ⇒ goal because <what the check exercises>; not covered: <gaps>"'
            : ""),
      );
    }
  }
  const criterionCommand = String(values.criterion ?? "").trim();
  const criterionFileRaw = String(values["criterion-file"] ?? "").trim();
  const criterionProtocol = String(values["criterion-protocol"] ?? "binary").trim();
  if (!CRITERION_PROTOCOLS.has(criterionProtocol)) {
    return cliError('--criterion-protocol must be "binary" or "tri-state"');
  }
  if (Boolean(criterionCommand) === Boolean(criterionFileRaw)) {
    return cliError("exactly one of --criterion or --criterion-file is required");
  }
  let criterionFile = null;
  if (criterionFileRaw) {
    try {
      criterionFile = resolveCriterionFile(repo, criterionFileRaw);
    } catch (err) {
      return cliError(err?.message ?? String(err));
    }
  }
  const files = (values.files ?? []).map(String).filter(Boolean);
  if (!files.length) return cliError("--files is required: the envelope needs at least one glob");
  const openJoinedOffender = joinedFileOffender(files);
  if (openJoinedOffender) return cliError(joinedFilesMessage(openJoinedOffender));
  if ((values["git-allowed"] ?? []).length && !String(values["git-reason"] ?? "").trim()) {
    return cliError("--git-reason is required when --git-allowed is used");
  }
  if (values["keep-green"] && !String(values.reason ?? "").trim()) {
    return cliError("--keep-green requires --reason <why a green start is intentional>");
  }
  const earnRed = Boolean(values["earn-red"]);
  if (earnRed && values["keep-green"]) {
    return cliError(
      "--earn-red and --keep-green are contradictory: keep-green expects a green steady state, " +
        "earn-red expects a red still to be written",
    );
  }
  if (earnRed && !String(values.reason ?? "").trim()) {
    return cliError("--earn-red requires --reason <why the failing check does not exist yet>");
  }
  const grantedBy = String(values["granted-by"] ?? "self").trim() || "self";
  if (!GRANT_PROVENANCES.has(grantedBy)) {
    return cliError('--granted-by must be "self" or "user" — provenance is recorded as stated, never invented');
  }
  const { subjects: criterionSubjects, error: subjectError } = resolveCriterionSubjects(
    repo,
    values["criterion-subject"],
    files,
    criterionFile,
  );
  if (subjectError !== null) return subjectError;
  const existing = loadTask(repo);
  if (existing && existing.state === "open" && !values.force) {
    return cliError(
      `${taskPath(repo)} already holds an open task; suspend/done/abandon it, or --force to archive and replace`,
    );
  }
  const criterion = criterionFile ? `criterion-file:${criterionFile}` : criterionCommand;
  const timeoutSec = Number.parseInt(String(values["criterion-timeout-seconds"]), 10) || CRITERION_TIMEOUT_SECONDS;
  // Snapshot dirtiness BEFORE running the criterion: a birth criterion that
  // writes under the envelope (a snapshot/check script) must not read back as
  // "already dirty when the task opened". This distinguishes pre-existing edits
  // from the criterion dirtying the tree during open.
  const openedDirty = envelopeDirty(repo, files);
  const verdict = criterionFile
    ? runCriterionFile(criterionFile, repo, timeoutSec, criterionProtocol)
    : runCriterion(criterion, repo, timeoutSec, criterionProtocol);
  if (verdict.verdict === "not_executable") {
    process.stderr.write(
      `open refused: the machine cannot execute the criterion (${verdict.detail}): ${criterion}\n` +
        "a criterion the machine cannot run leaves the task gateless; fix the command and retry\n",
    );
    return 1;
  }
  if (verdict.verdict === "indeterminate") {
    process.stderr.write(
      `open refused: the criterion could not adjudicate (${verdict.detail}): ${criterion}\n` +
        "regenerate or repair its evidence before opening a gated task\n",
    );
    return 1;
  }
  if (verdict.verdict === "pass" && !values["keep-green"] && !earnRed) {
    process.stderr.write(
      `open refused: the criterion is already green: ${criterion}\n` +
        "red is earned at birth — an already-green criterion cannot prove this task. " +
        "Fix the criterion, pass --earn-red --reason to earn the red later (the close stays " +
        "barred until one red is witnessed), or --keep-green --reason for a regression-guard task.\n",
    );
    return 1;
  }
  // Commit under the task lock, re-loading the current task inside it so a
  // concurrent hook or verb save is not clobbered by this open (nor this open by
  // them). The criterion checks above ran unlocked; the existing-task recheck,
  // archive, and save below are atomic under the lock. The outer pre-check
  // (already-open refusal) still short-circuits the common case before the lock.
  try {
    return withTaskLock(repo, () => {
      const current = loadTask(repo);
      if (current && current.state === "open" && !values.force) {
        return cliError(
          `${taskPath(repo)} already holds an open task; suspend/done/abandon it, or --force to archive and replace`,
        );
      }
      if (current) {
        try {
          archiveTask(repo, current, utcNow());
        } catch (err) {
          process.stderr.write(
            `open refused: cannot archive the current task before replacement (${err?.message ?? err}); ` +
              "the existing task remains current\n",
          );
          return 1;
        }
      }

  const task = createTask({
    idTime: utcNow(),
    openedAt: utcNow(),
    entropy: process.hrtime.bigint(),
    goal: String(values.goal).trim(),
    criterion,
    criterionFile,
    criterionSubject: criterionSubjects,
    sensor: criterionFile
      ? criterionFileSensorMetadata(criterionFile, repo)
      : criterionSensorMetadata(criterion, repo),
    timeoutSeconds: timeoutSec,
    criterionProtocol,
    keepGreen: Boolean(values["keep-green"]),
    earnRed,
    redWitnessedAtOpen: verdict.verdict === "fail",
    kind: values.probe ? "probe" : "task",
    openedDirty,
    alignment: String(values.alignment).trim(),
    progress: String(values.progress ?? "").trim() || null,
    envelope: {
      files,
      tables: (values.tables ?? []).map(String),
      interfaces: (values.interfaces ?? []).map(String),
      git: {
        allowed_ops: (values["git-allowed"] ?? []).map((op) => String(op).toLowerCase()),
        reason: String(values["git-reason"] ?? "").trim(),
      },
      destructive_allowed: Boolean(values["destructive-allowed"]),
      network_allowed: Boolean(values["network-allowed"]),
      install_scripts_allowed: Boolean(values["install-scripts-allowed"]),
    },
    budget: {
      rounds: Number.parseInt(String(values.rounds), 10) || DEFAULT_ROUNDS,
      writes: Number.parseInt(String(values.writes), 10) || 0,
      wall_clock_minutes: Number.parseInt(String(values["wall-clock-minutes"]), 10) || 0,
      tokens: Number.parseInt(String(values["token-budget"]), 10) || 0,
    },
    grants: collectGrants({
      grantedBy,
      flags: {
        destructive: Boolean(values["destructive-allowed"]),
        network: Boolean(values["network-allowed"]),
        installScripts: Boolean(values["install-scripts-allowed"]),
      },
      gitOps: values["git-allowed"] ?? [],
      gitReason: values["git-reason"],
      files,
      fileReason: String(values.reason ?? "").trim() || "task opened",
      subjects: criterionSubjects,
      subjectReason: String(values.reason ?? "").trim() || "work subject declared at open",
    }),
  });
  warnZeroMatchEnvelope(repo, files);
  warnSiblingEnvelopeOverlap(repo, files);
  if (criterionSubjects.length) warnInertCriterionSubjects(task, criterionSubjects);
  saveTask(repo, task);
  appendLedger(repo, task);
  clearUntracked(repo); // the task absorbs the untracked slate
  warnCriterionSensor(task);
  if (task.criterion_provenance === "state-dir") {
    process.stderr.write(
      "criterion provenance: state-dir — a session-authored checker guards this task. " +
        "If the true criterion is blocked, suspend --outcome needs_input or name the degradation in --alignment; " +
        "the flag rides the ledger and the close will ask for an independent review.\n",
    );
  }
  if (task.earn_red === true && task.red_witnessed !== true) {
    process.stderr.write(
      "earn-red: opened without a birth red — the close stays barred until this criterion is witnessed red once " +
        "(write the failing check first). A never-red task runs out of budget rather than closing green.\n",
    );
  }
  process.stdout.write(`opened ${taskPath(repo)} (budget: ${task.budget.rounds} rounds)\n`);
      return 0;
    });
  } catch (err) {
    if (err?.code === "TASKLOCK_TIMEOUT") return cliError(err.message);
    const refusal = stateWriteRefusal(err);
    if (refusal) return cliError(refusal);
    throw err;
  }
}

function requireOpenTask(repo) {
  const task = loadTask(repo);
  if (!task) {
    process.stderr.write(`${taskPath(repo)} does not exist; open a task first\n`);
    return null;
  }
  if (task.state !== "open") {
    process.stderr.write(`${taskPath(repo)} is already ${task.state}; open a new task\n`);
    return null;
  }
  return task;
}

// A workspace that cannot host task state (observed live: the Codex read-only
// sandbox tier) surfaces as an errno on the state-dir or lock mkdir. Name the
// condition in one line instead of letting a raw stack escape the verb — the
// task state is untouched either way, so the refusal is safe to keep terse.
const STATE_WRITE_ERRNOS = new Set(["EPERM", "EACCES", "EROFS", "ENOSPC"]);

function stateWriteRefusal(err) {
  if (!STATE_WRITE_ERRNOS.has(err?.code)) return null;
  return (
    `taskloop: cannot write task state (${err.code}: ${err.syscall ?? "fs"} ${err.path ?? "(unknown path)"}) — ` +
    "the workspace refused the write (read-only sandbox tier, permissions, or full disk); " +
    "grant write access (e.g. workspace-write) and retry"
  );
}

// Run a task-mutating verb under the same cross-process lock the hooks take, and
// re-load the task inside it, so a CLI verb serializes with concurrent hooks
// instead of clobbering their load-transition-save. A lock timeout fails closed
// as a clean CLI error, never a partial unlocked mutation. Each verb's argument
// validation runs inside the callback (under the lock) — it is short, and this
// keeps the prior "no open task precedes bad-argument" ordering unchanged.
function withOpenTaskLocked(repo, fn) {
  try {
    return withTaskLock(repo, () => {
      const task = requireOpenTask(repo);
      if (!task) return 1;
      return fn(task);
    });
  } catch (err) {
    if (err?.code === "TASKLOCK_TIMEOUT") return cliError(err.message);
    const refusal = stateWriteRefusal(err);
    if (refusal) return cliError(refusal);
    throw err;
  }
}

// A green whose check files changed since fingerprinting is a moved sensor,
// not a proof: both close doors refuse it. The gate is machine-observable and
// the blessed path is cheap — amend --criterion --reason re-fingerprints and
// records why the check legitimately moved. The evidence flag stays true for
// the ledger: the drift event is history even after the re-bless.
function warnInputDrift(drift, subjectChanged = [], sink = process.stderr) {
  if (drift.length) {
    sink.write(
      `criterion input files changed since they were fingerprinted: ${drift.join(", ")} — ` +
        "the sensor itself moved, so this green cannot close the task. " +
        "Re-bless the move: amend --criterion/--criterion-file --reason <why the check legitimately changed>, then close.\n" +
        (subjectChanged.length
          ? `  (a declared work subject also changed and is exempt: ${subjectChanged.join(", ")} — ` +
            "the refusal is only about the sensor files above)\n"
          : ""),
    );
  }
}

// A declared work subject changed and closed the task without a drift refusal.
// Echo it — with whether each change was machine-witnessed — so the exercised
// trust exception is visible at the moment of acceptance, not buried in state.
function warnSubjectExemption(task, sink = process.stderr) {
  const changes = Array.isArray(task.evidence?.criterion_subject_changes) ? task.evidence.criterion_subject_changes : [];
  if (!changes.length) return;
  const lines = changes.map(
    (c) => `  · ${c.path} — ${c.witnessed ? "machine-witnessed write" : "not machine-witnessed"}`,
  );
  sink.write(
    "declared work subject changed (drift exemption exercised — a machine check on the subject's fingerprint " +
      "was waived, not the goal):\n" +
      lines.join("\n") +
      "\n",
  );
}

// A green criterion is a machine check passing, not the goal being met. At the
// exact moment of acceptance, surface what the check does NOT prove — the
// alignment's own "not covered:" clause and any less-than-full input coverage —
// so the human accepting the close sees the gap instead of reading green as
// done. This changes no gate: it only re-shows declarations already on the task.
function warnCloseAcceptance(task, sink = process.stderr) {
  const alignment = String(task.alignment ?? "").trim();
  const coverage = String(task.criterion_input_coverage ?? "unknown");
  const parts = [];
  const notCovered = alignment.match(/not covered:\s*(.+)$/is);
  if (notCovered) parts.push(`not covered by the criterion: ${notCovered[1].trim()}`);
  else if (alignment) parts.push(`alignment: ${alignment}`);
  if (coverage !== "full") {
    parts.push(`criterion input coverage: ${coverage} — the fingerprint does not span the whole check`);
  }
  if (!parts.length) return;
  sink.write(
    "criterion green — a machine check passed, not the goal itself. Confirm it covers the goal:\n" +
      parts.map((p) => `  · ${p}`).join("\n") +
      "\n",
  );
}

// Honest close-time reconciliation, advisory only — never a gate. Two set
// differences over the declared envelope patterns:
//   · declared write-areas with no machine-witnessed write — a hint that a
//     declared piece of work may not have happened (but the envelope is a write
//     boundary, not a task checklist, and write-attribution is incomplete, so a
//     deletion or an un-attributed edit reads the same as "untouched").
//   · declared areas the criterion does not attribute to any of its inputs —
//     the check does not look there. Only meaningful once input coverage is
//     known: with unknown coverage the criterion has no attributed inputs at
//     all, so this dimension is suppressed rather than flag everything.
function warnCloseTriangle(task, sink = process.stderr) {
  const patterns = Array.isArray(task.envelope?.files) ? task.envelope.files : [];
  if (!patterns.length) return;
  const touched = Array.isArray(task.evidence?.touched_files) ? task.evidence.touched_files : [];
  const inputs = (Array.isArray(task.criterion_inputs) ? task.criterion_inputs : []).map((e) => String(e?.path ?? ""));
  const coverage = String(task.criterion_input_coverage ?? "unknown");
  const lines = [];
  const untouched = patterns.filter((p) => !touched.some((f) => insideEnvelope(f, [p])));
  if (untouched.length) {
    lines.push(`declared but not machine-witnessed as written: ${untouched.join(", ")}`);
  }
  if (coverage !== "unknown") {
    const unattributed = patterns.filter((p) => !inputs.some((i) => insideEnvelope(i, [p])));
    if (unattributed.length) {
      lines.push(`declared but not attributed to any criterion input: ${unattributed.join(", ")}`);
    }
  }
  if (!lines.length) return;
  sink.write(
    "envelope reconciliation (advisory telemetry, not a gate — a write boundary is not a task " +
      "checklist and write-attribution is incomplete):\n" +
      lines.map((l) => `  · ${l}`).join("\n") +
      "\n",
  );
}

// A provisional weak close remains auditable even though it bypasses the
// fresh-context gate; say that downgrade at the exact close point.
function remindUnreviewedSelfCheck(task, sink = process.stderr) {
  if (task.criterion_provenance !== "state-dir") return;
  if ((Array.isArray(task.reviews) ? task.reviews : []).length > 0) return;
  sink.write(
    "note: this green came from a session-authored checker and no independent review is recorded " +
      "(review --level second-model|fresh-context) — closing anyway; provenance rides the ledger.\n",
  );
}

function cmdDone(values) {
  const repo = repoFromArg(values.repo);
  return withOpenTaskLocked(repo, (task) => {
  const verdict = runTaskCriterion(task, repo);
  if (verdict.verdict === "fail") {
    // Metered like a blocked stop: a refused done burns a round, so retrying
    // `done` against a flaky criterion cannot fish for a false green for free.
    const tail = outputTail(verdict.output);
    task = transition(task, {
      type: "done-failure",
      at: utcNow(),
      verdict,
      signature: fnv1aHex(`${verdict.exit}|${tail}`),
    }).task;
    saveTask(repo, task);
    const overBudget = task.spent.rounds >= task.budget.rounds;
    process.stderr.write(
      `done refused: the criterion is red (round ${task.spent.rounds}/${task.budget.rounds}): ${task.criterion}\n` +
        (tail ? `--- criterion output (tail) ---\n${tail}\n` : "") +
        (overBudget
          ? "round budget spent — suspend --judgment or amend --rounds --reason; do not retry done.\n"
          : "there is no claim-based success; fix the work, amend the criterion with a reason, " +
            "or suspend/abandon honestly.\n"),
    );
    return 1;
  }
  if (verdict.verdict === "not_executable") {
    process.stderr.write(
      `done refused: the machine cannot execute the criterion (${verdict.detail}); ` +
        "amend the criterion so green is provable, or abandon --reason.\n",
    );
    return 1;
  }
  if (verdict.verdict === "indeterminate") {
    const tail = outputTail(verdict.output);
    process.stderr.write(
      `done refused: ${verdict.detail}; regenerate or repair the external evidence, then verify again. ` +
        "This did not burn a round.\n" +
        (tail ? `--- criterion output (tail) ---\n${tail}\n` : ""),
    );
    return 1;
  }
  const adjudication = adjudicateGreen(repo, task, Boolean(values.provisional));
  task = adjudication.task;
  if (adjudication.outcome === "drift") {
    process.stderr.write("done refused: drift green — see above for the amend --criterion --reason path.\n");
    return 1;
  }
  if (adjudication.outcome === "unearned") {
    process.stderr.write(`done refused: ${unearnedCloseMessage()}\n`);
    return 1;
  }
  if (adjudication.outcome === "weak") {
    process.stderr.write(`done refused: ${weakCloseMessage(task)}\n`);
    return 1;
  }
  process.stdout.write(
    `done: criterion green (${adjudication.spent}${values.provisional ? ", provisional" : ""})\n`,
  );
  return 0;
  });
}

function cmdSuspend(values) {
  const repo = repoFromArg(values.repo);
  return withOpenTaskLocked(repo, (task) => {
  const outcome = String(values.outcome ?? "needs_input").trim();
  if (!VALID_SUSPEND_OUTCOMES.has(outcome)) {
    return cliError(`--outcome must be one of ${[...VALID_SUSPEND_OUTCOMES].sort().join(", ")}`);
  }
  const judgment = String(values.judgment ?? "").trim();
  if (!judgment) {
    return cliError(
      '--judgment is required: "<remaining criterion; current failure; next safe action>" ' +
        "(changed files are machine-observed)",
    );
  }
  task = transition(task, { type: "suspend", at: utcNow(), outcome, source: "user", judgment }).task;
  saveTask(repo, task);
  appendLedger(repo, task, { state: "suspended", suspension_outcome: outcome, suspension_source: "user" });
  process.stdout.write(
    `suspended (${outcome}); machine-observed changed files ${touchedSummary(task)}; task stays open. ` +
      "If direction changed, amend --goal and/or --criterion with --reason before resume.\n",
  );
  return 0;
  });
}

function cmdResume(values) {
  const repo = repoFromArg(values.repo);
  return withOpenTaskLocked(repo, (task) => {
  const reason = String(values.reason ?? "").trim();
  if (!reason) return cliError("--reason is required: resuming a sticky suspension must say what changed");
  if (!isPlainObject(task.suspension)) return cliError("task is not suspended");
  const previous = task.suspension;
  task = transition(task, { type: "resume", at: utcNow(), reason }).task;
  saveTask(repo, task);
  appendLedger(repo, task, { state: "resumed", reason, previous_outcome: previous.outcome ?? null });
  process.stdout.write(`resumed; current goal: ${task.goal}\n`);
  return 0;
  });
}

function cmdAbandon(values) {
  const repo = repoFromArg(values.repo);
  return withOpenTaskLocked(repo, (task) => {
  const reason = String(values.reason ?? "").trim();
  if (!reason) return cliError("--reason is required: an abandoned task must say why");
  task = transition(task, { type: "terminal", at: utcNow(), state: "abandoned", episodeOutcome: "detached", reason }).task;
  saveTask(repo, task);
  appendLedger(repo, task, { reason });
  process.stdout.write("abandoned; recorded in the outcome ledger\n");
  return 0;
  });
}

function cmdNotNeeded(values) {
  const repo = repoFromArg(values.repo);
  return withOpenTaskLocked(repo, (task) => {
  const evidence = String(values.evidence ?? "").trim();
  if (!evidence) {
    return cliError("--evidence is required: name the read-only check that showed no work is needed");
  }
  task = transition(task, { type: "terminal", at: utcNow(), state: "not_needed", episodeOutcome: "green", reason: evidence }).task;
  saveTask(repo, task);
  appendLedger(repo, task, { evidence });
  process.stdout.write("closed as not-needed; recorded in the outcome ledger\n");
  return 0;
  });
}

// Record that an independent perspective reviewed this task, at what
// independence level. The finding itself is fed back into the loop body (the
// agent reads it and fixes or rebuts) — this only records the provenance so the
// ledger shows how independently a task was checked before it closed.
// Caveat: this is the strongest level EVER recorded, not tied to the closed
// state — a high-level review of an early state followed by more edits still
// stamps that level, so it can slightly overstate the independence of what
// actually closed. A coarse meta-loop correlation signal, not a proof.
function strongestReviewLevel(task) {
  const reviews = Array.isArray(task.reviews) ? task.reviews : [];
  let best = -1;
  for (const r of reviews) {
    const i = REVIEW_LEVELS.indexOf(String(r?.level ?? ""));
    if (i > best) best = i;
  }
  return best >= 0 ? REVIEW_LEVELS[best] : "none";
}

// The weak-close gate: a state-dir (session-authored) criterion is the author
// grading their own exam. Green alone must not close it — require at least a
// fresh-context review, or an explicit --provisional that rides the ledger so
// the soft close stays auditable. A repo-owned criterion is not author-graded
// and never trips this.
// Only reviews of the CURRENT criterion count toward the gate. A review is of a
// specific check state; once `amend --criterion` changes the check, the prior
// review no longer vouches for what will close, so the gate must ignore it. A
// pre-hash review (no stamped criterion_hash) is treated as not-current.
function weakCloseMessage(task) {
  const reason =
    task.criterion_provenance === "unresolved"
      ? "unresolved criterion inputs"
      : "state-dir criterion authored in the task's private state";
  return (
    `${reason} with no fresh-context review — this weak sensor cannot close on its own signal.\n` +
    "Add `review --level fresh-context|second-model`, or `done --provisional` to close as provisional (rides the ledger)."
  );
}

// An earn-red task opened without a birth red; its criterion has never been
// witnessed telling done from not-done. Green here proves nothing until a red
// is seen once on this sensor — the actionable move is to make the check fail.
function unearnedCloseMessage() {
  return (
    "criterion has not been witnessed red on this task — an earn-red task must see one red " +
    "before a green can close it (write the failing check, or make the current one fail once). " +
    "A red Stop gate or a red `done` counts; amending the criterion resets the witness."
  );
}

// The one green-close commit sequence. Both close doors (the done verb and the
// stop gate) route through here after their gates pass, so the doors cannot
// drift apart — a gate added to one door but not the other was a live near-miss.
// Returns the spend summary for the door's own success message.
function adjudicateGreen(repo, currentTask, provisional = false) {
  const changed = criterionInputDrift(currentTask, repo);
  // A declared work subject is exempt from drift refusal: its change is the
  // work happening, not the sensor being moved. Everything else keeps the old
  // refusal, so a mixed change (subject + real sensor) still blocks and names
  // only the un-exempt files.
  const subjects = new Set(Array.isArray(currentTask.criterion_subject) ? currentTask.criterion_subject : []);
  const drift = changed.filter((p) => !subjects.has(p));
  const subjectChanged = changed.filter((p) => subjects.has(p));
  const result = transition(currentTask, {
    type: "adjudicate-green",
    at: utcNow(),
    drift,
    subjectChanged,
    provisional,
  });
  const task = result.task;
  if (result.meta.outcome === "drift") warnInputDrift(drift, subjectChanged);
  saveTask(repo, task);
  if (result.meta.outcome === "closed") {
    appendLedger(repo, task);
    warnCloseAcceptance(task);
    if (subjectChanged.length) warnSubjectExemption(task);
    warnCloseTriangle(task);
    if (result.meta.unreviewedStateDir) remindUnreviewedSelfCheck(task);
  }
  return { task, ...result.meta };
}

function cmdReview(values) {
  const repo = repoFromArg(values.repo);
  return withOpenTaskLocked(repo, (task) => {
  const level = String(values.level ?? "").trim();
  if (!REVIEW_LEVELS.includes(level)) {
    return cliError(
      `--level must be one of ${REVIEW_LEVELS.join(", ")} ` +
        "(weakest→strongest independence); prefer second-model, and record a downgrade honestly",
    );
  }
  // Stamp the criterion this review vouched for, so a later criterion amend
  // does not silently carry the review's independence to a different check.
  const record = { at: utcNow(), level, criterion_hash: task.criterion_hash };
  const reviewer = String(values.reviewer ?? "").trim();
  if (reviewer) record.reviewer = reviewer;
  const findings = Number.parseInt(String(values.findings ?? ""), 10);
  if (Number.isFinite(findings)) record.findings = findings;
  task = transition(task, { type: "review", at: record.at, record }).task;
  saveTask(repo, task);
  process.stdout.write(
    `recorded ${level} review${reviewer ? ` by ${reviewer}` : ""}; ` +
      "the finding goes back into the loop body — this records only that it happened\n",
  );
  return 0;
  });
}

function cmdAmend(values) {
  const repo = repoFromArg(values.repo);
  return withOpenTaskLocked(repo, (task) => {
  const reason = String(values.reason ?? "").trim();
  if (!reason) return cliError("--reason is required: every goalpost or budget move carries its why");
  const nextGoal = String(values.goal ?? "").trim();
  const nextCriterionCommand = String(values.criterion ?? "").trim();
  const nextFileRaw = String(values["criterion-file"] ?? "").trim();
  if (nextCriterionCommand && nextFileRaw) return cliError("use only one of --criterion or --criterion-file");
  let nextFile = null;
  if (nextFileRaw) {
    try {
      nextFile = resolveCriterionFile(repo, nextFileRaw);
    } catch (err) {
      return cliError(err?.message ?? String(err));
    }
  }
  const addFiles = (values.files ?? []).map(String).filter(Boolean);
  const amendJoinedOffender = joinedFileOffender(addFiles);
  if (amendJoinedOffender) return cliError(joinedFilesMessage(amendJoinedOffender));
  const rounds = String(values.rounds ?? "").trim();
  const timeoutRaw = String(values["criterion-timeout-seconds"] ?? "").trim();
  const protocolRaw = String(values["criterion-protocol"] ?? "").trim();
  if (protocolRaw && !CRITERION_PROTOCOLS.has(protocolRaw)) {
    return cliError('--criterion-protocol must be "binary" or "tri-state"');
  }
  const gitAllowed = (values["git-allowed"] ?? []).map((o) => String(o).toLowerCase()).filter(Boolean);
  const gitReason = String(values["git-reason"] ?? "").trim();
  if (gitAllowed.length && !gitReason) {
    return cliError("--git-reason is required when --git-allowed is used");
  }
  const addSubjectsRaw = (values["criterion-subject"] ?? []).map(String).map((s) => s.trim()).filter(Boolean);
  if (
    !nextGoal &&
    !nextCriterionCommand &&
    !nextFile &&
    !addFiles.length &&
    !rounds &&
    !timeoutRaw &&
    !protocolRaw &&
    !gitAllowed.length &&
    !addSubjectsRaw.length
  ) {
    return cliError(
      "amend requires --goal, --criterion, --criterion-file, --criterion-protocol, --files, --criterion-subject, --rounds, --criterion-timeout-seconds, and/or --git-allowed",
    );
  }
  // Validate any new subjects against the POST-amend envelope and criterion
  // file: --files added in this same amend widen the envelope, and amending the
  // criterion changes which file is the (never-subject) checker.
  const effectiveEnvelope = [...(task.envelope?.files ?? []), ...addFiles];
  const effectiveCriterionFile = nextFile ?? (nextCriterionCommand ? null : task.criterion_file ?? null);
  const { subjects: addSubjects, error: amendSubjectError } = resolveCriterionSubjects(
    repo,
    addSubjectsRaw,
    effectiveEnvelope,
    effectiveCriterionFile,
  );
  if (amendSubjectError !== null) return amendSubjectError;
  const grantedBy = String(values["granted-by"] ?? "self").trim() || "self";
  if (!GRANT_PROVENANCES.has(grantedBy)) {
    return cliError('--granted-by must be "self" or "user" — provenance is recorded as stated, never invented');
  }
  const amendment = { at: utcNow(), reason };
  let criterionMove = null;
  const grants = [];
  let nextRounds = null;
  let timeoutSeconds = null;
  if (nextGoal) {
    amendment.goal = { from: task.goal ?? null, to: nextGoal };
  }
  if (nextCriterionCommand || nextFile) {
    const nextDisplay = nextFile ? `criterion-file:${nextFile}` : nextCriterionCommand;
    const nextProtocol = protocolRaw || task.criterion_protocol || "binary";
    amendment.criterion = { from_hash: task.criterion_hash, to: nextDisplay };
    if (nextFile) amendment.criterion.file = nextFile;
    criterionMove = {
      display: nextDisplay,
      hash: fnv1aHex(`${nextDisplay}\0${nextProtocol}`),
      ...(nextFile ? { file: nextFile } : {}),
      sensor: nextFile
        ? criterionFileSensorMetadata(nextFile, repo)
        : criterionSensorMetadata(nextCriterionCommand, repo),
    };
  }
  if (addFiles.length) {
    amendment.files_added = addFiles;
    grants.push(...collectGrants({ grantedBy, files: addFiles, fileReason: reason }));
    warnZeroMatchEnvelope(repo, addFiles);
    warnSiblingEnvelopeOverlap(repo, addFiles);
  }
  if (rounds) {
    amendment.rounds = { from: task.budget.rounds, to: Number.parseInt(rounds, 10) || task.budget.rounds };
    nextRounds = amendment.rounds.to;
  }
  if (timeoutRaw) {
    const to = Number.parseInt(timeoutRaw, 10);
    if (!Number.isInteger(to) || to <= 0) return cliError("--criterion-timeout-seconds must be a positive integer");
    // The timeout is part of the sensor's execution contract: a criterion that
    // legitimately grew (more tests) needs a blessable move, exactly like the
    // criterion string itself.
    amendment.criterion_timeout_seconds = { from: task.criterion_timeout_seconds, to };
    timeoutSeconds = to;
  }
  if (protocolRaw) {
    amendment.criterion_protocol = { from: task.criterion_protocol ?? "binary", to: protocolRaw };
  }
  if (gitAllowed.length) {
    // Parity with open: the contract card and the done-gate guidance both tell
    // the user to authorize git mid-task via amend --git-allowed. Honor it here
    // so the CLI stops contradicting its own instructions.
    grants.push(...collectGrants({ grantedBy, gitOps: gitAllowed, gitReason }));
    amendment.git = { allowed_ops: gitAllowed, reason: gitReason };
  }
  if (addSubjects.length) {
    // Recorded as its own amendment field, never folded into files_added: a
    // trust exception is a distinct authority from a write-envelope widening.
    amendment.criterion_subjects_added = addSubjects;
    grants.push(...collectGrants({ grantedBy, subjects: addSubjects, subjectReason: reason }));
  }
  task = transition(task, {
    type: "amend",
    at: amendment.at,
    goal: nextGoal || null,
    criterion: criterionMove,
    files: addFiles,
    criterionSubject: addSubjects,
    grants,
    rounds: nextRounds,
    timeoutSeconds,
    criterionProtocol: protocolRaw || null,
    git: gitAllowed.length ? { allowedOps: gitAllowed, reason: gitReason } : null,
    amendment,
  }).task;
  saveTask(repo, task);
  if (nextCriterionCommand || nextFile) warnCriterionSensor(task);
  if (addSubjects.length) warnInertCriterionSubjects(task, addSubjects);
  process.stdout.write("amended; the move and its reason are recorded on the task\n");
  return 0;
  });
}

function cmdStatus(values) {
  const repo = repoFromArg(values.repo);
  const task = loadTask(repo);
  if (!task) {
    process.stdout.write("no task\n");
    return 0;
  }
  process.stdout.write(
    `state=${task.state} rounds=${task.spent?.rounds ?? 0}/${task.budget?.rounds ?? "?"} ` +
      `writes=${task.evidence?.writes ?? 0} episodes=${(task.episodes ?? []).length} ` +
      `goal=${task.goal}\n` +
      `criterion=${task.criterion}\n` +
      `criterion_protocol=${task.criterion_protocol ?? "binary"}\n` +
      (Array.isArray(task.criterion_subject) && task.criterion_subject.length
        ? `criterion_subject=${task.criterion_subject.join(", ")}\n`
        : "") +
      (task.earn_red === true ? `earn_red=true red_witnessed=${Boolean(task.red_witnessed)}\n` : "") +
      `alignment=${task.alignment}\n` +
      `snapshot=${task.snapshot?.judgment ?? "none"}\n` +
      `touched=${touchedSummary(task)}\n`,
  );
  return 0;
}

function cmdVerify(values) {
  const repo = repoFromArg(values.repo);
  const task = loadTask(repo);
  if (!task) {
    process.stderr.write("no task\n");
    return 2;
  }
  const verdict = runTaskCriterion(task, repo);
  process.stdout.write(`${verdict.verdict}\n`);
  if (verdict.verdict === "pass") return 0;
  return verdict.verdict === "fail" ? 1 : 2;
}

// A read-only pass over the outcome ledger. It turns the manual review this
// tool grew out of into a rerunnable diagnostic — real vs probe, state /
// provenance / review distributions, drift / provisional / open signals — and,
// first, a field-trust self-check so a downstream stat cannot silently inherit
// a bad counter as fact. Reads only; never a gate.
const AUDIT_PROBE_GOALS = new Set(["probe", "g", "repro probe", "repro", "repro-probe"]);
function auditIsProbe(t) {
  // An explicit kind is authoritative — never let a heuristic override it. The
  // goal/repo heuristics only classify pre-schema rows that carry no kind.
  if (t.kind === "probe") return true;
  if (t.kind === "task") return false;
  return (
    /[\\/](scratchpad|temp)[\\/]/i.test(String(t.repo ?? "")) ||
    AUDIT_PROBE_GOALS.has(String(t.goal ?? "").trim().toLowerCase())
  );
}
function cmdAudit(values) {
  const { file, raw } = readOutcomeText();
  if (raw === null) {
    process.stdout.write(`no ledger at ${file}\n`);
    return 0;
  }
  const since = String(values.since ?? "").trim();
  const rows = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (since && String(r.ts ?? "") < since) continue;
      rows.push(r);
    } catch {
      // A corrupt/truncated row is itself a ledger-trust issue — count it so the
      // field-trust block surfaces it instead of silently undercounting.
      malformed += 1;
    }
  }
  // Ledger is append-ordered; suspended/resumed rows are non-terminal events,
  // so their task remains open even though the event line keeps its own state.
  const byId = new Map();
  for (const r of rows) {
    const key = r.id ?? `${r.repo}|${r.goal}`;
    if (r.state === "suspended" || r.state === "resumed") {
      byId.set(key, { ...r, state: "open", last_event: r.state });
    } else {
      byId.set(key, r);
    }
  }
  const tasks = [...byId.values()];

  const real = tasks.filter((t) => !auditIsProbe(t));
  const probes = tasks.filter(auditIsProbe);
  const tally = (key) => {
    const m = new Map();
    for (const t of tasks) {
      const v = String(t[key] ?? "—");
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return (
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join("  ") || "—"
    );
  };

  const warns = [];
  if (malformed) {
    warns.push(
      `! ${malformed} malformed ledger row(s) skipped — unparseable JSONL the audit could not count; ` +
        "the row/task totals are undercounts until the ledger is repaired",
    );
  }
  const closed = tasks.filter((t) => t.state === "done");
  const bigTok = tasks.filter((t) => Number(t.output_tokens_estimate) > 5_000_000);
  if (bigTok.length) {
    warns.push(
      `! token estimate implausible: ${bigTok.length} task(s) > 5,000,000 output tokens — read ` +
        "output_tokens_scope; inspect the runtime usage schema because the estimate is not task-attributed",
    );
  }
  if (closed.length && closed.every((t) => Number(t.rounds ?? 0) === 0)) {
    warns.push(
      `! rounds counter flat: all ${closed.length} closed task(s) show rounds=0 — the gate was verified ` +
        "outside taskloop and closed in one pass, so the round budget records nothing (not a bug)",
    );
  }
  const preSchema = tasks.filter((t) => t.kind === undefined || t.opened_dirty === undefined);
  if (preSchema.length) {
    warns.push(`· ${preSchema.length} pre-schema row(s) lack kind/opened_dirty — probe class by heuristic`);
  }
  // append-only means a probe abandoned before the kind-fidelity fix keeps a
  // fabricated kind="task" forever. explicit-kind trust counts it real; flag it
  // so the count is not silently wrong — classification unchanged, verify by hand.
  const suspiciousKind = tasks.filter(
    (t) => t.kind === "task" && /[\\/](scratchpad|temp)[\\/]/i.test(String(t.repo ?? "")),
  );
  if (suspiciousKind.length) {
    warns.push(
      `! ${suspiciousKind.length} suspicious kind=task row(s) in a scratchpad/temp repo — likely a pre-fix ` +
        "fabricated kind; counted real per explicit-kind trust, but verify by hand",
    );
  }

  const openTasks = tasks.filter((t) => t.state === "open");
  const drift = tasks.filter((t) => t.criterion_input_drift).length;
  const subjectChanged = tasks.filter((t) => t.criterion_subject_changed).length;
  const earnRed = tasks.filter((t) => t.earn_red === true).length;
  const earnRedUnearned = tasks.filter((t) => t.earn_red === true && t.red_witnessed !== true).length;
  const provisional = tasks.filter((t) => t.provisional).length;
  const dirty = tasks.filter((t) => t.opened_dirty).length;
  const out = [
    `taskloop audit — since ${since || "all"}  (${rows.length} rows, ${tasks.length} tasks)`,
    "",
    "field trust:",
    ...(warns.length ? warns.map((w) => `  ${w}`) : ["  · no field-trust warnings"]),
    "",
    `tasks:      real ${real.length}  probe ${probes.length}`,
    `state:      ${tally("state")}`,
    `provenance: ${tally("criterion_provenance")}`,
    `review:     ${tally("review_level")}`,
    `signals:    drift ${drift}  subject-exempt ${subjectChanged}  earn-red ${earnRed} (unearned ${earnRedUnearned})  provisional ${provisional}  opened-dirty ${dirty}`,
  ];
  if (openTasks.length) {
    out.push("", `open (unclosed): ${openTasks.length}`);
    for (const t of openTasks) out.push(`  ${t.id ?? "—"}  ${auditIsProbe(t) ? "[probe] " : ""}${t.goal ?? ""}`);
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

// ---------- hooks: the supervisor ----------

function repoFromPayload(payload) {
  const cwd = String(payload.cwd ?? process.cwd());
  // Walk up looking for an existing .taskloop/ so hooks work from subdirs,
  // but never past a git boundary: a nested repo (vendored checkout, test
  // fixture, worktree) is its own project and must not be captured by an
  // enclosing directory's task.
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, STATE_DIR, TASK_FILE))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

// ---------- untracked writes: the nudge before the loop ----------
//
// With no open task the machine used to be fully blind — the one decision the
// whole system left to prose was "should this work have opened a task?", and a
// live Codex session answered it wrong (multi-file landing, zero taskloop).
// The contract already defines the machine-checkable half: lightweight means
// SINGLE-FILE. So reads stay free, the first written file passes with a nudge,
// and the second distinct file gates until a task is opened.
//
// The gate counts only what it can attribute honestly: structured file fields,
// patch-body file lines, and unquoted shell redirects, folded case-insensitively
// where the filesystem is. Git discipline stays with the in-task envelope;
// writes outside this repo, writes with no extractable target (bare shell
// edits like sed -i — a known, accepted miss: guessing positional args would
// gate reads, and a false deny costs more than a missed nudge), and calls
// with no session identity nudge but never gate. Parallel calls that spread
// files before any response lands each get the same deny with the same open
// template — the gate is per-call, deliberately.

function hookUntrackedPretool(payload, repo) {
  const tool = String(payload.tool_name ?? "");
  const mapping = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const result = observeUntracked({
    payload,
    repo,
    writeShaped: looksLikeWrite(tool, mapping),
    writeTargets: writeFileTargets(tool, mapping),
    scriptPath: process.argv[1] ?? "taskloop.mjs",
  });
  if (result.kind === "deny") return deny(result.message);
  if (result.kind === "notice") process.stderr.write(result.message + "\n");
  return 0;
}

function hookPretool(payload, repo) {
  // Serialize the load -> transition -> save span against parallel hook
  // processes, and re-load inside the lock so the transition applies to the
  // latest task, not the snapshot main read before contending for the lock.
  return withTaskLock(repo, () => {
    const currentTask = loadTask(repo);
    if (!currentTask || currentTask.state !== "open") return 0; // raced to a close
    return hookPretoolLocked(payload, repo, currentTask);
  });
}

function hookPretoolLocked(payload, repo, currentTask) {
  // Suspended and cross-session ownership are decided under the lock, before
  // begin-episode, so the ownership read is atomic with the task save.
  const suspended = suspendedHookOutcome("pretooluse", payload, repo, currentTask);
  if (suspended !== null) return suspended;
  const ownership = episodeOwnership(currentTask, payload.session_id, Date.now(), resolveLeaseTtlMs());
  if (ownership.role === "bystander") {
    // Policy: a bystander (a foreign session in a worktree it does not own) is
    // released unsupervised — its envelope, budget, git-authorization and
    // command-safety all belong to ITS own task in ITS own worktree, not to the
    // owner's task here. taskloop is a collaborative fail-open supervisor, not a
    // sandbox, so it declines to police a session it is not supervising and
    // instead points it at a separate worktree. (Consequence: this call skips
    // this task's checks entirely; that is the intended fail-open behavior.)
    bystanderNote(ownership.owner);
    return 0;
  }
  const episode = transition(currentTask, { type: "begin-episode", at: utcNow(), atMs: Date.now(), session: payload.session_id });
  let task = episode.task;
  const tool = String(payload.tool_name ?? "");
  const mapping = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  tallyEpisodeTokens(task, payload);
  if (episode.meta.resumed) process.stderr.write(resumeBanner(task));

  const ops = gitOps(mapping);
  const deniedGit = ops.filter((op) => !task.envelope.git.allowed_ops.includes(op));
  if (deniedGit.length) {
    saveTask(repo, task);
    return deny(
      `taskloop: git operation(s) need envelope authorization: ${deniedGit.join(", ")}. ` +
        "Re-open or amend the task with --git-allowed <op> --git-reason <why> after the user asks for it.",
    );
  }

  // Safety runs on every command-bearing call, ahead of the write-shaped
  // short-circuit: a pipe-to-shell or an env dump is dangerous even though it
  // touches no tracked file. This is the fix for the audit's leak where
  // `curl | sh` slipped past because it was not "write-shaped".
  for (const command of commandValues(mapping)) {
    const failure = commandSafetyFailure(task, command);
    if (failure) {
      saveTask(repo, task);
      return deny(`taskloop: ${failure}`);
    }
  }

  const writeShaped = ops.length > 0 || looksLikeWrite(tool, mapping);
  if (!writeShaped) {
    // Reads and verification commands are never blocked and never counted:
    // an over-budget task can always still verify, suspend, or close.
    saveTask(repo, task);
    return 0;
  }

  if ((task.spent?.rounds ?? 0) >= (task.budget?.rounds ?? DEFAULT_ROUNDS)) {
    saveTask(repo, task);
    return deny(
      `taskloop: round budget exhausted (${task.spent?.rounds ?? 0}/${task.budget?.rounds ?? DEFAULT_ROUNDS}); ` +
        "reads and verification remain free. Amend --rounds --reason before writing again, or suspend/abandon honestly.",
    );
  }

  const rels = writeFileTargets(tool, mapping)
    .map((raw) => repoRelative(repo, raw))
    .filter(Boolean);
  for (const rel of rels) {
    if (!insideEnvelope(rel, task.envelope.files)) {
      saveTask(repo, task);
      return deny(
        `taskloop: write outside the envelope: ${rel}. Narrow the call, or if it belongs to the goal:\n` +
          `  node "${process.argv[1] ?? "taskloop.mjs"}" amend --repo "${repo}" --files "<glob>" --reason "<why>"`,
      );
    }
  }

  const budget = task.budget;
  if (budget.writes > 0 && task.evidence.writes >= budget.writes) {
    saveTask(repo, task);
    return deny(
      `taskloop: write budget exhausted (${task.evidence.writes}/${budget.writes}). ` +
        "Verification still runs: verify and stop, suspend --judgment, or amend --rounds/--reason.",
    );
  }
  if (budget.wall_clock_minutes > 0) {
    const started = Date.parse(String(task.spent.opened_at ?? ""));
    if (Number.isFinite(started) && (Date.now() - started) / 60000 > budget.wall_clock_minutes) {
      saveTask(repo, task);
      return deny(
        `taskloop: wall-clock budget exhausted (max ${budget.wall_clock_minutes}m). ` +
          "Verification still runs: verify and stop, suspend --judgment, or abandon --reason.",
      );
    }
  }
  if ((budget.tokens ?? 0) > 0 && spentTokens(task) > budget.tokens) {
    saveTask(repo, task);
    return deny(
      `taskloop: token budget exhausted (~${spentTokens(task)}/${budget.tokens} output tokens). ` +
        "Verification still runs: verify and stop, suspend --judgment, or abandon --reason.",
    );
  }

  task = transition(task, { type: "record-write", at: utcNow(), files: rels }).task;
  saveTask(repo, task);
  return 0;
}

function suspendByMachine(repo, currentTask, outcome, note) {
  const task = transition(currentTask, { type: "machine-suspend", at: utcNow(), outcome, note }).task;
  saveTask(repo, task);
  appendLedger(repo, task, { state: "suspended", suspension_outcome: outcome, suspension_source: "machine", note });
  process.stderr.write(
    `taskloop: ${note}; machine-observed changed files ${touchedSummary(task)}; ` +
      "the task stays open and writes are paused — use resume --reason after the blocker changes; " +
      'if direction changed, amend --goal/--criterion --reason; or close honestly with abandon --reason\n',
  );
  return 0;
}

function hookStop(payload, repo) {
  // Hold the task lock across the whole stop, re-loading inside it so the
  // adjudication applies to the latest task. The read-only criterion runs under
  // the lock too — a known cost: a parallel PreToolUse can wait up to the lock's
  // fail-open timeout while a slow criterion runs; moving the criterion out of
  // the lock is a later refinement.
  return withTaskLock(repo, () => {
    const currentTask = loadTask(repo);
    if (!currentTask || currentTask.state !== "open") return 0; // raced to a close
    return hookStopLocked(payload, repo, currentTask);
  });
}

function hookStopLocked(payload, repo, currentTask) {
  // Suspended and cross-session ownership are decided before adjudication, under
  // the lock. A parked task (needs_input, or a machine stall — observed live
  // when a /goal driver kept re-injecting the goal after an honest needs_input
  // suspension and drained the budget) is released without burning a round; a
  // bystander session's stop never adjudicates the owner's task.
  const suspended = suspendedHookOutcome("stop", payload, repo, currentTask);
  if (suspended !== null) return suspended;
  const ownership = episodeOwnership(currentTask, payload.session_id, Date.now(), resolveLeaseTtlMs());
  if (ownership.role === "bystander") {
    // Release without adjudicating: this session is not the task's driver, so
    // its stop says nothing about whether the owner's task is done. No takeover,
    // no round burned, owner's episode untouched.
    bystanderNote(ownership.owner);
    return 0;
  }
  const episode = transition(currentTask, { type: "begin-episode", at: utcNow(), atMs: Date.now(), session: payload.session_id });
  let task = episode.task;
  tallyEpisodeTokens(task, payload);
  if (episode.meta.resumed) process.stderr.write(resumeBanner(task));

  const verdict = runTaskCriterion(task, repo);
  if (verdict.verdict === "pass" && task.keep_green) {
    // Green is a keep-green task's steady state, not a success event: the
    // fresh-green door stays shut and only an explicit verb closes the task.
    task = transition(task, { type: "keep-green", at: utcNow() }).task;
    saveTask(repo, task);
    return 0;
  }
  if (verdict.verdict === "pass") {
    const adjudication = adjudicateGreen(repo, task, false);
    task = adjudication.task;
    if (adjudication.outcome === "drift") return 0;
    if (adjudication.outcome === "unearned") {
      return block(`taskloop: green held — ${unearnedCloseMessage()}`);
    }
    if (adjudication.outcome === "weak") {
      return block(`taskloop: green held — ${weakCloseMessage(task)}`);
    }
    process.stderr.write(`taskloop: criterion green — task done (${adjudication.spent})\n`);
    return 0;
  }
  if (verdict.verdict === "not_executable") {
    saveTask(repo, task);
    process.stderr.write(
      `taskloop: criterion cannot run (${verdict.detail}); releasing the stop — fix the criterion via amend\n`,
    );
    return 0;
  }
  if (verdict.verdict === "indeterminate") {
    const tail = outputTail(verdict.output);
    saveTask(repo, task);
    return block(
      `taskloop: ${verdict.detail}; regenerate or repair the external evidence, then verify again. ` +
        "The work is not adjudicated and no round was burned.\n" +
        (tail ? `--- criterion output (tail) ---\n${tail}\n` : ""),
    );
  }

  const tail = outputTail(verdict.output);
  const signature = fnv1aHex(`${verdict.exit}|${tail}`);
  const failure = transition(task, { type: "criterion-failure", at: utcNow(), verdict, signature });
  task = failure.task;
  const alternating = failure.meta.alternating;

  if (failure.meta.failureState === "stuck") {
    return suspendByMachine(
      repo,
      task,
      "stuck",
      alternating
        ? "two failure signatures alternating — fix A breaks B, fix B breaks A; suspended as stuck"
        : `same failure ${task.stall.count} stops in a row; suspended as stuck`,
    );
  }
  if (failure.meta.failureState === "out_of_budget") {
    const distinct = new Set(task.stall.history).size;
    const moving = task.stall.history.length >= 2 && distinct === task.stall.history.length;
    return suspendByMachine(
      repo,
      task,
      "out_of_budget",
      `round budget spent (${task.spent.rounds}/${task.budget.rounds})` +
        (moving
          ? " — every round failed differently, the task was still moving; amend --rounds --reason to continue"
          : ""),
    );
  }

  saveTask(repo, task);
  return block(
    `taskloop: criterion red (round ${task.spent.rounds}/${task.budget.rounds}): ${task.criterion}\n` +
      (tail ? `--- criterion output (tail) ---\n${tail}\n` : "") +
      "Fix and re-verify. If the criterion is wrong: amend --criterion --reason. " +
      "If input is missing: suspend --outcome needs_input --judgment \"<remaining; failure; next>\".",
  );
}

// Paste-ready hook wiring. Consumer integrations may install it automatically;
// this prints the manual form for a dogfood checkout or a hand-managed runtime.
// The supervisor is inert in any repo without a .taskloop/ task, so it is safe
// to leave registered globally.
function cmdHooks() {
  // Forward slashes on every platform: Windows backslashes get JSON-escaped in
  // the snippet (C:\\Users\\...), which breaks copy-paste greps and the test's
  // absolute-path assertion; forward-slash paths are valid on all platforms.
  const script = path.resolve(process.argv[1] ?? "taskloop.mjs").replace(/\\/g, "/");
  const command = `node "${script}"`;
  process.stdout.write(
    "# taskloop hook wiring — integrations may wire this for you; this is the manual\n" +
      "# form. The supervisor is inert without a .taskloop/ task, safe left on.\n\n" +
      '# Claude Code — merge into the "hooks" object of ~/.claude/settings.json:\n' +
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*",
                hooks: [{ type: "command", command, timeout: 20 }],
              },
            ],
            Stop: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 300 }] }],
          },
        },
        null,
        2,
      ) +
      "\n\n# Codex — append to ~/.codex/config.toml:\n" +
      [
        "[[hooks.PreToolUse]]",
        'matcher = ".*"',
        "",
        "[[hooks.PreToolUse.hooks]]",
        'type = "command"',
        `command = ${JSON.stringify(command)}`,
        "timeout = 20",
        'statusMessage = "Checking taskloop envelope"',
        "",
        "[[hooks.Stop]]",
        'matcher = ".*"',
        "",
        "[[hooks.Stop.hooks]]",
        'type = "command"',
        `command = ${JSON.stringify(command)}`,
        "timeout = 300",
        'statusMessage = "Checking taskloop stop gate"',
      ].join("\n") +
      "\n",
  );
  return 0;
}

// ---------- main ----------

function cmdHelp() {
  process.stdout.write(
    "taskloop.mjs — task-first loop supervisor (clean-room v2)\n\n" +
      "open a task (copy, fill in, run):\n" +
      '  node taskloop.mjs open --repo <repo> --goal "<one line>" \\\n' +
      '    (--criterion "<executable check, red until done>" | --criterion-file "<repo-relative script>") \\\n' +
      '    [--criterion-protocol binary|tri-state] [--criterion-subject "<repo-relative file>" …] \\\n' +
      '    [--keep-green --reason "<why>" | --earn-red --reason "<why>"] \\\n' +
      '    --alignment "green ⇒ goal because <...>; not covered: <...>" \\\n' +
      '    --files "<glob>" [--files "<glob2>" …] [--probe] [--rounds 8] [--writes N] [--wall-clock-minutes M]\n' +
      "    # repeat --files per glob (a comma-joined string is refused); --probe marks a throwaway debug task\n" +
      "    # --criterion-subject declares a criterion input the task itself rewrites (its change is not sensor drift)\n" +
      "    # --earn-red opens on a green criterion (write-the-failing-check-first); the close is barred until one red is witnessed\n\n" +
      "verbs:\n" +
      "  status | verify\n" +
      '  suspend  --outcome needs_input|stuck|out_of_budget --judgment "<remaining; failure; next>"\n' +
      '  resume   --reason "<what changed>"  # clears sticky suspension; current goal is echoed\n' +
      "  done [--provisional]       # runs the criterion; green is the only path\n" +
      "             # --provisional closes a state-dir criterion that has no fresh-context review (rides the ledger)\n" +
      '  abandon  --reason "<why>"\n' +
      '  not-needed --evidence "<read-only check>"\n' +
      '  review   --level second-model|fresh-context|self-reread [--reviewer <id>] [--findings N]\n' +
      "             # records review provenance (not a verdict); ledger shows the strongest level\n" +
      '  amend    --goal/--criterion/--criterion-file/--criterion-protocol/--criterion-subject/--files/--rounds/--criterion-timeout-seconds --reason "<why>"\n' +
      '             # to authorize git mid-task: amend --git-allowed <op> --git-reason "<why>" --reason "<why>"\n\n' +
      "  hooks                      # print paste-ready Claude/Codex hook wiring\n" +
      "  info                       # print the machine-readable integration contract\n" +
      '  audit    [--since <ISO ts>]  # read-only ledger diagnostic (real vs probe, distributions, field-trust)\n\n' +
      "hooks: pipe the runtime's PreToolUse/Stop JSON payload on stdin.\n" +
      "state: .taskloop/task.json (private; the dir gitignores itself); ledger: ~/.taskloop/outcomes.jsonl\n",
  );
  return 0;
}

function cmdInfo() {
  process.stdout.write(
    JSON.stringify({
      name: "taskloop",
      runtime_contract: 1,
      distribution_owner: "taskloop",
    }) + "\n",
  );
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length && ["help", "--help", "-h"].includes(argv[0])) return cmdHelp();
  // Verb-level help: `amend --help` must print usage, not "Unknown option".
  if (argv.some((a) => a === "--help" || a === "-h")) return cmdHelp();
  if (argv.length && Object.hasOwn(CLI_OPTIONS, argv[0])) {
    let values;
    try {
      ({ values } = parseArgs({ args: argv.slice(1), options: CLI_OPTIONS[argv[0]], allowPositionals: false }));
    } catch (err) {
      return cliError(`${err.message}\nusage: node taskloop.mjs help  (shows every '${argv[0]}' option)`);
    }
    if (argv[0] === "hooks") return cmdHooks();
    if (argv[0] === "info") return cmdInfo();
    if (argv[0] === "audit") return cmdAudit(values);
    if (argv[0] === "open") return cmdOpen(values);
    if (argv[0] === "status") return cmdStatus(values);
    if (argv[0] === "verify") return cmdVerify(values);
    if (argv[0] === "amend") return cmdAmend(values);
    if (argv[0] === "suspend") return cmdSuspend(values);
    if (argv[0] === "resume") return cmdResume(values);
    if (argv[0] === "done") return cmdDone(values);
    if (argv[0] === "abandon") return cmdAbandon(values);
    if (argv[0] === "review") return cmdReview(values);
    return cmdNotNeeded(values);
  }

  const payload = loadStdinJson();
  const event = String(payload.hook_event_name ?? "").toLowerCase();
  const repo = repoFromPayload(payload);
  // This routing read is pre-lock. The reverse race (a task closed between here
  // and dispatch) is caught by the hooks' in-lock reload + raced-closed check;
  // the forward race (a task opened in that window) takes the untracked path once
  // — a missed nudge, or an untracked multi-file gate on a write that the fresh
  // envelope would have allowed — accepted rather than locking the taskless path.
  const task = loadTask(repo);
  if (!task || task.state !== "open") {
    // No task: reads and Stop stay unsupervised, but writes get the untracked
    // nudge — single-file passes with a hint, multi-file gates on open.
    if (event !== "pretooluse") return 0;
    try {
      return hookUntrackedPretool(payload, repo);
    } catch (err) {
      process.stderr.write(`taskloop: untracked-write nudge degraded (${err?.message ?? err}); releasing\n`);
      return 0;
    }
  }
  try {
    if (event === "pretooluse") return hookPretool(payload, repo);
    if (event === "stop") return hookStop(payload, repo);
  } catch (err) {
    process.stderr.write(`taskloop: supervisor degraded (${err?.message ?? err}); releasing\n`);
    return 0;
  }
  return 0;
}

export { main };
