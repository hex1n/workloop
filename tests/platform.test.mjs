// WN-02 / WN-04 / WN-05: the parts of the runtime that a platform can break.
//
// Most of these assert semantics that are meant to be platform-independent —
// which is exactly why they have to run on every platform CI covers. A property
// that only holds where it was written is not a property.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Hex } from "../src/canonical.mjs";
import { CLASSES, createLockManager } from "../src/locks.mjs";
import { createStore } from "../src/store.mjs";
import { pathContains } from "../src/site.mjs";
import { EXIT, VERDICT_PREFIX } from "../src/domain/criterion.mjs";
import { assertClaims, next, observe, openLoop, openLoopStore } from "../src/domain/loop.mjs";

// Spaces and CJK in every path the runtime touches.
const AWKWARD = "工 作 区 with spaces";

const CRITERION = `
import fs from "node:fs";
const text = fs.readFileSync("源 码/work.txt", "utf8").trim();
const failures = text.includes("done") ? [] : [{ id: "not-done" }];
console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: failures.length === 0 ? "satisfied" : "unsatisfied", failures }));
process.exit(failures.length === 0 ? ${EXIT.SATISFIED} : ${EXIT.UNSATISFIED});
`;

test("WN-02: a path full of spaces and non-ASCII changes nothing about the semantics", async (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-wn-")));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, AWKWARD);
  fs.mkdirSync(path.join(root, "源 码"), { recursive: true });
  fs.writeFileSync(path.join(root, "源 码", "work.txt"), "todo\n");
  fs.writeFileSync(path.join(root, "检 查.mjs"), CRITERION);

  const location = path.join(root, ".workloop");
  fs.mkdirSync(location);
  createStore({ location, commandId: "genesis" });
  // A small snapshot interval so the staging-and-rename path really runs.
  const session = () => openLoopStore(location, { snapshotEvery: 2 });
  const criterionFile = path.join(root, "检 查.mjs");

  const loopId = openLoop(session(), {
    root, goal: "make it say done", claims: ["源 码"], criterionFile, roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open",
  }).loopId;
  await observe(session(), { root, loopId, session: "s1", criterionFile, commandId: "o1" });
  fs.writeFileSync(path.join(root, "源 码", "work.txt"), "done\n");
  await observe(session(), { root, loopId, session: "s1", criterionFile, commandId: "o2" });
  assert.equal(next(session(), { loopId }).decision, "achieved");

  // Replaying from genesis in a reader that never saw any of it agrees.
  assert.deepEqual(session().replay({ useSnapshot: false }).state, session().replay().state);

  // Nothing half-written was left behind. Every durable write here goes
  // through a staging file, and a staging file that survives is a write that
  // did not finish — which the next reader would have to guess about.
  const leftovers = fs.readdirSync(location, { recursive: true })
    .filter((entry) => /\.partial$|\.tmp$|\.released\./u.test(String(entry)));
  assert.deepEqual(leftovers, [], "no staging files survived");
});

test("WN-02: path containment is decided on this platform's separator", () => {
  // The comparison used to hard-code `/`. On Windows a claim identity is built
  // with `\`, so `src` and `src\nested` did not look nested and two loops could
  // hold overlapping paths — CC-02's invariant, broken on one platform only.
  const nested = ["src", "nested"].join(path.sep);
  assert.equal(pathContains(nested, "src"), true, `${nested} lies inside src`);
  assert.equal(pathContains("src", nested), true);
  assert.equal(pathContains("src", "srcs"), false, "a shared prefix is not containment");
  assert.equal(pathContains(".", "anything"), true, "the root contains everything");
});

test("WN-02: two loops cannot hold a path and a path inside it", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-nest-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "check.mjs"), "process.exit(3)");
  const location = path.join(root, ".workloop");
  fs.mkdirSync(location);
  createStore({ location, commandId: "genesis" });
  const open = (claims, commandId) => openLoop(openLoopStore(location), {
    root, goal: "g", claims, criterionFile: path.join(root, "check.mjs"), roundsBudget: 5,
    session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId,
  }).loopId;

  open(["src"], "outer");
  // Nested, expressed the way a caller on this platform would express it.
  assert.throws(() => open([path.join("src", "nested")], "inner"), (error) => error.code === "CLAIM_TAKEN");
  // And within a single loop's own claims.
  assert.throws(() => assertClaims(root, ["src", path.join("src", "nested")]), (error) => error.code === "CLAIM_OVERLAP");
});

test("WN-05: the criterion lease waits for a dead owner's deadline, then reclaims it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-lease-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = () => createLockManager({
    resolveLockPath: ({ lockClass, resourceId }) => path.join(dir, `${lockClass}-${sha256Hex(resourceId).slice(7, 39)}.lock`),
    defaults: { timeoutMs: 200 },
  });
  const lockPath = path.join(dir, `${CLASSES.CRITERION}-${sha256Hex("check").slice(7, 39)}.lock`);

  // A pid that has certainly exited: this process's own, minus nothing — take
  // a number that cannot be live by construction instead of guessing one.
  const deadPid = 0x7fffffff;
  const write = (deadlineOffset) => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      lock_class: CLASSES.CRITERION, resource_id: "check", pid: deadPid, token: "dead",
      acquired_at_ms: Date.now() - 60_000, deadline_ms: Date.now() + deadlineOffset,
    }));
  };

  // The mechanism is class-independent, but a property proved only on another
  // lock class is not proved on this one.
  write(60_000);
  assert.throws(() => manager().withLock(CLASSES.CRITERION, "check", () => assert.fail("must not enter")), (error) => error.code === "LOCK_UNAVAILABLE");
  assert.equal(fs.existsSync(lockPath), true, "a running lease is left alone");

  write(-1);
  assert.equal(manager().withLock(CLASSES.CRITERION, "check", () => "reclaimed"), "reclaimed");
  assert.equal(fs.existsSync(lockPath), false, "and the lock is cleaned up behind it");
});
