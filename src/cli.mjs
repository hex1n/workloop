// The command line: parse, call, print. Nothing else.
//
// Every decision this file could be tempted to make belongs one layer down.
// If a rule appears here it is a rule the service layer forgot, and it will be
// invisible to everything that does not go through a terminal.
import fs from "node:fs";
import path from "node:path";
import { createStore, openStore } from "./store.mjs";
import { assertKind, discover, siteForNewStore } from "./site.mjs";
import { abandon, amend, join, next, observe, openLoop, openLoopStore, ready, receipt, resume, suspend } from "./domain/loop.mjs";
import { exportStore, log, status } from "./domain/query.mjs";

export const VERBS = Object.freeze([
  "init", "open", "next", "observe", "receipt", "join", "suspend", "resume",
  "amend", "abandon", "status", "log", "ready", "export",
]);

// `--flag value`, `--flag=value`, and repeatable flags that collect. No
// positional arguments beyond the verb: a flag says what it is, and a script
// that reorders them keeps working.
export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
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
const integer = (value, fallback) => (value === undefined ? fallback : Number(value));

// Resolving the store is the one thing every verb but `init` needs. Explicit
// wins; otherwise walk up from the working directory the way git finds `.git`.
// Nothing is created here — a runtime that quietly starts a ledger wherever
// somebody happened to be standing is one whose history nobody can account for.
function resolve(options) {
  const explicit = typeof options.store === "string" ? path.resolve(options.store) : null;
  const root = typeof options.root === "string" ? path.resolve(options.root) : process.cwd();
  const site = explicit === null ? discover(root) : { location: explicit, root, kind: null };
  if (site === null) {
    const error = new Error(`no store found at or above ${root}; run \`workloop init --root <path>\` or pass --store`);
    error.code = "NO_STORE_FOUND";
    throw error;
  }
  const store = openLoopStore(site.location);
  assertKind(site.root, store.manifest);
  return { store, root: site.root, location: site.location };
}

const commonOf = (options, root) => ({
  loopId: options.loop,
  session: options.session,
  commandId: options.command,
  root: options.root === undefined ? root : path.resolve(options.root),
});

export function run(argv, { cwd = process.cwd() } = {}) {
  const { verb, options } = parseArgs(argv);
  if (!VERBS.includes(verb)) {
    const error = new Error(`unknown verb ${verb}; known verbs are ${VERBS.join(", ")}`);
    error.code = "UNKNOWN_VERB";
    throw error;
  }

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
        goal: options.goal, claims: list(options.claim), criterionFile: options.criterion,
        roundsBudget: integer(options.budget, 10), session: options.session, reason: options.reason,
        grantedBy: options["granted-by"], receipts: options.receipts, dependsOn: list(options["depends-on"]),
        commandId: options.command,
      });
      return { loop_id: result.loopId, seq: result.seq };
    }
    case "next": return next(store, common);
    case "observe": return observe(store, { ...common, criterionFile: options.criterion, timeoutMs: integer(options.timeout, undefined) });
    case "receipt": return receipt(store, { ...common, mode: options.mode ?? "commit" });
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

export async function main(argv) {
  try {
    const result = await run(argv);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    // The code a person greps for in stderr is the code a test asserts on.
    process.stderr.write(`${error.code ?? "ERROR"}: ${error.message}\n`);
    return 1;
  }
}
