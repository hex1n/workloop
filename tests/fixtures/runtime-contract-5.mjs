// Frozen public-contract probes for runtime contract 5. Keep this fixture
// independent of lib/ so tests cannot pass by
// importing the implementation values they are intended to verify.

const RUNTIME5_INFO = Object.freeze({
  runtime_contract: 5,
  task_snapshot_schema_version: 3,
  event_record_schema_version: 2,
  outcome_projection_schema_version: 3,
  event_store: ".taskloop/events.jsonl",
  outcome_projection: "~/.taskloop/outcomes.jsonl",
});

const RUNTIME5_EVENT_KINDS = Object.freeze([
  "task_opened",
  "task_suspended",
  "task_resumed",
  "task_joined",
  "task_terminal",
  "write_authorized",
  "criterion_observed",
  "criterion_side_effect_recorded",
  "output_tokens_tallied",
  "task_amended",
  "review_recorded",
  "proof_gap_accepted",
]);

const RUNTIME5_EVENT_PAYLOAD_FIELDS = Object.freeze({
  task_opened: Object.freeze(["goal", "criterion", "observation", "policy_name", "policy_rationale", "alignment", "envelope", "grants", "assurance", "budget", "episodes"]),
  task_suspended: Object.freeze(["reason", "judgment", "close_episode", "source", "acting_session"]),
  task_resumed: Object.freeze(["reason", "episode", "acting_session"]),
  task_joined: Object.freeze(["reason", "episode", "acting_session"]),
  task_terminal: Object.freeze(["outcome", "evidence", "reason", "source", "acting_session"]),
  write_authorized: Object.freeze(["files"]),
  criterion_observed: Object.freeze(["observation", "attempt_id", "signature", "failure_summary", "drift", "source"]),
  criterion_side_effect_recorded: Object.freeze(["observation"]),
  output_tokens_tallied: Object.freeze(["source_id", "source_generation_id", "episode_id", "from_offset", "to_offset", "range_sha256", "end_anchor_sha256", "output_tokens_delta", "mode"]),
  task_amended: Object.freeze(["reason", "goal", "alignment", "envelope", "grants", "rounds", "writes", "wall_clock_minutes", "output_tokens", "assurance", "criterion", "policy", "policy_rationale", "generation_id", "artifact_revision"]),
  review_recorded: Object.freeze(["record"]),
  proof_gap_accepted: Object.freeze(["record"]),
});

const AUTHORITY_FAILURE_HOOKS = Object.freeze({
  pretooluse_write: Object.freeze({ exit: 0, frame: "deny" }),
  pretooluse_read: Object.freeze({ exit: 0, frame: "silent" }),
  stop: Object.freeze({ exit: 0, frame: "block" }),
});

const RECORD_FIELDS = Object.freeze([
  "record_schema_version", "transaction_id", "command_id", "repo_sequence",
  "occurred_at_epoch_ms", "occurred_at", "actor", "previous_record_digest",
  "events", "record_digest",
]);

const EVENT_ENVELOPE_FIELDS = Object.freeze([
  "event_id", "task_id", "task_event_sequence", "kind", "payload_version", "payload",
]);

const SNAPSHOT_FIELDS = Object.freeze([
  "schema_version", "runtime_contract", "source_cursor", "projection", "snapshot_digest",
]);

const SNAPSHOT_SOURCE_CURSOR_FIELDS = Object.freeze([
  "event_store_file", "repo_sequence", "task_event_sequence", "record_digest", "event_id", "valid_end_offset",
]);

const TASK_PROJECTION_FIELDS = Object.freeze([
  "schema_version", "task_id", "task_revision", "last_substantive_task_revision", "artifact_revision",
  "created_at", "updated_at", "lifecycle", "goal", "criterion", "policy", "policy_rationale",
  "witness", "alignment", "envelope", "grants", "assurance", "budget", "spent", "evidence",
  "reviews", "attempts", "unsatisfied_streak", "episodes", "lifecycle_log", "task_event_sequence",
  "transcript_cursors",
]);

const OUTCOME_PROJECTION_FIELDS = Object.freeze([
  "projection_schema_version", "repo_identity", "repo_sequence", "event_id", "task_id",
  "kind", "occurred_at_epoch_ms", "occurred_at", "payload", "row_digest",
]);

const BENCHMARK_RECEIPT_FIELDS = Object.freeze([
  "receipt_schema_version", "status", "node", "os", "arch", "cpu", "filesystem",
  "capabilities", "record_count", "file_bytes", "samples", "summary", "thresholds", "passed",
]);

const BENCHMARK_SAMPLE_FIELDS = Object.freeze(["full_replay_ms", "incremental_tail_ms", "append_fsync_ms"]);

const BENCHMARK_SUMMARY_FIELDS = Object.freeze(["p50_ms", "p95_ms", "max_ms", "passed"]);

const BENCHMARK_THRESHOLDS = Object.freeze({
  full_replay_max_ms: 200,
  incremental_tail_p95_max_ms: 5,
  append_fsync_p95_max_ms: 20,
  record_count: 10001,
});

const PERSISTED_VALUE_CONSTRAINTS = Object.freeze({
  digest: "sha256:<64 lowercase hex>",
  epoch_ms: "non-negative safe integer",
  timestamp: "UTC ISO derived from the same epoch_ms",
  command_id: "non-empty string or null",
  previous_record_digest: "null only at repo_sequence 1, otherwise digest",
  sequence: "positive contiguous safe integer",
  actor_kind: Object.freeze(["cli", "hook"]),
  transcript_mode: Object.freeze(["baseline", "increment"]),
  benchmark_status: Object.freeze(["not_implemented", "pass", "fail"]),
  unknown_fields: "reject",
  unknown_versions: "reject",
});

// Descriptor grammar is intentionally small and closed: `null|` is the only
// nullable form, `object:name` must resolve below, arrays state cardinality,
// and discriminated objects name their discriminator. Implementations may use
// any validator, but must accept exactly this persisted value domain.
const PERSISTED_FIELD_CONTRACTS = Object.freeze({
  record: Object.freeze({
    record_schema_version: "literal:2",
    transaction_id: "uuid",
    command_id: "null|non-empty-string",
    repo_sequence: "positive-safe-integer",
    occurred_at_epoch_ms: "non-negative-safe-integer",
    occurred_at: "utc-iso-milliseconds",
    actor: "object:actor",
    previous_record_digest: "null|sha256-digest",
    events: "non-empty-array<object:event>",
    record_digest: "sha256-digest",
  }),
  event: Object.freeze({
    event_id: "sha256-digest",
    task_id: "uuid",
    task_event_sequence: "positive-safe-integer",
    kind: "enum:event-kind",
    payload_version: "literal:1",
    payload: "discriminated-object:event-payload-by-kind",
  }),
  snapshot: Object.freeze({
    schema_version: "literal:3",
    runtime_contract: "literal:4",
    source_cursor: "object:snapshot-source-cursor",
    projection: "object:task-projection",
    snapshot_digest: "sha256-digest",
  }),
  snapshot_source_cursor: Object.freeze({
    event_store_file: "literal:events.jsonl",
    repo_sequence: "positive-safe-integer",
    task_event_sequence: "positive-safe-integer",
    record_digest: "sha256-digest",
    event_id: "sha256-digest",
    valid_end_offset: "non-negative-safe-integer",
  }),
  task_projection: Object.freeze({
    schema_version: "literal:3",
    task_id: "uuid",
    task_revision: "positive-safe-integer",
    last_substantive_task_revision: "positive-safe-integer",
    artifact_revision: "non-negative-safe-integer",
    created_at: "utc-iso-milliseconds",
    updated_at: "utc-iso-milliseconds",
    lifecycle: "one-of<object:lifecycle-active|object:lifecycle-suspended|object:lifecycle-terminal>",
    goal: "non-empty-string",
    criterion: "object:criterion",
    policy: "object:policy",
    policy_rationale: "null|non-empty-string",
    witness: "null|object:witness",
    alignment: "object:alignment",
    envelope: "object:envelope",
    grants: "array<object:grant>",
    assurance: "object:assurance",
    budget: "object:budget",
    spent: "object:spent",
    evidence: "object:evidence",
    reviews: "array<object:review-record>",
    attempts: "array<object:attempt>",
    unsatisfied_streak: "non-negative-safe-integer",
    episodes: "non-empty-array<object:episode>",
    lifecycle_log: "non-empty-array<object:lifecycle-log-row>",
    task_event_sequence: "positive-safe-integer",
    transcript_cursors: "map<sha256-digest,object:transcript-cursor>",
  }),
  outcome_projection: Object.freeze({
    projection_schema_version: "literal:3",
    repo_identity: "sha256-digest",
    repo_sequence: "positive-safe-integer",
    event_id: "sha256-digest",
    task_id: "uuid",
    kind: "enum:event-kind",
    occurred_at_epoch_ms: "non-negative-safe-integer",
    occurred_at: "utc-iso-milliseconds",
    payload: "discriminated-object:event-payload-by-kind",
    row_digest: "sha256-digest",
  }),
});

const PERSISTED_NESTED_OBJECTS = Object.freeze({
  actor: Object.freeze({ kind: "enum:cli|hook", session_id: "null|non-empty-string" }),
  "criterion-source": Object.freeze({ kind: "enum:file|command", value: "non-empty-string" }),
  "declared-input": Object.freeze({ path: "repo-relative-path", hash: "sha256-digest" }),
  criterion: Object.freeze({
    source: "object:criterion-source",
    authored_by: "enum:self|user",
    protocol: "enum:binary|tri-state",
    timeout_seconds: "positive-safe-integer",
    declared_inputs: "array<object:declared-input>",
    subjects: "array<repo-relative-path>",
    criterion_definition_hash: "sha256-digest",
    criterion_generation_id: "uuid",
    criterion_input_fingerprint: "null|sha256-digest",
    input_coverage: "enum:full|unknown",
    provenance: "enum:repo|state_dir|unresolved",
    last_observation: "null|object:observation",
  }),
  "criterion-definition": Object.freeze({
    source: "object:criterion-source",
    authored_by: "enum:self|user",
    protocol: "enum:binary|tri-state",
    timeout_seconds: "positive-safe-integer",
    declared_inputs: "array<object:declared-input>",
    subjects: "array<repo-relative-path>",
    criterion_definition_hash: "sha256-digest",
    criterion_generation_id: "uuid",
    criterion_input_fingerprint: "null|sha256-digest",
    input_coverage: "enum:full|unknown",
    provenance: "enum:repo|state_dir|unresolved",
  }),
  execution: Object.freeze({
    exit_code: "null|integer",
    signal: "null|non-empty-string",
    duration_ms: "non-negative-safe-integer",
    execution_error: "null|non-empty-string",
    output_tail: "string:max-4096-utf8-bytes",
    timeout_seconds: "positive-safe-integer",
  }),
  observation: Object.freeze({
    observation_id: "uuid",
    verdict: "enum:satisfied|unsatisfied|indeterminate",
    criterion_generation_id: "null|uuid",
    observed_artifact_revision: "null|non-negative-safe-integer",
    observed_at: "utc-iso-milliseconds",
    execution: "object:execution",
    changed_paths: "array<repo-relative-path>",
  }),
  policy: Object.freeze({
    open_requirement: "enum:unsatisfied|determinate",
    witness_requirement: "enum:required|none",
    close_policy: "enum:automatic|explicit",
  }),
  witness: Object.freeze({
    criterion_generation_id: "uuid",
    observed_at: "utc-iso-milliseconds",
    source_event: "enum:open|stop|achieve",
  }),
  alignment: Object.freeze({ because: "non-empty-string", not_covered: "array<non-empty-string>" }),
  envelope: Object.freeze({
    files: "non-empty-array<repo-relative-path-or-glob>",
    git: "array<non-empty-string>",
    destructive: "boolean",
    network: "boolean",
  }),
  grant: Object.freeze({
    grant_id: "uuid",
    kind: "enum:git|destructive|network|install|whole_repo|criterion_subject|publish",
    scope: "non-empty-array<non-empty-string>",
    reason: "non-empty-string",
    granted_by: "enum:user|self",
    granted_at_task_revision: "positive-safe-integer",
  }),
  "proof-gap-record": Object.freeze({
    acceptance_id: "uuid",
    reason: "non-empty-string",
    granted_by: "enum:user|self",
    accepted_at: "utc-iso-milliseconds",
    criterion_generation_id: "uuid",
    accepted_at_task_revision: "positive-safe-integer",
  }),
  assurance: Object.freeze({
    declared_risk: "enum:routine|substantial|critical",
    risk_reason: "string",
    risk_declared_by: "enum:default|self|user",
    change_classes: "array<enum:internal|public_contract|schema|security|permissions|migration>",
    review_policy: "enum:risk_based|required|waived",
    required_review_level: "null|enum:fresh_context|second_model",
    review_waiver_reason: "null|non-empty-string",
    review_waiver_granted_by: "null|enum:self|user",
    proof_gap_acceptances: "array<object:proof-gap-record>",
    risk_floor_events: "array<enum:criterion_amend|policy_amend|criterion_amended_after_write|policy_amended_after_write>",
  }),
  budget: Object.freeze({
    rounds: "positive-safe-integer",
    writes: "null|non-negative-safe-integer",
    wall_clock_minutes: "null|non-negative-safe-integer",
    output_tokens: "null|non-negative-safe-integer",
  }),
  spent: Object.freeze({
    rounds: "non-negative-safe-integer",
    writes: "non-negative-safe-integer",
    wall_clock_ms: "non-negative-safe-integer",
    output_tokens_estimate: "non-negative-safe-integer",
  }),
  evidence: Object.freeze({
    touched_files: "array<repo-relative-path>",
    criterion_input_drift: "array<repo-relative-path>",
  }),
  "review-record": Object.freeze({
    review_id: "uuid",
    criterion_generation_id: "uuid",
    reviewed_task_revision: "positive-safe-integer",
    reviewed_artifact_revision: "non-negative-safe-integer",
    level: "enum:fresh_context|second_model",
    reviewer: "non-empty-string",
    blocking_findings_count: "non-negative-safe-integer",
    advisory_findings_count: "non-negative-safe-integer",
    reviewed_at: "utc-iso-milliseconds",
    acting_session: "null|non-empty-string",
  }),
  attempt: Object.freeze({
    attempt_id: "uuid",
    criterion_generation_id: "uuid",
    artifact_revision: "non-negative-safe-integer",
    signature: "null|non-empty-string",
    failure_summary: "string:max-160-utf8-bytes",
    observed_at: "utc-iso-milliseconds",
  }),
  episode: Object.freeze({
    episode_id: "uuid",
    host_session_id: "non-empty-string",
    started_at: "utc-iso-milliseconds",
    ended_at: "null|utc-iso-milliseconds",
    start_task_revision: "positive-safe-integer",
    end_task_revision: "null|positive-safe-integer",
    output_tokens_estimate: "non-negative-safe-integer",
  }),
  judgment: Object.freeze({ remaining: "non-empty-string", failure: "non-empty-string", next_action: "non-empty-string" }),
  "lifecycle-active": Object.freeze({ state: "literal:active" }),
  "lifecycle-suspended": Object.freeze({
    state: "literal:suspended",
    reason: "enum:needs_input|stuck|out_of_budget",
    suspended_at: "utc-iso-milliseconds",
    judgment: "object:judgment",
  }),
  "lifecycle-terminal": Object.freeze({
    state: "literal:terminal",
    outcome: "enum:achieved|not_needed|abandoned",
    terminal_at: "utc-iso-milliseconds",
    closing_observation_id: "null|uuid",
    proof_provisional: "null|boolean",
    evidence: "null|non-empty-string",
    verified_at_task_revision: "null|positive-safe-integer",
    reason: "null|non-empty-string",
  }),
  "lifecycle-log-row": Object.freeze({
    event: "enum:open|suspend|resume|join|achieve|not_needed|abandon",
    source: "enum:cli|stop",
    acting_session: "null|non-empty-string",
    at: "utc-iso-milliseconds",
    task_revision: "positive-safe-integer",
    reason: "null|non-empty-string",
  }),
  "transcript-cursor": Object.freeze({
    source_generation_id: "uuid",
    episode_id: "uuid",
    offset: "non-negative-safe-integer",
    range_sha256: "sha256-digest",
    end_anchor_sha256: "sha256-digest",
  }),
  "payload.task_opened": Object.freeze({
    goal: "non-empty-string", criterion: "object:criterion-definition", observation: "object:observation",
    policy_name: "enum:default|deferred_witness|steady_satisfied", policy_rationale: "null|non-empty-string",
    alignment: "object:alignment", envelope: "object:envelope", grants: "array<object:grant>",
    assurance: "object:assurance", budget: "object:budget", episodes: "non-empty-array<object:episode>",
  }),
  "payload.task_suspended": Object.freeze({
    reason: "enum:needs_input|stuck|out_of_budget", judgment: "object:judgment",
    close_episode: "boolean", source: "enum:cli|stop", acting_session: "null|non-empty-string",
  }),
  "payload.task_resumed": Object.freeze({ reason: "non-empty-string", episode: "object:episode", acting_session: "null|non-empty-string" }),
  "payload.task_joined": Object.freeze({ reason: "non-empty-string", episode: "object:episode", acting_session: "non-empty-string" }),
  "payload.task_terminal": Object.freeze({
    outcome: "enum:achieved|not_needed|abandoned", evidence: "null|non-empty-string", reason: "null|non-empty-string",
    source: "enum:cli|stop", acting_session: "null|non-empty-string",
  }),
  "payload.write_authorized": Object.freeze({ files: "non-empty-array<repo-relative-path>" }),
  "payload.criterion_observed": Object.freeze({
    observation: "object:observation", attempt_id: "null|uuid", signature: "null|non-empty-string",
    failure_summary: "string:max-160-utf8-bytes", drift: "array<repo-relative-path>", source: "enum:open|stop|achieve",
  }),
  "payload.criterion_side_effect_recorded": Object.freeze({ observation: "object:observation" }),
  "payload.output_tokens_tallied": Object.freeze({
    source_id: "sha256-digest", source_generation_id: "uuid", episode_id: "uuid",
    from_offset: "non-negative-safe-integer", to_offset: "non-negative-safe-integer", range_sha256: "sha256-digest",
    end_anchor_sha256: "sha256-digest", output_tokens_delta: "non-negative-safe-integer", mode: "enum:baseline|increment",
  }),
  "payload.task_amended": Object.freeze({
    reason: "non-empty-string", goal: "null|non-empty-string", alignment: "null|object:alignment",
    envelope: "null|object:envelope", grants: "null|non-empty-array<object:grant>", rounds: "null|positive-safe-integer",
    writes: "null|non-negative-safe-integer", wall_clock_minutes: "null|non-negative-safe-integer",
    output_tokens: "null|non-negative-safe-integer", assurance: "null|object:assurance", criterion: "null|object:criterion-definition",
    policy: "null|object:policy", policy_rationale: "null|non-empty-string", generation_id: "null|uuid", artifact_revision: "non-negative-safe-integer",
  }),
  "payload.review_recorded": Object.freeze({ record: "object:review-record" }),
  "payload.proof_gap_accepted": Object.freeze({ record: "object:proof-gap-record" }),
});

const PERSISTED_CANONICAL_PREIMAGES = Object.freeze({
  event_id: Object.freeze({
    encoding: "utf8(canonical-json)",
    include: Object.freeze(["task_id", "task_event_sequence", "kind", "payload_version", "payload"]),
    exclude: Object.freeze(["event_id"]),
    output: "sha256:<64 lowercase hex>",
  }),
  record_digest: Object.freeze({
    encoding: "utf8(canonical-json)",
    include: Object.freeze(["record_schema_version", "transaction_id", "command_id", "repo_sequence", "occurred_at_epoch_ms", "occurred_at", "actor", "previous_record_digest", "events"]),
    exclude: Object.freeze(["record_digest"]),
    output: "sha256:<64 lowercase hex>",
  }),
  snapshot_digest: Object.freeze({
    encoding: "utf8(canonical-json)",
    include: Object.freeze(["schema_version", "runtime_contract", "source_cursor", "projection"]),
    exclude: Object.freeze(["snapshot_digest"]),
    output: "sha256:<64 lowercase hex>",
  }),
  row_digest: Object.freeze({
    encoding: "utf8(canonical-json)",
    include: Object.freeze(["projection_schema_version", "repo_identity", "repo_sequence", "event_id", "task_id", "kind", "occurred_at_epoch_ms", "occurred_at", "payload"]),
    exclude: Object.freeze(["row_digest"]),
    output: "sha256:<64 lowercase hex>",
  }),
});

const V3_ERROR_MESSAGES = Object.freeze({
  LEGACY_STATE_UNSUPPORTED: "legacy task state is unsupported; archive it explicitly before opening a schema-v3 task",
  ORPHAN_V3_SNAPSHOT: "orphan schema-v3 snapshot has no event authority; archive it explicitly",
  MIXED_OR_INVALID_AUTHORITY: "task snapshot conflicts with schema-v3 event authority; archive only the incompatible snapshot",
  CORRUPT_EVENT_AUTHORITY: "schema-v3 event authority is corrupt; refusing snapshot fallback",
  UNKNOWN_RECORD_FIELD: "event record contains an unknown field",
  UNKNOWN_EVENT_FIELD: "domain event contains an unknown field",
  UNKNOWN_EVENT_KIND: "domain event kind is unsupported",
  UNSUPPORTED_RECORD_VERSION: "event record schema version is unsupported",
  UNSUPPORTED_PAYLOAD_VERSION: "domain event payload version is unsupported",
  CORRUPT_RECORD_DIGEST: "event record digest does not match canonical bytes",
  CORRUPT_EVENT_DIGEST: "domain event id does not match canonical bytes",
  REPO_SEQUENCE_GAP: "repository event sequence is not contiguous",
  TASK_SEQUENCE_GAP: "task event sequence is not contiguous",
  HASH_CHAIN_MISMATCH: "previous record digest does not match the event hash chain",
  TORN_TAIL_RECOVERY_REQUIRED: "event store has a torn tail that requires locked recovery",
});

export {
  AUTHORITY_FAILURE_HOOKS,
  BENCHMARK_RECEIPT_FIELDS,
  BENCHMARK_SAMPLE_FIELDS,
  BENCHMARK_SUMMARY_FIELDS,
  BENCHMARK_THRESHOLDS,
  EVENT_ENVELOPE_FIELDS,
  OUTCOME_PROJECTION_FIELDS,
  PERSISTED_CANONICAL_PREIMAGES,
  PERSISTED_FIELD_CONTRACTS,
  PERSISTED_NESTED_OBJECTS,
  PERSISTED_VALUE_CONSTRAINTS,
  RECORD_FIELDS,
  RUNTIME5_EVENT_PAYLOAD_FIELDS,
  RUNTIME5_EVENT_KINDS,
  RUNTIME5_INFO,
  SNAPSHOT_FIELDS,
  SNAPSHOT_SOURCE_CURSOR_FIELDS,
  TASK_PROJECTION_FIELDS,
  V3_ERROR_MESSAGES,
};
