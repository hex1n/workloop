#!/usr/bin/env node
// Install workloop's dependency-free runtime and loop skills.

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { directoryLockBackoff, localTimestamp, withOwnedDirectoryLock } from "./lib/prims.mjs";

const __filename = fileURLToPath(import.meta.url);
const SOURCE = path.resolve(process.env.WORKLOOP_INSTALL_REPO ?? path.dirname(__filename));
const HOME = path.resolve(process.env.WORKLOOP_INSTALL_HOME ?? os.homedir());
// Read the source checkout's contract from its prims.mjs text instead of
// importing it: WORKLOOP_INSTALL_REPO may point at a different checkout than
// the one this installer file (and its ./lib import) was loaded from, and the
// gate must judge what it is about to install, not what it is running as.
const RUNTIME_CONTRACT = (() => {
  const source = fs.readFileSync(path.join(SOURCE, "lib", "prims.mjs"), "utf8");
  const value = Number(source.match(/const RUNTIME_CONTRACT = (\d+);/)?.[1]);
  if (value !== 5) throw new Error(`workloop installer requires runtime contract 5 source; refusing contract ${Number.isFinite(value) ? value : "unknown"}`);
  return value;
})();
// Module-level plan log. Every exported entry point resets it so a library
// caller never inherits a previous invocation's rows; main() aggregates the
// rows appended by everything it runs after the one entry-point reset.
const ACTIONS = [];
const INSTALL_LOCK_TIMEOUT_MS = 30_000;
const INSTALL_LOCK_STALE_MS = 5 * 60_000;

function plan(kind, detail) {
  ACTIONS.push([kind, detail]);
}

function installFailpoint(name) {
  if (process.env.WORKLOOP_INSTALL_FAILPOINT === name) {
    throw new Error(`workloop installer injected interruption at ${name}`);
  }
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function walkFiles(root) {
  const files = [];
  if (!exists(root)) return files;
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) files.push(...walkFiles(file));
    else if (stat.isFile()) files.push(file);
  }
  return files;
}

function runtimeFiles(repo) {
  return [path.join(repo, "bin"), path.join(repo, "lib")]
    .flatMap((dir) => walkFiles(dir))
    .map((file) => ({ file, relative: path.relative(repo, file).replace(/\\/g, "/") }))
    .sort((a, b) => a.relative.localeCompare(b.relative));
}

function runtimeHash(files) {
  const hash = createHash("sha256");
  for (const entry of files) {
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(entry.file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function sameContent(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}

function pathPresent(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function sameInode(left, right) {
  try {
    const a = fs.statSync(left, { bigint: true });
    const b = fs.statSync(right, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
  } catch {
    return false;
  }
}

function treeManifest(root) {
  const entries = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`managed source tree contains a symlink: ${file}`);
      if (entry.isDirectory()) {
        entries.push({ relative, type: "directory", file });
        visit(file, relative);
      } else if (entry.isFile()) {
        entries.push({ relative, type: "file", file });
      } else {
        throw new Error(`managed source tree contains an unsupported entry: ${file}`);
      }
    }
  };
  visit(root);
  return entries;
}

function managedTreeDigest(root) {
  try {
    if (!fs.lstatSync(root).isDirectory()) return null;
    const hash = createHash("sha256");
    for (const entry of treeManifest(root)) {
      hash.update(entry.type);
      hash.update("\0");
      hash.update(entry.relative.replace(/\\/g, "/"));
      hash.update("\0");
      if (entry.type === "file") hash.update(fs.readFileSync(entry.file));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function managedTreeMatches(target, sourceEntries) {
  try {
    if (!fs.lstatSync(target).isDirectory()) return false;
    const targetEntries = treeManifest(target);
    if (sourceEntries.length !== targetEntries.length) return false;
    for (let index = 0; index < sourceEntries.length; index += 1) {
      const expected = sourceEntries[index];
      const actual = targetEntries[index];
      if (expected.relative !== actual.relative || expected.type !== actual.type) return false;
      if (expected.type !== "file") continue;
      const installed = path.join(target, expected.relative);
      const stat = fs.statSync(installed, { bigint: true });
      if (stat.nlink !== 1n || sameInode(expected.file, installed) || !sameContent(expected.file, installed)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function copyManagedTree(source, target, dry) {
  const sourceEntries = treeManifest(source);
  if (managedTreeMatches(target, sourceEntries)) {
    plan("ok", target);
    return;
  }
  plan(pathPresent(target) ? "update" : "new", target);
  if (dry) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const token = `${process.pid}.${randomUUID()}`;
  const temporary = `${target}.install.${token}`;
  const previous = `${target}.previous.${token}`;
  let movedPrevious = false;
  let activated = false;
  try {
    fs.mkdirSync(temporary);
    for (const entry of sourceEntries) {
      const installed = path.join(temporary, entry.relative);
      if (entry.type === "directory") fs.mkdirSync(installed, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(installed), { recursive: true });
        fs.copyFileSync(entry.file, installed);
      }
    }
    if (pathPresent(target)) {
      fs.renameSync(target, previous);
      movedPrevious = true;
    }
    fs.renameSync(temporary, target);
    activated = true;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (movedPrevious && !activated && !pathPresent(target)) fs.renameSync(previous, target);
    throw error;
  }
  if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true });
}

function copyFile(source, target, dry) {
  const linkedToSource = sameInode(source, target);
  const targetIsRegular = (() => {
    try {
      return fs.lstatSync(target).isFile();
    } catch {
      return false;
    }
  })();
  const multiplyLinked = targetIsRegular && fs.statSync(target, { bigint: true }).nlink !== 1n;
  if (targetIsRegular && !linkedToSource && !multiplyLinked && sameContent(source, target)) {
    plan("ok", target);
    return;
  }
  plan(pathPresent(target) ? "update" : "new", target);
  if (dry) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${process.hrtime.bigint().toString(36)}.tmp`,
  );
  try {
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the copy or activation failure.
    }
    throw error;
  }
}

function writeTextAtomicIfChanged(target, value, dry, { newMode } = {}) {
  if (exists(target) && fs.readFileSync(target, "utf8") === value) {
    plan("ok", target);
    return;
  }
  plan(exists(target) ? "update" : "new", target);
  if (dry) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${process.hrtime.bigint().toString(36)}.tmp`,
  );
  try {
    let mode = newMode;
    try {
      if (fs.lstatSync(target).isFile()) mode = fs.statSync(target).mode & 0o777;
    } catch {
      /* a new target uses its explicit mode or the process umask */
    }
    fs.writeFileSync(temporary, value, { encoding: "utf8", ...(mode ? { mode } : {}) });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the activation failure.
    }
    throw error;
  }
}

function tomlTableRange(text, table) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headers = [...text.matchAll(new RegExp(`^[ \\t]*\\[${escaped}\\][ \\t]*(?:#.*)?$`, "gm"))];
  if (headers.length > 1) return { error: `[${table}] appears more than once` };
  if (!headers.length) return null;
  const header = headers[0];
  const bodyStart = header.index + header[0].length;
  const nextHeader = /^[ \t]*\[\[?[^\]\r\n]+\]\]?[ \t]*(?:#.*)?$/gm;
  nextHeader.lastIndex = bodyStart;
  const next = nextHeader.exec(text);
  return { bodyStart, bodyEnd: next?.index ?? text.length };
}

function skipTomlSpaceAndComments(text, start, limit) {
  let index = start;
  for (;;) {
    while (index < limit && /\s/.test(text[index])) index += 1;
    if (text[index] !== "#") return index;
    while (index < limit && text[index] !== "\n") index += 1;
  }
}

function readTomlStringArray(text, assignmentEnd, limit) {
  let index = skipTomlSpaceAndComments(text, assignmentEnd, limit);
  if (text[index] !== "[") return { error: "writable_roots must be a TOML array" };
  const open = index;
  index += 1;
  const values = [];
  const valueStarts = [];
  let lastValueEnd = null;
  let lastHadComma = false;
  for (;;) {
    index = skipTomlSpaceAndComments(text, index, limit);
    if (index >= limit) return { error: "writable_roots array is not closed" };
    if (text[index] === "]") {
      return { open, close: index, values, valueStarts, lastValueEnd, lastHadComma };
    }
    const quote = text[index];
    if (quote !== '"' && quote !== "'") {
      return { error: "writable_roots must contain only quoted path strings" };
    }
    const start = index;
    index += 1;
    let escaped = false;
    while (index < limit) {
      const character = text[index];
      if (quote === '"' && character === "\\" && !escaped) {
        escaped = true;
        index += 1;
        continue;
      }
      if (character === quote && !escaped) break;
      escaped = false;
      index += 1;
    }
    if (index >= limit) return { error: "writable_roots contains an unterminated string" };
    const token = text.slice(start, index + 1);
    let value;
    try {
      value = quote === "'" ? token.slice(1, -1) : JSON.parse(token);
    } catch {
      return { error: "writable_roots contains a string escape this installer cannot preserve safely" };
    }
    values.push(value);
    valueStarts.push(start);
    index += 1;
    lastValueEnd = index;
    index = skipTomlSpaceAndComments(text, index, limit);
    if (text[index] === ",") {
      lastHadComma = true;
      index += 1;
    } else {
      lastHadComma = false;
      index = skipTomlSpaceAndComments(text, index, limit);
      if (text[index] !== "]") return { error: "writable_roots entries must be comma-separated" };
    }
  }
}

function appendTomlArrayPath(text, array, value) {
  const quoted = JSON.stringify(value);
  if (!array.values.length) {
    const inner = text.slice(array.open + 1, array.close);
    if (!inner.includes("\n")) {
      return text.slice(0, array.close) + quoted + text.slice(array.close);
    }
    const closingLineStart = text.lastIndexOf("\n", array.close - 1) + 1;
    const closingIndent = text.slice(closingLineStart, array.close);
    return text.slice(0, closingLineStart) + `${closingIndent}  ${quoted},\n` + text.slice(closingLineStart);
  }

  let next = text;
  let close = array.close;
  if (!array.lastHadComma) {
    next = next.slice(0, array.lastValueEnd) + "," + next.slice(array.lastValueEnd);
    close += 1;
  }
  const multiline = next.slice(array.open + 1, close).includes("\n");
  if (!multiline) return next.slice(0, close) + quoted + next.slice(close);

  const firstLineStart = next.lastIndexOf("\n", array.valueStarts[0] - 1) + 1;
  const itemIndent = next.slice(firstLineStart, array.valueStarts[0]);
  const closingLineStart = next.lastIndexOf("\n", close - 1) + 1;
  return next.slice(0, closingLineStart) + `${itemIndent}${quoted},\n` + next.slice(closingLineStart);
}

function mergeCodexLedgerBinding(text, ledgerRoot) {
  const table = tomlTableRange(text, "sandbox_workspace_write");
  if (table?.error) return { error: table.error };
  const quotedRoot = JSON.stringify(ledgerRoot);
  if (!table) {
    if (
      /^[ \t]*sandbox_workspace_write[ \t]*(?:\.|=)/m.test(text) ||
      /^[ \t]*\[[ \t]*["']sandbox_workspace_write["'][ \t]*\]/m.test(text)
    ) {
      return { error: "sandbox_workspace_write uses a dotted or inline TOML form this installer cannot preserve safely" };
    }
    const prefix = text && !text.endsWith("\n") ? text + "\n" : text;
    const gap = prefix.trim() ? "\n" : "";
    return {
      text: prefix + gap + `[sandbox_workspace_write]\nwritable_roots = [${quotedRoot}]\n`,
      changed: true,
    };
  }

  const body = text.slice(table.bodyStart, table.bodyEnd);
  const assignments = [...body.matchAll(/^[ \t]*writable_roots[ \t]*=/gm)];
  if (!assignments.length && /^[ \t]*["']writable_roots["'][ \t]*=/m.test(body)) {
    return { error: "writable_roots uses a quoted TOML key this installer cannot preserve safely" };
  }
  if (assignments.length > 1) return { error: "writable_roots appears more than once in [sandbox_workspace_write]" };
  if (!assignments.length) {
    const prefix = text.slice(0, table.bodyEnd);
    const newline = prefix.endsWith("\n") ? "" : "\n";
    return {
      text: prefix + newline + `writable_roots = [${quotedRoot}]\n` + text.slice(table.bodyEnd),
      changed: true,
    };
  }

  const assignmentEnd = table.bodyStart + assignments[0].index + assignments[0][0].length;
  const array = readTomlStringArray(text, assignmentEnd, table.bodyEnd);
  if (array.error) return { error: array.error };
  const wanted = path.resolve(ledgerRoot);
  const present = array.values.some((entry) => path.isAbsolute(entry) && path.resolve(entry) === wanted);
  if (present) return { text, changed: false };
  return { text: appendTomlArrayPath(text, array, ledgerRoot), changed: true };
}

function configureCodexLedgerBinding(home, { configure, dry }) {
  const config = path.join(home, ".codex", "config.toml");
  const ledgerRoot = path.join(home, ".workloop");
  let current = "";
  try {
    current = fs.readFileSync(config, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      plan(configure ? "error" : "warning", `cannot read Codex config ${config}: ${error?.message ?? error}`);
      return;
    }
  }
  const merged = mergeCodexLedgerBinding(current, ledgerRoot);
  if (merged.error) {
    plan(
      configure ? "error" : "warning",
      `${configure ? "cannot safely configure" : "cannot verify"} Codex outcome ledger binding: ${merged.error}; ` +
        `preserved ${config}`,
    );
    return;
  }
  if (!merged.changed) {
    plan("ok", `Codex outcome ledger binding: ${ledgerRoot}`);
    return;
  }
  if (!configure) {
    plan(
      "warning",
      `Codex outcome ledger binding is missing; agent-run workloop may drop ledger rows. ` +
        `Run node install.mjs --configure-codex to add ${ledgerRoot} to sandbox_workspace_write.writable_roots`,
    );
    return;
  }
  try {
    if (pathPresent(config) && fs.lstatSync(config).isSymbolicLink()) {
      plan(
        "error",
        `cannot safely configure Codex outcome ledger binding: ${config} is a symlink; ` +
          "edit its owned target explicitly or use --add-dir ~/.workloop",
      );
      return;
    }
    writeTextAtomicIfChanged(config, merged.text, dry, { newMode: 0o600 });
  } catch (error) {
    plan(
      "error",
      `cannot write Codex outcome ledger binding to ${config}: ${error?.message ?? error}; config preserved`,
    );
  }
}

function tomlContainerDelta(value) {
  let quote = null; let escaped = false; let delta = 0;
  for (const character of value) {
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#") break;
    if (character === "[" || character === "{") delta += 1;
    if (character === "]" || character === "}") delta -= 1;
  }
  return delta;
}

function codexStopCommands(config, text) {
  if (config.endsWith("hooks.json")) {
    const parsed = JSON.parse(text);
    const groups = parsed?.hooks?.Stop;
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      .map((handler) => handler?.command)
      .filter((command) => typeof command === "string");
  }
  const sections = [];
  const unparsedHookLines = [];
  let current = null;
  let unparsedHookRegion = false;
  let unparsedHookDepth = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[hooks\.([^.\]]+)(?:\.hooks)?\]\]\s*$/);
    if (header) {
      current = { event: header[1], lines: [] };
      sections.push(current);
      unparsedHookRegion = false;
      unparsedHookDepth = null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      unparsedHookRegion = /hooks/i.test(line);
      unparsedHookDepth = null;
      continue;
    }
    if (/^\s*hooks(?:\.|\s*=)/i.test(line)) {
      current = null;
      unparsedHookLines.push(line);
      unparsedHookDepth = tomlContainerDelta(line.slice(line.indexOf("=") + 1));
      unparsedHookRegion = unparsedHookDepth > 0;
      continue;
    }
    if (current) current.lines.push(line);
    else if (unparsedHookRegion) {
      unparsedHookLines.push(line);
      if (unparsedHookDepth !== null) {
        unparsedHookDepth += tomlContainerDelta(line);
        if (unparsedHookDepth <= 0) unparsedHookRegion = false;
      }
    }
  }
  const commands = sections.filter((section) => section.event === "Stop").map((section) => section.lines.join("\n"));
  if (unparsedHookLines.some((line) => /workloop(?:\.mjs)?/i.test(line))) {
    throw new Error("workloop hook uses unsupported TOML syntax");
  }
  return commands;
}

function inspectCodexHookProfiles(home) {
  for (const config of [path.join(home, ".codex", "hooks.json"), path.join(home, ".codex", "config.toml")]) {
    let text;
    try {
      text = fs.readFileSync(config, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") plan("warning", `cannot inspect Codex Hook configuration ${config}: ${error?.message ?? error}; preserved ${config}`);
      continue;
    }
    let commands;
    try {
      commands = codexStopCommands(config, text).filter((command) => /workloop(?:\.mjs)?/i.test(command));
    } catch (error) {
      plan("warning", `cannot inspect Codex Hook configuration ${config}: ${error?.message ?? error}; preserved ${config}`);
      continue;
    }
    if (!commands.length) continue;
    const joined = commands.join("\n");
    if (/\bhook\s+--profile\s+codex-safe\b/.test(joined) && !commands.some((command) => !/\bhook\s+--profile\s+codex-safe\b/.test(command))) {
      plan("ok", `Codex workloop Stop hook uses codex-safe: ${config}`);
      continue;
    }
    if (/\bhook\s+--profile\s+codex-cli-legacy\b/.test(joined)) {
      plan("warning", `experimental Codex CLI legacy Stop hook found in ${config}; never use it in Codex App. Generate a safe recipe with workloop hooks --profile codex-safe --mode nudge; configuration preserved`);
      continue;
    }
    plan("warning", `legacy Codex workloop Stop hook found in ${config}; generate a safe recipe with workloop hooks --profile codex-safe --mode nudge and merge it manually; configuration preserved`);
  }
}

function pruneRuntimes(runtimeRoot, activeHash, dry) {
  if (!exists(runtimeRoot)) return;
  for (const name of fs.readdirSync(runtimeRoot).sort()) {
    if (name === activeHash) continue;
    const target = path.join(runtimeRoot, name);
    if (dry) {
      plan("remove", target);
      continue;
    }
    const released = path.join(path.dirname(runtimeRoot), `.workloop-runtime-pruned-${name}.${process.pid}.${randomUUID()}`);
    try {
      fs.renameSync(target, released);
      try { fs.rmSync(released, { recursive: true, force: true }); } catch { /* moved out of active runtime set; later cleanup can remove it */ }
      plan("remove", target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      plan("ok", `${target} (old runtime still in use; cleanup deferred)`);
    }
  }
}

function withInstallLock(home, action) {
  const lock = path.join(home, "bin", ".workloop-runtime.install-lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  return withOwnedDirectoryLock(lock, action, {
    timeoutMs: INSTALL_LOCK_TIMEOUT_MS,
    staleMs: INSTALL_LOCK_STALE_MS,
    // Site policy: installs are rare and long, so keep the original 25ms
    // contention cadence instead of the shared 5ms default.
    wait: () => directoryLockBackoff(25),
    ownerExtra: { at: localTimestamp() },
    removeOnOwnerWriteFailure: true,
    timeoutError: () => new Error(`timed out waiting for workloop install lock: ${lock}`),
    // A later install can reap this lock only after its owner is gone.
    onReleaseError: () => {},
  });
}

function activateRuntimeShims(home, hash, dry) {
  const nodeWrapper =
    "#!/usr/bin/env node\n\n" +
    `import "./.workloop-runtime/${hash}/bin/workloop.mjs";\n`;
  const windowsWrapper = '@echo off\r\nnode "%~dp0workloop.mjs" %*\r\n';
  const powershellWrapper = "$script = Join-Path $PSScriptRoot 'workloop.mjs'\r\n& node $script @args\r\nexit $LASTEXITCODE\r\n";
  writeTextAtomicIfChanged(path.join(home, "bin", "workloop.mjs"), nodeWrapper, dry);
  writeTextAtomicIfChanged(path.join(home, "bin", "workloop.cmd"), windowsWrapper, dry);
  writeTextAtomicIfChanged(path.join(home, "bin", "workloop.ps1"), powershellWrapper, dry);
}

function installWorkloopRuntimeUnlocked(repo, home, dry, { activate = true } = {}) {
  const files = runtimeFiles(repo);
  if (!files.length) throw new Error(`workloop runtime is empty under ${repo}`);
  const hash = runtimeHash(files);
  const runtimeRoot = path.join(home, "bin", ".workloop-runtime");
  const versionRoot = path.join(runtimeRoot, hash);
  const install = () => {
    for (const entry of files) copyFile(entry.file, path.join(versionRoot, entry.relative), dry);
    if (activate) {
      // Activation is last, so every process sees one complete pinned runtime.
      activateRuntimeShims(home, hash, dry);
      pruneRuntimes(runtimeRoot, hash, dry);
    }
    return { hash, versionRoot };
  };
  return install();
}

export function installWorkloopRuntime(repo, home, dry = false) {
  ACTIONS.length = 0;
  const install = () => installWorkloopRuntimeUnlocked(repo, home, dry);
  return dry ? install() : withInstallLock(home, install);
}

function readManagedSkills(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.skills)) {
      return {
        runtimes: { ".claude": {}, ".codex": {} },
        legacyNames: new Set(parsed.skills.filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name))),
      };
    }
    if (parsed?.version !== 2 || !parsed.runtimes || typeof parsed.runtimes !== "object") {
      return { runtimes: { ".claude": {}, ".codex": {} }, legacyNames: new Set() };
    }
    const runtimes = {};
    for (const runtime of [".claude", ".codex"]) {
      const entries = parsed.runtimes[runtime];
      runtimes[runtime] = {};
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [name, digest] of Object.entries(entries)) {
        if (/^[a-z0-9][a-z0-9-]*$/.test(name) && /^[a-f0-9]{64}$/.test(String(digest))) {
          runtimes[runtime][name] = String(digest);
        }
      }
    }
    return { runtimes, legacyNames: new Set() };
  } catch {
    return { runtimes: { ".claude": {}, ".codex": {} }, legacyNames: new Set() };
  }
}

// Byte-exact source trees from the last asdf-owned core at
// 9c6dbdb957b530997c17a80bd4d2bdf3d3c02fd8, plus the unpublished name-only
// workloop installer used during this extraction. They permit a one-time safe
// adoption without treating an arbitrary same-name directory as workloop-owned.
const LEGACY_CORE_DIGESTS = {
  "loop-core": new Set([
    "240b0483fc292a65f999eb598d12e48903fb4c3a50b77a0e3f2cd42dc5701e06",
    "60e4890b035aeb597a3647ee012c1fd4cd7272804c9d2aa00ca568decc6ca47e",
  ]),
  workloop: new Set([
    "3dcb2d46005915b1ccd4aa41d6de8b5fb365e9527e4d6da1930707be5ea46281",
    "7468e5f0211b437157e0716e09cfafd1e3015a50f8030c5c5d0ef46a2fa59a4e",
  ]),
};

export function legacySkillCanBeAdopted(skill, actualDigest, legacyNamed, currentDigest) {
  if (LEGACY_CORE_DIGESTS[skill]?.has(actualDigest)) return true;
  return Boolean(legacyNamed && actualDigest && actualDigest === currentDigest);
}

function installWorkloopAssetsUnlocked(repo, home, dry) {
  const skillsRoot = path.join(repo, "skills");
  const skills = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const manifest = path.join(home, "bin", ".workloop-managed-skills.json");
  const previousState = readManagedSkills(manifest);
  const previous = previousState.runtimes;
  const next = { ".claude": {}, ".codex": {} };
  const sourceDigests = Object.fromEntries(
    skills.map((skill) => [skill, managedTreeDigest(path.join(skillsRoot, skill))]),
  );
  const groups = new Map();
  for (const runtime of [".claude", ".codex"]) {
    const root = path.join(home, runtime, "skills");
    let key;
    try {
      key = fs.realpathSync(root);
    } catch {
      key = path.resolve(root);
    }
    if (!groups.has(key)) groups.set(key, { root, runtimes: [] });
    groups.get(key).runtimes.push(runtime);
  }
  for (const { root, runtimes } of groups.values()) {
    const groupPrevious = {};
    const conflicts = new Set();
    for (const runtime of runtimes) {
      for (const [skill, digest] of Object.entries(previous[runtime])) {
        if (groupPrevious[skill] && groupPrevious[skill] !== digest) conflicts.add(skill);
        else groupPrevious[skill] = digest;
      }
    }
    for (const skill of conflicts) delete groupPrevious[skill];
    const owned = {};
    for (const skill of skills) {
      const source = path.join(skillsRoot, skill);
      const target = path.join(root, skill);
      const expectedPrevious = groupPrevious[skill];
      if (pathPresent(target)) {
        if (!expectedPrevious) {
          const actual = managedTreeDigest(target);
          if (!legacySkillCanBeAdopted(skill, actual, previousState.legacyNames.has(skill), sourceDigests[skill])) {
            plan("error", `${target} exists but is not proven workloop-owned; preserve it or remove it explicitly`);
            continue;
          }
          plan("ok", `${target} (adopt byte-exact legacy workloop core)`);
        } else {
          const actual = managedTreeDigest(target);
          if (actual !== expectedPrevious) {
            plan("error", `${target} changed since workloop installed it; preserving the external or local takeover`);
            continue;
          }
        }
      }
      copyManagedTree(source, target, dry);
      owned[skill] = sourceDigests[skill];
    }
    for (const [stale, expected] of Object.entries(groupPrevious).filter(([skill]) => !skills.includes(skill))) {
      const target = path.join(root, stale);
      if (!pathPresent(target)) continue;
      if (managedTreeDigest(target) !== expected) {
        plan("ok", `${target} (ownership changed; preserved and released)`);
        continue;
      }
      plan("remove", target);
      if (!dry) fs.rmSync(target, { recursive: true, force: true });
    }
    for (const runtime of runtimes) next[runtime] = { ...owned };
  }
  writeTextAtomicIfChanged(manifest, JSON.stringify({ version: 2, runtimes: next }, null, 2) + "\n", dry);
}

export function installWorkloopAssets(repo, home, dry = false) {
  ACTIONS.length = 0;
  const install = () => installWorkloopAssetsUnlocked(repo, home, dry);
  return dry ? install() : withInstallLock(home, install);
}

export function installWorkloop(repo, home, dry = false) {
  ACTIONS.length = 0;
  const install = () => {
    const runtime = installWorkloopRuntimeUnlocked(repo, home, dry, { activate: false });
    const releaseId = runtime.hash;
    const journal = path.join(home, "bin", ".workloop-activation-journal.json");
    const releaseManifest = path.join(home, "bin", ".workloop-active-release.json");
    const journalRow = {
      journal_version: 1,
      release_id: releaseId,
      runtime_contract: RUNTIME_CONTRACT,
      status: "activating",
      steps: { runtime_staged: true, skills_activated: false, shim_activated: false, manifest_committed: false },
    };
    writeTextAtomicIfChanged(journal, JSON.stringify(journalRow, null, 2) + "\n", dry);
    installFailpoint("runtime-staged");
    installWorkloopAssetsUnlocked(repo, home, dry);
    if (ACTIONS.some(([kind]) => kind === "error")) {
      journalRow.status = "needs_manual_intervention";
      writeTextAtomicIfChanged(journal, JSON.stringify(journalRow, null, 2) + "\n", dry);
      return runtime;
    }
    journalRow.steps.skills_activated = true;
    writeTextAtomicIfChanged(journal, JSON.stringify(journalRow, null, 2) + "\n", dry);
    installFailpoint("skills-activated");
    activateRuntimeShims(home, runtime.hash, dry);
    journalRow.steps.shim_activated = true;
    writeTextAtomicIfChanged(journal, JSON.stringify(journalRow, null, 2) + "\n", dry);
    installFailpoint("shim-activated");
    const skillManifest = path.join(home, "bin", ".workloop-managed-skills.json");
    const manifestRow = {
      release_manifest_version: 1,
      release_id: releaseId,
      runtime_contract: RUNTIME_CONTRACT,
      runtime_digest: runtime.hash,
      managed_skills_manifest_digest: dry || !exists(skillManifest) ? null : createHash("sha256").update(fs.readFileSync(skillManifest)).digest("hex"),
    };
    writeTextAtomicIfChanged(releaseManifest, JSON.stringify(manifestRow, null, 2) + "\n", dry);
    journalRow.steps.manifest_committed = true;
    journalRow.status = "committed";
    writeTextAtomicIfChanged(journal, JSON.stringify(journalRow, null, 2) + "\n", dry);
    installFailpoint("manifest-committed");
    if (!dry) fs.rmSync(journal, { force: true });
    installFailpoint("journal-cleaned");
    pruneRuntimes(path.join(home, "bin", ".workloop-runtime"), runtime.hash, dry);
    return runtime;
  };
  return dry ? install() : withInstallLock(home, install);
}

function registerCommitDistribution(repo, dry) {
  if (!exists(path.join(repo, ".git")) || !exists(path.join(repo, "hooks", "post-commit"))) return;
  const expectedHooksPath = path.resolve(repo, "hooks");
  const samePath = (a, b) => {
    const left = path.normalize(a);
    const right = path.normalize(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  };
  let current = "";
  try {
    current = execFileSync("git", ["-C", repo, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    current = "";
  }
  const currentHooksPath = current ? path.resolve(repo, current) : "";
  if (current === "hooks" || (currentHooksPath && samePath(currentHooksPath, expectedHooksPath))) {
    plan("ok", current === "hooks" ? "core.hooksPath=hooks" : `core.hooksPath=${current}`);
    return;
  }
  if (current) {
    plan("error", `core.hooksPath is '${current}'; not replacing a foreign hook directory`);
    return;
  }
  plan("update", "git config core.hooksPath hooks");
  if (!dry) execFileSync("git", ["-C", repo, "config", "core.hooksPath", "hooks"]);
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const configureCodex = args.includes("--configure-codex");
  if (args.some((arg) => !["--dry-run", "--configure-codex"].includes(arg))) {
    process.stderr.write("usage: node install.mjs [--dry-run] [--configure-codex]\n");
    return 2;
  }
  ACTIONS.length = 0;
  const installed = installWorkloop(SOURCE, HOME, dry);
  registerCommitDistribution(SOURCE, dry);
  const bindCodex = () => configureCodexLedgerBinding(HOME, { configure: configureCodex, dry });
  if (configureCodex && !dry) withInstallLock(HOME, bindCodex);
  else bindCodex();
  inspectCodexHookProfiles(HOME);
  const order = ["new", "update", "remove", "warning", "ok", "error"];
  const counts = Object.fromEntries(order.map((kind) => [kind, 0]));
  process.stdout.write(`workloop install ${dry ? "(dry run) " : ""}from ${SOURCE}\n\n`);
  for (const kind of order) {
    for (const [, detail] of ACTIONS.filter(([rowKind]) => rowKind === kind)) {
      counts[kind] += 1;
      if (kind !== "ok") process.stdout.write(`  ${kind.padEnd(7)} ${detail}\n`);
    }
  }
  process.stdout.write(
    `\nruntime: ${installed.hash}\n` +
      `summary: ${order.map((kind) => `${counts[kind]} ${kind}`).join(", ")}\n`,
  );
  return counts.error ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
