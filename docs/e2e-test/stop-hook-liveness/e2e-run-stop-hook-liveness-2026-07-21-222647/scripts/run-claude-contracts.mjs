import { execFileSync, spawnSync } from "node:child_process";
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
fs.writeFileSync(path.join(root, ".claimed-claude-contracts"), `${new Date().toISOString()}\n`, { flag: "wx" });
const workloop = path.join(os.homedir(), "bin", "workloop.mjs");

function fixture(name) {
  const value = manifest.fixtures.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`missing fixture ${name}`);
  return value;
}

function status(repo) {
  return JSON.parse(execFileSync("node", [workloop, "status", "--repo", "."], { cwd: repo, encoding: "utf8" }));
}

function stop(repo) {
  const payload = JSON.stringify({ hook_event_name: "Stop", cwd: repo });
  const started = process.hrtime.bigint();
  const result = spawnSync("node", [workloop, "hook", "--profile", "claude", "--mode", "nudge"], {
    cwd: repo,
    input: payload,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 128 * 1024,
  });
  return { ...result, durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

function spawnCaptured(args, repo, input = null) {
  const handle = spawnGuarded("node", [workloop, ...args], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs: 35_000,
  });
  const { child } = handle;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-32_768);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_768);
  });
  if (input === null) child.stdin.end();
  else child.stdin.end(input);
  const closed = handle.closed.then(({ code, signal, timedOut }) => ({ code, signal, timedOut, stdout, stderr }));
  return { child, closed, dispose: handle.dispose };
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("sentinel was not observed before deadline");
}

function timedStatus(repo) {
  const started = process.hrtime.bigint();
  const value = status(repo);
  return { value, durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

const shortFixture = fixture("claude-short");
const shortBefore = status(shortFixture.repo);
const shortUnsatisfied = stop(shortFixture.repo);
fs.writeFileSync(path.join(shortFixture.repo, "done"), "done\n");
const shortSatisfied = stop(shortFixture.repo);
const shortAfter = status(shortFixture.repo);

const overFixture = fixture("claude-over-budget");
const overBefore = status(overFixture.repo);
const overResult = stop(overFixture.repo);
const overAfter = status(overFixture.repo);

const progressFixture = fixture("claude-in-progress");
const owner = spawnCaptured(["verify", "--record", "--repo", "."], progressFixture.repo);
let leaseObserved;
let contender;
let progressStatus;
let suspended;
let suspendDurationMs;
let ownerResult;
try {
  await waitForFile(progressFixture.sentinel, 5_000);
  leaseObserved = fs.existsSync(path.join(progressFixture.repo, ".workloop", ".criterion.lock"));
  contender = stop(progressFixture.repo);
  progressStatus = timedStatus(progressFixture.repo);
  const suspendStarted = process.hrtime.bigint();
  suspended = spawnSync(
    "node",
    [
      workloop,
      "suspend",
      "--repo",
      ".",
      "--reason",
      "needs-input",
      "--remaining",
      "finish the isolated lease probe",
      "--failure",
      "criterion owner is intentionally still running",
      "--next-action",
      "inspect the owner result after lease release",
    ],
    { cwd: progressFixture.repo, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
  );
  suspendDurationMs = Number(process.hrtime.bigint() - suspendStarted) / 1e6;
  ownerResult = await owner.closed;
  if (ownerResult.timedOut) throw new Error("in-progress criterion owner exceeded its 35s outer deadline");
} finally {
  await owner.dispose();
}
const progressAfter = status(progressFixture.repo);

const staleFixture = fixture("claude-stale");
const staleBefore = status(staleFixture.repo);
const stalePayload = JSON.stringify({ hook_event_name: "Stop", cwd: staleFixture.repo });
const staleOwner = spawnCaptured(["hook", "--profile", "claude", "--mode", "nudge"], staleFixture.repo, stalePayload);
let staleResult;
try {
  await waitForFile(staleFixture.sentinel, 5_000);
  fs.writeFileSync(path.join(staleFixture.repo, "ignored.txt"), "after-direct-write\n");
  staleResult = await staleOwner.closed;
  if (staleResult.timedOut) throw new Error("stale-observation owner exceeded its 35s outer deadline");
} finally {
  await staleOwner.dispose();
}
const staleAfter = status(staleFixture.repo);

const result = {
  short: {
    first_exit_code: shortUnsatisfied.status,
    first_blocked_unsatisfied: /\"decision\":\"block\"/.test(shortUnsatisfied.stdout) && /criterion unsatisfied/.test(shortUnsatisfied.stdout),
    second_exit_code: shortSatisfied.status,
    second_released_silently: shortSatisfied.stdout === "",
    lifecycle_before: shortBefore.lifecycle.state,
    lifecycle_after: shortAfter.lifecycle.state,
    observation_after: shortAfter.criterion.last_observation?.verdict ?? null,
  },
  over_budget: {
    exit_code: overResult.status,
    duration_ms: Math.round(overResult.durationMs * 10) / 10,
    actionable_code: /criterion_requires_explicit_verification/.test(overResult.stdout),
    explicit_verb_present: /workloop verify --record|workloop achieve/.test(overResult.stdout),
    sentinel_started: fs.existsSync(overFixture.sentinel),
    round_delta: overAfter.spent.rounds - overBefore.spent.rounds,
    observation_delta: Number(Boolean(overAfter.criterion.last_observation?.observation_id)) - Number(Boolean(overBefore.criterion.last_observation?.observation_id)),
  },
  in_progress: {
    lease_observed: leaseObserved,
    contender_exit_code: contender.status,
    contender_duration_ms: Math.round(contender.durationMs * 10) / 10,
    contender_code: /criterion_in_progress/.test(contender.stdout),
    status_duration_ms: Math.round(progressStatus.durationMs * 10) / 10,
    status_lifecycle: progressStatus.value.lifecycle.state,
    suspend_exit_code: suspended.status,
    suspend_duration_ms: Math.round(suspendDurationMs * 10) / 10,
    owner_exit_code: ownerResult.code,
    owner_signal: ownerResult.signal,
    lifecycle_after: progressAfter.lifecycle.state,
    lease_released: !fs.existsSync(path.join(progressFixture.repo, ".workloop", ".criterion.lock")),
  },
  stale: {
    hook_exit_code: staleResult.code,
    hook_signal: staleResult.signal,
    stale_code: /criterion_observation_stale/.test(staleResult.stdout),
    round_delta: staleAfter.spent.rounds - staleBefore.spent.rounds,
    lifecycle_after: staleAfter.lifecycle.state,
    artifact_revision_delta: staleAfter.artifact_revision - staleBefore.artifact_revision,
    observation_verdict: staleAfter.criterion.last_observation?.verdict ?? null,
    changed_paths: staleAfter.criterion.last_observation?.changed_paths ?? [],
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
