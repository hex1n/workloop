// The host face: the CLI shell, the read-only verbs, export — and HF-08/HF-09,
// the two checks that keep what is shipped honest about what is implemented.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT, VERDICT_PREFIX } from "../src/domain/criterion.mjs";
import { VERBS, main, parseArgs, run } from "../src/cli.mjs";
import { npmJson } from "./helpers/npm.mjs";
import { openLoopStore } from "../src/domain/loop.mjs";
import { assertChain } from "../src/record.mjs";

const CRITERION = `
import fs from "node:fs";
const text = fs.readFileSync("work/a.txt", "utf8").trim();
const failures = text.includes("done") ? [] : [{ id: "not-done" }];
console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: failures.length === 0 ? "satisfied" : "unsatisfied", failures }));
process.exit(failures.length === 0 ? ${EXIT.SATISFIED} : ${EXIT.UNSATISFIED});
`;

function workspace(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "work"));
  fs.writeFileSync(path.join(root, "work", "a.txt"), "todo\n");
  fs.writeFileSync(path.join(root, "check.mjs"), CRITERION);
  return root;
}

const open = (root) => run([
  "open", "--root", root, "--goal", "work must say done", "--claim", "work",
  "--criterion", path.join(root, "check.mjs"), "--budget", "5", "--session", "s1",
  "--reason", "fixture", "--granted-by", "self", "--receipts", "none", "--command", "open",
]).loop_id;

test("arguments parse as flags, in any order, with repeats collecting", () => {
  assert.deepEqual(parseArgs(["open", "--goal", "g", "--claim", "a", "--claim=b", "--dry"]), {
    verb: "open",
    options: { goal: "g", claim: ["a", "b"], dry: true },
  });
  assert.throws(() => parseArgs(["open", "positional"]), /unexpected argument/u);
});

test("a verb the shell does not know is refused by name, and shown what there is", () => {
  assert.throws(() => run(["frobnicate"]), (error) => error.code === "UNKNOWN_VERB" && error.message.includes("workloop <verb>"));
});

test("asking what this is, is not an error", async () => {
  // A first command that answers with a refusal teaches the reader the tool is
  // hostile before it teaches them anything else.
  const printed = [];
  const stdout = process.stdout.write;
  process.stdout.write = (text) => { printed.push(text); return true; };
  try {
    for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
      assert.equal(await main(argv), 0, JSON.stringify(argv));
    }
  } finally {
    process.stdout.write = stdout;
  }
  assert.equal(printed.length, 4);
  // Derived from the tables the shell dispatches on, so a verb cannot exist
  // without appearing here.
  for (const verb of VERBS) assert.match(printed[0], new RegExp(`\\b${verb}\\b`, "u"), verb);
  assert.match(printed[0], /--granted-by/u, "and its flags with it");
});

test("a reader that stops listening is not a failure", () => {
  // `workloop log | head` closes the pipe mid-write. Printing a stack trace at
  // that is the tool complaining about being used correctly.
  const broken = { write() { const error = new Error("EPIPE"); error.code = "EPIPE"; throw error; } };
  const stdout = process.stdout;
  Object.defineProperty(process, "stdout", { value: broken, configurable: true });
  try {
    return main(["--help"]).then((code) => assert.equal(code, 0));
  } finally {
    Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
  }
});

test("every verb runs through the CLI, and the store is found by walking up", async (t) => {
  const root = workspace(t);
  const created = run(["init", "--root", root]);
  assert.equal(created.store_kind, "fs");

  const loopId = open(root);
  assert.match(loopId, /^sha256:[0-9a-f]{64}$/u);

  // Found from a subdirectory without being told where it is, the way git does.
  const fromBelow = run(["next", "--root", path.join(root, "work"), "--loop", loopId]);
  assert.equal(fromBelow.decision, "implement");
  assert.equal(fromBelow.loop_id, loopId);

  fs.writeFileSync(path.join(root, "work", "a.txt"), "done\n");
  await run(["observe", "--root", root, "--loop", loopId, "--session", "s1", "--criterion", path.join(root, "check.mjs"), "--command", "o1"]);
  assert.equal(run(["next", "--root", root, "--loop", loopId]).decision, "achieved");
  assert.deepEqual(run(["ready", "--root", root]), [], "a finished loop is not on the frontier");
});

test("the shell holds no rules of its own: a bad request fails with the service layer's code", (t) => {
  const root = workspace(t);
  run(["init", "--root", root]);
  for (const [args, code] of [
    [["open", "--root", root, "--goal", "g", "--claim", "work", "--budget", "5", "--criterion", path.join(root, "check.mjs"), "--session", "s1", "--reason", "r", "--granted-by", "self", "--command", "x"], "RECEIPTS_REQUIRED"],
    [["open", "--root", root, "--goal", "g", "--claim", "work/**", "--budget", "5", "--criterion", path.join(root, "check.mjs"), "--session", "s1", "--reason", "r", "--granted-by", "self", "--receipts", "none", "--command", "y"], "CLAIM_SHAPE"],
    [["next", "--root", root, "--loop", `sha256:${"0".repeat(64)}`], "NO_SUCH_LOOP"],
  ]) {
    assert.throws(() => run(args), (error) => error.code === code, code);
  }
});

test("a command with no store to work in is told so, and none is conjured", (t) => {
  const root = workspace(t);
  assert.throws(() => run(["ready", "--root", root]), (error) => error.code === "NO_STORE_FOUND");
  assert.equal(fs.existsSync(path.join(root, ".workloop")), false, "and the refusal created nothing");
});

test("status carries the same directive next would give, from the same function", async (t) => {
  const root = workspace(t);
  run(["init", "--root", root]);
  const loopId = open(root);
  await run(["observe", "--root", root, "--loop", loopId, "--session", "s1", "--criterion", path.join(root, "check.mjs"), "--command", "o1"]);

  const view = run(["status", "--root", root, "--loop", loopId]);
  assert.equal(view.loop_id, loopId);
  assert.deepEqual(view.claims, ["work"]);
  assert.equal(view.rounds_spent, 1);
  assert.equal(view.rounds[0].verdict, "unsatisfied");
  assert.deepEqual(view.next, run(["next", "--root", root, "--loop", loopId]), "one directive, one implementation");
});

test("the read-only verbs change not one byte", async (t) => {
  const root = workspace(t);
  run(["init", "--root", root]);
  const loopId = open(root);
  const location = path.join(root, ".workloop");
  const snapshot = () => fs.readdirSync(location, { recursive: true }).sort()
    .map((entry) => {
      const full = path.join(location, entry);
      return fs.statSync(full).isFile() ? [entry, fs.readFileSync(full).toString("base64")] : [entry, "dir"];
    });

  const before = JSON.stringify(snapshot());
  for (let round = 0; round < 3; round += 1) {
    run(["status", "--root", root, "--loop", loopId]);
    run(["log", "--root", root]);
    run(["ready", "--root", root]);
    run(["export", "--root", root]);
    // `try` starts a real process, which is exactly why it belongs in this
    // test rather than beside it: the verb whose whole purpose is to be free
    // is the one that would be worth nothing if it quietly cost something.
    await run(["try", "--root", root, "--loop", loopId, "--criterion", path.join(root, "check.mjs")]);
  }
  assert.equal(JSON.stringify(snapshot()), before, "reading is not writing");
});

test("try runs the criterion the way observe would, and records nothing", async (t) => {
  const root = workspace(t);

  // Before any ledger exists — which is when a criterion is actually being
  // written, and the moment the check is most worth having.
  const early = await run(["try", "--root", root, "--criterion", path.join(root, "check.mjs")]);
  assert.equal(early.recorded, false);
  assert.equal(early.verdict, "unsatisfied", "the work file still says todo");
  assert.deepEqual(early.failures.map((failure) => failure.id), ["not-done"]);
  assert.equal(early.exit_code, EXIT.UNSATISFIED);
  assert.equal(fs.existsSync(path.join(root, ".workloop")), false, "and asking created no ledger");

  // The working directory is the workspace, not wherever the caller stands —
  // the difference that makes "green by hand, red in the runtime" possible.
  const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-try-")));
  t.after(() => { process.chdir(repoRoot); fs.rmSync(elsewhere, { recursive: true, force: true }); });
  process.chdir(elsewhere);
  assert.equal((await run(["try", "--root", root, "--criterion", path.join(root, "check.mjs")])).verdict, "unsatisfied");
  process.chdir(repoRoot);

  // Named against a loop, it says whether this is the criterion that loop was
  // opened with. A criterion that has drifted is the one whose verdict means
  // least, so the comparison is reported rather than assumed.
  run(["init", "--root", root]);
  const loopId = open(root);
  const bound = await run(["try", "--root", root, "--loop", loopId, "--criterion", path.join(root, "check.mjs")]);
  assert.equal(bound.loop.matches, true);
  assert.equal(bound.loop.criterion_digest, bound.criterion_digest);

  const other = path.join(root, "other.mjs");
  fs.writeFileSync(other, CRITERION.replace("not-done", "renamed"));
  const drifted = await run(["try", "--root", root, "--loop", loopId, "--criterion", other]);
  assert.equal(drifted.loop.matches, false, "a different file is a different criterion, and it says so");
  assert.notEqual(drifted.criterion_digest, bound.criterion_digest);
});

test("log hands back records, and export hands back a ledger that verifies on its own", async (t) => {
  const root = workspace(t);
  run(["init", "--root", root]);
  const loopId = open(root);
  fs.writeFileSync(path.join(root, "work", "a.txt"), "done\n");
  await run(["observe", "--root", root, "--loop", loopId, "--session", "s1", "--criterion", path.join(root, "check.mjs"), "--command", "o1"]);

  const all = run(["log", "--root", root]);
  const mine = run(["log", "--root", root, "--loop", loopId]);
  assert.ok(all.length > mine.length, "the store's genesis is not the loop's");
  assert.equal(mine.every((record) => record.payload?.loop_id === loopId || record.digest === loopId), true);
  assert.deepEqual(run(["log", "--root", root, "--limit", "2"]), all.slice(-2), "a limit keeps the recent end");

  const exported = run(["export", "--root", root]);
  assert.equal(exported.record_count, all.length);
  assert.equal(exported.head_digest, all.at(-1).digest);
  // The point of an export is that it can be checked without the store it came
  // from: the chain is in it, so the chain can be re-verified from it alone.
  assertChain(exported.records, { anchorDigest: exported.manifest.genesis_digest });
  assert.equal(openLoopStore(path.join(root, ".workloop")).manifest.store_id, exported.manifest.store_id);
});

test("the shell invents nothing the service layer does not have", (t) => {
  const root = workspace(t);
  run(["init", "--root", root]);
  // A budget the caller did not state must not be supplied by the shell. The
  // service has no default for it, so inventing one here would be a policy
  // decision living where nobody can see it.
  assert.throws(() => run([
    "open", "--root", root, "--goal", "g", "--claim", "work", "--criterion", path.join(root, "check.mjs"),
    "--session", "s1", "--reason", "r", "--granted-by", "self", "--receipts", "none", "--command", "no-budget",
  ]), (error) => error.code === "BUDGET_REQUIRED");

  const loopId = open(root);
  // Nor a receipt mode.
  assert.throws(() => run(["receipt", "--root", root, "--loop", loopId, "--session", "s1", "--command", "r"]),
    (error) => error.code === "NO_RECEIPT_REGIME" || error.code === "UNKNOWN_RECEIPT_MODE");
});

test("a flag nobody reads is refused, not dropped", (t) => {
  const root = workspace(t);
  run(["init", "--root", root]);
  // `--bugdet 5` used to parse cleanly and vanish, and the loop quietly got
  // whatever the missing value happened to default to.
  assert.throws(() => run(["ready", "--root", root, "--bugdet", "5"]), (error) => error.code === "UNKNOWN_FLAG");
  assert.throws(() => run(["ready", "--root", root, "--loop", "x"]), (error) => error.code === "UNKNOWN_FLAG");
  assert.throws(() => parseArgs(["ready", "positional"]), (error) => error.code === "UNEXPECTED_ARGUMENT");
});

const repoRoot = process.cwd();
const observeVia = (location, loopId, root) => run([
  "observe", "--store", location, "--loop", loopId, "--session", "s1",
  "--criterion", path.join(root, "check.mjs"), "--command", "o-via-store",
]);

test("an explicit --store takes its root from the store, not from where the caller stands", async (t) => {
  const root = workspace(t);
  const created = run(["init", "--root", root]);
  // Registered before the directory it protects, because hooks run in
  // registration order: this test later stands inside `elsewhere`, and Windows
  // will not remove a directory that is some process's working directory. Put
  // the other way round — which is how it was written — the cleanup runs first
  // and fails with EBUSY on the only platform that enforces it.
  t.after(() => process.chdir(repoRoot));
  // A bare directory: nothing here resembles the workspace, so a wrong root
  // cannot accidentally find something that looks right.
  const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-elsewhere-")));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));

  // Standing somewhere unrelated, naming the store outright. The root that
  // reaches the verbs must be the store's own, or every path comparison after
  // this compares against the wrong tree.
  const loopId = run([
    "open", "--store", created.location, "--goal", "g", "--claim", "work",
    "--criterion", path.join(root, "check.mjs"), "--budget", "5", "--session", "s1",
    "--reason", "fixture", "--granted-by", "self", "--receipts", "none", "--command", "open",
  ]).loop_id;
  assert.deepEqual(run(["ready", "--store", created.location]), [loopId]);

  // `--root` says where to start looking. With the store named outright there
  // is nothing left to look for, and letting the flag win would resolve claims
  // against a filesystem the store does not describe.
  const misled = await run([
    "observe", "--store", created.location, "--root", elsewhere, "--loop", loopId,
    "--session", "s1", "--criterion", path.join(root, "check.mjs"), "--command", "o-with-wrong-root",
  ]);
  // The criterion runs with the workspace as its working directory. Had the
  // flag won, it would have looked for the task's files under a directory that
  // has none and come back unable to say anything.
  assert.equal(misled.records.find((record) => record.kind === "round_observed").payload.verdict, "unsatisfied");

  // The criterion runs with the workspace as its working directory, so this is
  // where a wrong root shows: it would look for `work/a.txt` under whatever
  // directory the caller happened to be in and report an unknown instead.
  process.chdir(elsewhere);
  const result = await observeVia(created.location, loopId, root);
  const round = result.records.find((record) => record.kind === "round_observed").payload;
  assert.equal(round.verdict, "unsatisfied", "the criterion found the workspace, so it could reach a verdict");
});

test("HF-08: what ships is only what is implemented", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const readFile = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

  // Two derived checks, where there used to be one convention and a list of
  // three names that did not fit it. A verb whose service function cannot be
  // named after it — `try` is a reserved word, so it never could be — was
  // indistinguishable from a verb nothing implements, and the fix on offer was
  // to lengthen the transcript. A transcript drifts; that is why it was already
  // being avoided one line above.
  const shell = readFile("src/cli.mjs");

  // 1. Every verb the shell offers is dispatched somewhere in the shell.
  for (const verb of VERBS) {
    const dispatched = shell.includes(`case "${verb}":`) || shell.includes(`verb === "${verb}"`);
    assert.ok(dispatched, `the shell offers \`${verb}\` but never dispatches it`);
  }

  // 2. Everything the shell imports from the service layer is really exported
  // there — so a dispatch cannot call into a name nobody wrote.
  for (const [, names, module_] of shell.matchAll(/^import \{([^}]+)\} from "(\.\/domain\/[\w.]+)";$/gmu)) {
    const exported = new Set([...readFile(`src/${module_.slice(2)}`).matchAll(/^export (?:async )?(?:function|const) (\w+)/gmu)].map((match) => match[1]));
    for (const name of names.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      assert.ok(exported.has(name), `the shell imports ${name} from ${module_}, which does not export it`);
    }
  }

  // The concepts the audit ruled out must not have crept back in.
  const sources = ["src/cli.mjs", "src/site.mjs", "src/store.mjs", "src/domain/loop.mjs", "src/domain/query.mjs"].map(readFile).join("\n");
  for (const retired of ["locator", "claimToken", "reattach", "forkIdentity", "permissionDecision"]) {
    assert.equal(sources.includes(retired), false, `${retired} was ruled out but appears in the shipped runtime`);
  }

  // Asked of the release itself, not of the source tree. Reading the sources
  // said nothing about what ships: the tarball carried 139 files of the
  // previous implementation's documentation, and every string check here
  // passed anyway.
  const shipped = npmJson(["pack", "--dry-run"], { cwd: repoRoot })[0].files.map((entry) => entry.path);
  for (const path_ of shipped) {
    assert.match(path_, /^(src\/|bin\/|greenfield\/WORKFLOW\.md$|package\.json$|README\.md$|LICENSE$)/u, `${path_} is not part of the runtime`);
  }
  assert.ok(shipped.includes("bin/workloop.mjs"), "and what is the runtime is there");
  assert.ok(shipped.includes("greenfield/WORKFLOW.md"), "including the workflow text HF-09 is about");

  // The criterion contract in the documentation is the one the code enforces.
  const contract = readFile("greenfield/slices/02-single-loop.md");
  assert.match(contract, /\b4 = satisfied/u);
  assert.equal(EXIT.SATISFIED, 4);
  assert.equal(EXIT.UNSATISFIED, 3);
  assert.match(contract, new RegExp(VERDICT_PREFIX, "u"), "the documented verdict line is the real one");
});

test("HF-09: every step of the shipped workflow has a decidable completion condition", () => {
  const workflow = fs.readFileSync(path.resolve(import.meta.dirname, "..", "greenfield", "WORKFLOW.md"), "utf8");
  const steps = workflow.split("\n").filter((line) => /^### /u.test(line));
  assert.ok(steps.length > 0, "the workflow declares no steps");
  const blocks = workflow.split(/^### /mu).slice(1);
  for (const [index, block] of blocks.entries()) {
    assert.match(block, /\*\*完成条件\*\*/u, `step ${index + 1} (${steps[index]}) has no completion condition`);
  }
});
