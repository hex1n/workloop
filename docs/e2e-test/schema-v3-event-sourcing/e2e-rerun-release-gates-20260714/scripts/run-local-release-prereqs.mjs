import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const runDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const attachments = path.join(runDir, "attachments");
fs.mkdirSync(attachments, { recursive: true });

const probes = [
  {
    id: "windows-cases-local",
    command: process.execPath,
    args: ["--test", "--test-reporter=spec", "--test-name-pattern=\\[W0[1-8]\\]", "tests/windows.test.mjs", "tests/event-store.test.mjs", "tests/task-snapshot-v3.test.mjs", "tests/runtime-v4.test.mjs", "tests/taskloop-architecture.test.mjs"],
  },
  { id: "npm-test", command: "npm", args: ["test"] },
  { id: "verify-full", command: process.execPath, args: ["tests/verify-full.mjs"] },
];

const summary = [];
for (const probe of probes) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync(probe.command, probe.args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const receipt = {
    id: probe.id,
    command: [probe.command, ...probe.args].join(" "),
    started_at: startedAt,
    duration_ms: Date.now() - start,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message ?? null,
  };
  const attachment = path.join(attachments, `${probe.id}.json`);
  fs.writeFileSync(attachment, `${JSON.stringify(receipt, null, 2)}\n`);
  summary.push({ id: probe.id, status: result.status, signal: result.signal, duration_ms: receipt.duration_ms, attachment });
  if (result.status !== 0) break;
}
fs.writeFileSync(path.join(attachments, "local-prereq-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.length !== probes.length || summary.some((row) => row.status !== 0)) process.exitCode = 1;
