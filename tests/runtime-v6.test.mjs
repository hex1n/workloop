import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRecord, readEventStore } from "../lib/event-store.mjs";
import { artifactCheckpointDelta, artifactCheckpointFromSnapshot, repoSnapshot } from "../lib/criterion.mjs";
import { syncOutcomeRecords } from "../lib/outcome-projector.mjs";
import { buildTaskSnapshot, validateTaskSnapshot } from "../lib/task-store.mjs";
import { artifactAssuranceHolds, assertV3TaskProjection, closureProjection, decide, evolve, evolveAll } from "../lib/task-engine.mjs";
import {
  EVENT_PAYLOAD_FIELDS_BY_VERSION,
  RUNTIME_CONTRACT,
  V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  V3_RUNTIME_CONTRACT,
  artifactCheckpointId,
  eventPayloadFields,
} from "../lib/prims.mjs";
import {
  RUNTIME6_EVENT_KINDS,
  RUNTIME6_EVENT_PAYLOAD_FIELDS,
  RUNTIME6_INFO,
} from "./fixtures/runtime-contract-6.mjs";
import { RUNTIME5_EVENT_KINDS, RUNTIME5_EVENT_PAYLOAD_FIELDS } from "./fixtures/runtime-contract-5.mjs";
import { makeTaskOpenedCommand } from "./helpers/event-v3-fixture.mjs";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
const CONTRACT5_SHA256 = "0c587e3536121e0b0eb78472fd28891d8a97e3c82634e472c52a3fcf5127ca10";

function digest(target) {
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

const AT = "2026-07-22T00:00:00.000Z";
const CAPTURED_AT_MS = Date.parse(AT);
const NEXT_CAPTURED_AT_MS = CAPTURED_AT_MS + 1_000;
const FILE_DIGEST = `sha256:${"3".repeat(64)}`;
const EMPTY_CHECKPOINT = artifactCheckpointId([]);
const FILE_ENTRY = Object.freeze({ kind: "file", hash: FILE_DIGEST });
const NEXT_CHECKPOINT = artifactCheckpointId([{ path: "work.txt", ...FILE_ENTRY }]);

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
    artifactBaseline: { checkpoint_id: EMPTY_CHECKPOINT, captured_at_ms: CAPTURED_AT_MS, entries: [] },
    coverageBasis: { history_requirement: "artifact_only", artifact_state: "full", mutation_history: "unknown", prewrite_enforcement: "unknown" },
  };
}

test("Contract 6 freezes independent version boundaries without rewriting Contract 5", () => {
  assert.deepEqual({ runtime: RUNTIME_CONTRACT, persistedTask: V3_RUNTIME_CONTRACT, outcome: V3_OUTCOME_PROJECTION_SCHEMA_VERSION }, {
    runtime: 6, persistedTask: 5, outcome: 4,
  });
  assert.equal(RUNTIME5_EVENT_KINDS.includes("tool_completed"), false);
  assert.equal(RUNTIME5_EVENT_KINDS.includes("artifact_reconciled"), false);
  assert.equal(RUNTIME5_EVENT_PAYLOAD_FIELDS.task_opened.includes("runtime_contract"), false);
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

test("[W04] runtime 6 keeps active Contract 5 read-only except explicit abandon", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v6-legacy-active-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true }); fs.mkdirSync(path.join(repo, ".workloop")); fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n"); fs.writeFileSync(path.join(repo, "work.txt"), "legacy\n");
  const command = { ...makeTaskOpenedCommand({ seed: "runtime-v6-legacy", atEpochMs: Date.parse(AT) }), runtimeContract: 5 };
  const event = decide(null, command).events[0];
  const record = buildRecord({
    transactionId: randomUUID(), repoSequence: 1, occurredAtEpochMs: Date.parse(AT),
    actor: { kind: "cli", session_id: command.actingSession }, previousRecordDigest: null,
    events: [{ ...event, task_event_sequence: 1 }],
  });
  fs.writeFileSync(path.join(repo, ".workloop", "events.jsonl"), `${JSON.stringify(record)}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_SESSION_ID: command.actingSession };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
  const status = run(["status", "--repo", repo]);
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).write_evidence, undefined);
  assert.equal(run(["report", "--repo", repo, "--json"]).status, 0);
  const suspended = run(["suspend", "--repo", repo, "--reason", "needs_input", "--remaining", "legacy", "--failure", "compat", "--next-action", "old runtime"]);
  assert.equal(suspended.status, 2); assert.match(suspended.stderr, /active Contract 5 task is read-only/);
  const abandoned = run(["abandon", "--repo", repo, "--reason", "explicit compatibility exit"]);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.deepEqual(JSON.parse(run(["status", "--repo", repo]).stdout).lifecycle.state, "terminal");
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

test("Contract 6 projections use persisted task runtime contract 5", () => {
  const command = openCommand();
  const event = decide(null, command).events[0];
  const record = buildRecord({
    transactionId: randomUUID(), repoSequence: 1, occurredAtEpochMs: Date.parse(AT),
    actor: { kind: "cli", session_id: "sanitized" }, previousRecordDigest: null,
    events: [{ ...event, task_event_sequence: 1 }],
  });
  const projection = evolveAll(null, [event]);
  const snapshot = buildTaskSnapshot({
    sourceCursor: {
      event_store_file: "events.jsonl", repo_sequence: 1, task_event_sequence: 1,
      record_digest: record.record_digest, event_id: record.events[0].event_id,
      valid_end_offset: Buffer.byteLength(`${JSON.stringify(record)}\n`),
    },
    projection, validateProjection: assertV3TaskProjection,
  });
  assert.equal(snapshot.runtime_contract, 5);
  assert.equal(validateTaskSnapshot(snapshot, { validateProjection: assertV3TaskProjection }), snapshot);
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
    checkpointId: NEXT_CHECKPOINT, capturedAtMs: NEXT_CAPTURED_AT_MS, fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: NEXT_CHECKPOINT,
    changedEntries: [{ path: "work.txt", before: null, after: FILE_ENTRY }], changedPaths: ["work.txt"],
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
  assert.deepEqual(state.artifact_checkpoint, { checkpoint_id: NEXT_CHECKPOINT, captured_at_ms: NEXT_CAPTURED_AT_MS, entries: [{ path: "work.txt", ...FILE_ENTRY }] });
});

test("Contract 6 rejects cross-contract event versions", () => {
  const opened = openCommand();
  const state = evolveAll(null, decide(null, opened).events);
  assert.throws(() => evolve(state, {
    kind: "write_authorized", payload_version: 1, task_id: state.task_id, at: "2026-07-22T00:00:01.000Z", payload: { files: ["work.txt"] },
  }), /incompatible with Contract 6/);
});

test("repository snapshots become deterministic persisted checkpoints and deltas", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v6-checkpoint-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, ".workloop"));
  fs.writeFileSync(path.join(repo, ".git", "ignored"), "control");
  fs.writeFileSync(path.join(repo, ".workloop", "ignored"), "control");
  fs.writeFileSync(path.join(repo, "b.txt"), "before\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "stable\n");

  const before = artifactCheckpointFromSnapshot(repoSnapshot(repo));
  assert.ok(Number.isSafeInteger(before.captured_at_ms));
  assert.deepEqual(before.entries.map((entry) => entry.path), ["a.txt", "b.txt"]);
  assert.match(before.checkpoint_id, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(before.entries.every((entry) => /^sha256:[0-9a-f]{64}$/u.test(entry.hash)));

  fs.rmSync(path.join(repo, "b.txt"));
  fs.writeFileSync(path.join(repo, "c.txt"), "after\n");
  const after = artifactCheckpointFromSnapshot(repoSnapshot(repo));
  assert.ok(after.captured_at_ms >= before.captured_at_ms);
  const delta = artifactCheckpointDelta(before, after);
  assert.deepEqual(delta.changed_paths, ["b.txt", "c.txt"]);
  assert.deepEqual(delta.changed_entries, [
    { path: "b.txt", before: { kind: before.entries[1].kind, hash: before.entries[1].hash }, after: null },
    { path: "c.txt", before: null, after: { kind: after.entries[1].kind, hash: after.entries[1].hash } },
  ]);

  fs.writeFileSync(path.join(repo, "shape"), "link:y");
  const regular = artifactCheckpointFromSnapshot(repoSnapshot(repo));
  fs.rmSync(path.join(repo, "shape"));
  fs.symlinkSync("y", path.join(repo, "shape"));
  const linked = artifactCheckpointFromSnapshot(repoSnapshot(repo));
  assert.notEqual(regular.checkpoint_id, linked.checkpoint_id);
  assert.equal(regular.entries.find((entry) => entry.path === "shape").kind, "file");
  assert.equal(linked.entries.find((entry) => entry.path === "shape").kind, "symlink");
  assert.deepEqual(artifactCheckpointDelta(regular, linked).changed_entries, [{
    path: "shape",
    before: { kind: "file", hash: regular.entries.find((entry) => entry.path === "shape").hash },
    after: { kind: "symlink", hash: linked.entries.find((entry) => entry.path === "shape").hash },
  }]);
});

test("an unowned reconciliation records a permanent mutation-history gap", () => {
  const opened = openCommand();
  let state = evolveAll(null, decide(null, opened).events);
  const reconciliation = decide(state, {
    type: "reconcile-artifacts", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z",
    checkpointId: NEXT_CHECKPOINT, capturedAtMs: NEXT_CAPTURED_AT_MS, fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: NEXT_CHECKPOINT,
    changedEntries: [{ path: "work.txt", before: null, after: FILE_ENTRY }], changedPaths: ["work.txt"],
    currentScopeViolations: [], coverage: "full", reason: "pre-criterion",
    coverageChange: {
      artifactState: "full", mutationHistory: "unknown", prewriteEnforcement: "unknown",
      episodeId: state.episodes.at(-1).episode_id, hostProfile: "repository", surface: "unhooked-reconcile",
      exhaustiveSurface: false, effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
      intervalToCheckpoint: NEXT_CHECKPOINT, reason: "unowned delta",
    },
  });
  assert.deepEqual(reconciliation.events.map((event) => event.kind), ["artifact_reconciled", "coverage_changed"]);
  state = evolveAll(state, reconciliation.events);
  assert.equal(state.coverage_intervals.length, 1);
  assert.equal(state.evidence.mutation_history_coverage, "unknown");

  const attemptedUpgrade = decide(state, {
    type: "change-coverage", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z",
    artifactState: "full", mutationHistory: "full", prewriteEnforcement: "full",
    episodeId: state.episodes.at(-1).episode_id, hostProfile: "fixture", surface: "direct", exhaustiveSurface: true,
    effectiveFromCheckpoint: NEXT_CHECKPOINT, intervalFromCheckpoint: NEXT_CHECKPOINT,
    intervalToCheckpoint: NEXT_CHECKPOINT, reason: "must not heal history",
  });
  assert.throws(() => evolveAll(state, attemptedUpgrade.events), /cannot upgrade degraded mutation history/);
});

test("strict Pre opens an exhaustive operation lease before authorization", () => {
  const opened = openCommand();
  opened.coverageBasis = { history_requirement: "complete", artifact_state: "full", mutation_history: "unknown", prewrite_enforcement: "unknown" };
  const state = evolveAll(null, decide(null, opened).events);
  const authorized = decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "strict-operation", toolFamily: "patch", hostProfile: "fixture-exhaustive",
    targetCoverage: "exact", receiptExpectation: "post",
    coverageChange: {
      artifactState: "full", mutationHistory: "full", prewriteEnforcement: "full",
      episodeId: state.episodes.at(-1).episode_id, operationId: "strict-operation", capabilityId: "hostcap:v1:fixture-exhaustive",
      hostProfile: "fixture-exhaustive", surface: "direct", exhaustiveSurface: true,
      effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
      intervalToCheckpoint: null, reason: "strict prewrite lease",
    },
  });
  assert.deepEqual(authorized.events.map((event) => event.kind), ["coverage_changed", "write_authorized"]);
  const projected = evolveAll(state, authorized.events);
  assert.equal(projected.capability_leases[0].operation_id, "strict-operation");
  assert.equal(projected.capability_leases[0].status, "open");
  assert.equal(projected.evidence.mutation_history_coverage, "full");
  assert.equal(projected.authority.prewrite_enforcement, "full");
  assert.equal(projected.authority.write_operations_authorized, 1);
});

test("Contract 6 history requirements are monotonic domain invariants", () => {
  const critical = openCommand();
  critical.assurance.declared_risk = "critical";
  assert.throws(() => decide(null, critical), /critical.*complete mutation history/);

  const finite = openCommand();
  finite.budget.writes = 1;
  assert.throws(() => decide(null, finite), /finite write budget.*complete mutation history/);

  const complete = openCommand();
  complete.coverageBasis = { history_requirement: "complete", artifact_state: "full", mutation_history: "full", prewrite_enforcement: "full" };
  let state = evolveAll(null, decide(null, complete).events);
  assert.throws(() => decide(state, {
    type: "amend", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z",
    reason: "attempt assurance downgrade", historyRequirement: "artifact_only",
  }), /cannot relax complete mutation history/);

  const artifactOnly = evolveAll(null, decide(null, openCommand()).events);
  const forgedUpgrade = decide(artifactOnly, {
    type: "change-coverage", taskId: artifactOnly.task_id, at: "2026-07-22T00:00:02.000Z",
    artifactState: "full", mutationHistory: "full", prewriteEnforcement: "full",
    episodeId: artifactOnly.episodes.at(-1).episode_id, operationId: "non-exhaustive", capabilityId: "hostcap:v1:non-exhaustive",
    hostProfile: "fixture", surface: "direct", exhaustiveSurface: false,
    effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
    intervalToCheckpoint: EMPTY_CHECKPOINT, reason: "invalid coverage promotion",
  });
  assert.throws(() => evolveAll(artifactOnly, forgedUpgrade.events), /full mutation history requires an exhaustive surface/);
});

test("finite write budgets are enforced in the engine while fresh satisfaction can still close", () => {
  const bounded = openCommand();
  bounded.budget.writes = 1;
  bounded.coverageBasis = { history_requirement: "complete", artifact_state: "full", mutation_history: "full", prewrite_enforcement: "full" };
  let state = evolveAll(null, decide(null, bounded).events);
  state = evolveAll(state, decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "bounded-operation", toolFamily: "patch", hostProfile: "fixture-exhaustive",
    targetCoverage: "exact", receiptExpectation: "post",
  }).events);
  assert.equal(state.spent.writes, 1);
  assert.throws(() => decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z", decision: "allow",
    files: ["work.txt"], operationId: "over-budget-operation", toolFamily: "patch", hostProfile: "fixture-exhaustive",
    targetCoverage: "exact", receiptExpectation: "post",
  }), /write budget exhausted/);

  const closing = openCommand();
  closing.budget.writes = 0;
  closing.coverageBasis = { history_requirement: "complete", artifact_state: "full", mutation_history: "full", prewrite_enforcement: "full" };
  state = evolveAll(null, decide(null, closing).events);
  const observed = decide(state, {
    type: "observe", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", source: "stop",
    observation: observation("satisfied"), attemptId: null, signature: null, failureSummary: "", drift: [], actingSession: "sanitized",
  });
  assert.deepEqual(observed.events.map((event) => event.kind), ["criterion_observed", "task_terminal"]);
});

test("operation completion and reconciliation are exactly-once as one decision", () => {
  const opened = openCommand();
  let state = evolveAll(null, decide(null, opened).events);
  state = evolveAll(state, decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "operation-1", toolFamily: "patch", hostProfile: "codex-safe",
    targetCoverage: "exact", receiptExpectation: "post",
  }).events);
  const command = {
    type: "complete-operation", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z",
    operationId: "operation-1", toolFamily: "patch", outcome: "success", reportedTargets: ["work.txt"],
    receiptQuality: "tool_specific", hostProfile: "codex-safe",
    checkpointId: NEXT_CHECKPOINT, capturedAtMs: NEXT_CAPTURED_AT_MS, fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: NEXT_CHECKPOINT,
    changedEntries: [{ path: "work.txt", before: null, after: FILE_ENTRY }], changedPaths: ["work.txt"],
    currentScopeViolations: [], coverage: "full", reason: "post-tool",
    coverageChange: {
      artifactState: "full", mutationHistory: "unknown", prewriteEnforcement: "unknown",
      episodeId: state.episodes.at(-1).episode_id, operationId: "operation-1", capabilityId: "hostcap:v1:codex",
      hostProfile: "codex-safe", surface: "direct", exhaustiveSurface: false,
      effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
      intervalToCheckpoint: NEXT_CHECKPOINT, reason: "non-exhaustive direct receipt",
    },
  };
  const completion = decide(state, command);
  assert.deepEqual(completion.events.map((event) => event.kind), ["tool_completed", "artifact_reconciled", "coverage_changed"]);
  state = evolveAll(state, completion.events);
  assert.equal(state.evidence.tool_completions_observed, 1);
  assert.equal(state.artifact_revision, 1);

  const replayed = decide(state, {
    ...command, at: "2026-07-22T00:00:03.000Z", checkpointId: NEXT_CHECKPOINT,
    fromCheckpoint: NEXT_CHECKPOINT, toCheckpoint: NEXT_CHECKPOINT, changedEntries: [], changedPaths: [],
    coverageChange: { ...command.coverageChange, effectiveFromCheckpoint: NEXT_CHECKPOINT, intervalFromCheckpoint: NEXT_CHECKPOINT, intervalToCheckpoint: NEXT_CHECKPOINT },
  });
  assert.deepEqual(replayed, { events: [], result: { status: "duplicate" } });
  state = evolveAll(state, replayed.events);
  assert.equal(state.evidence.tool_completions_observed, 1);
  assert.equal(state.artifact_revision, 1);
});

test("write authorization replay is exactly-once before budget and projection folds", () => {
  let state = evolveAll(null, decide(null, openCommand()).events);
  const command = {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "replayed-authorization", toolFamily: "patch", hostProfile: "fixture",
    targetCoverage: "exact", receiptExpectation: "post",
  };
  state = evolveAll(state, decide(state, command).events);
  const replay = decide(state, { ...command, at: "2026-07-22T00:00:02.000Z" });
  assert.deepEqual(replay, { events: [], result: { status: "duplicate" } });
  assert.throws(() => decide(state, { ...command, at: "2026-07-22T00:00:03.000Z", files: ["other.txt"] }), /conflicting write authorization/);
});

test("closure binds the exact event cursor, not only checkpoint and evidence revision", () => {
  const command = openCommand();
  command.policyName = "steady_satisfied";
  command.policyRationale = "explicit fixture close";
  let state = evolveAll(null, decide(null, command).events);
  state = evolveAll(state, decide(state, {
    type: "observe", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", source: "stop",
    observation: observation("satisfied"), attemptId: null, signature: null, failureSummary: "", drift: [], actingSession: "sanitized",
  }).events);
  assert.deepEqual(closureProjection(state), { state: "eligible" });
  state = evolveAll(state, decide(state, {
    type: "amend", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z", reason: "change goal after observation", goal: "new goal",
  }).events);
  assert.deepEqual(closureProjection(state), { state: "held", reasons: ["artifact_evidence_changed"] });
});

test("orphan and conflicting completion receipts fail closed without rewriting facts", () => {
  const strictCommand = openCommand();
  strictCommand.coverageBasis = { history_requirement: "complete", artifact_state: "full", mutation_history: "full", prewrite_enforcement: "full" };
  let state = evolveAll(null, decide(null, strictCommand).events);
  state = evolveAll(state, decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "conflict-operation", toolFamily: "patch", hostProfile: "fixture",
    targetCoverage: "exact", receiptExpectation: "post",
  }).events);
  const complete = {
    type: "complete-operation", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z",
    operationId: "conflict-operation", toolFamily: "patch", outcome: "success", reportedTargets: ["work.txt"],
    receiptQuality: "tool_specific", hostProfile: "fixture", checkpointId: EMPTY_CHECKPOINT, capturedAtMs: NEXT_CAPTURED_AT_MS,
    fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: EMPTY_CHECKPOINT, changedEntries: [], changedPaths: [],
    currentScopeViolations: [], coverage: "full", reason: "first receipt",
    coverageChange: {
      artifactState: "full", mutationHistory: "full", prewriteEnforcement: "full",
      episodeId: state.episodes.at(-1).episode_id, hostProfile: "fixture", surface: "direct", exhaustiveSurface: true,
      effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
      intervalToCheckpoint: EMPTY_CHECKPOINT, reason: "trusted fixture receipt",
    },
  };
  state = evolveAll(state, decide(state, complete).events);
  assert.equal(state.operations["conflict-operation"].completion.outcome, "success");
  assert.equal(state.evidence.mutation_history_coverage, "full");

  const conflict = decide(state, {
    ...complete, at: "2026-07-22T00:00:03.000Z", outcome: "failure", reason: "conflicting receipt",
    coverageChange: { ...complete.coverageChange, mutationHistory: "full", prewriteEnforcement: "full", reason: "conflicting fixture receipt" },
  });
  assert.equal(conflict.result.status, "conflict");
  assert.equal(conflict.events.some((event) => event.kind === "tool_completed"), false);
  state = evolveAll(state, conflict.events);
  assert.equal(state.operations["conflict-operation"].completion.outcome, "success");
  assert.equal(state.evidence.mutation_history_coverage, "unknown");
  assert.equal(state.authority.prewrite_enforcement, "unknown");

  const orphanCommand = openCommand();
  let orphan = evolveAll(null, decide(null, orphanCommand).events);
  const orphanReceipt = decide(orphan, {
    type: "complete-operation", taskId: orphan.task_id, at: "2026-07-22T00:00:04.000Z",
    operationId: "orphan-operation", toolFamily: "patch", outcome: "unknown", reportedTargets: ["orphan.txt"],
    receiptQuality: "unknown", hostProfile: "fixture", checkpointId: NEXT_CHECKPOINT, capturedAtMs: NEXT_CAPTURED_AT_MS,
    fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: NEXT_CHECKPOINT,
    changedEntries: [{ path: "work.txt", before: null, after: FILE_ENTRY }], changedPaths: ["work.txt"],
    currentScopeViolations: [], coverage: "full", reason: "orphan receipt",
    coverageChange: {
      artifactState: "full", mutationHistory: "unknown", prewriteEnforcement: "unknown",
      episodeId: orphan.episodes.at(-1).episode_id, operationId: "orphan-operation", capabilityId: "hostcap:v1:orphan",
      hostProfile: "fixture", surface: "direct", exhaustiveSurface: false,
      effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
      intervalToCheckpoint: NEXT_CHECKPOINT, reason: "orphan receipt",
    },
  });
  orphan = evolveAll(orphan, orphanReceipt.events);
  assert.equal(orphan.authority.write_operations_authorized, 0);
  assert.equal(orphan.evidence.tool_completions_observed, 1);
  assert.equal(orphan.operations["orphan-operation"].authorization, null);
  assert.equal(orphan.evidence.mutation_history_coverage, "unknown");
});

test("PostToolUse ignores reads and cannot inject a foreign completion", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v6-post-ownership-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const command = openCommand();
  command.episodes[0].host_session_id = "owner-v6";
  const event = decide(null, command).events[0];
  const record = buildRecord({
    transactionId: randomUUID(), repoSequence: 1, occurredAtEpochMs: Date.parse(AT),
    actor: { kind: "cli", session_id: "owner-v6" }, previousRecordDigest: null,
    events: [{ ...event, task_event_sequence: 1 }],
  });
  fs.mkdirSync(path.join(repo, ".workloop"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".workloop", "events.jsonl"), `${JSON.stringify(record)}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_SESSION_ID: "owner-v6" };
  const hook = (payload) => spawnSync(process.execPath, [CLI, "hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: repo, env, input: JSON.stringify(payload), encoding: "utf8",
  });

  const read = hook({
    hook_event_name: "PostToolUse", cwd: repo, session_id: "owner-v6", tool_use_id: "read-1",
    tool_name: "Read", tool_input: { file_path: path.join(repo, "work.txt") }, tool_response: { success: true },
  });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(readEventStore(repo).events.map((item) => item.kind), ["task_opened"]);

  const foreign = hook({
    hook_event_name: "PostToolUse", cwd: repo, session_id: "foreign-v6", tool_use_id: "foreign-1",
    tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt") }, tool_response: { success: true },
  });
  assert.equal(foreign.status, 0, foreign.stderr);
  const replay = readEventStore(repo);
  assert.deepEqual(replay.events.map((item) => item.kind), ["task_opened", "artifact_reconciled", "coverage_changed"]);
  const projection = evolveAll(null, replay.events);
  assert.equal(projection.evidence.tool_completions_observed, 0);
  assert.equal(Object.hasOwn(projection.operations, "foreign-1"), false);
  assert.equal(projection.evidence.mutation_history_coverage, "unknown");
});

test("outcome schema 4 preserves terminal count basis and coverage", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v6-outcome-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); fs.mkdirSync(home);
  const repoIdentity = `sha256:${"9".repeat(64)}`;
  const records = []; let previousRecordDigest = null; let repoSequence = 0; let taskEventSequence = 0;
  const append = (events) => {
    const record = buildRecord({
      transactionId: randomUUID(), repoSequence: ++repoSequence,
      occurredAtEpochMs: Date.parse(AT) + repoSequence,
      actor: { kind: "cli", session_id: "sanitized" }, previousRecordDigest,
      events: events.map((event) => ({ ...event, task_event_sequence: ++taskEventSequence })),
    });
    previousRecordDigest = record.record_digest; records.push(record);
  };

  const opened = openCommand();
  const genesis = decide(null, opened); append(genesis.events);
  let state = evolveAll(null, genesis.events);
  const authorization = decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "operation-1", toolFamily: "patch", hostProfile: "codex-safe",
    targetCoverage: "exact", receiptExpectation: "post",
  });
  append(authorization.events); state = evolveAll(state, authorization.events);
  const completion = decide(state, {
    type: "complete-operation", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z",
    operationId: "operation-1", toolFamily: "patch", outcome: "success", reportedTargets: ["work.txt"],
    receiptQuality: "tool_specific", hostProfile: "codex-safe",
    checkpointId: NEXT_CHECKPOINT, capturedAtMs: NEXT_CAPTURED_AT_MS, fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: NEXT_CHECKPOINT,
    changedEntries: [{ path: "work.txt", before: null, after: FILE_ENTRY }], changedPaths: ["work.txt"],
    currentScopeViolations: [], coverage: "full", reason: "post-tool",
    coverageChange: {
      artifactState: "full", mutationHistory: "unknown", prewriteEnforcement: "unknown",
      episodeId: state.episodes.at(-1).episode_id, operationId: "operation-1", capabilityId: "hostcap:v1:codex",
      hostProfile: "codex-safe", surface: "direct", exhaustiveSurface: false,
      effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
      intervalToCheckpoint: NEXT_CHECKPOINT, reason: "non-exhaustive receipt",
    },
  });
  append(completion.events); state = evolveAll(state, completion.events);
  const terminal = decide(state, { type: "abandon", taskId: state.task_id, at: "2026-07-22T00:00:03.000Z", reason: "fixture complete" });
  append(terminal.events);

  syncOutcomeRecords({ repoIdentity, records, home });
  const rows = fs.readFileSync(path.join(home, ".workloop", "outcomes.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const row = rows.at(-1);
  assert.equal(row.projection_schema_version, 4);
  assert.deepEqual(row.payload.write_evidence, {
    write_count_basis: "authorized", write_operations_authorized: 1,
    tool_completions_observed: 1, artifact_changes: 1, touched_files: ["work.txt"],
    artifact_state_coverage: "full", mutation_history_coverage: "unknown", prewrite_enforcement: "unknown",
  });

  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".workloop"));
  fs.writeFileSync(path.join(repo, ".workloop", "events.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const ledgerRun = spawnSync(process.execPath, [CLI, "ledger", "--repo", repo, "--json"], {
    cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
  });
  assert.equal(ledgerRun.status, 0, ledgerRun.stderr);
  const terminalWriteSet = JSON.parse(ledgerRun.stdout).queries.terminal_write_sets[0];
  assert.deepEqual({
    files: terminalWriteSet.files, basis: terminalWriteSet.write_count_basis,
    artifact: terminalWriteSet.artifact_state_coverage, history: terminalWriteSet.mutation_history_coverage,
  }, { files: ["work.txt"], basis: "authorized", artifact: "full", history: "unknown" });
});

test("PreToolUse and PostToolUse persist one correlated operation and landed artifact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v6-hook-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const command = openCommand();
  command.episodes[0].host_session_id = "owner-v6";
  const event = decide(null, command).events[0];
  const record = buildRecord({
    transactionId: randomUUID(), repoSequence: 1, occurredAtEpochMs: Date.parse(AT),
    actor: { kind: "cli", session_id: "owner-v6" }, previousRecordDigest: null,
    events: [{ ...event, task_event_sequence: 1 }],
  });
  fs.mkdirSync(path.join(repo, ".workloop"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".workloop", "events.jsonl"), `${JSON.stringify(record)}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_SESSION_ID: "owner-v6" };
  const hook = (payload) => spawnSync(process.execPath, [CLI, "hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: repo, env, input: JSON.stringify(payload), encoding: "utf8",
  });

  const pre = hook({
    hook_event_name: "PreToolUse", cwd: repo, session_id: "owner-v6", tool_use_id: "operation-1",
    tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt"), content: "landed\n" },
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, "");
  fs.writeFileSync(path.join(repo, "work.txt"), "landed\n");
  const post = hook({
    hook_event_name: "PostToolUse", cwd: repo, session_id: "owner-v6", tool_use_id: "operation-1",
    tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt") }, tool_response: { success: true },
  });
  assert.equal(post.status, 0, post.stderr);
  assert.equal(post.stdout, "");

  const replay = readEventStore(repo);
  assert.deepEqual(replay.events.map((item) => item.kind), [
    "task_opened", "write_authorized", "tool_completed", "artifact_reconciled", "coverage_changed",
  ]);
  assert.equal(replay.events[1].payload.operation_id, "operation-1");
  assert.equal(replay.events[2].payload.operation_id, "operation-1");
  const projection = JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
  assert.equal(projection.authority.write_operations_authorized, 1);
  assert.equal(projection.evidence.tool_completions_observed, 1);
  assert.equal(projection.artifact_revision, 1);
  assert.deepEqual(projection.evidence.touched_files, ["work.txt"]);

  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
  const status = JSON.parse(run(["status", "--repo", repo]).stdout);
  assert.deepEqual({
    writes: status.write_evidence.write_operations_authorized,
    completions: status.write_evidence.tool_completions_observed,
    artifact_revisions: status.write_evidence.artifact_revision,
    artifact_coverage: status.write_evidence.artifact_state_coverage,
    history_coverage: status.write_evidence.mutation_history_coverage,
  }, { writes: 1, completions: 1, artifact_revisions: 1, artifact_coverage: "full", history_coverage: "unknown" });
  assert.equal(status.budget.write_compliance, "not_applicable");
  assert.equal(status.write_evidence.authority.write_operations_authorized, 1);
  assert.equal(status.write_evidence.evidence.tool_completions_observed, 1);
  assert.equal(status.write_evidence.artifact_checkpoint.checkpoint_id, projection.artifact_checkpoint.checkpoint_id);
  assert.equal(status.write_evidence.capability_leases.length, 0);
  assert.equal(status.write_evidence.coverage_intervals.length, 1);
  const report = JSON.parse(run(["report", "--repo", repo, "--json"]).stdout);
  assert.equal(report.write_evidence.write_count_basis, "authorized");
  assert.equal(report.budget.write_compliance, "not_applicable");
  const ledger = JSON.parse(run(["ledger", "--repo", repo, "--json"]).stdout);
  assert.deepEqual({
    writes: ledger.metrics.writes,
    basis: ledger.metrics.write_count_basis,
    completions: ledger.metrics.tool_completions,
    artifact_changes: ledger.metrics.artifact_changes,
    touched: ledger.metrics.touched_files,
  }, { writes: 1, basis: "authorized", completions: 1, artifact_changes: 1, touched: 1 });
});

test("failure receipts, partial writes, and scan failures degrade without losing correlation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v6-failure-receipts-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const command = openCommand(); command.episodes[0].host_session_id = "owner-v6";
  const event = decide(null, command).events[0];
  const record = buildRecord({
    transactionId: randomUUID(), repoSequence: 1, occurredAtEpochMs: Date.parse(AT),
    actor: { kind: "cli", session_id: "owner-v6" }, previousRecordDigest: null,
    events: [{ ...event, task_event_sequence: 1 }],
  });
  fs.mkdirSync(path.join(repo, ".workloop"));
  fs.writeFileSync(path.join(repo, ".workloop", "events.jsonl"), `${JSON.stringify(record)}\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_SESSION_ID: "owner-v6" };
  const hook = (payload, extraEnv = {}) => spawnSync(process.execPath, [CLI, "hook", "--profile", "claude", "--mode", "nudge"], {
    cwd: repo, env: { ...env, ...extraEnv }, input: JSON.stringify(payload), encoding: "utf8",
  });
  const pre = (operationId, file) => hook({
    hook_event_name: "PreToolUse", cwd: repo, session_id: "owner-v6", tool_use_id: operationId,
    tool_name: "Write", tool_input: { file_path: path.join(repo, file) },
  });
  const failure = (operationId, file, extraEnv = {}) => hook({
    hook_event_name: "PostToolUseFailure", cwd: repo, session_id: "owner-v6", tool_use_id: operationId,
    tool_name: "Write", tool_input: { file_path: path.join(repo, file) }, error: { code: "fixture_failure" },
  }, extraEnv);

  assert.equal(pre("failure-no-write", "no-write.txt").status, 0);
  assert.equal(failure("failure-no-write", "no-write.txt").status, 0);
  let state = JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
  assert.equal(state.operations["failure-no-write"].completion.outcome, "failure");
  assert.equal(state.artifact_revision, 0);

  assert.equal(pre("failure-after-write", "partial.txt").status, 0);
  fs.writeFileSync(path.join(repo, "partial.txt"), "partial result\n");
  assert.equal(failure("failure-after-write", "partial.txt").status, 0);
  state = JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
  assert.equal(state.operations["failure-after-write"].completion.outcome, "failure");
  assert.equal(state.artifact_revision, 1);
  assert.ok(state.evidence.touched_files.includes("partial.txt"));

  assert.equal(pre("commit-failure", "commit-failure.txt").status, 0);
  fs.writeFileSync(path.join(repo, "commit-failure.txt"), "receipt commit failed\n");
  const degradedCommit = hook({
    hook_event_name: "PostToolUse", cwd: repo, session_id: "owner-v6", tool_use_id: "commit-failure",
    tool_name: "Write", tool_input: { file_path: path.join(repo, "commit-failure.txt") }, tool_response: { success: true },
  }, { WORKLOOP_POST_COMMIT_FAILPOINT: "before-authority-commit" });
  assert.equal(degradedCommit.status, 0, degradedCommit.stderr);
  state = JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
  assert.equal(state.operations["commit-failure"].completion, null);
  assert.equal(state.evidence.artifact_state_coverage, "unknown");
  assert.match(state.coverage_intervals.at(-1).reason, /PostToolUse authority commit failed/);

  assert.equal(pre("scan-timeout", "late.txt").status, 0);
  fs.writeFileSync(path.join(repo, "late.txt"), "not yet reconciled\n");
  const timedOut = hook({
    hook_event_name: "PostToolUse", cwd: repo, session_id: "owner-v6", tool_use_id: "scan-timeout",
    tool_name: "Write", tool_input: { file_path: path.join(repo, "late.txt") }, tool_response: { success: true },
  }, { WORKLOOP_POST_SNAPSHOT_DEADLINE_MS: "0" });
  assert.equal(timedOut.status, 0, timedOut.stderr); assert.equal(timedOut.stdout, "");
  state = JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
  assert.equal(state.operations["scan-timeout"].completion.outcome, "success");
  assert.equal(state.evidence.artifact_state_coverage, "unknown");
  assert.equal(state.evidence.touched_files.includes("late.txt"), false);

  const reconciled = spawnSync(process.execPath, [CLI, "achieve", "--repo", repo], { cwd: repo, env, encoding: "utf8" });
  assert.equal(reconciled.status, 2);
  state = JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
  assert.equal(state.evidence.artifact_state_coverage, "full");
  assert.ok(state.evidence.touched_files.includes("late.txt"));
  assert.equal(state.evidence.mutation_history_coverage, "unknown");

  fs.appendFileSync(path.join(repo, ".workloop", "events.jsonl"), "{broken\n");
  const unpersistable = hook({
    hook_event_name: "PostToolUse", cwd: repo, session_id: "owner-v6", tool_use_id: "unpersistable",
    tool_name: "Write", tool_input: { file_path: path.join(repo, "unpersistable.txt") }, tool_response: { success: true },
  });
  assert.equal(unpersistable.status, 2);
  assert.match(unpersistable.stderr, /completion receipt degradation could not be persisted/);
});

test("achieved and not-needed share Contract 6 artifact assurance", () => {
  const opened = openCommand();
  const state = evolveAll(null, decide(null, opened).events);
  assert.deepEqual(artifactAssuranceHolds(state), []);
  const notNeeded = decide(state, {
    type: "not-needed", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", evidence: "baseline already satisfies the need",
  });
  assert.equal(evolveAll(state, notNeeded.events).lifecycle.outcome, "not_needed");

  let reverted = evolveAll(state, decide(state, {
    type: "authorize-write", taskId: state.task_id, at: "2026-07-22T00:00:01.000Z", decision: "allow",
    files: ["work.txt"], operationId: "reverted-success", toolFamily: "patch", hostProfile: "codex-safe",
    targetCoverage: "exact", receiptExpectation: "post",
  }).events);
  reverted = evolveAll(reverted, decide(reverted, {
    type: "complete-operation", taskId: reverted.task_id, at: "2026-07-22T00:00:02.000Z",
    operationId: "reverted-success", toolFamily: "patch", outcome: "success", reportedTargets: ["work.txt"],
    receiptQuality: "tool_specific", hostProfile: "codex-safe",
    checkpointId: EMPTY_CHECKPOINT, capturedAtMs: NEXT_CAPTURED_AT_MS, fromCheckpoint: EMPTY_CHECKPOINT, toCheckpoint: EMPTY_CHECKPOINT,
    changedEntries: [], changedPaths: [], currentScopeViolations: [], coverage: "full", reason: "write reverted before reconciliation",
    coverageChange: {
      artifactState: "full", mutationHistory: "unknown", prewriteEnforcement: "unknown",
      episodeId: reverted.episodes.at(-1).episode_id, operationId: "reverted-success", capabilityId: "hostcap:v1:codex",
      hostProfile: "codex-safe", surface: "direct", exhaustiveSurface: false,
      effectiveFromCheckpoint: EMPTY_CHECKPOINT, intervalFromCheckpoint: EMPTY_CHECKPOINT,
      intervalToCheckpoint: EMPTY_CHECKPOINT, reason: "successful operation returned to baseline",
    },
  }).events);
  assert.throws(() => decide(reverted, {
    type: "not-needed", taskId: reverted.task_id, at: "2026-07-22T00:00:03.000Z", evidence: "bytes match baseline",
  }), /successful_completion_receipt_observed/);

  const strictCommand = openCommand();
  strictCommand.coverageBasis.history_requirement = "complete";
  const strict = evolveAll(null, decide(null, strictCommand).events);
  assert.deepEqual(artifactAssuranceHolds(strict), ["mutation_history_incomplete", "prewrite_enforcement_incomplete"]);
  assert.throws(() => decide(strict, {
    type: "not-needed", taskId: strict.task_id, at: "2026-07-22T00:00:01.000Z", evidence: "not sufficient",
  }), /mutation_history_incomplete/);

  const uncovered = structuredClone(state);
  uncovered.evidence.artifact_state_coverage = "unknown";
  uncovered.evidence.current_scope_violations = ["outside.txt"];
  assert.deepEqual(artifactAssuranceHolds(uncovered), ["artifact_state_unreconciled", "artifact_scope_violation"]);

  const satisfied = observation("satisfied");
  const observed = decide(state, {
    type: "observe", taskId: state.task_id, at: "2026-07-22T00:00:02.000Z", source: "stop", observation: satisfied,
    attemptId: null, signature: null, failureSummary: "", drift: [], actingSession: "sanitized",
  });
  assert.deepEqual(observed.events.map((event) => event.kind), ["criterion_observed", "task_terminal"]);

  const strictObserved = decide(strict, {
    type: "observe", taskId: strict.task_id, at: "2026-07-22T00:00:02.000Z", source: "stop", observation: observation("satisfied"),
    attemptId: null, signature: null, failureSummary: "", drift: [], actingSession: "sanitized",
  });
  assert.deepEqual(strictObserved.events.map((event) => event.kind), ["criterion_observed"]);
  assert.deepEqual(closureProjection(evolveAll(strict, strictObserved.events)).reasons, ["mutation_history_incomplete", "prewrite_enforcement_incomplete"]);
});

test("not-needed reconciles the repository before applying the terminal gate", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-v6-not-needed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const changed of [false, true]) {
    const repo = path.join(root, changed ? "changed" : "unchanged");
    const home = path.join(root, changed ? "changed-home" : "unchanged-home");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const command = openCommand();
    command.episodes[0].host_session_id = "owner-v6";
    const event = decide(null, command).events[0];
    const record = buildRecord({
      transactionId: randomUUID(), repoSequence: 1, occurredAtEpochMs: Date.parse(AT),
      actor: { kind: "cli", session_id: "owner-v6" }, previousRecordDigest: null,
      events: [{ ...event, task_event_sequence: 1 }],
    });
    fs.mkdirSync(path.join(repo, ".workloop"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".workloop", "events.jsonl"), `${JSON.stringify(record)}\n`);
    if (changed) fs.writeFileSync(path.join(repo, "work.txt"), "unexpected\n");
    const result = spawnSync(process.execPath, [CLI, "not-needed", "--repo", repo, "--evidence", "checked baseline"], {
      cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_SESSION_ID: "owner-v6" }, encoding: "utf8",
    });
    const kinds = readEventStore(repo).events.map((item) => item.kind);
    if (changed) {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /artifact_changed_since_baseline/);
      assert.deepEqual(kinds, ["task_opened", "artifact_reconciled", "coverage_changed"]);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(kinds, ["task_opened", "artifact_reconciled", "task_terminal"]);
    }
  }
});
