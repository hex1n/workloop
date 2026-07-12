import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { transition } from "../lib/task-engine.mjs";
import { withTaskLock } from "../lib/task-store.mjs";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "taskloop.mjs");
const MODULES = ["application.mjs", "criterion.mjs", "outcome-ledger.mjs", "prims.mjs", "supervision.mjs", "task-engine.mjs", "task-store.mjs", "untracked.mjs"];

function run(script, args = [], options = {}) { return spawnSync(process.execPath, [script, ...args], { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, input: options.input ?? "", encoding: "utf8" }); }
function imports(file) { return [...fs.readFileSync(file, "utf8").matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)].map((m) => m[1]).filter((x) => x.startsWith(".")); }

test("assembly remains the only cross-leaf seam", () => {
  assert.deepEqual(imports(CLI), ["../lib/application.mjs"]);
  for (const name of MODULES) assert.ok(fs.existsSync(path.join(ROOT, "lib", name)));
  for (const name of MODULES.filter((x) => !new Set(["application.mjs", "prims.mjs"]).has(x))) assert.ok(imports(path.join(ROOT, "lib", name)).every((x) => x === "./prims.mjs"), name);
});

test("integration handshake exposes all three coordinated schema contracts", () => {
  const info = JSON.parse(run(CLI, ["info"]).stdout);
  assert.deepEqual({ runtime: info.runtime_contract, task: info.task_schema_version, ledger: info.ledger_event_schema_version }, { runtime: 2, task: 1, ledger: 1 });
  assert.match(info.ledger_path, /outcomes-v1\.jsonl$/);
});

test("persisted timestamps use one UTC ISO rendering", () => {
  const prims = fs.readFileSync(path.join(ROOT, "lib", "prims.mjs"), "utf8");
  const untracked = fs.readFileSync(path.join(ROOT, "lib", "untracked.mjs"), "utf8");
  assert.doesNotMatch(prims, /function localStamp|single time rendering/);
  assert.doesNotMatch(untracked, /localStamp/);
  assert.match(untracked, /toISOString/);
});

test("task-engine transitions are pure", () => {
  const source = { schema_version: 1, task_revision: 1, last_substantive_task_revision: 1, artifact_revision: 0, lifecycle: { state: "active" }, policy: { open_requirement: "unsatisfied", witness_requirement: "required", close_policy: "automatic" }, criterion: { criterion_generation_id: "g" }, spent: { writes: 0 }, evidence: { touched_files: [] }, reviews: [] };
  const changed = transition(source, { type: "record-write", files: ["a"], at: "2026-01-01T00:00:00Z" }).task;
  assert.equal(source.artifact_revision, 0); assert.equal(changed.artifact_revision, 1); assert.notEqual(changed, source);
});

test("task lock serializes concurrent updates and fails closed on timeout", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-lock-v1-")); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  let release; const held = new Promise((resolve) => { release = resolve; });
  const helper = path.join(repo, "holder.mjs");
  fs.writeFileSync(helper, `import {withTaskLock} from ${JSON.stringify(path.join(ROOT, "lib", "task-store.mjs"))}; withTaskLock(${JSON.stringify(repo)},()=>{process.stdout.write('held\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)});`);
  const child = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  assert.throws(() => withTaskLock(repo, () => assert.fail("must not run"), { timeoutMs: 20 }), /lock unavailable/);
  await new Promise((resolve) => child.once("close", resolve)); release();
});

test("PreToolUse lock timeout denies the write instead of preserving stale proof", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-hook-lock-v1-")); const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true }); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n"); fs.writeFileSync(path.join(repo, "work.txt"), "x\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const opened = run(CLI, ["open", "--repo", repo, "--goal", "lock", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "probe", "--files", "work.txt"], { env }); assert.equal(opened.status, 0, opened.stderr);
  const lock = path.join(repo, ".taskloop", ".task.lock"); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "held" }));
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt") } });
  const denied = run(CLI, [], { cwd: repo, env: { ...env, TASKLOOP_LOCK_TIMEOUT_MS: "20" }, input: payload });
  assert.equal(denied.status, 0); assert.match(denied.stdout, /permissionDecision.*deny/); assert.match(denied.stdout, /artifact revision cannot be recorded/);
});

test("installer puts runtime and skills from one release under a temporary home", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-v1-")); const home = path.join(root, "home"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const shim = path.join(home, "bin", "taskloop.mjs"); assert.ok(fs.existsSync(shim));
  const info = JSON.parse(run(shim, ["info"], { env: { ...process.env, HOME: home, USERPROFILE: home } }).stdout); assert.equal(info.runtime_contract, 2);
  for (const runtime of [".claude", ".codex"]) for (const skill of ["loop-core", "workloop"]) assert.ok(fs.existsSync(path.join(home, runtime, "skills", skill, skill === "workloop" ? "SKILL.md" : "REFERENCE.md")));
  const manifest = JSON.parse(fs.readFileSync(path.join(home, "bin", ".taskloop-active-release.json"), "utf8"));
  assert.equal(manifest.release_id, manifest.runtime_digest); assert.equal(manifest.runtime_contract, 2);
  assert.equal(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), false);
});

test("every installer activation interruption leaves a journal and rerun converges", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-interrupt-v1-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const failpoint of ["runtime-staged", "skills-activated", "shim-activated", "manifest-committed", "journal-cleaned"]) {
    const home = path.join(root, failpoint); const base = { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT };
    const interrupted = run(path.join(ROOT, "install.mjs"), [], { env: { ...base, TASKLOOP_INSTALL_FAILPOINT: failpoint } });
    assert.notEqual(interrupted.status, 0, failpoint);
    if (failpoint !== "journal-cleaned") assert.ok(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), failpoint);
    const resumed = run(path.join(ROOT, "install.mjs"), [], { env: base }); assert.equal(resumed.status, 0, `${failpoint}: ${resumed.stderr}`);
    const info = JSON.parse(run(path.join(home, "bin", "taskloop.mjs"), ["info"], { env: base }).stdout); assert.equal(info.runtime_contract, 2);
    assert.equal(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), false);
  }
});
