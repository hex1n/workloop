// Frozen public-contract probes for runtime contract 7. Keep this fixture
// independent of lib/ so tests cannot pass by importing implementation values.

import { RUNTIME6_EVENT_PAYLOAD_FIELDS } from "./runtime-contract-6.mjs";

const RUNTIME7_INFO = Object.freeze({
  runtime_contract: 7,
  task_snapshot_schema_version: 3,
  persisted_task_runtime_contract: 6,
  event_record_schema_version: 2,
  outcome_projection_schema_version: 5,
  event_store: ".workloop/events.jsonl",
  outcome_projection: "~/.workloop/outcomes.jsonl",
});

const RUNTIME7_EVENT_PAYLOAD_FIELDS = Object.freeze({
  ...RUNTIME6_EVENT_PAYLOAD_FIELDS,
  task_opened: Object.freeze({
    ...RUNTIME6_EVENT_PAYLOAD_FIELDS.task_opened,
    3: Object.freeze(["goal", "criterion", "observation", "policy_name", "policy_rationale", "alignment", "envelope", "grants", "assurance", "budget", "episodes", "runtime_contract", "artifact_baseline", "coverage_basis"]),
  }),
  operation_intent_recorded: Object.freeze({
    1: Object.freeze(["operation_id", "tool_family", "declared_targets", "target_coverage", "host_profile", "receipt_expectation", "policy_mode", "policy_disposition", "policy_reasons", "session_relation"]),
  }),
});

const RUNTIME7_EVENT_KINDS = Object.freeze(Object.keys(RUNTIME7_EVENT_PAYLOAD_FIELDS));

export {
  RUNTIME7_EVENT_KINDS,
  RUNTIME7_EVENT_PAYLOAD_FIELDS,
  RUNTIME7_INFO,
};
