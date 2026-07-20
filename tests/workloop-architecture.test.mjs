import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { decide, evolve } from "../lib/task-engine.mjs";
import { withTaskLock } from "../lib/task-store.mjs";
import { makeTaskOpenedCommand } from "./helpers/event-v3-fixture.mjs";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
const MODULES = ["application.mjs", "criterion.mjs", "event-store.mjs", "evidence-ledger.mjs", "host-hooks.mjs", "outcome-projector.mjs", "prims.mjs", "supervision.mjs", "task-engine.mjs", "task-store.mjs", "untracked.mjs"];

function run(script, args = [], options = {}) { return spawnSync(process.execPath, [script, ...args], { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, input: options.input ?? "", encoding: "utf8" }); }
function imports(file) { return [...fs.readFileSync(file, "utf8").matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)].map((m) => m[1]).filter((x) => x.startsWith(".")); }

test("assembly remains the only cross-leaf seam", () => {
  assert.deepEqual(imports(CLI), ["../lib/application.mjs"]);
  for (const name of MODULES) assert.ok(fs.existsSync(path.join(ROOT, "lib", name)));
  for (const name of MODULES.filter((x) => !new Set(["application.mjs", "prims.mjs"]).has(x))) assert.ok(imports(path.join(ROOT, "lib", name)).every((x) => x === "./prims.mjs"), name);
});

test("integration handshake exposes runtime-contract-5 independent schemas", () => {
  const info = JSON.parse(run(CLI, ["info"]).stdout);
  assert.deepEqual({ runtime: info.runtime_contract, task: info.task_snapshot_schema_version, record: info.event_record_schema_version, outcome: info.outcome_projection_schema_version }, { runtime: 5, task: 3, record: 2, outcome: 3 });
  assert.equal(info.criterion_adapter_protocol_version, 2);
  assert.equal(info.event_store, ".workloop/events.jsonl");
  assert.equal(info.outcome_projection, "~/.workloop/outcomes.jsonl");
});

test("authority timestamps are UTC while human artifact names remain local", () => {
  const prims = fs.readFileSync(path.join(ROOT, "lib", "prims.mjs"), "utf8");
  const untracked = fs.readFileSync(path.join(ROOT, "lib", "untracked.mjs"), "utf8");
  const application = fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8");
  assert.match(prims, /function utcTimestamp/); assert.match(prims, /function artifactTimestamp/);
  assert.match(untracked, /localTimestamp/); assert.match(application, /localTimestamp/);
  assert.match(application, /utcTimestamp\(Date\.now\(\)\)/);
});

test("Stop hooks exit zero with no task and with incompatible task state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-stop-exit-v2-")); const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true }); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, TZ: "UTC", HOME: home, USERPROFILE: home }; const payload = JSON.stringify({ hook_event_name: "Stop", cwd: repo });
  let stopped = run(CLI, ["hook", "--profile", "claude"], { cwd: repo, env, input: payload }); assert.equal(stopped.status, 0); assert.equal(stopped.stdout, "");
  fs.mkdirSync(path.join(repo, ".workloop"), { recursive: true }); fs.writeFileSync(path.join(repo, ".workloop", "task.json"), '{"schema_version":1}\n');
  stopped = run(CLI, ["hook", "--profile", "claude"], { cwd: repo, env, input: payload });
  assert.equal(stopped.status, 0);
  assert.equal(stopped.stderr, "task snapshot exists without a valid schema-v3 event authority; archive it with explicit user authorization\n");
  assert.equal(stopped.stdout, '{"decision":"block","reason":"workloop: task state unavailable (ORPHAN_V3_SNAPSHOT); refusing to adjudicate Stop"}\n');
});

test("command-shaped authority fails closed when task authority is corrupt", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-corrupt-command-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".workloop"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".workloop", "task.json"), '{"schema_version":1}\n');
  const command = ["npm", "pub", "lish"].join(" ").replace("pub lish", "publish");
  const result = run(CLI, ["hook", "--profile", "claude"], {
    cwd: repo,
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, session_id: "owner", tool_name: "Bash", tool_input: { command } }),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /permissionDecision.*deny/);
  assert.match(result.stdout, /supervisor unavailable \([A-Z0-9_]+\); refusing a write/);
});

test("task-engine decide/evolve are pure", () => {
  const command = makeTaskOpenedCommand({ atEpochMs: 1_784_000_000_000 });
  const decision = decide(null, command);
  const event = { ...decision.events[0], task_event_sequence: 1 };
  const changed = evolve(null, event);
  assert.equal(decision.events[0].task_event_sequence, undefined);
  assert.equal(changed.schema_version, 3);
});

test("production assembly has no direct authoritative task writer", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8");
  assert.doesNotMatch(source, /\bsaveTask\s*\(/);
  assert.doesNotMatch(source, /\btransition\s*\(/);
  assert.match(source, /commitRecord\s*\(/);
  assert.match(source, /saveTaskSnapshot\s*\(/);
});

test("host wire protocol is localized behind the Host Hook seam", () => {
  const application = fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8");
  const hostHooks = fs.readFileSync(path.join(ROOT, "lib", "host-hooks.mjs"), "utf8");
  for (const literal of ["hookSpecificOutput", "permissionDecision", 'decision: "block"']) {
    assert.doesNotMatch(application, new RegExp(literal));
    assert.match(hostHooks, new RegExp(literal));
  }
});

test("Windows W01-W08 selection is non-vacuous in every listed source", () => {
  for (const file of [
    "windows.test.mjs",
    "event-store.test.mjs",
    "task-snapshot-v3.test.mjs",
    "runtime-v5.test.mjs",
    "workloop-architecture.test.mjs",
  ]) {
    assert.match(fs.readFileSync(path.join(ROOT, "tests", file), "utf8"), /\[W0[1-8]\]/, file);
  }
});

test("task lock serializes concurrent updates and fails closed on timeout", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-lock-v1-")); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const helper = path.join(repo, "holder.mjs");
  const taskStoreUrl = pathToFileURL(path.join(ROOT, "lib", "task-store.mjs")).href;
  fs.writeFileSync(helper, `import {withTaskLock} from ${JSON.stringify(taskStoreUrl)}; withTaskLock(${JSON.stringify(repo)},()=>{process.stdout.write('held\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)});`);
  const child = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "pipe"] });
  let childStderr = ""; child.stderr.on("data", (chunk) => { childStderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(`lock holder exited before readiness (${code}): ${childStderr}`)));
  });
  assert.throws(() => withTaskLock(repo, () => assert.fail("must not run"), { timeoutMs: 20 }), /lock unavailable/);
  await new Promise((resolve) => child.once("close", resolve));
});

test("ledger serializes snapshot reads behind the task lock", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-ledger-lock-v4-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, TZ: "UTC" };
  const opened = run(CLI, ["open", "--repo", repo, "--goal", "lock ledger", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "concurrency probe", "--files", "work.txt", "--risk", "routine", "--risk-reason", "isolated fixture"], { env });
  assert.equal(opened.status, 0, opened.stderr);

  const helper = path.join(root, "holder.mjs");
  const taskStoreUrl = pathToFileURL(path.join(ROOT, "lib", "task-store.mjs")).href;
  fs.writeFileSync(helper, `import {withTaskLock} from ${JSON.stringify(taskStoreUrl)}; withTaskLock(${JSON.stringify(repo)},()=>{process.stdout.write('held\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300)});`);
  const holder = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { holder.stdout.once("data", resolve); holder.once("error", reject); });

  const ledger = spawn(process.execPath, [CLI, "ledger", "--json", "--repo", repo], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let settled = false;
  ledger.stdout.on("data", (chunk) => { stdout += chunk; }); ledger.stderr.on("data", (chunk) => { stderr += chunk; });
  const ledgerCompletion = new Promise((resolve) => ledger.once("close", (status) => { settled = true; resolve(status); }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "ledger must wait while snapshot recovery is locked");
  await new Promise((resolve) => holder.once("close", resolve));
  const status = await ledgerCompletion;
  assert.equal(status, 0, stderr);
  assert.equal(JSON.parse(stdout).integrity.authority, "valid");
});

test("[W06] task lock recovers a crashed owner and crashed reaper without double ownership", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-stale-lock-v4-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const stateDir = path.join(repo, ".workloop");
  const lock = path.join(stateDir, ".task.lock");
  const reaper = `${lock}.reaper`;
  const taskStoreUrl = pathToFileURL(path.join(ROOT, "lib", "task-store.mjs")).href;
  const crashedOwnerHelper = path.join(repo, "crashed-owner.mjs");
  fs.writeFileSync(crashedOwnerHelper, `import {withTaskLock} from ${JSON.stringify(taskStoreUrl)}; withTaskLock(${JSON.stringify(repo)},()=>{process.stdout.write('held\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60_000)});`);
  const crashedOwner = spawn(process.execPath, [crashedOwnerHelper], { stdio: ["ignore", "pipe", "pipe"] });
  let ownerStderr = "";
  crashedOwner.stderr.on("data", (chunk) => { ownerStderr += chunk; });
  await new Promise((resolve, reject) => {
    crashedOwner.stdout.once("data", resolve);
    crashedOwner.once("error", reject);
    crashedOwner.once("close", (code) => reject(new Error(`W06 owner exited before readiness (${code}): ${ownerStderr}`)));
  });
  assert.equal(fs.existsSync(lock), true);
  crashedOwner.kill("SIGKILL");
  await new Promise((resolve) => crashedOwner.once("close", resolve));

  fs.mkdirSync(reaper, { recursive: true });
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(exited.status, 0, exited.stderr);
  fs.writeFileSync(path.join(reaper, "owner.json"), JSON.stringify({ pid: Number(exited.stdout), token: "crashed-reaper" }));
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lock, old, old);
  fs.utimesSync(reaper, old, old);

  const ownershipLog = path.join(repo, "ownership.log");
  const contenderHelper = path.join(repo, "contender.mjs");
  fs.writeFileSync(contenderHelper, `import fs from 'node:fs'; import {withTaskLock} from ${JSON.stringify(taskStoreUrl)}; withTaskLock(${JSON.stringify(repo)},()=>{fs.appendFileSync(${JSON.stringify(ownershipLog)},'enter:'+process.pid+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);fs.appendFileSync(${JSON.stringify(ownershipLog)},'exit:'+process.pid+'\\n')},{timeoutMs:2000});`);
  const runContender = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [contenderHelper], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`W06 contender failed (${code}): ${stderr}`)));
  });
  await Promise.all([runContender(), runContender()]);
  const ownership = fs.readFileSync(ownershipLog, "utf8").trim().split("\n");
  assert.equal(ownership.length, 4);
  assert.match(ownership[0], /^enter:\d+$/);
  assert.equal(ownership[1], ownership[0].replace("enter:", "exit:"));
  assert.match(ownership[2], /^enter:\d+$/);
  assert.equal(ownership[3], ownership[2].replace("enter:", "exit:"));
  assert.notEqual(ownership[0], ownership[2]);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(reaper), false);
});

test("PreToolUse lock timeout denies the write instead of preserving stale proof", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-hook-lock-v1-")); const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true }); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n"); fs.writeFileSync(path.join(repo, "work.txt"), "x\n");
  const env = { ...process.env, TZ: "UTC", HOME: home, USERPROFILE: home };
  const opened = run(CLI, ["open", "--repo", repo, "--goal", "lock", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "probe", "--files", "work.txt"], { env }); assert.equal(opened.status, 0, opened.stderr);
  const lock = path.join(repo, ".workloop", ".task.lock"); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "held" }));
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt") } });
  const denied = run(CLI, [], { cwd: repo, env: { ...env, WORKLOOP_LOCK_TIMEOUT_MS: "20" }, input: payload });
  assert.equal(denied.status, 0); assert.match(denied.stdout, /permissionDecision.*deny/); assert.match(denied.stdout, /artifact revision cannot be recorded/);
});
