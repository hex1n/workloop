#!/usr/bin/env node
// taskloop — clean-room implementation of the task-first loop engineering
// design (docs/plans/2026-07-06-loop-v2-task-first.md). Parallel to, and
// fully independent of, the v1 agent-loop machinery: own state dir
// (.taskloop/), own outcome ledger (~/.taskloop/), no shared code.
//
// Object model: the TASK is the durable unit (goal, criterion, alignment,
// envelope, budgets, evidence); EPISODES come and go underneath it. Budgets
// live on the task and are never refilled by starting a new episode.
// Success has exactly one path: a fresh green criterion. Suspension is a
// normal intermediate state; only a human closes a task any other way
// (abandon --reason, not-needed --evidence).
//
// Trust model: collaborative fail-open supervisor. The hard guarantee is
// narrow and stated: with a healthy environment and untouched state files,
// a red criterion cannot close a task as done. Nothing here resists a
// deliberately evasive agent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, execSync } from "node:child_process";
import { parseArgs } from "node:util";

const STATE_DIR = ".taskloop";
const TASK_FILE = "task.json";
const LEDGER_DIR = ".taskloop";
const LEDGER_FILE = "outcomes.jsonl";
const DEFAULT_ROUNDS = 8;
const STUCK_REPEATS = 3;
const CRITERION_TIMEOUT_SECONDS = 120;
const TOUCHED_FILES_CAP = 50;
const VALID_SUSPEND_OUTCOMES = new Set(["needs_input", "stuck", "out_of_budget"]);

// ---------- small helpers ----------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function fnv1aHex(input) {
  const s = String(input ?? "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function home() {
  return path.resolve(process.env.USERPROFILE || process.env.HOME || os.homedir());
}

function taskPath(repo) {
  return path.join(repo, STATE_DIR, TASK_FILE);
}

function loadTask(repo) {
  try {
    const parsed = JSON.parse(fs.readFileSync(taskPath(repo), "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveTask(repo, task) {
  const dir = path.join(repo, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(taskPath(repo), JSON.stringify(task, null, 2) + "\n", "utf8");
}

function appendLedger(repo, task, extra = {}) {
  try {
    const dir = path.join(home(), LEDGER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const row = {
      ts: utcNow(),
      repo: String(repo),
      state: task.state,
      goal: task.goal ?? null,
      criterion: task.criterion ?? null,
      rounds: task.spent?.rounds ?? 0,
      writes: task.evidence?.writes ?? 0,
      episodes: Array.isArray(task.episodes) ? task.episodes.length : 0,
      criterion_input_drift: Boolean(task.evidence?.criterion_input_drift),
      criterion_input_coverage: task.criterion_input_coverage ?? "full",
      ...extra,
    };
    fs.appendFileSync(path.join(dir, LEDGER_FILE), JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* the ledger is telemetry: degrade, never trap */
  }
}

function cliError(message) {
  process.stderr.write(message + "\n");
  return 2;
}

// ---------- criterion: the only sensor ----------

function hasShellSyntax(command) {
  return /[|&;<>$`*?()[\]{}"'\\]/.test(String(command ?? ""));
}

function runCriterion(criterion, repo, timeoutSec = CRITERION_TIMEOUT_SECONDS) {
  const opts = {
    cwd: repo,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  };
  const simple = !hasShellSyntax(criterion);
  try {
    const stdout = simple
      ? execFileSync(String(criterion).trim().split(/\s+/)[0], String(criterion).trim().split(/\s+/).slice(1), opts)
      : execSync(criterion, opts);
    return { verdict: "pass", exit: 0, output: String(stdout ?? "") };
  } catch (err) {
    const output = String(err.stdout ?? "") + String(err.stderr ?? "");
    if (err.signal || err.code === "ETIMEDOUT") {
      return { verdict: "fail", exit: null, output, detail: `timed out after ${timeoutSec}s` };
    }
    const status = typeof err.status === "number" ? err.status : null;
    if (status === null || status === 126 || status === 127) {
      return { verdict: "not_executable", exit: status, output, detail: `cannot execute (exit ${status ?? "spawn error"})` };
    }
    return { verdict: "fail", exit: status, output };
  }
}

function outputTail(text, limit = 2000) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > limit ? "..." + trimmed.slice(-limit) : trimmed;
}

function repoRelative(repo, raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const root = path.resolve(String(repo));
  const abs = path.resolve(root, s.replace(/\\/g, "/"));
  if (abs === root) return null;
  if (abs.startsWith(root + path.sep)) return abs.slice(root.length + 1).replace(/\\/g, "/");
  return s;
}

// Expand one criterion token to the repo files it names. A literal path
// resolves to itself; a single-directory glob (docs/check*.cjs) is read from
// its directory. A multi-level glob (docs/**/c.cjs) or a glob in the directory
// part cannot be enumerated cheaply and returns partial=true so the caller can
// record honest coverage instead of a false all-clear.
function expandCriterionToken(token, root) {
  const rel = token.replace(/\\/g, "/");
  if (!/[*?]/.test(rel)) {
    const abs = path.resolve(root, rel);
    if (abs !== root && abs.startsWith(root + path.sep)) {
      try {
        if (fs.statSync(abs).isFile()) return { files: [abs.slice(root.length + 1).replace(/\\/g, "/")], partial: false };
      } catch {
        /* not a file: nothing to fingerprint */
      }
    }
    return { files: [], partial: false };
  }
  const slash = rel.lastIndexOf("/");
  const dir = slash === -1 ? "" : rel.slice(0, slash);
  const base = slash === -1 ? rel : rel.slice(slash + 1);
  if (/[*?]/.test(dir)) return { files: [], partial: true }; // glob in the directory part: not enumerable here
  const absDir = path.resolve(root, dir);
  if (absDir !== root && !absDir.startsWith(root + path.sep)) return { files: [], partial: true };
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { files: [], partial: true };
  }
  const re = globToRegExp(base);
  const files = [];
  for (const ent of entries) {
    if (ent.isFile() && re.test(ent.name)) files.push((dir ? dir + "/" : "") + ent.name);
  }
  return { files, partial: false };
}

// Path-shaped tokens in the criterion that resolve to repo files: the check's
// own inputs, fingerprinted so a check weakened mid-task is visible at green.
// Glob-referenced checks are expanded (not skipped) so the drift flag cannot be
// dodged by a one-character rename; anything that cannot be enumerated marks
// the coverage partial rather than reading as a false all-clear.
function criterionInputs(criterion, repo) {
  const root = path.resolve(String(repo));
  const inputs = [];
  const seen = new Set();
  let partial = false;
  for (const rawToken of String(criterion ?? "").split(/[\s"'();|&<>]+/)) {
    const token = rawToken.replace(/^--?[\w-]+=/, "");
    if (!token || token.startsWith("-") || !/[\\/.]/.test(token)) continue;
    const { files, partial: tokenPartial } = expandCriterionToken(token, root);
    if (tokenPartial) partial = true;
    for (const rel of files) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      try {
        inputs.push({ path: rel, hash: fnv1aHex(fs.readFileSync(path.resolve(root, rel), "latin1")) });
      } catch {
        /* unreadable input: skip */
      }
    }
  }
  return { inputs, partial };
}

function criterionInputDrift(task, repo) {
  const changed = [];
  for (const entry of Array.isArray(task.criterion_inputs) ? task.criterion_inputs : []) {
    if (!isPlainObject(entry) || !entry.path) continue;
    let current;
    try {
      current = fnv1aHex(fs.readFileSync(path.resolve(String(repo), String(entry.path)), "latin1"));
    } catch {
      current = "missing";
    }
    if (current !== String(entry.hash ?? "")) {
      changed.push(String(entry.path));
      entry.hash = current;
    }
  }
  return changed;
}

// ---------- payload classification ----------

function loadStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function commandValues(mapping) {
  const values = [];
  for (const key of ["command", "cmd", "script"]) {
    const v = mapping?.[key];
    if (typeof v === "string" && v.trim()) values.push(v);
  }
  return values;
}

function fileFieldValues(mapping) {
  const values = [];
  for (const key of ["file_path", "path", "target_file", "filename"]) {
    const v = mapping?.[key];
    if (typeof v === "string" && v.trim()) values.push(v);
  }
  return values;
}

function redirectTargets(command) {
  const targets = [];
  const re = />>?\s*([^\s|&;<>]+)/g;
  let m;
  while ((m = re.exec(String(command))) !== null) {
    if (!m[1].startsWith("/dev/")) targets.push(m[1]);
  }
  return targets;
}

const GIT_WRITE_RE = /\bgit\s+(push|commit|add|reset|restore|checkout|clean|merge|rebase)\b/gi;

function gitOps(mapping) {
  const ops = new Set();
  for (const command of commandValues(mapping)) {
    let m;
    GIT_WRITE_RE.lastIndex = 0;
    while ((m = GIT_WRITE_RE.exec(command)) !== null) ops.add(m[1].toLowerCase());
  }
  return [...ops];
}

// Command-level safety, evaluated on EVERY command-bearing call before the
// write-shaped short-circuit: remote-exec, network, install, secret-dump, and
// destructive commands are dangerous whether or not they touch a tracked file.
// Conservative by design (a shell can always obscure intent via variables) and
// collaborative — it raises the cost of the obvious dangerous forms, it is not
// a sandbox. Reads and verification runs match none of these.
function commandSafetyFailure(task, command) {
  const env = task.envelope;
  if (/\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node)\b/i.test(command)) {
    return "remote-exec (download | shell) is denied; it needs explicit user intent and envelope.network_allowed";
  }
  if (!env.network_allowed && /\b(curl|wget|Invoke-WebRequest)\b/i.test(command)) {
    return "network command requires envelope.network_allowed";
  }
  if (!env.install_scripts_allowed && (/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/i.test(command) || /\bpip3?\s+install\b/i.test(command))) {
    return "package install requires envelope.install_scripts_allowed";
  }
  if (/(^|[\s;&|(])(printenv|env)(\s*$|\s*\|)/.test(command) || /\b(cat|less|more|head|tail)\b[^|;&]*(\.env\b|id_rsa|id_ed25519|\.pem\b|credentials)/i.test(command)) {
    return "environment/secret dump is denied by default";
  }
  if (
    !env.destructive_allowed &&
    (/\brm\s+(-\S*[rf]|--(recursive|force|dir))/i.test(command) ||
      /\bfind\b[^|]*\s-delete\b/i.test(command) ||
      /\bgit\s+clean\b/i.test(command) ||
      /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i.test(command))
  ) {
    return "destructive command requires envelope.destructive_allowed (user-approved)";
  }
  return null;
}

function looksLikeWrite(tool, mapping) {
  const compact = String(tool ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.includes("write") || compact.includes("edit") || compact.includes("patch") || compact === "notebookedit") {
    return true;
  }
  for (const command of commandValues(mapping)) {
    if (/(>|>>|\b(rm|mv|cp|mkdir|touch|sed\s+-i|tee)\b|\*\*\* (?:Add|Update|Delete) File:)/i.test(command)) return true;
    if (/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i.test(command)) return true;
  }
  return false;
}

function writeFileTargets(tool, mapping) {
  const targets = [...fileFieldValues(mapping)];
  for (const command of commandValues(mapping)) targets.push(...redirectTargets(command));
  return [...new Set(targets)];
}

// minimatch-lite: * (segment), ** (any depth), ? (one char)
function globToRegExp(pattern) {
  let out = "^";
  const p = String(pattern).replace(/\\/g, "/");
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (p[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$");
}

function insideEnvelope(rel, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(rel));
}

// ---------- episodes ----------

function activeEpisode(task) {
  const episodes = Array.isArray(task.episodes) ? task.episodes : [];
  const last = episodes.at(-1);
  return last && !last.closed_at ? last : null;
}

function closeEpisode(task, outcome) {
  const episode = activeEpisode(task);
  if (!episode) return null;
  episode.closed_at = utcNow();
  episode.outcome = outcome;
  return episode;
}

function ensureEpisode(task, session) {
  const sid = String(session ?? "").trim() || "unknown";
  let episode = activeEpisode(task);
  if (episode && episode.session !== sid) {
    // Single-writer default: a different session supersedes the previous
    // episode rather than sharing it. The machine snapshot half persists on
    // the task either way.
    closeEpisode(task, "detached");
    episode = null;
  }
  if (episode) return { episode, resumed: false };
  if (!Array.isArray(task.episodes)) task.episodes = [];
  const resumed = task.episodes.length > 0;
  episode = { id: task.episodes.length + 1, session: sid, opened_at: utcNow() };
  task.episodes.push(episode);
  return { episode, resumed };
}

function touchedSummary(task, limit = 10) {
  const touched = Array.isArray(task.evidence?.touched_files) ? task.evidence.touched_files : [];
  if (!touched.length) return "none";
  const shown = touched.slice(0, limit).join(", ");
  const extra = touched.length > limit ? `, +${touched.length - limit} more` : "";
  return `(${touched.length}): ${shown}${extra}`;
}

function resumeBanner(task) {
  const prev = (task.episodes ?? []).at(-2);
  return (
    `taskloop: resuming episode ${task.episodes.length}` +
    (prev?.outcome ? ` (previous: ${prev.outcome})` : "") +
    `; snapshot: ${task.snapshot?.judgment ?? "none recorded"}` +
    `; machine-observed changed files ${touchedSummary(task)}\n`
  );
}

// ---------- deny/block responses ----------

function deny(message) {
  process.stdout.write(
    JSON.stringify({ decision: "deny", permissionDecision: "deny", reason: message, message }) + "\n",
  );
  process.stderr.write(message + "\n");
  return 2;
}

function block(message) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: message }) + "\n");
  process.stderr.write(message + "\n");
  return 2;
}

// ---------- verbs ----------

const CLI_OPTIONS = {
  open: {
    repo: { type: "string" },
    goal: { type: "string" },
    criterion: { type: "string" },
    alignment: { type: "string" },
    progress: { type: "string" },
    files: { type: "string", multiple: true },
    tables: { type: "string", multiple: true },
    interfaces: { type: "string", multiple: true },
    "git-allowed": { type: "string", multiple: true },
    "git-reason": { type: "string" },
    rounds: { type: "string", default: String(DEFAULT_ROUNDS) },
    writes: { type: "string", default: "0" },
    "wall-clock-minutes": { type: "string", default: "0" },
    "criterion-timeout-seconds": { type: "string", default: String(CRITERION_TIMEOUT_SECONDS) },
    "destructive-allowed": { type: "boolean", default: false },
    "network-allowed": { type: "boolean", default: false },
    "install-scripts-allowed": { type: "boolean", default: false },
    "keep-green": { type: "boolean", default: false },
    reason: { type: "string" },
    force: { type: "boolean", default: false },
  },
  status: { repo: { type: "string" } },
  verify: { repo: { type: "string" } },
  amend: {
    repo: { type: "string" },
    criterion: { type: "string" },
    files: { type: "string", multiple: true },
    rounds: { type: "string" },
    reason: { type: "string" },
  },
  suspend: {
    repo: { type: "string" },
    outcome: { type: "string", default: "needs_input" },
    judgment: { type: "string" },
  },
  done: { repo: { type: "string" } },
  abandon: { repo: { type: "string" }, reason: { type: "string" } },
  "not-needed": { repo: { type: "string" }, evidence: { type: "string" } },
  hooks: { repo: { type: "string" } },
};

function repoFromArg(value) {
  const raw = String(value ?? process.cwd()).trim() || process.cwd();
  const expanded = raw.startsWith("~") ? path.join(home(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

function cmdOpen(values) {
  const repo = repoFromArg(values.repo);
  for (const [flag, label] of [
    ["goal", "--goal"],
    ["criterion", "--criterion"],
    ["alignment", "--alignment"],
  ]) {
    if (!String(values[flag] ?? "").trim()) {
      return cliError(
        `${label} is required` +
          (flag === "alignment"
            ? ': "green ⇒ goal because <what the check exercises>; not covered: <gaps>"'
            : ""),
      );
    }
  }
  const files = (values.files ?? []).map(String).filter(Boolean);
  if (!files.length) return cliError("--files is required: the envelope needs at least one glob");
  if ((values["git-allowed"] ?? []).length && !String(values["git-reason"] ?? "").trim()) {
    return cliError("--git-reason is required when --git-allowed is used");
  }
  if (values["keep-green"] && !String(values.reason ?? "").trim()) {
    return cliError("--keep-green requires --reason <why a green start is intentional>");
  }
  const existing = loadTask(repo);
  if (existing && existing.state === "open" && !values.force) {
    return cliError(
      `${taskPath(repo)} already holds an open task; suspend/done/abandon it, or --force to archive and replace`,
    );
  }
  if (existing) {
    try {
      const archive = path.join(repo, STATE_DIR, "history");
      fs.mkdirSync(archive, { recursive: true });
      fs.writeFileSync(
        path.join(archive, `task-${utcNow().replace(/[:]/g, "")}.json`),
        JSON.stringify(existing, null, 2) + "\n",
        "utf8",
      );
    } catch {
      /* archiving is best-effort */
    }
  }

  const criterion = String(values.criterion).trim();
  const timeoutSec = Number.parseInt(String(values["criterion-timeout-seconds"]), 10) || CRITERION_TIMEOUT_SECONDS;
  const verdict = runCriterion(criterion, repo, timeoutSec);
  if (verdict.verdict === "not_executable") {
    process.stderr.write(
      `open refused: the machine cannot execute the criterion (${verdict.detail}): ${criterion}\n` +
        "a criterion the machine cannot run leaves the task gateless; fix the command and retry\n",
    );
    return 1;
  }
  if (verdict.verdict === "pass" && !values["keep-green"]) {
    process.stderr.write(
      `open refused: the criterion is already green: ${criterion}\n` +
        "red is earned at birth — an already-green criterion cannot prove this task. " +
        "Fix the criterion, or pass --keep-green --reason for an intentional regression-guard task.\n",
    );
    return 1;
  }

  const task = {
    version: 1,
    state: "open",
    goal: String(values.goal).trim(),
    criterion,
    criterion_hash: fnv1aHex(criterion),
    ...(() => {
      const { inputs, partial } = criterionInputs(criterion, repo);
      return { criterion_inputs: inputs, criterion_input_coverage: partial ? "partial" : "full" };
    })(),
    criterion_timeout_seconds: timeoutSec,
    alignment: String(values.alignment).trim(),
    progress: String(values.progress ?? "").trim() || null,
    envelope: {
      files,
      tables: (values.tables ?? []).map(String),
      interfaces: (values.interfaces ?? []).map(String),
      git: {
        allowed_ops: (values["git-allowed"] ?? []).map((op) => String(op).toLowerCase()),
        reason: String(values["git-reason"] ?? "").trim(),
      },
      destructive_allowed: Boolean(values["destructive-allowed"]),
      network_allowed: Boolean(values["network-allowed"]),
      install_scripts_allowed: Boolean(values["install-scripts-allowed"]),
    },
    budget: {
      rounds: Number.parseInt(String(values.rounds), 10) || DEFAULT_ROUNDS,
      writes: Number.parseInt(String(values.writes), 10) || 0,
      wall_clock_minutes: Number.parseInt(String(values["wall-clock-minutes"]), 10) || 0,
    },
    spent: { rounds: 0, opened_at: utcNow() },
    evidence: { writes: 0, touched_files: [], criterion_input_drift: false },
    stall: { signature: null, count: 0, history: [] },
    snapshot: { judgment: null },
    episodes: [],
    amendments: [],
  };
  saveTask(repo, task);
  process.stdout.write(`opened ${taskPath(repo)} (budget: ${task.budget.rounds} rounds)\n`);
  return 0;
}

function requireOpenTask(repo) {
  const task = loadTask(repo);
  if (!task) {
    process.stderr.write(`${taskPath(repo)} does not exist; open a task first\n`);
    return null;
  }
  if (task.state !== "open") {
    process.stderr.write(`${taskPath(repo)} is already ${task.state}; open a new task\n`);
    return null;
  }
  return task;
}

function warnOnInputDrift(task, repo, sink = process.stderr) {
  const drift = criterionInputDrift(task, repo);
  if (drift.length) {
    task.evidence.criterion_input_drift = true;
    sink.write(
      `warning: criterion input files changed since open: ${drift.join(", ")} — ` +
        "a green from an edited check needs a recorded reason (amend --criterion --reason)\n",
    );
  }
  return drift;
}

function cmdDone(values) {
  const repo = repoFromArg(values.repo);
  const task = requireOpenTask(repo);
  if (!task) return 1;
  const verdict = runCriterion(task.criterion, repo, task.criterion_timeout_seconds);
  if (verdict.verdict === "fail") {
    // Metered like a blocked stop: a refused done burns a round, so retrying
    // `done` against a flaky criterion cannot fish for a false green for free.
    task.spent.rounds += 1;
    saveTask(repo, task);
    const overBudget = task.spent.rounds >= task.budget.rounds;
    const tail = outputTail(verdict.output);
    process.stderr.write(
      `done refused: the criterion is red (round ${task.spent.rounds}/${task.budget.rounds}): ${task.criterion}\n` +
        (tail ? `--- criterion output (tail) ---\n${tail}\n` : "") +
        (overBudget
          ? "round budget spent — suspend --judgment or amend --rounds --reason; do not retry done.\n"
          : "there is no claim-based success; fix the work, amend the criterion with a reason, " +
            "or suspend/abandon honestly.\n"),
    );
    return 1;
  }
  if (verdict.verdict === "not_executable") {
    process.stderr.write(
      `done refused: the machine cannot execute the criterion (${verdict.detail}); ` +
        "amend the criterion so green is provable, or abandon --reason.\n",
    );
    return 1;
  }
  warnOnInputDrift(task, repo);
  closeEpisode(task, "green");
  task.state = "done";
  task.closed_at = utcNow();
  saveTask(repo, task);
  appendLedger(repo, task);
  process.stdout.write(`done: criterion green (${task.spent.rounds} rounds, ${task.episodes.length} episodes)\n`);
  return 0;
}

function cmdSuspend(values) {
  const repo = repoFromArg(values.repo);
  const task = requireOpenTask(repo);
  if (!task) return 1;
  const outcome = String(values.outcome ?? "needs_input").trim();
  if (!VALID_SUSPEND_OUTCOMES.has(outcome)) {
    return cliError(`--outcome must be one of ${[...VALID_SUSPEND_OUTCOMES].sort().join(", ")}`);
  }
  const judgment = String(values.judgment ?? "").trim();
  if (!judgment) {
    return cliError(
      '--judgment is required: "<remaining criterion; current failure; next safe action>" ' +
        "(changed files are machine-observed)",
    );
  }
  task.snapshot = { judgment, at: utcNow() };
  closeEpisode(task, outcome);
  saveTask(repo, task);
  process.stdout.write(
    `suspended (${outcome}); machine-observed changed files ${touchedSummary(task)}; task stays open\n`,
  );
  return 0;
}

function cmdAbandon(values) {
  const repo = repoFromArg(values.repo);
  const task = requireOpenTask(repo);
  if (!task) return 1;
  const reason = String(values.reason ?? "").trim();
  if (!reason) return cliError("--reason is required: an abandoned task must say why");
  closeEpisode(task, "detached");
  task.state = "abandoned";
  task.closed_at = utcNow();
  task.outcome_reason = reason;
  saveTask(repo, task);
  appendLedger(repo, task, { reason });
  process.stdout.write("abandoned; recorded in the outcome ledger\n");
  return 0;
}

function cmdNotNeeded(values) {
  const repo = repoFromArg(values.repo);
  const task = requireOpenTask(repo);
  if (!task) return 1;
  const evidence = String(values.evidence ?? "").trim();
  if (!evidence) {
    return cliError("--evidence is required: name the read-only check that showed no work is needed");
  }
  closeEpisode(task, "green");
  task.state = "not_needed";
  task.closed_at = utcNow();
  task.outcome_reason = evidence;
  saveTask(repo, task);
  appendLedger(repo, task, { evidence });
  process.stdout.write("closed as not-needed; recorded in the outcome ledger\n");
  return 0;
}

function cmdAmend(values) {
  const repo = repoFromArg(values.repo);
  const task = requireOpenTask(repo);
  if (!task) return 1;
  const reason = String(values.reason ?? "").trim();
  if (!reason) return cliError("--reason is required: every goalpost or budget move carries its why");
  const next = String(values.criterion ?? "").trim();
  const addFiles = (values.files ?? []).map(String).filter(Boolean);
  const rounds = String(values.rounds ?? "").trim();
  if (!next && !addFiles.length && !rounds) {
    return cliError("amend requires --criterion, --files, and/or --rounds");
  }
  const amendment = { at: utcNow(), reason };
  if (next) {
    amendment.criterion = { from_hash: task.criterion_hash, to: next };
    task.criterion = next;
    task.criterion_hash = fnv1aHex(next);
    const refp = criterionInputs(next, repo);
    task.criterion_inputs = refp.inputs;
    task.criterion_input_coverage = refp.partial ? "partial" : "full";
    task.stall = { signature: null, count: 0, history: [] };
  }
  if (addFiles.length) {
    amendment.files_added = addFiles;
    task.envelope.files = [...new Set([...task.envelope.files, ...addFiles])];
  }
  if (rounds) {
    amendment.rounds = { from: task.budget.rounds, to: Number.parseInt(rounds, 10) || task.budget.rounds };
    task.budget.rounds = amendment.rounds.to;
  }
  task.amendments.push(amendment);
  saveTask(repo, task);
  process.stdout.write("amended; the move and its reason are recorded on the task\n");
  return 0;
}

function cmdStatus(values) {
  const repo = repoFromArg(values.repo);
  const task = loadTask(repo);
  if (!task) {
    process.stdout.write("no task\n");
    return 0;
  }
  process.stdout.write(
    `state=${task.state} rounds=${task.spent?.rounds ?? 0}/${task.budget?.rounds ?? "?"} ` +
      `writes=${task.evidence?.writes ?? 0} episodes=${(task.episodes ?? []).length} ` +
      `goal=${task.goal}\n` +
      `criterion=${task.criterion}\n` +
      `alignment=${task.alignment}\n` +
      `snapshot=${task.snapshot?.judgment ?? "none"}\n` +
      `touched=${touchedSummary(task)}\n`,
  );
  return 0;
}

function cmdVerify(values) {
  const repo = repoFromArg(values.repo);
  const task = loadTask(repo);
  if (!task) {
    process.stderr.write("no task\n");
    return 2;
  }
  const verdict = runCriterion(task.criterion, repo, task.criterion_timeout_seconds);
  process.stdout.write(`${verdict.verdict}\n`);
  if (verdict.verdict === "pass") return 0;
  return verdict.verdict === "fail" ? 1 : 2;
}

// ---------- hooks: the supervisor ----------

function repoFromPayload(payload) {
  const cwd = String(payload.cwd ?? process.cwd());
  // Walk up looking for an existing .taskloop/ so hooks work from subdirs.
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, STATE_DIR, TASK_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

function hookPretool(payload, repo, task) {
  const tool = String(payload.tool_name ?? "");
  const mapping = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const { resumed } = ensureEpisode(task, payload.session_id);
  if (resumed) process.stderr.write(resumeBanner(task));

  const ops = gitOps(mapping);
  const deniedGit = ops.filter((op) => !task.envelope.git.allowed_ops.includes(op));
  if (deniedGit.length) {
    saveTask(repo, task);
    return deny(
      `taskloop: git operation(s) need envelope authorization: ${deniedGit.join(", ")}. ` +
        "Re-open or amend the task with --git-allowed <op> --git-reason <why> after the user asks for it.",
    );
  }

  // Safety runs on every command-bearing call, ahead of the write-shaped
  // short-circuit: a pipe-to-shell or an env dump is dangerous even though it
  // touches no tracked file. This is the fix for the audit's leak where
  // `curl | sh` slipped past because it was not "write-shaped".
  for (const command of commandValues(mapping)) {
    const failure = commandSafetyFailure(task, command);
    if (failure) {
      saveTask(repo, task);
      return deny(`taskloop: ${failure}`);
    }
  }

  const writeShaped = ops.length > 0 || looksLikeWrite(tool, mapping);
  if (!writeShaped) {
    // Reads and verification commands are never blocked and never counted:
    // an over-budget task can always still verify, suspend, or close.
    saveTask(repo, task);
    return 0;
  }

  const targets = writeFileTargets(tool, mapping);
  for (const raw of targets) {
    const rel = repoRelative(repo, raw);
    if (rel && !insideEnvelope(rel, task.envelope.files)) {
      saveTask(repo, task);
      return deny(
        `taskloop: write outside the envelope: ${rel}. Narrow the call, or if it belongs to the goal:\n` +
          `  node "${process.argv[1] ?? "taskloop.mjs"}" amend --repo "${repo}" --files "<glob>" --reason "<why>"`,
      );
    }
  }

  const budget = task.budget;
  if (budget.writes > 0 && task.evidence.writes >= budget.writes) {
    saveTask(repo, task);
    return deny(
      `taskloop: write budget exhausted (${task.evidence.writes}/${budget.writes}). ` +
        "Verification still runs: verify and stop, suspend --judgment, or amend --rounds/--reason.",
    );
  }
  if (budget.wall_clock_minutes > 0) {
    const started = Date.parse(String(task.spent.opened_at ?? ""));
    if (Number.isFinite(started) && (Date.now() - started) / 60000 > budget.wall_clock_minutes) {
      saveTask(repo, task);
      return deny(
        `taskloop: wall-clock budget exhausted (max ${budget.wall_clock_minutes}m). ` +
          "Verification still runs: verify and stop, suspend --judgment, or abandon --reason.",
      );
    }
  }

  task.evidence.writes += 1;
  for (const raw of targets) {
    const rel = repoRelative(repo, raw);
    if (!rel || task.evidence.touched_files.includes(rel)) continue;
    if (task.evidence.touched_files.length >= TOUCHED_FILES_CAP) break;
    task.evidence.touched_files.push(rel);
  }
  saveTask(repo, task);
  return 0;
}

function suspendByMachine(repo, task, outcome, note) {
  closeEpisode(task, outcome);
  saveTask(repo, task);
  process.stderr.write(
    `taskloop: ${note}; machine-observed changed files ${touchedSummary(task)}; ` +
      "the task stays open — resume by continuing (rounds are task-level), " +
      'or close it honestly: abandon --reason / amend --rounds --reason\n',
  );
  return 0;
}

function hookStop(payload, repo, task) {
  const { resumed } = ensureEpisode(task, payload.session_id);
  if (resumed) process.stderr.write(resumeBanner(task));

  const verdict = runCriterion(task.criterion, repo, task.criterion_timeout_seconds);
  if (verdict.verdict === "pass") {
    warnOnInputDrift(task, repo);
    closeEpisode(task, "green");
    task.state = "done";
    task.closed_at = utcNow();
    saveTask(repo, task);
    appendLedger(repo, task);
    process.stderr.write(
      `taskloop: criterion green — task done (${task.spent.rounds} rounds, ${task.episodes.length} episodes)\n`,
    );
    return 0;
  }
  if (verdict.verdict === "not_executable") {
    saveTask(repo, task);
    process.stderr.write(
      `taskloop: criterion cannot run (${verdict.detail}); releasing the stop — fix the criterion via amend\n`,
    );
    return 0;
  }

  task.spent.rounds += 1;
  const tail = outputTail(verdict.output);
  const signature = fnv1aHex(`${verdict.exit}|${tail}`);
  if (task.stall.signature === signature) task.stall.count += 1;
  else {
    task.stall.signature = signature;
    task.stall.count = 1;
  }
  task.stall.history.push(signature);
  while (task.stall.history.length > 2 * STUCK_REPEATS + 2) task.stall.history.shift();
  const window = task.stall.history.slice(-2 * STUCK_REPEATS);
  const alternating =
    window.length === 2 * STUCK_REPEATS &&
    window[0] !== window[1] &&
    window.every((sig, i) => sig === window[i % 2]);

  if (task.stall.count >= STUCK_REPEATS || alternating) {
    return suspendByMachine(
      repo,
      task,
      "stuck",
      alternating
        ? "two failure signatures alternating — fix A breaks B, fix B breaks A; suspended as stuck"
        : `same failure ${task.stall.count} stops in a row; suspended as stuck`,
    );
  }
  if (task.spent.rounds >= task.budget.rounds) {
    const distinct = new Set(task.stall.history).size;
    const moving = task.stall.history.length >= 2 && distinct === task.stall.history.length;
    return suspendByMachine(
      repo,
      task,
      "out_of_budget",
      `round budget spent (${task.spent.rounds}/${task.budget.rounds})` +
        (moving
          ? " — every round failed differently, the task was still moving; amend --rounds --reason to continue"
          : ""),
    );
  }

  saveTask(repo, task);
  return block(
    `taskloop: criterion red (round ${task.spent.rounds}/${task.budget.rounds}): ${task.criterion}\n` +
      (tail ? `--- criterion output (tail) ---\n${tail}\n` : "") +
      "Fix and re-verify. If the criterion is wrong: amend --criterion --reason. " +
      "If input is missing: suspend --outcome needs_input --judgment \"<remaining; failure; next>\".",
  );
}

// Paste-ready hook wiring for dogfooding. Safe alongside the v1 agent-loop
// hooks: each supervisor is inert in a repo without its own state dir
// (.taskloop/ here, .agent-loop/ there), so both can stay registered.
function cmdHooks() {
  const script = path.resolve(process.argv[1] ?? "taskloop.mjs");
  const command = `node "${script}"`;
  process.stdout.write(
    "# taskloop hook wiring — coexists with the agent-loop v1 hooks (each is\n" +
      "# inert without its own state dir; no repo triggers both by accident).\n\n" +
      '# Claude Code — merge into the "hooks" object of ~/.claude/settings.json:\n' +
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*",
                hooks: [{ type: "command", command, timeout: 20 }],
              },
            ],
            Stop: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 300 }] }],
          },
        },
        null,
        2,
      ) +
      "\n\n# Codex — append to ~/.codex/config.toml:\n" +
      [
        "[[hooks.PreToolUse]]",
        'matcher = ".*"',
        "",
        "[[hooks.PreToolUse.hooks]]",
        'type = "command"',
        `command = ${JSON.stringify(command)}`,
        "timeout = 20",
        'statusMessage = "Checking taskloop envelope"',
        "",
        "[[hooks.Stop]]",
        'matcher = ".*"',
        "",
        "[[hooks.Stop.hooks]]",
        'type = "command"',
        `command = ${JSON.stringify(command)}`,
        "timeout = 300",
        'statusMessage = "Checking taskloop stop gate"',
      ].join("\n") +
      "\n",
  );
  return 0;
}

// ---------- main ----------

function cmdHelp() {
  process.stdout.write(
    "taskloop.mjs — task-first loop supervisor (clean-room v2)\n\n" +
      "open a task (copy, fill in, run):\n" +
      '  node taskloop.mjs open --repo <repo> --goal "<one line>" \\\n' +
      '    --criterion "<executable check, red until done>" \\\n' +
      '    --alignment "green ⇒ goal because <...>; not covered: <...>" \\\n' +
      '    --files "<glob>" [--rounds 8] [--writes N] [--wall-clock-minutes M]\n\n' +
      "verbs:\n" +
      "  status | verify\n" +
      '  suspend  --outcome needs_input|stuck|out_of_budget --judgment "<remaining; failure; next>"\n' +
      "  done                       # runs the criterion; green is the only path\n" +
      '  abandon  --reason "<why>"\n' +
      '  not-needed --evidence "<read-only check>"\n' +
      '  amend    --criterion/--files/--rounds --reason "<why>"\n\n' +
      "  hooks                      # print paste-ready Claude/Codex hook wiring\n\n" +
      "hooks: pipe the runtime's PreToolUse/Stop JSON payload on stdin.\n" +
      "state: .taskloop/task.json (private, gitignore it); ledger: ~/.taskloop/outcomes.jsonl\n",
  );
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length && ["help", "--help", "-h"].includes(argv[0])) return cmdHelp();
  if (argv.length && Object.hasOwn(CLI_OPTIONS, argv[0])) {
    let values;
    try {
      ({ values } = parseArgs({ args: argv.slice(1), options: CLI_OPTIONS[argv[0]], allowPositionals: false }));
    } catch (err) {
      return cliError(err.message);
    }
    if (argv[0] === "hooks") return cmdHooks();
    if (argv[0] === "open") return cmdOpen(values);
    if (argv[0] === "status") return cmdStatus(values);
    if (argv[0] === "verify") return cmdVerify(values);
    if (argv[0] === "amend") return cmdAmend(values);
    if (argv[0] === "suspend") return cmdSuspend(values);
    if (argv[0] === "done") return cmdDone(values);
    if (argv[0] === "abandon") return cmdAbandon(values);
    return cmdNotNeeded(values);
  }

  const payload = loadStdinJson();
  const event = String(payload.hook_event_name ?? "").toLowerCase();
  const repo = repoFromPayload(payload);
  const task = loadTask(repo);
  if (!task || task.state !== "open") return 0; // fail-open: no task, no supervision
  try {
    if (event === "pretooluse") return hookPretool(payload, repo, task);
    if (event === "stop") return hookStop(payload, repo, task);
  } catch (err) {
    process.stderr.write(`taskloop: supervisor degraded (${err?.message ?? err}); releasing\n`);
    return 0;
  }
  return 0;
}

process.exit(main());
