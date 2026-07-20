#!/usr/bin/env node
// Acceptance adapter for the terminal-write-sets ledger query (2026-07-19):
// `ledger --json` exposes each terminal task's outcome, close time, and
// non-synthetic write set so an attended meta-loop review can join landed
// work against repository history after close. Read-only against this
// repository; the behavioral fixture lives in the OS temp area.
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

const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
};
const skill = read("skills/meta-loop/SKILL.md");
const agents = read("AGENTS.md");
const suite = read("tests/workloop.test.mjs");
if ([skill, agents, suite].some((text) => text === null)) {
  say("sources unreadable");
  process.exit(INDETERMINATE);
}

const CLI = path.resolve("bin", "workloop.mjs");

// Behavioral seam: drive the source CLI in a temp fixture — a terminal task
// must project one query row with the documented shape, and corrupt authority
// must degrade the query to "unknown" rather than an empty list.
function ledgerProbe() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-tws-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, TZ: "UTC", HOME: home, USERPROFILE: home, WORKLOOP_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" };
    const git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-q"]);
    fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(1);\n");
    git(["add", "."]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"]);
    const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30_000 });
    const opened = cli(["open", "--repo", repo, "--goal", "probe", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "probe", "--files", "work.txt", "--risk", "routine", "--risk-reason", "temp fixture"]);
    if (opened.status !== 0) return false;
    if (cli(["abandon", "--repo", repo, "--reason", "probe complete"]).status !== 0) return false;
    let payload;
    try { payload = JSON.parse(cli(["ledger", "--json", "--repo", repo]).stdout); } catch { return false; }
    const rows = payload?.queries?.terminal_write_sets;
    if (!Array.isArray(rows) || rows.length !== 1) return false;
    const row = rows[0];
    if (typeof row.task_id !== "string" || row.outcome !== "abandoned") return false;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(String(row.closed_at)) || !Array.isArray(row.files)) return false;
    fs.appendFileSync(path.join(repo, ".workloop", "events.jsonl"), "{broken\n");
    let corrupt;
    try { corrupt = JSON.parse(cli(["ledger", "--json", "--repo", repo]).stdout); } catch { return false; }
    return corrupt?.queries?.terminal_write_sets === "unknown";
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const probes = {
  // The query exists behaviorally: row shape and unknown degradation.
  "ledger-terminal-write-sets": ledgerProbe,
  // The meta-loop skill binds the attended join to the query by name and
  // carries the landing-commit exclusion discipline.
  "skill-join-step": () => skill.includes("terminal_write_sets") && skill.includes("landing"),
  // The convention line makes the query surface a documented interface.
  "agents-convention": () => agents.includes("terminal_write_sets"),
  // The suite prices the file-collection path the fixture cannot reach.
  "suite-covers-query": () => suite.includes("terminal_write_sets"),
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
  say("terminal write sets hold and npm test is green");
  process.exit(SATISFIED);
}
const output = `${npmTest.stdout}\n${npmTest.stderr}`;
const failed = [...output.matchAll(/^\s*✖\s+(.+?)\s*\(\d+(?:\.\d+)?ms\)\s*$/gm)].map((match) => match[1].trim());
const names = [...new Set(failed)].sort();
say(names.length ? `npm test failing: ${names.join("; ")}` : "npm test failed without a parsable failure list");
process.exit(UNSATISFIED);
