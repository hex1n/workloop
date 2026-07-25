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
import { npm } from "./helpers/npm.mjs";

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
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-release-")));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const packed = npm(["pack", "--json", "--pack-destination", scratch], { cwd: repoRoot });
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
  const tarball = path.join(scratch, JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0].filename);
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
  // HF-06's one surviving clause: repeated installation is idempotent. npm owns
  // the mechanism; what is asserted here is only that it holds for this package.
  assert.deepEqual(inventory(prefix), afterFirst, "a second install changed the installed tree");

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
    });

    // WN-01 names all three Windows shells. A missing one is a shell this
    // machine cannot prove the release works from, not a shell to skip past.
    assert.equal(ran.error?.code, undefined, `${shell.id} could not be started: ${ran.error?.message}`);
    assert.equal(ran.status, 0, `${shell.id} exited ${ran.status} (${HELP_FAILED} = --help failed, ${UNKNOWN_VERB_NOT_1} = an unknown verb did not exit 1)\n${ran.stdout}\n${ran.stderr}`);
    // Exit 0 alone would also be what a script that ran nothing returns.
    // ASCII on purpose: the banner's em dash would be at the mercy of a console
    // codepage, and this assertion is about the CLI having run, not about that.
    assert.match(ran.stdout, /workloop <verb>/u, `${shell.id} exited 0 without the CLI having printed anything`);
  }
});
