// Internal taskloop module. Its public seam is the export list at the end.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { STATE_DIR, TASK_FILE, globToRegExp, isPlainObject, repoRelative } from "./prims.mjs";

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

function commandSyntaxOnly(command) {
  const kept = [];
  let heredocDelimiter = null;
  let patchBody = false;
  for (const line of String(command).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (heredocDelimiter) {
      if (trimmed === heredocDelimiter) heredocDelimiter = null;
      continue;
    }
    if (patchBody) {
      if (trimmed === "*** End Patch") patchBody = false;
      continue;
    }
    if (trimmed === "*** Begin Patch") {
      patchBody = true;
      continue;
    }
    kept.push(line);
    const heredoc = line.match(/<<(?!<)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))/);
    if (heredoc) heredocDelimiter = heredoc[1] ?? heredoc[2] ?? heredoc[3];
  }
  return kept.join("\n");
}

function redirectTargets(command) {
  const targets = [];
  const syntax = commandSyntaxOnly(command);
  let quote = null;
  for (let i = 0; i < syntax.length; i += 1) {
    const char = syntax[i];
    if (quote) {
      if (char === quote && syntax[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    if (syntax[i + 1] === ">") i += 1;
    let cursor = i + 1;
    while (/\s/.test(syntax[cursor] ?? "")) cursor += 1;
    if (syntax[cursor] === "&") {
      cursor += 1;
      if (/[\d-]/.test(syntax[cursor] ?? "")) {
        while (/\d/.test(syntax[cursor] ?? "")) cursor += 1;
        if (syntax[cursor] === "-") cursor += 1;
        i = cursor - 1;
        continue;
      }
      while (/\s/.test(syntax[cursor] ?? "")) cursor += 1;
    }
    let target = "";
    if (syntax[cursor] === '"' || syntax[cursor] === "'") {
      const targetQuote = syntax[cursor++];
      while (cursor < syntax.length && syntax[cursor] !== targetQuote) target += syntax[cursor++];
      i = cursor;
    } else {
      while (cursor < syntax.length && !/[\s|&;<>]/.test(syntax[cursor])) target += syntax[cursor++];
      i = cursor - 1;
    }
    if (!target || target.startsWith("/dev/") || /^NUL$/i.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

const GIT_WRITE_RE = /\bgit\s+(push|commit|add|reset|restore|checkout|clean|merge|rebase)\b/gi;

function gitOps(mapping) {
  const ops = new Set();
  for (const command of commandValues(mapping)) {
    for (const m of command.matchAll(GIT_WRITE_RE)) ops.add(m[1].toLowerCase());
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
  const hasGrant = (kind) => (task.grants ?? []).some((grant) => grant?.kind === kind);
  if (/\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node)\b/i.test(command) && !(env.network && env.destructive)) {
    return "remote-exec (download | shell) requires explicit network and destructive grants";
  }
  if (!env.network && /\b(curl|wget|Invoke-WebRequest)\b/i.test(command)) {
    return "network command requires an explicit network grant";
  }
  if (!hasGrant("install") && (/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/i.test(command) || /\bpip3?\s+install\b/i.test(command))) {
    return "package install requires an explicit install grant";
  }
  if (/(^|[\s;&|(])(printenv|env)(\s*$|\s*\|)/.test(command) || /\b(cat|less|more|head|tail)\b[^|;&]*(\.env\b|id_rsa|id_ed25519|\.pem\b|credentials)/i.test(command)) {
    return "environment/secret dump is denied by default";
  }
  if (
    !env.destructive &&
    (/\brm\s+(-\S*[rf]|--(recursive|force|dir))/i.test(command) ||
      /\bfind\b[^|]*\s-delete\b/i.test(command) ||
      /\bgit\s+clean\b/i.test(command) ||
      /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i.test(command))
  ) {
    return "destructive command requires an explicit destructive grant";
  }
  return null;
}

function looksLikeWrite(tool, mapping) {
  const compact = String(tool ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.includes("write") || compact.includes("edit") || compact.includes("patch") || compact === "notebookedit") {
    return true;
  }
  if (patchFileTargets(mapping).length) return true;
  for (const command of commandValues(mapping)) {
    if (redirectTargets(command).length) return true;
    const syntax = stripQuotedSegments(commandSyntaxOnly(command));
    if (/(\b(rm|mv|cp|mkdir|touch|sed\s+-i|tee)\b|\*\*\* (?:Add|Update|Delete) File:)/i.test(syntax)) return true;
    if (/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i.test(syntax)) return true;
  }
  return false;
}

// apply_patch packs many files into one call; without reading the patch body
// the envelope (and the untracked nudge) would be blind to every one of them —
// the exact tool shape of the observed multi-file-landing incident.

function patchFileTargets(mapping) {
  const targets = [];
  for (const value of Object.values(mapping ?? {})) {
    if (typeof value !== "string" || !value.includes("*** ")) continue;
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    let m;
    while ((m = re.exec(value)) !== null) targets.push(m[1].trim());
  }
  return targets;
}

function writeFileTargets(tool, mapping) {
  const targets = [...fileFieldValues(mapping), ...patchFileTargets(mapping)];
  for (const command of commandValues(mapping)) targets.push(...redirectTargets(command));
  return [...new Set(targets)];
}

// minimatch-lite: * (segment), ** (any depth), ? (one char)

function insideEnvelope(rel, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(rel));
}

// The envelope matches each glob literally (globToRegExp treats a comma as an
// ordinary character), so "src/**,tests/**" is one pattern that matches nothing
// real — a silently toothless envelope. Reject it at the door and point at the
// repeat-the-flag form instead.

function joinedFileOffender(files) {
  return files.find((f) => /[,;]/.test(String(f))) ?? null;
}

function joinedFilesMessage(offender) {
  const delimiter = String(offender).includes(";") ? "semicolon" : "comma";
  return (
    `--files "${offender}" contains a ${delimiter}: the envelope matches each glob literally, ` +
    `so a ${delimiter}-joined string matches no real file. Repeat --files for each glob instead.`
  );
}

// A birth snapshot: were any envelope files already dirty when the task opened?
// It never gates — it rides the ledger so an audit can tell a from-clean open
// (the criterion earns its unsatisfied witness) from one layered onto pre-existing edits (the
// "wrote first, opened after" pattern the review flagged). Git absent or this
// not being a repo degrades to false; the snapshot is telemetry, never a trap.

function envelopeDirty(repo, files) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      const rel = line.slice(3).trim();
      if (!rel) continue;
      if (insideEnvelope(rel.replace(/\\/g, "/"), files)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function currentRepoFiles(repo) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, "/"));
  } catch {
    const files = [];
    const walk = (dir, prefix = "") => {
      if (files.length >= 10_000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === STATE_DIR) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    walk(repo);
    return files;
  }
}

function warnZeroMatchEnvelope(repo, patterns, sink = process.stderr) {
  if (!patterns.length) return;
  const files = currentRepoFiles(repo);
  for (const pattern of patterns) {
    if (files.some((file) => globToRegExp(pattern).test(file))) continue;
    sink.write(
      `warning: envelope pattern "${pattern}" matches no current files; ` +
        "kept as a pre-grant for future files, but verify the spelling\n",
    );
  }
}

function stripQuotedSegments(command) {
  return String(command).replace(/"[^"]*"|'[^']*'/g, " ");
}

// --- cross-worktree envelope overlap (advisory, fail-open) ---
// Parallel work uses separate worktrees, but nothing stops two of them declaring
// overlapping envelopes; the conflict then surfaces only at merge. These read
// the sibling worktrees' authoritative task.json (not the ledger, which can be
// holed by a split HOME) to move that discovery left to open/amend time. Purely
// advisory: a write boundary overlap is a merge-conflict early warning, not a
// gate — whether and how to merge is the integrator's judgment.

// The literal prefix before the first glob metacharacter — a character prefix,
// not a directory segment, matching globToRegExp's semantics.
function globStaticPrefix(pattern) {
  const s = String(pattern);
  const at = s.search(/[*?[]/);
  return at === -1 ? s : s.slice(0, at);
}

// The literal tail after the last wildcard (a constrained suffix like ".js").
function globStaticSuffix(pattern) {
  const s = String(pattern);
  const at = Math.max(s.lastIndexOf("*"), s.lastIndexOf("?"));
  return at === -1 ? "" : s.slice(at + 1);
}

// Could two globs match a common path? Cheap superset test: their static
// prefixes must be compatible, and if BOTH constrain a literal suffix, one must
// be a suffix of the other — so src/*.js vs src/*.md (js/md) is rejected, while
// lib/** vs lib/*.md (one unconstrained) and a/b* vs a/bc* (both unconstrained)
// stay possible. An over-approximation by design: it is the "potential" level.
function patternsMayOverlap(a, b) {
  const pa = globStaticPrefix(a);
  const pb = globStaticPrefix(b);
  if (!(pa.startsWith(pb) || pb.startsWith(pa))) return false;
  const sa = globStaticSuffix(a);
  const sb = globStaticSuffix(b);
  if (sa && sb && !sa.endsWith(sb) && !sb.endsWith(sa)) return false;
  return true;
}

// Two levels, to keep the signal honest and reduce alert fatigue:
//   definite  — a file present in BOTH worktrees matches both envelopes;
//   potential — only the prefix/suffix heuristic says they could co-match.
// Returns { level, patterns } naming the new-envelope patterns involved, or null.
// `otherPath` is the sibling worktree root: a definite candidate must still
// exist there (checkouts diverge — a file here may be deleted in the sibling).
// A file unique to the sibling is missed by currentRepoFiles(repo) and degrades
// to the potential heuristic — acceptable for an advisory.
function envelopeOverlap(newPatterns, otherPatterns, repo, otherPath) {
  const news = (newPatterns ?? []).map(String).filter(Boolean);
  const others = (otherPatterns ?? []).map(String).filter(Boolean);
  if (!news.length || !others.length) return null;
  const definite = new Set();
  for (const file of currentRepoFiles(repo)) {
    if (!insideEnvelope(file, others)) continue;
    if (otherPath && !fs.existsSync(path.join(otherPath, file))) continue;
    for (const p of news) if (globToRegExp(p).test(file)) definite.add(p);
  }
  if (definite.size) return { level: "definite", patterns: [...definite] };
  const potential = new Set();
  for (const p of news) {
    if (others.some((o) => patternsMayOverlap(p, o))) potential.add(p);
  }
  return potential.size ? { level: "potential", patterns: [...potential] } : null;
}

// Open tasks in every OTHER worktree of this repo. `git worktree list` is the
// exact index of siblings; each carries its own authoritative task.json.
// Both active and suspended tasks still own their write envelope.
function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function siblingWorktreeOpenTasks(repo) {
  const self = realPath(repo);
  let out;
  try {
    // -z keeps paths with newlines intact; fields are NUL-separated.
    out = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const tasks = [];
  for (const field of out.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const wt = field.slice("worktree ".length);
    // realpath so an aliased/symlinked path to this same worktree is skipped.
    if (!wt || realPath(wt) === self) continue;
    try {
      const task = JSON.parse(fs.readFileSync(path.join(wt, STATE_DIR, TASK_FILE), "utf8"));
      if (isPlainObject(task) && new Set(["active", "suspended"]).has(task.lifecycle?.state)) {
        tasks.push({
          path: wt,
          goal: String(task.goal ?? ""),
          files: Array.isArray(task.envelope?.files) ? task.envelope.files : [],
          // Staleness context for the human to judge — never an auto "inactive"
          // verdict: when the task opened, and whether it is paused.
          opened_at: task.created_at ?? null,
          suspended: task.lifecycle.state === "suspended" ? (task.lifecycle.reason ?? "suspended") : null,
        });
      }
    } catch {
      /* no task or unreadable in that worktree: skip */
    }
  }
  return tasks;
}

export {
  commandValues,
  gitOps,
  commandSafetyFailure,
  looksLikeWrite,
  writeFileTargets,
  insideEnvelope,
  joinedFileOffender,
  joinedFilesMessage,
  envelopeDirty,
  warnZeroMatchEnvelope,
  envelopeOverlap,
  siblingWorktreeOpenTasks,
};
