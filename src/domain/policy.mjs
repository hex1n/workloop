// The default policy: mechanical, deterministic, and testable without a model.
//
// It answers one question — given what the log says, what is the next legal
// step — and it answers it the same way every time. No language model is
// involved, because a policy that cannot be evaluated cannot be improved: you
// could never tell "the strategy worked" from "the model happened to succeed".
import { digestOf } from "../canonical.mjs";
import { DECISION, SUSPENSION, VERDICT } from "./vocabulary.mjs";
import { isLive, lastRound, repeatedFailures, roundsSpent } from "./projection.mjs";

export const DEFAULT_STUCK_THRESHOLD = 3;

// Binds a failure to the world it happened in. Two failures are "the same"
// only when the criterion, the artifacts, the receipt and the reported failure
// identifiers all match — so a loop that is changing the code still counts as
// making progress even while the error message stays the same.
export function progressSignature({ criterionDigest, artifactCheckpoint, receiptDigest = null, failures = [] }) {
  const identifiers = failures
    .map((failure) => (typeof failure === "string" ? failure : failure?.id))
    .filter((id) => typeof id === "string" && id.length > 0)
    .sort();
  // A criterion that reported nothing identifiable gives no signature at all.
  // Inventing one from free text would make unrelated failures look identical
  // and stall a loop that is still moving.
  if (identifiers.length === 0) return null;
  return digestOf({ criterionDigest, artifactCheckpoint, receiptDigest, identifiers });
}

/**
 * Decides the next step. Pure: same state in, same decision out.
 * Order is load-bearing — budget is checked before new work is proposed, and
 * a terminal loop answers the same thing forever.
 */
export function decide(state, { stuckThreshold = DEFAULT_STUCK_THRESHOLD } = {}) {
  if (!state.opened) return { decision: DECISION.IMPLEMENT, reason: "the loop is not open yet" };
  if (state.lifecycle === "terminal") {
    return { decision: state.outcome === "achieved" ? DECISION.ACHIEVED : DECISION.STUCK, reason: `the loop is already ${state.outcome}`, terminal: true };
  }
  if (!isLive(state)) {
    return { decision: DECISION.SUSPEND, suspension: state.suspension, reason: `the loop is suspended: ${state.suspension}`, terminal: false };
  }

  const last = lastRound(state);
  if (last !== null && last.verdict === VERDICT.SATISFIED) {
    return { decision: DECISION.ACHIEVED, reason: "the criterion is satisfied", terminal: true };
  }

  // Checked before proposing work, so a loop out of budget stops asking for
  // more instead of running one round past its limit.
  if (roundsSpent(state) >= state.roundsBudget) {
    return { decision: DECISION.SUSPEND, suspension: SUSPENSION.OUT_OF_BUDGET, reason: `all ${state.roundsBudget} rounds are spent`, terminal: false };
  }

  if (last === null) return { decision: DECISION.IMPLEMENT, reason: "no round has been observed yet" };
  if (last.verdict === VERDICT.INDETERMINATE) {
    return { decision: DECISION.COLLECT_EVIDENCE, reason: "the criterion could not reach a verdict" };
  }

  const repeats = repeatedFailures(state);
  if (repeats >= stuckThreshold) {
    return { decision: DECISION.STUCK, reason: `the same failure survived ${repeats} rounds with no change in the artifacts`, terminal: false };
  }
  if (last.receiptDigest === null) {
    return { decision: DECISION.PRODUCE_RECEIPT, reason: "the last round changed things without producing a receipt" };
  }
  return { decision: DECISION.REPAIR, reason: "the criterion is unsatisfied and the failure is new" };
}

// The directive is what a host is handed. It is derived, not stored: while the
// state does not move, asking again returns the same thing, byte for byte.
export function nextDirective(state, options = {}) {
  const outcome = decide(state, options);
  const last = lastRound(state);
  return {
    round: roundsSpent(state) + 1,
    decision: outcome.decision,
    reason: outcome.reason,
    terminal: outcome.terminal === true,
    goal: state.goal,
    claims: [...state.claims],
    criterion_digest: state.criterionDigest,
    rounds_remaining: Math.max(0, state.roundsBudget - roundsSpent(state)),
    // The feedback a repair round needs: what failed last time, and against
    // which artifacts. Absent on the first round, which has nothing to repair.
    feedback: last === null ? null : {
      verdict: last.verdict,
      progress_signature: last.progressSignature,
      artifact_checkpoint: last.artifactCheckpoint,
      summary: last.summary,
    },
  };
}
