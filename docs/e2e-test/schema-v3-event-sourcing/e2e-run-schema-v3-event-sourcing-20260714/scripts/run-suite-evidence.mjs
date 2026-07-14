import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const runDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const attachments = path.join(runDir, "attachments");
fs.mkdirSync(attachments, { recursive: true });

const suites = [
  { id: "recovery", command: process.execPath, args: ["--test", "tests/event-store.test.mjs", "tests/task-snapshot-v3.test.mjs"] },
  { id: "runtime", command: process.execPath, args: ["--test", "--test-name-pattern=authority guard|transcript|outcomes-v3|HOME projection|twenty concurrent", "tests/runtime-v4.test.mjs"] },
  { id: "installer", command: process.execPath, args: ["--test", "tests/installer.test.mjs"] },
  { id: "stale-lock", command: process.execPath, args: ["--test", "--test-name-pattern=aged lock", "tests/taskloop-architecture.test.mjs"] },
  { id: "windows-cases-local", command: process.execPath, args: ["--test", "--test-reporter=spec", "--test-name-pattern=\\[W0[1-8]\\]", "tests/windows.test.mjs", "tests/event-store.test.mjs", "tests/task-snapshot-v3.test.mjs", "tests/runtime-v4.test.mjs", "tests/taskloop-architecture.test.mjs"] },
  { id: "benchmark", command: "npm", args: ["run", "bench:event-store", "--", "--json"] },
  { id: "npm-test", command: "npm", args: ["test"] },
  { id: "verify-full", command: process.execPath, args: ["tests/verify-full.mjs"] },
];

const summary = [];
for (const suite of suites) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync(suite.command, suite.args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const evidence = {
    id: suite.id,
    command: [suite.command, ...suite.args].join(" "),
    started_at: startedAt,
    duration_ms: Date.now() - start,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message ?? null,
  };
  const target = path.join(attachments, `${suite.id}.json`);
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  summary.push({ id: suite.id, status: result.status, signal: result.signal, duration_ms: evidence.duration_ms, attachment: target });
  if (result.status !== 0) break;
}

fs.writeFileSync(path.join(attachments, "suite-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.length !== suites.length || summary.some((row) => row.status !== 0)) process.exitCode = 1;
