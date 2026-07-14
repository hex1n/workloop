import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CRITERION_TIMEOUT_SECONDS, STATE_DIR, fnv1aHex, globToRegExp, outputTail, sha256Hex, utcTimestamp } from "./prims.mjs";

const WINDOWS_CMD_BUILTINS = new Set([
  "assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo", "endlocal", "erase", "exit",
  "for", "ftype", "goto", "help", "if", "md", "mkdir", "mklink", "move", "path", "pause", "popd", "prompt", "pushd", "rd", "rem",
  "ren", "rename", "rmdir", "set", "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
]);

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

function repoSnapshot(repo) {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repo, encoding: "utf8", env: spawnEnv(), timeout: 10000,
  });
  if (listed.status !== 0) return { hash: null, files: [] };
  const files = String(listed.stdout).split(/\r?\n/).filter(Boolean)
    .filter((file) => file !== STATE_DIR && !file.startsWith(`${STATE_DIR}/`)).sort();
  const entries = [];
  for (const file of files) {
    try {
      const stat = fs.lstatSync(path.resolve(repo, file));
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      entries.push(`${file}\0${fnv1aHex(fs.readFileSync(path.resolve(repo, file), "latin1"))}`);
    } catch {
      entries.push(`${file}\0missing`);
    }
  }
  return { hash: fnv1aHex(entries.join("\n")), files, entries };
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
    if (exitCode === 0) verdict = "satisfied";
    else if (exitCode === 1) verdict = "unsatisfied";
    else if (exitCode === 2) { verdict = "indeterminate"; error = "adapter_indeterminate"; }
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

function runCriterionSource(source, repo, timeoutSeconds = CRITERION_TIMEOUT_SECONDS, protocol = "binary") {
  const before = repoSnapshot(repo);
  const started = Date.now();
  let result;
  if (source.kind === "file") {
    const absolute = path.resolve(repo, source.value);
    const args = /\.(?:cjs|mjs|js)$/i.test(source.value) ? [absolute] : [];
    const executable = args.length ? process.execPath : absolute;
    result = spawnSync(executable, args, { cwd: repo, encoding: "utf8", env: spawnEnv(), timeout: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024 });
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
    result.taskloop_shell = shell;
  }
  result.duration_ms = Date.now() - started;
  const mapped = mapExecution(result, protocol, timeoutSeconds, { shell: Boolean(result.taskloop_shell), platform: process.platform });
  const after = repoSnapshot(repo);
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
  if (!absolute.startsWith(path.resolve(repo) + path.sep) || !fs.statSync(absolute).isFile()) throw new Error(`criterion file not found: ${value}`);
  return value;
}

function resolveSubject(repo, raw) {
  const value = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!value || /[*?\[\]]/.test(value) || path.posix.isAbsolute(value) || value.startsWith("../") || value === STATE_DIR || value.startsWith(`${STATE_DIR}/`)) throw new Error(`invalid criterion subject: ${value}`);
  const absolute = path.resolve(repo, value);
  if (!absolute.startsWith(path.resolve(repo) + path.sep)) throw new Error(`criterion subject escapes repository: ${value}`);
  return value;
}

function criterionMetadata({ source, protocol, timeoutSeconds, subjects = [], repo }) {
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
  changedSnapshotPaths,
  expandWindowsGlobs,
  criterionDrift,
  criterionMetadata,
  mapExecution,
  repoSnapshot,
  resolveCriterionFile,
  resolveSubject,
  runCriterionSource,
};
