#!/usr/bin/env node
// Acceptance adapter for the two-axis reviewer discipline (2026-07-20): the
// shared reviewer posture moves into loop-core and gains a two-axis frame —
// the spec axis (criterion/rubric) produces the blocking findings that gate,
// the standards axis produces advisory findings only. workloop and
// judgmentloop reference it instead of restating the posture. Read-only.
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
const core = read("skills/loop-core/REFERENCE.md");
const workloop = read("skills/workloop/SKILL.md");
const judgmentloop = read("skills/judgmentloop/SKILL.md");
if ([core, workloop, judgmentloop].some((text) => text === null)) {
  say("sources unreadable");
  process.exit(INDETERMINATE);
}

const probes = {
  // loop-core now carries the shared reviewer posture and the two-axis frame.
  "core-posture": () => core.includes("read-only from a fresh context") && core.includes("review receipt"),
  "core-two-axis": () => core.includes("two axes") && core.includes("spec axis") && core.includes("standards axis"),
  // Criterion anchoring preserved: only the spec axis gates; standards is advisory.
  "core-anchoring": () => core.includes("gate acceptance") && core.includes("advisory") && core.includes("never blocking"),
  // Both loops reference the shared discipline rather than restating it.
  "workloop-references": () => workloop.includes("two-axis") && workloop.includes("loop-core/REFERENCE.md"),
  "judgmentloop-references": () => judgmentloop.includes("two-axis") && judgmentloop.includes("loop-core/REFERENCE.md"),
  // Dedup: the posture paragraph no longer lives verbatim in workloop.
  "posture-deduped": () => !workloop.includes("Reviewers work read-only from a fresh context"),
};

const failing = Object.entries(probes).filter(([, probe]) => {
  try { return !probe(); } catch { return true; }
}).map(([id]) => id).sort();
if (failing.length) {
  say(`structural probes failing: ${failing.join(", ")}`);
  process.exit(UNSATISFIED);
}

const npmTest = spawnSync("npm", ["test"], { encoding: "utf8", timeout: 240_000, maxBuffer: 10 * 1024 * 1024 });
if (npmTest.error) {
  say(`npm test could not run: ${npmTest.error.code ?? npmTest.error.message}`);
  process.exit(INDETERMINATE);
}
if (npmTest.status === 0) {
  say("two-axis reviewer discipline holds and npm test is green");
  process.exit(SATISFIED);
}
const output = `${npmTest.stdout}\n${npmTest.stderr}`;
const failed = [...output.matchAll(/^\s*✖\s+(.+?)\s*\(\d+(?:\.\d+)?ms\)\s*$/gm)].map((match) => match[1].trim());
const names = [...new Set(failed)].sort();
say(names.length ? `npm test failing: ${names.join("; ")}` : "npm test failed without a parsable failure list");
process.exit(UNSATISFIED);
