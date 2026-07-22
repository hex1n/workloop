import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCriterionSource } from "../lib/criterion.mjs";

const ROOT = path.resolve(".");
const INSTALLER = path.join(ROOT, "install.mjs");
const WINDOWS = process.platform === "win32";
process.env.WORKLOOP_INSTALL_ISOLATED = "1";

function runNode(script, args = [], { cwd = ROOT, env = process.env, input = "", timeout = 30_000 } = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env, input, encoding: "utf8", timeout });
}

function withPath(env, entry) {
  const next = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "path"));
  const current = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  next.Path = [entry, current].filter(Boolean).join(path.delimiter);
  return next;
}

function parsed(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function installFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-windows-"));
  const home = path.join(root, "home with spaces 用户");
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WORKLOOP_INSTALL_HOME: home,
    WORKLOOP_INSTALL_REPO: ROOT,
  };
  return { root, home, env };
}

function installedFixture(t) {
  const fixture = installFixture(t);
  const installed = runNode(INSTALLER, [], { env: fixture.env });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  return { ...fixture, shim: path.join(fixture.home, "bin", "workloop.mjs") };
}

function pidsRegisteredWithin(pidFile, timeoutMs) {
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
      if ([pids.parent, pids.descendant].every((pid) => Number.isInteger(pid) && pid > 0)) return pids;
    } catch { /* the child has not registered a pid yet */ }
    if (Date.now() >= deadline) return null;
    Atomics.wait(idle, 0, 0, 50);
  }
}

test("Windows install is repeatable and exposes workloop to cmd and both PowerShell editions", { skip: !WINDOWS }, (t) => {
  const fixture = installFixture(t);
  const source = path.join(fixture.root, "install source");
  for (const directory of ["bin", "lib", "skills"]) fs.cpSync(path.join(ROOT, directory), path.join(source, directory), { recursive: true });
  const env = { ...fixture.env, WORKLOOP_INSTALL_REPO: source };
  for (const attempt of ["first", "second"]) {
    const installed = runNode(INSTALLER, [], { env });
    assert.equal(installed.status, 0, `${attempt} install: ${installed.stderr || installed.stdout}`);
  }

  const firstRelease = JSON.parse(fs.readFileSync(path.join(fixture.home, "bin", ".workloop-active-release.json"), "utf8")).release_id;
  fs.appendFileSync(path.join(source, "lib", "prims.mjs"), "\n// Windows upgrade probe.\n");
  const upgraded = runNode(INSTALLER, [], { env });
  assert.equal(upgraded.status, 0, `upgrade install: ${upgraded.stderr || upgraded.stdout}`);
  const secondRelease = JSON.parse(fs.readFileSync(path.join(fixture.home, "bin", ".workloop-active-release.json"), "utf8")).release_id;
  assert.notEqual(secondRelease, firstRelease);
  assert.deepEqual(fs.readdirSync(path.join(fixture.home, "bin", ".workloop-runtime")), [secondRelease]);

  const shellEnv = withPath(env, path.join(fixture.home, "bin"));
  const commands = [
    [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "workloop info"], "cmd"],
    ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "workloop info"], "Windows PowerShell"],
    ["pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "workloop info"], "PowerShell Core"],
  ];
  for (const [executable, args, label] of commands) {
    const info = parsed(spawnSync(executable, args, { env: shellEnv, encoding: "utf8", timeout: 30_000 }), label);
    assert.equal(info.runtime_contract, 6, label);
  }
});

const hookShells = [
  ["cmd", process.env.ComSpec ?? "cmd.exe", (command) => ["/d", "/s", "/c", command], { windowsVerbatimArguments: true }],
  ["Windows PowerShell", "powershell.exe", (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {}],
  ["PowerShell Core", "pwsh.exe", (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {}],
];

for (const [label, executable, argsFor, spawnOptions] of hookShells) {
  test(`Windows generated hook command carries a real PreToolUse payload through ${label}`, { skip: !WINDOWS }, (t) => {
    const fixture = installedFixture(t);
    const hooks = parsed(runNode(fixture.shim, ["hooks", "--profile", "claude"], { env: fixture.env }), "hooks");
    const command = hooks.hooks.PreToolUse[0].hooks[0].command;
    assert.equal(command, `node "${fixture.shim}" hook --profile claude --mode nudge`, `${label} hook command must use Windows shell quoting, an explicit profile, and the default nudge mode`);
    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: fixture.root,
      session_id: "windows-session",
      tool_name: "PowerShell",
      tool_input: { command: `node ${JSON.stringify(fixture.shim)} status` },
    });
    const args = argsFor(command);
    const response = parsed(spawnSync(executable, args, { env: fixture.env, input: payload, encoding: "utf8", timeout: 30_000, ...spawnOptions }), label);
    assert.equal(response.hookSpecificOutput.permissionDecision, "allow", label);
    assert.match(response.hookSpecificOutput.updatedInput.command, /^\$env:WORKLOOP_SESSION_ID='windows-session'; /, label);
  });
}

test("[W01] Windows genesis and replay survive spaces, Unicode, and drive-case path variants", { skip: !WINDOWS }, (t) => {
  const fixture = installedFixture(t);
  const repo = path.join(fixture.root, "repo with spaces 项目");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");

  const alternateDriveCase = repo.replace(/^([A-Za-z]):/, (_, drive) => `${drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()}:`);
  const opened = runNode(fixture.shim, ["open", "--repo", alternateDriveCase, "--goal", "windows state", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "the checker exercises the result", "--files", "work.txt", "--risk", "routine", "--risk-reason", "isolated fixture"], { cwd: repo, env: fixture.env });
  assert.equal(opened.status, 0, opened.stderr || opened.stdout);
  const audited = parsed(runNode(fixture.shim, ["audit", "--repo", repo], { cwd: repo, env: fixture.env }), "W01 audit");
  assert.equal(audited.valid, true);
  assert.equal(audited.last_repo_sequence, 1);
  assert.equal(fs.readdirSync(path.join(repo, ".workloop")).some((name) => name.includes(".genesis.") && name.endsWith(".tmp")), false);
  const taskFile = path.join(repo, ".workloop", "task.json");
  let previousRevision = JSON.parse(fs.readFileSync(taskFile, "utf8")).projection.task_revision;

  for (const content of ["second\n", "third\n"]) {
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt"), content } });
    const recorded = runNode(fixture.shim, [], { cwd: repo, env: fixture.env, input: payload });
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    const revision = JSON.parse(fs.readFileSync(taskFile, "utf8")).projection.task_revision;
    assert.ok(revision > previousRevision, `${revision} must be newer than ${previousRevision}`);
    previousRevision = revision;
  }
});

test("Windows criterion timeout terminates the child and returns promptly", { skip: !WINDOWS }, (t) => {
  const fixture = installedFixture(t);
  const repo = path.join(fixture.root, "timeout repo");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  const pidFile = path.join(fixture.root, "criterion.pid");
  fs.writeFileSync(path.join(repo, "slow.mjs"), [
    'import fs from "node:fs";',
    'import { spawn } from "node:child_process";',
    'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));`,
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);',
  ].join("\n"));
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");

  let registered = null;
  t.after(() => {
    for (const pid of [registered?.parent, registered?.descendant]) {
      if (!Number.isInteger(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* expected after process-tree cleanup */ }
    }
  });

  const started = Date.now();
  const opened = runNode(fixture.shim, ["open", "--repo", repo, "--goal", "timeout", "--criterion-file", "slow.mjs", "--criterion-policy", "default", "--criterion-timeout-seconds", "5", "--alignment-because", "the checker exercises timeout handling", "--files", "work.txt", "--risk", "routine", "--risk-reason", "isolated fixture"], { cwd: repo, env: fixture.env, timeout: 30_000 });
  assert.equal(opened.status, 2, opened.stderr || opened.stdout);
  assert.match(opened.stderr, /criterion indeterminate; task not opened/i);
  assert.ok(Date.now() - started < 30_000, `timeout took ${Date.now() - started}ms`);
  // The child registers its pid before sleeping, so a termination that failed
  // would leave that write to land during this poll. An absent pid therefore
  // means the child died before it ran, not that a live child went unnoticed.
  registered = pidsRegisteredWithin(pidFile, 5_000);
  if (registered === null) t.diagnostic("criterion process tree was terminated before it registered pids");
  else {
    for (const [kind, pid] of Object.entries(registered)) {
      assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH", `criterion ${kind} ${pid} is still alive`);
    }
  }
});

test("Windows criterion timeout fallback terminates descendants after the first tree-kill attempt fails", { skip: !WINDOWS }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-windows-tree-fallback-"));
  const repo = path.join(root, "repo");
  const pidFile = path.join(root, "criterion-pids.json");
  fs.mkdirSync(repo);
  let registered = null;
  t.after(() => {
    for (const pid of [registered?.parent, registered?.descendant]) {
      if (!Number.isInteger(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* expected after process-tree cleanup */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(repo, "slow.mjs"), [
    'import fs from "node:fs";',
    'import { spawn } from "node:child_process";',
    'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));`,
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);',
  ].join("\n"));

  const started = Date.now();
  const observation = runCriterionSource(
    { kind: "file", value: "slow.mjs" },
    repo,
    0.3,
    "binary",
    { deadlineEpochMs: Date.now() + 6_000, runnerFailFirstTreeKill: true },
  );
  assert.equal(observation.verdict, "indeterminate");
  assert.equal(observation.execution.execution_error, "timeout");
  assert.ok(Date.now() - started < 5_000, `fallback timeout took ${Date.now() - started}ms`);
  registered = pidsRegisteredWithin(pidFile, 5_000);
  assert.notEqual(registered, null, "criterion process tree did not register pids");
  for (const [kind, pid] of Object.entries(registered)) {
    assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH", `criterion ${kind} ${pid} survived the fallback tree kill`);
  }
});

test("[W06] Windows codex-safe Stop releases without launching a long criterion", { skip: !WINDOWS }, (t) => {
  const fixture = installedFixture(t);
  const repo = path.join(fixture.root, "release-only repo");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  const sentinel = path.join(fixture.root, "release-only.started");
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n");
  fs.writeFileSync(path.join(repo, "slow.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sentinel)}, "started"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); process.exit(1);\n`);
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  const opened = runNode(fixture.shim, ["open", "--repo", repo, "--goal", "release", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--criterion-timeout-seconds", "900", "--alignment-because", "release-only probe", "--files", "work.txt", "--risk", "routine", "--risk-reason", "fixture"], { cwd: repo, env: fixture.env });
  assert.equal(opened.status, 0, opened.stderr || opened.stdout);
  const amended = runNode(fixture.shim, ["amend", "--repo", repo, "--criterion-file", "slow.mjs", "--reason", "long criterion probe"], { cwd: repo, env: fixture.env });
  assert.equal(amended.status, 0, amended.stderr || amended.stdout);

  const started = Date.now();
  const stopped = runNode(fixture.shim, ["hook", "--profile", "codex-safe", "--mode", "deny"], { cwd: repo, env: fixture.env, input: JSON.stringify({ hook_event_name: "Stop", cwd: repo }), timeout: 5_000 });
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.equal(stopped.stdout, "");
  assert.ok(Date.now() - started < 2_000, `release-only Stop took ${Date.now() - started}ms`);
  assert.equal(fs.existsSync(sentinel), false);
  const state = JSON.parse(fs.readFileSync(path.join(repo, ".workloop", "task.json"), "utf8")).projection;
  assert.equal(state.spent.rounds, 0);
  assert.equal(state.criterion.last_observation, null);
});

test("[W06] Windows criterion lease waits for a dead owner's declared deadline before recovery", { skip: !WINDOWS }, (t) => {
  const fixture = installedFixture(t);
  const repo = path.join(fixture.root, "criterion lease repo");
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  const opened = runNode(fixture.shim, ["open", "--repo", repo, "--goal", "lease", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--criterion-timeout-seconds", "5", "--alignment-because", "lease probe", "--files", "work.txt", "--risk", "routine", "--risk-reason", "fixture"], { cwd: repo, env: fixture.env });
  assert.equal(opened.status, 0, opened.stderr || opened.stdout);

  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(exited.status, 0, exited.stderr);
  const lock = path.join(repo, ".workloop", ".criterion.lock");
  fs.mkdirSync(lock);
  const now = Date.now();
  const owner = { pid: Number(exited.stdout), token: "dead-owner", intent: "verify_record", started_at_epoch_ms: now - 60_000, deadline_epoch_ms: now + 60_000 };
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
  const old = new Date(now - 60_000);
  fs.utimesSync(lock, old, old);
  const payload = JSON.stringify({ hook_event_name: "Stop", cwd: repo });
  let stopped = runNode(fixture.shim, ["hook", "--profile", "claude", "--mode", "deny"], { cwd: repo, env: fixture.env, input: payload });
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.match(stopped.stdout, /criterion_in_progress/);
  assert.equal(fs.existsSync(lock), true);

  owner.deadline_epoch_ms = now - 20_000;
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
  fs.utimesSync(lock, old, old);
  stopped = runNode(fixture.shim, ["hook", "--profile", "claude", "--mode", "deny"], { cwd: repo, env: fixture.env, input: payload });
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.match(stopped.stdout, /criterion unsatisfied/);
  assert.equal(fs.existsSync(lock), false);
});

test("Windows installer reaps a stale lock owned by an exited process", { skip: !WINDOWS }, (t) => {
  const fixture = installFixture(t);
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(exited.status, 0, exited.stderr);
  const lock = path.join(fixture.home, "bin", ".workloop-runtime.install-lock");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: Number(exited.stdout), token: "exited" }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);

  const installed = runNode(INSTALLER, [], { env: fixture.env, timeout: 10_000 });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(fs.existsSync(lock), false);
});
