import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnGuarded } from "./process-guard.mjs";

const runId = process.env.WORKLOOP_E2E_RUN_ID;
if (!runId) throw new Error("WORKLOOP_E2E_RUN_ID is required; prepare a fresh fixture run first");
if (!/^\d{8}T\d{6}$/.test(runId)) throw new Error("WORKLOOP_E2E_RUN_ID must use YYYYMMDDTHHMMSS");
const root = path.join(os.tmpdir(), `workloop-stop-hook-liveness-${runId}`);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "fixture-manifest.json"), "utf8"));
if (manifest.run_id !== runId) throw new Error("fixture manifest run_id does not match WORKLOOP_E2E_RUN_ID");
fs.writeFileSync(path.join(root, ".claimed-codex-app"), `${new Date().toISOString()}\n`, { flag: "wx" });
const fixture = manifest.fixtures.find(({ name }) => name === "codex-app");
if (!fixture) throw new Error("missing codex-app fixture");
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

const server = spawnGuarded("codex", ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  timeoutMs: 20 * 60_000,
});
const { child } = server;
const pending = new Map();
const turns = new Map();
const completedTurns = new Map();
let nextId = 1;
let stderr = "";
let apiErrorCount = 0;
let badIdCount = 0;

child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-32_768);
  badIdCount += (String(chunk).match(/invalid_id_prefix/g) ?? []).length;
});

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch {
    apiErrorCount += 1;
    stderr = `${stderr}\nnon-JSON app-server response`.slice(-32_768);
    return;
  }
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "error") apiErrorCount += 1;
  badIdCount += (JSON.stringify(message).match(/invalid_id_prefix/g) ?? []).length;
  if (message.method === "turn/completed") {
    const waiter = turns.get(message.params?.turn?.id);
    if (waiter) {
      turns.delete(message.params.turn.id);
      waiter.resolve(message.params.turn);
    } else completedTurns.set(message.params.turn.id, message.params.turn);
  }
});

server.closed.then(
  () => {
    const error = new Error("app-server closed before all requests completed");
    for (const waiter of pending.values()) waiter.reject(error);
    for (const waiter of turns.values()) waiter.reject(error);
    pending.clear();
    turns.clear();
  },
  (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    for (const waiter of turns.values()) waiter.reject(error);
    pending.clear();
    turns.clear();
  },
);

function request(method, params, timeoutMs = 15_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`app-server request timed out: ${method}`));
    }, timeoutMs);
    const settle = (callback) => (value) => {
      clearTimeout(timeoutId);
      callback(value);
    };
    pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return;
      const waiter = pending.get(id);
      pending.delete(id);
      waiter?.reject(error);
    });
  });
}

async function runTurn(threadId, text) {
  const response = await request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
  }, 30_000);
  const turnId = response.turn.id;
  if (completedTurns.has(turnId)) {
    const turn = completedTurns.get(turnId);
    completedTurns.delete(turnId);
    if (turn.status !== "completed") throw new Error(`App turn ended ${turn.status}`);
    return;
  }
  const completion = new Promise((resolve, reject) => turns.set(turnId, { resolve, reject }));
  let timeoutId;
  const timer = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("App turn timed out")), 120_000); });
  let turn;
  try { turn = await Promise.race([completion, timer]); }
  finally {
    clearTimeout(timeoutId);
    turns.delete(turnId);
  }
  if (turn.status !== "completed") throw new Error(`App turn ended ${turn.status}`);
}

let threadId = null;
try {
  await request("initialize", {
    clientInfo: { name: "workloop-e2e", title: "Workloop E2E", version: "1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  const started = await request("thread/start", {
    cwd: fixture.repo,
    runtimeWorkspaceRoots: [fixture.repo],
    approvalPolicy: "never",
    sandbox: "workspace-write",
    baseInstructions: "Follow the fixed-token E2E prompt exactly. Do not make edits.",
  });
  threadId = started.thread.id;
  await runTurn(
    threadId,
    `Use the shell exactly once to run node ${JSON.stringify(workloop)} status --repo . and then reply exactly APP-ANCHOR. Do not edit any file.`,
  );

  const baselineCensus = censusCount();
  const baselineTask = taskProjection();
  const baselineEvents = eventHash();
  for (let index = 1; index <= 10; index += 1) {
    await runTurn(threadId, `Do not use tools. Reply exactly APP-PROBE-${String(index).padStart(2, "0")}.`);
  }
  const probeCensusDelta = censusCount() - baselineCensus;
  await runTurn(threadId, "Do not use tools. Reply exactly APP-NEXT-TURN.");

  const finalTask = taskProjection();
  const finalLedger = workloopJson(["ledger", "--json", "--repo", "."]);
  process.stdout.write(`${JSON.stringify({
    probe_turns: 10,
    completed_turns: 11,
    probe_stop_census_delta: probeCensusDelta,
    post_next_turn_stop_census_delta: censusCount() - baselineCensus,
    next_turn_ok: true,
    api_error_count: apiErrorCount,
    bad_id_count: badIdCount,
    sentinel_started: fs.existsSync(fixture.sentinel),
    task_event_hash_changed: eventHash() !== baselineEvents,
    round_delta: finalTask.rounds - baselineTask.rounds,
    artifact_revision_delta: finalTask.artifact_revision - baselineTask.artifact_revision,
    observation_changed: finalTask.observation_id !== baselineTask.observation_id,
    lifecycle_before: baselineTask.lifecycle,
    lifecycle_after: finalTask.lifecycle,
    pretooluse_armed: finalLedger.integrity.pretooluse_armed,
  }, null, 2)}\n`);
} finally {
  if (threadId) {
    try { await request("thread/archive", { threadId }, 10_000); } catch { /* fixture task cleanup is best effort */ }
  }
  child.stdin.end();
  await server.dispose();
  if (pending.size > 0) throw new Error(`app-server closed with pending requests: ${stderr}`);
}
