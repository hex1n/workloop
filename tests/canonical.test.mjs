// Property P0 (canonicalization is stable) from greenfield/slices/01-log-kernel.md.
import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalError, canonicalJson, digestOf } from "../src/canonical.mjs";

const shuffled = (object) => {
  const keys = Object.keys(object);
  const out = {};
  for (const key of [...keys].reverse()) out[key] = object[key];
  return out;
};

test("key order in the input never reaches the output", () => {
  const value = { b: 1, a: 2, "": 3, "0": 4, "é": 5, "Z": 6 };
  assert.equal(canonicalJson(value), canonicalJson(shuffled(value)));
  // Code-unit order, not JavaScript's own property order: "0" is an integer-like
  // key and would come first in Object.keys, but "" sorts before it.
  assert.equal(canonicalJson(value), '{"":3,"0":4,"Z":6,"a":2,"b":1,"é":5}');
});

test("nesting, arrays, and Unicode round-trip to identical bytes", () => {
  const value = {
    nested: { deep: [1, { z: "🙂", a: "́e" }, []] },
    surrogate: "🙂",
    combining: "é",
    empty: {},
  };
  assert.equal(canonicalJson(value), canonicalJson(JSON.parse(canonicalJson(value))));
  assert.equal(digestOf(value), digestOf(JSON.parse(canonicalJson(value))));
});

test("a lone surrogate is escaped rather than emitted raw", () => {
  const encoded = canonicalJson({ lone: "\ud800" });
  assert.equal(encoded, '{"lone":"\\ud800"}');
  assert.equal(canonicalJson(JSON.parse(encoded)), encoded);
});

test("array order is data and is preserved", () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("values with no reproducible form are refused, not coerced", () => {
  const cases = [
    [{ n: Number.NaN }, "NON_FINITE_NUMBER"],
    [{ n: Number.POSITIVE_INFINITY }, "NON_FINITE_NUMBER"],
    // -0 would silently serialize as 0, letting two different inputs claim one digest.
    [{ n: -0 }, "NEGATIVE_ZERO"],
    [{ n: 1n }, "UNSUPPORTED_TYPE"],
    [{ n: undefined }, "UNSUPPORTED_TYPE"],
    [{ n: () => {} }, "UNSUPPORTED_TYPE"],
    [{ n: Symbol("s") }, "UNSUPPORTED_TYPE"],
    [{ n: new Date(0) }, "UNSUPPORTED_TYPE"],
    [{ n: new Map() }, "UNSUPPORTED_TYPE"],
  ];
  for (const [value, code] of cases) {
    assert.throws(() => canonicalJson(value), (error) => error instanceof CanonicalError && error.code === code, JSON.stringify(String(value.n)));
  }
});

test("refusal names the path so a deep offender is findable", () => {
  assert.throws(
    () => canonicalJson({ a: { b: [0, { c: Number.NaN }] } }),
    (error) => error.path.join(".") === "a.b.1.c" && /at a\.b\.1\.c$/u.test(error.message),
  );
});

test("integers carry no decimal point and equal numbers share a digest", () => {
  assert.equal(canonicalJson({ n: 1.0 }), '{"n":1}');
  assert.equal(digestOf({ n: 1 }), digestOf({ n: 1.0 }));
  assert.equal(canonicalJson({ n: 1e21 }), '{"n":1e+21}');
});

test("digests are stable across processes for the same data", () => {
  // Pinned so a future refactor that changes canonical bytes cannot pass
  // unnoticed: every digest ever written to a store depends on this value.
  assert.equal(digestOf({ a: 1, b: "x" }), "sha256:ecf9e98ec0641e23113ff3ce8bdc78d0ddd249886517fd4a7f68cc83d4e65667");
});
