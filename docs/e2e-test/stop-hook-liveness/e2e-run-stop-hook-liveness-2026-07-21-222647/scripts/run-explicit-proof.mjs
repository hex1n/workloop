import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnGuarded } from "./process-guard.mjs";

const runId = process.env.WORKLOOP_E2E_RUN_ID;
if (!runId) throw new Error("WORKLOOP_E2E_RUN_ID is required; prepare a fresh fixture run first");
if (!/^\d{8}T\d{6}$/.test(runId)) throw new Error("WORKLOOP_E2E_RUN_ID must use YYYYMMDDTHHMMSS");
const root = path.join(os.tmpdir(), `workloop-stop-hook-liveness-${runId}`);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "fixture-manifest.json"), "utf8"));
if (manifest.run_id !== runId) throw new Error("fixture manifest run_id does not match WORKLOOP_E2E_RUN_ID");
fs.writeFileSync(path.join(root, ".claimed-explicit-proof"), `${new Date().toISOString()}\n`, { flag: "wx" });
const fixture = manifest.fixtures.find(({ name }) => name === "explicit-proof-terminal");
const workloop = path.join(os.homedir(), "bin", "workloop.mjs");

function status() {
  return JSON.parse(execFileSync("node", [workloop, "status", "--repo", "."], { cwd: fixture.repo, encoding: "utf8" }));
}

function digestEvents() {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(fixture.repo, ".workloop", "events.jsonl"))).digest("hex");
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("criterion sentinel was not observed before deadline");
}

const before = status();
const eventsBefore = digestEvents();
fs.writeFileSync(path.join(fixture.repo, "done"), "done\n");

const owner = spawnGuarded("node", [workloop, "verify", "--record", "--repo", "."], {
  cwd: fixture.repo,
  stdio: ["ignore", "pipe", "pipe"],
  timeoutMs: 35_000,
});
const { child } = owner;
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout = `${stdout}${chunk}`.slice(-32_768);
});
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-32_768);
});

let during;
let statusDurationMs;
let childResult;
try {
  await waitForFile(fixture.sentinel, 5_000);
  const statusStarted = process.hrtime.bigint();
  during = status();
  statusDurationMs = Number(process.hrtime.bigint() - statusStarted) / 1e6;
  childResult = await owner.closed;
  if (childResult.timedOut) throw new Error("explicit proof owner exceeded its 35s outer deadline");
} finally {
  await owner.dispose();
}
const after = status();

process.stdout.write(
  `${JSON.stringify(
    {
      owner_exit_code: childResult.code,
      owner_signal: childResult.signal,
      owner_reported_satisfied: /satisfied|achieved|terminal/i.test(`${stdout}\n${stderr}`),
      sentinel_started: fs.existsSync(fixture.sentinel),
      status_during_lifecycle: during.lifecycle.state,
      status_duration_ms: Math.round(statusDurationMs * 10) / 10,
      lifecycle_before: before.lifecycle.state,
      lifecycle_after: after.lifecycle.state,
      round_delta: after.spent.rounds - before.spent.rounds,
      artifact_revision_delta: after.artifact_revision - before.artifact_revision,
      observation_present_after: Boolean(after.criterion.last_observation?.observation_id),
      event_hash_changed: digestEvents() !== eventsBefore,
    },
    null,
    2,
  )}\n`,
);
