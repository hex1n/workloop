// Internal taskloop module. Its public seam is the export list at the end.

import { REVIEW_LEVELS, STUCK_REPEATS, TOUCHED_FILES_CAP, fnv1aHex, isPlainObject } from "./prims.mjs";

function activeEpisode(task) {
  const episodes = Array.isArray(task.episodes) ? task.episodes : [];
  const last = episodes.at(-1);
  return last && !last.closed_at ? last : null;
}

function closeEpisode(task, outcome, at) {
  const episode = activeEpisode(task);
  if (!episode) return null;
  episode.closed_at = at;
  episode.outcome = outcome;
  return episode;
}

// Token collection stays in the application telemetry path; the engine owns
// only the task-level total used by budgets and outcome projection.
function spentTokens(task) {
  return (Array.isArray(task.episodes) ? task.episodes : []).reduce(
    (sum, ep) => sum + (Number.isFinite(ep?.output_tokens) ? ep.output_tokens : 0),
    0,
  );
}

function ensureEpisode(task, session, at, atMs) {
  const sid = String(session ?? "").trim() || "unknown";
  const seenMs = Number.isFinite(atMs) ? atMs : Date.parse(at);
  let episode = activeEpisode(task);
  if (episode && episode.session !== sid) {
    // Single-writer default: a different session supersedes the previous
    // episode rather than sharing it. The machine snapshot half persists on
    // the task either way. The hook path gates this takeover through
    // episodeOwnership first, so a *fresh* foreign session never reaches here.
    closeEpisode(task, "detached", at);
    episode = null;
  }
  if (episode) {
    // Refresh the owner's lease on every touch. last_seen_ms keeps millisecond
    // precision (opened_at/last_seen_at are second-truncated by utcNow), so TTL
    // expiry is not up to ~1s early.
    episode.last_seen_at = at;
    if (Number.isFinite(seenMs)) episode.last_seen_ms = seenMs;
    return { episode, resumed: false };
  }
  if (!Array.isArray(task.episodes)) task.episodes = [];
  const resumed = task.episodes.length > 0;
  episode = { id: task.episodes.length + 1, session: sid, opened_at: at, last_seen_at: at };
  if (Number.isFinite(seenMs)) episode.last_seen_ms = seenMs;
  task.episodes.push(episode);
  return { episode, resumed };
}

// Who owns the right to drive this task right now. Write isolation is physically
// worktree-level, but turn adjudication is a per-session question: a bystander
// session sharing the worktree must not silently detach the owner's episode and
// adjudicate a task it is not driving. Prefer explicit handoff (a suspended task
// hands off via resume); the lease TTL is only the escape hatch for an owner
// that vanished without suspending. Recency stands in for liveness — the sole
// signal available without a session-liveness oracle. Returns the role and the
// current owning session so the hook can name the contention.
function episodeOwnership(task, session, nowMs, ttlMs) {
  const sid = String(session ?? "").trim() || "unknown";
  const episode = activeEpisode(task);
  if (!episode || episode.session === sid) return { role: "owner", owner: episode?.session ?? sid };
  // A different session holds the active episode.
  if (isPlainObject(task.suspension)) return { role: "handoff", owner: episode.session };
  // Millisecond lease when present; fall back to the second-truncated stamps for
  // pre-P0 tasks. A future timestamp (clock skew) yields a negative age, which is
  // < ttlMs, so ownership is conservatively kept rather than handed off.
  const seenMs = Number.isFinite(episode.last_seen_ms)
    ? episode.last_seen_ms
    : Date.parse(episode.last_seen_at ?? episode.opened_at ?? "");
  if (!Number.isFinite(seenMs) || nowMs - seenMs >= ttlMs) {
    return { role: "handoff", owner: episode.session }; // owner likely gone — takeover escape
  }
  return { role: "bystander", owner: episode.session }; // owner likely live
}

function touchedSummary(task, limit = 10) {
  const touched = Array.isArray(task.evidence?.touched_files) ? task.evidence.touched_files : [];
  if (!touched.length) return "none";
  const shown = touched.slice(0, limit).join(", ");
  const extra = touched.length > limit ? `, +${touched.length - limit} more` : "";
  return `(${touched.length}): ${shown}${extra}`;
}

// Machine-generated memory of what was tried: no judgment, just each failed
// close attempt's identity (signature) and first output line (head), capped so
// the task file stays small. Both close doors record through here.

const ATTEMPTS_CAP = 20;

function recordAttempt(task, verdict, signature, at) {
  if (!Array.isArray(task.attempts)) task.attempts = [];
  const firstLine = String(verdict.output ?? "").trim().split(/\r?\n/)[0] ?? "";
  task.attempts.push({
    at,
    round: task.spent?.rounds ?? 0,
    exit: verdict.exit ?? null,
    signature,
    head: firstLine.slice(0, 160),
  });
  while (task.attempts.length > ATTEMPTS_CAP) task.attempts.shift();
}

function deadEndsSummary(task) {
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  if (!attempts.length) return "";
  const distinct = new Set(attempts.map((a) => a.signature)).size;
  return (
    `; dead-ends: ${attempts.length} failed attempt${attempts.length === 1 ? "" : "s"} ` +
    `(${distinct} distinct) — last: ${attempts.at(-1).head || "(no output)"}`
  );
}

function resumeBanner(task) {
  const prev = (task.episodes ?? []).at(-2);
  return (
    `taskloop: resuming episode ${task.episodes.length}` +
    (prev?.outcome ? ` (previous: ${prev.outcome})` : "") +
    `; current goal: ${task.goal ?? "(missing)"}` +
    `; snapshot: ${task.snapshot?.judgment ?? "none recorded"}` +
    `; machine-observed changed files ${touchedSummary(task)}` +
    deadEndsSummary(task) +
    "\n"
  );
}

function cloneTask(task) {
  // task.json is deliberately JSON-only; cloning through that same contract
  // keeps transitions pure without introducing a runtime or schema dependency.
  return JSON.parse(JSON.stringify(task));
}

function createTask(facts) {
  return {
    version: 1,
    id: fnv1aHex(`${facts.idTime}|${facts.goal}|${facts.criterion}|${facts.entropy}`),
    state: "open",
    goal: facts.goal,
    criterion: facts.criterion,
    ...(facts.criterionFile ? { criterion_file: facts.criterionFile } : {}),
    ...(facts.criterionSubject?.length ? { criterion_subject: facts.criterionSubject } : {}),
    // earn_red only rides tasks that opened without a birth red. Its red_witnessed
    // starts from whether the open run itself saw red (an earn-red task opened on
    // a red criterion has already earned it); a birth-red or keep-green task
    // carries neither field, so the close gate — which fires only on an explicit
    // red_witnessed === false — never touches them.
    ...(facts.earnRed ? { earn_red: true, red_witnessed: Boolean(facts.redWitnessedAtOpen) } : {}),
    criterion_hash: fnv1aHex(`${facts.criterion}\0${facts.criterionProtocol}`),
    criterion_protocol: facts.criterionProtocol,
    ...facts.sensor,
    criterion_timeout_seconds: facts.timeoutSeconds,
    keep_green: facts.keepGreen,
    kind: facts.kind,
    opened_dirty: facts.openedDirty,
    alignment: facts.alignment,
    progress: facts.progress,
    envelope: facts.envelope,
    budget: facts.budget,
    spent: { rounds: 0, opened_at: facts.openedAt },
    evidence: { writes: 0, touched_files: [], criterion_input_drift: false },
    stall: { signature: null, count: 0, history: [] },
    snapshot: { judgment: null },
    episodes: [],
    amendments: [],
    reviews: [],
    grants: facts.grants,
    attempts: [],
  };
}

function currentCriterionReviewLevel(task) {
  const reviews = Array.isArray(task.reviews) ? task.reviews : [];
  let best = -1;
  for (const review of reviews) {
    if (review?.criterion_hash !== task.criterion_hash) continue;
    const index = REVIEW_LEVELS.indexOf(String(review?.level ?? ""));
    if (index > best) best = index;
  }
  return best >= 0 ? REVIEW_LEVELS[best] : "none";
}

function weakCloseBlocked(task, provisional) {
  if (provisional) return false;
  if (!new Set(["state-dir", "unresolved"]).has(task.criterion_provenance)) return false;
  return REVIEW_LEVELS.indexOf(currentCriterionReviewLevel(task)) < REVIEW_LEVELS.indexOf("fresh-context");
}

function transition(task, event) {
  if (!event?.at) throw new Error(`task transition ${event?.type ?? "unknown"} requires event.at`);
  const next = cloneTask(task);
  const at = event.at;
  const meta = {};
  switch (event.type) {
    case "begin-episode": {
      const episode = ensureEpisode(next, event.session, at, event.atMs);
      meta.resumed = episode.resumed;
      break;
    }
    case "suspend":
      next.snapshot = { judgment: event.judgment, at };
      next.suspension = {
        outcome: event.outcome,
        at,
        source: event.source,
        ...(event.judgment ? { judgment: event.judgment } : {}),
        ...(event.note ? { note: event.note } : {}),
      };
      if (event.source === "user") closeEpisode(next, event.outcome, at);
      break;
    case "resume": {
      const previous = next.suspension;
      delete next.suspension;
      if (!Array.isArray(next.resumptions)) next.resumptions = [];
      next.resumptions.push({ at, reason: event.reason, previous_outcome: previous?.outcome ?? null });
      meta.previous = previous ?? null;
      break;
    }
    case "terminal":
      closeEpisode(next, event.episodeOutcome ?? "detached", at);
      next.state = event.state;
      next.closed_at = at;
      if (event.reason !== undefined) next.outcome_reason = event.reason;
      break;
    case "adjudicate-green":
      // Declared work-subject inputs that changed are recorded on every
      // adjudication — including one that still blocks as drift — so the
      // exercised exemption stays visible even after a later blessed close.
      // witnessed = the change appears among this task's machine-observed
      // writes; attribution is incomplete, so false means "look again", not
      // "someone else did it".
      if (event.subjectChanged?.length) {
        next.evidence.criterion_subject_changed = true;
        next.evidence.criterion_subject_changes = event.subjectChanged.map((rel) => ({
          path: rel,
          witnessed: next.evidence.touched_files.includes(rel),
        }));
      }
      if (event.drift?.length) {
        next.evidence.criterion_input_drift = true;
        meta.outcome = "drift";
      } else if (next.earn_red === true && next.red_witnessed !== true) {
        // The discrimination proof was never completed: this sensor has not been
        // witnessed telling "done" from "not done" during the task, so a green
        // cannot close it. Distinct from weak-close (which is about review
        // independence) — here no red was ever seen on the current criterion.
        meta.outcome = "unearned";
      } else if (weakCloseBlocked(next, event.provisional)) {
        meta.outcome = "weak";
      } else {
        closeEpisode(next, "green", at);
        next.state = "done";
        next.closed_at = at;
        if (event.provisional) next.provisional = true;
        meta.outcome = "closed";
        meta.spent = `${next.spent.rounds} rounds, ${next.episodes.length} episodes`;
        meta.unreviewedStateDir =
          next.criterion_provenance === "state-dir" &&
          (Array.isArray(next.reviews) ? next.reviews : []).length === 0;
      }
      break;
    case "done-failure":
      // Cap at the budget: a failure transition must never store
      // spent.rounds > budget.rounds, or the write gate's spent>=budget
      // boundary reads a corrupted counter (observed: a red done retried past
      // an exhausted budget pushed rounds to 9/8).
      if (next.spent.rounds < next.budget.rounds) next.spent.rounds += 1;
      if (next.earn_red === true) next.red_witnessed = true;
      recordAttempt(next, event.verdict, event.signature, at);
      break;
    case "review":
      if (!Array.isArray(next.reviews)) next.reviews = [];
      next.reviews.push(event.record);
      break;
    case "keep-green":
      next.stall = { signature: null, count: 0, history: [] };
      break;
    case "machine-suspend":
      next.suspension = { outcome: event.outcome, at, source: "machine", note: event.note };
      break;
    case "record-write":
      next.evidence.writes += 1;
      for (const rel of event.files ?? []) {
        if (next.evidence.touched_files.includes(rel)) continue;
        if (next.evidence.touched_files.length >= TOUCHED_FILES_CAP) break;
        next.evidence.touched_files.push(rel);
      }
      break;
    case "criterion-failure": {
      // Same invariant as done-failure: never let the stored round count pass
      // the budget. out_of_budget is still detected below once rounds reach it.
      if (next.spent.rounds < next.budget.rounds) next.spent.rounds += 1;
      if (next.earn_red === true) next.red_witnessed = true;
      recordAttempt(next, event.verdict, event.signature, at);
      if (next.stall.signature === event.signature) next.stall.count += 1;
      else {
        next.stall.signature = event.signature;
        next.stall.count = 1;
      }
      next.stall.history.push(event.signature);
      while (next.stall.history.length > 2 * STUCK_REPEATS + 2) next.stall.history.shift();
      const window = next.stall.history.slice(-2 * STUCK_REPEATS);
      const alternating =
        window.length === 2 * STUCK_REPEATS &&
        window[0] !== window[1] &&
        window.every((signature, index) => signature === window[index % 2]);
      // Budget exhaustion outranks the stuck signature at the cap: a task with no
      // rounds left is write-blocked on resume regardless of why it failed, so its
      // suspension must point at amend --rounds, not read as merely stuck. Below
      // the cap the stuck/alternating signal still fires; alternating stays as
      // diagnostic metadata either way.
      if (next.spent.rounds >= next.budget.rounds) meta.failureState = "out_of_budget";
      else if (next.stall.count >= STUCK_REPEATS || alternating) meta.failureState = "stuck";
      else meta.failureState = "red";
      meta.alternating = alternating;
      break;
    }
    case "amend":
      if (event.goal) next.goal = event.goal;
      if (event.criterion) {
        next.criterion = event.criterion.display;
        next.criterion_hash = event.criterion.hash;
        if (event.criterion.file) next.criterion_file = event.criterion.file;
        else delete next.criterion_file;
        Object.assign(next, event.criterion.sensor);
        next.stall = { signature: null, count: 0, history: [] };
        // A work-subject exemption was granted against a specific check (same
        // principle as reviews stamped with criterion_hash): when the sensor
        // moves, the old exemption must not silently follow it. The same amend
        // may re-declare below.
        delete next.criterion_subject;
        // The red witness is proof about the OLD sensor; a moved criterion must
        // earn its own red before a green can close it again.
        if (next.earn_red === true) next.red_witnessed = false;
      }
      if (event.criterionSubject?.length) {
        next.criterion_subject = [
          ...new Set([...(Array.isArray(next.criterion_subject) ? next.criterion_subject : []), ...event.criterionSubject]),
        ];
      }
      if (event.criterionProtocol) {
        next.criterion_protocol = event.criterionProtocol;
        next.criterion_hash = fnv1aHex(`${next.criterion}\0${next.criterion_protocol}`);
        next.stall = { signature: null, count: 0, history: [] };
      }
      if (event.files?.length) next.envelope.files = [...new Set([...next.envelope.files, ...event.files])];
      if (event.grants?.length) {
        if (!Array.isArray(next.grants)) next.grants = [];
        next.grants.push(...event.grants);
      }
      if (event.rounds) next.budget.rounds = event.rounds;
      if (event.timeoutSeconds) next.criterion_timeout_seconds = event.timeoutSeconds;
      if (event.git?.allowedOps?.length) {
        if (!next.envelope.git || typeof next.envelope.git !== "object") {
          next.envelope.git = { allowed_ops: [], reason: "" };
        }
        next.envelope.git.allowed_ops = [...new Set([...next.envelope.git.allowed_ops, ...event.git.allowedOps])];
        next.envelope.git.reason = event.git.reason;
      }
      next.amendments.push(event.amendment);
      break;
    default:
      throw new Error(`unknown task transition: ${event.type}`);
  }
  return { task: next, meta };
}

export {
  activeEpisode,
  episodeOwnership,
  spentTokens,
  touchedSummary,
  resumeBanner,
  createTask,
  transition,
};
