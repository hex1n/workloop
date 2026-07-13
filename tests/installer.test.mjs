import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(".");

function run(script, args = [], options = {}) { return spawnSync(process.execPath, [script, ...args], { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, input: options.input ?? "", encoding: "utf8" }); }

test("installer puts runtime and skills from one release under a temporary home", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-v1-")); const home = path.join(root, "home"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const shim = path.join(home, "bin", "taskloop.mjs"); assert.ok(fs.existsSync(shim));
  const windowsShim = path.join(home, "bin", "taskloop.cmd"); assert.ok(fs.existsSync(windowsShim));
  assert.equal(fs.readFileSync(windowsShim, "utf8"), '@echo off\r\nnode "%~dp0taskloop.mjs" %*\r\n');
  const info = JSON.parse(run(shim, ["info"], { env: { ...process.env, HOME: home, USERPROFILE: home } }).stdout); assert.equal(info.runtime_contract, 3);
  for (const runtime of [".claude", ".codex"]) for (const skill of ["loop-core", "workloop"]) assert.ok(fs.existsSync(path.join(home, runtime, "skills", skill, skill === "workloop" ? "SKILL.md" : "REFERENCE.md")));
  const manifest = JSON.parse(fs.readFileSync(path.join(home, "bin", ".taskloop-active-release.json"), "utf8"));
  assert.equal(manifest.release_id, manifest.runtime_digest); assert.equal(manifest.runtime_contract, 3);
  assert.equal(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), false);
});

test("installed runtime exercises the assurance matrix", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-assurance-install-v2-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT };
  assert.equal(run(path.join(ROOT, "install.mjs"), [], { env }).status, 0);
  const shim = path.join(home, "bin", "taskloop.mjs");
  const makeRepo = (name, satisfied = false, stateCriterion = false) => {
    const repo = path.join(root, name); fs.mkdirSync(path.join(repo, ...(stateCriterion ? [".taskloop"] : [])), { recursive: true });
    const checker = stateCriterion ? path.join(repo, ".taskloop", "check.mjs") : path.join(repo, "check.mjs");
    fs.writeFileSync(checker, `process.exit(${satisfied ? 0 : 1});\n`); fs.writeFileSync(path.join(repo, "work.txt"), "x\n"); return repo;
  };
  const open = (repo, extra = [], satisfied = false, stateCriterion = false) => run(shim, ["open", "--repo", repo, "--goal", "matrix", "--criterion-file", stateCriterion ? ".taskloop/check.mjs" : "check.mjs", "--criterion-policy", satisfied ? "steady-satisfied" : "default", ...(satisfied ? ["--reason", "guard"] : []), "--alignment-because", "probe", "--files", "work.txt", ...extra], { env });
  const status = (repo) => JSON.parse(run(shim, ["status", "--repo", repo], { env }).stdout);

  const routine = makeRepo("routine"); assert.equal(open(routine, ["--risk", "routine", "--risk-reason", "reversible"]).status, 0); assert.equal(status(routine).review_requirement.level, null);
  const joined = run(shim, ["join", "--repo", routine, "--reason", "installed handoff"], { env: { ...env, TASKLOOP_SESSION_ID: "installed-session" } }); assert.equal(joined.status, 0, joined.stderr); assert.equal(JSON.parse(run(shim, ["status", "--repo", routine], { env: { ...env, TASKLOOP_SESSION_ID: "installed-session" } }).stdout).session_binding.cli_identity_matches_owner, true);
  const routineState = JSON.parse(fs.readFileSync(path.join(routine, ".taskloop", "task.json"), "utf8")); assert.match(routineState.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(run(shim, ["abandon", "--repo", routine, "--reason", "archive probe"], { env }).status, 0); assert.equal(open(routine, ["--risk", "routine", "--risk-reason", "reversible"]).status, 0);
  assert.ok(fs.readdirSync(path.join(routine, ".taskloop", "history")).some((name) => /^task-\d{8}-\d{6}-/.test(name)));
  const substantial = makeRepo("substantial"); assert.equal(open(substantial).status, 0); assert.equal(status(substantial).review_requirement.level, "fresh_context");
  const critical = makeRepo("critical"); assert.equal(open(critical, ["--risk", "critical", "--risk-reason", "contract", "--change-class", "public-contract"]).status, 0); assert.equal(status(critical).review_requirement.level, "second_model");
  assert.equal(run(shim, ["review", "--repo", critical, "--level", "fresh-context", "--reviewer", "peer", "--blocking-findings", "0", "--advisory-findings", "0"], { env }).status, 0); assert.equal(status(critical).review_requirement.accepted, false);
  const floor = makeRepo("floor"); assert.equal(open(floor, ["--risk", "routine", "--risk-reason", "claimed small", "--destructive-allowed", "--reason", "irreversible"]).status, 0); assert.equal(status(floor).review_requirement.level, "second_model");
  const waived = makeRepo("waived", true); assert.equal(open(waived, ["--review-policy", "waived", "--review-waiver-reason", "accepted"], true).status, 0); assert.equal(run(shim, ["achieve", "--repo", waived], { env }).status, 0);
  const stale = makeRepo("stale"); assert.equal(open(stale).status, 0); assert.equal(run(shim, ["review", "--repo", stale, "--level", "fresh-context", "--reviewer", "peer", "--blocking-findings", "0", "--advisory-findings", "0"], { env }).status, 0);
  const hook = JSON.stringify({ hook_event_name: "PreToolUse", cwd: stale, tool_name: "Write", tool_input: { file_path: path.join(stale, "work.txt") } }); assert.equal(run(shim, [], { cwd: stale, env, input: hook }).status, 0); assert.equal(status(stale).review_requirement.accepted, false);
  const weak = makeRepo("weak", true, true); assert.equal(open(weak, ["--risk", "routine", "--risk-reason", "reversible"], true, true).status, 0); assert.equal(run(shim, ["accept-proof-gap", "--repo", weak, "--reason", "accepted", "--granted-by", "user"], { env }).status, 0); assert.equal(status(weak).review_requirement.level, "fresh_context");
});

test("every installer activation interruption leaves a journal and rerun converges", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-interrupt-v1-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const failpoint of ["runtime-staged", "skills-activated", "shim-activated", "manifest-committed", "journal-cleaned"]) {
    const home = path.join(root, failpoint); const base = { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT };
    const interrupted = run(path.join(ROOT, "install.mjs"), [], { env: { ...base, TASKLOOP_INSTALL_FAILPOINT: failpoint } });
    assert.notEqual(interrupted.status, 0, failpoint);
    if (failpoint !== "journal-cleaned") assert.ok(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), failpoint);
    const resumed = run(path.join(ROOT, "install.mjs"), [], { env: base }); assert.equal(resumed.status, 0, `${failpoint}: ${resumed.stderr}`);
    const info = JSON.parse(run(path.join(home, "bin", "taskloop.mjs"), ["info"], { env: base }).stdout); assert.equal(info.runtime_contract, 3);
    assert.equal(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), false);
  }
});
