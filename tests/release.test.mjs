// WN-01: the release is an npm package with a `bin`, so what needs proving is
// not that the source tree runs — every other test proves that — but that the
// *packed* thing installs and runs. Twice over the same prefix, from a path
// with a space and non-ASCII in it, through every shell the platform actually
// hands people.
//
// This used to live in the CI workflow, where it had never executed once. An
// assertion nobody has ever run is worth what an untested test is worth, and
// its Windows half was written in POSIX syntax that could not have passed. In
// the gate it runs wherever the gate runs, and it can be probed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { VERBS } from "../src/cli.mjs";
import { npm, npmJson } from "./helpers/npm.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// A space and CJK, because those are the two things a path handler gets wrong.
const PREFIX_NAME = "前缀 with space";

// Distinct codes, so a failure says which half of the check failed rather than
// just that the shell was unhappy.
const HELP_FAILED = 21;
const UNKNOWN_VERB_NOT_1 = 22;

// The scripts carry no non-ASCII of their own: the awkward path travels in an
// environment variable, which the OS passes as Unicode, instead of being
// written into a file whose encoding a shell is free to guess.
const SH = `"$WORKLOOP_SHIM" --help || exit ${HELP_FAILED}
"$WORKLOOP_SHIM" frobnicate
test $? -eq 1 || exit ${UNKNOWN_VERB_NOT_1}
exit 0
`;

// \`if errorlevel N\` means "N or greater", so exactly-1 takes both directions.
const CMD = `@echo off\r
call "%WORKLOOP_SHIM%" --help\r
if errorlevel 1 exit /b ${HELP_FAILED}\r
call "%WORKLOOP_SHIM%" frobnicate\r
if not errorlevel 1 exit /b ${UNKNOWN_VERB_NOT_1}\r
if errorlevel 2 exit /b ${UNKNOWN_VERB_NOT_1}\r
exit /b 0\r
`;

// The refusal path writes to stderr, and some PowerShell versions turn native
// stderr into a terminating error. Turn that off where the setting exists: the
// exit code is the contract here, not the stream.
const PS = `if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
& $env:WORKLOOP_SHIM --help
if ($LASTEXITCODE -ne 0) { exit ${HELP_FAILED} }
& $env:WORKLOOP_SHIM frobnicate
if ($LASTEXITCODE -ne 1) { exit ${UNKNOWN_VERB_NOT_1} }
exit 0
`;

const POWERSHELL = (script) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];

// npm writes the POSIX shim under `bin/` and the Windows ones in the prefix
// root, and it writes one per shell — which is why each shell can be asked to
// call the CLI the way its own users would.
const SHELLS = process.platform === "win32"
  ? [
    { id: "cmd", command: "cmd.exe", args: (script) => ["/d", "/s", "/c", script], extension: "cmd", body: CMD, shim: "workloop.cmd" },
    { id: "powershell", command: "powershell.exe", args: POWERSHELL, extension: "ps1", body: PS, shim: "workloop.ps1" },
    { id: "pwsh", command: "pwsh.exe", args: POWERSHELL, extension: "ps1", body: PS, shim: "workloop.ps1" },
  ]
  : [{ id: "sh", command: "/bin/sh", args: (script) => [script], extension: "sh", body: SH, shim: path.join("bin", "workloop") }];

// npm keeps the package under lib/ on POSIX and in the prefix root on Windows.
// Asked rather than assumed: a layout surprise should name itself.
const installedPackage = (prefix) => {
  for (const candidate of [path.join(prefix, "lib", "node_modules", "workloop"), path.join(prefix, "node_modules", "workloop")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`npm installed no workloop package under ${prefix}`);
};

// The verb table the installed binary prints, so it can be compared with the
// one this source tree defines. WN-01 asks the shells for "正确契约版本", which
// is two questions: which release, answered by `--version` below, and which
// contract, answered here — a stale or foreign workloop on the machine can
// share a version string, but not this source tree's verb table.
const verbsOffered = (help) => new Set([...help.matchAll(/^\s{2}([a-z]+)\s{2,}--/gmu)].map((match) => match[1]));

const inventory = (directory) => {
  const seen = [];
  const walk = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const next = path.join(current, entry.name);
      const label = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next, label);
      else seen.push(`${label} ${entry.isSymbolicLink() ? "->" : fs.statSync(next).size}`);
    }
  };
  walk(directory, "");
  return seen;
};

test("WN-01: the packed release installs into an awkward prefix and runs from every shell", (t) => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-release-")));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const packed = npmJson(["pack", "--pack-destination", scratch], { cwd: repoRoot })[0];
  const packedVersion = packed.version;
  const tarball = path.join(scratch, packed.filename);
  assert.ok(fs.existsSync(tarball), `npm pack reported ${tarball}, which is not there`);

  // An empty cache and no network: a zero-dependency tarball has nothing to
  // fetch, and a gate that needs the registry is a gate that goes red on a
  // train.
  const prefix = path.join(scratch, PREFIX_NAME);
  const install = () => npm([
    "install", "--global", "--prefix", prefix,
    "--cache", path.join(scratch, "cache"), "--offline", "--no-audit", "--no-fund",
    tarball,
  ], { cwd: scratch });

  const first = install();
  assert.equal(first.status, 0, `first install failed: ${first.stderr}`);
  const afterFirst = inventory(prefix);

  const second = install();
  assert.equal(second.status, 0, `installing over the same prefix failed: ${second.stderr}`);
  // WN-01 and HF-06's first clause: repeated installation is idempotent. npm
  // owns the mechanism; what is asserted here is only that it holds for this
  // package.
  assert.deepEqual(inventory(prefix), afterFirst, "a second install changed the installed tree");

  // "运行时目录只剩现行版本" — the half of WN-01's second clause that survived
  // the ruling on activation manifests. A file the current tarball does not
  // carry is what a source file deleted since the previous version looks like
  // on disk; installing must replace the package tree, not merge into it, or
  // an upgrade leaves the old runtime's code sitting inside the new one.
  const stale = path.join(installedPackage(prefix), "src", "from-a-previous-version.mjs");
  fs.writeFileSync(stale, "export const gone = true;\n");
  const upgrade = install();
  assert.equal(upgrade.status, 0, `installing over a dirtied package failed: ${upgrade.stderr}`);
  assert.equal(fs.existsSync(stale), false, "a file from a previous version survived the install");
  assert.deepEqual(inventory(prefix), afterFirst, "after installing over a dirtied package the tree is not the current release");

  // What got installed can say which release it is. Compared with what `npm
  // pack` reported rather than with a number written here: a version this test
  // spelled out would be a third copy, and the one that drifts is always the
  // copy nobody runs.
  const shimForVersion = path.join(prefix, process.platform === "win32" ? "workloop.cmd" : path.join("bin", "workloop"));
  const reported = spawnSync(process.execPath, [path.join(installedPackage(prefix), "bin", "workloop.mjs"), "--version"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(reported.status, 0, `--version failed: ${reported.stderr}`);
  assert.equal(reported.stdout.trim(), packedVersion, "the installed runtime knows which release it is");
  assert.ok(fs.existsSync(shimForVersion), "and the shim it was reached through is there");

  const scripts = path.join(scratch, "shell-checks");
  fs.mkdirSync(scripts);

  for (const shell of SHELLS) {
    const shim = path.join(prefix, shell.shim);
    assert.ok(fs.existsSync(shim), `npm installed no ${shell.shim}; the prefix holds:\n${afterFirst.join("\n")}`);

    const script = path.join(scripts, `check-${shell.id}.${shell.extension}`);
    fs.writeFileSync(script, shell.body);
    const ran = spawnSync(shell.command, shell.args(script), {
      encoding: "utf8",
      env: { ...process.env, WORKLOOP_SHIM: shim },
      // A shell that stops for input — a prompt `-NonInteractive` did not
      // suppress, a `cmd` waiting on something — must fail this test, not own
      // the gate until someone notices it never finished.
      timeout: 60_000,
    });

    // WN-01 names all three Windows shells. A missing one is a shell this
    // machine cannot prove the release works from, not a shell to skip past.
    assert.equal(ran.error?.code, undefined, `${shell.id} could not be started: ${ran.error?.message}`);
    assert.equal(ran.status, 0, `${shell.id} exited ${ran.status} (${HELP_FAILED} = --help failed, ${UNKNOWN_VERB_NOT_1} = an unknown verb did not exit 1)\n${ran.stdout}\n${ran.stderr}`);
    // Exit 0 alone would also be what a script that ran nothing returns, and a
    // banner alone would be printed by any workloop this machine happens to
    // have. The verb table is the contract surface, so comparing it with this
    // source tree's own is what answers WN-01's "正确契约版本". ASCII on
    // purpose: it must not depend on a console codepage.
    assert.deepEqual(verbsOffered(ran.stdout), new Set(VERBS), `${shell.id} reached a CLI offering a different verb table\n${ran.stdout}`);
  }
});
