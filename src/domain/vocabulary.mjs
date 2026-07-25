// The loop vocabulary: every kind this domain can write, as data.
//
// Adding a fact the loop can record means adding a descriptor here. Nothing in
// the kernel changes, and no validation code is written — that is the whole
// point of the seam.
import { createVocabulary } from "../vocabulary.mjs";
// The adapter owns these: it is what produces the values, so repeating the
// literals here would let the log and the code that writes it drift apart.
import { MAX_REASONS, MODE, STANDING, STATUS } from "./receipt.mjs";

export const KIND = Object.freeze({
  OPENED: "loop_opened",
  OBSERVED: "round_observed",
  DECIDED: "round_decided",
  JOINED: "loop_joined",
  SUSPENDED: "loop_suspended",
  RESUMED: "loop_resumed",
  TERMINAL: "loop_terminal",
  AMENDED: "loop_amended",
  RECEIPT: "loop_receipt",
});

// What a loop must show before it may be certified. Declared when the loop is
// opened and never inferred: this is the standard the loop is judged against,
// and a standard that changes because somebody ran `git init` halfway through
// is not a standard.
export const RECEIPTS = Object.freeze({ NONE: "none", GIT: "git" });

export const VERDICT = Object.freeze({ SATISFIED: "satisfied", UNSATISFIED: "unsatisfied", INDETERMINATE: "indeterminate" });

export const DECISION = Object.freeze({
  IMPLEMENT: "implement",
  PRODUCE_RECEIPT: "produce_receipt",
  REPAIR: "repair",
  COLLECT_EVIDENCE: "collect_evidence",
  // Evidence exists that no judgment has seen yet. The design's decision table
  // has always listed this ("有 receipt 未判断 → judge"); dropping it is what
  // let the runtime keep telling a host to produce a receipt it had already
  // produced, with nothing in the directive to lead the loop back out.
  JUDGE: "judge",
  // `review` is deliberately absent. The design lists it as an option beside
  // `stuck`, but nothing in this slice can produce a reviewer, and vocabulary
  // that nothing writes is exactly the residue the audit spent its time
  // removing. It returns when a reviewer does.
  STUCK: "stuck",
  ACHIEVED: "achieved",
  SUSPEND: "suspend",
});

export const SUSPENSION = Object.freeze({ OUT_OF_BUDGET: "out_of_budget", NEEDS_INPUT: "needs_input" });
export const TERMINAL = Object.freeze({ ACHIEVED: "achieved", ABANDONED: "abandoned" });

export const loopVocabulary = createVocabulary({
  [KIND.OPENED]: {
    fields: {
      goal: { type: "string", max: 1000 },
      claims: { type: "strings", max: 64 },
      criterion_digest: { type: "digest" },
      rounds_budget: { type: "integer", min: 1, max: 10_000 },
      opened_by: { type: "string", max: 200 },
      reason: { type: "string", max: 1000 },
      granted_by: { type: "enum", values: ["self", "user"] },
      receipts: { type: "enum", values: Object.values(RECEIPTS) },
    },
  },
  [KIND.OBSERVED]: {
    fields: {
      round: { type: "integer", min: 1 },
      verdict: { type: "enum", values: Object.values(VERDICT) },
      // Null when the criterion said nothing a signature could be built from.
      // A silent criterion must not look like a repeated failure.
      progress_signature: { type: "digest", nullable: true },
      artifact_checkpoint: { type: "digest" },
      receipt_digest: { type: "digest", nullable: true },
      // Why the receipt is or is not in force. `receipt_digest: null` alone
      // cannot tell "no receipt was ever produced" from "one was, and it has
      // since drifted" — two very different situations for whoever is reading
      // the log to find out what went wrong.
      receipt_state: { type: "enum", values: Object.values(STANDING) },
      summary: { type: "string", max: 2000, min: 0 },
      observed_by: { type: "string", max: 200 },
    },
  },
  [KIND.DECIDED]: {
    fields: {
      round: { type: "integer", min: 1 },
      decision: { type: "enum", values: Object.values(DECISION) },
      reason: { type: "string", max: 1000 },
    },
  },
  [KIND.JOINED]: {
    fields: {
      session: { type: "string", max: 200 },
      reason: { type: "string", max: 1000 },
    },
  },
  [KIND.SUSPENDED]: {
    fields: {
      outcome: { type: "enum", values: Object.values(SUSPENSION) },
      reason: { type: "string", max: 1000 },
      suspended_by: { type: "string", max: 200 },
    },
  },
  [KIND.RESUMED]: {
    fields: {
      reason: { type: "string", max: 1000 },
      resumed_by: { type: "string", max: 200 },
    },
  },
  [KIND.TERMINAL]: {
    fields: {
      outcome: { type: "enum", values: Object.values(TERMINAL) },
      reason: { type: "string", max: 1000 },
      // Present when the loop was achieved: the receipt the judgment rested on.
      receipt_digest: { type: "digest", nullable: true },
      granted_by: { type: "enum", values: ["self", "user"] },
    },
  },
  [KIND.AMENDED]: {
    fields: {
      rounds_budget: { type: "integer", min: 1, max: 10_000, nullable: true },
      criterion_digest: { type: "digest", nullable: true },
      goal: { type: "string", max: 1000, nullable: true },
      reason: { type: "string", max: 1000 },
      // Amending is a person changing what the loop is for, so it never
      // carries "self": the runtime may not rewrite its own objective.
      granted_by: { type: "enum", values: ["user"] },
    },
  },
  [KIND.RECEIPT]: {
    fields: {
      mode: { type: "enum", values: Object.values(MODE) },
      // Two states, because the runtime does not own the index and cannot
      // honestly offer a third. `clean` is witnessed, never inferred.
      status: { type: "enum", values: Object.values(STATUS) },
      // One more than the adapter's cap, for the line that says how many were
      // dropped.
      reasons: { type: "strings", max: MAX_REASONS + 1 },
      paths: { type: "strings", max: 4096 },
      head_before: { type: "string", max: 64, nullable: true },
      commit_oid: { type: "string", max: 64, nullable: true },
      parent_oid: { type: "string", max: 64, nullable: true },
      tree_digest: { type: "digest" },
      recorded_by: { type: "string", max: 200 },
    },
  },
});
