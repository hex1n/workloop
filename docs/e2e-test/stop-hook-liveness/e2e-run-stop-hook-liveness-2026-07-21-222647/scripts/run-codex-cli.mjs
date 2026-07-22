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
fs.writeFileSync(path.join(root, ".claimed-codex-cli"), `${new Date().toISOString()}\n`, { flag: "wx" });
const fixture = manifest.fixtures.find(({ name }) => name === "codex-cli");
if (!fixture) throw new Error("missing codex-cli fixture");
const workloop = path.join(os.homedir(), "bin", "workloop.mjs");

function workloopJson(args) {
  return JSON.parse(execFileSync("node", [workloop, ...args], { cwd: fixture.repo, encoding: "utf8" }));
}

function eventHash() {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(fixture.repo, ".workloop", "events.jsonl"))).digest("hex");
}

function censusCount() {
  return workloopJson(["ledger", "--json", "--repo", "."]).integrity.censuses.length;
}

function taskProjection() {
  const value = workloopJson(["status", "--repo", "."]);
  return {
    lifecycle: value.lifecycle.state,
    rounds: value.spent.rounds,
    artifact_revision: value.artifact_revision,
    observation_id: value.criterion.last_observation?.observation_id ?? null,
  };
}

function jsonEvents(stdout) {
  const events = [];
  for (const line of String(stdout).split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); }
    catch { /* non-JSON diagnostics are counted through exit status and stderr */ }
  }
  return events;
}

async function runCodex(args) {
  const processHandle = spawnGuarded("codex", args, {
    cwd: fixture.repo,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 120_000,
  });
  let stdout = "";
  let stderr = "";
  processHandle.child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-8 * 1024 * 1024); });
  processHandle.child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
  let result;
  try { result = await processHandle.closed; }
  finally { await processHandle.dispose(); }
  if (result.timedOut) throw new Error("Codex CLI probe exceeded its 120s outer deadline");
  if (result.code !== 0) throw new Error(`Codex CLI probe failed (${result.code}): ${stderr.slice(-2_000)}`);
  return jsonEvents(stdout);
}

const initial = await runCodex([
  "exec",
  "--json",
  "--dangerously-bypass-hook-trust",
  "--sandbox",
  "workspace-write",
  "-C",
  fixture.repo,
  `Use the shell exactly once to run node ${JSON.stringify(workloop)} status --repo . and then reply exactly CODEX-ANCHOR. Do not edit any file.`,
]);
const threadId = initial.find((event) => event.type === "thread.started")?.thread_id;
if (typeof threadId !== "string" || threadId.length === 0) throw new Error("Codex CLI did not report a resumable thread id");

const baselineCensus = censusCount();
const baselineTask = taskProjection();
const baselineEvents = eventHash();
let completedTurns = 0;
let errorEvents = 0;

for (let index = 1; index <= 10; index += 1) {
  const events = await runCodex([
    "exec",
    "resume",
    "--json",
    "--dangerously-bypass-hook-trust",
    threadId,
    `Do not use tools. Reply exactly CODEX-PROBE-${String(index).padStart(2, "0")}.`,
  ]);
  completedTurns += 1;
  errorEvents += events.filter((event) => event.type === "error" || event.type === "turn.failed").length;
}

const probeCensusDelta = censusCount() - baselineCensus;
const nextEvents = await runCodex([
  "exec",
  "resume",
  "--json",
  "--dangerously-bypass-hook-trust",
  threadId,
  "Do not use tools. Reply exactly CODEX-NEXT-TURN.",
]);
completedTurns += 1;
errorEvents += nextEvents.filter((event) => event.type === "error" || event.type === "turn.failed").length;

const finalTask = taskProjection();
const finalLedger = workloopJson(["ledger", "--json", "--repo", "."]);
process.stdout.write(`${JSON.stringify({
  probe_turns: 10,
  completed_turns: completedTurns,
  probe_stop_census_delta: probeCensusDelta,
  post_next_turn_stop_census_delta: censusCount() - baselineCensus,
  next_turn_ok: completedTurns === 11,
  error_event_count: errorEvents,
  sentinel_started: fs.existsSync(fixture.sentinel),
  task_event_hash_changed: eventHash() !== baselineEvents,
  round_delta: finalTask.rounds - baselineTask.rounds,
  artifact_revision_delta: finalTask.artifact_revision - baselineTask.artifact_revision,
  observation_changed: finalTask.observation_id !== baselineTask.observation_id,
  lifecycle_before: baselineTask.lifecycle,
  lifecycle_after: finalTask.lifecycle,
  pretooluse_armed: finalLedger.integrity.pretooluse_armed,
}, null, 2)}\n`);
