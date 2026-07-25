// The loop service: the verbs a host drives.
//
// One call advances one transition. There is no background runner, no timer,
// and no path by which this file executes the work it asks for — it decides
// what the next legal step is and records what came back.
import fs from "node:fs";
import path from "node:path";
import { digestOf, sha256Hex } from "../canonical.mjs";
import { openStore } from "../store.mjs";
import { runCriterion } from "./criterion.mjs";
import { decide, nextDirective, progressSignature } from "./policy.mjs";
import { EMPTY, isLive, reduceLoop, roundsSpent } from "./projection.mjs";
import { DECISION, KIND, SUSPENSION, TERMINAL, VERDICT, loopVocabulary } from "./vocabulary.mjs";

export class LoopError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LoopError";
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new LoopError(code, message);
};

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
export function artifactCheckpoint(root, claims) {
  const entries = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      entries.push([relative, null]);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative, name));
      return;
    }
    entries.push([relative, sha256Hex(fs.readFileSync(absolute))]);
  };
  for (const claim of [...claims].sort()) walk(claim);
  return digestOf(entries);
}

export function openLoop(store, { goal, claims, criterionFile, roundsBudget, session, commandId }) {
  if (typeof goal !== "string" || goal.trim().length === 0) refuse("GOAL_REQUIRED", "a loop needs a goal");
  if (!Array.isArray(claims) || claims.length === 0) refuse("CLAIMS_REQUIRED", "a loop needs at least one write claim");
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "a loop records who opened it");
  const criterionDigest = criterionDigestOf(criterionFile);
  const payload = { goal, claims: [...claims].sort(), criterion_digest: criterionDigest, rounds_budget: roundsBudget, opened_by: session };
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
export async function observe(store, { root, receiptDigest = null, session, commandId, timeoutMs, criterionFile, stuckThreshold }) {
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "an observation records who made it");
  const before = store.replay().state;
  if (!before.opened) refuse("NOT_OPEN", "no loop has been opened in this store");
  if (!isLive(before)) refuse("NOT_LIVE", `the loop is ${before.lifecycle}`);

  const expectedRevision = before.revision;
  const round = roundsSpent(before) + 1;
  if (criterionDigestOf(criterionFile) !== before.criterionDigest) {
    refuse("CRITERION_CHANGED", "the criterion file no longer matches the one this loop was opened with");
  }

  const outcome = await runCriterion({ executable: process.execPath, args: [criterionFile], cwd: root, timeoutMs });
  const checkpoint = artifactCheckpoint(root, before.claims);
  const signature = outcome.verdict === VERDICT.UNSATISFIED
    ? progressSignature({ criterionDigest: before.criterionDigest, artifactCheckpoint: checkpoint, receiptDigest, failures: outcome.failures })
    : null;

  return store.append({
    commandId,
    requestDigest: digestOf({ round, checkpoint, receiptDigest, verdict: outcome.verdict, signature }),
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
        summary: outcome.execution.output_tail.slice(0, 2000),
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

export function suspend(store, { outcome, reason, session, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ outcome, reason }),
    prepare: (state) => {
      if (!isLive(state)) refuse("NOT_LIVE", `the loop is already ${state.lifecycle}`);
      return [checked(KIND.SUSPENDED, { outcome, reason, suspended_by: session })];
    },
  });
}

export function resume(store, { reason, session, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ reason }),
    prepare: (state) => {
      if (state.lifecycle !== "suspended") refuse("NOT_SUSPENDED", `the loop is ${state.lifecycle}`);
      return [checked(KIND.RESUMED, { reason, resumed_by: session })];
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
