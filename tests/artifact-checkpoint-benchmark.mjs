import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { artifactCheckpointFromSnapshot, repoSnapshot } from "../lib/criterion.mjs";

const CASES = Object.freeze([
  Object.freeze({ name: "small", file_count: 128, bytes_per_file: 1_024 }),
  Object.freeze({ name: "medium", file_count: 4_096, bytes_per_file: 1_024 }),
]);

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function createRepository(root, fixture) {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const body = Buffer.alloc(fixture.bytes_per_file, 0x78);
  for (let index = 0; index < fixture.file_count; index += 1) {
    const directory = path.join(root, `group-${String(index % 32).padStart(2, "0")}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `file-${String(index).padStart(5, "0")}.txt`), body);
  }
}

function measureArtifactCheckpoints() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-artifact-benchmark-"));
  try {
    const cases = [];
    for (const fixture of CASES) {
      const repo = path.join(root, fixture.name);
      createRepository(repo, fixture);
      const samples = [];
      let checkpoint = null;
      for (let sample = 0; sample < 3; sample += 1) {
        const started = performance.now();
        checkpoint = artifactCheckpointFromSnapshot(repoSnapshot(repo));
        samples.push(performance.now() - started);
      }
      cases.push({
        ...fixture,
        manifest_bytes: Buffer.byteLength(JSON.stringify(checkpoint), "utf8"),
        hash_duration_ms: {
          samples,
          p50: percentile(samples, 0.5),
          max: Math.max(...samples),
        },
      });
    }
    return {
      receipt_schema_version: 1,
      status: "measured",
      node: process.version,
      os: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? null,
      cases,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--describe") {
  process.stdout.write(`${JSON.stringify({
    interface_version: 1,
    command: "npm run bench:artifact-checkpoint -- --json",
    measurements: ["file_count", "manifest_bytes", "hash_duration_ms"],
    cases: CASES,
  })}\n`);
} else if (args.length === 1 && args[0] === "--json") {
  process.stdout.write(`${JSON.stringify(measureArtifactCheckpoints())}\n`);
} else {
  process.stderr.write("usage: artifact-checkpoint-benchmark.mjs --describe | --json\n");
  process.exitCode = 2;
}

export { measureArtifactCheckpoints };
