#!/usr/bin/env node
// Acceptance adapter for the command-safety batch. Read-only: it reads
// package.json and runs the repository suite; it writes nothing.
//
// Two things must hold together. The adversarial suite passing while it sits
// outside `npm test` would be a green nobody runs, so the wiring is part of the
// done-when, not a follow-up.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SUITE = "tests/command-safety-adversarial.test.mjs";
const WIRED_SCRIPTS = ["test", "test:matrix"];
const SATISFIED = 4;
const UNSATISFIED = 3;
const INDETERMINATE = 2;

// One bounded line, stable for a given cause: no durations, counts, or paths
// that move between runs, or the three-identical-failures suspension goes blind.
function say(message) {
  process.stdout.write(`WORKLOOP_CRITERION: ${message}\n`);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
} catch (error) {
  say(`package.json unreadable: ${error.code ?? "parse failed"}`);
  process.exit(INDETERMINATE);
}

const unwired = WIRED_SCRIPTS.filter((name) => !String(pkg.scripts?.[name] ?? "").includes(SUITE));
if (unwired.length) {
  say(`adversarial suite is not wired into npm scripts: ${unwired.join(", ")}`);
  process.exit(UNSATISFIED);
}

const suite = spawnSync("npm", ["test"], { encoding: "utf8", timeout: 100_000, maxBuffer: 10 * 1024 * 1024 });
if (suite.error) {
  say(`npm test could not run: ${suite.error.code ?? suite.error.message}`);
  process.exit(INDETERMINATE);
}
if (suite.status === 0) {
  say("npm test green with the adversarial suite wired in");
  process.exit(SATISFIED);
}

// The spec reporter prints `✖ <name> (1.23ms)`; the duration is per-run noise.
const output = `${suite.stdout}\n${suite.stderr}`;
const failed = [...output.matchAll(/^\s*✖\s+(.+?)\s*\(\d+(?:\.\d+)?ms\)\s*$/gm)].map((match) => match[1].trim());
const names = [...new Set(failed)].sort();
say(names.length ? `npm test failing: ${names.join("; ")}` : "npm test failed without a parsable failure list");
process.exit(UNSATISFIED);
