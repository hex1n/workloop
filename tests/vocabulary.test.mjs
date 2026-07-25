// Slice 2: the declarative vocabulary. The property being protected is that
// adding or changing a kind is a data change, so the cost of keeping the
// vocabulary honest never rises with its size.
import assert from "node:assert/strict";
import test from "node:test";
import { digestOf } from "../src/canonical.mjs";
import { VocabularyError, createVocabulary } from "../src/vocabulary.mjs";

const vocabulary = createVocabulary({
  loop_opened: {
    fields: {
      goal: { type: "string", max: 500 },
      claims: { type: "strings", max: 64 },
      criterion_digest: { type: "digest" },
      rounds_budget: { type: "integer", min: 1, max: 1000 },
    },
  },
  round_observed: {
    fields: {
      verdict: { type: "enum", values: ["satisfied", "unsatisfied", "indeterminate"] },
      failure_signature: { type: "digest", nullable: true },
      artifact_checkpoint: { type: "digest" },
    },
  },
});

const opened = { goal: "make it green", claims: ["src"], criterion_digest: digestOf({ c: 1 }), rounds_budget: 3 };

test("a payload that matches its descriptor is accepted unchanged", () => {
  assert.equal(vocabulary.assert("loop_opened", opened), opened);
  assert.deepEqual(vocabulary.kinds(), ["loop_opened", "round_observed"]);
});

test("an unknown kind fails closed rather than passing through unvalidated", () => {
  assert.throws(() => vocabulary.assert("invented", {}), (error) => error instanceof VocabularyError && error.code === "UNKNOWN_KIND");
});

test("fields must match exactly, so a fact nobody agreed to carry cannot ride along", () => {
  // A superset would be quietly dropped by the next reader, which is worse than
  // a refusal: the writer would believe it had recorded something.
  assert.throws(() => vocabulary.assert("loop_opened", { ...opened, extra: 1 }), (error) => error.code === "PAYLOAD_FIELDS");
  const { goal, ...missing } = opened;
  void goal;
  assert.throws(() => vocabulary.assert("loop_opened", missing), (error) => error.code === "PAYLOAD_FIELDS");
});

test("each field type is enforced, with its bounds", () => {
  const cases = [
    [{ goal: "" }, "empty string"],
    [{ goal: "x".repeat(501) }, "over max length"],
    [{ goal: 5 }, "wrong type"],
    [{ claims: "src" }, "string where a list belongs"],
    [{ claims: [""] }, "empty item"],
    [{ claims: Array.from({ length: 65 }, (_, index) => `c${index}`) }, "over list max"],
    [{ criterion_digest: "sha256:short" }, "malformed digest"],
    [{ rounds_budget: 0 }, "under min"],
    [{ rounds_budget: 1001 }, "over max"],
    [{ rounds_budget: 1.5 }, "not an integer"],
  ];
  for (const [changes, why] of cases) {
    assert.throws(() => vocabulary.assert("loop_opened", { ...opened, ...changes }), (error) => error.code === "PAYLOAD_FIELD", why);
  }
});

test("enums accept only their declared values", () => {
  const observed = { verdict: "satisfied", failure_signature: null, artifact_checkpoint: digestOf({ a: 1 }) };
  assert.equal(vocabulary.assert("round_observed", observed), observed);
  assert.throws(() => vocabulary.assert("round_observed", { ...observed, verdict: "maybe" }), (error) => error.code === "PAYLOAD_FIELD");
});

test("nullable is explicit: only fields declared nullable may be null", () => {
  const observed = { verdict: "unsatisfied", failure_signature: null, artifact_checkpoint: digestOf({ a: 1 }) };
  assert.equal(vocabulary.assert("round_observed", observed).failure_signature, null);
  assert.throws(
    () => vocabulary.assert("round_observed", { ...observed, artifact_checkpoint: null }),
    (error) => error.code === "PAYLOAD_FIELD",
  );
});

test("a malformed descriptor is refused when the vocabulary is built, not when it is used", () => {
  // The alternative is discovering a typo in a descriptor at the moment a real
  // command needs to be written.
  assert.throws(() => createVocabulary({ bad: { fields: { x: { type: "unheard_of" } } } }), (error) => error.code === "BAD_DESCRIPTOR");
  assert.throws(() => createVocabulary({ bad: { fields: { x: { type: "enum" } } } }), (error) => error.code === "BAD_DESCRIPTOR");
  assert.throws(() => createVocabulary({ bad: {} }), (error) => error.code === "BAD_DESCRIPTOR");
});

test("adding a kind is a data change, not a code change", () => {
  // The point of the whole file: this test adds vocabulary without touching
  // any validation logic.
  const extended = createVocabulary({
    loop_opened: { fields: { goal: { type: "string" }, claims: { type: "strings" }, criterion_digest: { type: "digest" }, rounds_budget: { type: "integer", min: 1 } } },
    loop_suspended: { fields: { outcome: { type: "enum", values: ["out_of_budget", "needs_input"] }, reason: { type: "string" } } },
  });
  assert.deepEqual(extended.kinds(), ["loop_opened", "loop_suspended"]);
  assert.ok(extended.assert("loop_suspended", { outcome: "out_of_budget", reason: "three rounds spent" }));
});
