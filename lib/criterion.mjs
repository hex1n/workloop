import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CRITERION_TIMEOUT_SECONDS, STATE_DIR, fnv1aHex, globToRegExp, outputHead, outputTail, sha256Hex, utcTimestamp } from "./prims.mjs";

const WINDOWS_CMD_BUILTINS = new Set([
  "assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo", "endlocal", "erase", "exit",
  "for", "ftype", "goto", "help", "if", "md", "mkdir", "mklink", "move", "path", "pause", "popd", "prompt", "pushd", "rd", "rem",
  "ren", "rename", "rmdir", "set", "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
]);
const CRITERION_MESSAGE_PREFIX = "WORKLOOP_CRITERION: ";

function spawnEnv(platform = process.platform) {
  const env = { ...process.env };
  const floor = [path.dirname(process.execPath)];
  if (platform === "win32") {
    const sysRoot = env.SystemRoot || env.windir || "C:\\Windows";
    floor.push(path.join(sysRoot, "System32"), sysRoot);
    if (!env.COMSPEC) env.COMSPEC = path.join(sysRoot, "System32", "cmd.exe");
  } else floor.push("/usr/local/bin", "/usr/bin", "/bin");
  env.PATH = [env.PATH ?? env.Path ?? "", ...floor].filter(Boolean).join(path.delimiter);
  return env;
}

function hasShellSyntax(command) {
  return /[|&;<>$`*?()[\]{}"'\\]/.test(String(command ?? ""));
}

function expandWindowsGlobs(command, repo) {
  if (/[|&;<>$`()[\]{}"'\\]/.test(String(command ?? ""))) return String(command);
  return String(command).replace(/\S+/g, (token) => {
    if (!/[*?]/.test(token) || token.startsWith("-")) return token;
    const normalized = token.replaceAll("\\", "/");
    const slash = normalized.lastIndexOf("/");
    const directory = slash < 0 ? "" : normalized.slice(0, slash);
    const pattern = slash < 0 ? normalized : normalized.slice(slash + 1);
    if (/[*?]/.test(directory)) return token;
    let entries;
    try { entries = fs.readdirSync(path.resolve(repo, directory), { withFileTypes: true }); }
    catch { return token; }
    const matches = entries.filter((entry) => entry.isFile() && globToRegExp(pattern).test(entry.name)).map((entry) => `${directory ? `${directory}/` : ""}${entry.name}`);
    return matches.length ? matches.map((item) => /\s/.test(item) ? `"${item}"` : item).join(" ") : token;
  });
}

// A stat identity is trusted only for files quiescent since well before the
// snapshot was captured: on coarse-timestamp filesystems (FAT's 2s, older
// ext3/HFS+ seconds) an in-place same-size rewrite during the criterion run
// could land in the same timestamp tick as a modification made just before it.
const SNAPSHOT_REUSE_GRACE_MS = 2000;

function repoSnapshot(repo, previous = null) {
  const capturedAtMs = Date.now();
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repo, encoding: "utf8", env: spawnEnv(), timeout: 10000,
  });
  if (listed.status !== 0) return { hash: null, files: [] };
  const files = String(listed.stdout).split(/\r?\n/).filter(Boolean)
    .filter((file) => file !== STATE_DIR && !file.startsWith(`${STATE_DIR}/`)).sort();
  const previousEntry = new Map((previous?.entries ?? []).map((entry) => [entry.slice(0, entry.indexOf("\0")), entry]));
  const previousStats = previous?.stats ?? new Map();
  const reuseCutoffNs = previous ? BigInt(Math.max(0, (previous.captured_at_ms ?? 0) - SNAPSHOT_REUSE_GRACE_MS)) * 1_000_000n : 0n;
  const entries = [];
  const stats = new Map();
  for (const file of files) {
    const absolute = path.resolve(repo, file);
    try {
      // The bigint stat identity (dev:ino:size:mtimeNs) lets the after-run
      // snapshot reuse the before-run content hash for files whose stat is
      // unchanged, instead of re-reading every byte in the repository twice
      // per criterion run. Reuse requires the file to have been quiescent
      // since before the run began (mtime older than the before-snapshot's
      // capture minus the grace window); a writer that back-dates mtime to
      // hide a side effect is outside this gate's collaborative threat model.
      // Symlinks are always re-read: their lstat identity does not cover the
      // target.
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const key = stat.isSymbolicLink() ? null : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      if (key) stats.set(file, key);
      const quiescent = key !== null && stat.mtimeNs < reuseCutoffNs;
      const reused = quiescent && previousStats.get(file) === key ? previousEntry.get(file) : null;
      entries.push(reused ?? `${file}\0${fnv1aHex(fs.readFileSync(absolute, "latin1"))}`);
    } catch {
      entries.push(`${file}\0missing`);
    }
  }
  return { hash: fnv1aHex(entries.join("\n")), files, entries, stats, captured_at_ms: capturedAtMs };
}

function changedSnapshotPaths(before, after) {
  const a = new Map((before.entries ?? []).map((entry) => [entry.slice(0, entry.indexOf("\0")), entry]));
  const b = new Map((after.entries ?? []).map((entry) => [entry.slice(0, entry.indexOf("\0")), entry]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
}

function executionError(result, { shell = false, platform = process.platform } = {}) {
  if (result.error?.code === "ETIMEDOUT") return "timeout";
  if (result.signal) return `signal:${result.signal}`;
  if (result.error?.code === "ENOENT") return "command_not_found";
  if (result.error?.code === "EACCES" || result.error?.code === "EPERM") return "permission_denied";
  if (result.error) return "spawn_failed";
  if (shell && (result.status === 127 || (platform === "win32" && result.status === 9009))) return "command_not_found";
  if (shell && result.status === 126) return "permission_denied";
  return null;
}

function windowsCommandResolvable(executable, repo, env) {
  if (!/^[A-Za-z0-9._-]+$/.test(executable)) return true;
  if (WINDOWS_CMD_BUILTINS.has(executable.toLowerCase())) return true;
  const options = { cwd: repo, encoding: "utf8", env, timeout: 10_000 };
  return spawnSync("where.exe", [executable], options).status === 0;
}

function mapExecution(result, protocol, timeoutSeconds, options = {}) {
  const exitCode = Number.isInteger(result.status) ? result.status : null;
  let error = executionError(result, options);
  let verdict;
  if (error) verdict = "indeterminate";
  else if (protocol === "tri-state") {
    if (exitCode === 4) verdict = "satisfied";
    else if (exitCode === 3) verdict = "unsatisfied";
    else if (exitCode === 2) { verdict = "indeterminate"; error = "adapter_indeterminate"; }
    else if (exitCode === 0) { verdict = "indeterminate"; error = "adapter_silent"; }
    else { verdict = "indeterminate"; error = "invalid_adapter_exit"; }
  } else verdict = exitCode === 0 ? "satisfied" : "unsatisfied";
  return {
    verdict,
    execution: {
      exit_code: exitCode,
      signal: result.signal ?? null,
      duration_ms: result.duration_ms,
      execution_error: error,
      output_tail: outputTail(String(result.stdout ?? "") + String(result.stderr ?? ""), 4096),
      timeout_seconds: timeoutSeconds,
    },
  };
}

function criterionMessage(stdout, limit = 160) {
  let message = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith(CRITERION_MESSAGE_PREFIX) && line.slice(CRITERION_MESSAGE_PREFIX.length).trim()) message = outputHead(line.slice(CRITERION_MESSAGE_PREFIX.length).trim(), limit);
  }
  return message;
}

function shebangInvocation(file) {
  try {
    const firstLine = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
    const match = firstLine.match(/^#!\s*(\S+)(?:\s+(.+))?$/);
    if (!match) return null;
    return { executable: match[1], args: [...String(match[2] ?? "").trim().split(/\s+/).filter(Boolean), file] };
  } catch { return null; }
}

function criterionFileInvocation(file, platform = process.platform, nodePath = process.execPath) {
  const extension = path.extname(file).toLowerCase();
  if ([".cjs", ".mjs", ".js"].includes(extension)) return { executable: nodePath, args: [file] };
  if (platform === "win32") {
    if (extension === ".cmd" || extension === ".bat") return { executable: "cmd.exe", args: ["/d", "/s", "/c", file] };
    if (extension === ".ps1") return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", file] };
    if (extension === ".sh") throw new Error(`${extension} criterion is not executable on ${platform}`);
    return { executable: file, args: [] };
  }
  if (extension === ".sh") return shebangInvocation(file) ?? { executable: "/bin/sh", args: [file] };
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") throw new Error(`${extension} criterion is not executable on ${platform}`);
  return { executable: file, args: [] };
}

function criterionOutput(stdout, stderr, limit = 4096) {
  const message = criterionMessage(stdout);
  const prefixedMessage = message ? `${CRITERION_MESSAGE_PREFIX}${message}` : null;
  const safeStderr = String(stderr ?? "").split(/\r?\n/).map((line) => line.startsWith(CRITERION_MESSAGE_PREFIX) ? `[stderr] ${line}` : line).join("\n");
  const combined = outputTail(`${String(stdout ?? "")}\n${safeStderr}`, limit);
  if (!prefixedMessage || combined.split(/\r?\n/).includes(prefixedMessage)) return combined;
  const reserved = Buffer.byteLength(prefixedMessage + "\n", "utf8");
  return prefixedMessage + (reserved < limit ? `\n${outputTail(combined, limit - reserved)}` : "");
}

function runCriterionSource(source, repo, timeoutSeconds = CRITERION_TIMEOUT_SECONDS, protocol = "binary") {
  const before = repoSnapshot(repo);
  const started = Date.now();
  let result;
  if (source.kind === "file") {
    const absolute = path.resolve(repo, source.value);
    try {
      const invocation = criterionFileInvocation(absolute);
      result = spawnSync(invocation.executable, invocation.args, { cwd: repo, encoding: "utf8", env: spawnEnv(), timeout: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      result = { status: null, signal: null, error, stdout: "", stderr: String(error.message ?? error) };
    }
  } else {
    const rawCommand = String(source.value).trim();
    const command = process.platform === "win32" ? expandWindowsGlobs(rawCommand, repo) : rawCommand;
    const shell = process.platform === "win32" || hasShellSyntax(command);
    const argv = command.split(/\s+/).filter(Boolean);
    const env = spawnEnv();
    result = shell
      ? spawnSync(command, { cwd: repo, encoding: "utf8", env, shell: true, timeout: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024 })
      : spawnSync(argv[0], argv.slice(1), { cwd: repo, encoding: "utf8", env, timeout: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024 });
    if (process.platform === "win32" && result.status !== 0 && !hasShellSyntax(command) && !windowsCommandResolvable(argv[0] ?? "", repo, env)) {
      result.error = Object.assign(new Error(`command not found: ${argv[0] ?? ""}`), { code: "ENOENT" });
      result.status = null;
    }
    result.workloop_shell = shell;
  }
  result.duration_ms = Date.now() - started;
  const mapped = mapExecution(result, protocol, timeoutSeconds, { shell: Boolean(result.workloop_shell), platform: process.platform });
  mapped.execution.output_tail = criterionOutput(result.stdout, result.stderr, 4096);
  const after = repoSnapshot(repo, before);
  const changed_paths = changedSnapshotPaths(before, after);
  if (changed_paths.length) {
    mapped.verdict = "indeterminate";
    mapped.execution.execution_error = "criterion_side_effect";
  }
  return {
    observation_id: randomUUID(),
    verdict: mapped.verdict,
    criterion_generation_id: null,
    observed_artifact_revision: null,
    observed_at: utcTimestamp(Date.now()),
    execution: mapped.execution,
    changed_paths,
  };
}

function resolveCriterionFile(repo, raw) {
  const value = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!value || path.posix.isAbsolute(value) || value.startsWith("../") || value.includes("/../")) throw new Error("--criterion-file requires a repository-relative file");
  const absolute = path.resolve(repo, value);
  let isFile = false;
  try {
    isFile = fs.statSync(absolute).isFile();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!absolute.startsWith(path.resolve(repo) + path.sep) || !isFile) throw new Error(`criterion file not found: ${value}`);
  return value;
}

function resolveSubject(repo, raw) {
  const value = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!value || /[*?\[\]]/.test(value) || path.posix.isAbsolute(value) || value.startsWith("../") || value === STATE_DIR || value.startsWith(`${STATE_DIR}/`)) throw new Error(`invalid criterion subject: ${value}`);
  const absolute = path.resolve(repo, value);
  if (!absolute.startsWith(path.resolve(repo) + path.sep)) throw new Error(`criterion subject escapes repository: ${value}`);
  return value;
}

function criterionMetadata({ source, protocol, timeoutSeconds, subjects = [], authoredBy = "self", repo }) {
  const declared_inputs = source.kind === "file"
    ? [{ path: source.value, hash: sha256Hex(fs.readFileSync(path.resolve(repo, source.value))) }]
    : [];
  const provenance = source.kind !== "file"
    ? "unresolved"
    : source.value === STATE_DIR || source.value.startsWith(`${STATE_DIR}/`)
      ? "state_dir"
      : "repo";
  return {
    source,
    authored_by: authoredBy,
    protocol,
    timeout_seconds: timeoutSeconds,
    declared_inputs,
    subjects,
    criterion_definition_hash: null,
    criterion_generation_id: randomUUID(),
    criterion_input_fingerprint: declared_inputs.length ? sha256Hex(JSON.stringify(declared_inputs)) : null,
    input_coverage: declared_inputs.length ? "full" : "unknown",
    provenance,
  };
}

function criterionDrift(criterion, repo) {
  const subjects = new Set(criterion.subjects ?? []);
  const changed = [];
  for (const input of criterion.declared_inputs ?? []) {
    if (subjects.has(input.path)) continue;
    let hash = "missing";
    try { hash = sha256Hex(fs.readFileSync(path.resolve(repo, input.path))); } catch { /* missing */ }
    if (hash !== input.hash) changed.push(input.path);
  }
  return changed;
}

export {
  CRITERION_MESSAGE_PREFIX,
  changedSnapshotPaths,
  expandWindowsGlobs,
  criterionDrift,
  criterionFileInvocation,
  criterionMessage,
  criterionMetadata,
  mapExecution,
  repoSnapshot,
  resolveCriterionFile,
  resolveSubject,
  runCriterionSource,
};
