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
  goal: "make it green", claims: ["src"], criterion_digest: CRITERION, rounds_budget: budget, opened_by: "s1", receipts, depends_on: [],
});
const observed = (round, verdict, { signature = null, failures = [], checkpoint = CHECKPOINT(round), receipt = digestOf({ r: round }), receiptState = "in_force", dependencyState = "none" } = {}) =>
  record(KIND.OBSERVED, {
    round, verdict, progress_signature: signature, failures, artifact_checkpoint: checkpoint,
    receipt_digest: receipt, receipt_state: receiptState, dependency_state: dependencyState, summary: "", observed_by: "s1",
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

test("a round that recorded an unmet dependency blocks, with no help from the caller", () => {
  // The gate's answer was written into the round, so the policy can reach it
  // from the log alone — which is what lets a plain reader of the ledger see
  // why a satisfied loop was not certified.
  const blocked = fold([opened(3, RECEIPTS.NONE), observed(1, VERDICT.SATISFIED, { dependencyState: "unmet" })]);
  assert.equal(decide(blocked).decision, DECISION.BLOCKED);
  assert.notEqual(decide(blocked).terminal, true, "blocked is not an ending");
  // A caller that has just re-checked overrides the record: the round says
  // what was true then, not what is true now.
  assert.equal(decide(blocked, { dependency: { state: "satisfied", unmet: [] } }).decision, DECISION.ACHIEVED);
});

test("SL-13: an amendment that changes the terms retires the judgments made under the old ones", () => {
  const stale = { signature: digestOf({ f: "measured by the old rule" }) };
  const before = fold([opened(5), observed(1, VERDICT.UNSATISFIED, stale)]);
  assert.equal(decide(before).decision, DECISION.REPAIR);
  assert.ok(nextDirective(before).feedback, "while the terms hold, the failure is what to repair");

  // A different criterion measured a different thing; a different goal asked a
  // different question. Handing that verdict back as feedback would send an
  // agent to fix a rule that is no longer asked for.
  for (const change of [{ criterion_digest: digestOf({ criterion: 2 }), goal: null }, { criterion_digest: null, goal: "something else" }]) {
    const after = reduceLoop(before, record(KIND.AMENDED, {
      rounds_budget: null, reason: "the terms changed", granted_by: "user", ...change,
    }));
    assert.equal(decide(after).decision, DECISION.IMPLEMENT, "nothing has been observed under the terms now in force");
    assert.equal(nextDirective(after).feedback, null, "and no verdict from the old terms is offered as one");
    assert.equal(roundsSpent(after), 1, "the round still happened, and still costs");
  }

  // A budget change is not a change of terms: how much may still be spent is
  // not what counts as finished.
  const funded = reduceLoop(before, record(KIND.AMENDED, {
    rounds_budget: 9, criterion_digest: null, goal: null, reason: "more time", granted_by: "user",
  }));
  assert.equal(decide(funded).decision, DECISION.REPAIR, "the judgment still stands");
  assert.ok(nextDirective(funded).feedback);
});

test("SL-13: the same failure either side of an amendment is not the same failure", () => {
  const signature = digestOf({ f: "same text, different rule" });
  const records = [opened(10)];
  for (let round = 1; round <= DEFAULT_STUCK_THRESHOLD; round += 1) records.push(observed(round, VERDICT.UNSATISFIED, { signature }));
  assert.equal(decide(fold(records)).decision, DECISION.STUCK);

  // Retired rounds do not accumulate towards stuck: a loop is not stuck for
  // having failed three times against a rule nobody is asking about now.
  const amended = reduceLoop(fold(records), record(KIND.AMENDED, {
    rounds_budget: null, criterion_digest: digestOf({ criterion: 2 }), goal: null, reason: "new rule", granted_by: "user",
  }));
  assert.equal(repeatedFailures(amended), 0);
  assert.equal(decide(amended).decision, DECISION.IMPLEMENT);

  // The case that makes the filter load-bearing rather than redundant: only
  // the goal changed, so the criterion digest — and with it the signature — is
  // unchanged, and a fresh round can carry the very same one. Counting across
  // the amendment would call the loop stuck on its first round under the new
  // terms, on the strength of failures nobody is asking about any more.
  const regoaled = reduceLoop(fold(records), record(KIND.AMENDED, {
    rounds_budget: null, criterion_digest: null, goal: "a different question", reason: "new goal", granted_by: "user",
  }));
  const fresh = reduceLoop(regoaled, observed(DEFAULT_STUCK_THRESHOLD + 1, VERDICT.UNSATISFIED, { signature }));
  assert.equal(repeatedFailures(fresh), 1, "one failure under the terms in force, not four");
  assert.equal(decide(fresh).decision, DECISION.REPAIR);
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

test("a round written before failures were recorded still folds, and says nothing rather than undefined", () => {
  // Records already in a log are never rewritten, so this shape is permanent.
  // Adding a field to a projection is how retired judgments once came back to
  // life (slice 8 §3.1); the snapshot stamp catches a stale cache, but nothing
  // catches a reader that assumes every record has every field.
  const { failures, ...withoutTheField } = observed(1, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }) }).payload;
  void failures;
  const old = { seq: 99, kind: KIND.OBSERVED, payload: withoutTheField };
  const state = fold([opened(), old]);

  assert.deepEqual(state.rounds[0].failures, [], "absent is empty, not undefined");
  const directive = nextDirective(state);
  assert.deepEqual(directive.feedback.failures, [], "and the directive carries a list either way");
  assert.equal(directive.decision, DECISION.REPAIR, "the rest of the round still reads normally");
});

test("the directive hands back what failed, not only the prose about it", () => {
  const state = fold([opened(), observed(1, VERDICT.UNSATISFIED, { signature: digestOf({ f: "a" }), failures: ["missing-alpha", "missing-beta"] })]);
  const directive = nextDirective(state);
  assert.equal(directive.decision, DECISION.REPAIR);
  assert.deepEqual(directive.feedback.failures, ["missing-alpha", "missing-beta"]);
  // A copy: a caller that sorts or splices the directive must not reach back
  // into the projection every later reader shares.
  directive.feedback.failures.push("invented");
  assert.deepEqual(nextDirective(state).feedback.failures, ["missing-alpha", "missing-beta"]);
});
