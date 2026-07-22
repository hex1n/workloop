import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildRecord } from "../lib/event-store.mjs";
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
