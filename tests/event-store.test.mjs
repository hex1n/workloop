import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EVENT_STORE_FILE,
  OUTCOME_CURSOR_DIR,
  OUTCOME_PROJECTION_FILE,
  RUNTIME_CONTRACT,
  V3_EVENT_KINDS,
  V3_EVENT_PAYLOAD_FIELDS,
  V3_EVENT_RECORD_SCHEMA_VERSION,
  V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
  V3_RUNTIME_CONTRACT,
  V3_TASK_SNAPSHOT_SCHEMA_VERSION,
  canonicalJson,
  sha256Hex,
  utcTimestamp,
} from "../lib/prims.mjs";
import {
  deterministicId,
  generateRecordFacts,
  makeTaskOpenedCommand,
  makeTranscriptBytes,
} from "./helpers/event-v3-fixture.mjs";
import {
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
} from "./fixtures/runtime-contract-5.mjs";
import { decide, evolve, evolveAll } from "../lib/task-engine.mjs";
import {
  auditEventStore,
  buildRecord,
  commitRecord,
  eventStorePath,
  readEventStore,
  readEventStoreTail,
  syncDirectory,
  WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED,
} from "../lib/event-store.mjs";

function assertPersistedDescriptor(value, descriptor, label) {
  if (descriptor.startsWith("null|")) {
    if (value === null) return;
    return assertPersistedDescriptor(value, descriptor.slice(5), label);
  }
  if (descriptor.startsWith("object:")) {
    const name = descriptor.slice("object:".length);
    const schema = PERSISTED_NESTED_OBJECTS[name] ?? PERSISTED_FIELD_CONTRACTS[name.replaceAll("-", "_")];
    assert.ok(schema, `${label}: unknown object contract ${name}`);
    assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label}: expected ${descriptor}`);
    assert.deepEqual(Object.keys(value).sort(), Object.keys(schema).sort(), `${label}: exact fields`);
    for (const [field, childDescriptor] of Object.entries(schema)) assertPersistedDescriptor(value[field], childDescriptor, `${label}.${field}`);
    return;
  }
  const oneOfMatch = descriptor.match(/^one-of<(.+)>$/);
  if (oneOfMatch) {
    const failures = [];
    for (const option of oneOfMatch[1].split("|")) {
      try { assertPersistedDescriptor(value, option, label); return; } catch (error) { failures.push(error.message); }
    }
    assert.fail(`${label}: no one-of contract matched: ${failures.join("; ")}`);
  }
  const mapMatch = descriptor.match(/^map<([^,]+),(.+)>$/);
  if (mapMatch) {
    assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label}: expected ${descriptor}`);
    for (const [key, child] of Object.entries(value)) {
      assertPersistedDescriptor(key, mapMatch[1], `${label} key`);
      assertPersistedDescriptor(child, mapMatch[2], `${label}.${key}`);
    }
    return;
  }
  const arrayMatch = descriptor.match(/^(non-empty-)?array<(.+)>$/);
  if (arrayMatch) {
    assert.ok(Array.isArray(value), `${label}: expected ${descriptor}`);
    if (arrayMatch[1]) assert.ok(value.length > 0, `${label}: expected non-empty array`);
    for (let index = 0; index < value.length; index += 1) assertPersistedDescriptor(value[index], arrayMatch[2], `${label}[${index}]`);
    return;
  }
  if (descriptor.startsWith("enum:")) {
    assert.ok(descriptor.slice(5).split("|").includes(value), `${label}: expected ${descriptor}`);
    return;
  }
  if (descriptor.startsWith("literal:")) {
    const literal = descriptor.slice(8);
    if (/^-?\d+$/.test(literal)) assert.equal(value, Number(literal), `${label}: expected ${descriptor}`);
    else if (literal === "true" || literal === "false") assert.equal(value, literal === "true", `${label}: expected ${descriptor}`);
    else assert.equal(value, literal, `${label}: expected ${descriptor}`);
    return;
  }
  if (descriptor === "uuid") assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, label);
  else if (descriptor === "sha256-digest") assert.match(value, /^sha256:[0-9a-f]{64}$/, label);
  else if (descriptor === "positive-safe-integer") assert.ok(Number.isSafeInteger(value) && value > 0, label);
  else if (descriptor === "non-negative-safe-integer") assert.ok(Number.isSafeInteger(value) && value >= 0, label);
  else if (descriptor === "integer") assert.ok(Number.isSafeInteger(value), label);
  else if (descriptor === "boolean") assert.equal(typeof value, "boolean", label);
  else if (descriptor === "non-empty-string") assert.ok(typeof value === "string" && value.length > 0, label);
  else if (descriptor.startsWith("string")) {
    assert.equal(typeof value, "string", label);
    const limit = descriptor.match(/^string:max-(\d+)-utf8-bytes$/)?.[1];
    if (limit) assert.ok(Buffer.byteLength(value, "utf8") <= Number(limit), `${label}: exceeds ${limit} UTF-8 bytes`);
  }
  else if (descriptor === "utc-iso-milliseconds") assert.equal(new Date(Date.parse(value)).toISOString(), value, label);
  else if (descriptor === "repo-relative-path" || descriptor === "repo-relative-path-or-glob") {
    const portable = typeof value === "string" ? value.replaceAll("\\", "/") : "";
    const normalized = path.posix.normalize(portable);
    assert.ok(portable.length > 0 && !path.posix.isAbsolute(portable) && !path.win32.isAbsolute(value) && normalized !== ".." && !normalized.startsWith("../"), label);
  } else assert.fail(`${label}: unsupported contract descriptor ${descriptor}`);
}

function resignPersisted(value, digestField) {
  const next = structuredClone(value);
  const contract = PERSISTED_CANONICAL_PREIMAGES[digestField];
  const preimage = Object.fromEntries(contract.include.map((field) => [field, next[field]]));
  next[digestField] = sha256Hex(canonicalJson(preimage));
  return next;
}

function terminateCrashChildAtSeam(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("tests/helpers/event-store-crash-child.mjs"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let frame = null;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`crash child timeout: ${stderr}`)); }, 10_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0 || frame) return;
      try { frame = JSON.parse(stdout.slice(0, newline)); } catch (error) { reject(error); child.kill("SIGKILL"); return; }
      child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!frame) reject(new Error(`crash child exited before seam (${code}/${signal}): ${stderr}`));
      else resolve({ frame, code, signal });
    });
  });
}

test("runtime contract 7 keeps snapshot, record, and outcome versions independent", () => {
  assert.deepEqual(
    {
      activeRuntime: RUNTIME_CONTRACT,
      task: V3_TASK_SNAPSHOT_SCHEMA_VERSION,
      runtime: V3_RUNTIME_CONTRACT,
      record: V3_EVENT_RECORD_SCHEMA_VERSION,
      outcome: V3_OUTCOME_PROJECTION_SCHEMA_VERSION,
      eventStore: EVENT_STORE_FILE,
      outcomeProjection: OUTCOME_PROJECTION_FILE,
      outcomeCursors: OUTCOME_CURSOR_DIR,
    },
    {
      activeRuntime: 7,
      task: 3,
      runtime: 5,
      record: 2,
      outcome: 5,
      eventStore: "events.jsonl",
      outcomeProjection: "outcomes.jsonl",
      outcomeCursors: "outcomes-cursors",
    },
  );
});

test("schema-v3 event catalog and persisted primitives are deterministic", () => {
  assert.deepEqual(V3_EVENT_KINDS, [
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
  assert.deepEqual(V3_EVENT_PAYLOAD_FIELDS.output_tokens_tallied, [
    "source_id",
    "source_generation_id",
    "episode_id",
    "from_offset",
    "to_offset",
    "range_sha256",
    "end_anchor_sha256",
    "output_tokens_delta",
    "mode",
  ]);
  const left = canonicalJson({ z: [3, { b: true, a: "x" }], a: null });
  const right = canonicalJson({ a: null, z: [3, { a: "x", b: true }] });
  assert.equal(left, '{"a":null,"z":[3,{"a":"x","b":true}]}');
  assert.equal(left, right);
  assert.equal(sha256Hex(left), "sha256:f39f20b5b275a590ffdbf04446b233ed928b40757f744e70a5e1c0a385aa83f9");
  assert.equal(utcTimestamp(1_784_000_000_000), "2026-07-14T03:33:20.000Z");
  assert.throws(() => canonicalJson({ impossible: undefined }), /canonical JSON/);
  assert.throws(() => utcTimestamp(-1), /epoch milliseconds/);
});

test("UTC authority timestamps are invariant across timezone and DST settings", () => {
  const moduleUrl = new URL("../lib/prims.mjs", import.meta.url).href;
  const script = `import {utcTimestamp} from ${JSON.stringify(moduleUrl)}; process.stdout.write(utcTimestamp(1784000000000));`;
  const outputs = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map((timezone) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ: timezone } });
    assert.equal(result.status, 0, `${timezone}: ${result.stderr}`);
    return result.stdout;
  });
  assert.deepEqual(outputs, ["2026-07-14T03:33:20.000Z", "2026-07-14T03:33:20.000Z", "2026-07-14T03:33:20.000Z"]);
});

test("event-store case manifest freezes every acceptance ID with one result", () => {
  const manifestPath = path.resolve("tests/fixtures/event-store-cases-v3.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const range = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
  const expectedIds = [
    ...range("A", 8),
    ...range("C", 12),
    ...range("R", 8),
    ...range("T", 6),
    ...range("W", 8),
    ...range("P", 4),
  ];
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.plan_revision_sha256, "7989bdbd061165efb23618a52c7819d61db29d9449a2549ea2b24508ca1dfcf0");
  assert.deepEqual(manifest.cases.map((item) => item.id), expectedIds);
  assert.equal(new Set(manifest.cases.map((item) => item.id)).size, manifest.cases.length);
  for (const item of manifest.cases) {
    assert.deepEqual(Object.keys(item), ["id", "phase", "precondition", "injection_point", "expected"], item.id);
    for (const key of ["phase", "precondition", "injection_point", "expected"]) {
      assert.equal(typeof item[key], "string", `${item.id}.${key}`);
      assert.ok(item[key].trim(), `${item.id}.${key}`);
    }
  }
});

test("runtime-contract-5 fixture freezes the external handshake and authority hook failures", () => {
  assert.deepEqual(RUNTIME5_INFO, {
    runtime_contract: 5,
    task_snapshot_schema_version: 3,
    event_record_schema_version: 2,
    outcome_projection_schema_version: 3,
    event_store: ".workloop/events.jsonl",
    outcome_projection: "~/.workloop/outcomes.jsonl",
  });
  assert.deepEqual(RUNTIME5_EVENT_KINDS, V3_EVENT_KINDS);
  assert.deepEqual(AUTHORITY_FAILURE_HOOKS, {
    pretooluse_write: { exit: 0, frame: "deny" },
    pretooluse_read: { exit: 0, frame: "silent" },
    stop: { exit: 0, frame: "block" },
  });
});

test("runtime-contract-5 fixture freezes every persisted envelope and benchmark receipt", () => {
  assert.deepEqual(RECORD_FIELDS, [
    "record_schema_version", "transaction_id", "command_id", "repo_sequence",
    "occurred_at_epoch_ms", "occurred_at", "actor", "previous_record_digest",
    "events", "record_digest",
  ]);
  assert.deepEqual(EVENT_ENVELOPE_FIELDS, [
    "event_id", "task_id", "task_event_sequence", "kind", "payload_version", "payload",
  ]);
  assert.deepEqual(SNAPSHOT_FIELDS, [
    "schema_version", "runtime_contract", "source_cursor", "projection", "snapshot_digest",
  ]);
  assert.deepEqual(SNAPSHOT_SOURCE_CURSOR_FIELDS, [
    "event_store_file", "repo_sequence", "task_event_sequence", "record_digest", "event_id", "valid_end_offset",
  ]);
  assert.deepEqual(OUTCOME_PROJECTION_FIELDS, [
    "projection_schema_version", "repo_identity", "repo_sequence", "event_id", "task_id",
    "kind", "occurred_at_epoch_ms", "occurred_at", "payload", "row_digest",
  ]);
  assert.deepEqual(BENCHMARK_RECEIPT_FIELDS, [
    "receipt_schema_version", "status", "node", "os", "arch", "cpu", "filesystem",
    "capabilities", "record_count", "file_bytes", "samples", "summary", "thresholds", "passed",
  ]);
  assert.deepEqual(BENCHMARK_THRESHOLDS, {
    full_replay_max_ms: 200,
    incremental_tail_p95_max_ms: 5,
    append_fsync_p95_max_ms: 20,
    record_count: 10001,
  });
});

test("runtime-contract-5 fixture freezes nested payload, projection, and value constraints", () => {
  assert.deepEqual(RUNTIME5_EVENT_PAYLOAD_FIELDS, V3_EVENT_PAYLOAD_FIELDS);
  assert.deepEqual(Object.keys(RUNTIME5_EVENT_PAYLOAD_FIELDS), RUNTIME5_EVENT_KINDS);
  assert.deepEqual(TASK_PROJECTION_FIELDS, [
    "schema_version", "task_id", "task_revision", "last_substantive_task_revision", "artifact_revision",
    "created_at", "updated_at", "lifecycle", "goal", "criterion", "policy", "policy_rationale",
    "witness", "alignment", "envelope", "grants", "assurance", "budget", "spent", "evidence",
    "reviews", "attempts", "unsatisfied_streak", "episodes", "lifecycle_log", "task_event_sequence",
    "transcript_cursors",
  ]);
  assert.deepEqual(BENCHMARK_SAMPLE_FIELDS, ["full_replay_ms", "incremental_tail_ms", "append_fsync_ms"]);
  assert.deepEqual(BENCHMARK_SUMMARY_FIELDS, ["p50_ms", "p95_ms", "max_ms", "passed"]);
  assert.deepEqual(PERSISTED_VALUE_CONSTRAINTS, {
    digest: "sha256:<64 lowercase hex>",
    epoch_ms: "non-negative safe integer",
    timestamp: "UTC ISO derived from the same epoch_ms",
    command_id: "non-empty string or null",
    previous_record_digest: "null only at repo_sequence 1, otherwise digest",
    sequence: "positive contiguous safe integer",
    actor_kind: ["cli", "hook"],
    transcript_mode: ["baseline", "increment"],
    benchmark_status: ["not_implemented", "pass", "fail"],
    unknown_fields: "reject",
    unknown_versions: "reject",
  });
});

test("runtime-contract-5 fixture freezes a closed persisted type graph and digest preimages", () => {
  assert.deepEqual(Object.keys(PERSISTED_FIELD_CONTRACTS.record), RECORD_FIELDS);
  assert.deepEqual(Object.keys(PERSISTED_FIELD_CONTRACTS.event), EVENT_ENVELOPE_FIELDS);
  assert.deepEqual(Object.keys(PERSISTED_FIELD_CONTRACTS.snapshot), SNAPSHOT_FIELDS);
  assert.deepEqual(Object.keys(PERSISTED_FIELD_CONTRACTS.snapshot_source_cursor), SNAPSHOT_SOURCE_CURSOR_FIELDS);
  assert.deepEqual(Object.keys(PERSISTED_FIELD_CONTRACTS.task_projection), TASK_PROJECTION_FIELDS);
  assert.deepEqual(Object.keys(PERSISTED_FIELD_CONTRACTS.outcome_projection), OUTCOME_PROJECTION_FIELDS);
  assert.deepEqual(PERSISTED_FIELD_CONTRACTS.record, {
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
  });
  assert.deepEqual(PERSISTED_FIELD_CONTRACTS.event, {
    event_id: "sha256-digest",
    task_id: "uuid",
    task_event_sequence: "positive-safe-integer",
    kind: "enum:event-kind",
    payload_version: "literal:1",
    payload: "discriminated-object:event-payload-by-kind",
  });
  assert.deepEqual(PERSISTED_FIELD_CONTRACTS.snapshot, {
    schema_version: "literal:3",
    runtime_contract: "literal:4",
    source_cursor: "object:snapshot-source-cursor",
    projection: "object:task-projection",
    snapshot_digest: "sha256-digest",
  });
  assert.deepEqual(PERSISTED_FIELD_CONTRACTS.outcome_projection, {
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
  });

  assert.deepEqual(PERSISTED_NESTED_OBJECTS.actor, {
    kind: "enum:cli|hook",
    session_id: "null|non-empty-string",
  });
  assert.deepEqual(PERSISTED_NESTED_OBJECTS["payload.output_tokens_tallied"], {
    source_id: "sha256-digest",
    source_generation_id: "uuid",
    episode_id: "uuid",
    from_offset: "non-negative-safe-integer",
    to_offset: "non-negative-safe-integer",
    range_sha256: "sha256-digest",
    end_anchor_sha256: "sha256-digest",
    output_tokens_delta: "non-negative-safe-integer",
    mode: "enum:baseline|increment",
  });
  assert.deepEqual(Object.keys(PERSISTED_NESTED_OBJECTS).filter((name) => name.startsWith("payload.")), RUNTIME5_EVENT_KINDS.map((kind) => `payload.${kind}`));
  for (const kind of RUNTIME5_EVENT_KINDS) {
    assert.deepEqual(Object.keys(PERSISTED_NESTED_OBJECTS[`payload.${kind}`]), RUNTIME5_EVENT_PAYLOAD_FIELDS[kind], kind);
  }

  const referenced = [];
  for (const [container, fields] of Object.entries({ ...PERSISTED_FIELD_CONTRACTS, ...PERSISTED_NESTED_OBJECTS })) {
    for (const [field, descriptor] of Object.entries(fields)) {
      assert.equal(typeof descriptor, "string", `${container}.${field}`);
      for (const match of descriptor.matchAll(/object:([a-z0-9_.-]+)/g)) referenced.push([`${container}.${field}`, match[1]]);
    }
  }
  for (const [field, reference] of referenced) {
    if (reference === "event-payload-by-kind") continue;
    assert.ok(PERSISTED_FIELD_CONTRACTS[reference.replaceAll("-", "_")] || PERSISTED_NESTED_OBJECTS[reference], `${field} has unresolved ${reference}`);
  }
  assert.equal(
    createHash("sha256").update(JSON.stringify({ fields: PERSISTED_FIELD_CONTRACTS, nested: PERSISTED_NESTED_OBJECTS })).digest("hex"),
    // cli_verify observation source added 2026-07-19; the deliberate change is
    // documented in docs/plans/2026-07-19-cli-recorded-observation.md.
    "d2fe219f390882a111fdbe618e10cda374401248b62e9f51a82122f0dd6fcf94",
  );

  assert.deepEqual(PERSISTED_CANONICAL_PREIMAGES, {
    event_id: {
      encoding: "utf8(canonical-json)",
      include: ["task_id", "task_event_sequence", "kind", "payload_version", "payload"],
      exclude: ["event_id"],
      output: "sha256:<64 lowercase hex>",
    },
    record_digest: {
      encoding: "utf8(canonical-json)",
      include: ["record_schema_version", "transaction_id", "command_id", "repo_sequence", "occurred_at_epoch_ms", "occurred_at", "actor", "previous_record_digest", "events"],
      exclude: ["record_digest"],
      output: "sha256:<64 lowercase hex>",
    },
    snapshot_digest: {
      encoding: "utf8(canonical-json)",
      include: ["schema_version", "runtime_contract", "source_cursor", "projection"],
      exclude: ["snapshot_digest"],
      output: "sha256:<64 lowercase hex>",
    },
    row_digest: {
      encoding: "utf8(canonical-json)",
      include: ["projection_schema_version", "repo_identity", "repo_sequence", "event_id", "task_id", "kind", "occurred_at_epoch_ms", "occurred_at", "payload"],
      exclude: ["row_digest"],
      output: "sha256:<64 lowercase hex>",
    },
  });
  assert.throws(() => assertPersistedDescriptor("3", "literal:3", "numeric literal"));
  assert.throws(() => assertPersistedDescriptor("雪".repeat(2049), "string:max-4096-utf8-bytes", "bounded text"));
  assert.throws(() => assertPersistedDescriptor("a/../../outside", "repo-relative-path", "escaping path"));
  assert.throws(() => assertPersistedDescriptor("C:/outside", "repo-relative-path", "Windows slash absolute path"));
  assert.throws(() => assertPersistedDescriptor("C:\\outside", "repo-relative-path", "Windows backslash absolute path"));
});

test("runtime-contract-5 fixture freezes authority and corruption errors exactly", () => {
  assert.deepEqual(V3_ERROR_MESSAGES, {
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
});

test("event fixtures are deterministic without committing generated datasets", () => {
  assert.equal(deterministicId("phase-0", "task", 7), deterministicId("phase-0", "task", 7));
  assert.notEqual(deterministicId("phase-0", "task", 7), deterministicId("phase-0", "task", 8));
  const command = makeTaskOpenedCommand({ seed: "phase-0", index: 7, atEpochMs: 1_784_000_000_000 });
  assert.equal(command.type, "open");
  assert.equal(command.at, "2026-07-14T03:33:20.000Z");
  assert.equal(command.taskId, "53efcd7f-49fe-455c-8582-7a181f745569");
  assert.equal(command.observation.verdict, "unsatisfied");
  assert.equal(command.episodes[0].episode_id, "963711c6-83c3-4d21-90b6-33755a2beb13");
});

test("record and transcript generators produce deterministic bounded inputs lazily", () => {
  let count = 0;
  let first;
  let last;
  const datasetDigest = createHash("sha256");
  for (const fact of generateRecordFacts({ seed: "benchmark-v1", count: 10001, startEpochMs: 1_784_000_000_000 })) {
    first ??= fact;
    last = fact;
    count += 1;
    datasetDigest.update(`${JSON.stringify(fact)}\n`);
  }
  assert.equal(count, 10001);
  assert.equal(first.repo_sequence, 1);
  assert.equal(first.events[0].kind, "task_opened");
  assert.equal(first.events[0].task_event_sequence, 1);
  assertPersistedDescriptor(first.events[0].payload, "object:payload.task_opened", "first.events[0].payload");
  assert.equal(last.repo_sequence, 10001);
  assert.equal(last.events[0].kind, "write_authorized");
  assert.equal(last.events[0].task_event_sequence, 10001);
  assert.equal(datasetDigest.digest("hex"), "76977fee184dab1d8c539862c77b24dde71a81999549c54c2b541a9e2cc05923");

  const transcript = makeTranscriptBytes({ seed: "transcript-v1", rows: 3, lineEnding: "\r\n", finalPartial: true });
  assert.ok(Buffer.isBuffer(transcript));
  assert.equal(transcript.includes(Buffer.from("雪")), true);
  assert.equal(transcript.toString("utf8").split("\r\n").length, 4);
  assert.equal(transcript.toString("utf8").endsWith("partial"), true);
  const completeRows = transcript.toString("utf8").split("\r\n").slice(0, 3).map(JSON.parse);
  assert.deepEqual(completeRows.map((row) => row.message.usage.output_tokens), [1, 2, 3]);
});

test("crash and benchmark scripts freeze interfaces without fabricating evidence", () => {
  const run = (script, args) => spawnSync(process.execPath, [path.resolve(script), ...args], { encoding: "utf8" });
  const crash = run("tests/helpers/event-store-crash-child.mjs", ["--describe"]);
  assert.equal(crash.status, 0, crash.stderr);
  assert.deepEqual(JSON.parse(crash.stdout), {
    interface_version: 1,
    production_module: "lib/event-store.mjs",
    snapshot_module: "lib/task-store.mjs",
    operations: ["create-genesis", "append", "recover", "write-snapshot"],
    seams: [
      "before-genesis-temp-create",
      "during-genesis-write",
      "after-genesis-temp-fsync",
      "after-genesis-rename",
      "before-append",
      "during-append",
      "after-record-write",
      "after-event-fsync",
      "during-snapshot-write",
      "after-snapshot-rename",
      "after-quarantine-receipt-fsync",
    ],
    required_arguments: ["--repo", "--operation", "--seam", "--command-file"],
    notification_fields: ["protocol_version", "operation", "seam", "pid", "repo", "at_epoch_ms"],
    notification_protocol: "newline JSON on stdout after a production seam is reached",
    termination_protocol: "parent process terminates this child after the requested notification",
  });

  const described = run("tests/event-store-benchmark.mjs", ["--describe"]);
  assert.equal(described.status, 0, described.stderr);
  const benchmarkInterface = JSON.parse(described.stdout);
  assert.deepEqual(benchmarkInterface.thresholds, BENCHMARK_THRESHOLDS);
  assert.deepEqual(benchmarkInterface.receipt_fields, BENCHMARK_RECEIPT_FIELDS);

  assert.deepEqual(benchmarkInterface.receipt_fields, BENCHMARK_RECEIPT_FIELDS);
});

test("decide and evolve open a schema-v3 task from injected facts without mutation", () => {
  const command = makeTaskOpenedCommand({ seed: "phase-1", index: 1, atEpochMs: 1_784_000_000_000 });
  const before = structuredClone(command);
  const decision = decide(null, command);
  assert.deepEqual(command, before);
  assert.equal(decision.result.status, "opened");
  assert.equal(decision.events.length, 1);
  const [event] = decision.events;
  assert.equal(event.kind, "task_opened");
  assert.equal(event.payload_version, 1);
  assert.equal(event.task_id, command.taskId);
  assert.equal(event.at, command.at);
  assert.deepEqual(Object.keys(event.payload), V3_EVENT_PAYLOAD_FIELDS.task_opened);
  const detachedGoal = event.payload.criterion.source.value;
  command.criterion.source.value = "mutated after decide";
  assert.equal(event.payload.criterion.source.value, detachedGoal);

  const state = evolve(null, event);
  assert.equal(state.schema_version, 3);
  assert.equal(state.task_id, command.taskId);
  assert.equal(state.lifecycle.state, "active");
  assert.equal(state.task_revision, 1);
  assert.equal(state.task_event_sequence, 1);
  assert.deepEqual(state.transcript_cursors, {});
  assert.equal(state.created_at, command.at);
  assertPersistedDescriptor(state, "object:task-projection", "opened projection");
  command.criterion.source.value = before.criterion.source.value;
  assert.deepEqual(command, before);
});

test("write authorization tallies one transcript range before invalidating artifacts", () => {
  const opened = makeTaskOpenedCommand({ seed: "phase-1", index: 2, atEpochMs: 1_784_000_000_000 });
  const openDecision = decide(null, opened);
  const initial = evolve(null, openDecision.events[0]);
  const sourceId = sha256Hex("/workspace/transcript.jsonl");
  const generationId = deterministicId("phase-1", "transcript-generation", 2);
  const episodeId = initial.episodes[0].episode_id;
  const baselineDecision = decide(initial, {
    type: "tally-transcript",
    taskId: initial.task_id,
    at: "2026-07-14T03:33:40.000Z",
    transcriptRange: {
      source_id: sourceId,
      source_generation_id: generationId,
      episode_id: episodeId,
      from_offset: 0,
      to_offset: 20,
      range_sha256: sha256Hex("baseline-0-20"),
      end_anchor_sha256: sha256Hex("anchor-20"),
      output_tokens_delta: 0,
      mode: "baseline",
    },
  });
  const withBaseline = baselineDecision.events.reduce((state, event) => evolve(state, event), initial);
  const command = {
    type: "authorize-write",
    taskId: initial.task_id,
    at: "2026-07-14T03:34:20.000Z",
    decision: "allow",
    files: ["work.txt"],
    transcriptRange: {
      source_id: sourceId,
      source_generation_id: generationId,
      episode_id: episodeId,
      from_offset: 20,
      to_offset: 40,
      range_sha256: sha256Hex("range-20-40"),
      end_anchor_sha256: sha256Hex("anchor-40"),
      output_tokens_delta: 120,
      mode: "increment",
    },
  };
  const before = structuredClone(withBaseline);
  const decision = decide(withBaseline, command);
  assert.deepEqual(withBaseline, before);
  assert.deepEqual(decision.events.map((event) => event.kind), ["output_tokens_tallied", "write_authorized"]);
  assert.equal(decision.result.status, "allow");

  const next = decision.events.reduce((state, event) => evolve(state, event), withBaseline);
  assert.equal(next.spent.output_tokens_estimate, 120);
  assert.equal(next.spent.writes, 1);
  assert.equal(next.artifact_revision, 1);
  assert.equal(next.task_event_sequence, 4);
  assert.deepEqual(next.evidence.touched_files, ["work.txt"]);
  assert.deepEqual(next.transcript_cursors[sourceId], {
    source_generation_id: generationId,
    episode_id: episodeId,
    offset: 40,
    range_sha256: sha256Hex("range-20-40"),
    end_anchor_sha256: sha256Hex("anchor-40"),
  });
  assert.equal(next.episodes[0].output_tokens_estimate, 120);
  assert.deepEqual(withBaseline, before);
});

test("one observation decision can suspend atomically and replay without a snapshot", () => {
  const opened = makeTaskOpenedCommand({ seed: "phase-1", index: 3, atEpochMs: 1_784_000_000_000 });
  const openDecision = decide(null, opened);
  const initial = evolve(null, openDecision.events[0]);
  const sourceId = sha256Hex("/workspace/stop-transcript.jsonl");
  const generationId = deterministicId("phase-1", "transcript-generation", 3);
  const episodeId = initial.episodes[0].episode_id;
  const baselineDecision = decide(initial, {
    type: "tally-transcript",
    taskId: initial.task_id,
    at: "2026-07-14T03:33:40.000Z",
    transcriptRange: {
      source_id: sourceId,
      source_generation_id: generationId,
      episode_id: episodeId,
      from_offset: 0,
      to_offset: 10,
      range_sha256: sha256Hex("stop-baseline"),
      end_anchor_sha256: sha256Hex("stop-anchor-10"),
      output_tokens_delta: 0,
      mode: "baseline",
    },
  });
  let state = baselineDecision.events.reduce((current, event) => evolve(current, event), initial);
  const history = [...openDecision.events, ...baselineDecision.events];
  let decision;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const atEpochMs = 1_784_000_040_000 + attempt * 20_000;
    const at = new Date(atEpochMs).toISOString();
    const command = {
      type: "observe",
      taskId: initial.task_id,
      at,
      atEpochMs,
      observation: {
        observation_id: deterministicId("phase-1", "observation", 30 + attempt),
        verdict: "unsatisfied",
        execution: { exit_code: 1, signal: null, duration_ms: 1, execution_error: null, output_tail: "still failing", timeout_seconds: 30 },
        changed_paths: [],
        observed_at: at,
      },
      attemptId: deterministicId("phase-1", "attempt", 30 + attempt),
      signature: sha256Hex("failure-signature"),
      failureSummary: "criterion remains unsatisfied",
      drift: [],
      source: "stop",
      autoSuspend: true,
      remaining: "criterion is unsatisfied",
      actingSession: initial.episodes[0].host_session_id,
      ...(attempt === 3 ? {
        transcriptRange: {
          source_id: sourceId,
          source_generation_id: generationId,
          episode_id: episodeId,
          from_offset: 10,
          to_offset: 30,
          range_sha256: sha256Hex("stop-range-10-30"),
          end_anchor_sha256: sha256Hex("stop-anchor-30"),
          output_tokens_delta: 50,
          mode: "increment",
        },
      } : {}),
    };
    decision = decide(state, command);
    if (attempt < 3) {
      assert.deepEqual(decision.events.map((event) => event.kind), ["criterion_observed"]);
      assert.deepEqual(decision.result, { status: "observed" });
    }
    state = decision.events.reduce((current, event) => evolve(current, event), state);
    history.push(...decision.events);
  }
  assert.deepEqual(decision.events.map((event) => event.kind), ["output_tokens_tallied", "criterion_observed", "task_suspended"]);
  assert.deepEqual(decision.result, { status: "suspended", reason: "stuck", judgment: { remaining: "criterion is unsatisfied", failure: "same failure repeated 3 times", next_action: "change the approach or inputs, then resume" } });
  const next = state;
  assert.equal(next.lifecycle.state, "suspended");
  assert.equal(next.lifecycle.reason, "stuck");
  assert.equal(next.lifecycle.judgment.failure, "same failure repeated 3 times");
  assert.equal(next.unsatisfied_streak, 3);
  assert.equal(next.spent.rounds, 3);
  assert.equal(next.spent.output_tokens_estimate, 50);
  assert.equal(next.attempts.length, 3);
  assert.equal(next.episodes[0].ended_at, decision.events.at(-1).at);
  assert.equal(next.task_event_sequence, 7);

  const frozenHistory = structuredClone(history);
  const replayed = evolveAll(null, history);
  assert.deepEqual(replayed, next);
  assert.deepEqual(history, frozenHistory);
});

test("a suspended write denial still commits a new tally range and cannot replay it", () => {
  const opened = makeTaskOpenedCommand({ seed: "phase-1", index: 4, atEpochMs: 1_784_000_000_000 });
  const openEvent = decide(null, opened).events[0];
  const initial = evolve(null, openEvent);
  const sourceId = sha256Hex("/workspace/suspended-transcript.jsonl");
  const generationId = deterministicId("phase-1", "transcript-generation", 4);
  const episodeId = initial.episodes[0].episode_id;
  const baseline = decide(initial, {
    type: "tally-transcript",
    taskId: initial.task_id,
    at: "2026-07-14T03:33:40.000Z",
    transcriptRange: {
      source_id: sourceId,
      source_generation_id: generationId,
      episode_id: episodeId,
      from_offset: 0,
      to_offset: 10,
      range_sha256: sha256Hex("suspended-baseline"),
      end_anchor_sha256: sha256Hex("suspended-anchor-10"),
      output_tokens_delta: 0,
      mode: "baseline",
    },
  }).events[0];
  const withBaseline = evolve(initial, baseline);
  const suspendDecision = decide(withBaseline, {
    type: "suspend",
    taskId: initial.task_id,
    at: "2026-07-14T03:34:20.000Z",
    reason: "stuck",
    judgment: { remaining: "work", failure: "blocked", next_action: "resume later" },
    closeEpisode: true,
    source: "stop",
    actingSession: initial.episodes[0].host_session_id,
  });
  const suspended = suspendDecision.events.reduce((state, event) => evolve(state, event), withBaseline);
  const deniedCommand = {
    type: "authorize-write",
    taskId: initial.task_id,
    at: "2026-07-14T03:35:20.000Z",
    decision: "deny",
    reason: "task suspended (stuck); resume before writing",
    files: ["work.txt"],
    transcriptRange: {
      source_id: sourceId,
      source_generation_id: generationId,
      episode_id: episodeId,
      from_offset: 10,
      to_offset: 30,
      range_sha256: sha256Hex("suspended-range-10-30"),
      end_anchor_sha256: sha256Hex("suspended-anchor-30"),
      output_tokens_delta: 75,
      mode: "increment",
    },
  };
  const denied = decide(suspended, deniedCommand);
  assert.deepEqual(denied.events.map((event) => event.kind), ["output_tokens_tallied"]);
  assert.equal(denied.result.status, "deny");
  const tallied = evolve(suspended, denied.events[0]);
  assert.equal(tallied.lifecycle.state, "suspended");
  assert.equal(tallied.spent.output_tokens_estimate, 75);
  assert.equal(tallied.spent.writes, 0);
  assert.equal(tallied.artifact_revision, 0);
  assert.equal(tallied.episodes[0].output_tokens_estimate, 0);
  assert.throws(() => decide(tallied, deniedCommand), /authoritative cursor/);
  assert.throws(() => evolve(tallied, denied.events[0]), /authoritative cursor/);
});

test("schema-v3 resume and join rotate episodes through explicit events", () => {
  const opened = makeTaskOpenedCommand({ seed: "phase-1-lifecycle", index: 1, atEpochMs: 1_784_000_000_000 });
  let state = evolve(null, decide(null, opened).events[0]);
  state = evolveAll(state, decide(state, {
    type: "suspend", taskId: state.task_id, at: "2026-07-14T03:34:00.000Z", reason: "needs_input",
    judgment: { remaining: "choose a target", failure: "target is ambiguous", next_action: "provide the target" },
    closeEpisode: true, source: "cli", actingSession: state.episodes[0].host_session_id,
  }).events);
  const resumeEpisode = {
    episode_id: deterministicId("phase-1-lifecycle", "episode", 2),
    host_session_id: deterministicId("phase-1-lifecycle", "session", 2),
    started_at: "2026-07-14T03:35:00.000Z", ended_at: null,
    start_task_revision: state.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0,
  };
  const resumed = decide(state, {
    type: "resume", taskId: state.task_id, at: resumeEpisode.started_at, atEpochMs: Date.parse(resumeEpisode.started_at),
    reason: "target supplied", episode: resumeEpisode, actingSession: resumeEpisode.host_session_id,
  });
  assert.deepEqual(resumed.events.map((event) => event.kind), ["task_resumed"]);
  state = evolveAll(state, resumed.events);
  assert.equal(state.lifecycle.state, "active");
  assert.deepEqual(state.episodes[1], resumeEpisode);
  assert.equal(state.lifecycle_log.at(-1).event, "resume");

  const joinedEpisode = {
    episode_id: deterministicId("phase-1-lifecycle", "episode", 3),
    host_session_id: deterministicId("phase-1-lifecycle", "session", 3),
    started_at: "2026-07-14T03:36:00.000Z", ended_at: null,
    start_task_revision: state.task_revision + 1, end_task_revision: null, output_tokens_estimate: 0,
  };
  const joined = decide(state, {
    type: "join", taskId: state.task_id, at: joinedEpisode.started_at,
    reason: "new host owns the work", episode: joinedEpisode, actingSession: joinedEpisode.host_session_id,
  });
  assert.deepEqual(joined.events.map((event) => event.kind), ["task_joined"]);
  state = evolveAll(state, joined.events);
  assert.equal(state.episodes[1].ended_at, joinedEpisode.started_at);
  assert.deepEqual(state.episodes[2], joinedEpisode);
  assert.equal(state.lifecycle_log.at(-1).event, "join");
  assert.equal(state.task_event_sequence, 4);
});

test("schema-v3 governance and criterion-side-effect events preserve revision semantics", () => {
  const opened = makeTaskOpenedCommand({ seed: "phase-1-governance", index: 1, atEpochMs: 1_784_000_000_000 });
  opened.criterion.provenance = "unresolved";
  opened.criterion.input_coverage = "unknown";
  let state = evolve(null, decide(null, opened).events[0]);
  state.assurance.risk_floor_events.push("criterion_amended_after_write");
  const nonDefaultPolicy = { open_requirement: "determinate", witness_requirement: "required", close_policy: "automatic" };
  assert.throws(() => decide(state, {
    type: "amend", taskId: state.task_id, at: "2026-07-14T03:33:30.000Z", reason: "change policy", policy: nonDefaultPolicy,
  }), /generation/i);
  const policyOnly = decide(state, {
    type: "amend", taskId: state.task_id, at: "2026-07-14T03:33:30.000Z", reason: "change policy",
    policy: nonDefaultPolicy, generationId: deterministicId("phase-1-governance", "criterion-generation", 2),
  });
  assert.equal(policyOnly.events[0].payload.policy_rationale, "change policy");
  const review = {
    review_id: deterministicId("phase-1-governance", "review", 1), criterion_generation_id: state.criterion.criterion_generation_id,
    reviewed_task_revision: state.last_substantive_task_revision, reviewed_artifact_revision: state.artifact_revision,
    level: "fresh_context", reviewer: "independent-reviewer", blocking_findings_count: 0, advisory_findings_count: 1,
    reviewed_at: "2026-07-14T03:34:00.000Z", acting_session: null,
  };
  const reviewed = decide(state, { type: "review", taskId: state.task_id, at: review.reviewed_at, record: review });
  assert.deepEqual(reviewed.events.map((event) => event.kind), ["review_recorded"]);
  state = evolveAll(state, reviewed.events);
  assert.deepEqual(state.reviews, [review]);

  const acceptance = {
    acceptance_id: deterministicId("phase-1-governance", "acceptance", 1), reason: "external checker cannot be vendored",
    granted_by: "user", accepted_at: "2026-07-14T03:35:00.000Z", criterion_generation_id: state.criterion.criterion_generation_id,
    accepted_at_task_revision: state.task_revision + 1,
  };
  const accepted = decide(state, { type: "accept-proof-gap", taskId: state.task_id, at: acceptance.accepted_at, record: acceptance });
  assert.deepEqual(accepted.events.map((event) => event.kind), ["proof_gap_accepted"]);
  state = evolveAll(state, accepted.events);
  assert.deepEqual(state.assurance.proof_gap_acceptances, [acceptance]);

  const amended = decide(state, {
    type: "amend", taskId: state.task_id, at: "2026-07-14T03:36:00.000Z", reason: "tighten scope",
    goal: "fixture task with tighter scope", alignment: { because: "new evidence", not_covered: ["deployment"] }, rounds: 12,
  });
  assert.deepEqual(amended.events.map((event) => event.kind), ["task_amended"]);
  assert.equal(amended.events[0].payload.artifact_revision, state.artifact_revision);
  state = evolveAll(state, amended.events);
  assert.equal(state.goal, "fixture task with tighter scope");
  assert.equal(state.budget.rounds, 12);
  assert.deepEqual(state.alignment, { because: "new evidence", not_covered: ["deployment"] });
  assert.equal(state.last_substantive_task_revision, state.task_revision);

  const observation = {
    observation_id: deterministicId("phase-1-governance", "observation", 9), verdict: "indeterminate",
    criterion_generation_id: null, observed_artifact_revision: null, observed_at: "2026-07-14T03:37:00.000Z",
    execution: { exit_code: 2, signal: null, duration_ms: 1, execution_error: "criterion_side_effect", output_tail: "criterion changed work.txt", timeout_seconds: 120 },
    changed_paths: ["work.txt"],
  };
  const sourceId = sha256Hex("/workspace/governance-transcript.jsonl");
  const generationId = deterministicId("phase-1-governance", "transcript-generation", 1);
  const episodeId = state.episodes.at(-1).episode_id;
  state = evolveAll(state, decide(state, {
    type: "tally-transcript", taskId: state.task_id, at: "2026-07-14T03:36:30.000Z",
    transcriptRange: {
      source_id: sourceId, source_generation_id: generationId, episode_id: episodeId,
      from_offset: 0, to_offset: 10, range_sha256: sha256Hex("governance-baseline"),
      end_anchor_sha256: sha256Hex("governance-anchor-10"), output_tokens_delta: 0, mode: "baseline",
    },
  }).events);
  const sideEffect = decide(state, {
    type: "criterion-side-effect", taskId: state.task_id, at: observation.observed_at, observation,
    transcriptRange: {
      source_id: sourceId, source_generation_id: generationId, episode_id: episodeId,
      from_offset: 10, to_offset: 20, range_sha256: sha256Hex("governance-range-10-20"),
      end_anchor_sha256: sha256Hex("governance-anchor-20"), output_tokens_delta: 8, mode: "increment",
    },
  });
  assert.deepEqual(sideEffect.events.map((event) => event.kind), ["output_tokens_tallied", "criterion_side_effect_recorded"]);
  const artifactBefore = state.artifact_revision;
  state = evolveAll(state, sideEffect.events);
  assert.equal(state.artifact_revision, artifactBefore + 1);
  assert.equal(state.criterion.last_observation.observation_id, observation.observation_id);
  assert.equal(state.criterion.last_observation.observed_artifact_revision, state.artifact_revision);
  assert.equal(state.spent.output_tokens_estimate, 8);
  assert.equal(state.task_event_sequence, 7);
  assertPersistedDescriptor(state, "object:task-projection", "governance projection");
});

test("schema-v3 terminal events cover achieved, not-needed, and abandoned tasks", () => {
  const openState = (index) => {
    const command = makeTaskOpenedCommand({ seed: "phase-1-terminal", index, atEpochMs: 1_784_000_000_000 + index });
    command.assurance.declared_risk = "routine";
    command.assurance.risk_reason = "isolated reversible fixture";
    command.assurance.risk_declared_by = "self";
    return evolve(null, decide(null, command).events[0]);
  };
  const achievedInitial = openState(1);
  const achievedAt = "2026-07-14T03:34:00.000Z";
  const achievedObservation = {
    observation_id: deterministicId("phase-1-terminal", "observation", 1), verdict: "satisfied",
    criterion_generation_id: null, observed_artifact_revision: null, observed_at: achievedAt,
    execution: { exit_code: 0, signal: null, duration_ms: 1, execution_error: null, output_tail: "ok", timeout_seconds: 120 },
    changed_paths: [],
  };
  const achieved = decide(achievedInitial, {
    type: "achieve", taskId: achievedInitial.task_id, at: achievedAt, atEpochMs: Date.parse(achievedAt),
    observation: achievedObservation, attemptId: null, signature: null, failureSummary: "", drift: [],
    actingSession: achievedInitial.episodes[0].host_session_id,
  });
  assert.deepEqual(achieved.events.map((event) => event.kind), ["criterion_observed", "task_terminal"]);
  const achievedState = evolveAll(achievedInitial, achieved.events);
  assert.deepEqual(achieved.result, { status: "terminal", outcome: "achieved" });
  assert.equal(achievedState.lifecycle.outcome, "achieved");
  assert.equal(achievedState.lifecycle.closing_observation_id, achievedObservation.observation_id);
  assertPersistedDescriptor(achievedState, "object:task-projection", "achieved projection");

  const stoppedInitial = openState(4);
  const stoppedAt = "2026-07-14T03:34:30.000Z";
  const stoppedObservation = { ...structuredClone(achievedObservation), observation_id: deterministicId("phase-1-terminal", "observation", 4), observed_at: stoppedAt };
  const stopped = decide(stoppedInitial, {
    type: "observe", taskId: stoppedInitial.task_id, at: stoppedAt, atEpochMs: Date.parse(stoppedAt),
    observation: stoppedObservation, attemptId: null, signature: null, failureSummary: "", drift: [],
    source: "stop", autoSuspend: true, actingSession: stoppedInitial.episodes[0].host_session_id,
  });
  assert.deepEqual(stopped.events.map((event) => event.kind), ["criterion_observed", "task_terminal"]);
  assert.deepEqual(stopped.result, { status: "terminal", outcome: "achieved" });
  assert.equal(evolveAll(stoppedInitial, stopped.events).lifecycle.outcome, "achieved");
  assert.throws(() => decide(openState(5), {
    type: "observe", taskId: openState(5).task_id, at: stoppedAt, atEpochMs: Date.parse(stoppedAt) + 1,
    observation: { ...stoppedObservation, verdict: "unsatisfied" }, attemptId: deterministicId("phase-1-terminal", "attempt", 5),
    signature: "failure", failureSummary: "failure", drift: [], source: "stop", autoSuspend: true,
  }), /matching atEpochMs/);

  const notNeededInitial = openState(2);
  const notNeeded = decide(notNeededInitial, {
    type: "not-needed", taskId: notNeededInitial.task_id, at: "2026-07-14T03:35:00.000Z",
    evidence: "the requested artifact already exists", actingSession: null,
  });
  assert.deepEqual(notNeeded.events.map((event) => event.kind), ["task_terminal"]);
  const notNeededState = evolveAll(notNeededInitial, notNeeded.events);
  assert.equal(notNeededState.lifecycle.outcome, "not_needed");
  assert.equal(notNeededState.lifecycle.evidence, "the requested artifact already exists");

  const abandonedInitial = openState(3);
  const abandoned = decide(abandonedInitial, {
    type: "abandon", taskId: abandonedInitial.task_id, at: "2026-07-14T03:36:00.000Z",
    reason: "owner cancelled the task", actingSession: null,
  });
  assert.deepEqual(abandoned.events.map((event) => event.kind), ["task_terminal"]);
  const abandonedState = evolveAll(abandonedInitial, abandoned.events);
  assert.equal(abandonedState.lifecycle.outcome, "abandoned");
  assert.equal(abandonedState.lifecycle.reason, "owner cancelled the task");
});

test("[W08] production event store probes directory fsync while committing a canonical genesis", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop event 空格 "));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const command = makeTaskOpenedCommand({ seed: "event-store-production", index: 1, atEpochMs: 1_784_000_000_000 });
  const domainEvent = decide(null, command).events[0];
  const record = buildRecord({
    transactionId: deterministicId("event-store-production", "transaction", 1),
    commandId: null,
    repoSequence: 1,
    occurredAtEpochMs: command.atEpochMs,
    actor: { kind: "cli", session_id: command.actingSession },
    previousRecordDigest: null,
    events: [{ ...domainEvent, task_event_sequence: 1 }],
  });
  assert.equal(record.events[0].event_id, "sha256:dab33a3f1b7e2ec0eddd17c0e6a730fa5b9f96a2f8268a03d1f0e34d7bae3c0b");
  assert.equal(record.record_digest, "sha256:ab9436ad6e73a9a64f8b6e58abc4d90926259dc6d3d7970433f13bb8cb590923");
  assert.throws(() => buildRecord({
    transactionId: record.transaction_id, commandId: 42, repoSequence: 1,
    occurredAtEpochMs: command.atEpochMs, actor: record.actor, previousRecordDigest: null,
    events: [{ ...domainEvent, task_event_sequence: 1 }],
  }), (error) => error.code === "UNKNOWN_RECORD_FIELD");
  assert.throws(() => buildRecord({
    transactionId: record.transaction_id, commandId: null, repoSequence: 1,
    occurredAtEpochMs: command.atEpochMs, actor: { kind: "cli", session_id: 42 }, previousRecordDigest: null,
    events: [{ ...domainEvent, task_event_sequence: 1 }],
  }), (error) => error.code === "UNKNOWN_RECORD_FIELD");
  assert.throws(() => buildRecord({
    transactionId: record.transaction_id, commandId: null, repoSequence: 2,
    occurredAtEpochMs: command.atEpochMs, actor: record.actor, previousRecordDigest: null,
    events: [{ ...domainEvent, task_event_sequence: 1 }],
  }), (error) => error.code === "HASH_CHAIN_MISMATCH");
  assert.deepEqual(Object.keys(record), RECORD_FIELDS);
  assert.deepEqual(Object.keys(record.events[0]), EVENT_ENVELOPE_FIELDS);

  const receipt = commitRecord(repo, record);
  assert.deepEqual(receipt, {
    committed: true,
    genesis: true,
    repo_sequence: 1,
    record_digest: record.record_digest,
    bytes_written: Buffer.byteLength(`${canonicalJson(record)}\n`),
    directory_fsync: receipt.directory_fsync,
    cursor: {
      valid_end_offset: Buffer.byteLength(`${canonicalJson(record)}\n`),
      last_repo_sequence: 1,
      last_record_digest: record.record_digest,
      task_sequences: { [command.taskId]: 1 },
    },
  });
  if (process.platform === "win32") assert.match(receipt.directory_fsync, /^(?:supported|unsupported:(?:EISDIR|EPERM|EINVAL))$/);
  else assert.equal(receipt.directory_fsync, "supported");
  assert.equal(eventStorePath(repo), path.join(repo, ".workloop", "events.jsonl"));
  const replay = readEventStore(repo);
  assert.equal(replay.records.length, 1);
  assert.deepEqual(replay.records[0], record);
  assert.equal(replay.valid_end_offset, receipt.bytes_written);
  assert.equal(replay.last_record_digest, record.record_digest);
  assert.deepEqual(replay.task_sequences, { [command.taskId]: 1 });
  assert.deepEqual(replay.source_cursor, {
    event_store_file: "events.jsonl",
    repo_sequence: 1,
    task_event_sequence: 1,
    record_digest: record.record_digest,
    event_id: record.events[0].event_id,
    valid_end_offset: receipt.bytes_written,
  });
  assert.equal(replay.events[0].at, command.at);
  assert.equal(replay.events[0].atEpochMs, command.atEpochMs);
  assert.deepEqual(auditEventStore(repo), {
    valid: true,
    record_count: 1,
    event_count: 1,
    valid_end_offset: receipt.bytes_written,
    last_repo_sequence: 1,
    last_record_digest: record.record_digest,
    recovered_tail: null,
    error: null,
  });
});

test("[W08] directory fsync degrades only for the frozen Windows capability allowlist", () => {
  assert.deepEqual(WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED, { open: ["EISDIR", "EPERM"], fsync: ["EINVAL", "EPERM"] });
  for (const code of WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.open) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(syncDirectory("C:\\repo\\.workloop", { openSync() { throw error; } }, "win32"), `unsupported:${code}`);
  }
  for (const code of WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.fsync) {
    let closed = 0;
    const error = Object.assign(new Error(code), { code });
    assert.equal(syncDirectory("C:\\repo\\.workloop", { openSync() { return 9; }, fsyncSync() { throw error; }, closeSync(fd) { assert.equal(fd, 9); closed += 1; } }, "win32"), `unsupported:${code}`);
    assert.equal(closed, 1);
  }
  for (const stage of ["open", "fsync"]) {
    const error = Object.assign(new Error("unexpected"), { code: "EACCES" });
    const operations = stage === "open"
      ? { openSync() { throw error; } }
      : { openSync() { return 9; }, fsyncSync() { throw error; }, closeSync() {} };
    assert.throws(() => syncDirectory("C:\\repo\\.workloop", operations, "win32"), (seen) => seen === error);
  }
});

test("record schema 2 appends to and replays a legacy schema-1 authority", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-record-upgrade-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const opened = makeTaskOpenedCommand({ seed: "record-upgrade", index: 1, atEpochMs: 1_784_000_000_000 });
  const openEvent = { ...decide(null, opened).events[0], task_event_sequence: 1 };
  const modernGenesis = buildRecord({
    transactionId: deterministicId("record-upgrade", "transaction", 1), commandId: null, repoSequence: 1,
    occurredAtEpochMs: opened.atEpochMs, actor: { kind: "cli", session_id: opened.actingSession }, previousRecordDigest: null, events: [openEvent],
  });
  const legacyGenesis = structuredClone(modernGenesis);
  legacyGenesis.record_schema_version = 1;
  delete legacyGenesis.events[0].payload.criterion.authored_by;
  const eventPreimage = Object.fromEntries(Object.entries(legacyGenesis.events[0]).filter(([key]) => key !== "event_id"));
  legacyGenesis.events[0].event_id = sha256Hex(canonicalJson(eventPreimage));
  const recordPreimage = Object.fromEntries(Object.entries(legacyGenesis).filter(([key]) => key !== "record_digest"));
  legacyGenesis.record_digest = sha256Hex(canonicalJson(recordPreimage));
  assert.equal(commitRecord(repo, legacyGenesis).committed, true);

  const initial = evolve(null, openEvent);
  const writeEvent = decide(initial, { type: "authorize-write", taskId: opened.taskId, decision: "allow", files: ["work.txt"], actingSession: null, at: "2026-07-14T03:34:21.000Z", atEpochMs: 1_784_000_001_000 }).events[0];
  const currentRecord = buildRecord({
    transactionId: deterministicId("record-upgrade", "transaction", 2), commandId: null, repoSequence: 2,
    occurredAtEpochMs: 1_784_000_001_000, actor: { kind: "cli", session_id: null }, previousRecordDigest: legacyGenesis.record_digest,
    events: [{ ...writeEvent, task_event_sequence: 2 }],
  });
  assert.equal(currentRecord.record_schema_version, 2);
  assert.equal(commitRecord(repo, currentRecord).committed, true);
  assert.deepEqual(readEventStore(repo).records.map((record) => record.record_schema_version), [1, 2]);
});

test("production event store appends one complete transaction and enforces the chain", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-append-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const opened = makeTaskOpenedCommand({ seed: "event-store-append", index: 1, atEpochMs: 1_784_000_000_000 });
  const openEvent = { ...decide(null, opened).events[0], task_event_sequence: 1 };
  const genesis = buildRecord({
    transactionId: deterministicId("event-store-append", "transaction", 1), commandId: null, repoSequence: 1,
    occurredAtEpochMs: opened.atEpochMs, actor: { kind: "cli", session_id: opened.actingSession },
    previousRecordDigest: null, events: [openEvent],
  });
  commitRecord(repo, genesis);
  const genesisReplay = readEventStore(repo);
  const genesisCursor = genesisReplay.cursor;
  assert.equal(Object.isFrozen(genesisCursor), true);
  assert.equal(Object.isFrozen(genesisCursor.task_sequences), true);
  const state = evolve(null, openEvent);
  const writeCommand = { type: "authorize-write", taskId: state.task_id, at: "2026-07-14T03:34:00.000Z", decision: "allow", files: ["work.txt"] };
  const writeEvent = { ...decide(state, writeCommand).events[0], task_event_sequence: 2 };
  assert.throws(() => buildRecord({
    transactionId: deterministicId("event-store-append", "invalid-genesis", 1), commandId: null, repoSequence: 1,
    occurredAtEpochMs: Date.parse(writeCommand.at), actor: { kind: "hook", session_id: opened.actingSession },
    previousRecordDigest: null, events: [{ ...writeEvent, task_event_sequence: 1 }],
  }), /genesis must contain exactly one task_opened event/);
  const second = buildRecord({
    transactionId: deterministicId("event-store-append", "transaction", 2), commandId: deterministicId("event-store-append", "command", 2),
    repoSequence: 2, occurredAtEpochMs: Date.parse(writeCommand.at), actor: { kind: "hook", session_id: opened.actingSession },
    previousRecordDigest: genesis.record_digest,
    events: [writeEvent, { ...writeEvent, task_event_sequence: 3, payload: { files: ["second.txt"] } }],
  });
  const receipt = commitRecord(repo, second, { cursor: genesisCursor });
  assert.equal(receipt.genesis, false);
  assert.equal(receipt.repo_sequence, 2);
  assert.equal(receipt.cursor.last_record_digest, second.record_digest);
  const replay = readEventStore(repo);
  assert.deepEqual(replay.records, [genesis, second]);
  assert.deepEqual(replay.task_sequences, { [state.task_id]: 3 });
  assert.equal(replay.events[1].kind, "write_authorized");
  assert.equal(replay.last_record_digest, second.record_digest);
  const tail = readEventStoreTail(repo, genesisCursor);
  assert.deepEqual(tail.records, [second]);
  assert.equal(tail.start_offset, genesisCursor.valid_end_offset);
  assert.equal(tail.valid_end_offset, replay.valid_end_offset);
  assert.deepEqual(tail.task_sequences, { [state.task_id]: 3 });
  assert.throws(
    () => readEventStoreTail(repo, { ...replay.cursor, last_record_digest: genesis.record_digest }),
    /does not match its source record/,
  );
  const bytesBefore = fs.readFileSync(eventStorePath(repo));
  const broken = buildRecord({
    transactionId: deterministicId("event-store-append", "transaction", 3), commandId: null, repoSequence: 3,
    occurredAtEpochMs: Date.parse("2026-07-14T03:35:00.000Z"), actor: { kind: "cli", session_id: null },
    previousRecordDigest: sha256Hex("wrong chain"), events: [{ ...writeEvent, task_event_sequence: 4 }],
  });
  assert.throws(() => commitRecord(repo, broken, { cursor: { ...receipt.cursor, task_sequences: { ...receipt.cursor.task_sequences } } }), /trusted replay cursor/);
  assert.throws(() => commitRecord(repo, broken), (error) => error.code === "HASH_CHAIN_MISMATCH");
  assert.deepEqual(fs.readFileSync(eventStorePath(repo)), bytesBefore);
});

test("production replay durably quarantines a torn tail and recovery is reentrant", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-tail-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const opened = makeTaskOpenedCommand({ seed: "event-store-tail", index: 1, atEpochMs: 1_784_000_000_000 });
  const genesis = buildRecord({
    transactionId: deterministicId("event-store-tail", "transaction", 1), commandId: null, repoSequence: 1,
    occurredAtEpochMs: opened.atEpochMs, actor: { kind: "cli", session_id: opened.actingSession }, previousRecordDigest: null,
    events: [{ ...decide(null, opened).events[0], task_event_sequence: 1 }],
  });
  commitRecord(repo, genesis);
  const target = eventStorePath(repo);
  const validBytes = fs.readFileSync(target);
  const committedCursor = readEventStore(repo).cursor;
  const tail = Buffer.from('{"partial":"雪"', "utf8");
  fs.appendFileSync(target, tail);
  const tornBytes = fs.readFileSync(target);
  const recoveryEpochMs = 1_784_000_100_000;
  assert.throws(
    () => readEventStore(repo),
    (error) => error.code === "TORN_TAIL_RECOVERY_REQUIRED" && error.message === V3_ERROR_MESSAGES.TORN_TAIL_RECOVERY_REQUIRED,
  );
  assert.deepEqual(fs.readFileSync(target), tornBytes);
  assert.throws(
    () => readEventStoreTail(repo, committedCursor),
    (error) => error.code === "TORN_TAIL_RECOVERY_REQUIRED",
  );
  assert.deepEqual(fs.readFileSync(target), tornBytes);
  const strictAudit = auditEventStore(repo);
  assert.equal(strictAudit.valid, false);
  assert.equal(strictAudit.error.code, "TORN_TAIL_RECOVERY_REQUIRED");
  assert.deepEqual(fs.readFileSync(target), tornBytes);
  assert.throws(() => readEventStore(repo, {
    recoveryEpochMs,
    recoverTornTail: true,
    onSeam(seam) { if (seam === "after-quarantine-receipt-fsync") throw new Error("injected recovery crash"); },
  }), /injected recovery crash/);
  assert.deepEqual(fs.readFileSync(target), tornBytes);

  const replay = readEventStore(repo, { recoveryEpochMs, recoverTornTail: true });
  assert.deepEqual(replay.records, [genesis]);
  assert.deepEqual(fs.readFileSync(target), validBytes);
  assert.equal(replay.recovered_tail.valid_end_offset, validBytes.length);
  assert.equal(replay.recovered_tail.original_file_length, tornBytes.length);
  assert.equal(replay.recovered_tail.tail_sha256, sha256Hex(tail));
  assert.equal(replay.recovered_tail.recovered_at, utcTimestamp(recoveryEpochMs));
  assert.deepEqual(fs.readFileSync(replay.recovered_tail.quarantine_path), tail);
  const receiptBytes = fs.readFileSync(replay.recovered_tail.receipt_path, "utf8");
  const receipt = JSON.parse(receiptBytes);
  assert.deepEqual(receipt, replay.recovered_tail);
  assert.equal(receiptBytes, `${JSON.stringify(JSON.parse(canonicalJson(replay.recovered_tail)), null, 2)}\n`);
  const quarantineFiles = fs.readdirSync(path.join(repo, ".workloop", "quarantine"));
  assert.equal(quarantineFiles.filter((name) => name.endsWith(".bin")).length, 1);
  assert.equal(quarantineFiles.filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(readEventStore(repo, { recoveryEpochMs }).recovered_tail, null);
});

test("production replay fails closed on internal corruption without changing authority bytes", async (t) => {
  const opened = makeTaskOpenedCommand({ seed: "event-store-corruption", index: 1, atEpochMs: 1_784_000_000_000 });
  const genesis = buildRecord({
    transactionId: deterministicId("event-store-corruption", "transaction", 1), commandId: null, repoSequence: 1,
    occurredAtEpochMs: opened.atEpochMs, actor: { kind: "cli", session_id: opened.actingSession }, previousRecordDigest: null,
    events: [{ ...decide(null, opened).events[0], task_event_sequence: 1 }],
  });
  const cases = [
    ["invalid JSON", Buffer.from('{"broken"\n'), "UNKNOWN_RECORD_FIELD"],
    ["unknown record field", { ...structuredClone(genesis), unexpected: true }, "UNKNOWN_RECORD_FIELD"],
    ["event digest", (() => { const value = structuredClone(genesis); value.events[0].event_id = sha256Hex("bad event"); return resignPersisted(value, "record_digest"); })(), "CORRUPT_EVENT_DIGEST"],
    ["nested payload field", (() => {
      const value = structuredClone(genesis);
      value.events[0].payload.observation.execution.unexpected = true;
      value.events[0] = resignPersisted(value.events[0], "event_id");
      return resignPersisted(value, "record_digest");
    })(), "UNKNOWN_EVENT_FIELD"],
    ["invalid scalar value", (() => {
      const value = structuredClone(genesis);
      value.events[0].payload.goal = null;
      value.events[0] = resignPersisted(value.events[0], "event_id");
      return resignPersisted(value, "record_digest");
    })(), "UNKNOWN_EVENT_FIELD"],
    ["record digest", { ...structuredClone(genesis), record_digest: sha256Hex("bad record") }, "CORRUPT_RECORD_DIGEST"],
    ["repo sequence", resignPersisted({ ...structuredClone(genesis), repo_sequence: 2 }, "record_digest"), "REPO_SEQUENCE_GAP"],
    ["task sequence", (() => {
      const value = structuredClone(genesis);
      value.events[0].task_event_sequence = 2;
      value.events[0] = resignPersisted(value.events[0], "event_id");
      return resignPersisted(value, "record_digest");
    })(), "TASK_SEQUENCE_GAP"],
  ];
  for (const [name, malformed, code] of cases) await t.test(name, () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-corrupt-"));
    try {
      const target = eventStorePath(repo);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.isBuffer(malformed) ? malformed : Buffer.from(`${canonicalJson(malformed)}\n`);
      fs.writeFileSync(target, bytes);
      assert.throws(() => readEventStore(repo), (error) => error.code === code && error.message === V3_ERROR_MESSAGES[code]);
      assert.deepEqual(fs.readFileSync(target), bytes, name);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  await t.test("hash chain", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-chain-"));
    try {
      commitRecord(repo, genesis);
      const second = buildRecord({
        transactionId: deterministicId("event-store-corruption", "transaction", 2), commandId: null, repoSequence: 2,
        occurredAtEpochMs: opened.atEpochMs + 1, actor: { kind: "cli", session_id: opened.actingSession },
        previousRecordDigest: genesis.record_digest,
        events: [{ ...decide(evolve(null, { ...decide(null, opened).events[0], task_event_sequence: 1 }), {
          type: "authorize-write", taskId: opened.taskId, at: new Date(opened.atEpochMs + 1).toISOString(), decision: "allow", files: ["work.txt"],
        }).events[0], task_event_sequence: 2 }],
      });
      const broken = resignPersisted({ ...structuredClone(second), previous_record_digest: sha256Hex("wrong previous") }, "record_digest");
      fs.appendFileSync(eventStorePath(repo), `${canonicalJson(broken)}\n`);
      const bytes = fs.readFileSync(eventStorePath(repo));
      assert.throws(() => readEventStore(repo), (error) => error.code === "HASH_CHAIN_MISMATCH" && error.message === V3_ERROR_MESSAGES.HASH_CHAIN_MISMATCH);
      assert.deepEqual(fs.readFileSync(eventStorePath(repo)), bytes);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  await t.test("corrupt prefix plus torn tail", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-prefix-"));
    try {
      const value = structuredClone(genesis);
      value.events[0].payload.goal = null;
      value.events[0] = resignPersisted(value.events[0], "event_id");
      const broken = resignPersisted(value, "record_digest");
      const bytes = Buffer.concat([Buffer.from(`${canonicalJson(broken)}\n`), Buffer.from("partial")]);
      const target = eventStorePath(repo);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      assert.throws(() => readEventStore(repo), (error) => error.code === "UNKNOWN_EVENT_FIELD");
      assert.deepEqual(fs.readFileSync(target), bytes);
      assert.equal(fs.existsSync(path.join(repo, ".workloop", "quarantine")), false);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});

test("[W03] crash child proves partial-tail quarantine and reentrant recovery", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-crash-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const opened = makeTaskOpenedCommand({ seed: "event-store-crash", index: 1, atEpochMs: 1_784_000_000_000 });
  const genesis = buildRecord({
    transactionId: deterministicId("event-store-crash", "transaction", 1), commandId: null, repoSequence: 1,
    occurredAtEpochMs: opened.atEpochMs, actor: { kind: "cli", session_id: opened.actingSession }, previousRecordDigest: null,
    events: [{ ...decide(null, opened).events[0], task_event_sequence: 1 }],
  });
  const commandFile = path.join(repo, "record.json");
  fs.writeFileSync(commandFile, canonicalJson(genesis));
  const common = ["--repo", repo, "--command-file", commandFile];
  for (const [seam, authorityExists] of [["before-genesis-temp-create", false], ["after-genesis-temp-fsync", false], ["after-genesis-rename", true]]) {
    const seamRepo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-genesis-seam-"));
    try {
      const seamCommand = path.join(seamRepo, "record.json");
      fs.writeFileSync(seamCommand, canonicalJson(genesis));
      const crashed = await terminateCrashChildAtSeam(["--repo", seamRepo, "--command-file", seamCommand, "--operation", "create-genesis", "--seam", seam]);
      assert.equal(crashed.signal, "SIGKILL");
      assert.equal(fs.existsSync(eventStorePath(seamRepo)), authorityExists, seam);
      if (authorityExists) assert.deepEqual(readEventStore(seamRepo).records, [genesis]);
    } finally { fs.rmSync(seamRepo, { recursive: true, force: true }); }
  }
  const genesisCrash = await terminateCrashChildAtSeam([...common, "--operation", "create-genesis", "--seam", "during-genesis-write"]);
  assert.equal(genesisCrash.signal, "SIGKILL");
  assert.equal(genesisCrash.frame.seam, "during-genesis-write");
  assert.equal(genesisCrash.frame.repo, path.resolve(repo));
  assert.equal(fs.existsSync(eventStorePath(repo)), false);

  commitRecord(repo, genesis);
  const openedState = evolve(null, { ...decide(null, opened).events[0], task_event_sequence: 1 });
  const writeAt = opened.atEpochMs + 1;
  const writeEvent = decide(openedState, {
    type: "authorize-write", taskId: opened.taskId, at: new Date(writeAt).toISOString(), decision: "allow", files: ["work.txt"],
  }).events[0];
  const second = buildRecord({
    transactionId: deterministicId("event-store-crash", "transaction", 2), commandId: null, repoSequence: 2,
    occurredAtEpochMs: writeAt, actor: { kind: "hook", session_id: opened.actingSession }, previousRecordDigest: genesis.record_digest,
    events: [{ ...writeEvent, task_event_sequence: 2 }],
  });
  fs.writeFileSync(commandFile, canonicalJson(second));
  const oldBytes = fs.readFileSync(eventStorePath(repo));
  const zeroFsOps = new Proxy(fs, { get(target, property) { return property === "writeSync" ? () => 0 : target[property]; } });
  assert.throws(() => commitRecord(repo, second, { cursor: readEventStore(repo).cursor, fsOps: zeroFsOps }), /no valid progress/);
  assert.deepEqual(fs.readFileSync(eventStorePath(repo)), oldBytes);
  let exceptionWrites = 0;
  const exceptionFsOps = new Proxy(fs, {
    get(target, property) {
      if (property !== "writeSync") return target[property];
      return (fd, buffer, offset, length, position) => {
        exceptionWrites += 1;
        if (exceptionWrites === 2) throw new Error("injected append exception");
        return target.writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
      };
    },
  });
  assert.throws(() => commitRecord(repo, second, { cursor: readEventStore(repo).cursor, fsOps: exceptionFsOps }), /injected append exception/);
  const exceptionRecovery = readEventStore(repo, { recoveryEpochMs: opened.atEpochMs + 1, recoverTornTail: true });
  assert.deepEqual(exceptionRecovery.records, [genesis]);
  assert.ok(exceptionRecovery.recovered_tail);
  const beforeAppend = await terminateCrashChildAtSeam([...common, "--operation", "append", "--seam", "before-append"]);
  assert.equal(beforeAppend.signal, "SIGKILL");
  assert.deepEqual(readEventStore(repo).records, [genesis]);
  const appendCrash = await terminateCrashChildAtSeam([...common, "--operation", "append", "--seam", "during-append"]);
  assert.equal(appendCrash.signal, "SIGKILL");
  const recoveredOld = readEventStore(repo, { recoveryEpochMs: opened.atEpochMs + 2, recoverTornTail: true });
  assert.deepEqual(recoveredOld.records, [genesis]);
  assert.ok(recoveredOld.recovered_tail);

  const fsyncCrash = await terminateCrashChildAtSeam([...common, "--operation", "append", "--seam", "after-event-fsync"]);
  assert.equal(fsyncCrash.signal, "SIGKILL");
  const recoveredNew = readEventStore(repo);
  assert.deepEqual(recoveredNew.records, [genesis, second]);

  const writeCrashRepo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-write-seam-"));
  try {
    commitRecord(writeCrashRepo, genesis);
    const writeCommandFile = path.join(writeCrashRepo, "record.json");
    fs.writeFileSync(writeCommandFile, canonicalJson(second));
    const afterWrite = await terminateCrashChildAtSeam(["--repo", writeCrashRepo, "--command-file", writeCommandFile, "--operation", "append", "--seam", "after-record-write"]);
    assert.equal(afterWrite.signal, "SIGKILL");
    assert.deepEqual(readEventStore(writeCrashRepo).records, [genesis, second]);
  } finally { fs.rmSync(writeCrashRepo, { recursive: true, force: true }); }

  const tail = Buffer.from("partial-after-committed-record");
  fs.appendFileSync(eventStorePath(repo), tail);
  const tornBytes = fs.readFileSync(eventStorePath(repo));
  const recoveryCrash = await terminateCrashChildAtSeam([...common, "--operation", "recover", "--seam", "after-quarantine-receipt-fsync"]);
  assert.equal(recoveryCrash.signal, "SIGKILL");
  assert.deepEqual(fs.readFileSync(eventStorePath(repo)), tornBytes);
  const finalRecovery = readEventStore(repo, { recoverTornTail: true });
  assert.deepEqual(finalRecovery.records, [genesis, second]);
  assert.equal(finalRecovery.recovered_tail.tail_sha256, sha256Hex(tail));
});
