// The loop service: the verbs a host drives.
//
// One call advances one transition. There is no background runner, no timer,
// and no path by which this file executes the work it asks for — it decides
// what the next legal step is and records what came back.
import fs from "node:fs";
import path from "node:path";
import { digestOf, sha256Hex } from "../canonical.mjs";
import { CLASSES } from "../locks.mjs";
import { openStore } from "../store.mjs";
import { runCriterion } from "./criterion.mjs";
import { LoopError, refuse } from "./error.mjs";
import { decide, nextDirective, progressSignature } from "./policy.mjs";
import { EMPTY, isLive, reduceLoop, roundsSpent } from "./projection.mjs";
import { STANDING, receiptStanding, takeReceipt } from "./receipt.mjs";
import { DECISION, KIND, RECEIPTS, SUSPENSION, TERMINAL, VERDICT, loopVocabulary } from "./vocabulary.mjs";

export { LoopError };

// Every record this service writes goes through the vocabulary first, so an
// unvalidated payload cannot reach the log by way of a code path that forgot.
const checked = (kind, payload) => ({ kind, payload: loopVocabulary.assert(kind, payload) });

export function openLoopStore(location, options = {}) {
  return openStore(location, { reduce: reduceLoop, initial: EMPTY, ...options });
}

export const criterionDigestOf = (file) => sha256Hex(fs.readFileSync(file));

// A checkpoint over the claimed paths: what the artifacts looked like when the
// round was observed. Two rounds with the same checkpoint changed nothing the
// loop is responsible for.
export const MAX_CHECKPOINT_ENTRIES = 20_000;

export function artifactCheckpoint(root, claims) {
  const entries = [];
  const walk = (relative, depth) => {
    if (entries.length >= MAX_CHECKPOINT_ENTRIES) refuse("CLAIM_TOO_LARGE", `a claim expands past ${MAX_CHECKPOINT_ENTRIES} entries`);
    // Depth is bounded rather than trusted: a symlink loop under a claim would
    // otherwise walk until the stack gives out, and a checkpoint that crashes
    // is worse than one that refuses.
    if (depth > 64) refuse("CLAIM_TOO_DEEP", `${relative} nests deeper than 64 levels`);
    const absolute = path.join(root, relative);
    let stat;
    try {
      // lstat, not stat: a symlink is recorded as the link it is, so the walk
      // cannot be led outside the claim or around in a circle.
      stat = fs.lstatSync(absolute);
    } catch {
      entries.push([relative, "absent"]);
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push([relative, `symlink:${sha256Hex(fs.readlinkSync(absolute))}`]);
      return;
    }
    if (stat.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(absolute).sort();
      } catch (error) {
        // Unreadable is a fact about the artifacts, not a reason to lose the
        // whole observation: the criterion has already run by now.
        entries.push([relative, `unreadable:${error.code ?? "unknown"}`]);
        return;
      }
      for (const name of names) walk(path.join(relative, name), depth + 1);
      return;
    }
    if (!stat.isFile()) {
      // Sockets, FIFOs and devices have no content worth hashing, and reading
      // one could block forever.
      entries.push([relative, `special:${stat.mode & fs.constants.S_IFMT}`]);
      return;
    }
    try {
      entries.push([relative, sha256Hex(fs.readFileSync(absolute))]);
    } catch (error) {
      entries.push([relative, `unreadable:${error.code ?? "unknown"}`]);
    }
  };
  for (const claim of [...claims].sort()) walk(claim, 0);
  return digestOf(entries);
}

// Claims name paths inside the workspace, relative to its root. Anything that
// could resolve elsewhere, or that needs expanding before it means anything,
// is refused: a claim the runtime cannot compare literally is a claim two
// loops cannot be shown to be disjoint on.
export function assertClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0) refuse("CLAIMS_REQUIRED", "a loop needs at least one write claim");
  for (const claim of claims) {
    if (typeof claim !== "string" || claim.length === 0) refuse("CLAIM_SHAPE", "a claim must be a non-empty path");
    if (path.isAbsolute(claim)) refuse("CLAIM_SHAPE", `${claim} must be relative to the workspace root`);
    if (/[*?[\]{}]/u.test(claim)) refuse("CLAIM_SHAPE", `${claim} is a pattern; claims are literal paths`);
    const normalized = path.normalize(claim);
    if (normalized.split(path.sep).includes("..")) refuse("CLAIM_SHAPE", `${claim} escapes the workspace root`);
  }
  const normalized = claims.map((claim) => path.normalize(claim));
  if (new Set(normalized).size !== normalized.length) refuse("CLAIM_SHAPE", "claims must be distinct");
  // Overlap makes "my paths" undecidable, which is the one thing claims exist
  // to make decidable.
  for (const outer of normalized) {
    for (const inner of normalized) {
      if (outer !== inner && (inner === outer || inner.startsWith(`${outer}${path.sep}`))) {
        refuse("CLAIM_OVERLAP", `${inner} lies inside ${outer}`);
      }
    }
  }
  return [...normalized].sort();
}

export function openLoop(store, { goal, claims, criterionFile, roundsBudget, session, reason, grantedBy, receipts, commandId }) {
  if (typeof goal !== "string" || goal.trim().length === 0) refuse("GOAL_REQUIRED", "a loop needs a goal");
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "a loop records who opened it");
  // Provenance is required at the seam, not merely allowed: a loop that cannot
  // say who opened it and why is a loop nobody can audit later.
  if (typeof reason !== "string" || reason.trim().length === 0) refuse("REASON_REQUIRED", "opening a loop records why");
  if (grantedBy !== "self" && grantedBy !== "user") refuse("PROVENANCE_REQUIRED", "granted_by must be self or user");
  // No default. This is the standard the loop will be certified against, and a
  // certification standard that nobody stated is one nobody agreed to.
  if (!Object.values(RECEIPTS).includes(receipts)) refuse("RECEIPTS_REQUIRED", `receipts must be one of ${Object.values(RECEIPTS)}`);
  const criterionDigest = criterionDigestOf(criterionFile);
  const payload = {
    goal, claims: assertClaims(claims), criterion_digest: criterionDigest,
    rounds_budget: roundsBudget, opened_by: session, reason, granted_by: grantedBy, receipts,
  };
  return store.append({
    commandId,
    requestDigest: digestOf(payload),
    prepare: (state) => {
      if (state.opened) refuse("ALREADY_OPEN", "this store already holds a loop");
      return [checked(KIND.OPENED, payload)];
    },
  });
}

// Pure read. While the state does not move, this returns the same directive,
// which is what lets a host ask again after a crash without wondering whether
// it has been given new work.
export function next(store, options = {}) {
  const { state } = store.replay();
  if (!state.opened) refuse("NOT_OPEN", "no loop has been opened in this store");
  return nextDirective(state, options);
}

/**
 * Submits the result of a round: the host says what it did, the runtime runs
 * the criterion itself and records the judgment and the decision that follows.
 *
 * The criterion runs outside the store lock, because it can take minutes and
 * holding a lock for that long would make the loop unusable. Staleness is
 * caught instead by comparing the loop's own revision when the result is
 * written — so work happening elsewhere cannot invalidate this round, and a
 * change to *this* loop cannot be silently overwritten.
 */
/**
 * Produces a receipt: the runtime performs one task-scoped git operation and
 * records what it saw.
 *
 * Held under the git_index lock, which is declared outer to the store lock, so
 * the order here is git_index → store. The criterion runs outside every lock
 * because it takes minutes; this takes milliseconds, and the index is the one
 * piece of genuinely shared mutable state in the picture.
 */
export function receipt(store, { root, mode, session, commandId }) {
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "a receipt records who took it");
  const before = store.replay().state;
  if (!before.opened) refuse("NOT_OPEN", "no loop has been opened in this store");
  if (!isLive(before)) refuse("NOT_LIVE", `the loop is ${before.lifecycle}`);
  if (before.receipts !== RECEIPTS.GIT) refuse("NO_RECEIPT_REGIME", `this loop was opened with receipts: ${before.receipts}`);

  const applied = store.commandRecords(commandId);
  if (applied !== null) return { seq: applied.at(-1).seq, records: applied, replayed: true };

  return store.withLock(CLASSES.GIT_INDEX, root, () => {
    const taken = takeReceipt({ root, mode, claims: before.claims, storeLocation: store.location });
    const payload = { ...taken, recorded_by: session };
    return store.append({
      commandId,
      requestDigest: digestOf({ mode, session, claims: before.claims }),
      prepare: (state) => {
        if (!isLive(state)) refuse("NOT_LIVE", `the loop is ${state.lifecycle}`);
        return [checked(KIND.RECEIPT, payload)];
      },
    });
  });
}

export async function observe(store, { root, session, commandId, timeoutMs, criterionFile, stuckThreshold }) {
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "an observation records who made it");
  const before = store.replay().state;
  if (!before.opened) refuse("NOT_OPEN", "no loop has been opened in this store");
  if (!isLive(before)) refuse("NOT_LIVE", `the loop is ${before.lifecycle}`);

  // A retry of a round that already landed must not run the criterion again.
  // Discovering the replay only at the append layer would mean paying for the
  // whole check — minutes, sometimes — to be told the work was already done.
  const alreadyApplied = store.commandRecords(commandId);
  if (alreadyApplied !== null) return { seq: alreadyApplied.at(-1).seq, records: alreadyApplied, replayed: true };

  const expectedRevision = before.revision;
  const round = roundsSpent(before) + 1;
  if (criterionDigestOf(criterionFile) !== before.criterionDigest) {
    refuse("CRITERION_CHANGED", "the criterion file no longer matches the one this loop was opened with");
  }

  const outcome = await runCriterion({ executable: process.execPath, args: [criterionFile], cwd: root, timeoutMs });
  const checkpoint = artifactCheckpoint(root, before.claims);

  // The receipt is re-verified here rather than taken on trust — and rather
  // than accepted from the caller, which is what this used to do and what made
  // the anchor axiom half-honoured. A receipt that no longer describes the task
  // paths is simply not in force: the round records the observation and says
  // why, instead of throwing away a criterion run that already happened.
  const standing = before.receipts === RECEIPTS.GIT
    ? receiptStanding({ root, receipt: before.receipt, claims: before.claims, storeLocation: store.location })
    : { standing: STANDING.NONE };
  const receiptDigest = standing.standing === STANDING.IN_FORCE ? before.receipt.digest : null;

  const signature = outcome.verdict === VERDICT.UNSATISFIED
    ? progressSignature({ criterionDigest: before.criterionDigest, artifactCheckpoint: checkpoint, receiptDigest, failures: outcome.failures })
    : null;

  return store.append({
    commandId,
    // The request, not the result: what the caller asked for is what makes a
    // retry recognisable. Digesting the outcome would make every retry look
    // like a different command, because the criterion may legitimately say
    // something new each time it runs.
    requestDigest: digestOf({ round, session, criterion: before.criterionDigest }),
    prepare: (state) => {
      // The optimistic check. It compares this loop's own revision, so a
      // neighbouring loop's activity can never invalidate this round — the
      // failure mode that made the previous implementation's certification
      // unusable under concurrency.
      if (state.revision !== expectedRevision) {
        refuse("ROUND_STALE", `the loop moved from revision ${expectedRevision} to ${state.revision} while the criterion ran`);
      }
      const observation = checked(KIND.OBSERVED, {
        round,
        verdict: outcome.verdict,
        progress_signature: signature,
        artifact_checkpoint: checkpoint,
        receipt_digest: receiptDigest,
        receipt_state: standing.standing,
        // The tail again, not the head. output_tail is already the end of what
        // the criterion printed; taking its first 2000 characters would throw
        // away precisely the part that says what went wrong.
        summary: outcome.execution.output_tail.slice(-2000),
        observed_by: session,
      });
      const projected = reduceLoop(state, { seq: state.revision + 1, ...observation });
      const verdictOfRound = decide(projected, { stuckThreshold });
      const records = [observation, checked(KIND.DECIDED, { round, decision: verdictOfRound.decision, reason: verdictOfRound.reason })];

      // A decision that ends or pauses the loop is written in the same command
      // as the observation that caused it: a reader can never find a loop that
      // was judged achieved but never closed.
      if (verdictOfRound.decision === DECISION.ACHIEVED) {
        records.push(checked(KIND.TERMINAL, { outcome: TERMINAL.ACHIEVED, reason: verdictOfRound.reason, receipt_digest: receiptDigest, granted_by: "self" }));
      } else if (verdictOfRound.decision === DECISION.SUSPEND) {
        records.push(checked(KIND.SUSPENDED, { outcome: verdictOfRound.suspension ?? SUSPENSION.NEEDS_INPUT, reason: verdictOfRound.reason, suspended_by: session }));
      } else if (verdictOfRound.decision === DECISION.STUCK) {
        records.push(checked(KIND.SUSPENDED, { outcome: SUSPENSION.NEEDS_INPUT, reason: verdictOfRound.reason, suspended_by: session }));
      }
      return records;
    },
  });
}

// Pausing and resuming are decisions about someone else's work unless the
// session making them is part of the loop. Knowing a loop's address is not
// the same as having standing to move it.
const assertParticipant = (state, session) => {
  if (!state.participants.includes(session)) {
    refuse("NOT_A_PARTICIPANT", `session ${session} has not taken part in this loop`);
  }
};

export function suspend(store, { outcome, reason, session, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ outcome, reason, session }),
    prepare: (state) => {
      if (!isLive(state)) refuse("NOT_LIVE", `the loop is already ${state.lifecycle}`);
      assertParticipant(state, session);
      return [checked(KIND.SUSPENDED, { outcome, reason, suspended_by: session })];
    },
  });
}

export function resume(store, { reason, session, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ reason, session }),
    prepare: (state) => {
      if (state.lifecycle !== "suspended") refuse("NOT_SUSPENDED", `the loop is ${state.lifecycle}`);
      assertParticipant(state, session);
      return [checked(KIND.RESUMED, { reason, resumed_by: session })];
    },
  });
}

// Joining is how a new session gains standing. It is deliberately explicit:
// the alternative is standing that accrues by accident.
export function join(store, { session, reason, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ session, reason }),
    prepare: (state) => {
      if (!state.opened) refuse("NOT_OPEN", "no loop has been opened in this store");
      if (state.lifecycle === "terminal") refuse("ALREADY_TERMINAL", "a finished loop cannot be joined");
      if (state.participants.includes(session)) refuse("ALREADY_PARTICIPANT", `session ${session} is already taking part`);
      return [checked(KIND.JOINED, { session, reason })];
    },
  });
}

// Changing what the loop is for is a person's act, never the runtime's, so the
// vocabulary itself refuses any provenance but "user".
export function amend(store, { roundsBudget = null, criterionFile = null, goal = null, reason, commandId }) {
  const criterionDigest = criterionFile === null ? null : criterionDigestOf(criterionFile);
  const payload = { rounds_budget: roundsBudget, criterion_digest: criterionDigest, goal, reason, granted_by: "user" };
  return store.append({
    commandId,
    requestDigest: digestOf(payload),
    prepare: (state) => {
      if (state.lifecycle === "terminal") refuse("ALREADY_TERMINAL", "a finished loop cannot be amended");
      return [checked(KIND.AMENDED, payload)];
    },
  });
}

export function abandon(store, { reason, commandId }) {
  const payload = { outcome: TERMINAL.ABANDONED, reason, receipt_digest: null, granted_by: "user" };
  return store.append({
    commandId,
    requestDigest: digestOf(payload),
    prepare: (state) => {
      if (state.lifecycle === "terminal") refuse("ALREADY_TERMINAL", "the loop is already finished");
      return [checked(KIND.TERMINAL, payload)];
    },
  });
}
