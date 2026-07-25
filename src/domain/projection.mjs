// The loop projection: what the records add up to.
//
// A pure fold over the log. It holds no opinion about what to do next — that
// is the policy's job, and keeping the two apart is what lets the policy change
// without rewriting history.
import { KIND, RECEIPTS, TERMINAL, VERDICT } from "./vocabulary.mjs";

export const LIFECYCLE = Object.freeze({ ACTIVE: "active", SUSPENDED: "suspended", TERMINAL: "terminal" });

export const EMPTY = Object.freeze({
  opened: false,
  goal: null,
  claims: [],
  criterionDigest: null,
  roundsBudget: 0,
  // The evidence regime this loop was opened under, and the newest receipt
  // recorded for it. The receipt is carried by digest, not by copying its
  // facts: entities couple only through content addresses.
  receipts: RECEIPTS.NONE,
  receipt: null,
  lifecycle: LIFECYCLE.ACTIVE,
  suspension: null,
  outcome: null,
  rounds: [],
  // Who is entitled to move this loop. Membership is earned by opening it or
  // by observing a round, never by simply knowing its address.
  participants: [],
  revision: 0,
});

const clone = (state) => ({
  ...state,
  claims: [...state.claims],
  participants: [...state.participants],
  rounds: state.rounds.map((round) => ({ ...round })),
});

export function reduceLoop(state = EMPTY, record) {
  const next = clone(state ?? EMPTY);
  // Every record moves the revision, which is what optimistic concurrency
  // compares against. It counts records, not rounds, so any change at all is
  // visible to a caller that thought it knew the state.
  next.revision = record.seq;
  const payload = record.payload;
  switch (record.kind) {
    case KIND.OPENED:
      next.opened = true;
      next.goal = payload.goal;
      next.claims = [...payload.claims];
      next.criterionDigest = payload.criterion_digest;
      next.roundsBudget = payload.rounds_budget;
      next.receipts = payload.receipts;
      next.participants = [payload.opened_by];
      break;
    case KIND.RECEIPT:
      if (!next.participants.includes(payload.recorded_by)) next.participants.push(payload.recorded_by);
      // Only the newest receipt stands. An older one describes a state of the
      // task paths that a later receipt has already superseded.
      // The seq is what lets the policy tell "no receipt yet" from "a receipt
      // arrived after the last round was judged" — a distinction the loop
      // cannot escape a directive loop without.
      next.receipt = { ...payload, digest: record.digest ?? null, seq: record.seq };
      break;
    case KIND.OBSERVED:
      if (!next.participants.includes(payload.observed_by)) next.participants.push(payload.observed_by);
      next.rounds.push({
        seq: record.seq,
        round: payload.round,
        verdict: payload.verdict,
        progressSignature: payload.progress_signature,
        artifactCheckpoint: payload.artifact_checkpoint,
        receiptDigest: payload.receipt_digest,
        receiptState: payload.receipt_state,
        summary: payload.summary,
        decision: null,
      });
      break;
    case KIND.DECIDED: {
      const round = next.rounds.find((entry) => entry.round === payload.round);
      if (round !== undefined) round.decision = payload.decision;
      break;
    }
    case KIND.JOINED:
      if (!next.participants.includes(payload.session)) next.participants.push(payload.session);
      break;
    case KIND.SUSPENDED:
      next.lifecycle = LIFECYCLE.SUSPENDED;
      next.suspension = payload.outcome;
      break;
    case KIND.RESUMED:
      next.lifecycle = LIFECYCLE.ACTIVE;
      next.suspension = null;
      break;
    case KIND.TERMINAL:
      next.lifecycle = LIFECYCLE.TERMINAL;
      next.outcome = payload.outcome;
      break;
    case KIND.AMENDED:
      if (payload.rounds_budget !== null) next.roundsBudget = payload.rounds_budget;
      if (payload.criterion_digest !== null) next.criterionDigest = payload.criterion_digest;
      if (payload.goal !== null) next.goal = payload.goal;
      break;
    default:
      // Kernel records (tail repairs, the store's own genesis) pass through:
      // they move the revision and nothing else, which is exactly right — they
      // are facts about the log, not about the loop.
      break;
  }
  return next;
}

export const roundsSpent = (state) => state.rounds.length;
export const lastRound = (state) => (state.rounds.length === 0 ? null : state.rounds.at(-1));
export const isLive = (state) => state.lifecycle === LIFECYCLE.ACTIVE;
export const achieved = (state) => state.lifecycle === LIFECYCLE.TERMINAL && state.outcome === TERMINAL.ACHIEVED;

// How many times in a row the most recent progress signature has been seen.
// A null signature never counts: three silences are not three of the same
// failure, and treating them as one would stop a loop that is still moving.
export function repeatedFailures(state) {
  const last = lastRound(state);
  if (last === null || last.progressSignature === null || last.verdict !== VERDICT.UNSATISFIED) return 0;
  let count = 0;
  for (let index = state.rounds.length - 1; index >= 0; index -= 1) {
    if (state.rounds[index].progressSignature !== last.progressSignature) break;
    count += 1;
  }
  return count;
}
