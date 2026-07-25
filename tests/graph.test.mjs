// GE-01 … GE-06, plus the two CC scenarios that only became expressible once a
// store could hold more than one loop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { EXIT, VERDICT_PREFIX } from "../src/domain/criterion.mjs";
import { UNMET } from "../src/domain/graph.mjs";
import { abandon, amend, next, observe, openLoop, openLoopStore, ready, receipt } from "../src/domain/loop.mjs";
import { DECISION, VERDICT } from "../src/domain/vocabulary.mjs";

// One criterion, parameterised by the file it checks, so two loops in one store
// can succeed and fail independently.
const criterionFor = (file) => `
import fs from "node:fs";
const text = fs.existsSync(${JSON.stringify(file)}) ? fs.readFileSync(${JSON.stringify(file)}, "utf8").trim() : "";
const failures = text.includes("done") ? [] : [{ id: "not-done", expected: "done", actual: text }];
console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: failures.length === 0 ? "satisfied" : "unsatisfied", failures }));
process.exit(failures.length === 0 ? ${EXIT.SATISFIED} : ${EXIT.UNSATISFIED});
`;

const git = (root, ...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

function workspace(t, { asRepo = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-graph-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["alpha", "beta"]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "work.txt"), "todo\n");
    fs.writeFileSync(path.join(root, `check-${name}.mjs`), criterionFor(`${name}/work.txt`));
  }
  if (asRepo) {
    git(root, "init", "-q", ".");
    git(root, "config", "user.email", "gate@workloop.test");
    git(root, "config", "user.name", "gate");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "core.hooksPath", path.join(root, "no-hooks"));
    fs.writeFileSync(path.join(root, "README"), "seed\n");
    git(root, "add", "README");
    git(root, "commit", "-q", "-m", "seed");
  }
  const location = path.join(root, ".workloop");
  createStore({ location, commandId: "genesis" });
  const session = () => openLoopStore(location);
  const open = (name, extra = {}) => openLoop(session(), {
    goal: `${name} must say done`, claims: [name], criterionFile: path.join(root, `check-${name}.mjs`),
    roundsBudget: 5, session: "s1", reason: "fixture", grantedBy: "self",
    receipts: asRepo ? "git" : "none", commandId: `open-${name}`, ...extra,
  }).loopId;
  const finish = async (name, loopId) => {
    fs.writeFileSync(path.join(root, name, "work.txt"), "done\n");
    if (asRepo) receipt(session(), { root, loopId, mode: "commit", session: "s1", commandId: `receipt-${name}` });
    return observe(session(), { root, loopId, session: "s1", criterionFile: path.join(root, `check-${name}.mjs`), commandId: `observe-${name}` });
  };
  return { root, location, session, open, finish, criterionFor: (name) => path.join(root, `check-${name}.mjs`) };
}

test("GE-01: edges are declared at open, validated there, and frozen afterwards", (t) => {
  const { session, open } = workspace(t);
  const alpha = open("alpha");

  for (const [edges, code] of [
    [["sha256:" + "0".repeat(64)], "EDGE_UNKNOWN_UPSTREAM"],
    [["not-a-loop-id"], "EDGE_SHAPE"],
    [[alpha, alpha], "EDGE_DUPLICATE"],
  ]) {
    const before = session().read().length;
    assert.throws(() => open("beta", { dependsOn: edges, commandId: `bad-${code}` }), (error) => error.code === code, code);
    assert.equal(session().read().length, before, "a refused open writes nothing");
  }

  const beta = open("beta", { dependsOn: [alpha] });
  const record = session().read().find((entry) => entry.digest === beta);
  assert.deepEqual(record.payload.depends_on, [{ loop_id: alpha, pinned_certification_digest: null }]);

  // Frozen: `amend` has no way to name an edge, so the only route to a
  // different dependency is a different loop. That is what makes A→B→A
  // unconstructible rather than merely refused — see §4 of the slice spec.
  amend(session(), { loopId: alpha, dependsOn: [beta], reason: "try to add an edge", commandId: "amend" });
  assert.deepEqual(session().replay().state.loops[alpha].dependsOn, [], "amending cannot grow an edge");
});

test("GE-01: an abandoned upstream is refused; longer cycles cannot be built at all", (t) => {
  const { session, open } = workspace(t);
  const alpha = open("alpha");
  abandon(session(), { loopId: alpha, reason: "not doing this", commandId: "abandon" });
  assert.throws(
    () => open("beta", { dependsOn: [alpha] }),
    (error) => error.code === "EDGE_ABANDONED_UPSTREAM",
    "an edge to work that was given up is a dependency that can never be met",
  );

  // Why there is no cycle checker: an edge may only point at a loop that
  // already exists, and an existing loop can never gain one (asserted in the
  // test above, where amend fails to add an edge). Append order is therefore a
  // topological order, and A→B→A has no way to come into being. A search for
  // cycles here could never find one — and a check that cannot fire is exactly
  // what the audit spent its time deleting.
});

test("GE-02: an unmet dependency blocks certification but never the observation", async (t) => {
  const { root, session, open, finish, criterionFor } = workspace(t);
  const alpha = open("alpha");
  const beta = open("beta", { dependsOn: [alpha] });

  fs.writeFileSync(path.join(root, "beta", "work.txt"), "done\n");
  await observe(session(), { root, loopId: beta, session: "s1", criterionFile: criterionFor("beta"), commandId: "observe-beta-1" });

  const round = session().read().find((entry) => entry.kind === "round_observed" && entry.payload.loop_id === beta).payload;
  assert.equal(round.verdict, VERDICT.SATISFIED, "the criterion passed and the round was recorded");
  assert.equal(round.dependency_state, "unmet");
  const directive = next(session(), { loopId: beta });
  assert.equal(directive.decision, DECISION.BLOCKED);
  assert.match(directive.reason, /dependency_unmet/u);
  assert.match(directive.reason, new RegExp(UNMET.UNFINISHED, "u"));
  assert.equal(session().replay().state.loops[beta].lifecycle, "active", "blocked is not terminal and not suspended");

  // The upstream finishes; the same downstream loop is then certifiable.
  await finish("alpha", alpha);
  assert.equal(session().replay().state.loops[alpha].outcome, "achieved");
  await observe(session(), { root, loopId: beta, session: "s1", criterionFile: criterionFor("beta"), commandId: "observe-beta-2" });
  assert.equal(next(session(), { loopId: beta }).decision, DECISION.ACHIEVED);
});

test("GE-03: a pinned edge matches one certification literally; an unpinned edge takes any", async (t) => {
  const { session, open, finish } = workspace(t);
  const alpha = open("alpha");
  await finish("alpha", alpha);
  const certification = session().replay().state.loops[alpha].certification;
  assert.equal(certification, null, "a loop with no receipt regime certifies on no receipt");

  // With nothing to pin to, a pin can only fail — which is the honest answer:
  // the pin names evidence this upstream does not have.
  const wrong = `sha256:${"1".repeat(64)}`;
  const pinned = open("beta", { dependsOn: [`${alpha}@${wrong}`], commandId: "open-pinned" });
  const state = session().replay().state;
  assert.deepEqual(state.loops[pinned].dependsOn, [{ loop_id: alpha, pinned_certification_digest: wrong }]);
  assert.equal(ready(session()).includes(pinned), false, "a mismatched pin keeps the loop off the frontier");
  assert.equal(ready(session()).includes(alpha), false, "and a finished loop is not on it either");
});

test("GE-05: ready is a read, and it changes as upstreams finish", async (t) => {
  const { location, session, open, finish } = workspace(t);
  const alpha = open("alpha");
  const beta = open("beta", { dependsOn: [alpha] });

  assert.deepEqual(ready(session()), [alpha], "beta waits on alpha");

  const before = fs.readFileSync(path.join(location, "segments", "000001.log"));
  ready(session());
  ready(session());
  assert.deepEqual(fs.readFileSync(path.join(location, "segments", "000001.log")), before, "asking changes not one byte");

  await finish("alpha", alpha);
  assert.deepEqual(ready(session()), [beta], "the frontier moves to beta, and does not include the finished alpha");
});

test("CC-02: two loops in one store cannot claim the same paths", (t) => {
  const { session, open } = workspace(t);
  open("alpha");
  const before = session().read().length;
  assert.throws(() => open("alpha", { commandId: "again" }), (error) => error.code === "CLAIM_TAKEN");
  assert.equal(session().read().length, before, "a refused open leaves the log unchanged");

  // A claim that contains another's is just as undecidable as an equal one.
  assert.throws(() => open("beta", { claims: ["."], commandId: "root-claim" }), (error) => error.code === "CLAIM_TAKEN");
});

test("CC-07: disjoint loops interleave for their whole lives without invalidating each other", async (t) => {
  const { root, session, open, criterionFor } = workspace(t);
  const alpha = open("alpha");
  const beta = open("beta");

  // Interleaved rounds. Under the old global revision every one of beta's
  // records moved alpha's version, so alpha's next write would be refused as
  // stale — the exact failure this design was rebuilt to not have.
  for (const round of [1, 2]) {
    for (const [name, id] of [["alpha", alpha], ["beta", beta]]) {
      await observe(session(), { root, loopId: id, session: "s1", criterionFile: criterionFor(name), commandId: `${name}-${round}` });
    }
  }

  const state = session().replay().state;
  assert.equal(state.loops[alpha].rounds.length, 2);
  assert.equal(state.loops[beta].rounds.length, 2);
  assert.notEqual(state.loops[alpha].revision, state.loops[beta].revision, "each loop has its own version");
  assert.equal(session().read().some((entry) => entry.kind === "loop_suspended"), false, "nobody was refused");

  // And both finish.
  for (const [name, id] of [["alpha", alpha], ["beta", beta]]) {
    fs.writeFileSync(path.join(root, name, "work.txt"), "done\n");
    await observe(session(), { root, loopId: id, session: "s1", criterionFile: criterionFor(name), commandId: `${name}-final` });
    assert.equal(next(session(), { loopId: id }).decision, DECISION.ACHIEVED, name);
  }
});

test("GE-04 / GE-06: end to end in a repository, across sessions, with ancestry enforced", async (t) => {
  const { root, session, open, finish, criterionFor } = workspace(t, { asRepo: true });
  const alpha = open("alpha");
  const beta = open("beta", { dependsOn: [alpha] });

  // Downstream first: satisfied, receipted, and still refused.
  fs.writeFileSync(path.join(root, "beta", "work.txt"), "done\n");
  receipt(session(), { root, loopId: beta, mode: "commit", session: "s2", commandId: "receipt-beta-1" });
  await observe(session(), { root, loopId: beta, session: "s2", criterionFile: criterionFor("beta"), commandId: "observe-beta-1" });
  assert.equal(next(session(), { loopId: beta }).decision, DECISION.BLOCKED);

  await finish("alpha", alpha);
  const upstream = session().replay().state.loops[alpha];
  assert.equal(upstream.outcome, "achieved");
  assert.ok(upstream.certificationCommit, "the upstream was certified on a commit");

  // A fresh session — nothing carried but the directory — sees the frontier move.
  assert.deepEqual(ready(session(), { isAncestor: () => true }), [beta]);

  // The upstream's commit is rewritten out of this history. The downstream's
  // own work is untouched, and it is still refused: the evidence it depends on
  // is no longer reachable from where it stands.
  git(root, "reset", "-q", "--hard", "HEAD~1");
  fs.writeFileSync(path.join(root, "beta", "work.txt"), "done\n");
  receipt(session(), { root, loopId: beta, mode: "commit", session: "s3", commandId: "receipt-beta-2" });
  await observe(session(), { root, loopId: beta, session: "s3", criterionFile: criterionFor("beta"), commandId: "observe-beta-2" });
  const blocked = session().read().filter((entry) => entry.kind === "round_observed" && entry.payload.loop_id === beta).at(-1).payload;
  assert.equal(blocked.verdict, VERDICT.SATISFIED);
  assert.equal(blocked.dependency_state, "unmet");
  assert.equal(session().read().some((entry) => entry.kind === "loop_terminal" && entry.payload.loop_id === beta), false);

  // LK-07: the whole graph replays from genesis in a process that never saw it.
  assert.deepEqual(session().replay({ useSnapshot: false }).state, session().replay().state);
});
