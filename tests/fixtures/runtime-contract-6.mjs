// Frozen public-contract probes for runtime contract 6. Keep this fixture
// independent of lib/ so tests cannot pass by importing implementation values.

const RUNTIME6_INFO = Object.freeze({
  runtime_contract: 6,
  task_snapshot_schema_version: 3,
  persisted_task_runtime_contract: 5,
  event_record_schema_version: 2,
  outcome_projection_schema_version: 4,
  event_store: ".workloop/events.jsonl",
  outcome_projection: "~/.workloop/outcomes.jsonl",
});

const RUNTIME6_EVENT_PAYLOAD_FIELDS = Object.freeze({
  task_opened: Object.freeze({
    1: Object.freeze(["goal", "criterion", "observation", "policy_name", "policy_rationale", "alignment", "envelope", "grants", "assurance", "budget", "episodes"]),
    2: Object.freeze(["goal", "criterion", "observation", "policy_name", "policy_rationale", "alignment", "envelope", "grants", "assurance", "budget", "episodes", "runtime_contract", "artifact_baseline", "coverage_basis"]),
  }),
  task_suspended: Object.freeze({ 1: Object.freeze(["reason", "judgment", "close_episode", "source", "acting_session"]) }),
  task_resumed: Object.freeze({ 1: Object.freeze(["reason", "episode", "acting_session"]) }),
  task_joined: Object.freeze({ 1: Object.freeze(["reason", "episode", "acting_session"]) }),
  task_terminal: Object.freeze({ 1: Object.freeze(["outcome", "evidence", "reason", "source", "acting_session"]) }),
  write_authorized: Object.freeze({
    1: Object.freeze(["files"]),
    2: Object.freeze(["operation_id", "tool_family", "declared_targets", "target_coverage", "host_profile", "receipt_expectation"]),
  }),
  criterion_observed: Object.freeze({
    1: Object.freeze(["observation", "attempt_id", "signature", "failure_summary", "drift", "source"]),
    2: Object.freeze(["observation", "attempt_id", "signature", "failure_summary", "drift", "source", "checkpoint_id", "evidence_revision", "event_cursor"]),
  }),
  criterion_side_effect_recorded: Object.freeze({
    1: Object.freeze(["observation"]),
    2: Object.freeze(["observation", "checkpoint_id", "evidence_revision", "event_cursor"]),
  }),
  output_tokens_tallied: Object.freeze({ 1: Object.freeze(["source_id", "source_generation_id", "episode_id", "from_offset", "to_offset", "range_sha256", "end_anchor_sha256", "output_tokens_delta", "mode"]) }),
  task_amended: Object.freeze({ 1: Object.freeze(["reason", "goal", "alignment", "envelope", "grants", "rounds", "writes", "wall_clock_minutes", "output_tokens", "assurance", "criterion", "policy", "policy_rationale", "generation_id", "artifact_revision"]) }),
  review_recorded: Object.freeze({
    1: Object.freeze(["record"]),
    2: Object.freeze(["record"]),
  }),
  proof_gap_accepted: Object.freeze({ 1: Object.freeze(["record"]) }),
  tool_completed: Object.freeze({ 1: Object.freeze(["operation_id", "tool_family", "outcome", "reported_targets", "receipt_quality", "host_profile"]) }),
  artifact_reconciled: Object.freeze({ 1: Object.freeze(["checkpoint_id", "from_checkpoint", "to_checkpoint", "changed_entries", "changed_paths", "current_scope_violations", "coverage", "reason"]) }),
  coverage_changed: Object.freeze({ 1: Object.freeze(["artifact_state", "mutation_history", "prewrite_enforcement", "episode_id", "operation_id", "capability_id", "host_profile", "surface", "exhaustive_surface", "effective_from_checkpoint", "interval_from_checkpoint", "interval_to_checkpoint", "reason"]) }),
});

const RUNTIME6_EVENT_KINDS = Object.freeze(Object.keys(RUNTIME6_EVENT_PAYLOAD_FIELDS));

export {
  RUNTIME6_EVENT_KINDS,
  RUNTIME6_EVENT_PAYLOAD_FIELDS,
  RUNTIME6_INFO,
};
