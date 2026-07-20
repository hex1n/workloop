#!/usr/bin/env node
// Acceptance adapter for the advisory-fix follow-up (2026-07-19): the three
// advisory findings from the smell-batch fresh-context review, resolved with
// behavior guarded by the full suite. Read-only.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SATISFIED = 4;
const UNSATISFIED = 3;
const INDETERMINATE = 2;

function say(message) {
  process.stdout.write(`WORKLOOP_CRITERION: ${message}\n`);
}

let criterion; let install; let app;
try {
  criterion = fs.readFileSync("lib/criterion.mjs", "utf8");
  install = fs.readFileSync("install.mjs", "utf8");
  app = fs.readFileSync("lib/application.mjs", "utf8");
} catch (error) {
  say(`sources unreadable: ${error.code ?? "read failed"}`);
  process.exit(INDETERMINATE);
}

const probes = {
  // Advisory 1: stat-identity reuse only for files quiescent before the run,
  // so coarse-timestamp filesystems cannot hide a same-tick in-place rewrite.
  "snapshot-quiescence": () => criterion.includes("SNAPSHOT_REUSE_GRACE_MS"),
  // Advisory 2: the install lock keeps its original 25ms backoff cadence as
  // explicit site policy instead of inheriting the shared 5ms default.
  "install-backoff": () => install.includes("directoryLockBackoff(25)"),
  // Advisory 3: the corrupt-authority wrapper carries the failing field as
  // error.field only, never appended into the message text.
  "field-not-in-message": () => !app.includes("(at ${cause.field})") && app.includes("failure.field = cause.field"),
};

const failing = Object.entries(probes).filter(([, probe]) => {
  try { return !probe(); } catch { return true; }
}).map(([id]) => id).sort();
if (failing.length) {
  say(`structural probes failing: ${failing.join(", ")}`);
  process.exit(UNSATISFIED);
}

const suite = spawnSync("npm", ["test"], { encoding: "utf8", timeout: 240_000, maxBuffer: 10 * 1024 * 1024 });
if (suite.error) {
  say(`npm test could not run: ${suite.error.code ?? suite.error.message}`);
  process.exit(INDETERMINATE);
}
if (suite.status === 0) {
  say("advisory fixes hold and npm test is green");
  process.exit(SATISFIED);
}
const output = `${suite.stdout}\n${suite.stderr}`;
const failed = [...output.matchAll(/^\s*✖\s+(.+?)\s*\(\d+(?:\.\d+)?ms\)\s*$/gm)].map((match) => match[1].trim());
const names = [...new Set(failed)].sort();
say(names.length ? `npm test failing: ${names.join("; ")}` : "npm test failed without a parsable failure list");
process.exit(UNSATISFIED);
