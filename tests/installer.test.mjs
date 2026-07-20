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
  const safe = Buffer.from(JSON.stringify(safeConfig, null, 2) + "\n");
  fs.writeFileSync(config, safe);
  const checked = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.doesNotMatch(checked.stdout, /legacy Codex workloop Stop hook found/);
  assert.deepEqual(fs.readFileSync(config), safe);
});

test("installer does not confuse a workloop PreToolUse hook with another tool's Stop hook", (t) => {
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
  assert.doesNotMatch(installed.stdout, /Codex workloop Stop hook/);
  assert.deepEqual(fs.readFileSync(config), original);
});

test("installer does not confuse a TOML workloop PreToolUse hook with Stop", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-hook-toml-ownership-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = Buffer.from('[[hooks.PreToolUse]]\nmatcher = "Write"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node /installed/workloop.mjs hook --profile codex-safe"\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node /installed/notifier.mjs"\n');
  fs.writeFileSync(config, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env: { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT } });

  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.doesNotMatch(installed.stdout, /Codex workloop Stop hook|cannot inspect Codex Hook configuration.*config\.toml/);
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

test("installer adopts skill trees a pre-rename release installed under the legacy manifest name", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-legacy-manifest-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  assert.equal(run(path.join(ROOT, "install.mjs"), [], { env }).status, 0);

  // Reproduce a home upgraded from the pre-rename release: the ownership
  // record still carries the legacy file name, so nothing claims the trees.
  const current = path.join(home, "bin", ".workloop-managed-skills.json");
  fs.renameSync(current, path.join(home, "bin", ".taskloop-managed-skills.json"));

  const upgraded = run(path.join(ROOT, "install.mjs"), [], { env });
  assert.equal(upgraded.status, 0, upgraded.stdout || upgraded.stderr);
  assert.doesNotMatch(upgraded.stdout, /is not proven workloop-owned/);
  assert.ok(fs.existsSync(current), "adoption must recommit ownership under the current manifest name");
  const adopted = JSON.parse(fs.readFileSync(current, "utf8"));
  for (const runtime of [".claude", ".codex"]) for (const skill of ["loop-core", "workloop"]) assert.ok(adopted.runtimes[runtime][skill]);
});

test("installer does not adopt a same-named skill tree the legacy manifest never owned", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-legacy-foreign-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  const foreign = path.join(home, ".claude", "skills", "judgmentloop");
  fs.mkdirSync(foreign, { recursive: true });
  const original = Buffer.from("# someone else's judgmentloop\n");
  fs.writeFileSync(path.join(foreign, "SKILL.md"), original);
  // A legacy manifest that claims the name but records a different tree must
  // not launder a takeover into workloop ownership.
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", ".taskloop-managed-skills.json"), JSON.stringify({
    version: 2, runtimes: { ".claude": { judgmentloop: "0".repeat(64) }, ".codex": {} },
  }, null, 2) + "\n");

  const installed = run(path.join(ROOT, "install.mjs"), [], { env });

  assert.notEqual(installed.status, 0);
  assert.match(installed.stdout, /judgmentloop.*(not proven workloop-owned|changed since workloop installed it)/);
  assert.deepEqual(fs.readFileSync(path.join(foreign, "SKILL.md")), original);
});

test("installer migrates a pre-rename outcome ledger without carrying control state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-ledger-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  const legacyRoot = path.join(home, ".taskloop");
  fs.mkdirSync(path.join(legacyRoot, "outcomes-v3-cursors"), { recursive: true });
  const rows = '{"kind":"task_opened","task_id":"a"}\n{"kind":"task_closed","task_id":"a"}\n';
  fs.writeFileSync(path.join(legacyRoot, "outcomes-v3.jsonl"), rows);
  fs.writeFileSync(path.join(legacyRoot, "outcomes.jsonl"), '{"kind":"legacy"}\n');
  fs.writeFileSync(path.join(legacyRoot, "outcomes-v3-cursors", "abc.json"), '{"offset":2}\n');
  // Control state is schema-versioned separately and hard-blocks an armed Stop
  // gate if it lands in the ledger root, so it must never ride along.
  fs.writeFileSync(path.join(legacyRoot, "task.json"), JSON.stringify({ version: 1, id: "stale" }) + "\n");
  fs.writeFileSync(path.join(legacyRoot, "untracked-writes.json"), JSON.stringify({ sessions: {} }) + "\n");

  const installed = run(path.join(ROOT, "install.mjs"), [], { env });

  assert.equal(installed.status, 0, installed.stdout || installed.stderr);
  const ledgerRoot = path.join(home, ".workloop");
  assert.equal(fs.readFileSync(path.join(ledgerRoot, "outcomes-v3.jsonl"), "utf8"), rows);
  assert.equal(fs.readFileSync(path.join(ledgerRoot, "outcomes.jsonl"), "utf8"), '{"kind":"legacy"}\n');
  assert.equal(fs.readFileSync(path.join(ledgerRoot, "outcomes-v3-cursors", "abc.json"), "utf8"), '{"offset":2}\n');
  assert.equal(fs.existsSync(path.join(ledgerRoot, "task.json")), false, "control state must not enter the ledger root");
  assert.equal(fs.existsSync(path.join(ledgerRoot, "untracked-writes.json")), false, "control state must not enter the ledger root");
  assert.ok(fs.existsSync(path.join(legacyRoot, "outcomes-v3.jsonl")), "migration copies; the owner removes the source");
});

test("installer never overwrites ledger rows already recorded under the current root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-ledger-keep-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  fs.mkdirSync(path.join(home, ".taskloop"), { recursive: true });
  fs.mkdirSync(path.join(home, ".workloop"), { recursive: true });
  fs.writeFileSync(path.join(home, ".taskloop", "outcomes-v3.jsonl"), '{"kind":"stale"}\n');
  const current = '{"kind":"current"}\n';
  fs.writeFileSync(path.join(home, ".workloop", "outcomes-v3.jsonl"), current);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env });

  assert.equal(installed.status, 0, installed.stdout || installed.stderr);
  assert.equal(fs.readFileSync(path.join(home, ".workloop", "outcomes-v3.jsonl"), "utf8"), current);
});

test("installer diagnoses a pre-rename Claude hook without editing user configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-claude-hook-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: 'node "/home/bin/taskloop.mjs" hook --profile claude --mode nudge' }] }],
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/home/bin/taskloop.mjs" hook --profile claude --mode nudge' }] }],
  } }, null, 2) + "\n");
  fs.writeFileSync(settings, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env });

  assert.equal(installed.status, 0, installed.stdout || installed.stderr);
  assert.match(installed.stdout, /Claude Hook configuration still runs the pre-rename shim/);
  assert.match(installed.stdout, /workloop\.mjs/);
  assert.deepEqual(fs.readFileSync(settings), original, "host hook configuration is diagnosed, never rewritten");
});

test("installer stays quiet about a Claude hook already on the current shim", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-claude-hook-ok-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ hooks: {
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/home/bin/workloop.mjs" hook --profile claude --mode nudge' }] }],
  } }, null, 2) + "\n");

  const installed = run(path.join(ROOT, "install.mjs"), [], { env });

  assert.equal(installed.status, 0, installed.stdout || installed.stderr);
  assert.doesNotMatch(installed.stdout, /pre-rename shim/);
});

test("installer reclaims a hooks path whose directory is gone but keeps a live foreign one", async () => {
  const { hooksPathDisposition } = await import(new URL("../install.mjs", import.meta.url));
  const expected = path.join(ROOT, "hooks");
  // A rename leaves core.hooksPath pointing at a directory that is simply gone;
  // that is stale, not foreign, so reclaiming it cannot clobber anyone's hooks.
  assert.equal(hooksPathDisposition({ current: "", expected, present: () => true }).action, "set");
  assert.equal(hooksPathDisposition({ current: expected, expected, present: () => true }).action, "keep");
  assert.equal(hooksPathDisposition({ current: "/gone/taskloop/hooks", expected, present: () => false }).action, "reclaim");
  assert.equal(hooksPathDisposition({ current: "/live/other/hooks", expected, present: () => true }).action, "refuse");
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

test("installer warns when the Claude PreToolUse matcher leaves subagent spawns ungated", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-install-subagent-gap-")); const home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKLOOP_INSTALL_HOME: home, WORKLOOP_INSTALL_REPO: ROOT };
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = Buffer.from(JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Write|Edit|Bash", hooks: [{ type: "command", command: 'node "/home/bin/workloop.mjs" hook --profile claude --mode nudge' }] }],
  } }, null, 2) + "\n");
  fs.writeFileSync(settings, original);

  const installed = run(path.join(ROOT, "install.mjs"), [], { env });

  assert.equal(installed.status, 0, installed.stdout || installed.stderr);
  assert.match(installed.stdout, /matcher does not cover the Agent tool/);
  assert.deepEqual(fs.readFileSync(settings), original, "host hook configuration is diagnosed, never rewritten");

  // Covering the spawning tool clears the warning.
  fs.writeFileSync(settings, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Write|Edit|Bash|Agent", hooks: [{ type: "command", command: 'node "/home/bin/workloop.mjs" hook --profile claude --mode nudge' }] }],
  } }, null, 2) + "\n");
  const covered = run(path.join(ROOT, "install.mjs"), [], { env });
  assert.equal(covered.status, 0, covered.stderr);
  assert.doesNotMatch(covered.stdout, /matcher does not cover the Agent tool/);
});
