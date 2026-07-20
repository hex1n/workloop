import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { buildRecord, commitRecord, eventStorePath, readEventStore, readEventStoreTail } from "../lib/event-store.mjs";
import { canonicalJson } from "../lib/prims.mjs";
import { evolveAll } from "../lib/task-engine.mjs";
import {
  BENCHMARK_RECEIPT_FIELDS,
  BENCHMARK_THRESHOLDS,
} from "./fixtures/runtime-contract-5.mjs";
import { generateRecordFacts } from "./helpers/event-v3-fixture.mjs";

const args = process.argv.slice(2);

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values, passed) {
  return { p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: Math.max(...values), passed };
}

function benchmarkEventStore() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-event-benchmark-"));
  try {
    const records = [];
    let previous = null;
    for (const fact of generateRecordFacts({ seed: "benchmark-v1", count: BENCHMARK_THRESHOLDS.record_count, startEpochMs: 1_784_000_000_000 })) {
      const record = buildRecord({
        transactionId: fact.transaction_id,
        commandId: fact.command_id,
        repoSequence: fact.repo_sequence,
        occurredAtEpochMs: fact.occurred_at_epoch_ms,
        actor: fact.actor,
        previousRecordDigest: previous,
        events: fact.events,
      });
      records.push(record);
      previous = record.record_digest;
    }

    const incrementalCount = 100;
    const baseCount = records.length - incrementalCount;
    const target = eventStorePath(repo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const baseBytes = Buffer.from(records.slice(0, baseCount).map((record) => `${canonicalJson(record)}\n`).join(""), "utf8");
    fs.writeFileSync(target, baseBytes);
    const baseFd = fs.openSync(target, "r+");
    try { fs.fsyncSync(baseFd); } finally { fs.closeSync(baseFd); }
    const baseReplay = readEventStore(repo);
    let cursor = baseReplay.cursor;
    readEventStoreTail(repo, cursor);
    const incrementalTailMs = [];
    const appendFsyncMs = [];
    for (const record of records.slice(baseCount)) {
      const appendStarted = performance.now();
      const appendReceipt = commitRecord(repo, record, { cursor });
      appendFsyncMs.push(performance.now() - appendStarted);
      const tailStarted = performance.now();
      const tail = readEventStoreTail(repo, cursor);
      incrementalTailMs.push(performance.now() - tailStarted);
      if (tail.records.length !== 1 || tail.records[0].record_digest !== record.record_digest) throw new Error("incremental benchmark replay diverged");
      cursor = appendReceipt.cursor;
    }

    const runFullReplayWorker = () => {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--full-replay-worker", repo], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`full replay worker failed: ${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    runFullReplayWorker();
    const fullReplayMs = Array.from({ length: 3 }, () => runFullReplayWorker().full_replay_ms);
    const fullPassed = Math.max(...fullReplayMs) < BENCHMARK_THRESHOLDS.full_replay_max_ms;
    const tailPassed = percentile(incrementalTailMs, 0.95) < BENCHMARK_THRESHOLDS.incremental_tail_p95_max_ms;
    const appendPassed = percentile(appendFsyncMs.slice(0, 50), 0.95) < BENCHMARK_THRESHOLDS.append_fsync_p95_max_ms;
    const passed = fullPassed && tailPassed && appendPassed;
    const statfs = typeof fs.statfsSync === "function" ? fs.statfsSync(repo) : null;
    const values = {
      receipt_schema_version: 1,
      status: passed ? "pass" : "fail",
      node: process.version,
      os: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? null,
      filesystem: statfs ? String(statfs.type) : null,
      capabilities: { directory_fsync: process.platform === "win32" ? "unsupported_platform" : "supported" },
      record_count: BENCHMARK_THRESHOLDS.record_count,
      file_bytes: fs.statSync(target).size,
      samples: { full_replay_ms: fullReplayMs, incremental_tail_ms: incrementalTailMs, append_fsync_ms: appendFsyncMs.slice(0, 50) },
      summary: {
        full_replay_ms: summarize(fullReplayMs, fullPassed),
        incremental_tail_ms: summarize(incrementalTailMs, tailPassed),
        append_fsync_ms: summarize(appendFsyncMs.slice(0, 50), appendPassed),
      },
      thresholds: BENCHMARK_THRESHOLDS,
      passed,
    };
    return Object.fromEntries(BENCHMARK_RECEIPT_FIELDS.map((field) => [field, values[field]]));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

if (args.length === 2 && args[0] === "--full-replay-worker") {
  const started = performance.now();
  const replay = readEventStore(path.resolve(args[1]));
  const projection = evolveAll(null, replay.events);
  const fullReplayMs = performance.now() - started;
  if (replay.records.length !== BENCHMARK_THRESHOLDS.record_count || projection.task_event_sequence !== BENCHMARK_THRESHOLDS.record_count) throw new Error("full benchmark replay diverged");
  process.stdout.write(`${JSON.stringify({ full_replay_ms: fullReplayMs })}\n`);
} else if (args.length === 1 && args[0] === "--describe") {
  process.stdout.write(`${JSON.stringify({
    interface_version: 1,
    command: "npm run bench:event-store -- --json",
    thresholds: BENCHMARK_THRESHOLDS,
    receipt_fields: BENCHMARK_RECEIPT_FIELDS,
  })}\n`);
} else if (args.length === 1 && args[0] === "--json") {
  const receipt = benchmarkEventStore();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (!receipt.passed) process.exitCode = 1;
} else {
  process.stderr.write("usage: event-store-benchmark.mjs --describe | --json\n");
  process.exitCode = 2;
}

export { benchmarkEventStore };
