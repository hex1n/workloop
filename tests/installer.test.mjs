import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(".");

function run(script, args = [], options = {}) { return spawnSync(process.execPath, [script, ...args], { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, input: options.input ?? "", encoding: "utf8" }); }

test("installer puts runtime and skills from one release under a temporary home", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-v1-")); const home = path.join(root, "home"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const shim = path.join(home, "bin", "workloop.mjs"); assert.ok(fs.existsSync(shim));
  const windowsShim = path.join(home, "bin", "workloop.cmd"); assert.ok(fs.existsSync(windowsShim));
  const powershellShim = path.join(home, "bin", "workloop.ps1"); assert.ok(fs.existsSync(powershellShim));
  assert.equal(fs.readFileSync(windowsShim, "utf8"), '@echo off\r\nnode "%~dp0workloop.mjs" %*\r\n');
  assert.equal(fs.readFileSync(powershellShim, "utf8"), "$script = Join-Path $PSScriptRoot 'workloop.mjs'\r\n& node $script @args\r\nexit $LASTEXITCODE\r\n");
  const info = JSON.parse(run(shim, ["info"], { env: { ...process.env, HOME: home, USERPROFILE: home } }).stdout); assert.equal(info.runtime_contract, 5);
  for (const runtime of [".claude", ".codex"]) for (const skill of ["loop-core", "workloop", "judgmentloop", "meta-loop"]) assert.ok(fs.existsSync(path.join(home, runtime, "skills", skill, skill === "loop-core" ? "REFERENCE.md" : "SKILL.md")));
  const manifest = JSON.parse(fs.readFileSync(path.join(home, "bin", ".workloop-active-release.json"), "utf8"));
  assert.equal(manifest.release_id, manifest.runtime_digest); assert.equal(manifest.runtime_contract, 5);
  assert.equal(fs.existsSync(path.join(home, "bin", ".workloop-activation-journal.json")), false);
});

test("installer warns about legacy Codex Stop hooks without editing user configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-profile-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "/installed/workloop.mjs"' }] }] } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /legacy Codex workloop Stop hook.*hooks --profile codex-safe/);
  assert.deepEqual(fs.readFileSync(config), original);

  const safeConfig = JSON.parse(original.toString("utf8"));
  safeConfig.hooks.Stop[0].hooks[0].command += " hook --profile codex-safe";
  safeConfig.hooks.Stop[0].hooks[0].timeout = 45;
  safeConfig.hooks.Stop[0].matcher = "*";
  safeConfig.hooks.PreToolUse = [{
    matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*",
    hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-safe', timeout: 20 }],
  }];
  safeConfig.hooks.PostToolUse = [{
    matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*",
    hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-safe', timeout: 30 }],
  }];
  const safe = Buffer.from(JSON.stringify(safeConfig, null, 2) + "\n");
  fs.writeFileSync(config, safe);
  const checked = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.doesNotMatch(checked.stdout, /(?:legacy|experimental).*Codex.*hook|Codex workloop (?:PreToolUse|PostToolUse|Stop) hook (?:is missing|uses a stale|is configured)/);
  assert.deepEqual(fs.readFileSync(config), safe);
});

test("installer diagnoses a missing Codex PreToolUse hook without editing configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-missing-pretooluse-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: {
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-safe --mode nudge', timeout: 45 }] }],
  } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /Codex workloop PreToolUse hook is missing.*hooks --profile codex-safe/);
  assert.match(installed.stdout, /Codex workloop PostToolUse hook is missing.*hooks --profile codex-safe/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer diagnoses Codex PreToolUse profile, timeout, and matcher drift", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-pretooluse-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    {
      name: "profile",
      handler: { type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-cli-legacy --mode nudge', timeout: 20 },
      matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*",
      expected: /experimental Codex CLI legacy PreToolUse hook/,
    },
    {
      name: "timeout",
      handler: { type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-safe --mode nudge', timeout: 45 },
      matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*",
      expected: /Codex workloop PreToolUse hook uses a stale or missing timeout/,
    },
    {
      name: "matcher",
      handler: { type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-safe --mode nudge', timeout: 20 },
      matcher: "Write|Bash",
      expected: /Codex workloop PreToolUse hook uses a stale or missing matcher/,
    },
  ];
  for (const fixture of cases) {
    const home = path.join(root, fixture.name);
    const config = path.join(home, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = Buffer.from(JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: fixture.matcher, hooks: [fixture.handler] }],
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-safe --mode nudge', timeout: 45 }] }],
    } }, null, 2) + "\n");
    fs.writeFileSync(config, original);

    const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });
    assert.equal(installed.status, 0, `${fixture.name}: ${installed.stderr || installed.stdout}`);
    assert.match(installed.stdout, fixture.expected, fixture.name);
    assert.deepEqual(fs.readFileSync(config), original, fixture.name);
  }
});

test("installer diagnoses Claude PreToolUse drift without editing configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-claude-pretooluse-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile claude --mode nudge', timeout: 45 }] }],
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile claude --mode nudge', timeout: 45 }] }],
  } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /Claude workloop PreToolUse hook uses a stale or missing timeout/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer diagnoses a stale codex-safe Stop timeout without editing configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-timeout-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile codex-safe --mode nudge', timeout: 300 }] }] } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /stale or missing timeout.*hooks --profile codex-safe/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer diagnoses a stale Claude hard-Stop timeout without editing configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-claude-timeout-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "/installed/workloop.mjs" hook --profile claude --mode nudge', timeout: 300 }] }] } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /Claude workloop Stop hook uses a stale or missing timeout.*hooks --profile claude/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer reports a missing Workloop Stop without confusing another tool's Stop hook", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-ownership-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: 'node "/installed/workloop.mjs"' }] }],
    Stop: [{ hooks: [{ type: "command", command: 'node "/installed/notifier.mjs"' }] }],
  } }, null, 2) + "\n");
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /Codex workloop Stop hook is missing/);
  assert.doesNotMatch(installed.stdout, /legacy Codex workloop Stop hook/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer reports a missing TOML Workloop Stop without confusing another tool's Stop", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-toml-ownership-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('[[hooks.PreToolUse]]\nmatcher = "Write"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node /installed/workloop.mjs hook --profile codex-safe"\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node /installed/notifier.mjs"\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /Codex workloop Stop hook is missing/);
  assert.doesNotMatch(installed.stdout, /legacy Codex workloop Stop hook|cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer diagnoses inline TOML workloop Stop handlers without rewriting TOML", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-toml-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('[[hooks.Stop]]\nmatcher = "*"\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = \'node "/installed/workloop.mjs"\'\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /legacy Codex workloop Stop hook.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer warns when workloop TOML hook syntax cannot be inspected safely", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-toml-unsafe-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('hooks = { Stop = [{ command = "node /installed/workloop.mjs" }] }\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer warns about unsupported workloop Stop syntax even beside a recognized PreToolUse section", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-toml-mixed-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('[[hooks.PreToolUse.hooks]]\ncommand = "node /installed/workloop.mjs hook --profile codex-safe"\n\nhooks.Stop.command = "node /installed/workloop.mjs"\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer warns about a multiline dotted workloop Stop value", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-toml-multiline-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('hooks.Stop = [\n  { command = "node /installed/workloop.mjs" }\n]\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /cannot inspect Codex Hook configuration.*config\.toml/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("runtime-contract-5 installer refuses a contract-3 source rollback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-no-v3-rollback-")); const home = path.join(root, "home"); const source = path.join(root, "source");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["bin", "lib", "skills"]) fs.cpSync(path.join(ROOT, directory), path.join(source, directory), { recursive: true });
  const prims = path.join(source, "lib", "prims.mjs");
  fs.writeFileSync(prims, fs.readFileSync(prims, "utf8").replace("const RUNTIME_CONTRACT = 5;", "const RUNTIME_CONTRACT = 3;"));
  const result = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: source } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /refusing contract 3/);
  assert.equal(fs.existsSync(path.join(home, "bin", "workloop.mjs")), false);
});

test("installed runtime exercises the assurance matrix", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-assurance-install-v2-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, TZ: "UTC", HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  assert.equal(run(path.join(ROOT, "install.mjs"), [], { env }).status, 0);
  const shim = path.join(home, "bin", "workloop.mjs");
  const makeRepo = (name, satisfied = false, stateCriterion = false) => {
    const repo = path.join(root, name); fs.mkdirSync(path.join(repo, ...(stateCriterion ? [".workloop"] : [])), { recursive: true });
    const checker = stateCriterion ? path.join(repo, ".workloop", "check.mjs") : path.join(repo, "check.mjs");
    fs.writeFileSync(checker, `process.exit(${satisfied ? 0 : 1});\n`); fs.writeFileSync(path.join(repo, "work.txt"), "x\n"); return repo;
  };
  const open = (repo, extra = [], satisfied = false, stateCriterion = false) => run(shim, ["open", "--repo", repo, "--goal", "matrix", "--criterion-file", stateCriterion ? ".workloop/check.mjs" : "check.mjs", "--criterion-policy", satisfied ? "steady-satisfied" : "default", ...(satisfied ? ["--reason", "guard"] : []), "--alignment-because", "probe", "--files", "work.txt", ...extra], { env });
  const status = (repo) => JSON.parse(run(shim, ["status", "--repo", repo], { env }).stdout);

  const routine = makeRepo("routine"); assert.equal(open(routine, ["--risk", "routine", "--risk-reason", "reversible"]).status, 0); assert.equal(status(routine).review_requirement.level, null);
  const joined = run(shim, ["join", "--repo", routine, "--reason", "installed handoff"], { env: { ...env, WORKLOOP_SESSION_ID: "installed-session" } }); assert.equal(joined.status, 0, joined.stderr); assert.equal(JSON.parse(run(shim, ["status", "--repo", routine], { env: { ...env, WORKLOOP_SESSION_ID: "installed-session" } }).stdout).session_binding.cli_identity_matches_owner, true);
  const routineState = JSON.parse(fs.readFileSync(path.join(routine, ".workloop", "task.json"), "utf8")).projection; assert.match(routineState.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(run(shim, ["abandon", "--repo", routine, "--reason", "archive probe"], { env }).status, 0); assert.equal(open(routine, ["--risk", "routine", "--risk-reason", "reversible"]).status, 0);
  assert.equal(fs.readFileSync(path.join(routine, ".workloop", "events.jsonl"), "utf8").trim().split("\n").flatMap((line) => JSON.parse(line).events).filter((event) => event.kind === "task_opened").length, 2);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-interrupt-v1-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const failpoint of ["runtime-staged", "skills-activated", "shim-activated", "manifest-committed", "journal-cleaned"]) {
    const home = path.join(root, failpoint); const base = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
    const interrupted = run(path.join(ROOT, "install.mjs"), [], { env: { ...base, WORKLOOP_INSTALL_FAILPOINT: failpoint } });
    assert.notEqual(interrupted.status, 0, failpoint);
    if (failpoint !== "journal-cleaned") assert.ok(fs.existsSync(path.join(home, "bin", ".workloop-activation-journal.json")), failpoint);
    const resumed = run(path.join(ROOT, "install.mjs"), [], { env: base }); assert.equal(resumed.status, 0, `${failpoint}: ${resumed.stderr}`);
    const info = JSON.parse(run(path.join(home, "bin", "workloop.mjs"), ["info"], { env: base }).stdout); assert.equal(info.runtime_contract, 5);
    assert.equal(fs.existsSync(path.join(home, "bin", ".workloop-activation-journal.json")), false);
  }
});

test("uninstall removes what it installed and preserves what it cannot prove is its own", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-uninstall-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  assert.equal(run(path.join(ROOT, "install.mjs"), [], { env }).status, 0);

  // Three things uninstall must not take: a managed tree the owner edited, a
  // tree it never installed, and a shim someone replaced by hand.
  const edited = path.join(home, ".claude", "skills", "meta-loop", "SKILL.md");
  fs.appendFileSync(edited, "\nlocally edited\n");
  const foreign = path.join(home, ".claude", "skills", "someone-elses");
  fs.mkdirSync(foreign, { recursive: true }); fs.writeFileSync(path.join(foreign, "SKILL.md"), "not ours\n");
  const handShim = path.join(home, "bin", "workloop.ps1");
  fs.writeFileSync(handShim, "#!/bin/sh\necho hand written\n");
  const ledger = path.join(home, ".workloop");
  fs.mkdirSync(ledger, { recursive: true }); fs.writeFileSync(path.join(ledger, "outcomes.jsonl"), '{"row":1}\n');

  const dry = run(path.join(ROOT, "uninstall.mjs"), ["--dry-run"], { env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(fs.existsSync(path.join(home, "bin", ".workloop-runtime")), "dry run must not delete");

  const removed = run(path.join(ROOT, "uninstall.mjs"), [], { env });
  assert.equal(removed.status, 0, removed.stderr);
  for (const gone of [".workloop-runtime", ".workloop-managed-skills.json", ".workloop-active-release.json", "workloop.mjs", "workloop.cmd"]) {
    assert.equal(fs.existsSync(path.join(home, "bin", gone)), false, `${gone} should be removed`);
  }
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "loop-core")), false);
  assert.match(fs.readFileSync(edited, "utf8"), /locally edited/);
  assert.ok(fs.existsSync(path.join(foreign, "SKILL.md")));
  assert.match(fs.readFileSync(handShim, "utf8"), /hand written/);
  assert.ok(fs.existsSync(path.join(ledger, "outcomes.jsonl")), "the outcome ledger is not an install artifact");
  assert.match(removed.stdout, /is not a workloop-generated shim; preserved/);
  assert.match(removed.stdout, /changed since workloop installed it; preserved/);
  assert.match(removed.stdout, /--purge-ledger/);

  // Rerunning is a no-op, and --purge-ledger is the explicit opt-in.
  const again = run(path.join(ROOT, "uninstall.mjs"), [], { env });
  assert.equal(again.status, 0); assert.match(again.stdout, /0 remove/);
  assert.equal(run(path.join(ROOT, "uninstall.mjs"), ["--purge-ledger"], { env }).status, 0);
  assert.equal(fs.existsSync(ledger), false);
});

test("uninstall on a home that never installed workloop changes nothing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-uninstall-fresh-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(home, { recursive: true });
  const result = run(path.join(ROOT, "uninstall.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 remove/);
  assert.equal(run(path.join(ROOT, "uninstall.mjs"), ["--bogus"], { env: { ...process.env, WORKLOOP_INSTALL_HOME: home } }).status, 2);
});

test("uninstall preserves foreign content wearing workloop names", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-uninstall-foreign-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A home that never installed workloop but holds same-named foreign
  // content: a runtime directory with real work in it, an empty directory
  // named after the empty-set hash, control files that carry the right
  // version discriminator but not the written shape, and a skill tree wearing
  // a shipped skill name with no manifest record. Nothing here is provably
  // ours, so nothing may be deleted and everything must be reported.
  const bin = path.join(home, "bin");
  const notes = path.join(bin, ".workloop-runtime", "notes");
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, "todo.txt"), "keep me\n");
  fs.mkdirSync(path.join(bin, ".workloop-runtime", "e3b0c44298fc"), { recursive: true });
  // Each control file carries the right version discriminator but not the
  // written shape, so a validator relaxed back to discriminator-only for any
  // one of them deletes that file and fails this test.
  fs.writeFileSync(path.join(bin, ".workloop-managed-skills.json"), JSON.stringify({ version: 2, runtimes: [] }) + "\n");
  fs.writeFileSync(path.join(bin, ".workloop-active-release.json"), JSON.stringify({ release_manifest_version: 1 }) + "\n");
  fs.writeFileSync(path.join(bin, ".workloop-activation-journal.json"), JSON.stringify({ journal_version: 1, steps: {} }) + "\n");
  const squatter = path.join(home, ".claude", "skills", "workloop");
  fs.mkdirSync(squatter, { recursive: true });
  fs.writeFileSync(path.join(squatter, "SKILL.md"), "not the managed tree\n");
  const result = run(path.join(ROOT, "uninstall.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 remove/);
  assert.ok(fs.existsSync(path.join(notes, "todo.txt")), "foreign runtime content survives");
  assert.ok(fs.existsSync(path.join(bin, ".workloop-runtime", "e3b0c44298fc")), "an empty tree can never be proven ours");
  for (const kept of [".workloop-managed-skills.json", ".workloop-active-release.json", ".workloop-activation-journal.json"]) {
    assert.ok(fs.existsSync(path.join(bin, kept)), `${kept} survives`);
  }
  assert.ok(fs.existsSync(path.join(squatter, "SKILL.md")), "a same-named tree without a manifest record survives");
  assert.match(result.stdout, /is not a workloop-installed runtime version; preserved/);
  assert.match(result.stdout, /kept: it still holds entries workloop cannot prove it installed/);
  assert.match(result.stdout, /does not match the shape workloop writes; preserved/);
  assert.match(result.stdout, /wears a workloop skill name but the manifest cannot prove workloop installed it; preserved/);
  // Unparseable is preserved through the same door as wrong-shaped.
  fs.writeFileSync(path.join(bin, ".workloop-activation-journal.json"), "not json\n");
  const again = run(path.join(ROOT, "uninstall.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home } });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /0 remove/);
  assert.ok(fs.existsSync(path.join(bin, ".workloop-activation-journal.json")), "unparseable journal survives");
});

test("uninstall preserves a runtime version carrying a stowaway", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-uninstall-stowaway-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Anything the owner put inside the versioned runtime — a file, or an empty
  // directory the hash cannot see — is work the proof no longer covers: the
  // whole version directory must survive either way.
  const plants = {
    file: (version) => { const p = path.join(version, "notes.txt"); fs.writeFileSync(p, "irreplaceable\n"); return p; },
    "empty-dir": (version) => { const p = path.join(version, "keepsake"); fs.mkdirSync(p); return p; },
  };
  for (const [variant, plant] of Object.entries(plants)) {
    const home = path.join(root, variant);
    const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
    assert.equal(run(path.join(ROOT, "install.mjs"), [], { env }).status, 0);
    const runtimeRoot = path.join(home, "bin", ".workloop-runtime");
    const version = fs.readdirSync(runtimeRoot).filter((name) => /^[0-9a-f]{12}$/.test(name))[0];
    const stowaway = plant(path.join(runtimeRoot, version));
    const removed = run(path.join(ROOT, "uninstall.mjs"), [], { env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(fs.existsSync(stowaway), `${variant}: the stowaway survives with its directory`);
    assert.match(removed.stdout, /is not a workloop-installed runtime version; preserved/);
    assert.match(removed.stdout, /kept: it still holds entries workloop cannot prove it installed/);
    // Everything provable still leaves: shims and control files are gone.
    for (const gone of ["workloop.mjs", "workloop.cmd", ".workloop-managed-skills.json", ".workloop-active-release.json"]) {
      assert.equal(fs.existsSync(path.join(home, "bin", gone)), false, `${variant}: ${gone} should be removed`);
    }
  }
});

test("the published tarball carries exactly what installing needs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-pack-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // npm is npm.cmd on Windows, which a bare spawn cannot resolve under Node 22.
  const packed = spawnSync("npm", ["pack", "--pack-destination", root], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(packed.status, 0, packed.stderr);
  // Extract with a relative path from inside root: GNU tar reads a drive-colon
  // absolute path as a remote host, and bsdtar has no --force-local escape.
  const tarball = packed.stdout.trim().split("\n").at(-1);
  assert.equal(spawnSync("tar", ["-xzf", tarball], { cwd: root, encoding: "utf8" }).status, 0);
  const pkg = path.join(root, "package");

  // Publishing internal working material is not undoable, so the allowlist is
  // asserted from both directions: what must ship, and what must never.
  for (const required of ["bin", "lib", "skills", "install.mjs", "uninstall.mjs", "package.json", "LICENSE"]) {
    assert.ok(fs.existsSync(path.join(pkg, required)), `${required} must ship`);
  }
  // Publishing without stated terms is the ambiguity the LICENSE file exists to
  // remove, so the packaged manifest must keep saying so.
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).license, "UNLICENSED");
  for (const excluded of ["docs", "tests", ".scratch", "hooks", "AGENTS.md", "CLAUDE.md"]) {
    assert.equal(fs.existsSync(path.join(pkg, excluded)), false, `${excluded} must not ship`);
  }

  // The allowlist is only correct if the installer still works from it.
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: pkg };
  const installed = run(path.join(pkg, "install.mjs"), [], { env });
  assert.equal(installed.status, 0, installed.stderr);
  assert.doesNotMatch(installed.stdout, /^ {2}error/m);
  const info = JSON.parse(run(path.join(home, "bin", "workloop.mjs"), ["info"], { env }).stdout);
  assert.equal(info.name, "workloop"); assert.equal(info.runtime_contract, 5);
  for (const skill of ["loop-core", "workloop", "judgmentloop", "meta-loop"]) {
    assert.ok(fs.existsSync(path.join(home, ".claude", "skills", skill)), `${skill} must install`);
  }
  assert.equal(run(path.join(pkg, "uninstall.mjs"), [], { env }).status, 0);
  assert.equal(fs.existsSync(path.join(home, "bin", ".workloop-runtime")), false);
});
