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

// Effect-verb shapes announce an external, often irreversible publication
// (tool + publish|deploy|release|push|upload). Matching the announced verb
// rather than an enumerated tool list keeps the class ecosystem-agnostic;
// git push stays with per-operation git authorization, text/shell tools are
// exempt, and word collisions deny recoverably while wrappers stay out of
// lexical reach.
const PUBLISH_VERB_RE = /(^|[;&|(\r\n][ \t]*)([A-Za-z0-9_./-]+)[ \t]+(publish|deploy|release|push|upload)(?=$|[\s;&|)])/gi;
const PUBLISH_MULTIWORD_RE = /(^|[;&|(\r\n][ \t]*)(?:[A-Za-z0-9_./-]*\/)?gh[ \t]+(pr|issue|release)[ \t]+create(?=$|[\s;&|)])/i;
const PUBLISH_EXEMPT_TOOLS = new Set(["git", "echo", "printf", "cat", "grep", "rg", "sed", "awk", "head", "tail", "less", "more", "ls", "man", "which", "find", "test"]);

function publishShape(rawCommand) {
  // Fold shell line continuations first: the shell reassembles `pub\<LF>lish`
  // into one token before execution, so matching must see the folded form.
  const command = String(rawCommand).replace(/\\\r?\n/g, "");
  if (PUBLISH_MULTIWORD_RE.test(command)) return true;
  for (const match of command.matchAll(PUBLISH_VERB_RE)) {
    const tool = match[2].split("/").pop().toLowerCase();
    if (!tool || tool.startsWith("-")) continue;
    if (!PUBLISH_EXEMPT_TOOLS.has(tool)) return true;
  }
  return false;
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
  if (!hasGrant("publish") && publishShape(command)) {
    return "publish-shaped command requires an explicit publish grant";
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
  for (const command of commandValues(mapping)) {
    targets.push(...redirectTargets(command));
    for (const match of command.matchAll(/\bcurl\b[\s\S]*?(?:^|\s)(?:-o\s*|--output(?:=|\s))(?:(?:"([^"]+)"|'([^']+)')|([^\s;&|]+))/g)) targets.push(match[1] ?? match[2] ?? match[3]);
    for (const match of command.matchAll(/\bInvoke-WebRequest\b[\s\S]*?\s-OutFile(?::|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)) targets.push(match[1] ?? match[2] ?? match[3]);
  }
  return [...new Set(targets)];
}

const foldPath = process.platform === "win32" || process.platform === "darwin" ? (value) => value.toLowerCase() : (value) => value;
const pathMeta = /(^~(?:[\\/]|$)|[*?\[\]{}]|\$|`)/;

function canonicalPath(rawPath) {
  let cursor = path.resolve(rawPath); const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(path.basename(cursor)); cursor = parent;
  }
  try { return foldPath(path.join(fs.realpathSync(cursor), ...suffix)); } catch { return null; }
}

function canonicalWriteTarget(repo, raw) {
  const value = String(raw ?? "").trim();
  if (!value || pathMeta.test(value)) return null;
  return canonicalPath(path.isAbsolute(value) ? value : path.resolve(repo, value));
}

function pathInside(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function curlRemoteName(command) {
  return /\bcurl\b/i.test(command) && (/(?:^|\s)-[A-Za-z]*O[A-Za-z]*(?=\s|$)/.test(command) || /--remote-name\b/.test(command));
}

function controlPlaneRoots(repo, home = os.homedir()) {
  const roots = [canonicalPath(path.join(repo, STATE_DIR)), canonicalPath(path.join(repo, ".git")), canonicalPath(path.join(home, STATE_DIR))];
  try {
    const lines = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/);
    roots.push(...lines.map((line) => canonicalPath(line)));
  } catch { /* a non-git directory still has taskloop control roots */ }
  return [...new Set(roots.filter(Boolean))];
}

function controlPlaneWriteFailure(repo, tool, mapping, home = os.homedir()) {
  const commands = commandValues(mapping);
  const writeShaped = looksLikeWrite(tool, mapping) || gitOps(mapping).length > 0 || commands.some((command) => curlRemoteName(command) || writeFileTargets("", { command }).length > 0);
  if (!writeShaped) return null;
  const roots = controlPlaneRoots(repo, home);
  for (const raw of writeFileTargets(tool, mapping)) {
    const text = String(raw).trim();
    const expanded = text === "~" ? home : /^~[\\/]/.test(text) ? path.join(home, text.slice(2)) : text;
    const target = canonicalWriteTarget(repo, expanded);
    if (target && roots.some((root) => pathInside(target, root))) return `direct writes to taskloop/git control state are denied: ${raw}`;
  }
  return null;
}

const READONLY_GIT = new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "describe", "shortlog", "grep"]);

function gitCommandReadonly(command) {
  const segments = String(command).split(/[;&|\n]+/).map((segment) => segment.trim()).filter(Boolean);
  for (const rawSegment of segments) {
    let segment = rawSegment;
    const stripAssignments = () => { segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, ""); };
    stripAssignments();
    if (/^exec\s+/i.test(segment)) { segment = segment.replace(/^exec\s+/i, ""); stripAssignments(); }
    if (/^env\s+/i.test(segment)) { segment = segment.replace(/^env\s+(?:-\S+\s+)*/i, ""); stripAssignments(); }
    if (/^sudo\b/i.test(segment) && /(?:^|\s)(?:[^\s;&|]*\/)?git(?:\s|$)/i.test(segment)) return false;
    const invocation = segment.match(/^(?:(?:sudo)(?:\s+-\S+)*\s+|command\s+)?(?:[^\s;&|]*\/)?git(?:\s+([\s\S]*))?$/i);
    if (!invocation) continue;
    const supported = segment.match(/^(?:command\s+)?(?:[^\s;&|]*\/)?git\s+([\s\S]+)$/i);
    if (!supported) return false;
    const words = supported[1].trim().split(/\s+/); let i = 0;
    while (words[i]?.startsWith("-")) i += 1;
    const sub = words[i]?.toLowerCase();
    if (READONLY_GIT.has(sub)) continue;
    if (sub === "worktree" && words[i + 1]?.toLowerCase() === "list") continue;
    if (sub === "config" && words.slice(i + 1).some((word) => /^(--get(?:-all|-regexp)?|--list|-l)$/.test(word))) continue;
    return false;
  }
  return true;
}

function foreignCommandFailure(command) {
  const value = String(command);
  if (/\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node)\b/i.test(value)) return "foreign session remote-exec is denied; use taskloop join";
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/i.test(value) || /\bpip3?\s+install\b/i.test(value)) return "foreign session package installation is denied; use taskloop join";
  if (/(^|[\s;&|(])(printenv|env)(\s*$|\s*\|)/.test(value) || /\b(cat|less|more|head|tail)\b[^|;&]*(\.env\b|id_rsa|id_ed25519|\.pem\b|credentials)/i.test(value)) return "foreign session secret dump is denied; use taskloop join";
  if (/\brm\s+(-\S*[rf]|--(recursive|force|dir))/i.test(value) || /\bfind\b[^|]*\s-delete\b/i.test(value) || /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i.test(value)) return "foreign session destructive command is denied; use taskloop join";
  if (/\bgit\b/i.test(value) && !gitCommandReadonly(value)) return "foreign session git command is not read-only; use taskloop join";
  if (/\bwget\b/i.test(value) || curlRemoteName(value)) return "foreign session network output is not provably stdout-only; use taskloop join";
  return null;
}

function foreignWriteDecision(repo, task, tool, mapping) {
  const commands = commandValues(mapping);
  for (const command of commands) {
    const failure = foreignCommandFailure(command); if (failure) return { kind: "deny", message: failure };
  }
  const networkOnly = commands.length > 0 && !looksLikeWrite(tool, mapping) && writeFileTargets(tool, mapping).length === 0 && commands.every((command) => /\b(curl|Invoke-WebRequest)\b/i.test(command) && !/\bwget\b/i.test(command) && !curlRemoteName(command));
  if (networkOnly) return { kind: "allow", writeShaped: false, targets: [] };
  const writeShaped = gitOps(mapping).length > 0 || looksLikeWrite(tool, mapping) || commands.some((command) => /\b(curl|wget|Invoke-WebRequest)\b/i.test(command));
  if (!writeShaped) return { kind: "allow", writeShaped: false, targets: [] };
  const targets = writeFileTargets(tool, mapping);
  if (commands.some((command) => /(?:^|[;&|()]\s*)cd\s+[^;&|]+/i.test(command)) && targets.some((target) => !path.isAbsolute(String(target)))) {
    return { kind: "deny", message: "foreign session write target depends on a shell directory change; use taskloop join" };
  }
  const unresolvedCommandWrite = commands.some((command) => {
    const syntax = stripQuotedSegments(commandSyntaxOnly(command));
    return /(\b(rm|mv|cp|mkdir|touch|sed\s+-i|tee)\b|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b)/i.test(syntax);
  });
  const targetlessWrite = looksLikeWrite(tool, mapping) && targets.length === 0;
  if (targetlessWrite || unresolvedCommandWrite) return { kind: "deny", message: "foreign session write target is not provable; use taskloop join" };
  const canonicalRepo = canonicalPath(repo);
  const normalized = targets.map((raw) => ({ raw, absolute: canonicalWriteTarget(repo, raw) }));
  if (normalized.some((row) => !row.absolute)) return { kind: "deny", message: "foreign session write target is not safely resolvable; use taskloop join" };
  for (const row of normalized) {
    if (!canonicalRepo || !pathInside(row.absolute, canonicalRepo)) continue;
    const relative = path.relative(canonicalRepo, row.absolute).replaceAll("\\", "/");
    if (insideEnvelope(relative, task.envelope.files.map((pattern) => foldPath(String(pattern))))) return { kind: "deny", message: `foreign session cannot write inside the task envelope: ${row.raw}; use taskloop join` };
  }
  return { kind: "untracked", writeShaped: true, targets };
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

function sameDirectory(a, b) {
  try {
    const left = fs.statSync(a, { bigint: true });
    const right = fs.statSync(b, { bigint: true });
    if (left.ino !== 0n && right.ino !== 0n) return left.dev === right.dev && left.ino === right.ino;
  } catch {
    /* fall back to normalized path comparison */
  }
  const left = realPath(a); const right = realPath(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function siblingWorktreeOpenTasks(repo) {
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
    // Object identity handles Windows short/long path aliases for the same worktree.
    if (!wt || sameDirectory(wt, repo)) continue;
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
  controlPlaneWriteFailure,
  foreignWriteDecision,
};
