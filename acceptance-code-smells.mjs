#!/usr/bin/env node
// Acceptance adapter for the 2026-07-19 code-smell batch. Read-only: it greps
// the sources for the structural shape each fix must leave behind, then runs
// the repository suite so behavior-preservation is part of the done-when.
//
// Probe ids are stable and sorted so the failure signature only changes when
// the set of remaining fixes changes, never between identical runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SATISFIED = 4;
const UNSATISFIED = 3;
const INDETERMINATE = 2;

function say(message) {
  process.stdout.write(`WORKLOOP_CRITERION: ${message}\n`);
}

const LIB = [
  "application.mjs", "criterion.mjs", "event-store.mjs", "evidence-ledger.mjs", "host-hooks.mjs",
  "outcome-projector.mjs", "prims.mjs", "supervision.mjs", "task-engine.mjs", "task-store.mjs", "untracked.mjs",
];

let sources;
try {
  sources = Object.fromEntries(LIB.map((name) => [name, fs.readFileSync(path.join("lib", name), "utf8")]));
  sources["install.mjs"] = fs.readFileSync("install.mjs", "utf8");
  sources["AGENTS.md"] = fs.readFileSync("AGENTS.md", "utf8");
} catch (error) {
  say(`sources unreadable: ${error.code ?? "read failed"}`);
  process.exit(INDETERMINATE);
}

const occurrences = (text, needle) => text.split(needle).length - 1;
const libCount = (needle) => LIB.reduce((sum, name) => sum + occurrences(sources[name], needle), 0);
const onlyPrims = (needle) => libCount(needle) === occurrences(sources["prims.mjs"], needle) && occurrences(sources["prims.mjs"], needle) > 0;

const app = sources["application.mjs"];
const engine = sources["task-engine.mjs"];
const store = sources["event-store.mjs"];
const supervision = sources["supervision.mjs"];
const install = sources["install.mjs"];

const probes = {
  // 1: one directory-lock implementation, in prims, with one liveness semantic.
  "lock-dedup": () => onlyPrims(".reaper") && libCount("process.kill(") + occurrences(install, "process.kill(") === occurrences(sources["prims.mjs"], "process.kill("),
  // 4: leaf helpers hoisted into prims instead of re-declared per module.
  "clone-hoist": () => onlyPrims("JSON.parse(JSON.stringify"),
  "digest-hoist": () => onlyPrims("sha256:[0-9a-f]{64}"),
  "uuid-hoist": () => onlyPrims("[89ab][0-9a-f]{3}"),
  "exactkeys-hoist": () => onlyPrims("JSON.stringify(Object.keys"),
  "pathexists-hoist": () => libCount("function pathEntryExists") + occurrences(install, "function pathEntryExists") === occurrences(sources["prims.mjs"], "function pathEntryExists") && occurrences(sources["prims.mjs"], "function pathEntryExists") === 1,
  "foldcase-hoist": () => onlyPrims('"win32" || process.platform === "darwin"'),
  "localtimestamp-install": () => !install.includes("function localTimestamp"),
  // 3: the writeShaped safety predicate has exactly one definition.
  "writeshaped-single": () => app.includes("function writeShapedCall") && occurrences(app, "hasCommandWriteTarget") === 2,
  // 5: source-cursor construction and field list have one home each.
  "sourcecursor-dedup": () => !app.includes("sourceCursorFromCommit") && libCount("SOURCE_CURSOR_FIELDS = [") === 1,
  // 6: budget dimension labels/flags come from one shared map.
  "budget-map": () => sources["prims.mjs"].includes("BUDGET_DIMENSIONS") && engine.includes("BUDGET_DIMENSIONS") && app.includes("BUDGET_DIMENSIONS"),
  // 7: decide/evolve dispatch tables, deduplicated auto-suspend, verb table.
  "engine-dispatch": () => engine.includes("V3_DECIDERS") && engine.includes("V3_REDUCERS"),
  "autosuspend-dedup": () => occurrences(engine, "toISOString() !== command.at") <= 1,
  "verb-table": () => occurrences(app, "if (verb === ") === 0,
  // 2: schema triple-definition documented; descriptor errors name the field.
  "schema-sync-doc": () => sources["AGENTS.md"].includes("PAYLOAD_CONTRACTS"),
  "schema-diagnostics": () => store.includes("function eventStoreError(code, field"),
  // 9: one home-directory resolution.
  "home-unify": () => sources["prims.mjs"].includes("function userHome") && !app.includes("USERPROFILE") && !supervision.includes("os.homedir()") && !sources["outcome-projector.mjs"].includes("USERPROFILE"),
  // 10/11/13: dead assignments, shadowing, and the worst density spots.
  "dead-next": () => occurrences(app, "let next") === 0,
  "shadowing": () => occurrences(app, "catch (error)") === 0 && !app.includes("let authorityError"),
  "density": () => occurrences(app, "recoverTail: true }); if (") === 0,
  // 12/14: the two undocumented tricks now carry explanatory comments.
  "cd-comment": () => supervision.includes("over-matches quoted text"),
  "sql-comment": () => supervision.includes("inert group"),
  // 15: lifecycle rows always carry reason; no post-hoc patching.
  "lifecycle-reason": () => !engine.includes("??= null"),
  // 17: evidence integrity is an explicit parameter, not only a hidden property.
  "evidence-integrity": () => sources["evidence-ledger.mjs"].includes("function foldEvidence(rows, integrity"),
  // 18: repo snapshots reuse unchanged-stat hashes instead of re-reading bytes.
  "snapshot-reuse": () => sources["criterion.mjs"].includes("mtimeNs"),
  // 19: one deep-clone idiom across lib.
  "structuredclone-gone": () => libCount("structuredClone") === 0,
  // 20: the installer's module-level plan log resets at every exported entry.
  "actions-reset": () => occurrences(install, "ACTIONS.length = 0") >= 3,
  // 8: the contract regex explains why it reads the source checkout.
  "contract-comment": () => install.includes("source checkout's contract"),
  // 16: a missing criterion file gets the friendly message, not a raw ENOENT.
  "criterion-msg": () => {
    const probeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-smell-probe-"));
    try {
      return import("./lib/criterion.mjs").then(({ resolveCriterionFile }) => {
        try { resolveCriterionFile(probeRepo, "missing-check.mjs"); return false; }
        catch (error) { return /criterion file not found/.test(String(error?.message)); }
      });
    } finally {
      fs.rmSync(probeRepo, { recursive: true, force: true });
    }
  },
};

const failing = [];
for (const [id, probe] of Object.entries(probes)) {
  let held;
  try { held = await probe(); } catch { held = false; }
  if (!held) failing.push(id);
}
failing.sort();
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
  say("all structural probes hold and npm test is green");
  process.exit(SATISFIED);
}
const output = `${suite.stdout}\n${suite.stderr}`;
const failed = [...output.matchAll(/^\s*✖\s+(.+?)\s*\(\d+(?:\.\d+)?ms\)\s*$/gm)].map((match) => match[1].trim());
const names = [...new Set(failed)].sort();
say(names.length ? `npm test failing: ${names.join("; ")}` : "npm test failed without a parsable failure list");
process.exit(UNSATISFIED);
