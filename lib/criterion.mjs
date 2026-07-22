import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CRITERION_TIMEOUT_SECONDS, STATE_DIR, artifactCheckpointId, fnv1aHex, globToRegExp, outputHead, outputTail, sha256Hex, utcTimestamp } from "./prims.mjs";

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

function snapshotDeadlineError() {
  return Object.assign(new Error("repository snapshot deadline elapsed"), { code: "ETIMEDOUT" });
}

function assertSnapshotDeadline(deadlineEpochMs, now = Date.now) {
  if (Number.isSafeInteger(deadlineEpochMs) && now() >= deadlineEpochMs) throw snapshotDeadlineError();
}

function repositoryContentFiles(repo, { deadlineEpochMs = null, now = Date.now } = {}) {
  const files = [];
  const visit = (directory, relativeDirectory = "") => {
    assertSnapshotDeadline(deadlineEpochMs, now);
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
    for (const entry of entries) {
      assertSnapshotDeadline(deadlineEpochMs, now);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      // Git metadata and workloop's own control state are not repository
      // inputs. Everything else is included, including ignored files: a
      // criterion can read ignored build/config content just as readily as a
      // tracked source file.
      if (entry.name === ".git" || relative === STATE_DIR || relative.startsWith(`${STATE_DIR}/`)) continue;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile() || stat.isSymbolicLink()) files.push(relative);
    }
  };
  try {
    visit(repo);
    return { files, error: null };
  } catch (error) {
    return { files: [], error };
  }
}

// A stat identity is trusted only for files quiescent since well before the
// snapshot was captured: on coarse-timestamp filesystems (FAT's 2s, older
// ext3/HFS+ seconds) an in-place same-size rewrite during the criterion run
// could land in the same timestamp tick as a modification made just before it.
const SNAPSHOT_REUSE_GRACE_MS = 2000;
const SNAPSHOT_READ_CHUNK_BYTES = 64 * 1024;
const CRITERION_OPERATION_CLEANUP_MS = 5000;
const CRITERION_RUNNER_FALLBACK_MS = 3200;
const WINDOWS_TASKKILL_TIMEOUT_MS = 750;
const WINDOWS_TASKKILL_FALLBACK_TIMEOUT_MS = 2000;

function hashFileForSnapshot(file, { deadlineEpochMs = null, now = Date.now } = {}) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(SNAPSHOT_READ_CHUNK_BYTES);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    for (;;) {
      assertSnapshotDeadline(deadlineEpochMs, now);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      assertSnapshotDeadline(deadlineEpochMs, now);
    }
    return digest.digest("hex");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function repoSnapshot(repo, previous = null, { deadlineEpochMs = null, now = Date.now } = {}) {
  const capturedAtMs = now();
  const listed = repositoryContentFiles(repo, { deadlineEpochMs, now });
  if (listed.error) return { hash: null, files: [], error: listed.error };
  const files = listed.files;
  const previousEntry = new Map((previous?.entries ?? []).map((entry) => [entry.slice(0, entry.indexOf("\0")), entry]));
  const previousStats = previous?.stats ?? new Map();
  const reuseCutoffNs = previous ? BigInt(Math.max(0, (previous.captured_at_ms ?? 0) - SNAPSHOT_REUSE_GRACE_MS)) * 1_000_000n : 0n;
  const entries = [];
  const stats = new Map();
  for (const file of files) {
    const absolute = path.resolve(repo, file);
    try {
      assertSnapshotDeadline(deadlineEpochMs, now);
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
      if (reused) entries.push(reused);
      else {
        const kind = stat.isSymbolicLink() ? "symlink" : "file";
        const contentHash = stat.isSymbolicLink()
          ? sha256Hex(`link:${fs.readlinkSync(absolute)}`)
          : hashFileForSnapshot(absolute, { deadlineEpochMs, now });
        entries.push(`${file}\0${kind}\0${contentHash}`);
      }
      assertSnapshotDeadline(deadlineEpochMs, now);
    } catch (error) {
      // A partial fingerprint cannot authorize a commit. Races and unreadable
      // content fail closed so compare-and-commit will discard the observation.
      return {
        hash: null,
        files: [],
        error: error?.code === "ETIMEDOUT"
          ? error
          : Object.assign(new Error(`repository snapshot unavailable at ${file}`), { cause: error }),
      };
    }
  }
  try { assertSnapshotDeadline(deadlineEpochMs, now); }
  catch (error) { return { hash: null, files: [], error }; }
  return { hash: sha256Hex(entries.join("\n")), files, entries, stats, captured_at_ms: capturedAtMs };
}

// Revalidate a prepared full snapshot at the locked commit boundary without
// rehashing the whole repository. Directory membership and stat identities are
// checked for every path; only recently modified regular files and symlinks
// need content reads. The caller supplies a small absolute deadline so this
// final compare cannot turn the task lock back into a criterion-length lock.
function validateRepoSnapshot(repo, expected, { deadlineEpochMs = null, now = Date.now } = {}) {
  if (expected?.hash === null || expected?.hash === undefined) return { matches: false, changed_paths: [], error: expected?.error ?? new Error("expected repository snapshot unavailable") };
  const listed = repositoryContentFiles(repo, { deadlineEpochMs, now });
  if (listed.error) return { matches: false, changed_paths: [], error: listed.error };
  const expectedFiles = new Set(expected.files ?? []);
  const currentFiles = new Set(listed.files);
  const changed = new Set([...expectedFiles, ...currentFiles].filter((file) => expectedFiles.has(file) !== currentFiles.has(file)));
  const expectedEntries = new Map((expected.entries ?? []).map((entry) => [entry.slice(0, entry.indexOf("\0")), entry]));
  const reuseCutoffNs = BigInt(Math.max(0, (expected.captured_at_ms ?? 0) - SNAPSHOT_REUSE_GRACE_MS)) * 1_000_000n;
  for (const file of listed.files) {
    if (!expectedFiles.has(file)) continue;
    const absolute = path.resolve(repo, file);
    try {
      assertSnapshotDeadline(deadlineEpochMs, now);
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        const entry = `${file}\0symlink\0${sha256Hex(`link:${fs.readlinkSync(absolute)}`)}`;
        if (entry !== expectedEntries.get(file)) changed.add(file);
      } else if (!stat.isFile()) changed.add(file);
      else {
        const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
        if (expected.stats?.get(file) !== key) changed.add(file);
        else if (stat.mtimeNs >= reuseCutoffNs) {
          const entry = `${file}\0file\0${hashFileForSnapshot(absolute, { deadlineEpochMs, now })}`;
          if (entry !== expectedEntries.get(file)) changed.add(file);
        }
      }
      assertSnapshotDeadline(deadlineEpochMs, now);
    } catch (error) {
      return { matches: false, changed_paths: [...changed].sort(), error };
    }
  }
  return { matches: changed.size === 0, changed_paths: [...changed].sort(), error: null };
}

function changedSnapshotPaths(before, after) {
  const a = new Map((before.entries ?? []).map((entry) => [entry.slice(0, entry.indexOf("\0")), entry]));
  const b = new Map((after.entries ?? []).map((entry) => [entry.slice(0, entry.indexOf("\0")), entry]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
}

function artifactCheckpointFromSnapshot(snapshot) {
  if (snapshot?.hash === null || snapshot?.hash === undefined || snapshot?.error) throw snapshot?.error ?? new Error("repository snapshot is unavailable");
  const entries = (snapshot.entries ?? []).map((entry) => {
    const firstSeparator = entry.indexOf("\0");
    const secondSeparator = entry.indexOf("\0", firstSeparator + 1);
    if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) throw new Error("repository snapshot entry is invalid");
    const entryPath = entry.slice(0, firstSeparator);
    const kind = entry.slice(firstSeparator + 1, secondSeparator);
    const rawHash = entry.slice(secondSeparator + 1);
    if (!new Set(["file", "symlink"]).has(kind)) throw new Error("repository snapshot entry kind is invalid");
    const hash = /^sha256:[0-9a-f]{64}$/u.test(rawHash) ? rawHash : /^[0-9a-f]{64}$/u.test(rawHash) ? `sha256:${rawHash}` : null;
    if (!hash) throw new Error("repository snapshot entry digest is invalid");
    return { path: entryPath, kind, hash };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("repository snapshot contains duplicate paths");
  const capturedAtMs = snapshot.captured_at_ms;
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) throw new Error("repository snapshot capture time is invalid");
  return { checkpoint_id: artifactCheckpointId(entries), captured_at_ms: capturedAtMs, entries };
}

function artifactCheckpointDelta(before, after) {
  const previous = new Map((before?.entries ?? []).map((entry) => [entry.path, { kind: entry.kind, hash: entry.hash }]));
  const current = new Map((after?.entries ?? []).map((entry) => [entry.path, { kind: entry.kind, hash: entry.hash }]));
  const changedPaths = [...new Set([...previous.keys(), ...current.keys()])]
    .filter((entryPath) => JSON.stringify(previous.get(entryPath) ?? null) !== JSON.stringify(current.get(entryPath) ?? null))
    .sort();
  return {
    changed_entries: changedPaths.map((entryPath) => ({ path: entryPath, before: previous.get(entryPath) ?? null, after: current.get(entryPath) ?? null })),
    changed_paths: changedPaths,
  };
}

function executionError(result, { shell = false, platform = process.platform } = {}) {
  if (result.error?.code === "ETIMEDOUT") return "timeout";
  if (result.error?.code === "ECLEANUP") return "cleanup_failed";
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

const CRITERION_RUNNER_SOURCE = String.raw`
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const spec = JSON.parse(fs.readFileSync(0, "utf8"));
const limit = 10 * 1024 * 1024;
const output = { stdout: [], stderr: [] };
const sizes = { stdout: 0, stderr: 0 };
let overflow = false;
let timedOut = false;
let spawnError = null;
let treeKilled = null;
let child;
let finished = false;
function taskkillTree(timeout) {
  try {
    const killed = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout });
    return !killed.error && killed.status === 0;
  } catch { return false; }
}
function killTree() {
  if (!child?.pid) return true;
  if (process.platform === "win32") {
    if (spec.fail_first_tree_kill) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${WINDOWS_TASKKILL_TIMEOUT_MS});
    }
    const firstSucceeded = !spec.fail_first_tree_kill && taskkillTree(${WINDOWS_TASKKILL_TIMEOUT_MS});
    if (firstSucceeded || taskkillTree(${WINDOWS_TASKKILL_FALLBACK_TIMEOUT_MS})) return true;
    try { child.kill("SIGKILL"); } catch {}
    return false;
  } else {
    try { process.kill(-child.pid, "SIGKILL"); return true; }
    catch { try { child.kill("SIGKILL"); } catch {} }
    return false;
  }
}
function ensureTreeKilled() {
  if (treeKilled === true) return true;
  treeKilled = killTree();
  return treeKilled;
}
function capture(name, chunk) {
  if (sizes[name] + chunk.length <= limit) {
    output[name].push(chunk);
    sizes[name] += chunk.length;
    return;
  }
  if (!overflow) {
    overflow = true;
    ensureTreeKilled();
  }
}
function finish(meta) {
  if (finished) return;
  finished = true;
  process.stdout.write(Buffer.concat(output.stdout));
  process.stderr.write(Buffer.concat(output.stderr));
  process.stderr.write("\n" + spec.marker + JSON.stringify(meta) + "\n");
}
function run() {
  if (Number.isFinite(spec.startup_delay_ms) && spec.startup_delay_ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.startup_delay_ms);
  }
  const remainingMs = spec.execution_deadline_epoch_ms - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    finish({ status: null, signal: null, timed_out: true, error_code: "ETIMEDOUT" });
    return;
  }
  try {
    child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => { spawnError = error; });
    const timer = setTimeout(() => { timedOut = true; ensureTreeKilled(); }, Math.max(1, Math.min(spec.timeout_ms, remainingMs)));
    child.on("exit", (status, signal) => {
      if (!timedOut && !overflow) return;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      finish({
        status,
        signal,
        timed_out: timedOut,
        tree_killed: treeKilled,
        error_code: treeKilled === false ? "ECLEANUP" : timedOut ? "ETIMEDOUT" : "ENOBUFS",
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      finish({
        status,
        signal,
        timed_out: timedOut,
        tree_killed: treeKilled,
        error_code: treeKilled === false ? "ECLEANUP" : timedOut ? "ETIMEDOUT" : overflow ? "ENOBUFS" : spawnError?.code ?? null,
      });
    });
  } catch (error) {
    ensureTreeKilled();
    finish({ status: null, signal: null, timed_out: false, tree_killed: treeKilled, error_code: error?.code ?? "ERUNNER" });
  }
}
run();
`;

function runCriterionProcess({ executable, args }, { repo, env, timeoutMs, deadlineEpochMs = null, runnerStartupDelayMs = 0, runnerFailFirstTreeKill = false }) {
  const marker = `WORKLOOP_RUNNER_${randomUUID()}_`;
  const startedAtMs = Date.now();
  const executionDeadlineEpochMs = Math.min(
    startedAtMs + timeoutMs,
    Number.isSafeInteger(deadlineEpochMs) ? deadlineEpochMs : Number.MAX_SAFE_INTEGER,
  );
  if (executionDeadlineEpochMs <= startedAtMs) return {
    status: null,
    signal: null,
    error: Object.assign(new Error("criterion deadline elapsed before process-tree runner spawn"), { code: "ETIMEDOUT" }),
    stdout: "",
    stderr: "",
  };
  let result;
  let metadata = null;
  const parentTimeoutMs = Math.max(1, Math.min(
    timeoutMs + CRITERION_RUNNER_FALLBACK_MS,
    Number.isSafeInteger(deadlineEpochMs) ? deadlineEpochMs - Date.now() : Number.MAX_SAFE_INTEGER,
  ));
  result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", CRITERION_RUNNER_SOURCE], {
    cwd: repo,
    encoding: "utf8",
    env,
    input: JSON.stringify({ executable, args, cwd: repo, env, timeout_ms: timeoutMs, execution_deadline_epoch_ms: executionDeadlineEpochMs, startup_delay_ms: runnerStartupDelayMs, fail_first_tree_kill: runnerFailFirstTreeKill, marker }),
    timeout: parentTimeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 24 * 1024 * 1024,
  });
  const markerStart = String(result.stderr ?? "").lastIndexOf(`\n${marker}`);
  if (markerStart < 0) {
    if (!result.error) result.error = Object.assign(new Error("criterion process-tree runner did not return metadata"), { code: "ERUNNER" });
  } else {
    const metadataStart = markerStart + marker.length + 1;
    const metadataEnd = String(result.stderr).indexOf("\n", metadataStart);
    try { metadata = JSON.parse(String(result.stderr).slice(metadataStart, metadataEnd < 0 ? undefined : metadataEnd)); }
    catch { metadata = { status: null, signal: null, error_code: "ERUNNER" }; }
    result.stderr = String(result.stderr).slice(0, markerStart);
    result.status = Number.isInteger(metadata.status) ? metadata.status : null;
    result.signal = typeof metadata.signal === "string" ? metadata.signal : null;
    if (metadata.error_code) result.error = Object.assign(new Error(`criterion process error: ${metadata.error_code}`), { code: metadata.error_code });
    else result.error = undefined;
  }
  return result;
}

function runCriterionSource(source, repo, timeoutSeconds = CRITERION_TIMEOUT_SECONDS, protocol = "binary", {
  deadlineEpochMs = null,
  onSnapshots = null,
  runnerStartupDelayMs = 0,
  runnerFailFirstTreeKill = false,
} = {}) {
  const started = Date.now();
  const before = repoSnapshot(repo, null, { deadlineEpochMs });
  const configuredTimeoutMs = timeoutSeconds * 1000;
  const deadlineTimeoutMs = Number.isSafeInteger(deadlineEpochMs) ? deadlineEpochMs - Date.now() : configuredTimeoutMs;
  // When the absolute operation deadline is the binding limit, reserve a fixed
  // cleanup window for process-tree teardown and the mandatory after-snapshot.
  // Without this reserve a Windows taskkill
  // can consume the final milliseconds and make every clean timeout look like
  // a stale repository observation.
  const completionReserveMs = Number.isSafeInteger(deadlineEpochMs) ? CRITERION_OPERATION_CLEANUP_MS : 0;
  const executionTimeoutMs = Math.max(1, Math.min(configuredTimeoutMs, deadlineTimeoutMs - completionReserveMs));
  let result;
  let snapshotFailure = before.error ?? null;
  if (snapshotFailure) {
    result = { status: null, signal: null, error: snapshotFailure, stdout: "", stderr: "" };
  } else if (Number.isSafeInteger(deadlineEpochMs) && deadlineTimeoutMs <= completionReserveMs) {
    result = { status: null, signal: null, error: Object.assign(new Error("criterion deadline elapsed before spawn"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" };
  } else if (source.kind === "file") {
    const absolute = path.resolve(repo, source.value);
    try {
      const invocation = criterionFileInvocation(absolute);
      result = runCriterionProcess(invocation, { repo, env: spawnEnv(), timeoutMs: executionTimeoutMs, deadlineEpochMs, runnerStartupDelayMs, runnerFailFirstTreeKill });
    } catch (error) {
      result = { status: null, signal: null, error, stdout: "", stderr: String(error.message ?? error) };
    }
  } else {
    const rawCommand = String(source.value).trim();
    const command = process.platform === "win32" ? expandWindowsGlobs(rawCommand, repo) : rawCommand;
    const shell = process.platform === "win32" || hasShellSyntax(command);
    const argv = command.split(/\s+/).filter(Boolean);
    const env = spawnEnv();
    const invocation = shell
      ? process.platform === "win32"
        ? { executable: env.COMSPEC, args: ["/d", "/s", "/c", command] }
        : { executable: "/bin/sh", args: ["-c", command] }
      : { executable: argv[0], args: argv.slice(1) };
    result = runCriterionProcess(invocation, { repo, env, timeoutMs: executionTimeoutMs, deadlineEpochMs, runnerStartupDelayMs, runnerFailFirstTreeKill });
    if (process.platform === "win32" && result.status !== 0 && !hasShellSyntax(command) && !windowsCommandResolvable(argv[0] ?? "", repo, env)) {
      result.error = Object.assign(new Error(`command not found: ${argv[0] ?? ""}`), { code: "ENOENT" });
      result.status = null;
    }
    result.workloop_shell = shell;
  }
  result.duration_ms = Date.now() - started;
  const mapped = mapExecution(result, protocol, timeoutSeconds, { shell: Boolean(result.workloop_shell), platform: process.platform });
  mapped.execution.output_tail = criterionOutput(result.stdout, result.stderr, 4096);
  if (snapshotFailure && snapshotFailure.code !== "ETIMEDOUT") {
    mapped.verdict = "indeterminate";
    mapped.execution.execution_error = "repository_snapshot_unavailable";
  }
  const after = before.hash === null
    ? { hash: null, files: [], error: before.error }
    : repoSnapshot(repo, before, { deadlineEpochMs });
  snapshotFailure = after.error ?? snapshotFailure;
  if (after.error) {
    mapped.verdict = "indeterminate";
    mapped.execution.execution_error = after.error.code === "ETIMEDOUT" ? "timeout" : "repository_snapshot_unavailable";
  }
  onSnapshots?.({ before_hash: before.hash, after_hash: after.hash, before, after });
  const changed_paths = before.hash !== null && after.hash !== null ? changedSnapshotPaths(before, after) : [];
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
  CRITERION_OPERATION_CLEANUP_MS,
  artifactCheckpointDelta,
  artifactCheckpointFromSnapshot,
  changedSnapshotPaths,
  expandWindowsGlobs,
  criterionDrift,
  criterionFileInvocation,
  criterionMessage,
  criterionMetadata,
  mapExecution,
  repoSnapshot,
  validateRepoSnapshot,
  resolveCriterionFile,
  resolveSubject,
  runCriterionSource,
};
