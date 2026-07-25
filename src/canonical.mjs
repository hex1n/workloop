// Canonical JSON and digests.
//
// Every digest in the store is taken over canonical bytes, so canonicalization
// is a first-class contract rather than a formatting convenience: two values
// that are equal as data must produce identical bytes on every platform and in
// every process, forever. Anything that cannot satisfy that is refused here
// rather than silently coerced, because a silent coercion becomes a digest that
// nobody can reproduce.
import { createHash } from "node:crypto";

class CanonicalError extends Error {
  constructor(code, message, path) {
    super(path.length === 0 ? message : `${message} at ${path.join(".")}`);
    this.name = "CanonicalError";
    this.code = code;
    this.path = [...path];
  }
}

const refuse = (code, message, path) => {
  throw new CanonicalError(code, message, path);
};

function encodeNumber(value, path) {
  if (!Number.isFinite(value)) refuse("NON_FINITE_NUMBER", "non-finite numbers have no canonical form", path);
  // -0 and 0 are indistinguishable once serialized, so accepting -0 would let
  // two different inputs claim the same digest.
  if (Object.is(value, -0)) refuse("NEGATIVE_ZERO", "negative zero has no canonical form", path);
  return JSON.stringify(value);
}

function encode(value, path) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return encodeNumber(value, path);
    // JSON.stringify has produced well-formed output since ES2019: lone
    // surrogates are escaped rather than emitted raw, so string encoding is
    // already deterministic and round-trippable.
    case "string":
      return JSON.stringify(value);
    case "bigint":
      refuse("UNSUPPORTED_TYPE", "bigint has no canonical JSON form", path);
      break;
    case "undefined":
    case "function":
    case "symbol":
      refuse("UNSUPPORTED_TYPE", `${typeof value} has no canonical JSON form`, path);
      break;
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encode(item, [...path, index])).join(",")}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    refuse("UNSUPPORTED_TYPE", "only plain objects have a canonical form", path);
  }
  // Code-unit order, which is what Array#sort gives by default. Locale-aware
  // ordering would make digests machine-dependent.
  const keys = Object.keys(value).sort();
  const members = keys.map((key) => {
    const child = value[key];
    if (child === undefined) refuse("UNSUPPORTED_TYPE", "undefined has no canonical JSON form", [...path, key]);
    return `${JSON.stringify(key)}:${encode(child, [...path, key])}`;
  });
  return `{${members.join(",")}}`;
}

// A value is a plain record-like object if it carries data and nothing else:
// no class identity, no prototype behaviour. Objects made with a null
// prototype qualify — they are data by construction.
export function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value) {
  return encode(value, []);
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digestOf(value) {
  return sha256Hex(canonicalBytes(value));
}

export { CanonicalError };
