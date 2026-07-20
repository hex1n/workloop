// Internal workloop module. Its public seam is the export list at the end.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { STATE_DIR, TASK_FILE, V3_RUNTIME_CONTRACT, V3_TASK_SNAPSHOT_SCHEMA_VERSION, canonicalJson, foldCasePath, globToRegExp, hasExactKeys, isPlainObject, sha256Hex, userHome } from "./prims.mjs";

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

function dialectQuote(char, dialect) {
  return char === '"' || (char === "'" && dialect !== "cmd");
}

function dialectEscape(source, index, dialect, quote) {
  const char = source[index];
  if (dialect === "posix" && char === "\\" && quote !== "'") {
    const next = source[index + 1];
    const active = quote === '"' ? /["\\$`\r\n]/.test(next ?? "") : next !== undefined;
    return active ? { value: /[\r\n]/.test(next) ? "" : next, end: index + 2 } : null;
  }
  if (dialect === "cmd" && char === "^" && quote === null && source[index + 1] !== undefined) {
    const next = source[index + 1];
    const end = next === "\r" && source[index + 2] === "\n" ? index + 3 : index + 2;
    return { value: /[\r\n]/.test(next) ? "" : next, end };
  }
  if (dialect === "powershell" && char === "`" && quote !== "'" && source[index + 1] !== undefined) {
    const next = source[index + 1];
    const end = next === "\r" && source[index + 2] === "\n" ? index + 3 : index + 2;
    return { value: /[\r\n]/.test(next) ? "" : next, end };
  }
  return null;
}

function redirectionOperatorAt(source, index, dialect) {
  const candidates = dialect === "posix"
    ? ["&>>", "&>", "<<<", "<<-", "<<", ">>", "<&", ">&", "<>", ">", "<"]
    : dialect === "powershell"
      ? ["*>>", "*>", ">>", "<&", ">&", "<>", ">", "<"]
      : [">>", "<&", ">&", "<>", ">", "<"];
  return candidates.find((candidate) => source.startsWith(candidate, index)) ?? null;
}

function separatorAt(source, index, dialect) {
  const char = source[index];
  if (char === "\r" || char === "\n") return char === "\r" && source[index + 1] === "\n" ? "\r\n" : char;
  if (char === "|" || char === "&") {
    if (source[index + 1] === char || (char === "|" && source[index + 1] === "&")) return char + source[index + 1];
    return char;
  }
  if (char === ";" && dialect !== "cmd") return char;
  if (char === "(" || char === ")") return char;
  return null;
}

function readShellValue(source, start, dialect) {
  let value = "";
  let quote = null;
  let started = false;
  let index = start;
  for (; index < source.length;) {
    const char = source[index];
    const escaped = dialectEscape(source, index, dialect, quote);
    if (escaped) {
      value += escaped.value;
      started = true;
      index = escaped.end;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else value += char;
      started = true;
      index += 1;
      continue;
    }
    if (dialectQuote(char, dialect)) {
      quote = char;
      started = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char) || separatorAt(source, index, dialect) || redirectionOperatorAt(source, index, dialect)) break;
    value += char;
    started = true;
    index += 1;
  }
  return { value, end: index, started };
}

function heredocDeclarations(line) {
  const declarations = [];
  let quote = null;
  for (let index = 0; index < line.length;) {
    const escaped = dialectEscape(line, index, "posix", quote);
    if (escaped) {
      index = escaped.end;
      continue;
    }
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (dialectQuote(char, "posix")) {
      quote = char;
      index += 1;
      continue;
    }
    const operator = redirectionOperatorAt(line, index, "posix");
    if (operator !== "<<" && operator !== "<<-") {
      index += 1;
      continue;
    }
    let cursor = index + operator.length;
    while (/[ \t]/.test(line[cursor] ?? "")) cursor += 1;
    const target = readShellValue(line, cursor, "posix");
    if (target.started) declarations.push({ delimiter: target.value, stripTabs: operator === "<<-" });
    index = Math.max(target.end, index + operator.length);
  }
  return declarations;
}

function commandSource(command, dialect) {
  const lines = String(command).split(/\r?\n/);
  const syntax = [];
  const heredocs = [];
  let patchBody = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (patchBody) {
      if (trimmed === "*** End Patch") patchBody = false;
      continue;
    }
    if (trimmed === "*** Begin Patch") {
      patchBody = true;
      continue;
    }
    syntax.push(line);
    if (dialect !== "posix") continue;
    const declarations = heredocDeclarations(line);
    if (declarations.length === 0) continue;
    let bodyCursor = lineIndex + 1;
    for (const declaration of declarations) {
      const body = [];
      let closed = false;
      for (; bodyCursor < lines.length; bodyCursor += 1) {
        const compared = declaration.stripTabs ? lines[bodyCursor].replace(/^\t+/, "") : lines[bodyCursor];
        if (compared === declaration.delimiter) {
          closed = true;
          bodyCursor += 1;
          break;
        }
        body.push(compared);
      }
      heredocs.push({ ...declaration, body: body.join("\n"), closed });
    }
    lineIndex = Math.max(lineIndex, bodyCursor - 1);
  }
  return { syntax: syntax.join("\n"), heredocs };
}

function commandParts(syntax, dialect, heredocs = []) {
  const parts = [];
  let words = [];
  let redirections = [];
  let heredocIndex = 0;
  const flush = (separator) => {
    if (words.length || redirections.length) {
      const attached = redirections.map((redirection) => {
        if (redirection.operator !== "<<" && redirection.operator !== "<<-") return redirection;
        const heredoc = heredocs[heredocIndex++];
        return { ...redirection, heredoc: heredoc?.delimiter === redirection.target ? heredoc : null };
      });
      parts.push({ text: words.join(" "), words, redirections: attached, separator });
    }
    words = [];
    redirections = [];
  };
  for (let index = 0; index < syntax.length;) {
    if (syntax[index] === " " || syntax[index] === "\t") {
      index += 1;
      continue;
    }
    const separator = separatorAt(syntax, index, dialect);
    const directOperator = redirectionOperatorAt(syntax, index, dialect);
    const descriptor = directOperator ? null : syntax.slice(index).match(/^(\d+)(?=[<>])/);
    const operatorIndex = descriptor ? index + descriptor[1].length : index;
    const operator = directOperator ?? redirectionOperatorAt(syntax, operatorIndex, dialect);
    if (operator) {
      let cursor = operatorIndex + operator.length;
      while (/[ \t]/.test(syntax[cursor] ?? "")) cursor += 1;
      const target = readShellValue(syntax, cursor, dialect);
      const fd = descriptor?.[1] ?? (operator.startsWith("<") ? "0" : null);
      const descriptorTarget = (operator === ">&" || operator === "<&") && /^(?:\d+|-)$/.test(target.value);
      redirections.push({ operator, fd, target: target.value, descriptorTarget });
      index = Math.max(target.end, cursor);
      continue;
    }
    if (separator) {
      flush(separator === "\r\n" || separator === "\r" ? "\n" : separator);
      index += separator.length;
      continue;
    }
    const word = readShellValue(syntax, index, dialect);
    if (!word.started) {
      index += 1;
      continue;
    }
    words.push(word.value);
    index = word.end;
  }
  flush(null);
  return parts;
}

const GIT_WRITE_SUBCOMMANDS = new Set(["push", "commit", "add", "reset", "restore", "checkout", "clean", "merge", "rebase"]);

// git accepts global options before its subcommand, so the subcommand is not a
// fixed text position after `git`. Reading it as one is how `git -C . push`
// stayed ungated by the envelope and unpriced by the irreversible floor while
// `git push` was caught. These options consume the following word; the `--opt=value`
// form carries its own and is handled by the `=` test.
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);

function toolName(word) {
  const executable = String(word ?? "").replace(/^@/, "").split(/[\\/]/).pop()?.toLowerCase();
  return executable?.replace(/\.(?:bat|cmd|com|exe|ps1)$/i, "") ?? null;
}

function assignmentWord(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

const SUDO_OPTIONS = {
  shortValues: new Set(["C", "D", "g", "h", "p", "R", "r", "T", "t", "U", "u"]),
  longValues: new Set(["--chdir", "--chroot", "--close-from", "--group", "--host", "--other-user", "--prompt", "--role", "--type", "--user"]),
};
const ENV_OPTIONS = {
  shortValues: new Set(["C", "S", "u"]),
  longValues: new Set(["--chdir", "--split-string", "--unset"]),
};
const EXEC_OPTIONS = { shortValues: new Set(["a"]), longValues: new Set() };
const TIME_OPTIONS = { shortValues: new Set(["f", "o"]), longValues: new Set(["--format", "--output"]) };
const TIMEOUT_OPTIONS = { shortValues: new Set(["k", "s"]), longValues: new Set(["--kill-after", "--signal"]) };
const NICE_OPTIONS = { shortValues: new Set(["n"]), longValues: new Set(["--adjustment"]) };
const STDBUF_OPTIONS = { shortValues: new Set(["e", "i", "o"]), longValues: new Set(["--error", "--input", "--output"]) };
const XARGS_OPTIONS = {
  shortValues: new Set(["a", "d", "E", "I", "J", "L", "n", "P", "R", "S", "s"]),
  longValues: new Set(["--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars", "--max-lines", "--max-procs", "--process-slot-var", "--replace"]),
};
const NO_VALUE_OPTIONS = { shortValues: new Set(), longValues: new Set() };
const SHELL_CONTROL_PREFIXES = new Set(["!", "{", "do", "elif", "else", "if", "then", "until", "while"]);
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

function wrapperOptionsEndIndexes(words, start, { shortValues, longValues }) {
  const ends = new Set();
  const visited = new Set();
  const visit = (index) => {
    if (visited.has(index)) return;
    visited.add(index);
    if (index >= words.length) {
      ends.add(words.length);
      return;
    }
    const word = words[index];
    if (word === "--") {
      ends.add(index + 1);
      return;
    }
    if (/^--[^-]/.test(word)) {
      const name = word.split("=", 1)[0];
      if (word.includes("=")) visit(index + 1);
      else if (longValues.has(name)) visit(Math.min(index + 2, words.length));
      else {
        // Unknown wrapper options are the root ambiguity: they may be boolean
        // or consume the next word. Preserve both parses instead of silently
        // choosing one and calling the hidden command safe.
        visit(index + 1);
        visit(Math.min(index + 2, words.length));
      }
      return;
    }
    if (!/^-[^-]/.test(word)) {
      ends.add(index);
      return;
    }
    const cluster = word.slice(1);
    const valueOffset = [...cluster].findIndex((char) => shortValues.has(char));
    if (valueOffset >= 0) {
      visit(valueOffset === cluster.length - 1 ? Math.min(index + 2, words.length) : index + 1);
      return;
    }
    visit(index + 1);
    visit(Math.min(index + 2, words.length));
  };
  visit(start);
  return [...ends].sort((a, b) => a - b);
}

function envSplitWords(value) {
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  const flush = () => {
    if (started) words.push(current);
    current = "";
    started = false;
  };
  const escapes = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  const source = String(value);
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      else current += char;
      started = true;
      continue;
    }
    if (char === "\\" && source[index + 1] !== undefined) {
      const escaped = source[++index];
      if (escaped === "c") {
        flush();
        break;
      }
      if (escaped === "_") {
        if (quote === '"') {
          current += " ";
          started = true;
        } else flush();
        continue;
      }
      current += escapes[escaped] ?? escaped;
      started = true;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
    started = true;
  }
  flush();
  return words;
}

function envSplitStringWords(words, envIndex) {
  for (let index = envIndex + 1; index < words.length;) {
    const word = words[index];
    let value = null;
    let end = index + 1;
    if (word === "-S" || word === "--split-string") {
      value = words[index + 1] ?? "";
      end = index + 2;
    } else if (word.startsWith("-S") && word.length > 2) value = word.slice(2);
    else if (word.startsWith("--split-string=")) value = word.slice("--split-string=".length);
    if (value !== null) {
      // env owns a second parsing pass, including `\_` word separation and
      // `\c` termination. The outer shell has already removed only the quotes
      // that protected the complete split string.
      const split = envSplitWords(value);
      return ["env", ...split, ...words.slice(end)];
    }
    if (word === "-u" || word === "-C" || word === "--unset" || word === "--chdir") index += 2;
    else if (word.startsWith("-")) index += 1;
    else break;
  }
  return null;
}

function mergeCommandInvocationAnalyses(analyses, ambiguous = false) {
  const seen = new Set();
  const invocations = [];
  for (const analysis of analyses) {
    for (const invocation of analysis.invocations) {
      const key = JSON.stringify([invocation.tool, invocation.words]);
      if (seen.has(key)) continue;
      seen.add(key);
      invocations.push(invocation);
    }
  }
  return { invocations, ambiguous: ambiguous || analyses.some((analysis) => analysis.ambiguous) };
}

function commandInvocationAnalysisFromWords(words, start = 0, depth = 0) {
  if (depth >= 24) return { invocations: [], ambiguous: true };
  let index = start;
  while (SHELL_CONTROL_PREFIXES.has(words[index]?.toLowerCase())) index += 1;
  while (assignmentWord(words[index] ?? "")) index += 1;
  const tool = toolName(words[index]);
  if (!tool) return { invocations: [], ambiguous: false };
  if (tool === "command" && words.slice(index + 1).some((word) => /^-[^-]*[vV]/.test(word))) {
    return { invocations: [{ tool, words: words.slice(index + 1) }], ambiguous: false };
  }
  if (tool === "call") return commandInvocationAnalysisFromWords(words, index + 1, depth + 1);
  if (tool === "env") {
    const expanded = envSplitStringWords(words, index);
    if (expanded) return commandInvocationAnalysisFromWords(expanded, 0, depth + 1);
  }
  const grammar = tool === "exec" ? EXEC_OPTIONS
    : tool === "command" ? NO_VALUE_OPTIONS
      : tool === "sudo" ? SUDO_OPTIONS
        : tool === "env" ? ENV_OPTIONS
          : tool === "nohup" ? NO_VALUE_OPTIONS
            : tool === "time" ? TIME_OPTIONS
              : tool === "timeout" ? TIMEOUT_OPTIONS
                : tool === "nice" ? NICE_OPTIONS
                  : tool === "setsid" ? NO_VALUE_OPTIONS
                    : tool === "stdbuf" ? STDBUF_OPTIONS
                      : tool === "xargs" ? XARGS_OPTIONS
                        : null;
  if (!grammar) return { invocations: [{ tool, words: words.slice(index + 1) }], ambiguous: false };
  const ends = wrapperOptionsEndIndexes(words, index + 1, grammar);
  const analyses = ends.map((end) => {
    const commandIndex = tool === "timeout" ? Math.min(end + 1, words.length) : end;
    return commandInvocationAnalysisFromWords(words, commandIndex, depth + 1);
  });
  return mergeCommandInvocationAnalyses(analyses, ends.length > 1);
}

function commandInvocationsAnalysisFromWords(words) {
  const primary = commandInvocationAnalysisFromWords(words);
  const analyses = [primary];
  for (const invocation of primary.invocations) {
    if (invocation.tool !== "find") continue;
    for (let index = 0; index < invocation.words.length; index += 1) {
      if (!FIND_EXEC_ACTIONS.has(invocation.words[index])) continue;
      let end = index + 1;
      while (end < invocation.words.length && invocation.words[end] !== ";" && invocation.words[end] !== "+") end += 1;
      analyses.push(commandInvocationsAnalysisFromWords(invocation.words.slice(index + 1, end)));
      index = end;
    }
  }
  return mergeCommandInvocationAnalyses(analyses);
}

function windowsExecutableSyntax(value) {
  return /^\s*(?:"(?:[A-Za-z]:\\|\\\\)|(?:[A-Za-z]:\\|\\\\))/.test(String(value));
}

const POSIX_SHELL_COMMAND_TOOLS = new Set(["bash", "sh", "zsh"]);
const POWERSHELL_COMMAND_TOOLS = new Set(["powershell", "pwsh"]);
const BASH_LONG_VALUE_OPTIONS = new Set(["--init-file", "--rcfile"]);

function shellCommandBody(invocation) {
  if (invocation.tool === "cmd") {
    const bodyIndex = invocation.words.findIndex((word) => /^\/[ck]/i.test(word));
    if (bodyIndex < 0) return null;
    const attached = invocation.words[bodyIndex].slice(2);
    return [attached, ...invocation.words.slice(bodyIndex + 1)].filter(Boolean).join(" ");
  }
  if (POWERSHELL_COMMAND_TOOLS.has(invocation.tool)) {
    const bodyIndex = invocation.words.findIndex((word) => /^-(?:c|command|cwa|commandwithargs)$/i.test(word));
    return bodyIndex < 0 ? null : invocation.words.slice(bodyIndex + 1).join(" ");
  }
  if (POSIX_SHELL_COMMAND_TOOLS.has(invocation.tool)) {
    for (let index = 0; index < invocation.words.length;) {
      const word = invocation.words[index];
      if (word === "--") return null;
      if (!word.startsWith("-")) return null;
      if (/^-[^-]*c/.test(word)) return invocation.words[index + 1] ?? null;
      const longName = word.split("=", 1)[0];
      const longTakesValue = invocation.tool === "bash" && BASH_LONG_VALUE_OPTIONS.has(longName) && !word.includes("=");
      index += word === "-o" || word === "-O" || longTakesValue ? 2 : 1;
    }
  }
  return null;
}

function dollarSubstitutionBodies(value, dialect) {
  if (dialect === "cmd") return [];
  const raw = String(value);
  const bodies = [];
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (dialect === "powershell" && char === "`" && quote !== "'") {
      index += 1;
      continue;
    }
    if (dialect !== "powershell" && char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (quote === "'" || char !== "$" || raw[index + 1] !== "(") continue;
    let depth = 1;
    let nestedQuote = null;
    let cursor = index + 2;
    for (; cursor < raw.length && depth > 0; cursor += 1) {
      const nested = raw[cursor];
      const escaped = dialect === "powershell" ? "`" : "\\";
      if (nested === escaped && nestedQuote !== "'" && raw[cursor + 1] !== undefined) {
        cursor += 1;
        continue;
      }
      if ((nested === "'" || nested === '"') && (!nestedQuote || nestedQuote === nested)) {
        nestedQuote = nestedQuote ? null : nested;
        continue;
      }
      if (nestedQuote) continue;
      if (nested === "(") depth += 1;
      else if (nested === ")") depth -= 1;
    }
    if (depth === 0) {
      bodies.push(raw.slice(index + 2, cursor - 1));
      index = cursor - 1;
    }
  }
  return bodies;
}

function posixBacktickBodies(value, dialect) {
  if (dialect !== "portable" && dialect !== "posix") return [];
  const raw = String(value);
  const bodies = [];
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (quote === "'" || char !== "`") continue;
    let cursor = index + 1;
    for (; cursor < raw.length; cursor += 1) {
      if (raw[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (raw[cursor] === "`") break;
    }
    if (cursor < raw.length) {
      bodies.push(raw.slice(index + 1, cursor));
      index = cursor;
    }
  }
  return bodies;
}

function interpreterStdinDialect(invocation) {
  if (POWERSHELL_COMMAND_TOOLS.has(invocation.tool)) {
    const bodyIndex = invocation.words.findIndex((word) => /^-(?:c|command|cwa|commandwithargs|f|file)$/i.test(word));
    return bodyIndex >= 0 && invocation.words[bodyIndex + 1] === "-" ? "powershell" : null;
  }
  if (!POSIX_SHELL_COMMAND_TOOLS.has(invocation.tool) || shellCommandBody(invocation) !== null) return null;
  let stdin = false;
  for (let index = 0; index < invocation.words.length;) {
    const word = invocation.words[index];
    if (word === "--") return stdin || !invocation.words[index + 1] ? "posix" : null;
    if (!word.startsWith("-")) return stdin ? "posix" : null;
    if (/^-[^-]*s/.test(word)) stdin = true;
    const longName = word.split("=", 1)[0];
    const longTakesValue = invocation.tool === "bash" && BASH_LONG_VALUE_OPTIONS.has(longName) && !word.includes("=");
    index += word === "-o" || word === "-O" || longTakesValue ? 2 : 1;
  }
  return "posix";
}

function invocationExecutesTool(invocation, tools, seen = new Set()) {
  if (tools.has(invocation.tool)) return true;
  const nested = invocation.nestedSource;
  if (!nested || seen.has(nested)) return false;
  seen.add(nested);
  return nested.chains.some((chain) => chain.parts.some((part) => (
    part.invocations.some((candidate) => invocationExecutesTool(candidate, tools, seen))
  )));
}

function partExecutesTool(part, tools) {
  return part.invocations.some((invocation) => invocationExecutesTool(invocation, tools));
}

function effectiveStdinRedirection(part) {
  return part.redirections.filter((redirection) => (
    redirection.fd === "0" && ["<", "<<", "<<-", "<<<", "<&", "<>"].includes(redirection.operator)
  )).at(-1) ?? null;
}

function staticStdinBody(redirection) {
  if (!redirection) return null;
  if ((redirection.operator === "<<" || redirection.operator === "<<-") && redirection.heredoc?.closed) return redirection.heredoc.body;
  if (redirection.operator === "<<<" && !/[$`]/.test(redirection.target)) return redirection.target;
  return null;
}

function invocationConsumesStdin(invocation, seen = new Set()) {
  if (interpreterStdinDialect(invocation)) return true;
  const nested = invocation.nestedSource;
  if (!nested || seen.has(nested)) return false;
  seen.add(nested);
  return nested.chains.some((chain) => chain.parts.some((part) => part.invocations.some((candidate) => invocationConsumesStdin(candidate, seen))));
}

function partConsumesStdin(part) {
  return part.invocations.some((invocation) => invocationConsumesStdin(invocation));
}

// Parse each executable view once. Every effect projector consumes this IR so
// dialect decoding, nested interpreters, separators, wrapper resolution, and
// ambiguity cannot drift between owner, git, risk, and foreign-session gates.
function commandStructuralAnalysis(command, { dialect = "portable" } = {}) {
  const sources = [];
  const sourceByKey = new Map();
  const sourceKeys = new Set();
  const viewKeys = new Set();
  const views = [];
  const chains = [];
  const enqueue = (source, sourceDialect, kind = "root") => {
    const text = String(source ?? "");
    if (!text) return;
    const key = JSON.stringify([text, sourceDialect, kind]);
    if (sourceKeys.has(key)) return sourceByKey.get(key);
    sourceKeys.add(key);
    const record = { source: text, dialect: sourceDialect, kind, chains: [] };
    sourceByKey.set(key, record);
    sources.push(record);
    return record;
  };
  if (dialect === "portable") {
    const candidates = windowsExecutableSyntax(command) ? ["cmd", "powershell"] : ["posix", "cmd", "powershell"];
    for (const candidate of candidates) enqueue(command, candidate);
  } else enqueue(command, dialect);
  for (let cursor = 0; cursor < sources.length; cursor += 1) {
    const source = sources[cursor];
    const parsed = commandSource(source.source, source.dialect);
    source.syntax = parsed.syntax;
    for (const body of dollarSubstitutionBodies(parsed.syntax, source.dialect)) enqueue(body, source.dialect, "command-body");
    for (const body of posixBacktickBodies(parsed.syntax, source.dialect)) enqueue(body, "posix", "command-body");
    const text = parsed.syntax;
    if (!text) continue;
    const viewKey = JSON.stringify([text, source.dialect]);
    if (viewKeys.has(viewKey)) continue;
    viewKeys.add(viewKey);
    views.push(text);
    const parts = commandParts(text, source.dialect, parsed.heredocs).map((part) => {
      const invocationAnalysis = commandInvocationsAnalysisFromWords(part.words);
      return {
        ...part,
        dialect: source.dialect,
        heredocs: part.redirections.flatMap((redirection) => redirection.heredoc ? [redirection.heredoc] : []),
        dynamicExec: false,
        invocations: invocationAnalysis.invocations,
        ambiguous: invocationAnalysis.ambiguous,
      };
    });
    if (parts.length) {
      const chain = { dialect: source.dialect, parts };
      chains.push(chain);
      source.chains.push(chain);
    }
    for (const part of parts) {
      for (const invocation of part.invocations) {
        if (
          POWERSHELL_COMMAND_TOOLS.has(invocation.tool) &&
          invocation.words.some((word) => /^-e(?:n(?:c(?:odedcommand)?)?)?$/i.test(word))
        ) part.dynamicExec = true;
        const body = shellCommandBody(invocation);
        const bodyDialect = invocation.tool === "cmd" ? "cmd"
          : POWERSHELL_COMMAND_TOOLS.has(invocation.tool) ? "powershell"
            : POSIX_SHELL_COMMAND_TOOLS.has(invocation.tool) ? "posix"
              : source.dialect;
        if (body && body !== "-") invocation.nestedSource = enqueue(body, bodyDialect, "command-body");
        if (interpreterStdinDialect(invocation)) {
          const stdinBody = staticStdinBody(effectiveStdinRedirection(part));
          if (stdinBody !== null) invocation.nestedSource = enqueue(stdinBody, bodyDialect, "static-code");
        }
      }
    }
    for (let index = 0; index + 1 < parts.length; index += 1) {
      if (parts[index].separator !== "|" && parts[index].separator !== "|&") continue;
      for (const invocation of parts[index + 1].invocations) {
        const stdinDialect = interpreterStdinDialect(invocation);
        if (!stdinDialect) continue;
        if (effectiveStdinRedirection(parts[index + 1])) continue;
        const stdinBody = partExecutesTool(parts[index], new Set(["cat"]))
          ? staticStdinBody(effectiveStdinRedirection(parts[index]))
          : null;
        if (stdinBody !== null) invocation.nestedSource = enqueue(stdinBody, stdinDialect, "static-code");
      }
    }
    if (source.dialect === "cmd") {
      for (const part of parts) {
        const first = toolName(part.words[0]);
        const forF = part.words.some((word, index) => word.toLowerCase() === "for" && /^\/f$/i.test(part.words[index + 1] ?? ""));
        if ((first === "for" || first === "if") && forF) part.dynamicExec = true;
      }
    }
  }
  for (const source of sources) {
    for (const chain of source.chains) {
      for (let index = 0; index < chain.parts.length; index += 1) {
        const part = chain.parts[index];
        if (!partConsumesStdin(part)) continue;
        const stdin = effectiveStdinRedirection(part);
        const incomingPipe = index > 0 && (chain.parts[index - 1].separator === "|" || chain.parts[index - 1].separator === "|&");
        if (stdin && staticStdinBody(stdin) === null) part.dynamicExec = true;
        else if (!stdin && !incomingPipe && source.kind !== "command-body") part.dynamicExec = true;
        else if (!stdin && incomingPipe) {
          const previous = chain.parts[index - 1];
          const staticPipe = partExecutesTool(previous, new Set(["cat"])) && staticStdinBody(effectiveStdinRedirection(previous)) !== null;
          if (!staticPipe && !partExecutesTool(previous, REMOTE_SOURCE_TOOLS)) part.dynamicExec = true;
        }
      }
    }
  }
  return {
    rootView: sources[0]?.syntax ?? "",
    views: [...new Set(views)],
    chains,
    sources,
    segments: chains.flatMap((chain) => chain.parts),
  };
}

// The first word that is neither an option nor an option's value. `--opt=value`
// carries its own; the listed options consume the next word.
function optionsEndIndexes(words, valueOptions, optionalValueOptions = null) {
  const ends = new Set();
  const visited = new Set();
  const visit = (index) => {
    if (visited.has(index)) return;
    visited.add(index);
    if (index >= words.length) {
      ends.add(words.length);
      return;
    }
    const word = words[index];
    if (!word.startsWith("-")) {
      ends.add(index);
      return;
    }
    if (word === "--") {
      ends.add(index + 1);
      return;
    }
    const longName = word.split("=", 1)[0];
    const optionalValues = optionalValueOptions?.get(longName);
    if (optionalValues) {
      const next = words[index + 1]?.toLowerCase();
      visit(!word.includes("=") && optionalValues.has(next) ? Math.min(index + 2, words.length) : index + 1);
      return;
    }
    const shortOption = word.slice(0, 2);
    const attachedShortValue = word.length > 2 && valueOptions.has(shortOption);
    if (word.includes("=") || attachedShortValue) {
      visit(index + 1);
      return;
    }
    if (valueOptions.has(word)) {
      visit(Math.min(index + 2, words.length));
      return;
    }
    // Unknown tool options have the same arity ambiguity as wrapper options.
    // Keep both candidates; effect classification consumes their union.
    visit(index + 1);
    visit(Math.min(index + 2, words.length));
  };
  visit(0);
  return [...ends].sort((a, b) => a - b);
}

// A gate that names the tool it fears can find that tool wherever the shell put
// it: behind `nohup`, past a `timeout` duration, inside `find -exec`. That reach
// is what the pre-structural regexes had by scanning raw text, and the tool name
// is the anchor that keeps the scan from reading an operand as a command. Find
// actions and documented wrappers expose a nested command position; arbitrary
// operands do not.
// A text tool's arguments are data, not instructions: `echo rm -rf x` prints a
// string and deletes nothing, and pricing it as destructive would put a critical
// floor on an echo. A real command after `&&` or `;` starts its own segment, so
// anchoring every shape scanner on the segment's command-position tool (via
// fixedToolInvocations) costs no reach.
function fixedToolInvocations(segment, tools) {
  return segment.invocations.filter((invocation) => tools.has(invocation.tool));
}

function gitSubcommandsAt(words) {
  return optionsEndIndexes(words, GIT_GLOBAL_VALUE_OPTIONS).map((index) => ({
    words,
    index,
    subcommand: words[index]?.toLowerCase() ?? null,
  }));
}

const GIT_TOOL = new Set(["git"]);

// The one place that decides what a shell segment told git to do. The envelope's
// per-operation authorization, the irreversible-shape floor, and the
// foreign-session read-only test must never disagree about that.
function gitSubcommandsFromStructure(structure) {
  const found = new Set();
  for (const segment of structure.segments) {
    for (const invocation of fixedToolInvocations(segment, GIT_TOOL)) {
      for (const { subcommand } of gitSubcommandsAt(invocation.words)) {
        if (subcommand) found.add(subcommand);
      }
    }
  }
  return found;
}

function gitOps(mapping, options = {}) {
  return (options.callAnalysis ?? analyzeToolCall(options.tool, mapping, options)).git.ops;
}

// Effect-verb shapes announce an external, often irreversible publication
// (tool + publish|deploy|release|push|upload). Matching the announced verb
// rather than an enumerated tool list keeps the class ecosystem-agnostic;
// git push stays with per-operation git authorization, text/shell tools are
// exempt, and word collisions deny recoverably while known wrappers resolve to
// the command they execute.
const PUBLISH_VERBS = new Set(["publish", "deploy", "release", "push", "upload"]);
const GH_CREATE_SCOPES = new Set(["pr", "issue", "release"]);
const GH_GLOBAL_VALUE_OPTIONS = new Set(["-R", "--hostname", "--repo"]);
const PUBLISH_EXEMPT_TOOLS = new Set(["git", "cp", "mv", "tar", "echo", "printf", "cat", "grep", "rg", "sed", "awk", "head", "tail", "less", "more", "ls", "man", "which", "find", "test"]);

// The verb sits at the subcommand position, not at a fixed offset after the
// tool: `npm --registry=<url> publish` publishes exactly as `npm publish` does,
// and the option that moves the destination is the one most worth reading.
// Reading the position rather than scanning every word is what keeps
// `kubectl get deploy` and `cp -r build deploy` reads — there the verb word is
// an operand, not the instruction.
const SUBCOMMAND_VALUE_OPTIONS = new Set([
  "-C", "-c", "--prefix", "--registry", "--userconfig",
  "--globalconfig", "--cache", "--otp", "--tag", "--access", "--config", "--cwd",
]);
const NPM_DOCUMENTED_VALUE_OPTIONS = new Set(`
  --_auth --access --allow-git --also --audit-level --auth-type --before --browser --ca
  --cache --cache-max --cache-min --cafile --call --cert --cidr --cpu --depth
  --diff --diff-dst-prefix --diff-src-prefix --diff-unified --editor
  --expect-result-count --expires --fetch-retries --fetch-retry-factor
  --fetch-retry-maxtimeout --fetch-retry-mintimeout --fetch-timeout --git
  --globalconfig --heading --https-proxy --include --init-author-email
  --init-author-name --init-author-url --init-license --init-module --init-type
  --init-version --init.author.email --init.author.name --init.author.url
  --init.license --init.module --init.version --install-strategy --key --libc
  --local-address --location --lockfile-version --loglevel --logs-dir --logs-max
  --name --maxsockets --message --min-release-age --node-gyp --node-options
  --noproxy --omit --only --orgs --os --otp --package --pack-destination
  --packages --prefix --preid --provenance-file --proxy --registry
  --replace-registry-host --save-prefix --sbom-format --sbom-type --scope
  --scopes --packages-and-scopes-permission --orgs-permission --password
  --token-description --script-shell --searchexclude --searchlimit --searchopts
  --searchstaleness --shell --tag --tag-version-prefix --umask --user-agent
  --userconfig --viewer --which --workspace
`.trim().split(/\s+/));
const PIP_DOCUMENTED_VALUE_OPTIONS = new Set([
  "--python", "--log", "--keyring-provider", "--proxy", "--retries", "--timeout",
  "--exists-action", "--trusted-host", "--cert", "--client-cert", "--cache-dir",
  "--use-feature", "--use-deprecated", "--resume-retries",
]);
const NPM_OPTIONAL_VALUE_OPTIONS = new Map([
  ["--color", new Set(["always", "false", "true"])],
]);
// `-w` is not portable across the install tools: npm's takes a workspace name,
// while pnpm's `-w`/`--workspace-root` is a boolean. Consuming the next word for
// pnpm would eat the subcommand and read `pnpm -w add lodash` as no install.
const NPM_SUBCOMMAND_VALUE_OPTIONS = new Set([...SUBCOMMAND_VALUE_OPTIONS, ...NPM_DOCUMENTED_VALUE_OPTIONS, "-w", "--workspace"]);
const PNPM_SUBCOMMAND_VALUE_OPTIONS = new Set([...SUBCOMMAND_VALUE_OPTIONS, "--filter", "-F"]);
const PIP_SUBCOMMAND_VALUE_OPTIONS = new Set([...SUBCOMMAND_VALUE_OPTIONS, ...PIP_DOCUMENTED_VALUE_OPTIONS]);
// A monorepo scopes the real verb behind a package selector:
// `yarn workspace <pkg> publish` publishes exactly what `yarn publish` does.
// These are the documented way to release one package, not an obscure spelling.
const WORKSPACE_SCOPES = new Set(["workspace", "workspaces"]);

function toolSubcommandAnalysis(invocation) {
  const options = invocation.tool === "npm" ? NPM_SUBCOMMAND_VALUE_OPTIONS
    : invocation.tool === "pnpm" ? PNPM_SUBCOMMAND_VALUE_OPTIONS
      : PIP_TOOLS.has(invocation.tool) ? PIP_SUBCOMMAND_VALUE_OPTIONS
      : SUBCOMMAND_VALUE_OPTIONS;
  const found = new Set();
  let ambiguous = false;
  const visit = (words, scope) => {
    if (scope >= 3) return;
    const optionalValues = invocation.tool === "npm" ? NPM_OPTIONAL_VALUE_OPTIONS : null;
    const indexes = optionsEndIndexes(words, options, optionalValues);
    if (indexes.length > 1) ambiguous = true;
    for (const index of indexes) {
      const word = words[index]?.toLowerCase() ?? null;
      if (WORKSPACE_SCOPES.has(word)) visit(words.slice(index + 2), scope + 1);
      else if (word) found.add(word);
    }
  };
  visit(invocation.words, 0);
  return { subcommands: found, ambiguous };
}

function toolSubcommands(invocation) {
  return toolSubcommandAnalysis(invocation).subcommands;
}

function publishShapeFromStructure(structure) {
  for (const segment of structure.segments) {
    for (const invocation of segment.invocations) {
      const ghIndexes = invocation.tool === "gh" ? optionsEndIndexes(invocation.words, GH_GLOBAL_VALUE_OPTIONS) : [];
      if (ghIndexes.some((index) => GH_CREATE_SCOPES.has(invocation.words[index]?.toLowerCase()) && invocation.words[index + 1]?.toLowerCase() === "create")) return true;
      if (PUBLISH_EXEMPT_TOOLS.has(invocation.tool)) continue;
      if ([...toolSubcommands(invocation)].some((subcommand) => PUBLISH_VERBS.has(subcommand))) return true;
    }
  }
  return false;
}

const INSTALL_TOOLS = new Set(["npm", "pnpm", "yarn", "bun"]);
// `ci` installs the whole lockfile tree: the same supply-chain reach as
// `install`, and the spelling CI documentation teaches first.
const INSTALL_SUBCOMMANDS = new Set(["i", "install", "add", "ci"]);
const PIP_TOOLS = new Set(["pip", "pip3"]);
const PYTHON_TOOL_RE = /^(?:py|python(?:\d+(?:\.\d+)*)?)$/;

const INSTALL_ALL_TOOLS = new Set([...INSTALL_TOOLS, ...PIP_TOOLS]);

function pythonModuleInvocation(words) {
  // Python permits boolean short options to cluster before `m`: `-Im pip` is
  // the isolated-mode spelling of `-I -m pip`. Value-taking options such as
  // `-W` and `-X` are intentionally absent so their attached values cannot be
  // mistaken for module execution.
  for (let index = 0; index < words.length; index += 1) {
    if (!/^-[bBdEIOPqRsSuvx]*m$/.test(words[index])) continue;
    const module = words[index + 1]?.toLowerCase() ?? null;
    return { module, words: words.slice(index + 2) };
  }
  return null;
}

function installShapeFromStructure(structure) {
  for (const segment of structure.segments) {
    for (const invocation of fixedToolInvocations(segment, INSTALL_ALL_TOOLS)) {
      const subcommands = toolSubcommands(invocation);
      if (INSTALL_TOOLS.has(invocation.tool) && [...subcommands].some((subcommand) => INSTALL_SUBCOMMANDS.has(subcommand))) return true;
      if (PIP_TOOLS.has(invocation.tool) && subcommands.has("install")) return true;
    }
    for (const invocation of segment.invocations) {
      if (!PYTHON_TOOL_RE.test(invocation.tool)) continue;
      const moduleInvocation = pythonModuleInvocation(invocation.words);
      if (!moduleInvocation || !PIP_TOOLS.has(moduleInvocation.module)) continue;
      if (toolSubcommands({ tool: "pip", words: moduleInvocation.words }).has("install")) return true;
    }
  }
  return false;
}

const LOCAL_WRITE_TOOLS = new Set(["cp", "mkdir", "mv", "rm", "tee", "touch"]);

function localCommandWriteFromStructure(structure) {
  for (const segment of structure.segments) {
    for (const invocation of segment.invocations) {
      if (LOCAL_WRITE_TOOLS.has(invocation.tool)) return true;
      if (invocation.tool === "sed" && invocation.words.some((word) => /^-i(?:$|[^-])|^--in-place(?:=|$)/.test(word))) return true;
    }
  }
  return false;
}

// A short cluster is a letter bag, not an ordered list: `-v -rf`, `-rf`, and
// `-fr` delete identically, and rm applies the later -f over an earlier -i.
// Long options are whole words — `--one-file-system` is not a force flag.
const RM_DESTRUCTIVE_LONG = new Set(["--recursive", "--force", "--dir"]);
// The SQL keywords are spelled with an inert group (`DR(?:OP)` matches exactly
// DROP) so the complete statement text never appears in this source: word-level
// danger scanners — including a supervised session editing this very file —
// must not read the detector as the thing it detects.
const SQL_DESTRUCTIVE_RE = /\b(DR(?:OP)\s+TABLE|TRUN(?:CATE)|DEL(?:ETE)\s+FROM)\b/i;
const SQL_WRITE_RE = /\b(INS(?:ERT)\s+INTO|UPD(?:ATE)\s+\w+\s+SET|DEL(?:ETE)\s+FROM|DR(?:OP)\s+TABLE|TRUN(?:CATE))\b/i;
const SQL_CLIENT_TOOLS = new Set(["duckdb", "mariadb", "mysql", "psql", "sqlite3", "sqlcmd"]);
const SQL_ATTACHED_COMMAND_OPTIONS = new Map([
  ["duckdb", ["-c"]],
  ["mariadb", ["-e", "--execute="]],
  ["mysql", ["-e", "--execute="]],
  ["psql", ["-c", "--command="]],
  ["sqlcmd", ["-Q", "-q"]],
]);

function rmIsDestructive(words) {
  for (const word of words) {
    if (word === "--") break;
    if (word.startsWith("--")) {
      if (RM_DESTRUCTIVE_LONG.has(word.toLowerCase())) return true;
      continue;
    }
    if (word.length > 1 && word.startsWith("-") && /[rRf]/.test(word.slice(1))) return true;
  }
  return false;
}

const DESTRUCTIVE_TOOLS = new Set(["rm", "find", "git"]);

function sqlInvocationText(invocation) {
  const prefixes = SQL_ATTACHED_COMMAND_OPTIONS.get(invocation.tool) ?? [];
  return invocation.words.map((word) => {
    const prefix = prefixes.find((candidate) => word.startsWith(candidate) && word.length > candidate.length);
    return prefix ? `${prefix} ${word.slice(prefix.length)}` : word;
  }).join(" ");
}

function sqlInputMatches(structure, statementPattern) {
  for (const chain of structure.chains) {
    for (let index = 0; index < chain.parts.length; index += 1) {
      const part = chain.parts[index];
      const sqlInvocations = part.invocations.filter((invocation) => invocationExecutesTool(invocation, SQL_CLIENT_TOOLS));
      if (sqlInvocations.some((invocation) => statementPattern.test(sqlInvocationText(invocation)))) return true;
      if (!partExecutesTool(part, SQL_CLIENT_TOOLS)) continue;
      const directStdin = effectiveStdinRedirection(part);
      if (directStdin?.heredoc && statementPattern.test(directStdin.heredoc.body)) return true;
      for (let source = index - 1; source >= 0 && (chain.parts[source].separator === "|" || chain.parts[source].separator === "|&"); source -= 1) {
        const input = chain.parts[source];
        const pipedStdin = effectiveStdinRedirection(input);
        if (statementPattern.test(input.text) || (pipedStdin?.heredoc && statementPattern.test(pipedStdin.heredoc.body))) return true;
      }
    }
  }
  return false;
}

function destructiveShapeFromStructure(structure) {
  if (sqlInputMatches(structure, SQL_DESTRUCTIVE_RE)) return true;
  for (const segment of structure.segments) {
    for (const invocation of fixedToolInvocations(segment, DESTRUCTIVE_TOOLS)) {
      if (invocation.tool === "rm" && rmIsDestructive(invocation.words)) return true;
      if (invocation.tool === "find" && invocation.words.includes("-delete")) return true;
      if (invocation.tool === "git" && gitSubcommandsAt(invocation.words).some(({ subcommand }) => subcommand === "clean")) return true;
    }
  }
  return false;
}

// A path-scoped destructive grant can only be judged when every destructive
// contributor names enumerable targets. rm is the one modeled shape: find
// -delete walks a subtree the analyzer does not enumerate, git clean is the
// git classifier's territory, and SQL destruction has no filesystem target at
// all — each marks the command unscopeable so the scoped gate fails closed.
// Every rm invocation this misses must also be missed by
// destructiveShapeFromStructure, and vice versa, or scope and shape disagree.
function destructiveTargetsFromStructure(structure) {
  if (sqlInputMatches(structure, SQL_DESTRUCTIVE_RE)) return { scopeable: false, targets: [] };
  const targets = new Set();
  let scopeable = true;
  for (const chain of structure.chains) {
    const directories = chainWorkingDirectories(chain);
    for (let index = 0; index < chain.parts.length; index += 1) {
      for (const invocation of fixedToolInvocations(chain.parts[index], DESTRUCTIVE_TOOLS)) {
        if (invocation.tool === "rm" && rmIsDestructive(invocation.words)) {
          const extracted = extractWriteOperands("rm", invocation.words);
          if (!extracted.enumerable) { scopeable = false; continue; }
          for (const destination of extracted.destinations) targets.add(resolveShellTarget(directories[index], destination, chain.dialect));
          continue;
        }
        if (invocation.tool === "find" && invocation.words.includes("-delete")) scopeable = false;
        if (invocation.tool === "git" && gitSubcommandsAt(invocation.words).some(({ subcommand }) => subcommand === "clean")) scopeable = false;
      }
    }
  }
  return { scopeable, targets: [...targets] };
}

// Command-level safety, evaluated on EVERY command-bearing call before the
// write-shaped short-circuit: remote-exec, network, install, secret-dump, and
// destructive commands are dangerous whether or not they touch a tracked file.
// Conservative by design (a shell can always obscure intent via variables) and
// collaborative — it raises the cost of the obvious dangerous forms, it is not
// a sandbox. Reads and verification runs match none of these.

function commandAnalysisIsAmbiguous(structure) {
  for (const segment of structure.segments) {
    if (segment.ambiguous) return true;
    for (const invocation of segment.invocations) {
      if (invocation.tool === "git" && gitSubcommandsAt(invocation.words).length > 1) return true;
      const subcommands = toolSubcommandAnalysis(invocation);
      if (subcommands.ambiguous || subcommands.subcommands.size > 1) return true;
    }
  }
  return false;
}

function commandDialect({ dialect = null, tool = null } = {}, command = "") {
  if (new Set(["cmd", "portable", "posix", "powershell"]).has(dialect)) return dialect;
  const compactTool = String(tool ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compactTool.includes("powershell") || compactTool === "pwsh") return "powershell";
  if (compactTool === "cmd" || compactTool === "cmdexe") return "cmd";
  if (compactTool.includes("bash") || compactTool.includes("zsh") || compactTool === "sh") return "posix";
  if (compactTool.includes("shell")) return process.platform === "win32" ? "powershell" : "posix";
  if (tool) return process.platform === "win32" ? "powershell" : "posix";
  return windowsExecutableSyntax(command) ? "cmd" : "posix";
}

function analyzeCommand(command, options = {}) {
  const raw = String(command);
  const parserOptions = { dialect: commandDialect(options, raw) };
  const structure = commandStructuralAnalysis(raw, parserOptions);
  const rootView = structure.rootView;
  const gitSubcommands = gitSubcommandsFromStructure(structure);
  const network = networkAnalysisFromStructure(structure);
  const localWrite = sqlInputMatches(structure, SQL_WRITE_RE) || localCommandWriteFromStructure(structure);
  const effects = new Set(network.effects);
  if (structure.segments.some((segment) => segment.dynamicExec)) effects.add("dynamic_exec");
  if (installShapeFromStructure(structure)) effects.add("install");
  if (publishShapeFromStructure(structure)) effects.add("publish");
  if (secretDumpShapeFromStructure(structure)) effects.add("secret_dump");
  if (destructiveShapeFromStructure(structure)) effects.add("destructive");
  if (gitSubcommands.has("push")) effects.add("git_push");
  return {
    resolution: commandAnalysisIsAmbiguous(structure) ? "ambiguous" : "resolved",
    dialect: parserOptions.dialect,
    effects: [...effects],
    shapes: ["publish", "git_push", "destructive", "network", "network_write", "install", "dynamic_exec"].filter((shape) => effects.has(shape)),
    git: {
      subcommands: [...gitSubcommands],
      ops: [...gitSubcommands].filter((subcommand) => GIT_WRITE_SUBCOMMANDS.has(subcommand)),
      readonly: gitSubcommands.size === 0 || gitReadonlyFromStructure(structure),
    },
    network: {
      unresolvedWrite: network.unresolvedWrite,
      targets: network.targets,
    },
    local: {
      write: localWrite,
      targets: localTargetsFromStructure(structure),
      destinations: localWriteDestinations(structure),
      destructive: effects.has("destructive") ? destructiveTargetsFromStructure(structure) : { scopeable: true, targets: [] },
    },
    execution: {
      views: [
        stripQuotedSegments(rootView),
        ...structure.views.filter((view) => view !== rootView),
      ],
    },
  };
}

function analyzeToolCall(tool, mapping, options = {}) {
  const commands = commandValues(mapping).map((command) => ({
    command,
    analysis: analyzeCommand(command, { ...options, tool }),
  }));
  return {
    commands,
    effects: [...new Set(commands.flatMap(({ analysis }) => analysis.effects))],
    shapes: [...new Set(commands.flatMap(({ analysis }) => analysis.shapes))],
    git: {
      ops: [...new Set(commands.flatMap(({ analysis }) => analysis.git.ops))],
    },
  };
}

const NETWORK_TOOLS = new Set(["curl", "invoke-webrequest", "iwr", "wget"]);
const REMOTE_SOURCE_TOOLS = new Set([...NETWORK_TOOLS, "fetch"]);
const REMOTE_EXEC_TOOLS = new Set(["bash", "node", "python", "python2", "python3", "sh", "zsh"]);
const CURL_SHORT_VALUE_OPTIONS = new Set(["A", "b", "c", "C", "d", "D", "e", "E", "F", "h", "H", "K", "m", "P", "Q", "r", "t", "T", "u", "U", "w", "x", "X", "y", "Y", "z"]);
const WGET_SHORT_VALUE_OPTIONS = new Set([..."aABeiIlOPQRtTUwWXY"]);
const CURL_FILE_SHORT_OPTIONS = new Set(["c", "D", "o"]);
const CURL_FILE_LONG_OPTIONS = new Set(["--alt-svc", "--cookie-jar", "--dump-header", "--hsts", "--output", "--stderr", "--trace", "--trace-ascii"]);
const WGET_FILE_SHORT_OPTIONS = new Set(["a", "o"]);
const WGET_FILE_LONG_OPTIONS = new Set(["--append-output", "--hsts-file", "--output-file", "--warc-cdx", "--warc-file"]);

function fileOutputTarget(value) {
  const target = String(value ?? "");
  return target && target !== "-" && !target.startsWith("/dev/") && !/^NUL$/i.test(target) ? target : null;
}

function redirectionTargetsFromPart(part) {
  const outputOperators = new Set([">", ">>", "&>", "&>>", "*>", "*>>", ">&", "<>"]);
  return part.redirections.flatMap((redirection) => (
    outputOperators.has(redirection.operator) && !redirection.descriptorTarget && fileOutputTarget(redirection.target)
      ? [redirection.target]
      : []
  ));
}

function partCdTarget(part) {
  const tool = toolName(part.words[0]);
  if (tool === "cd") {
    const operands = part.words.slice(1).filter((word) => word !== "--" && !/^\/d$/i.test(word));
    return operands[0] ?? null;
  }
  if (tool === "set-location" || tool === "sl") {
    const pathIndex = part.words.findIndex((word) => /^-(?:path|literalpath)$/i.test(word));
    return pathIndex >= 0 ? part.words[pathIndex + 1] ?? null : part.words[1] ?? null;
  }
  return null;
}

function resolveShellTarget(cwd, target, dialect) {
  const value = String(target ?? "");
  if (!value || /[$`*?\[\]{}]/.test(value)) return value;
  const windows = dialect === "cmd" || dialect === "powershell";
  if (windows && (path.win32.isAbsolute(value) || path.win32.isAbsolute(cwd))) {
    return path.win32.normalize(path.win32.isAbsolute(value) ? value : path.win32.join(cwd, value));
  }
  const normalizedCwd = windows ? cwd.replaceAll("\\", "/") : cwd;
  const normalizedValue = windows ? value.replaceAll("\\", "/") : value;
  if (path.posix.isAbsolute(normalizedValue)) return path.posix.normalize(normalizedValue);
  return path.posix.normalize(path.posix.join(normalizedCwd, normalizedValue));
}

function chainWorkingDirectories(chain) {
  const directories = [];
  let cwd = ".";
  for (const part of chain.parts) {
    directories.push(cwd);
    if (part.separator === "|" || part.separator === "|&") continue;
    const target = partCdTarget(part);
    if (target) cwd = resolveShellTarget(cwd, target, chain.dialect);
  }
  return directories;
}

function localTargetsFromStructure(structure) {
  const targets = new Set();
  for (const chain of structure.chains) {
    const directories = chainWorkingDirectories(chain);
    for (let index = 0; index < chain.parts.length; index += 1) {
      for (const target of redirectionTargetsFromPart(chain.parts[index])) {
        targets.add(resolveShellTarget(directories[index], target, chain.dialect));
      }
    }
  }
  return [...targets];
}

// The local writers name their destination in an operand, not a redirection, so
// localTargetsFromStructure never sees it. Parsing that destination is what lets
// a foreign session's cross-repo `cp`/`rm`/`mv` resolve instead of denying as
// unprovable. It is security-sensitive: a destination we fail to enumerate must
// deny, never silently allow. Every grammar we do not model returns
// enumerable:false so the caller fails closed rather than guessing a path.
//
// dest "last": the final operand is the destination, earlier operands are read
// sources. dest "all": every operand is itself written. A recursive copy writes
// an unbounded subtree we do not enumerate, so it fails closed. targetDirOpts
// move the destination to their value (cp/mv -t DIR); valueOpts consume the next
// word so a flag value is never read as a path.
function writeToolProfile(tool) {
  switch (tool) {
    case "cp": return { dest: "last", recursiveShort: "rRa", longRecursive: new Set(["--recursive", "--archive", "--dereference-recursive"]), valueShort: new Set(["S"]), targetDirShort: new Set(["t"]), longValue: new Set(["--suffix"]), longTargetDir: new Set(["--target-directory"]) };
    case "mv": return { dest: "last", recursiveShort: "", longRecursive: new Set(), valueShort: new Set(["S"]), targetDirShort: new Set(["t"]), longValue: new Set(["--suffix"]), longTargetDir: new Set(["--target-directory"]) };
    case "rm": return { dest: "all", recursiveShort: "", longRecursive: new Set(), valueShort: new Set(), targetDirShort: new Set(), longValue: new Set(), longTargetDir: new Set() };
    case "tee": return { dest: "all", recursiveShort: "", longRecursive: new Set(), valueShort: new Set(), targetDirShort: new Set(), longValue: new Set(), longTargetDir: new Set() };
    case "mkdir": return { dest: "all", recursiveShort: "", longRecursive: new Set(), valueShort: new Set(["m", "Z"]), targetDirShort: new Set(), longValue: new Set(["--mode", "--context"]), longTargetDir: new Set() };
    case "touch": return { dest: "all", recursiveShort: "", longRecursive: new Set(), valueShort: new Set(["d", "r", "t"]), targetDirShort: new Set(), longValue: new Set(["--date", "--reference", "--time"]), longTargetDir: new Set() };
    default: return null;
  }
}

function extractWriteOperands(tool, words) {
  const spec = writeToolProfile(tool);
  if (!spec) return { enumerable: false, destinations: [] };
  const failClosed = { enumerable: false, destinations: [] };
  const operands = [];
  let targetDir = null;
  let recursive = false;
  let terminated = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!terminated && word === "--") { terminated = true; continue; }
    if (terminated || word === "-" || !word.startsWith("-")) { operands.push(word); continue; }
    if (word.startsWith("--")) {
      const name = word.split("=", 1)[0];
      const hasEquals = word.includes("=");
      if (spec.longTargetDir.has(name)) { const value = hasEquals ? word.slice(name.length + 1) : words[index += 1]; if (value === undefined) return failClosed; targetDir = value; continue; }
      if (spec.longRecursive.has(name)) { recursive = true; continue; }
      if (spec.longValue.has(name)) { if (!hasEquals && words[index += 1] === undefined) return failClosed; continue; }
      continue;
    }
    const letters = word.slice(1);
    if (letters.length === 1 && spec.targetDirShort.has(letters)) { const value = words[index += 1]; if (value === undefined) return failClosed; targetDir = value; continue; }
    if (letters.length === 1 && spec.valueShort.has(letters)) { if (words[index += 1] === undefined) return failClosed; continue; }
    // A multi-letter cluster carrying a value or target-directory letter cannot be
    // positioned without the tool's full getopt rules; deny rather than misread it.
    if ([...letters].some((letter) => spec.valueShort.has(letter) || spec.targetDirShort.has(letter))) return failClosed;
    if ([...letters].some((letter) => spec.recursiveShort.includes(letter))) recursive = true;
  }
  if (recursive) return failClosed;
  if (targetDir !== null) return { enumerable: true, destinations: [targetDir] };
  if (spec.dest === "last") {
    if (operands.length < 2) return failClosed;
    return { enumerable: true, destinations: [operands[operands.length - 1]] };
  }
  if (operands.length === 0) return failClosed;
  return { enumerable: true, destinations: operands };
}

// Resolves each local writer's destination operand against the same cd-tracked
// working directory the redirection targets use. resolved:false means at least
// one local write's destination could not be enumerated, and the foreign gate
// must fail closed. Iterating structure.chains covers exactly the invocations
// that set local.write (segments === chains.flatMap(parts)), so a write can
// never both flag local.write and escape this scan.
function localWriteDestinations(structure) {
  const targets = new Set();
  let resolved = true;
  for (const chain of structure.chains) {
    const directories = chainWorkingDirectories(chain);
    for (let index = 0; index < chain.parts.length; index += 1) {
      for (const invocation of chain.parts[index].invocations) {
        const tool = invocation.tool;
        const sedInPlace = tool === "sed" && invocation.words.some((word) => /^-i(?:$|[^-])|^--in-place(?:=|$)/.test(word));
        if (!LOCAL_WRITE_TOOLS.has(tool) && !sedInPlace) continue;
        if (sedInPlace) { resolved = false; continue; }
        const extracted = extractWriteOperands(tool, invocation.words);
        if (!extracted.enumerable) { resolved = false; continue; }
        for (const destination of extracted.destinations) targets.add(resolveShellTarget(directories[index], destination, chain.dialect));
      }
    }
  }
  return { targets: [...targets], resolved };
}

function curlInvocationOutput(words) {
  const targets = [];
  let remoteName = false;
  let outputDirectory = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--") break;
    const longName = word.split("=", 1)[0];
    if (CURL_FILE_LONG_OPTIONS.has(longName)) {
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[++index];
      const target = fileOutputTarget(value);
      if (target) targets.push(target);
    } else if (longName === "--output-dir") {
      outputDirectory = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[++index];
    } else if (word === "--remote-name" || word === "--remote-name-all") remoteName = true;
    else if (/^-[^-]/.test(word)) {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset += 1) {
        const option = cluster[offset];
        if (option === "O") {
          remoteName = true;
          continue;
        }
        if (option === "o" || CURL_SHORT_VALUE_OPTIONS.has(option)) {
          const attached = cluster.slice(offset + 1);
          const value = attached || words[++index];
          if (CURL_FILE_SHORT_OPTIONS.has(option)) {
            const target = fileOutputTarget(value);
            if (target) targets.push(target);
          }
          break;
        }
      }
    }
  }
  if (remoteName) {
    const directory = fileOutputTarget(outputDirectory);
    if (directory) targets.push(directory);
  }
  return { targets, unresolvedWrite: remoteName, writes: targets.length > 0 || remoteName };
}

function wgetInvocationOutput(words) {
  const targets = [];
  let explicitOutput = false;
  let missingOutput = false;
  let directoryPrefix = null;
  let auxiliaryWrites = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--") break;
    const longName = word.split("=", 1)[0];
    if (longName === "--output-document") {
      explicitOutput = true;
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[++index];
      if (value === undefined) missingOutput = true;
      const target = fileOutputTarget(value);
      if (target) targets.push(target);
      continue;
    }
    if (longName === "--directory-prefix") {
      directoryPrefix = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[++index];
      continue;
    }
    if (WGET_FILE_LONG_OPTIONS.has(longName)) {
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[++index];
      const target = fileOutputTarget(value);
      if (target) {
        targets.push(target);
        auxiliaryWrites = true;
      }
      continue;
    }
    if (!/^-[^-]/.test(word)) continue;
    const cluster = word.slice(1);
    for (let offset = 0; offset < cluster.length; offset += 1) {
      const option = cluster[offset];
      if (option === "O" || option === "P" || WGET_FILE_SHORT_OPTIONS.has(option)) {
        const attached = cluster.slice(offset + 1);
        const value = attached || words[++index];
        if (option === "O") {
          explicitOutput = true;
          if (value === undefined) missingOutput = true;
        } else if (option === "P") directoryPrefix = value;
        const target = fileOutputTarget(value);
        if (target && option !== "P") {
          targets.push(target);
          if (WGET_FILE_SHORT_OPTIONS.has(option)) auxiliaryWrites = true;
        }
        break;
      }
      if (WGET_SHORT_VALUE_OPTIONS.has(option)) {
        if (offset === cluster.length - 1) index += 1;
        break;
      }
    }
  }
  const bodyWrites = !explicitOutput || targets.length > 0 || missingOutput;
  if (!explicitOutput) {
    const directory = fileOutputTarget(directoryPrefix);
    if (directory) targets.push(directory);
  }
  return { targets, unresolvedWrite: !explicitOutput || missingOutput, writes: bodyWrites || auxiliaryWrites };
}

function powershellWebOutput(words) {
  const targets = [];
  for (let index = 0; index < words.length; index += 1) {
    const match = words[index].match(/^-out(?:f(?:i(?:l(?:e)?)?)?)?(?::(.*))?$/i);
    if (match) {
      const target = fileOutputTarget(match[1] || words[++index]);
      if (target) targets.push(target);
    }
  }
  return { targets, unresolvedWrite: false, writes: targets.length > 0 };
}

function networkAnalysisFromStructure(structure) {
  const effects = new Set();
  const targets = new Set();
  let unresolvedWrite = false;
  for (const chain of structure.chains) {
    const directories = chainWorkingDirectories(chain);
    for (let index = 0; index < chain.parts.length; index += 1) {
      const part = chain.parts[index];
      const tools = new Set(part.invocations.map((invocation) => invocation.tool));
      const networkInvocations = part.invocations.filter((invocation) => NETWORK_TOOLS.has(invocation.tool));
      if (networkInvocations.length) {
        effects.add("network");
        const redirected = redirectionTargetsFromPart(part);
        for (const target of redirected) targets.add(resolveShellTarget(directories[index], target, chain.dialect));
        if (redirected.length) effects.add("network_write");
      }
      for (const invocation of networkInvocations) {
        const output = invocation.tool === "curl"
          ? curlInvocationOutput(invocation.words)
          : invocation.tool === "wget"
            ? wgetInvocationOutput(invocation.words)
            : powershellWebOutput(invocation.words);
        for (const target of output.targets) targets.add(resolveShellTarget(directories[index], target, chain.dialect));
        if (output.writes) effects.add("network_write");
        if (output.unresolvedWrite) unresolvedWrite = true;
      }
      const next = chain.parts[index + 1];
      if (
        (part.separator === "|" || part.separator === "|&") &&
        [...tools].some((tool) => REMOTE_SOURCE_TOOLS.has(tool)) &&
        next && partExecutesTool(next, REMOTE_EXEC_TOOLS)
      ) effects.add("remote_exec");
    }
  }
  return { effects, targets: [...targets], unresolvedWrite };
}

const SECRET_READER_TOOLS = new Set(["cat", "head", "less", "more", "tail"]);
const SECRET_PATH_RE = /(\.env\b|id_rsa|id_ed25519|\.pem\b|credentials)/i;

function secretDumpShapeFromStructure(structure) {
  for (const segment of structure.segments) {
    for (const invocation of segment.invocations) {
      if (invocation.tool === "printenv" && invocation.words.length === 0) return true;
      if (SECRET_READER_TOOLS.has(invocation.tool) && SECRET_PATH_RE.test(invocation.words.join(" "))) return true;
    }
    if (segment.invocations.length === 0 && /(?:^|\s)env\s*$/.test(segment.text)) return true;
  }
  return false;
}

// The literal path roots of a task's scoped destructive grants, canonicalized
// like every judged target. The legacy full-grant marker scope "commands" is
// not a root; an entry that cannot canonicalize contributes nothing, so a
// grant of unresolvable roots silently authorizes nothing rather than
// something unintended.
function destructiveScopeRoots(repo, task) {
  const entries = (task.grants ?? [])
    .filter((item) => item?.kind === "destructive")
    .flatMap((item) => (item.scope ?? []).filter((entry) => entry !== "commands"));
  return [...new Set(entries.map((entry) => canonicalWriteTarget(repo, String(entry).replaceAll("\\", "/"))).filter(Boolean))];
}

// A scoped destructive grant authorizes recursive deletion, so scope
// membership must hold for a target's whole subtree: roots are literal paths,
// not globs (a single-star glob can match a directory while missing its
// grandchildren), and every target must canonicalize — symlinks resolved, no
// variables, globs, or ~ — inside a granted root. Anything unprovable fails
// closed to the deny.
function scopedDestructiveFailure(task, analysis, options) {
  const escalation = "run workloop amend --destructive-allowed --reason <why> for full destructive authority";
  const local = analysis.local?.destructive;
  if (!local || !local.scopeable || !local.targets.length) {
    return `destructive shape is not coverable by the path-scoped destructive grant (only rm with enumerable literal targets is); ${escalation}`;
  }
  const repo = options.repo;
  const roots = repo ? destructiveScopeRoots(repo, task) : [];
  if (!roots.length) return `the destructive scope grant names no resolvable root; ${escalation}`;
  for (const raw of local.targets) {
    const absolute = canonicalWriteTarget(repo, raw);
    if (!absolute) return `cannot safely resolve destructive target ${raw} (variable, glob, or unsafe path); the scoped destructive grant covers only literal paths`;
    if (!roots.some((root) => pathInside(absolute, root))) return `destructive target ${raw} is outside the granted destructive scope`;
  }
  return null;
}

function commandSafetyFailure(task, command, options = {}) {
  const env = task.envelope;
  const hasGrant = (kind) => (task.grants ?? []).some((grant) => grant?.kind === kind);
  const analysis = options.analysis ?? analyzeCommand(command, options);
  const hasEffect = (effect) => analysis.effects.includes(effect);
  if (hasEffect("remote_exec") && !(env.network && env.destructive)) {
    return "remote-exec (download | shell) requires explicit network and destructive grants";
  }
  if (hasEffect("dynamic_exec")) {
    return "dynamic interpreter input is denied because the executed command cannot be statically resolved";
  }
  if (!env.network && hasEffect("network")) {
    return "network command requires an explicit network grant; run workloop amend --network-allowed --reason <why> to request one";
  }
  if (!hasGrant("install") && hasEffect("install")) {
    return "package install requires an explicit install grant; run workloop amend --install-scripts-allowed --reason <why> to request one";
  }
  if (!hasGrant("publish") && hasEffect("publish")) {
    return "publish-shaped command requires an explicit publish grant; run workloop amend --publish-allowed --reason <why> to request one";
  }
  if (hasEffect("secret_dump")) {
    return "environment/secret dump is denied by default";
  }
  if (!env.destructive && hasEffect("destructive")) {
    if (!hasGrant("destructive")) {
      return "destructive command requires an explicit destructive grant; run workloop amend --destructive-scope <root> --reason <why> for transient-tree cleanup, --destructive-allowed for full authority, or leave transient files for the host to reap";
    }
    const scopeFailure = scopedDestructiveFailure(task, analysis, options);
    if (scopeFailure) return scopeFailure;
  }
  return null;
}

function commandExecutionViews(command, options = {}) {
  return analyzeCommand(command, options).execution.views;
}

function commandShapes(command, options = {}) {
  return analyzeCommand(command, options).shapes;
}

function looksLikeWrite(tool, mapping, callAnalysis = null) {
  const compact = String(tool ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.includes("write") || compact.includes("edit") || compact.includes("patch") || compact === "notebookedit") {
    return true;
  }
  if (patchFileTargets(mapping).length) return true;
  const call = callAnalysis ?? analyzeToolCall(tool, mapping);
  for (const { analysis } of call.commands) {
    if (analysis.local.targets.length) return true;
    if (analysis.local.write) return true;
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

function writeFileTargets(tool, mapping, callAnalysis = null) {
  const targets = [...fileFieldValues(mapping), ...patchFileTargets(mapping)];
  const call = callAnalysis ?? analyzeToolCall(tool, mapping);
  for (const { analysis } of call.commands) {
    targets.push(...analysis.local.targets);
    targets.push(...analysis.network.targets);
  }
  return [...new Set(targets)];
}

const pathMeta = /(^~(?:[\\/]|$)|[*?\[\]{}]|\$|`)/;

function canonicalPath(rawPath) {
  let cursor = path.resolve(rawPath); const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(path.basename(cursor)); cursor = parent;
  }
  try { return foldCasePath(path.join(fs.realpathSync(cursor), ...suffix)); } catch { return null; }
}

function canonicalWriteTarget(repo, raw) {
  const value = String(raw ?? "").trim();
  if (!value || pathMeta.test(value)) return null;
  return canonicalPath(path.isAbsolute(value) ? value : path.resolve(repo, value));
}

function pathInside(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function controlPlaneRoots(repo, home = userHome()) {
  const roots = [canonicalPath(path.join(repo, STATE_DIR)), canonicalPath(path.join(repo, ".git")), canonicalPath(path.join(home, STATE_DIR))];
  try {
    const lines = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/);
    roots.push(...lines.map((line) => canonicalPath(line)));
  } catch { /* a non-git directory still has workloop control roots */ }
  return [...new Set(roots.filter(Boolean))];
}

function controlPlaneWriteFailure(repo, tool, mapping, home = userHome(), callAnalysis = null) {
  const call = callAnalysis ?? analyzeToolCall(tool, mapping);
  // Command destinations (cp/rm/mv/tee/mkdir/touch operands) as well as file
  // fields and redirections: control state is protected from every session,
  // owner included, whichever tool shape carries the write.
  const targets = allWriteTargets(tool, mapping, call);
  const writeShaped = looksLikeWrite(tool, mapping, call) || call.git.ops.length > 0 || call.commands.some(({ analysis }) => analysis.effects.includes("network_write"));
  if (!writeShaped) return null;
  const roots = controlPlaneRoots(repo, home);
  for (const raw of targets) {
    const text = String(raw).trim();
    const expanded = text === "~" ? home : /^~[\\/]/.test(text) ? path.join(home, text.slice(2)) : text;
    const target = canonicalWriteTarget(repo, expanded);
    if (target && roots.some((root) => pathInside(target, root))) return `direct writes to workloop/git control state are denied: ${raw}`;
  }
  return null;
}

const READONLY_GIT = new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "describe", "shortlog", "grep"]);

function gitReadonlyFromStructure(structure) {
  for (const segment of structure.segments) {
    for (const invocation of fixedToolInvocations(segment, GIT_TOOL)) {
      for (const { words, index, subcommand } of gitSubcommandsAt(invocation.words)) {
        if (READONLY_GIT.has(subcommand)) continue;
        if (subcommand === "worktree" && words[index + 1]?.toLowerCase() === "list") continue;
        if (subcommand === "config" && words.slice(index + 1).some((word) => /^(--get(?:-all|-regexp)?|--list|-l)$/.test(word))) continue;
        return false;
      }
    }
  }
  return true;
}

// Category (3) of the foreign-session deny taxonomy: a host-level risk floor.
// These commands are irreversible or externally visible regardless of which
// file or repository they touch, so the deny names the risk and the
// authorization it needs — not the current workspace's session binding, which
// did not scope the operation.
// Returns { category, message } or null. The category is the single source for
// whether a failure is the git-non-read-only floor (which git -C delegation may
// waive) or a host-level risk floor (which it may not) — no caller re-enumerates
// the effect precedence.
function foreignAnalysisFailure(analysis) {
  const hasEffect = (effect) => analysis.effects.includes(effect);
  const host = (message) => ({ category: "host", message });
  if (hasEffect("publish")) return host("irreversible publication needs task authorization; run workloop join to act under the active task");
  if (hasEffect("dynamic_exec")) return host("dynamically constructed interpreter input cannot be statically checked; run workloop join to act under the active task");
  if (analysis.network.unresolvedWrite) return host("remote output is not provably stdout-only; run workloop join to act under the active task");
  if (hasEffect("remote_exec")) return host("remote-exec needs task authorization; run workloop join to act under the active task");
  if (hasEffect("install")) return host("package installation needs task authorization; run workloop join to act under the active task");
  if (hasEffect("secret_dump")) return host("secret exfiltration needs task authorization; run workloop join to act under the active task");
  if (hasEffect("destructive")) return host("destructive command needs task authorization; run workloop join to act under the active task");
  if (analysis.git.subcommands.length > 0 && !analysis.git.readonly) return { category: "git", message: "non-read-only git needs task authorization; run workloop join to act under the active task" };
  return null;
}

// --- git -C cross-repository delegation (foreign-session category 3) ---
// A foreign session's non-read-only git command hits the host-level floor. But
// when `git -C <dir>` targets a DIFFERENT repository, this repository's task has
// no claim over it, so the target's own workloop state should decide. This
// delegates that one shape and fails closed on everything it cannot prove:
//   - only `git -C <dir> <subcommand> ...`, never a compound or option-laden form;
//   - never push (irreversibly external) — the destructive shapes never reach here
//     because the effect floor outranks the git branch;
//   - only when the target's git-common-dir differs from this repository's, so a
//     linked worktree (which shares, and could corrupt, this repository's git) is
//     never mistaken for an unrelated repository.

function parseGitDashCInvocation(words) {
  // Find the subcommand with the one git classifier (gitSubcommandsAt already
  // steps over -C and the other global value options), then require the clean
  // single-`-C <dir>` prefix. Any other global option before the subcommand
  // fails closed rather than growing a second, looser directory parser.
  const positions = gitSubcommandsAt(words);
  if (positions.length !== 1) return null;
  const { index, subcommand } = positions[0];
  if (!subcommand || subcommand.startsWith("-")) return null;
  let chdir = null;
  for (let i = 0; i < index; i += 1) {
    if (words[i] !== "-C") return null;
    if (chdir !== null) return null;
    chdir = words[i + 1];
    i += 1;
  }
  if (!chdir || chdir.startsWith("-")) return null;
  return { chdir, subcommand };
}

function gitRevParse(dir, arg) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", arg], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

function repoCommonDir(dir) {
  const out = gitRevParse(dir, "--git-common-dir");
  return out ? canonicalPath(out) : null;
}

// Locate the repository that contains a resolved path. The path need not exist
// yet; git resolves from the nearest existing ancestor directory. Returns:
//   null                — under no git repository (unsupervised, safe to allow);
//   { root }            — the work-tree root;
//   { gitInternal:true } — inside a git directory (writing into `.git`, a bare or
//                          separate/submodule git dir) whose work-tree root cannot
//                          be named. That is git control state, so the caller must
//                          fail closed rather than treat an unresolved root as
//                          "no repository".
function containingRepoRoot(target) {
  let dir = String(target);
  while (dir && !fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { return null; }
  const top = gitRevParse(dir, "--show-toplevel");
  if (top) return { root: top };
  const commonDir = gitRevParse(dir, "--git-common-dir");
  if (!commonDir) return null;
  return path.basename(commonDir) === ".git" ? { root: path.dirname(commonDir) } : { gitInternal: true };
}

function foldedEnvelopeGlobs(files) {
  return files.map((pattern) => foldCasePath(String(pattern)));
}

// The projection of a digest-consistent v3 snapshot wrapper, or null if the
// wrapper is malformed or tampered. The single verification every lock-free
// snapshot reader shares; a snapshot, never the event authority, so it never
// blocks on a lock.
function digestVerifiedV3Projection(stored) {
  const fields = ["projection", "runtime_contract", "schema_version", "snapshot_digest", "source_cursor"];
  if (
    stored.runtime_contract !== V3_RUNTIME_CONTRACT ||
    !hasExactKeys(stored, fields) ||
    !isPlainObject(stored.source_cursor) || !isPlainObject(stored.projection)
  ) return null;
  const preimage = { schema_version: stored.schema_version, runtime_contract: stored.runtime_contract, source_cursor: stored.source_cursor, projection: stored.projection };
  return sha256Hex(canonicalJson(preimage)) === stored.snapshot_digest ? stored.projection : null;
}

// null: no workloop state (unsupervised). undefined: state present but not
// provably an authentic projection (fail closed). object: the projection.
function readValidatedTaskProjection(dir) {
  const stateDir = path.join(dir, STATE_DIR);
  if (!fs.existsSync(stateDir)) return null;
  let stored;
  try { stored = JSON.parse(fs.readFileSync(path.join(stateDir, TASK_FILE), "utf8")); }
  catch { return undefined; }
  if (stored?.schema_version !== V3_TASK_SNAPSHOT_SCHEMA_VERSION) return undefined;
  return digestVerifiedV3Projection(stored) ?? undefined;
}

// The external repository's active/suspended task, or null if it is unsupervised
// or terminal, or { unreadable: true } to fail closed. Shared by the git-command
// and the file-write delegation so both read a foreign repository the same way.
function externalRepoActiveTask(repoRoot) {
  const projection = readValidatedTaskProjection(repoRoot);
  if (projection === undefined) return { unreadable: true };
  if (!projection || !new Set(["active", "suspended"]).has(projection.lifecycle?.state)) return null;
  return {
    task_id: projection.task_id,
    owner: String(projection.episodes?.at(-1)?.host_session_id ?? "").trim(),
    files: Array.isArray(projection.envelope?.files) ? projection.envelope.files : [],
  };
}

function ownedBySession(task, sessionId) {
  const self = String(sessionId ?? "").trim();
  return Boolean(task.owner && self && task.owner === self);
}

function gitExternalDelegation(repo, command, analysis, sessionId) {
  const structure = commandStructuralAnalysis(String(command), { dialect: analysis.dialect });
  const invocations = [];
  for (const segment of structure.segments) for (const invocation of fixedToolInvocations(segment, GIT_TOOL)) invocations.push(invocation);
  if (invocations.length !== 1) return null;
  const parsed = parseGitDashCInvocation(invocations[0].words);
  if (!parsed || READONLY_GIT.has(parsed.subcommand) || parsed.subcommand === "push") return null;
  const targetDir = path.isAbsolute(parsed.chdir) ? parsed.chdir : path.resolve(repo, parsed.chdir);
  const targetCommon = repoCommonDir(targetDir);
  const selfCommon = repoCommonDir(repo);
  if (!targetCommon || !selfCommon || targetCommon === selfCommon) return null;
  const task = externalRepoActiveTask(targetDir);
  if (task?.unreadable) return { kind: "deny", message: `cannot read the workloop state of ${parsed.chdir}; run the command from that repository` };
  if (!task || ownedBySession(task, sessionId)) return { kind: "allow" };
  return { kind: "deny", message: `${parsed.chdir} has an active workloop task (task ${task.task_id}); join it in that repository or run under its owning session` };
}

// A resolved write target outside this repository is judged by the repository
// that actually contains it, exactly as this repository judges its own targets:
// its control state is always protected, and a write intersecting its active
// task's envelope conflicts there. A target under no repository, or under one
// whose task does not claim it, is parallel work and allowed.
function externalTargetDecision(raw, absoluteTarget, sessionId, home) {
  const found = containingRepoRoot(absoluteTarget);
  if (!found) return { kind: "allow" };
  const controlStateDenied = { kind: "deny", message: `direct writes to workloop/git control state are denied: ${raw}` };
  if (found.gitInternal) return controlStateDenied;
  const repoRoot = found.root;
  if (controlPlaneRoots(repoRoot, home).some((root) => pathInside(absoluteTarget, root))) return controlStateDenied;
  const task = externalRepoActiveTask(repoRoot);
  if (task?.unreadable) return { kind: "deny", message: `cannot read the workloop state of ${repoRoot}; run the command from that repository` };
  if (!task || ownedBySession(task, sessionId)) return { kind: "allow" };
  const canonicalRoot = canonicalPath(repoRoot);
  if (!canonicalRoot || !pathInside(absoluteTarget, canonicalRoot)) return { kind: "allow" };
  const relative = path.relative(canonicalRoot, absoluteTarget).replaceAll("\\", "/");
  const globs = foldedEnvelopeGlobs(task.files);
  if (insideEnvelope(relative, globs) || envelopeRegionContains(relative, globs)) {
    return { kind: "deny", message: `write to ${raw} conflicts with the active task envelope in ${repoRoot} (task ${task.task_id}); join it in that repository or use a separate worktree for parallel work` };
  }
  return { kind: "allow" };
}

// The owner path's git authorization, with one difference from the raw
// envelope.git check: a clean `git -C <external repo> <sub>` is judged by that
// repository (mirroring the foreign delegation) instead of this task's grants,
// so the owner's task scope does not bleed onto a repository it never claimed.
// Returns a denial message, or null when every git op is authorized or delegated.
function ownerGitDenial(repo, task, callAnalysis, sessionId) {
  const granted = task.envelope.git ?? [];
  const unauthorized = new Set();
  for (const { command, analysis } of callAnalysis.commands) {
    if (!analysis.git.ops.length) continue;
    if (!analysis.git.readonly) {
      const delegation = gitExternalDelegation(repo, command, analysis, sessionId);
      if (delegation?.kind === "deny") return delegation.message;
      if (delegation?.kind === "allow") continue;
    }
    for (const op of analysis.git.ops) if (!granted.includes(op)) unauthorized.add(op);
  }
  return unauthorized.size ? `git operation(s) need envelope authorization: ${[...unauthorized].join(", ")}` : null;
}

// An owner write whose resolved target lands in a different repository is scoped
// to that repository, exactly as for a foreign session: its control state and
// its active task's envelope are protected there. The owner keeps its own trust
// on this repository — an in-repo or unresolvable target returns null here and is
// handled by the owner path's existing envelope/ledger logic. Returns a denial
// message or null.
function ownerExternalTargetDenial(repo, tool, mapping, callAnalysis, home, sessionId) {
  const canonicalRepo = canonicalPath(repo);
  const targets = allWriteTargets(tool, mapping, callAnalysis);
  for (const raw of targets) {
    const absolute = canonicalWriteTarget(repo, raw);
    if (!absolute) continue;
    if (canonicalRepo && pathInside(absolute, canonicalRepo)) continue;
    const decision = externalTargetDecision(raw, absolute, sessionId, home);
    if (decision.kind === "deny") return decision.message;
  }
  return null;
}

function commandWriteDestinations(call) {
  const targets = new Set();
  let resolved = true;
  for (const { analysis } of call.commands) {
    const destinations = analysis.local.destinations;
    if (!destinations || !destinations.resolved) resolved = false;
    for (const target of destinations?.targets ?? []) targets.add(target);
  }
  return { targets: [...targets], resolved };
}

// After the safety gate has allowed a destructive-shaped call under a scoped
// grant (envelope.destructive false), decide how the authorize-write event
// attributes it. The verified rm targets are always recorded; `exclusive` is
// true only when they are provably the call's only local writes — any git op,
// network write, unenumerable destination, or destination beyond the verified
// set keeps the unattributed `<command>` fallback and its floor price. A null
// return means the call could not be re-verified and is priced as full
// destructive use, never the cheaper scoped form.
function scopedDestructiveAttribution(repo, task, call) {
  if (task.envelope.destructive || !call.effects.includes("destructive")) return null;
  const verified = new Set();
  const rawTargets = [];
  for (const { analysis } of call.commands) {
    if (!analysis.effects.includes("destructive")) continue;
    const local = analysis.local?.destructive;
    if (!local?.scopeable) return null;
    for (const raw of local.targets) {
      const absolute = canonicalWriteTarget(repo, raw);
      if (!absolute) return null;
      verified.add(absolute);
      rawTargets.push(raw);
    }
  }
  if (!rawTargets.length) return null;
  let exclusive = call.git.ops.length === 0 && !call.commands.some(({ analysis }) => analysis.effects.includes("network_write"));
  if (exclusive) {
    const destinations = commandWriteDestinations(call);
    exclusive = destinations.resolved && destinations.targets.every((destination) => {
      const absolute = canonicalWriteTarget(repo, destination);
      return Boolean(absolute) && verified.has(absolute);
    });
  }
  return { exclusive, targets: [...new Set(rawTargets)] };
}

// Every distinct write target of a tool call: file fields and redirections plus
// the parsed command-writer destinations. The one place every gate that asks
// "what does this call write" reads from.
function allWriteTargets(tool, mapping, call) {
  return [...new Set([...writeFileTargets(tool, mapping, call), ...commandWriteDestinations(call).targets])];
}

function foreignWriteDecision(repo, task, tool, mapping, callAnalysis = null, home = userHome(), sessionId = null) {
  const call = callAnalysis ?? analyzeToolCall(tool, mapping);
  for (const { command, analysis } of call.commands) {
    const failure = foreignAnalysisFailure(analysis);
    if (!failure) continue;
    // A non-read-only git command aimed at a different repository is judged by
    // that repository's workloop state, not this one's floor.
    if (failure.category === "git") {
      const delegation = gitExternalDelegation(repo, command, analysis, sessionId);
      if (delegation) {
        if (delegation.kind === "deny") return { kind: "deny", message: delegation.message };
        continue;
      }
    }
    return { kind: "deny", message: failure.message };
  }
  const destinations = commandWriteDestinations(call);
  const targets = allWriteTargets(tool, mapping, call);
  const networkOnly = call.commands.length > 0 && !looksLikeWrite(tool, mapping, call) && targets.length === 0 && call.commands.every(({ analysis }) => analysis.effects.includes("network") && !analysis.effects.includes("network_write"));
  if (networkOnly) return { kind: "allow", writeShaped: false, targets: [] };
  const writeShaped = call.git.ops.length > 0 || call.commands.some(({ analysis }) => analysis.effects.includes("network_write")) || looksLikeWrite(tool, mapping, call);
  if (!writeShaped) return { kind: "allow", writeShaped: false, targets: [] };
  // Category (2): workloop cannot prove where the write lands, so it cannot rule
  // out a conflict. The deny asks the caller to make the target provable rather
  // than framing it as a blanket foreign-session prohibition.
  // This is a raw-text belt over the structural cd tracking on purpose: the
  // parser resolves the cd forms it models, but an unmodeled spelling (a
  // variable cd, an alias, a dialect quirk) would silently mis-scope every
  // relative target. The regex deliberately over-matches quoted text — a false
  // deny asks for an absolute path; a false allow mis-attributes a write.
  if (call.commands.some(({ command }) => /(?:^|[;&|()]\s*)cd\s+[^;&|]+/i.test(command)) && targets.some((target) => !path.isAbsolute(String(target)))) {
    return { kind: "deny", message: "cannot resolve the write target: it depends on a shell directory change; use an absolute path or split the command, or run workloop join" };
  }
  // A local writer whose destination we could not enumerate, or a write shape
  // with no target at all (a SQL mutation, sed -i), stays unprovable and denies.
  if (!destinations.resolved) return { kind: "deny", message: "cannot resolve the write target; use an absolute path or split the command, or run workloop join" };
  if (looksLikeWrite(tool, mapping, call) && targets.length === 0) return { kind: "deny", message: "cannot resolve the write target; use an absolute path or split the command, or run workloop join" };
  const canonicalRepo = canonicalPath(repo);
  const controlRoots = controlPlaneRoots(repo, home);
  const envelopeGlobs = foldedEnvelopeGlobs(task.envelope.files);
  const normalized = targets.map((raw) => ({ raw, absolute: canonicalWriteTarget(repo, raw) }));
  if (normalized.some((row) => !row.absolute)) return { kind: "deny", message: "cannot safely resolve the write target (variable, glob, or unsafe path); use an absolute path, or run workloop join" };
  // Category (1): the target is a protected resource. Control state is protected
  // from every session, so it names no owner and offers no join; an envelope
  // conflict names the task and the resource and points at join or a worktree.
  for (const row of normalized) {
    if (controlRoots.some((root) => pathInside(row.absolute, root))) return { kind: "deny", message: `direct writes to workloop/git control state are denied: ${row.raw}` };
    // A target outside this repository is scoped to the repository that contains
    // it, not silently allowed just because this repository does not claim it.
    if (!canonicalRepo || !pathInside(row.absolute, canonicalRepo)) {
      const external = externalTargetDecision(row.raw, row.absolute, sessionId, home);
      if (external.kind === "deny") return { kind: "deny", message: external.message };
      continue;
    }
    const relative = path.relative(canonicalRepo, row.absolute).replaceAll("\\", "/");
    if (insideEnvelope(relative, envelopeGlobs) || envelopeRegionContains(relative, envelopeGlobs)) {
      return { kind: "deny", message: `write to ${row.raw} conflicts with the active task envelope (task ${task.task_id}); run workloop join to take over, or use a separate worktree for parallel work` };
    }
  }
  return { kind: "untracked", writeShaped: true, targets };
}

// minimatch-lite: * (segment), ** (any depth), ? (one char)

function insideEnvelope(rel, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(rel));
}

function literalGlobPrefix(pattern) {
  const index = pattern.search(/[*?[\]{}]/);
  return index === -1 ? pattern : pattern.slice(0, index);
}

// insideEnvelope answers "is this path a claimed file". A command that writes a
// directory subtree (cp into a dir, mkdir, tee) also touches the envelope when
// the destination is an ancestor of a claimed path: writing evil.txt into the
// envelope's own directory lands a claimed file even though the directory itself
// is not one. This catches that direction. An empty literal prefix (a repo-wide
// glob such as **) makes every in-repo directory an ancestor, which is the safe
// reading.
function envelopeRegionContains(relativeDir, patterns) {
  const base = relativeDir === "" ? "" : relativeDir.replace(/\/+$/, "") + "/";
  return patterns.some((pattern) => literalGlobPrefix(pattern).startsWith(base));
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

function siblingWorktreeOpenTasks(repo, { validateV3Projection = null } = {}) {
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
      const stored = JSON.parse(fs.readFileSync(path.join(wt, STATE_DIR, TASK_FILE), "utf8"));
      let task = stored;
      if (stored?.schema_version === V3_TASK_SNAPSHOT_SCHEMA_VERSION) {
        const projection = digestVerifiedV3Projection(stored);
        if (!projection) continue;
        task = projection;
        if (typeof validateV3Projection !== "function") continue;
        try { validateV3Projection(task); } catch { continue; }
      }
      if (isPlainObject(task) && new Set(["active", "suspended"]).has(task.lifecycle?.state)) {
        tasks.push({
          path: realPath(wt),
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
  analyzeCommand,
  analyzeToolCall,
  commandValues,
  commandExecutionViews,
  gitOps,
  commandSafetyFailure,
  commandShapes,
  scopedDestructiveAttribution,
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
  ownerGitDenial,
  ownerExternalTargetDenial,
};
