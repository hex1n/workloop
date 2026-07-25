// The command line: parse, call, print. Nothing else.
//
// Every decision this file could be tempted to make belongs one layer down.
// If a rule appears here it is a rule the service layer forgot, and it will be
// invisible to everything that does not go through a terminal.
import fs from "node:fs";
import path from "node:path";
import { createStore, openStore } from "./store.mjs";
import { KIND, assertKind, discover, siteForNewStore, worktreeRoot } from "./site.mjs";
import { abandon, amend, join, next, observe, openLoop, openLoopStore, ready, receipt, resume, suspend } from "./domain/loop.mjs";
import { exportStore, log, status } from "./domain/query.mjs";

export const VERBS = Object.freeze([
  "init", "open", "next", "observe", "receipt", "join", "suspend", "resume",
  "amend", "abandon", "status", "log", "ready", "export",
]);

// `--flag value`, `--flag=value`, and repeatable flags that collect. No
// positional arguments beyond the verb: a flag says what it is, and a script
// that reorders them keeps working.
const shellError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw shellError("UNEXPECTED_ARGUMENT", `unexpected argument ${token}; every input is a --flag`);
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value;
    if (equals !== -1) value = token.slice(equals + 1);
    else if (rest[index + 1] === undefined || rest[index + 1].startsWith("--")) value = true;
    else { value = rest[index + 1]; index += 1; }
    if (Object.hasOwn(options, name)) options[name] = [...[options[name]].flat(), value];
    else options[name] = value;
  }
  return { verb, options };
}

const list = (value) => (value === undefined ? [] : [value].flat());
const integer = (value) => (value === undefined ? undefined : Number(value));

// Which flags each verb reads. Declared, so a flag nobody reads is refused
// instead of ignored: `--bugdet 5` used to parse cleanly and vanish, and the
// loop got whatever the missing value defaulted to.
const FLAGS = Object.freeze({
  init: ["root", "kind", "command"],
  open: ["store", "root", "goal", "claim", "criterion", "budget", "session", "reason", "granted-by", "receipts", "depends-on", "command"],
  next: ["store", "root", "loop"],
  observe: ["store", "root", "loop", "session", "criterion", "timeout", "command"],
  receipt: ["store", "root", "loop", "mode", "session", "command"],
  join: ["store", "root", "loop", "session", "reason", "command"],
  suspend: ["store", "root", "loop", "session", "outcome", "reason", "command"],
  resume: ["store", "root", "loop", "session", "reason", "command"],
  amend: ["store", "root", "loop", "goal", "budget", "criterion", "reason", "depends-on", "command"],
  abandon: ["store", "root", "loop", "reason", "command"],
  status: ["store", "root", "loop"],
  log: ["store", "root", "loop", "from", "limit"],
  ready: ["store", "root"],
  export: ["store", "root"],
});

// Resolving the store is the one thing every verb but `init` needs. Explicit
// wins; otherwise walk up from the working directory the way git finds `.git`.
// Nothing is created here — a runtime that quietly starts a ledger wherever
// somebody happened to be standing is one whose history nobody can account for.
function resolve(options) {
  const from = typeof options.root === "string" ? path.resolve(options.root) : process.cwd();
  if (typeof options.store === "string") {
    const location = path.resolve(options.store);
    const store = openLoopStore(location);
    // The root comes from the store, not from wherever the caller happens to
    // be standing. Checking the kind against an unrelated directory reported
    // conflicts that were not there and missed the ones that were — and the
    // kind check is the whole reason FS-07 exists.
    const root = store.manifest.store_kind === KIND.FS ? path.dirname(location) : worktreeRoot(from) ?? from;
    assertKind(root, store.manifest);
    return { store, root, location };
  }
  const site = discover(from);
  if (site === null) {
    throw shellError("NO_STORE_FOUND", `no store found at or above ${from}; run \`workloop init --root <path>\` or pass --store`);
  }
  const store = openLoopStore(site.location);
  assertKind(site.root, store.manifest);
  return { store, root: site.root, location: site.location };
}

// `--root` says where to start looking; the store's own root is what every
// verb then works against. Letting the flag override it would resolve claims
// against a filesystem the store does not describe.
const commonOf = (options, root) => ({
  loopId: options.loop,
  session: options.session,
  commandId: options.command,
  root,
});

// Built from the same tables the shell dispatches on, so a verb or a flag
// cannot exist without appearing here — the usage text is derived, never
// transcribed.
export function usage() {
  const width = Math.max(...VERBS.map((verb) => verb.length));
  return [
    "workloop — a ledger of goals, evidence, and the next legal step",
    "",
    "  workloop <verb> [--store <path>] [--root <path>] [options]",
    "",
    ...VERBS.map((verb) => `  ${verb.padEnd(width)}  ${FLAGS[verb].map((flag) => `--${flag}`).join(" ")}`),
    "",
    "Every input is a --flag; there are no positional arguments.",
    "Output is JSON on stdout. A refusal prints `CODE: message` on stderr and exits non-zero.",
  ].join("\n");
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const { verb, options } = parseArgs(argv);
  if (!VERBS.includes(verb)) {
    throw shellError("UNKNOWN_VERB", `unknown verb ${verb === undefined ? "" : verb}\n\n${usage()}`.trim());
  }
  const unknown = Object.keys(options).filter((flag) => !FLAGS[verb].includes(flag));
  if (unknown.length > 0) throw shellError("UNKNOWN_FLAG", `${verb} does not take --${unknown[0]}; it takes ${FLAGS[verb].map((flag) => `--${flag}`).join(", ")}`);

  if (verb === "init") {
    const root = path.resolve(typeof options.root === "string" ? options.root : cwd);
    const site = siteForNewStore(root, { kind: options.kind });
    fs.mkdirSync(site.location, { recursive: true });
    createStore({ location: site.location, storeKind: site.kind, commandId: options.command ?? `init-${site.kind}` });
    const store = openStore(site.location);
    return { store_id: store.manifest.store_id, store_kind: site.kind, location: site.location, root: site.root };
  }

  const { store, root } = resolve(options);
  const common = commonOf(options, root);

  switch (verb) {
    case "open": {
      const result = openLoop(store, {
        root: common.root,
        goal: options.goal, claims: list(options.claim), criterionFile: options.criterion,
        roundsBudget: integer(options.budget), session: options.session, reason: options.reason,
        grantedBy: options["granted-by"], receipts: options.receipts, dependsOn: list(options["depends-on"]),
        commandId: options.command,
      });
      return { loop_id: result.loopId, seq: result.seq };
    }
    case "next": return next(store, common);
    case "observe": return observe(store, { ...common, criterionFile: options.criterion, timeoutMs: integer(options.timeout) });
    case "receipt": return receipt(store, { ...common, mode: options.mode });
    case "join": return join(store, { ...common, reason: options.reason });
    case "suspend": return suspend(store, { ...common, outcome: options.outcome, reason: options.reason });
    case "resume": return resume(store, { ...common, reason: options.reason });
    case "amend": return amend(store, {
      loopId: options.loop, reason: options.reason, commandId: options.command,
      roundsBudget: options.budget === undefined ? null : Number(options.budget),
      criterionFile: options.criterion ?? null, goal: options.goal ?? null,
      ...(options["depends-on"] === undefined ? {} : { dependsOn: list(options["depends-on"]) }),
    });
    case "abandon": return abandon(store, { ...common, reason: options.reason });
    case "status": return status(store, common);
    case "log": return log(store, { loopId: options.loop, fromSeq: integer(options.from, 1), limit: options.limit === undefined ? null : Number(options.limit) });
    case "ready": return ready(store, { root: common.root });
    case "export": return exportStore(store);
    default: throw new Error(`unreachable: ${verb}`);
  }
}

const HELP = new Set(["--help", "-h", "help", undefined]);

export async function main(argv) {
  // Asking what this is, is not an error. A first command that answers with a
  // refusal teaches the reader that the tool is hostile before it teaches them
  // anything else.
  if (argv.length === 0 || HELP.has(argv[0])) {
    write(process.stdout, `${usage()}\n`);
    return 0;
  }
  try {
    const result = await run(argv);
    write(process.stdout, `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    // The code a person greps for in stderr is the code a test asserts on.
    write(process.stderr, `${error.code ?? "ERROR"}: ${error.message}\n`);
    return 1;
  }
}

// `workloop log | head` closes the pipe while this is still writing. That is
// the reader saying "enough", not a failure — printing a stack trace at it is
// the tool complaining about being used correctly.
function write(stream, text) {
  try {
    stream.write(text);
  } catch (error) {
    if (error.code !== "EPIPE") throw error;
  }
}
