// GR-01 … GR-07: the git receipt.
//
// Every repository here is a real one, and every git command is the one the
// runtime actually runs. The point of a receipt is that it is evidence the
// runtime gathered itself, so a test that simulated git would be testing the
// simulation.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestOf } from "../src/canonical.mjs";
import { createStore } from "../src/store.mjs";
import { EXIT, VERDICT_PREFIX } from "../src/domain/criterion.mjs";
import { amend, next, observe, openLoop, openLoopStore, receipt } from "../src/domain/loop.mjs";
import { MODE, STANDING, STATUS, receiptStanding, takeReceipt } from "../src/domain/receipt.mjs";
import { status } from "../src/domain/query.mjs";
import { DECISION, VERDICT } from "../src/domain/vocabulary.mjs";

const RECEIPT_CHILD = path.resolve(import.meta.dirname, "helpers", "receipt-child.mjs");

const CRITERION = `
import fs from "node:fs";
const text = fs.readFileSync("src/a.txt", "utf8").trim();
const failures = text.includes("done") ? [] : [{ id: "not-done", expected: "done", actual: text }];
console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: failures.length === 0 ? "satisfied" : "unsatisfied", failures }));
process.exit(failures.length === 0 ? ${EXIT.SATISFIED} : ${EXIT.UNSATISFIED});
`;

const git = (root, ...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", ".");
  git(root, "config", "user.email", "gate@workloop.test");
  git(root, "config", "user.name", "gate");
  // The environment's own git config must not decide whether this test passes.
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", path.join(root, "no-hooks"));

  fs.writeFileSync(path.join(root, "README"), "seed\n");
  git(root, "add", "README");
  git(root, "commit", "-q", "-m", "seed");

  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "src", "a.txt"), "todo\n");
  fs.writeFileSync(path.join(root, "docs", "b.txt"), "notes\n");
  fs.writeFileSync(path.join(root, "check.mjs"), CRITERION);

  // The ledger lives inside the repository it records, which is the situation
  // GR-05 is about.
  const location = path.join(root, ".workloop");
  createStore({ location, commandId: "genesis" });
  return { root, location, session: () => openLoopStore(location), criterionFile: path.join(root, "check.mjs") };
}

// The criterion sits at the workspace root, so the fixture can say where the
// claims are rooted without every call site repeating it.
const open = (session, claims = ["src"], criterionFile) => openLoop(session, {
  root: path.dirname(criterionFile),
  goal: "make src/a.txt say done", claims, criterionFile, roundsBudget: 5,
  session: "s1", reason: "fixture", grantedBy: "self", receipts: "git", commandId: "open",
});

const staged = (root) => git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
const payloadOf = (result) => result.records.at(-1).payload;

test("GR-01: a task-scoped stage keeps another task's index entry, and the commit leaves it staged", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  // Somebody else — another loop, the user, an editor — stages their own file.
  git(root, "add", "docs/b.txt");

  const stage = payloadOf(receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" }));
  assert.deepEqual(staged(root), ["docs/b.txt", "src/a.txt"], "the foreign entry survives the task-scoped add");
  assert.equal(stage.status, STATUS.UNCERTAIN, "content the loop cannot account for is never vouched for");
  assert.match(stage.reasons[0], /docs\/b\.txt/u);

  const commit = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }));
  assert.deepEqual(commit.paths, ["src/a.txt"], "the commit carries only the task's paths");
  assert.deepEqual(staged(root), ["docs/b.txt"], "and the other task's entry is still staged afterwards");
  assert.equal(commit.status, STATUS.UNCERTAIN);
});

test("GR-02: a clean stage receipt causally binds a clean task-scoped commit", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  const head = git(root, "rev-parse", "HEAD");

  const stage = payloadOf(receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" }));
  assert.equal(stage.status, STATUS.CLEAN);
  assert.deepEqual(stage.reasons, []);

  const commit = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }));
  assert.equal(commit.status, STATUS.CLEAN);
  assert.equal(commit.head_before, head);
  assert.equal(commit.parent_oid, head, "the commit is a child of the HEAD the receipt was taken against");
  assert.deepEqual(commit.paths, ["src/a.txt"]);
  assert.equal(commit.commit_oid, git(root, "rev-parse", "HEAD"));
});

test("GR-03: a host index mutation after the stage degrades the commit receipt without swallowing it", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  assert.equal(payloadOf(receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" })).status, STATUS.CLEAN);

  git(root, "add", "docs/b.txt");
  const commit = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }));

  assert.equal(commit.status, STATUS.UNCERTAIN, "the receipt degrades");
  assert.ok(commit.commit_oid, "but the host's commit still happened — the runtime is not the approver");
  assert.deepEqual(git(root, "diff-tree", "-r", "--no-commit-id", "--name-only", "HEAD").split("\n").filter(Boolean), ["src/a.txt"]);
  assert.deepEqual(staged(root), ["docs/b.txt"], "the foreign content was not swallowed into the commit");
});

test("GR-04: a direct Git race keeps the host's success and records an uncertain receipt", (t) => {
  const { root, session, criterionFile } = repo(t);
  git(root, "add", "docs/b.txt");
  const { loopId } = open(session(), ["src"], criterionFile);

  const result = receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" });
  assert.equal(result.replayed, false, "the operation succeeded");
  assert.ok(staged(root).includes("src/a.txt"), "the task's own paths were staged");
  assert.equal(payloadOf(result).status, STATUS.UNCERTAIN, "clean is never fabricated");
});

test("GR-05: the runtime's control plane never enters a receipt, even under a '.' claim", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["."], criterionFile);

  const stage = payloadOf(receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" }));
  assert.equal(stage.status, STATUS.CLEAN, "a loop that claims everything owns everything it staged");
  assert.ok(stage.paths.includes("src/a.txt") && stage.paths.includes("docs/b.txt"), "task data is in");
  assert.equal(stage.paths.some((entry) => entry.startsWith(".workloop")), false, "the ledger is not");

  const commit = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }));
  assert.equal(commit.paths.some((entry) => entry.startsWith(".workloop")), false);
  // Not merely excluded from the receipt: never tracked at all. A loop that
  // committed its own ledger into the repository it records would be recording
  // the record of itself.
  assert.equal(git(root, "ls-files", ".workloop"), "");
  assert.match(git(root, "status", "--porcelain", "--untracked-files=normal"), /\?\? \.workloop/u);
});

test("GR-06: an amended history unlands a receipt whose content never changed", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  const recorded = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }));
  assert.equal(recorded.status, STATUS.CLEAN);

  const claims = ["src"];
  const location = session().location;
  assert.equal(receiptStanding({ root, receipt: recorded, claims, storeLocation: location }).standing, STANDING.IN_FORCE);

  // Rewrites the commit without touching a byte of the task's content. Nothing
  // about the artifacts changed; the evidence for them did.
  git(root, "commit", "-q", "--amend", "-m", "reworded");
  assert.equal(git(root, "show", "HEAD:src/a.txt"), "done", "the content is identical");
  assert.equal(
    receiptStanding({ root, receipt: recorded, claims, storeLocation: location }).standing,
    STANDING.UNLANDED,
    "a commit that is no longer an ancestor of HEAD cannot support a certification",
  );
});

test("GR-07: drift on the task paths unseats the receipt; drift elsewhere does not", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  const recorded = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }));
  const standing = () => receiptStanding({ root, receipt: recorded, claims: ["src"], storeLocation: session().location });
  assert.equal(standing().standing, STANDING.IN_FORCE);

  // Non-task drift, in every form. SL-07's rule: what a neighbour does to its
  // own paths can never unseat this loop's evidence.
  fs.writeFileSync(path.join(root, "docs", "b.txt"), "edited\n");
  fs.writeFileSync(path.join(root, "docs", "c.txt"), "new\n");
  git(root, "add", "docs/b.txt");
  assert.equal(standing().standing, STANDING.IN_FORCE, "a neighbour's drift is not this loop's problem");

  for (const [label, disturb, restore] of [
    ["unstaged", () => fs.writeFileSync(path.join(root, "src", "a.txt"), "drifted\n"), () => fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n")],
    ["staged", () => {
      fs.writeFileSync(path.join(root, "src", "a.txt"), "drifted\n");
      git(root, "add", "src/a.txt");
    }, () => {
      git(root, "restore", "--staged", "--worktree", "--source", "HEAD", "src/a.txt");
    }],
    ["untracked", () => fs.writeFileSync(path.join(root, "src", "new.mjs"), "\n"), () => fs.rmSync(path.join(root, "src", "new.mjs"))],
  ]) {
    disturb();
    const result = standing();
    assert.equal(result.standing, STANDING.DRIFTED, `${label} drift must unseat the receipt`);
    assert.match(result.drift.join(" "), new RegExp(`^${label}:|\\s${label}:`, "u"), `${label} drift is named as such`);
    restore();
    assert.equal(standing().standing, STANDING.IN_FORCE, `and the loop recovers once ${label} drift is undone`);
  }

  // A committed follow-up on the task paths: the receipt is still an ancestor,
  // so only the path comparison can catch this one.
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done, and more\n");
  git(root, "add", "src/a.txt");
  git(root, "commit", "-q", "-m", "follow-up");
  const after = standing();
  assert.equal(after.standing, STANDING.DRIFTED);
  assert.match(after.drift.join(" "), /committed:src\/a\.txt/u);
});

test("GR-06/07 end to end: an achievement rests on a receipt the runtime re-verified", async (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);

  // Round 1: the work is not done. No receipt exists at all.
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });
  const afterFirst = session().read().at(-2).payload;
  assert.equal(afterFirst.verdict, VERDICT.UNSATISFIED);
  assert.equal(afterFirst.receipt_state, STANDING.NONE);
  assert.equal(next(session(), { loopId }).decision, DECISION.PRODUCE_RECEIPT, "under the git regime, evidence comes before repair");

  // Round 2: the work is done and receipted, so the loop may be certified.
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  const recorded = receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" });
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-2" });

  const records = session().read();
  const round = records.find((entry) => entry.kind === "round_observed" && entry.payload.round === 2).payload;
  assert.equal(round.verdict, VERDICT.SATISFIED);
  assert.equal(round.receipt_state, STANDING.IN_FORCE);
  assert.equal(round.receipt_digest, recorded.records.at(-1).digest, "the round binds the receipt record itself, by digest");
  assert.equal(records.at(-1).payload.outcome, "achieved");
});

test("GR-07 end to end: a satisfied criterion over drifted paths is refused certification", async (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" });

  // The criterion will still pass — "done" is still in the file — but the file
  // is no longer the one the receipt vouched for.
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done, plus something nobody receipted\n");
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });

  const records = session().read();
  const round = records.find((entry) => entry.kind === "round_observed").payload;
  assert.equal(round.verdict, VERDICT.SATISFIED, "the check passed");
  assert.equal(round.receipt_state, STANDING.DRIFTED);
  assert.equal(round.receipt_digest, null);
  assert.equal(records.some((entry) => entry.kind === "loop_terminal"), false, "and the loop was not certified");
  assert.equal(next(session(), { loopId }).decision, DECISION.PRODUCE_RECEIPT);
});

test("once the receipt exists the directive moves on, instead of asking again", async (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");

  // Observing before receipting: the check passes, but nothing vouches for it.
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });
  assert.equal(next(session(), { loopId }).decision, DECISION.PRODUCE_RECEIPT);

  // The host does exactly what it was told. Asking again must not return the
  // same instruction — a directive that never changes is a loop with no exit.
  receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" });
  assert.equal(next(session(), { loopId }).decision, DECISION.JUDGE, "the evidence exists and is waiting to be judged");

  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-2" });
  assert.equal(next(session(), { loopId }).decision, DECISION.ACHIEVED);
});

test("a loop that claims the whole repository can still be certified", async (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["."], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" });

  // The ledger sits inside the claim and is written on every append, so it is
  // permanently untracked, permanently changing content under ".". If the
  // drift checks did not exclude the control plane, this loop could never be
  // certified — the runtime's own record-keeping would unseat its evidence.
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });
  const round = session().read().find((entry) => entry.kind === "round_observed").payload;
  assert.equal(round.receipt_state, STANDING.IN_FORCE);
  assert.equal(session().read().at(-1).payload.outcome, "achieved");
});

test("SL-13: an amendment retires the judgments, not the evidence", async (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  // A round that fails, with a receipt in force behind it.
  receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" });
  await observe(session(), { root, loopId, session: "s1", criterionFile, commandId: "observe-1" });
  const before = session().read().find((entry) => entry.kind === "round_observed").payload;
  assert.equal(before.verdict, VERDICT.UNSATISFIED);
  assert.equal(before.receipt_state, STANDING.IN_FORCE);
  assert.equal(next(session(), { root, loopId }).decision, DECISION.REPAIR);

  const stricter = path.join(root, "stricter.mjs");
  fs.writeFileSync(stricter, `${fs.readFileSync(criterionFile, "utf8")}\n// a different bar\n`);
  amend(session(), { loopId, criterionFile: stricter, reason: "raise the bar", commandId: "am" });

  // A receipt says what the artifacts are; a criterion says what would be good
  // enough. Changing the second does not unmake the first — the receipt is
  // still on the loop, and the next round will re-verify it as usual. What
  // changed is that nothing has been judged under the new rule.
  const state = session().replay().state.loops[loopId];
  assert.ok(state.receipt, "the evidence is still there");
  assert.equal(state.receipt.status, STATUS.CLEAN);
  const directive = next(session(), { root, loopId });
  assert.equal(directive.decision, DECISION.IMPLEMENT, "not produce_receipt: the loop is not missing evidence");
  assert.equal(directive.feedback, null);
});

test("a commit the ledger never learned about can be named, and healed by a retry", async (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");

  // The window the design cannot close: git commits before anything can be
  // written about it. Here the commit happens and the append never does —
  // exactly what a process dying in between leaves behind.
  const orphan = takeReceipt({ root, mode: MODE.COMMIT, claims: ["src"], storeLocation: session().location, loopId, commandId: "lost-in-the-crash" });
  assert.ok(orphan.commit_oid);

  const found = status(session(), { loopId, root }).unrecorded_commits;
  assert.equal(found.exhausted, false);
  assert.deepEqual(found.commits, [{ commit_oid: orphan.commit_oid, command_id: "lost-in-the-crash" }],
    "the runtime can point at the commit its own ledger denies");

  // Healed by the path that already existed: the same command id again finds
  // nothing left to commit and attests the one already there.
  const healed = receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "lost-in-the-crash" });
  assert.equal(payloadOf(healed).commit_oid, orphan.commit_oid, "it vouches for that very commit");
  assert.deepEqual(status(session(), { loopId, root }).unrecorded_commits.commits, [], "and the ledger no longer denies it");
});

test("a commit made by somebody else is not this loop's to answer for", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  git(root, "add", "src/a.txt");
  git(root, "commit", "-q", "-m", "workloop receipt");   // the message alone proves nothing

  assert.deepEqual(status(session(), { loopId, root }).unrecorded_commits.commits, [],
    "a line of prose anybody can write is not provenance");
});

test("a loop that declared no receipt regime refuses to produce one", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = openLoop(session(), {
    root,
    goal: "g", claims: ["src"], criterionFile, roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open",
  });
  assert.throws(
    () => receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }),
    (error) => error.code === "NO_RECEIPT_REGIME",
  );
});

test("work the host committed itself can still be receipted", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  // The host owns git and may commit by hand. A loop that could never produce
  // evidence for such work could never be certified at all.
  git(root, "add", "src/a.txt");
  git(root, "commit", "-q", "-m", "committed by the host, not by workloop");
  const head = git(root, "rev-parse", "HEAD");

  const attested = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit-1" }));
  assert.equal(attested.status, STATUS.CLEAN);
  assert.equal(attested.commit_oid, head, "the receipt attests the commit that already holds the work");
  assert.equal(attested.head_before, head, "and says so: a made commit has head_before === parent_oid instead");
  assert.deepEqual(attested.paths, ["src/a.txt"]);
  assert.equal(receiptStanding({ root, receipt: attested, claims: ["src"], storeLocation: session().location }).standing, STANDING.IN_FORCE);
});

test("a claim that simply did not change this round is still clean", (t) => {
  const { root, session, criterionFile } = repo(t);
  fs.mkdirSync(path.join(root, "docs2"));
  fs.writeFileSync(path.join(root, "docs2", "notes.md"), "notes\n");
  git(root, "add", "docs2");
  git(root, "commit", "-q", "-m", "a second claim, tracked");

  const { loopId } = open(session(), ["src", "docs2"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  const commit = payloadOf(receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }));

  // Only `src` changed, so only `src` is in the commit. An earlier rule asked
  // whether each claim contributed to the operation and flagged the ones that
  // had not — which meant a loop with two claims could never be vouched for
  // unless both changed in the same round. It surfaced the first time the
  // runtime was pointed at a real repository.
  assert.equal(commit.status, STATUS.CLEAN, `an untouched claim is not an unaccountable one: ${commit.reasons}`);
  assert.deepEqual(commit.reasons, []);
});

test("a receipt never reports clean over a claim it could not see", (t) => {
  const { root, session, criterionFile } = repo(t);
  // git tracks `Src/a.txt`; the directory is then renamed by case only, which
  // git is never told about. Every pathspec built from the disk spelling now
  // matches nothing git knows.
  git(root, "add", "src/a.txt");
  git(root, "commit", "-q", "-m", "tracked as src");
  fs.renameSync(path.join(root, "src"), path.join(root, "tmp"));
  fs.renameSync(path.join(root, "tmp"), path.join(root, "Src"));

  // The condition is whether git's spelling still reaches the directory, and
  // the earlier check did not ask that. It looked for an entry named `Src`,
  // which is there on every filesystem after the rename above — so it never
  // fired, and on a case-sensitive volume the test went on to run an entirely
  // different scenario: git sees `src/a.txt` deleted and `Src/a.txt` added, so
  // there is no emptiness to be unaccountable about. It failed on the first
  // Linux run CI ever did, which is the only reason anyone found out.
  //
  // Skipped rather than silently returned: a check that quietly does nothing
  // is what this test was already guilty of. The assertion still runs in CI on
  // the macOS legs, which are case-insensitive.
  if (!fs.existsSync(path.join(root, "src"))) {
    t.skip("this volume is case-sensitive, so renaming src to Src is a move git can see, not a spelling git has lost");
    return;
  }

  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "Src", "a.txt"), "uncommitted\n");
  const stage = payloadOf(receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" }));

  // Staging nothing while the task's own file is modified is not a clean tree.
  // It is a tree the runtime could not see, and those are different answers.
  assert.deepEqual(stage.paths, []);
  assert.equal(stage.status, STATUS.UNCERTAIN, "an emptiness nobody can account for is never clean");
  assert.match(stage.reasons.join(" "), /matched nothing under it/u);
  assert.match(git(root, "status", "--porcelain"), /a\.txt/iu, "and the change really is still sitting there, unstaged");
});

test("git failures are refused rather than turned into a receipt", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = openLoop(session(), {
    root,
    goal: "g", claims: ["absent"], criterionFile, roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "git", commandId: "open",
  });
  // Claims that hold nothing and appear in no commit: there is no commit to
  // make and none to attest, so there is no receipt either.
  assert.throws(
    () => receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" }),
    (error) => error.code === "NOTHING_TO_COMMIT",
  );
  // But a claim that names nothing yet is ordinary — claims name intent, and
  // on the first round the agent has not created that path. Staging must not
  // turn that into a hard failure of the whole receipt.
  const early = payloadOf(receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" }));
  assert.deepEqual(early.paths, []);
  assert.equal(early.status, STATUS.CLEAN, "nothing claimed, nothing foreign: there is nothing to be uncertain about");

  // A workspace that is not the repository root would make every path
  // comparison in the adapter compare strings with different origins.
  assert.throws(
    () => takeReceipt({ root: path.join(root, "src"), mode: MODE.STAGE, claims: ["."], storeLocation: null }),
    (error) => error.code === "NOT_REPOSITORY_ROOT",
  );
});

test("a receipt over a crowded index is recorded rather than thrown away", (t) => {
  const { root, session, criterionFile } = repo(t);
  fs.mkdirSync(path.join(root, "other"));
  for (let index = 0; index < 25; index += 1) fs.writeFileSync(path.join(root, "other", `f${index}.txt`), `${index}\n`);
  git(root, "add", "other");
  const { loopId } = open(session(), ["src"], criterionFile);

  // More foreign entries than the reasons list can hold. The git operation has
  // already happened by the time the payload is built, so a payload the log
  // refuses would leave the index changed with nothing recording it.
  const result = receipt(session(), { loopId, root, mode: MODE.STAGE, session: "s1", commandId: "stage" });
  const stage = payloadOf(result);
  assert.equal(stage.status, STATUS.UNCERTAIN);
  assert.ok(stage.reasons.length <= 21, `reasons must stay within what the log carries, got ${stage.reasons.length}`);
  assert.match(stage.reasons.at(-1), /and \d+ more/u, "and it says how many it dropped rather than pretending there were none");
});

test("a retry racing its original still commits once", async (t) => {
  const { root, location, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  const before = Number(git(root, "rev-list", "--count", "HEAD"));

  // Real processes, released together by a barrier so they genuinely overlap.
  //
  // What this proves: two callers sharing a command id produce one commit, one
  // record, and one "recorded" outcome. What it does NOT prove is the in-lock
  // idempotence re-check in `receipt` — removing that guard leaves this test
  // green, because the second caller finds nothing left to commit and attests
  // the first caller's commit instead. The guard only earns its keep when the
  // working tree also moves between the two, which there is no deterministic
  // way to force from here. It is recorded as untested in the slice spec
  // rather than left looking covered.
  const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-barrier-"));
  t.after(() => fs.rmSync(barrier, { recursive: true, force: true }));
  const run = (id) => new Promise((resolve) => {
    const child = spawn(process.execPath, [RECEIPT_CHILD, location, root, loopId, id, "shared-command", barrier, "2"], { encoding: "utf8" });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("close", () => resolve(out.trim()));
  });
  const outcomes = await Promise.all([run("s1"), run("s2")]);

  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), before + 1, `one commit, not ${outcomes}`);
  assert.equal(outcomes.filter((line) => line === "recorded").length, 1, `exactly one caller recorded it: ${outcomes}`);
  assert.equal(session().read().filter((entry) => entry.kind === "loop_receipt").length, 1);
});

test("a retry that arrives while the original holds the lock commits once", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "done\n");
  const commits = () => Number(git(root, "rev-list", "--count", "HEAD"));
  const before = commits();

  // The window: both callers passed the check outside the lock, one is inside,
  // and the other's record lands before it looks again. Waiting for that to
  // happen by itself is not a test — so the moment is named and stepped into.
  let landed = null;
  const result = receipt(session(), {
    loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "shared",
    onPhase: (phase) => {
      if (phase !== "git_index_locked" || landed !== null) return;
      landed = takeReceipt({ root, mode: MODE.COMMIT, claims: ["src"], storeLocation: session().location, loopId, commandId: "shared" });
      openLoopStore(session().location).append({
        commandId: "shared",
        requestDigest: digestOf({ loopId, mode: MODE.COMMIT, session: "s1", claims: ["src"] }),
        prepare: () => [{ kind: "loop_receipt", payload: { ...landed, loop_id: loopId, recorded_by: "s2" } }],
      });
      // And the work moves on. Without this the caller inside the lock would
      // find nothing left to commit and attest the other's commit — the same
      // answer by a different route, which is why the guard looked untestable.
      // With it, a caller that does not look again makes a second commit whose
      // record the append then throws away as a duplicate: a commit nobody
      // recorded, which is the one outcome this runtime must never produce.
      fs.writeFileSync(path.join(root, "src", "a.txt"), "and then some more\n");
    },
  });

  assert.ok(landed, "the other caller really did get there first");
  assert.equal(result.replayed, true, "so this one answers from the log instead of committing again");
  assert.equal(result.records.at(-1).payload.recorded_by, "s2", "and hands back the record that landed");
  assert.equal(commits(), before + 1, "one commit, not two");
  assert.match(git(root, "status", "--porcelain", "--", "src"), /^.?M src\/a\.txt$/mu, "the later change is left for the next round, not silently committed");
});

test("a retried receipt does not commit twice", (t) => {
  const { root, session, criterionFile } = repo(t);
  const { loopId } = open(session(), ["src"], criterionFile);
  const before = git(root, "rev-list", "--count", "HEAD");

  const first = receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" });
  const again = receipt(session(), { loopId, root, mode: MODE.COMMIT, session: "s1", commandId: "commit" });

  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.records.map((entry) => entry.seq), first.records.map((entry) => entry.seq));
  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), Number(before) + 1, "one commit, not two");
});
