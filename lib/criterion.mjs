// Internal taskloop module. Its public seam is the export list at the end.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, execSync } from "node:child_process";
import { CRITERION_TIMEOUT_SECONDS, STATE_DIR, fnv1aHex, globToRegExp, isPlainObject } from "./prims.mjs";

function hasShellSyntax(command) {
  return /[|&;<>$`*?()[\]{}"'\\]/.test(String(command ?? ""));
}

// The child env can be stripped by the calling harness (observed live: a Codex
// session whose hooks ran with no usable PATH/COMSPEC, so every bare command
// name was a spawn error and only absolute executable paths worked). Give the
// criterion an env floor: the running node's own directory plus the platform's
// system bins, appended after any PATH the parent did provide.

function criterionSpawnEnv() {
  const env = { ...process.env };
  const floor = [path.dirname(process.execPath)];
  if (process.platform === "win32") {
    const sysRoot = env.SystemRoot || env.windir || "C:\\Windows";
    floor.push(path.join(sysRoot, "System32"), sysRoot);
    if (!env.COMSPEC) env.COMSPEC = path.join(sysRoot, "System32", "cmd.exe");
  } else {
    floor.push("/usr/local/bin", "/usr/bin", "/bin");
  }
  const have = String(env.PATH ?? env.Path ?? "");
  env.PATH = have ? have + path.delimiter + floor.join(path.delimiter) : floor.join(path.delimiter);
  return env;
}

// cmd.exe never expands globs, so on Windows a glob-referenced check
// (node docs/check*.cjs) reads MODULE_NOT_FOUND exit 1 as a permanent false
// red: it opens, then can never turn green. Expand repo-resolvable glob tokens
// with the same machinery the fingerprint uses, so execution and drift
// tracking see the same files. A shell-literate line (quotes, pipes, $) is
// left verbatim — its author addressed a shell on purpose.

function win32CriterionCommand(criterion, repo) {
  const line = String(criterion);
  if (/[|&;<>$`()[\]{}"']/.test(line)) return line;
  const root = path.resolve(String(repo));
  return line.replace(/\S+/g, (token) => {
    if (!/[*?]/.test(token) || token.startsWith("-")) return token;
    const { files } = expandCriterionToken(token, root);
    if (!files.length) return token;
    return files.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" ");
  });
}

// A bare command line (no shell syntax) historically refused when its
// executable did not exist (execFile ENOENT). The unified cmd.exe path keeps
// that boundary deterministically: resolve the first token against
// PATH/PATHEXT before spawning — cmd's localized "not recognized" text and
// its exit 1 cannot tell not-found apart from a legitimate red.

function win32ResolvesExecutable(line, env, root) {
  const m = String(line).trim().match(/^"([^"]+)"|^(\S+)/);
  const token = m ? (m[1] ?? m[2]) : "";
  if (!token) return false;
  const exts = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const hits = (base) => [base, ...exts.map((e) => base + e), ...exts.map((e) => base + e.toLowerCase())].some(isFile);
  if (/[\\/]/.test(token) || /^[A-Za-z]:/.test(token)) return hits(path.resolve(String(root), token));
  return String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => hits(path.join(dir, token)));
}

function criterionErrorResult(err, win, timeoutSec, protocol = "binary") {
  const output = String(err.stdout ?? "") + String(err.stderr ?? "");
  if (err.signal || err.code === "ETIMEDOUT") {
    return { verdict: "fail", exit: null, output, detail: `timed out after ${timeoutSec}s` };
  }
  if (err.code === "EPERM" || err.code === "EACCES") {
    return {
      verdict: "not_executable",
      exit: null,
      output,
      detail:
        "cannot execute (the environment blocked the spawn itself — sandbox, ACL, or execute bit; " +
        "rerun with escalated permissions, or suspend --outcome needs_input)",
    };
  }
  const status = typeof err.status === "number" ? err.status : null;
  const notFound = status === null || status === 127 || (win && status === 9009);
  if (notFound || status === 126) {
    const hint = notFound
      ? "command or shell not found in this environment; try an absolute executable path"
      : `exit ${status}`;
    return { verdict: "not_executable", exit: status, output, detail: `cannot execute (${hint})` };
  }
  if (protocol === "tri-state" && status === 2) {
    return {
      verdict: "indeterminate",
      exit: 2,
      output,
      detail: "criterion adapter could not adjudicate (exit 2)",
    };
  }
  return { verdict: "fail", exit: status, output };
}

function runCriterion(criterion, repo, timeoutSec = CRITERION_TIMEOUT_SECONDS, protocol = "binary") {
  const opts = {
    cwd: repo,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    env: criterionSpawnEnv(),
  };
  const win = process.platform === "win32";
  let command = String(criterion);
  if (win) {
    command = win32CriterionCommand(command, repo);
    // An absolute shell spawns even when the parent stripped PATH entirely.
    opts.shell = opts.env.COMSPEC;
    if (!/[|&;<>$`()[\]{}"']/.test(command) && !win32ResolvesExecutable(command, opts.env, repo)) {
      return {
        verdict: "not_executable",
        exit: null,
        output: "",
        detail: "cannot execute (command or shell not found in this environment; try an absolute executable path)",
      };
    }
  }
  const simple = !win && !hasShellSyntax(command);
  try {
    const argv = command.trim().split(/\s+/);
    const stdout = simple ? execFileSync(argv[0], argv.slice(1), opts) : execSync(command, opts);
    return { verdict: "pass", exit: 0, output: String(stdout ?? "") };
  } catch (err) {
    return criterionErrorResult(err, win, timeoutSec, protocol);
  }
}

function runCriterionFile(criterionFile, repo, timeoutSec = CRITERION_TIMEOUT_SECONDS, protocol = "binary") {
  const absolute = path.resolve(repo, criterionFile);
  const opts = {
    cwd: repo,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    env: criterionSpawnEnv(),
  };
  const nodeScript = /\.(?:cjs|mjs|js)$/i.test(criterionFile);
  try {
    const stdout = nodeScript
      ? execFileSync(process.execPath, [absolute], opts)
      : execFileSync(absolute, [], opts);
    return { verdict: "pass", exit: 0, output: String(stdout ?? "") };
  } catch (err) {
    return criterionErrorResult(err, process.platform === "win32", timeoutSec, protocol);
  }
}

function normalizeCriterionPathToken(token) {
  let value = String(token ?? "").replace(/\\/g, "/");
  if (process.platform === "win32") {
    if (/^\/[A-Za-z]\//.test(value)) value = `${value[1].toUpperCase()}:/${value.slice(3)}`;
    else if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  }
  return value;
}

// Expand one criterion token to the repo files it names. A literal path
// resolves to itself; a single-directory glob (docs/check*.cjs) is read from
// its directory. A multi-level glob (docs/**/c.cjs) or a glob in the directory
// part cannot be enumerated cheaply and returns partial=true so the caller can
// record honest coverage instead of a false all-clear.

function expandCriterionToken(token, root) {
  const rel = normalizeCriterionPathToken(token);
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
  const unresolved = [];
  const seen = new Set();
  let partial = false;
  const rawTokens = String(criterion ?? "").match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s();|&<>]+/g) ?? [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const rawToken = rawTokens[index];
    const unquoted = /^(["']).*\1$/.test(rawToken) ? rawToken.slice(1, -1) : rawToken;
    const token = normalizeCriterionPathToken(unquoted.replace(/^--?[\w-]+=/, ""));
    if (!token || token.startsWith("-") || token === "/dev/null" || /^NUL$/i.test(token)) continue;
    const pathShaped = /[\\/]/.test(token) || /\.[A-Za-z0-9]{1,10}(?:[*?][^\s]*)?$/.test(token);
    if (!pathShaped) continue;
    const { files, partial: tokenPartial } = expandCriterionToken(token, root);
    if (tokenPartial) partial = true;
    // The first token may be an external executable such as /usr/bin/node.
    // Fingerprint it when it is repo-local, but do not treat the external
    // command itself as an unresolved criterion input.
    if (!files.length && index > 0) unresolved.push(token);
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
  return { inputs, partial, unresolved: [...new Set(unresolved)] };
}

// Where the checker itself lives. A checker inside the loop's own state dir
// was written by the session that opened the task (observed live: a unit-test
// criterion blocked by an unrelated module baseline degraded into a
// .taskloop/*.mjs asserting the author's own source strings — runnable, green
// on schedule, and proof of nothing but authorship). The engine cannot judge
// a check's semantics, so it records where the check lives and lets the flag
// ride the warning, the close reminder, and the ledger — never a gate.

function criterionProvenance(inputs, unresolved = []) {
  if (unresolved.length) return "unresolved";
  const prefix = STATE_DIR + "/";
  const inside = (Array.isArray(inputs) ? inputs : []).some((entry) => String(entry?.path ?? "").startsWith(prefix));
  return inside ? "state-dir" : "repo";
}

function criterionSensorMetadata(criterion, repo) {
  const { inputs, partial, unresolved } = criterionInputs(criterion, repo);
  return {
    criterion_inputs: inputs,
    criterion_input_coverage: partial || unresolved.length ? (inputs.length ? "partial" : "unknown") : inputs.length ? "full" : "unknown",
    criterion_unresolved_inputs: unresolved,
    criterion_provenance: criterionProvenance(inputs, unresolved),
  };
}

function resolveCriterionFile(repo, raw) {
  const value = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!value) throw new Error("--criterion-file requires a repository-relative path");
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error("--criterion-file must be repository-relative");
  }
  const root = path.resolve(repo);
  const absolute = path.resolve(root, value);
  if (absolute === root || !absolute.startsWith(root + path.sep)) {
    throw new Error("--criterion-file must stay inside the repository");
  }
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new Error(`--criterion-file does not exist: ${value}`);
  }
  if (!stat.isFile()) throw new Error(`--criterion-file is not a file: ${value}`);
  return absolute.slice(root.length + 1).replace(/\\/g, "/");
}

// A declared work subject is a trust exception, so it must be named precisely:
// one repo-relative file, no globs, never the loop's own state dir. Existence
// is not required — a subject the task will create simply has no fingerprint
// to exempt yet.
function resolveCriterionSubject(repo, raw) {
  const value = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!value) throw new Error("--criterion-subject requires a repository-relative file path");
  if (/[*?[\]]/.test(value)) {
    throw new Error(
      `--criterion-subject must name an exact file, not a glob: ${value} — a trust exception names its files precisely`,
    );
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`--criterion-subject must be repository-relative: ${value}`);
  }
  const root = path.resolve(repo);
  const absolute = path.resolve(root, value);
  if (absolute === root || !absolute.startsWith(root + path.sep)) {
    throw new Error(`--criterion-subject must stay inside the repository: ${value}`);
  }
  const rel = absolute.slice(root.length + 1).replace(/\\/g, "/");
  if (rel === STATE_DIR || rel.startsWith(STATE_DIR + "/")) {
    throw new Error(`--criterion-subject cannot live in the loop's own state dir: ${value}`);
  }
  return rel;
}

function criterionFileSensorMetadata(criterionFile, repo) {
  const absolute = path.resolve(repo, criterionFile);
  const inputs = [{ path: criterionFile, hash: fnv1aHex(fs.readFileSync(absolute, "latin1")) }];
  return {
    criterion_inputs: inputs,
    criterion_input_coverage: "full",
    criterion_unresolved_inputs: [],
    criterion_provenance: criterionProvenance(inputs),
  };
}

function runTaskCriterion(task, repo) {
  return task.criterion_file
    ? runCriterionFile(
        task.criterion_file,
        repo,
        task.criterion_timeout_seconds,
        task.criterion_protocol ?? "binary",
      )
    : runCriterion(
        task.criterion,
        repo,
        task.criterion_timeout_seconds,
        task.criterion_protocol ?? "binary",
      );
}

function warnCriterionSensor(sensor, sink = process.stderr) {
  if (sensor.criterion_provenance === "unresolved") {
    sink.write(
      `warning: unresolved criterion path inputs: ${sensor.criterion_unresolved_inputs.join(", ")}; ` +
        "coverage is not full and weak-close safeguards apply\n",
    );
  } else if (sensor.criterion_input_coverage === "unknown") {
    sink.write(
      "warning: criterion inputs could not be identified; coverage is unknown and no input fingerprint protects this check\n",
    );
  } else if (sensor.criterion_input_coverage === "partial") {
    sink.write("warning: criterion input coverage is partial; not every path-shaped input could be fingerprinted\n");
  }
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
    // Pure detection: never re-baseline here, or the first observation would
    // disarm the gate and the next close attempt would sail through. The
    // fingerprint moves only through amend --criterion --reason.
    if (current !== String(entry.hash ?? "")) changed.push(String(entry.path));
  }
  return changed;
}

export {
  runCriterion,
  runCriterionFile,
  criterionSensorMetadata,
  resolveCriterionFile,
  resolveCriterionSubject,
  criterionFileSensorMetadata,
  runTaskCriterion,
  warnCriterionSensor,
  criterionInputDrift,
};
