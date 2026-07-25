// CC-01 / CC-03 / CC-04: what a claim is, and what a session is not.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { assertClaims, claimIdentity, next, observe, openLoop, openLoopStore, ready, receipt, suspend } from "../src/domain/loop.mjs";
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

test("CC-03: two loops cannot claim one directory that neither has created yet", (t) => {
  const { root, open } = workspace(t);
  if (!caseInsensitive(root)) return;
  // Nothing on disk to resolve against, so identity alone cannot close this.
  // Left open, the two loops would find themselves sharing a tree the moment
  // either created it — which is the situation claims exist to prevent, only
  // deferred by a day.
  open(["Src/new"]);
  assert.throws(() => open(["src/new"], { commandId: "second" }), (error) => error.code === "CLAIM_TAKEN");
  assert.throws(() => assertClaims(root, ["Dir", "dir"]), (error) => error.code === "CLAIM_SHAPE");
});

test("a loop cannot claim the runtime's own files", (t) => {
  const { root, open } = workspace(t);
  fs.mkdirSync(path.join(root, ".git"));
  for (const claim of [".workloop", ".git", path.join(".workloop", "segments")]) {
    // Control-plane paths are excluded from every checkpoint and receipt, so a
    // loop that claimed them could never observe or vouch for its own scope.
    // Accepting that quietly hands somebody an unwinnable loop.
    assert.throws(() => open([claim], { commandId: `claim-${claim}` }), (error) => error.code === "CLAIM_IS_CONTROL_PLANE", claim);
  }
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

test("SL-06: a filesystem loop is certified on a snapshot of its artifacts", async (t) => {
  const { root, session, criterionFile } = workspace(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.txt"), "todo\n");
  const passing = path.join(root, "pass.mjs");
  fs.writeFileSync(passing, `console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: "satisfied", failures: [] })); process.exit(${EXIT.SATISFIED});`);
  const loopId = openLoop(session(), {
    root, goal: "g", claims: ["src"], criterionFile: passing, roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "fs", commandId: "open",
  }).loopId;

  // Satisfied is not enough on its own: a loop that declared an evidence
  // regime is certified on evidence, whichever regime it declared.
  await observe(session(), { root, loopId, session: "s1", criterionFile: passing, commandId: "o1" });
  assert.equal(next(session(), { loopId }).decision, "produce_receipt");

  const taken = receipt(session(), { root, loopId, mode: "snapshot", session: "s1", commandId: "r1" });
  const payload = taken.records.at(-1).payload;
  assert.equal(payload.status, "clean");
  assert.equal(payload.commit_oid, null, "there is no commit here, and the receipt says so rather than inventing one");
  assert.deepEqual(payload.paths, ["src/a.txt"]);
  assert.match(payload.tree_digest, /^sha256:/u);

  await observe(session(), { root, loopId, session: "s1", criterionFile: passing, commandId: "o2" });
  const round = session().read().filter((entry) => entry.kind === "round_observed").at(-1).payload;
  assert.equal(round.receipt_state, "in_force");
  assert.equal(session().read().at(-1).payload.outcome, "achieved");
});

test("SL-06: a filesystem receipt stops holding the moment the artifacts move", async (t) => {
  const { root, session } = workspace(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.txt"), "todo\n");
  const passing = path.join(root, "pass.mjs");
  fs.writeFileSync(passing, `console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: "satisfied", failures: [] })); process.exit(${EXIT.SATISFIED});`);
  const loopId = openLoop(session(), {
    root, goal: "g", claims: ["src"], criterionFile: passing, roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "fs", commandId: "open",
  }).loopId;
  receipt(session(), { root, loopId, mode: "snapshot", session: "s1", commandId: "r1" });

  // No history to be reachable from, so the only question a filesystem receipt
  // can answer is whether the paths still hash to what it recorded.
  fs.writeFileSync(path.join(root, "src", "a.txt"), "changed after the receipt\n");
  await observe(session(), { root, loopId, session: "s1", criterionFile: passing, commandId: "o1" });
  const round = session().read().find((entry) => entry.kind === "round_observed").payload;
  assert.equal(round.verdict, "satisfied", "the check still passes");
  assert.equal(round.receipt_state, "drifted");
  assert.equal(session().read().some((entry) => entry.kind === "loop_terminal"), false, "and it is not certified");
});

test("SL-06: a filesystem receipt does not vouch for what it could not read", (t) => {
  const { root, session } = workspace(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.txt"), "readable\n");
  const locked = path.join(root, "src", "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "inside.txt"), "x\n");
  fs.chmodSync(locked, 0o000);
  // Running as root, or on a filesystem without POSIX modes, the directory
  // stays readable and there is nothing here to observe.
  let blocked = true;
  try { fs.readdirSync(locked); blocked = false; } catch { /* as intended */ }
  if (!blocked) { fs.chmodSync(locked, 0o755); return; }

  const passing = path.join(root, "pass.mjs");
  fs.writeFileSync(passing, `console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: "satisfied", failures: [] })); process.exit(${EXIT.SATISFIED});`);
  const loopId = openLoop(session(), {
    root, goal: "g", claims: ["src"], criterionFile: passing, roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "fs", commandId: "open",
  }).loopId;

  const payload = receipt(session(), { root, loopId, mode: "snapshot", session: "s1", commandId: "r1" }).records.at(-1).payload;
  // Same rule as the git side: an emptiness the runtime cannot account for is
  // never clean. Here it is a directory it was not allowed to open — the
  // receipt says which one rather than passing over it.
  fs.chmodSync(locked, 0o755);
  assert.equal(payload.status, "uncertain");
  assert.match(payload.reasons.join(" "), /locked.*could not be read/u);
});

test("SL-06: a regime takes the modes it has, and says so about the ones it does not", (t) => {
  const { root, session } = workspace(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.txt"), "x\n");
  const loopId = openLoop(session(), {
    root, goal: "g", claims: ["src"], criterionFile: path.join(root, "check.mjs"), roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "fs", commandId: "open",
  }).loopId;

  // Asking for a git commit and getting a filesystem snapshot without being
  // told is evidence of a different kind than the one requested.
  for (const mode of ["commit", "stage", "banana", undefined]) {
    assert.throws(
      () => receipt(session(), { root, loopId, mode, session: "s1", commandId: `r-${mode}` }),
      (error) => error.code === "UNKNOWN_RECEIPT_MODE",
      String(mode),
    );
  }
  assert.ok(receipt(session(), { root, loopId, mode: "snapshot", session: "s1", commandId: "ok" }));
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
