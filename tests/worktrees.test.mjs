// WT-02 / WT-05: nesting that is real versus nesting that only looks real, and
// what survives a worktree being removed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore, openStore } from "../src/store.mjs";
import { KIND, discover, siteForNewStore } from "../src/site.mjs";
import { EXIT, VERDICT_PREFIX } from "../src/domain/criterion.mjs";
import { amend, next, observe, openLoop, openLoopStore } from "../src/domain/loop.mjs";
import { status } from "../src/domain/query.mjs";

const git = (root, ...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const CRITERION = `
import fs from "node:fs";
const text = fs.existsSync("work/a.txt") ? fs.readFileSync("work/a.txt", "utf8").trim() : "";
const failures = text.includes("done") ? [] : [{ id: "not-done" }];
console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: failures.length === 0 ? "satisfied" : "unsatisfied", failures }));
process.exit(failures.length === 0 ? ${EXIT.SATISFIED} : ${EXIT.UNSATISFIED});
`;

function repo(t, at = null) {
  const root = at ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-wt-")));
  if (at !== null) fs.mkdirSync(root, { recursive: true });
  if (at === null) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", ".");
  git(root, "config", "user.email", "gate@workloop.test");
  git(root, "config", "user.name", "gate");
  git(root, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "README"), "seed\n");
  git(root, "add", "README");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

const init = (root, options = {}) => {
  const site = siteForNewStore(root, options);
  fs.mkdirSync(site.location, { recursive: true });
  createStore({ location: site.location, storeKind: site.kind, commandId: "genesis" });
  return site;
};

test("WT-02: a nested repository keeps its own ledger; a nested directory does not", (t) => {
  const outer = repo(t);
  init(outer);

  // A repository inside a repository is a different set of files, and git is
  // what says so — the outer repo tracks none of the inner one's contents and
  // its pathspecs cannot reach them. Two ledgers, two trees, no conflict.
  const inner = repo(t, path.join(outer, "vendor", "sub"));
  const nested = init(inner);
  assert.equal(nested.kind, KIND.GIT);
  assert.notEqual(openStore(nested.location).manifest.store_id, openStore(discover(outer).location).manifest.store_id);

  // A plain subdirectory is a different matter: it is the outer tree. Asked
  // for a store there, the runtime says the outer one already covers it.
  const plain = path.join(outer, "just-a-directory");
  fs.mkdirSync(plain);
  assert.throws(() => siteForNewStore(plain, { kind: KIND.FS }), (error) => error.code === "STORE_EXISTS");

  // And below a *filesystem* store, which has no tree boundary of its own,
  // nesting is refused outright — its checkpoint walks everything under it.
  const plainRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-plain-")));
  t.after(() => fs.rmSync(plainRoot, { recursive: true, force: true }));
  init(plainRoot);
  const under = path.join(plainRoot, "child");
  fs.mkdirSync(under);
  assert.throws(() => siteForNewStore(under), (error) => error.code === "STORE_NESTED_INSIDE");
});

test("WT-02: discovery stops at the first store it meets and does not reach past it", (t) => {
  const outer = repo(t);
  const outerSite = init(outer);
  const inner = repo(t, path.join(outer, "vendor", "sub"));
  const innerSite = init(inner);

  const deep = path.join(inner, "src", "nested");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(fs.realpathSync.native(discover(deep).location), fs.realpathSync.native(innerSite.location), "the nearest ledger wins");
  assert.equal(fs.realpathSync.native(discover(outer).location), fs.realpathSync.native(outerSite.location));
});

test("WT-02: a copy of a whole repository is a collision, and looking does not change it", (t) => {
  const root = repo(t);
  const site = init(root);
  const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-copy-")));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.cpSync(root, path.join(elsewhere, "copy"), { recursive: true });

  const copied = path.join(elsewhere, "copy", ".git", "workloop");
  const before = fs.readFileSync(path.join(copied, "manifest.json"));
  assert.throws(() => openStore(copied), (error) => error.code === "STORE_COLLISION");
  assert.deepEqual(fs.readFileSync(path.join(copied, "manifest.json")), before, "the refusal wrote nothing");
  assert.ok(openStore(site.location), "and the original is untouched");
});

test("WT-02: a filesystem ledger and a nested repository's ledger cannot coexist, in either order", (t) => {
  // A filesystem checkpoint walks everything under its root, straight through
  // the repository boundary that exempts one git ledger from another. So the
  // arrangement is refused whichever end is built first — which is also what
  // makes a three-level version of it unconstructible rather than merely
  // undetected.
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-top-")));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  init(top);
  const middle = repo(t, path.join(top, "vendor", "mid"));
  assert.throws(() => siteForNewStore(middle), (error) => error.code === "STORE_NESTED_INSIDE");

  // The other order: the repository's ledger first, the filesystem one after.
  const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-order-")));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  init(repo(t, path.join(other, "vendor", "mid")));
  assert.throws(() => siteForNewStore(other, { kind: KIND.FS }), (error) => error.code === "STORE_CONTAINS_NESTED");
});

test("WT-02: a store is never created over a ledger it cannot see past", (t) => {
  // The downward scan has to look inside `.git` on purpose — a git ledger
  // lives in the one directory a scan otherwise skips, and a store created
  // above one that it never saw is two ledgers over one tree.
  const outer = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-over-")));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const inner = repo(t, path.join(outer, "sub"));
  init(inner);
  assert.throws(() => siteForNewStore(outer, { kind: KIND.FS }), (error) => error.code === "STORE_CONTAINS_NESTED");

  // And the kind of what it finds is read, not inferred from the path shape:
  // an fs ledger mistaken for a git one was let through by the exemption.
  const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-mixed-")));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const child = path.join(other, "child");
  fs.mkdirSync(child);
  init(child);
  repo(t, other);
  assert.throws(() => siteForNewStore(other), (error) => error.code === "STORE_CONTAINS_NESTED");
});

test("WT-05: removing a worktree takes nothing away from the history it observed", async (t) => {
  const root = repo(t);
  const site = init(root);
  const worktree = path.join(root, "side");
  git(root, "worktree", "add", "-q", worktree, "-b", "side");
  fs.mkdirSync(path.join(worktree, "work"));
  fs.writeFileSync(path.join(worktree, "work", "a.txt"), "todo\n");
  fs.writeFileSync(path.join(worktree, "check.mjs"), CRITERION);

  const session = () => openLoopStore(site.location);
  const loopId = openLoop(session(), {
    root: worktree, goal: "work must say done", claims: ["work"],
    criterionFile: path.join(worktree, "check.mjs"), roundsBudget: 5, session: "s1",
    reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open",
  }).loopId;
  await observe(session(), { root: worktree, loopId, session: "s1", criterionFile: path.join(worktree, "check.mjs"), commandId: "o1" });

  git(root, "worktree", "remove", "--force", worktree);
  assert.equal(fs.existsSync(worktree), false);

  // The ledger lives in the common directory, so the worktree was only ever a
  // place to stand. Everything it recorded is still here, and still readable
  // from the main checkout.
  const view = status(session(), { loopId, root });
  assert.equal(view.rounds_spent, 1);
  assert.equal(view.rounds[0].verdict, "unsatisfied");
  assert.equal(next(session(), { loopId }).decision, "repair");

  // Rebuilding a worktree at the same path reuses no identity: the store's
  // comes from the common directory and the loop's from its opening record.
  git(root, "worktree", "add", "-q", worktree, "-b", "side-again");
  assert.equal(fs.realpathSync.native(discover(worktree).location), fs.realpathSync.native(site.location), "same ledger");
  assert.equal(status(session(), { loopId, root }).rounds_spent, 1, "and the same single round");
});

test("SL-13: status marks the rounds an amendment retired, and keeps them", async (t) => {
  const root = repo(t);
  const site = init(root);
  fs.mkdirSync(path.join(root, "work"));
  fs.writeFileSync(path.join(root, "work", "a.txt"), "todo\n");
  fs.writeFileSync(path.join(root, "old.mjs"), CRITERION);
  fs.writeFileSync(path.join(root, "new.mjs"), `${CRITERION}\n// a different rule\n`);

  const session = () => openLoopStore(site.location);
  const loopId = openLoop(session(), {
    root, goal: "g", claims: ["work"], criterionFile: path.join(root, "old.mjs"),
    roundsBudget: 5, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open",
  }).loopId;
  await observe(session(), { root, loopId, session: "s1", criterionFile: path.join(root, "old.mjs"), commandId: "o1" });
  assert.equal(status(session(), { loopId, root }).rounds[0].stale, false);

  amend(session(), { loopId, criterionFile: path.join(root, "new.mjs"), reason: "different rule now", commandId: "am" });
  const view = status(session(), { loopId, root });
  // Marked, not removed: it happened, it cost a round, and it no longer
  // answers the question the loop is now asking. A reader has to be able to
  // see all three of those at once.
  assert.equal(view.rounds.length, 1, "history is not rewritten");
  assert.equal(view.rounds[0].stale, true);
  assert.equal(view.rounds_spent, 1, "and the round is still spent");
  assert.equal(view.next.decision, "implement");
  assert.equal(view.next.feedback, null);
});

test("WT-05: a verb that needs the workspace refuses when the workspace is gone", async (t) => {
  const root = repo(t);
  const site = init(root);
  const worktree = path.join(root, "side");
  git(root, "worktree", "add", "-q", worktree, "-b", "side");
  fs.mkdirSync(path.join(worktree, "work"));
  fs.writeFileSync(path.join(worktree, "work", "a.txt"), "todo\n");
  fs.writeFileSync(path.join(root, "check.mjs"), CRITERION);

  const session = () => openLoopStore(site.location);
  const loopId = openLoop(session(), {
    root: worktree, goal: "g", claims: ["work"], criterionFile: path.join(root, "check.mjs"),
    roundsBudget: 5, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open",
  }).loopId;

  git(root, "worktree", "remove", "--force", worktree);
  // Reading is still fine; working is not. "That place no longer exists" is a
  // different answer from "try again later", and the loop says which.
  assert.ok(status(session(), { loopId, root }));
  await assert.rejects(
    () => observe(session(), { root: worktree, loopId, session: "s1", criterionFile: path.join(root, "check.mjs"), commandId: "o1" }),
    (error) => error.code === "NO_SUCH_WORKSPACE",
  );
  assert.equal(status(session(), { loopId, root }).rounds_spent, 0, "and no round was spent on a place that is not there");
});
