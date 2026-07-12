// Internal taskloop module. Its public seam is the export list at the end.

import path from "node:path";

const STATE_DIR = ".taskloop";

const TASK_FILE = "task.json";

const LEDGER_DIR = ".taskloop";

const LEDGER_FILE = "outcomes-v2.jsonl";

const TASK_SCHEMA_VERSION = 2;

const LEDGER_EVENT_SCHEMA_VERSION = 2;

const RUNTIME_CONTRACT = 3;

const DEFAULT_ROUNDS = 8;

const STUCK_REPEATS = 3;

const CRITERION_TIMEOUT_SECONDS = 120;

const TOUCHED_FILES_CAP = 50;

const VALID_SUSPEND_OUTCOMES = new Set(["needs_input", "stuck", "out_of_budget"]);

const OBSERVATION_VERDICTS = new Set(["unsatisfied", "satisfied", "indeterminate"]);

const TERMINAL_OUTCOMES = new Set(["achieved", "not_needed", "abandoned"]);
// The independence ladder, weakest → strongest. A review's value comes from
// how independent the reviewer's failure modes are from the author's:
// self-reread shares everything; fresh-context washes session-state
// contamination (optimism, sunk cost, tunnel vision) but not model-level blind
// spots; second-model washes those too (uncorrelated weights). The engine
// records which level a task got — provenance, not a verdict — so the outcome
// ledger makes "closed without independent review" visible; it never gates
// `done` on it (a review is a probabilistic signal fed back into the loop
// body, not an objective criterion).

const REVIEW_LEVELS = ["self_reread", "fresh_context", "second_model"];

// ---------- small helpers ----------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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

function outputTail(text, limit = 2000) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > limit ? "..." + trimmed.slice(-limit) : trimmed;
}

function localTimestamp(when = new Date()) {
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function artifactTimestamp(when = new Date()) {
  return localTimestamp(when).replaceAll("-", "").replace(" ", "-").replaceAll(":", "");
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

export {
  STATE_DIR,
  TASK_FILE,
  LEDGER_DIR,
  LEDGER_FILE,
  TASK_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA_VERSION,
  RUNTIME_CONTRACT,
  DEFAULT_ROUNDS,
  STUCK_REPEATS,
  CRITERION_TIMEOUT_SECONDS,
  TOUCHED_FILES_CAP,
  VALID_SUSPEND_OUTCOMES,
  OBSERVATION_VERDICTS,
  TERMINAL_OUTCOMES,
  REVIEW_LEVELS,
  isPlainObject,
  fnv1aHex,
  outputTail,
  localTimestamp,
  artifactTimestamp,
  repoRelative,
  globToRegExp,
};
