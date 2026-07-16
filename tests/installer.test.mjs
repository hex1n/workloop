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
  const info = JSON.parse(run(shim, ["info"], { env: { ...process.env, HOME: home, USERPROFILE: home } }).stdout); assert.equal(info.runtime_contract, 4);
  for (const runtime of [".claude", ".codex"]) for (const skill of ["loop-core", "workloop", "judgmentloop", "meta-loop"]) assert.ok(fs.existsSync(path.join(home, runtime, "skills", skill, skill === "loop-core" ? "REFERENCE.md" : "SKILL.md")));
  const manifest = JSON.parse(fs.readFileSync(path.join(home, "bin", ".taskloop-active-release.json"), "utf8"));
  assert.equal(manifest.release_id, manifest.runtime_digest); assert.equal(manifest.runtime_contract, 4);
  assert.equal(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), false);
});

test("installer warns about legacy Codex Stop hooks without editing user configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-hook-profile-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "/installed/taskloop.mjs"' }] }] } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /legacy Codex taskloop Stop hook.*hooks --profile codex-safe/);
  assert.deepEqual(fs.readFileSync(config), original);

  const safeConfig = JSON.parse(original.toString("utf8"));
  safeConfig.hooks.Stop[0].hooks[0].command += " hook --profile codex-safe";
  const safe = Buffer.from(JSON.stringify(safeConfig, null, 2) + "\n");
  fs.writeFileSync(config, safe);
  const checked = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.doesNotMatch(checked.stdout, /legacy Codex taskloop Stop hook found/);
  assert.deepEqual(fs.readFileSync(config), safe);
});

test("installer does not confuse a taskloop PreToolUse hook with another tool's Stop hook", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-hook-ownership-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: 'node "/installed/taskloop.mjs"' }] }],
    Stop: [{ hooks: [{ type: "command", command: 'node "/installed/notifier.mjs"' }] }],
  } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.doesNotMatch(installed.stdout, /Codex taskloop Stop hook/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer does not confuse a TOML taskloop PreToolUse hook with Stop", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-hook-toml-ownership-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('[[hooks.PreToolUse]]\nmatcher = "Write"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node /installed/taskloop.mjs hook --profile codex-safe"\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node /installed/notifier.mjs"\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.doesNotMatch(installed.stdout, /Codex taskloop Stop hook|cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer diagnoses inline TOML taskloop Stop handlers without rewriting TOML", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-hook-toml-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('[[hooks.Stop]]\nmatcher = "*"\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = \'node "/installed/taskloop.mjs"\'\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /legacy Codex taskloop Stop hook.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer warns when taskloop TOML hook syntax cannot be inspected safely", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-hook-toml-unsafe-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('hooks = { Stop = [{ command = "node /installed/taskloop.mjs" }] }\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer warns about unsupported taskloop Stop syntax even beside a recognized PreToolUse section", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-hook-toml-mixed-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('[[hooks.PreToolUse.hooks]]\ncommand = "node /installed/taskloop.mjs hook --profile codex-safe"\n\nhooks.Stop.command = "node /installed/taskloop.mjs"\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer warns about a multiline dotted taskloop Stop value", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-hook-toml-multiline-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('hooks.Stop = [\n  { command = "node /installed/taskloop.mjs" }\n]\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("runtime-contract-4 installer refuses a contract-3 source rollback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-no-v3-rollback-")); const home = path.join(root, "home"); const source = path.join(root, "source");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["bin", "lib", "skills"]) fs.cpSync(path.join(ROOT, directory), path.join(source, directory), { recursive: true });
  const prims = path.join(source, "lib", "prims.mjs");
  fs.writeFileSync(prims, fs.readFileSync(prims, "utf8").replace("const RUNTIME_CONTRACT = 4;", "const RUNTIME_CONTRACT = 3;"));
  const result = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: source } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /refusing contract 3/);
  assert.equal(fs.existsSync(path.join(home, "bin", "taskloop.mjs")), false);
});

test("installed runtime exercises the assurance matrix", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-assurance-install-v2-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, TZ: "UTC", HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT };
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
  const routineState = JSON.parse(fs.readFileSync(path.join(routine, ".taskloop", "task.json"), "utf8")).projection; assert.match(routineState.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(run(shim, ["abandon", "--repo", routine, "--reason", "archive probe"], { env }).status, 0); assert.equal(open(routine, ["--risk", "routine", "--risk-reason", "reversible"]).status, 0);
  assert.equal(fs.readFileSync(path.join(routine, ".taskloop", "events-v3.jsonl"), "utf8").trim().split("\n").flatMap((line) => JSON.parse(line).events).filter((event) => event.kind === "task_opened").length, 2);
  const substantial = makeRepo("substantial"); assert.equal(open(substantial).status, 0); assert.equal(status(substantial).review_requirement.level, "fresh_context");
  const critical = makeRepo("critical"); assert.equal(open(critical, ["--risk", "critical", "--risk-reason", "contract", "--change-class", "public-contract"]).status, 0); assert.equal(status(critical).review_requirement.level, "second_model");
  assert.equal(run(shim, ["review", "--repo", critical, "--level", "fresh-context", "--reviewer", "peer", "--blocking-findings", "0", "--advisory-findings", "0"], { env }).status, 0); assert.equal(status(critical).review_requirement.accepted, false);
  const floor = makeRepo("floor"); assert.equal(open(floor, ["--risk", "routine", "--risk-reason", "claimed small", "--destructive-allowed", "--reason", "irreversible"]).status, 0); assert.equal(status(floor).review_requirement.level, null);
  const waived = makeRepo("waived", true); assert.equal(open(waived, ["--review-policy", "waived", "--review-waiver-reason", "accepted"], true).status, 0); assert.equal(run(shim, ["achieve", "--repo", waived], { env }).status, 0);
  const stale = makeRepo("stale"); assert.equal(open(stale).status, 0); assert.equal(run(shim, ["review", "--repo", stale, "--level", "fresh-context", "--reviewer", "peer", "--blocking-findings", "0", "--advisory-findings", "0"], { env }).status, 0);
  const hook = JSON.stringify({ hook_event_name: "PreToolUse", cwd: stale, tool_name: "Write", tool_input: { file_path: path.join(stale, "work.txt") } }); assert.equal(run(shim, [], { cwd: stale, env, input: hook }).status, 0); assert.equal(status(stale).review_requirement.accepted, false);
  const weak = makeRepo("weak", true, true); assert.equal(open(weak, ["--risk", "routine", "--risk-reason", "reversible"], true, true).status, 0); assert.equal(run(shim, ["accept-proof-gap", "--repo", weak, "--reason", "accepted", "--granted-by", "user"], { env }).status, 2); assert.equal(status(weak).proof_assurance.state, "adequate");
});

test("every installer activation interruption leaves a journal and rerun converges", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-install-interrupt-v1-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const failpoint of ["runtime-staged", "skills-activated", "shim-activated", "manifest-committed", "journal-cleaned"]) {
    const home = path.join(root, failpoint); const base = { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_INSTALL_HOME: home, TASKLOOP_INSTALL_REPO: ROOT };
    const interrupted = run(path.join(ROOT, "install.mjs"), [], { env: { ...base, TASKLOOP_INSTALL_FAILPOINT: failpoint } });
    assert.notEqual(interrupted.status, 0, failpoint);
    if (failpoint !== "journal-cleaned") assert.ok(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), failpoint);
    const resumed = run(path.join(ROOT, "install.mjs"), [], { env: base }); assert.equal(resumed.status, 0, `${failpoint}: ${resumed.stderr}`);
    const info = JSON.parse(run(path.join(home, "bin", "taskloop.mjs"), ["info"], { env: base }).stdout); assert.equal(info.runtime_contract, 4);
    assert.equal(fs.existsSync(path.join(home, "bin", ".taskloop-activation-journal.json")), false);
  }
});
