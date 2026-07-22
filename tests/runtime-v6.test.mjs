import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildRecord } from "../lib/event-store.mjs";
import { assertV3TaskProjection, decide, evolve, evolveAll } from "../lib/task-engine.mjs";
import {
  EVENT_PAYLOAD_FIELDS_BY_VERSION,
  eventPayloadFields,
} from "../lib/prims.mjs";
import {
  RUNTIME6_EVENT_KINDS,
  RUNTIME6_EVENT_PAYLOAD_FIELDS,
  RUNTIME6_INFO,
} from "./fixtures/runtime-contract-6.mjs";

const ROOT = path.resolve(".");
const CONTRACT5_SHA256 = "0c587e3536121e0b0eb78472fd28891d8a97e3c82634e472c52a3fcf5127ca10";

function digest(target) {
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

const AT = "2026-07-22T00:00:00.000Z";
const EMPTY_CHECKPOINT = `sha256:${"0".repeat(64)}`;
const NEXT_CHECKPOINT = `sha256:${"2".repeat(64)}`;
const FILE_DIGEST = `sha256:${"3".repeat(64)}`;

function observation(verdict = "unsatisfied") {
  return {
    observation_id: randomUUID(), verdict, criterion_generation_id: null,
    observed_artifact_revision: null, observed_at: AT,
    execution: { exit_code: verdict === "satisfied" ? 0 : 1, signal: null, duration_ms: 1, execution_error: null, output_tail: "", timeout_seconds: 30 },
    changed_paths: [],
  };
}

function openCommand() {
  const generationId = randomUUID();
  return {
    type: "open", runtimeContract: 6, taskId: randomUUID(), at: AT,
    goal: "exercise Contract 6", observation: observation(), policyName: "default", policyRationale: null,
    criterion: {
      source: { kind: "command", value: "node check.mjs" }, authored_by: "self", protocol: "binary", timeout_seconds: 30,
      declared_inputs: [], subjects: [], criterion_definition_hash: `sha256:${"4".repeat(64)}`,
      criterion_generation_id: generationId, criterion_input_fingerprint: null, input_coverage: "unknown", provenance: "unresolved",
    },
    alignment: { because: "the fixture exercises persisted semantics", not_covered: [] },
    envelope: { files: ["**"], git: [], destructive: false, network: false }, grants: [],
    assurance: {
      declared_risk: "routine", risk_reason: "isolated fixture", risk_declared_by: "self", change_classes: ["schema"],
      review_policy: "risk_based", required_review_level: null, review_waiver_reason: null,
      review_waiver_granted_by: null, proof_gap_acceptances: [], risk_floor_events: [],
    },
    budget: { rounds: 8, writes: null, wall_clock_minutes: null, output_tokens: null },
    episodes: [{ episode_id: randomUUID(), host_session_id: "sanitized", started_at: AT, ended_at: null, start_task_revision: 1, end_task_revision: null, output_tokens_estimate: 0 }],
    artifactBaseline: { checkpoint_id: EMPTY_CHECKPOINT, entries: [] },
    coverageBasis: { history_requirement: "artifact_only", artifact_state: "full", mutation_history: "unknown", prewrite_enforcement: "unknown" },
  };
}

test("Contract 6 freezes independent version boundaries without rewriting Contract 5", () => {
  assert.deepEqual(RUNTIME6_INFO, {
    runtime_contract: 6,
    task_snapshot_schema_version: 3,
    persisted_task_runtime_contract: 5,
    event_record_schema_version: 2,
    outcome_projection_schema_version: 4,
    event_store: ".workloop/events.jsonl",
    outcome_projection: "~/.workloop/outcomes.jsonl",
  });
  assert.equal(digest(path.join(ROOT, "tests", "fixtures", "runtime-contract-5.mjs")), CONTRACT5_SHA256);
});

test("payload contracts dispatch by event kind and payload version", () => {
  assert.deepEqual(EVENT_PAYLOAD_FIELDS_BY_VERSION, RUNTIME6_EVENT_PAYLOAD_FIELDS);
  assert.deepEqual(Object.keys(EVENT_PAYLOAD_FIELDS_BY_VERSION), RUNTIME6_EVENT_KINDS);
  for (const [kind, versions] of Object.entries(RUNTIME6_EVENT_PAYLOAD_FIELDS)) {
    for (const [version, fields] of Object.entries(versions)) {
      assert.deepEqual(eventPayloadFields(kind, Number(version)), fields, `${kind} v${version}`);
    }
  }
  assert.equal(eventPayloadFields("tool_completed", 2), null);
  assert.equal(eventPayloadFields("unknown", 1), null);
});

test("event framing accepts a Contract 6-only kind without changing record schema", () => {
  const taskId = randomUUID();
  const record = buildRecord({
    transactionId: randomUUID(),
    repoSequence: 2,
    occurredAtEpochMs: 1_785_000_000_000,
    actor: { kind: "hook", session_id: "sanitized" },
    previousRecordDigest: `sha256:${"1".repeat(64)}`,
    events: [{
      task_id: taskId,
      task_event_sequence: 2,
      kind: "tool_completed",
      payload_version: 1,
      payload: {
        operation_id: "operation-1",
        tool_family: "patch",
        outcome: "success",
        reported_targets: ["work.txt"],
        receipt_quality: "tool_specific",
        host_profile: "codex-safe",
      },
    }],
  });
  assert.equal(record.record_schema_version, 2);
  assert.equal(record.events[0].kind, "tool_completed");
});

test("event framing persists a Contract 6 genesis with payload version 2", () => {
  const command = openCommand();
  const event = decide(null, command).events[0];
  const record = buildRecord({
    transactionId: randomUUID(), repoSequence: 1, occurredAtEpochMs: Date.parse(AT),
    actor: { kind: "cli", session_id: "sanitized" }, previousRecordDigest: null,
    events: [{ ...event, task_event_sequence: 1 }],
  });
  assert.equal(record.record_schema_version, 2);
  assert.equal(record.events[0].payload_version, 2);
  assert.equal(record.events[0].payload.runtime_contract, 6);
});

test("Contract 6 projection separates authorization, completion, and artifact mutation", () => {
  const opened = openCommand();
  const genesis = decide(null, opened);
  assert.equal(genesis.events[0].payload_version, 2);
  let state = evolveAll(null, genesis.events);
  assertV3TaskProjection(state);
  assert.equal(state.runtime_contract, 6);
  assert.equal(state.spent.write_count_basis, "authorized");
  assert.equal(state.evidence.artifact_state_coverage, "full");
  assert.equal(state.evidence.mutation_history_coverage, "unknown");

  const lease = decide(state, {
    type: "change-coverage", taskId: state.task_id, at: "2026-07-22T00:00:00.500Z",
    artifactState: "full", mutationHistory: "full", prewriteEnforcement: "full",
    episodeId: state.episodes.at(-1).episode_id, operationId: "operation-1", capabilityId: "hostcap:v1:fixture",
    hostProfile: "fixture", surface: "direct", exhaustiveSurface: true,
    effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
    intervalToCheckpoint: null, reason: "strict prewrite lease",
  });
  state = evolveAll(state, lease.events);
  assert.equal(state.capability_leases[0].status, "open");
  assert.equal(state.evidence.mutation_history_coverage, "full");

  const authorization = decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "operation-1", toolFamily: "patch", hostProfile: "codex-safe",
    targetCoverage: "exact", receiptExpectation: "post",
  });
  assert.equal(authorization.events[0].payload_version, 2);
  state = evolveAll(state, authorization.events);
  assert.equal(state.authority.write_operations_authorized, 1);
  assert.equal(state.spent.writes, 1);
  assert.equal(state.artifact_revision, 0);
  assert.deepEqual(state.evidence.touched_files, []);

  const completion = decide(state, {
    type: "complete-tool", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z",
    operationId: "operation-1", toolFamily: "patch", outcome: "success", reportedTargets: ["work.txt"],
    receiptQuality: "tool_specific", hostProfile: "codex-safe",
  });
  state = evolveAll(state, completion.events);
  assert.equal(state.evidence.tool_completions_observed, 1);
  assert.equal(state.artifact_revision, 0);
  assert.deepEqual(state.evidence.touched_files, []);

  const reconciliation = decide(state, {
    type: "reconcile-artifacts", taskId: state.task_id, at: "2026-07-22T00:00:03.000Z",
    checkpointId: NEXT_CHECKPOINT, fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: NEXT_CHECKPOINT,
    changedEntries: [{ path: "work.txt", before: null, after: FILE_DIGEST }], changedPaths: ["work.txt"],
    currentScopeViolations: [], coverage: "full", reason: "post-tool",
  });
  state = evolveAll(state, reconciliation.events);
  const leaseClosed = decide(state, {
    type: "change-coverage", taskId: state.task_id, at: "2026-07-22T00:00:04.000Z",
    artifactState: "full", mutationHistory: "full", prewriteEnforcement: "full",
    episodeId: state.episodes.at(-1).episode_id, operationId: "operation-1", capabilityId: "hostcap:v1:fixture",
    hostProfile: "fixture", surface: "direct", exhaustiveSurface: true,
    effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
    intervalToCheckpoint: NEXT_CHECKPOINT, reason: "post-tool lease close",
  });
  state = evolveAll(state, leaseClosed.events);
  assertV3TaskProjection(state);
  assert.equal(state.artifact_revision, 1);
  assert.equal(state.evidence.evidence_revision, 2);
  assert.equal(state.capability_leases[0].status, "closed");
  assert.deepEqual(state.evidence.touched_files, ["work.txt"]);
  assert.deepEqual(state.artifact_checkpoint, { checkpoint_id: NEXT_CHECKPOINT, entries: [{ path: "work.txt", hash: FILE_DIGEST }] });
});

test("Contract 6 rejects cross-contract event versions", () => {
  const opened = openCommand();
  const state = evolveAll(null, decide(null, opened).events);
  assert.throws(() => evolve(state, {
    kind: "write_authorized", payload_version: 1, task_id: state.task_id, at: "2026-07-22T00:00:01.000Z", payload: { files: ["work.txt"] },
  }), /incompatible with Contract 6/);
});
