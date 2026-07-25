// Declarative record vocabulary.
//
// A kind is described, not coded: each one is a versioned descriptor listing
// the fields it carries, their types, and their bounds. One generic checker
// enforces every descriptor. This is the seam the previous implementation
// lacked — it hand-wrote validation per kind, which made every vocabulary
// change expensive, which is why its vocabulary only ever grew.
//
// The kernel does not read this file. Vocabulary is domain, and domain arrives
// here in slice 2.
import { canonicalJson, isPlainObject } from "./canonical.mjs";

export class VocabularyError extends Error {
  constructor(code, message, kind) {
    super(kind === undefined ? message : `${message} (kind ${kind})`);
    this.name = "VocabularyError";
    this.code = code;
    this.kind = kind ?? null;
  }
}

const refuse = (code, message, kind) => {
  throw new VocabularyError(code, message, kind);
};

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

// Field types are deliberately few. Every one of them is a shape whose
// canonical form is stable, because anything stored here ends up inside a
// digest sooner or later.
const TYPES = {
  string: (value, rule) => typeof value === "string"
    && value.length >= (rule.min ?? 1)
    && value.length <= (rule.max ?? 4096)
    && (rule.pattern === undefined || rule.pattern.test(value)),
  integer: (value, rule) => Number.isSafeInteger(value)
    && value >= (rule.min ?? 0)
    && value <= (rule.max ?? Number.MAX_SAFE_INTEGER),
  boolean: (value) => typeof value === "boolean",
  digest: (value) => typeof value === "string" && DIGEST.test(value),
  enum: (value, rule) => rule.values.includes(value),
  strings: (value, rule) => Array.isArray(value)
    && value.length <= (rule.max ?? 256)
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= (rule.itemMax ?? 4096)),
  object: (value) => isPlainObject(value),
  // A bounded list of small records, each checked against its own field map by
  // the same rules as a top-level payload. Edges need it: encoding "which loop,
  // pinned to what" as a packed string would put a parser between the log and
  // its own meaning, and a log that needs parsing is no longer self-describing.
  list: (value, rule) => Array.isArray(value)
    && value.length <= (rule.max ?? 64)
    && value.every((item) => isPlainObject(item) && matchesFields(rule.fields, item)),
};

function matchesFields(fields, payload) {
  const declared = Object.keys(fields).sort();
  if (canonicalJson(declared) !== canonicalJson(Object.keys(payload).sort())) return false;
  return Object.entries(fields).every(([field, rule]) => {
    const value = payload[field];
    if (value === null && rule.nullable === true) return true;
    return TYPES[rule.type](value, rule);
  });
}

function assertDescriptor(kind, descriptor) {
  if (!isPlainObject(descriptor?.fields)) refuse("BAD_DESCRIPTOR", "a descriptor needs a fields object", kind);
  for (const [field, rule] of Object.entries(descriptor.fields)) {
    if (!isPlainObject(rule) || !Object.hasOwn(TYPES, rule.type)) {
      refuse("BAD_DESCRIPTOR", `field ${field} has no known type`, kind);
    }
    if (rule.type === "enum" && !Array.isArray(rule.values)) refuse("BAD_DESCRIPTOR", `field ${field} is an enum without values`, kind);
    if (rule.type === "list") {
      if (!isPlainObject(rule.fields)) refuse("BAD_DESCRIPTOR", `field ${field} is a list without item fields`, kind);
      assertDescriptor(`${kind}.${field}`, { fields: rule.fields });
    }
  }
  return descriptor;
}

export function createVocabulary(descriptors) {
  const kinds = new Map();
  for (const [kind, descriptor] of Object.entries(descriptors)) {
    kinds.set(kind, assertDescriptor(kind, descriptor));
  }

  return {
    kinds: () => [...kinds.keys()].sort(),
    has: (kind) => kinds.has(kind),

    // Refuses rather than repairs, and names the field: a payload that does not
    // fit its descriptor is not a payload with a problem, it is a record this
    // vocabulary cannot mean anything by.
    assert(kind, payload) {
      const descriptor = kinds.get(kind);
      if (descriptor === undefined) refuse("UNKNOWN_KIND", `${kind} is not in this vocabulary`, kind);
      if (!isPlainObject(payload)) refuse("PAYLOAD_SHAPE", "payload must be a plain object", kind);

      const declared = Object.keys(descriptor.fields).sort();
      const present = Object.keys(payload).sort();
      // Exact match, not a superset: an unexpected field is a caller writing a
      // fact this vocabulary has never agreed to carry, and letting it through
      // means the next reader silently ignores it.
      if (canonicalJson(declared) !== canonicalJson(present)) {
        const missing = declared.filter((field) => !present.includes(field));
        const extra = present.filter((field) => !declared.includes(field));
        refuse("PAYLOAD_FIELDS", `payload fields differ: missing [${missing}], unexpected [${extra}]`, kind);
      }
      for (const [field, rule] of Object.entries(descriptor.fields)) {
        const value = payload[field];
        if (value === null && rule.nullable === true) continue;
        if (!TYPES[rule.type](value, rule)) {
          refuse("PAYLOAD_FIELD", `field ${field} does not satisfy ${rule.type}`, kind);
        }
      }
      return payload;
    },
  };
}
