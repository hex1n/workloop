// The host face: the CLI shell, the read-only verbs, export — and HF-08/HF-09,
// the two checks that keep what is shipped honest about what is implemented.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT, VERDICT_PREFIX } from "../src/domain/criterion.mjs";
import { VERBS, parseArgs, run } from "../src/cli.mjs";
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-cli-")));
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

test("a verb the shell does not know is refused by name, not by silence", () => {
  assert.throws(() => run(["frobnicate"]), (error) => error.code === "UNKNOWN_VERB");
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
    [["open", "--root", root, "--goal", "g", "--claim", "work", "--criterion", path.join(root, "check.mjs"), "--session", "s1", "--reason", "r", "--granted-by", "self", "--command", "x"], "RECEIPTS_REQUIRED"],
    [["open", "--root", root, "--goal", "g", "--claim", "work/**", "--criterion", path.join(root, "check.mjs"), "--session", "s1", "--reason", "r", "--granted-by", "self", "--receipts", "none", "--command", "y"], "CLAIM_SHAPE"],
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
  }
  assert.equal(JSON.stringify(snapshot()), before, "reading is not writing");
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

test("HF-08: what ships is only what is implemented", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const readFile = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

  // The verb list the shell offers must be the verbs the service layer has —
  // taken from the module, never transcribed, because a transcript drifts.
  const service = new Set([...readFile("src/domain/loop.mjs").matchAll(/^export (?:async )?function (\w+)/gmu)].map((match) => match[1]));
  for (const verb of VERBS) {
    if (verb === "init") continue;
    const implemented = service.has(verb) || service.has(`${verb}Loop`) || ["status", "log", "export"].includes(verb);
    assert.ok(implemented, `the shell offers \`${verb}\` but no service function backs it`);
  }

  // The concepts the audit ruled out must not have crept back in.
  const sources = ["src/cli.mjs", "src/site.mjs", "src/store.mjs", "src/domain/loop.mjs", "src/domain/query.mjs"].map(readFile).join("\n");
  for (const retired of ["locator", "claimToken", "reattach", "forkIdentity", "permissionDecision"]) {
    assert.equal(sources.includes(retired), false, `${retired} was ruled out but appears in the shipped runtime`);
  }

  // The criterion contract in the documentation is the one the code enforces.
  const contract = readFile("greenfield/slices/02-single-loop.md");
  assert.match(contract, new RegExp(`\\b4 = satisfied`, "u"));
  assert.equal(EXIT.SATISFIED, 4);
  assert.equal(EXIT.UNSATISFIED, 3);
  assert.match(contract, new RegExp(VERDICT_PREFIX.replace(/_/gu, "_"), "u"), "the documented verdict line is the real one");
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
