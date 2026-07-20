#!/usr/bin/env node
// Acceptance adapter for the loop-improvement batch (2026-07-19): stage 1
// (workloop authoring discipline text, risk-floor evidence capture) and stage 2
// (the cli_verify recorded-observation proposal and its implementation).
// Read-only.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SATISFIED = 4;
const UNSATISFIED = 3;
const INDETERMINATE = 2;

function say(message) {
  process.stdout.write(`WORKLOOP_CRITERION: ${message}\n`);
}

const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};
const skill = read("skills/workloop/SKILL.md");
const calibration = read("docs/decisions/2026-07-16-risk-floor-calibration.md");
const proposal = read("docs/plans/2026-07-19-cli-recorded-observation.md");
const app = read("lib/application.mjs");
const store = read("lib/event-store.mjs");
const engine = read("lib/task-engine.mjs");
const fixture = read("tests/fixtures/runtime-contract-5.mjs");
const suite = read("tests/workloop.test.mjs");
if ([skill, calibration, app, store, engine, fixture, suite].some((text) => text === null)) {
  say("sources unreadable");
  process.exit(INDETERMINATE);
}

const probes = {
  // Stage 1a: probe-design discipline in the workloop skill — behavior-level
  // probes over source-text greps, cheap probes before expensive suites.
  "skill-probe-discipline": () => skill.includes("source-text probes") && skill.includes("failure signature"),
  // Stage 1b: reviewer posture and review receipts in the workloop skill.
  "skill-review-receipt": () => skill.includes("review receipt") && skill.includes("worktree"),
  // Stage 1c: the risk-floor calibration decision gains the observed data point.
  "calibration-datapoint": () => calibration.includes("2026-07-19"),
  // Stage 2a: the interface-change proposal exists and names the new source.
  "proposal-exists": () => proposal !== null && proposal.includes("cli_verify") && proposal.includes("frozen"),
  // Stage 2b: the enum is extended at both schema sites and the frozen fixture.
  "source-enum-extended": () =>
    store.includes("enum:open|stop|achieve|cli_verify") &&
    engine.includes('"cli_verify"') &&
    (fixture.match(/open\|stop\|achieve\|cli_verify/g) ?? []).length >= 2,
  // Stage 2c: verify --record is wired and behaviorally tested.
  "verify-record-wired": () => app.includes('"cli_verify"') && app.includes("record: BOOL"),
  "verify-record-tested": () => suite.includes("verify --record") || suite.includes('"--record"'),
};

const failing = Object.entries(probes).filter(([, probe]) => {
  try { return !probe(); } catch { return true; }
}).map(([id]) => id).sort();
if (failing.length) {
  say(`structural probes failing: ${failing.join(", ")}`);
  process.exit(UNSATISFIED);
}

const run = spawnSync("npm", ["test"], { encoding: "utf8", timeout: 240_000, maxBuffer: 10 * 1024 * 1024 });
if (run.error) {
  say(`npm test could not run: ${run.error.code ?? run.error.message}`);
  process.exit(INDETERMINATE);
}
if (run.status === 0) {
  say("loop-improvement batch holds and npm test is green");
  process.exit(SATISFIED);
}
const output = `${run.stdout}\n${run.stderr}`;
const failed = [...output.matchAll(/^\s*✖\s+(.+?)\s*\(\d+(?:\.\d+)?ms\)\s*$/gm)].map((match) => match[1].trim());
const names = [...new Set(failed)].sort();
say(names.length ? `npm test failing: ${names.join("; ")}` : "npm test failed without a parsable failure list");
process.exit(UNSATISFIED);
