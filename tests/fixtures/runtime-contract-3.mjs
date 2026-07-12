// Frozen compatibility probes extracted from runtime-contract 3 at
// e029035ef2f5e51b9a304aeb4408f1515b0a3017. Keep these independent of lib/:
// they represent the reader an upgraded runtime must remain compatible with.

const EVENT_KINDS = new Set(["task_opened", "task_amended", "task_reviewed", "proof_gap_accepted", "task_suspended", "task_resumed", "task_terminal"]);
const PAYLOAD_FIELDS = {
  task_opened: new Set(["goal", "policy", "policy_rationale", "criterion", "alignment", "envelope", "assurance", "budget"]),
  task_amended: new Set(["changed_fields", "reason", "before_substantive_revision", "after_substantive_revision", "before_generation", "after_generation", "before_definition_hash", "after_definition_hash", "grants", "assurance"]),
  task_reviewed: new Set(["level", "reviewer", "criterion_generation_id", "reviewed_task_revision", "reviewed_artifact_revision", "blocking_findings_count", "advisory_findings_count", "reviewed_at", "assurance"]),
  proof_gap_accepted: new Set(["acceptance_id", "reason", "granted_by", "accepted_at", "criterion_generation_id", "accepted_at_task_revision", "assurance"]),
  task_suspended: new Set(["reason", "judgment", "spent", "artifact_revision"]),
  task_resumed: new Set(["reason", "new_episode_id", "spent"]),
  task_terminal: new Set(["outcome", "closing_observation_id", "proof_provisional", "assurance", "spent", "review_level", "advisory_findings_count", "artifact_revision", "evidence", "verified_at_task_revision", "reason"]),
};

function legacyValidateEvent(row) {
  if (!row || typeof row !== "object" || Array.isArray(row) || row.event_schema_version !== 2 || row.task_schema_version !== 2) return "unsupported schema";
  if (!EVENT_KINDS.has(row.kind)) return "unknown kind";
  const allowed = PAYLOAD_FIELDS[row.kind];
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return "invalid payload";
  for (const key of Object.keys(row.payload)) if (!allowed.has(key)) return `unknown payload field ${key}`;
  return null;
}

// The v2 validator was intentionally open at the task and review object level.
// This frozen projection exercises the exact affected portion: additive
// lifecycle_log and review.acting_session must be ignored by the old reader.
function legacyAssertAdditiveTask(task) {
  if (!task || task.schema_version !== 2) throw new Error("incompatible task schema");
  for (const key of ["grants", "reviews", "attempts", "episodes"]) if (!Array.isArray(task[key])) throw new Error(`invalid task field: ${key}`);
  if (!new Set(["active", "suspended", "terminal"]).has(task.lifecycle?.state)) throw new Error("invalid lifecycle state");
  return task;
}

function legacyCursorOffset(cursor, taskId, contentLength) {
  const continuingTask = cursor && typeof cursor === "object" && !Array.isArray(cursor) && cursor.task_id === taskId;
  const previous = continuingTask ? cursor.offset : 0;
  return Number.isSafeInteger(previous) && previous >= 0 && previous <= contentLength ? previous : 0;
}

export { legacyAssertAdditiveTask, legacyCursorOffset, legacyValidateEvent };
