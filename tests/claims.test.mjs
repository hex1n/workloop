// CC-01 / CC-03 / CC-04: what a claim is, and what a session is not.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { assertClaims, claimIdentity, next, observe, openLoop, openLoopStore, ready, suspend } from "../src/domain/loop.mjs";
import { EXIT, VERDICT_PREFIX } from "../src/domain/criterion.mjs";

const CRITERION = `console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: "unsatisfied", failures: [{ id: "x" }] })); process.exit(${EXIT.UNSATISFIED});`;

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-claims-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "check.mjs"), CRITERION);
  const location = path.join(root, ".workloop");
  fs.mkdirSync(location);
  createStore({ location, commandId: "genesis" });
  const session = () => openLoopStore(location);
  const open = (claims, extra = {}) => openLoop(session(), {
    root, goal: "g", claims, criterionFile: path.join(root, "check.mjs"), roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "none",
    commandId: `open-${claims.join("+")}`, ...extra,
  }).loopId;
  return { root, session, open, criterionFile: path.join(root, "check.mjs") };
}

// Whether this volume tells `Src` and `src` apart. Asked of the filesystem,
// never inferred from the platform: macOS volumes can be case-sensitive and
// Windows directories can be, so a platform check is a check that is wrong on
// somebody's machine.
function caseInsensitive(root) {
  const probe = path.join(root, "CaseProbe");
  fs.mkdirSync(probe);
  const answer = fs.existsSync(path.join(root, "caseprobe"));
  fs.rmSync(probe, { recursive: true, force: true });
  return answer;
}

test("CC-03: a claim opened through a symlink is recorded as the physical path", (t) => {
  const { root, open, session } = workspace(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"));

  assert.equal(claimIdentity(root, "alias"), "src", "the identity is what is on disk");
  const loopId = open(["alias"]);
  assert.deepEqual(session().replay().state.loops[loopId].claims, ["src"], "and that is what the log records");

  // The alias and the real name are the same directory, so the second loop is
  // claiming paths the first already owns.
  assert.throws(() => open(["src"], { commandId: "second" }), (error) => error.code === "CLAIM_TAKEN");
});

test("CC-03: a symlink cannot walk a claim out of the workspace", (t) => {
  const { root, open } = workspace(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-outside-")));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, "escape"));

  // The textual `..` check cannot see this: the string has no `..` in it.
  assert.throws(() => claimIdentity(root, "escape"), (error) => error.code === "CLAIM_ESCAPES_ROOT");
  assert.throws(() => open(["escape"]), (error) => error.code === "CLAIM_ESCAPES_ROOT");
});

test("CC-03: case aliases close on the volumes that have them", (t) => {
  const { root, open } = workspace(t);
  fs.mkdirSync(path.join(root, "Src"));

  if (caseInsensitive(root)) {
    // One directory, two spellings. Refusing here is the whole point: the two
    // loops would otherwise issue receipts contradicting each other about the
    // same files, and it takes one keystroke to arrange.
    assert.equal(claimIdentity(root, "src"), "Src", "the identity is the spelling on disk");
    open(["Src"]);
    assert.throws(() => open(["src"], { commandId: "second" }), (error) => error.code === "CLAIM_TAKEN");
  } else {
    // A case-sensitive volume genuinely has two directories, so two loops may
    // legitimately hold one each.
    fs.mkdirSync(path.join(root, "src"));
    assert.equal(claimIdentity(root, "src"), "src");
    open(["Src"]);
    assert.ok(open(["src"], { commandId: "second" }), "two directories, two loops");
  }
});

test("CC-03: a path that does not exist yet keeps the spelling it was given", (t) => {
  const { root } = workspace(t);
  fs.mkdirSync(path.join(root, "Src"));

  // Resolved as far as the disk can answer, and no further. Nobody has created
  // the rest, so nothing on disk can say what it will be called — a fact, not
  // a gap in the check.
  assert.equal(claimIdentity(root, path.join("Src", "New", "feature")), path.join("Src", "New", "feature"));
  if (caseInsensitive(root)) {
    assert.equal(claimIdentity(root, path.join("src", "New", "feature")), path.join("Src", "New", "feature"), "the existing part still normalises");
  }
});

test("CC-03: `...` is an ordinary directory name, not a variant of `..`", (t) => {
  const { root, open } = workspace(t);
  fs.mkdirSync(path.join(root, "..."));
  assert.equal(claimIdentity(root, "..."), "...");
  assert.ok(open(["..."]), "a directory with a peculiar name is still a directory");
});

test("CC-03: claims sort by code unit, so the same claims digest the same anywhere", (t) => {
  const { root } = workspace(t);
  for (const name of ["b", "a", "B", "A", "_z"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  const sorted = assertClaims(root, ["b", "_z", "a"]);
  assert.deepEqual(sorted, [...sorted].sort(), "the order is the default one");
  // `localeCompare` would put "a" before "B" in most locales; code unit order
  // does not. The ordering ends up inside a digest, so a locale-dependent one
  // would give the same claims two identities on two machines.
  assert.equal(["B", "a"].sort().join(","), "B,a");
});

test("CC-01: one store carries several disjoint loops, each with its own identity", (t) => {
  const { root, open, session } = workspace(t);
  for (const name of ["alpha", "beta"]) fs.mkdirSync(path.join(root, name));
  const alpha = open(["alpha"]);
  const beta = open(["beta"]);

  assert.notEqual(alpha, beta);
  const state = session().replay().state;
  assert.equal(Object.keys(state.loops).length, 2);
  assert.deepEqual(ready(session()).sort(), [alpha, beta].sort(), "both are on the frontier");
  assert.deepEqual(state.loops[alpha].claims, ["alpha"]);
  assert.deepEqual(state.loops[beta].claims, ["beta"]);
});

test("CC-04: a session is provenance, not routing — one may hold several loops at once", async (t) => {
  const { root, open, session, criterionFile } = workspace(t);
  for (const name of ["alpha", "beta"]) fs.mkdirSync(path.join(root, name));
  const alpha = open(["alpha"]);
  const beta = open(["beta"]);

  // One session advancing two loops is the ordinary case in a graph, not an
  // error: the old world's one-session-one-loop rule existed only to make
  // side-channel evidence unambiguous, and it went out with the side channel.
  for (const loopId of [alpha, beta]) {
    await observe(session(), { root, loopId, session: "s1", criterionFile, commandId: `observe-${loopId.slice(7, 15)}` });
  }
  const state = session().replay().state;
  assert.equal(state.loops[alpha].rounds.length, 1);
  assert.equal(state.loops[beta].rounds.length, 1);
  assert.deepEqual(state.loops[alpha].participants, ["s1"]);

  // Every change records who made it, and standing is checked — but that is
  // authorisation, not addressing. There is no path that infers which loop a
  // session meant; the loop is always named.
  assert.throws(
    () => suspend(session(), { loopId: alpha, outcome: "needs_input", reason: "r", session: "stranger", commandId: "s" }),
    (error) => error.code === "NOT_A_PARTICIPANT",
  );
  assert.equal(next(session(), { loopId: alpha }).loop_id, alpha, "addressing is explicit, always");
});
