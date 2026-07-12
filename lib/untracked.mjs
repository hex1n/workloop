import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { STATE_DIR, isPlainObject, localTimestamp, repoRelative } from "./prims.mjs";

const UNTRACKED_FILE = "untracked-writes.json";
const UNTRACKED_TTL_MS = 24 * 60 * 60 * 1000;
const foldCase =
  process.platform === "win32" || process.platform === "darwin" ? (value) => value.toLowerCase() : (value) => value;

function untrackedPath(repo) {
  return path.join(repo, STATE_DIR, UNTRACKED_FILE);
}

function clearUntracked(repo) {
  try {
    fs.rmSync(untrackedPath(repo), { force: true });
  } catch {
    /* best-effort: a stale slate only re-nudges */
  }
}

function loadUntracked(repo) {
  try {
    const parsed = JSON.parse(fs.readFileSync(untrackedPath(repo), "utf8"));
    if (isPlainObject(parsed) && isPlainObject(parsed.sessions)) return parsed;
  } catch {
    /* missing or corrupt scratch is an empty slate */
  }
  return { sessions: {} };
}

function repoInsideRelative(repo, raw) {
  const rel = repoRelative(repo, raw);
  if (!rel) return null;
  const root = path.resolve(String(repo));
  const abs = path.resolve(root, String(raw).replace(/\\/g, "/"));
  return abs.startsWith(root + path.sep) ? rel : null;
}

function observeUntracked({ payload, sessionId = null, foreign = false, repo, writeShaped, writeTargets, scriptPath, now = Date.now() }) {
  if (!writeShaped) return { kind: "allow" };
  const sessionRaw = sessionId ?? payload.session_id;
  const session = typeof sessionRaw === "string" && sessionRaw.trim() ? sessionRaw : null;
  const state = loadUntracked(repo);
  for (const [sid, bucket] of Object.entries(state.sessions)) {
    if (!isPlainObject(bucket) || !(now - Date.parse(bucket.ts ?? "") < UNTRACKED_TTL_MS)) {
      delete state.sessions[sid];
    }
  }
  // A prior entry must have materialized on disk to keep counting: an allowed
  // write lands before the next PreToolUse, so an entry with no file behind it
  // is a misattribution (a cd'd relative redirect folded against payload cwd,
  // or a denied call) — poison, not evidence. Cost of the prune: parallel
  // single-target calls that spread files before any write lands each read as
  // first-file notices; a false deny costs more than a missed nudge.
  const prior = session ? (state.sessions[session]?.files ?? []) : [];
  const known = new Set(prior.filter((rel) => fs.existsSync(path.join(repo, rel))));
  const inside = [];
  for (const raw of writeTargets) {
    // An unexpanded $VAR target cannot be resolved client-side; recording its
    // literal fold would attribute a guess (observed: $VAR/../x collapsing
    // into a repo-inside path it never touches).
    if (String(raw).includes("$")) continue;
    const rel = repoInsideRelative(repo, raw);
    if (rel) {
      const folded = foldCase(rel);
      known.add(folded);
      inside.push(folded);
    }
  }
  const files = [...known].sort();
  if (session) {
    state.sessions[session] = { files, ts: localTimestamp(now) };
    try {
      fs.mkdirSync(path.join(repo, STATE_DIR), { recursive: true });
      fs.writeFileSync(untrackedPath(repo), JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch {
      /* the nudge must never break the tool call */
    }
  }
  const openTemplate = foreign
    ? "  parallel work: use a separate worktree; to continue this task: taskloop join --reason \"<handoff reason>\""
    :
    `  node "${scriptPath}" open --repo "${repo}" --goal "<one line>" ` +
    '--criterion "<executable done-when check>" --criterion-policy default ' +
    '--alignment-because "<what the check exercises>" --not-covered "<gap>" --files "<glob>"';
  // Gate only calls that put an attributable target inside this repo: the
  // stated contract keeps outside-repo writes and target-less write shapes
  // (sed -i and kin) at a nudge, never a deny — even once the gate is armed.
  if (session && inside.length && files.length >= 2) {
    return {
      kind: "deny",
      message:
        `taskloop: untracked multi-file work this session (${files.join(", ")}). ` +
        (foreign ? "Parallel work belongs in a separate worktree; continuing this task requires join:\n" : "The lightweight default covers a single-file tweak; wider work opens a task first:\n") +
        openTemplate,
    };
  }
  return {
    kind: "notice",
    message:
      (foreign ? "taskloop: foreign session write outside the task envelope; use a separate worktree for parallel work or join to continue this task:\n" : "taskloop: no open task — single-file so far; if this is landing wider work, open a task before the next file:\n") +
      openTemplate,
  };
}

export { clearUntracked, observeUntracked };
