// The read-only face: status, log, export.
//
// Nothing here writes. Not a snapshot, not a tail repair, not a lock — asking
// what a loop is doing must never be the thing that changes it, or a person
// debugging a stuck loop can never be sure whether they are watching it or
// disturbing it.
import { refuse } from "./error.mjs";
import { dependencyState } from "./graph.mjs";
import { ancestryCheck, loopOf, next } from "./loop.mjs";
import { unrecordedCommits } from "./receipt.mjs";
import { isStale, roundsSpent } from "./projection.mjs";

/**
 * Everything known about one loop, plus the step it would be given.
 *
 * The directive here *is* `next`'s answer — the same function, not a second
 * implementation of the same rules. Two of them would drift, and the one a
 * person reads would stop being the one a host obeys.
 */
export function status(store, { loopId, root, ...options } = {}) {
  const { state } = store.replay();
  const loop = loopOf(state, loopId);
  const rounds = loop.rounds.map((round) => ({
    round: round.round,
    // Marked, not hidden: it happened, it just no longer answers the question
    // the loop is now asking.
    stale: isStale(loop, round),
    verdict: round.verdict,
    // So "which check failed in round 1" is a question the ledger answers,
    // instead of one that sends the reader back into the summary text.
    failures: [...round.failures],
    decision: round.decision,
    receipt_state: round.receiptState,
    dependency_state: round.dependencyState,
    artifact_checkpoint: round.artifactCheckpoint,
  }));
  return {
    loop_id: loop.id,
    goal: loop.goal,
    claims: [...loop.claims],
    criterion_digest: loop.criterionDigest,
    receipts: loop.receipts,
    lifecycle: loop.lifecycle,
    suspension: loop.suspension,
    outcome: loop.outcome,
    certification: loop.certification,
    revision: loop.revision,
    participants: [...loop.participants],
    depends_on: loop.dependsOn.map((edge) => ({ ...edge })),
    dependency: dependencyState(loop, state, { ...options, ...ancestryCheck(root) }),
    rounds_spent: roundsSpent(loop),
    rounds_budget: loop.roundsBudget,
    rounds,
    receipt: loop.receipt === null ? null : {
      digest: loop.receipt.digest, mode: loop.receipt.mode, status: loop.receipt.status,
      commit_oid: loop.receipt.commit_oid, paths: [...loop.receipt.paths],
    },
    // Commits this loop made that no record names. A fact about the repository,
    // not a step for the loop: putting it in the directive would stop the loop
    // on something it cannot itself resolve.
    unrecorded_commits: root === undefined || loop.receipts !== "git"
      ? null
      : unrecordedCommits({
        root,
        loopId,
        recordedCommands: new Set(store.read()
          .filter((record) => record.kind === "loop_receipt" && record.payload.loop_id === loopId)
          .map((record) => record.cmd)),
      }),
    next: next(store, { loopId, root, ...options }),
  };
}

/**
 * The records themselves, optionally narrowed to one loop.
 *
 * Records, not a reading of them. A person has to be able to hold this next to
 * the bytes on disk and see the same thing; a summary that cannot be checked
 * against the log is a second source of truth.
 */
export function log(store, { loopId = null, fromSeq = 1, limit = null } = {}) {
  const records = store.read({ fromSeq })
    .filter((record) => loopId === null || record.payload?.loop_id === loopId || record.digest === loopId);
  if (limit === null) return records;
  if (!Number.isSafeInteger(limit) || limit < 1) refuse("BAD_LIMIT", "limit must be a positive integer");
  // The tail, not the head: what a person wants when they cap the output is
  // what happened most recently.
  return records.slice(-limit);
}

/**
 * A self-contained, independently checkable copy of the whole ledger.
 *
 * This is the answer to a property the design accepts on purpose: a store
 * lives in the root it describes, so deleting the root deletes the history.
 * Exporting is how a person keeps it — and it has to be done *before*, which
 * is exactly the kind of thing nobody remembers, so it is said plainly in the
 * documentation rather than left to be discovered.
 *
 * There is no import. Restoring a store would mean forging the physical anchor
 * that says "this identity belongs to this place", and an anchor that can be
 * forged tells you nothing. An export is for keeping and auditing.
 */
export function exportStore(store) {
  const records = store.read();
  return {
    export_schema: 1,
    manifest: { ...store.manifest },
    head_digest: records.length === 0 ? null : records.at(-1).digest,
    record_count: records.length,
    records,
  };
}
