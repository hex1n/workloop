// The default policy and the projection it reads. Both are pure, so these
// tests need no store and no filesystem — which is the point: the rule that
// decides what an agent does next must be checkable without running anything.
import assert from "node:assert/strict";
import test from "node:test";
import { digestOf } from "../src/canonical.mjs";
import { EMPTY, reduceLoop, repeatedFailures, roundsSpent } from "../src/domain/projection.mjs";
import { DEFAULT_STUCK_THRESHOLD, decide, nextDirective, progressSignature } from "../src/domain/policy.mjs";
import { DECISION, KIND, RECEIPTS, SUSPENSION, TERMINAL, VERDICT } from "../src/domain/vocabulary.mjs";

const CRITERION = digestOf({ criterion: 1 });
const CHECKPOINT = (value) => digestOf({ artifacts: value });
let seq = 0;
const record = (kind, payload) => ({ seq: (seq += 1), kind, payload });
const fold = (records) => records.reduce((state, entry) => reduceLoop(state, entry), EMPTY);

const opened = (budget = 3, receipts = RECEIPTS.NONE) => record(KIND.OPENED, {
  goal: "make it green", claims: ["src"], criterion_digest: CRITERION, rounds_budget: budget, opened_by: "s1", receipts,
});
const observed = (round, verdict, { signature = null, checkpoint = CHECKPOINT(round), receipt = digestOf({ r: round }), receiptState = "in_force" } = {}) =>
  record(KIND.OBSERVED, {
    round, verdict, progress_signature: signature, artifact_checkpoint: checkpoint,
    receipt_digest: receipt, receipt_state: receiptState, summary: "", observed_by: "s1",
  });

test("an unopened loop asks for implementation and nothing else", () => {
  assert.equal(decide(EMPTY).decision, DECISION.IMPLEMENT);
});

test("a fresh loop asks for implementation; a satisfied one is achieved", () => {
  const fresh = fold([opened()]);
  assert.equal(decide(fresh).decision, DECISION.IMPLEMENT);
  assert.equal(decide(fold([opened(), observed(1, VERDICT.SATISFIED)])).decision, DECISION.ACHIEVED);
});

test("an unsatisfied round with a new failure asks for repair", () => {
  const state = fold([opened(), observed(1, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }) })]);
  assert.equal(decide(state).decision, DECISION.REPAIR);
});

test("under the git regime, a round with no receipt in force asks for one first", () => {
  const unreceipted = { signature: digestOf({ f: "a" }), receipt: null, receiptState: "none" };
  const state = fold([opened(3, RECEIPTS.GIT), observed(1, VERDICT.UNSATISFIED, unreceipted)]);
  assert.equal(decide(state).decision, DECISION.PRODUCE_RECEIPT);
  // A loop that declared no receipt regime has no way to produce one, so it is
  // never handed a directive it cannot discharge.
  assert.equal(decide(fold([opened(3, RECEIPTS.NONE), observed(1, VERDICT.UNSATISFIED, unreceipted)])).decision, DECISION.REPAIR);
});

test("GR-06/07: a satisfied criterion is not an achievement while its receipt is absent", () => {
  const drifted = { receipt: null, receiptState: "drifted" };
  const state = fold([opened(3, RECEIPTS.GIT), observed(1, VERDICT.SATISFIED, drifted)]);
  const outcome = decide(state);
  assert.equal(outcome.decision, DECISION.PRODUCE_RECEIPT, "passing over artifacts nothing vouches for is not achieved");
  assert.match(outcome.reason, /drifted/u, "the log says which of the ways it failed to hold");
  assert.notEqual(outcome.terminal, true, "and the loop stays open");
  // The same round with the receipt standing certifies.
  assert.equal(decide(fold([opened(3, RECEIPTS.GIT), observed(1, VERDICT.SATISFIED)])).decision, DECISION.ACHIEVED);
});

test("an indeterminate verdict asks for evidence rather than counting as failure", () => {
  const state = fold([opened(), observed(1, VERDICT.INDETERMINATE)]);
  assert.equal(decide(state).decision, DECISION.COLLECT_EVIDENCE);
  assert.equal(repeatedFailures(state), 0, "an indeterminate round is not a repeated failure");
});

test("the same failure repeated to the threshold is stuck", () => {
  const signature = digestOf({ f: "same" });
  const records = [opened(10)];
  for (let round = 1; round <= DEFAULT_STUCK_THRESHOLD; round += 1) records.push(observed(round, VERDICT.UNSATISFIED, { signature }));
  const state = fold(records);
  assert.equal(repeatedFailures(state), DEFAULT_STUCK_THRESHOLD);
  assert.equal(decide(state).decision, DECISION.STUCK);
});

test("a changed failure resets the count, so a moving loop is never called stuck", () => {
  const records = [opened(10),
    observed(1, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }) }),
    observed(2, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }) }),
    observed(3, VERDICT.UNSATISFIED, { signature: digestOf({ f: "b" }) })];
  const state = fold(records);
  assert.equal(repeatedFailures(state), 1);
  assert.equal(decide(state).decision, DECISION.REPAIR);
});

test("a silent criterion never accumulates towards stuck", () => {
  // Three rounds where the criterion reported nothing identifiable are three
  // unknowns, not one failure seen three times. Treating them as stuck would
  // stop a loop for the crime of having a quiet checker.
  const records = [opened(10)];
  for (let round = 1; round <= 5; round += 1) records.push(observed(round, VERDICT.UNSATISFIED, { signature: null }));
  const state = fold(records);
  assert.equal(repeatedFailures(state), 0);
  assert.equal(decide(state).decision, DECISION.REPAIR);
});

test("budget is checked before more work is proposed", () => {
  const records = [opened(2),
    observed(1, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }) }),
    observed(2, VERDICT.UNSATISFIED, { signature: digestOf({ f: "b" }) })];
  const outcome = decide(fold(records));
  assert.equal(outcome.decision, DECISION.SUSPEND);
  assert.equal(outcome.suspension, SUSPENSION.OUT_OF_BUDGET);
  assert.equal(outcome.terminal, false, "running out of budget is recoverable, not an ending");
});

test("a satisfied verdict outranks an exhausted budget", () => {
  // The last round of the budget succeeding is a success, not a suspension.
  const records = [opened(1), observed(1, VERDICT.SATISFIED)];
  assert.equal(decide(fold(records)).decision, DECISION.ACHIEVED);
});

test("a suspended loop reports its suspension and asks for nothing", () => {
  const state = fold([opened(), record(KIND.SUSPENDED, { outcome: SUSPENSION.NEEDS_INPUT, reason: "which database?", suspended_by: "s1" })]);
  const outcome = decide(state);
  assert.equal(outcome.decision, DECISION.SUSPEND);
  assert.equal(outcome.suspension, SUSPENSION.NEEDS_INPUT);
  // And resuming puts it back to work.
  assert.equal(decide(reduceLoop(state, record(KIND.RESUMED, { reason: "postgres", resumed_by: "s2" }))).decision, DECISION.IMPLEMENT);
});

test("a terminal loop answers the same thing forever", () => {
  const state = fold([opened(), observed(1, VERDICT.SATISFIED),
    record(KIND.TERMINAL, { outcome: TERMINAL.ACHIEVED, reason: "done", receipt_digest: digestOf({ r: 1 }), granted_by: "self" })]);
  const first = decide(state);
  assert.equal(first.decision, DECISION.ACHIEVED);
  assert.equal(first.terminal, true);
  assert.deepEqual(decide(state), first);
  // Even records arriving afterwards cannot reopen it.
  assert.equal(decide(reduceLoop(state, record("unrelated_kernel_record", {}))).decision, DECISION.ACHIEVED);
});

test("an amendment changes the objective the policy reads", () => {
  const records = [opened(1), observed(1, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }) })];
  assert.equal(decide(fold(records)).decision, DECISION.SUSPEND);
  const amended = reduceLoop(fold(records), record(KIND.AMENDED, {
    rounds_budget: 5, criterion_digest: null, goal: null, reason: "more time", granted_by: "user",
  }));
  assert.equal(decide(amended).decision, DECISION.REPAIR, "more budget puts the loop back to work");
});

test("the directive is derived, so asking twice gives the same answer", () => {
  const state = fold([opened(), observed(1, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }) })]);
  assert.deepEqual(nextDirective(state), nextDirective(state));
  assert.equal(JSON.stringify(nextDirective(state)), JSON.stringify(nextDirective(state)));
});

test("a repair directive carries what failed last time", () => {
  const signature = digestOf({ f: "a" });
  const state = fold([opened(), observed(1, VERDICT.UNSATISFIED, { signature })]);
  const directive = nextDirective(state);
  assert.equal(directive.round, 2);
  assert.equal(directive.decision, DECISION.REPAIR);
  assert.equal(directive.feedback.progress_signature, signature);
  assert.equal(directive.rounds_remaining, 2);
  assert.equal(nextDirective(fold([opened()])).feedback, null, "the first round has nothing to repair");
});

test("a progress signature binds the failure to the world it happened in", () => {
  const base = { criterionDigest: CRITERION, artifactCheckpoint: CHECKPOINT(1), receiptDigest: digestOf({ r: 1 }), failures: [{ id: "test-a" }] };
  assert.equal(progressSignature(base), progressSignature({ ...base, failures: [{ id: "test-a" }] }));
  // Any of the four changing makes it a different failure.
  assert.notEqual(progressSignature(base), progressSignature({ ...base, artifactCheckpoint: CHECKPOINT(2) }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, criterionDigest: digestOf({ criterion: 2 }) }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, receiptDigest: digestOf({ r: 2 }) }));
  assert.notEqual(progressSignature(base), progressSignature({ ...base, failures: [{ id: "test-b" }] }));
  // Order of reported failures is not a difference.
  assert.equal(
    progressSignature({ ...base, failures: [{ id: "a" }, { id: "b" }] }),
    progressSignature({ ...base, failures: [{ id: "b" }, { id: "a" }] }),
  );
  // Nothing identifiable means no signature at all.
  assert.equal(progressSignature({ ...base, failures: [] }), null);
  assert.equal(progressSignature({ ...base, failures: [{ message: "boom" }] }), null);
});

test("the projection counts rounds and tracks revision", () => {
  const records = [opened(), observed(1, VERDICT.UNSATISFIED), record(KIND.DECIDED, { round: 1, decision: DECISION.REPAIR, reason: "r" })];
  const state = fold(records);
  assert.equal(roundsSpent(state), 1);
  assert.equal(state.rounds[0].decision, DECISION.REPAIR);
  // Revision follows the log's own sequence, so any record at all — including
  // one this domain does not understand — makes a stale caller's view stale.
  assert.equal(state.revision, records.at(-1).seq);
  assert.equal(reduceLoop(state, { seq: 999, kind: "kernel_record_of_some_kind", payload: {} }).revision, 999);
});
