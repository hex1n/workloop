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
import { digestOf, sha256Hex } from "../src/canonical.mjs";
import { CLASSES, createLockManager } from "../src/locks.mjs";
import { createStore } from "../src/store.mjs";
import { canonicalPath, isUnder, pathContains, systemPath } from "../src/site.mjs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { EXIT, VERDICT_PREFIX, killTree, reapOrphanedCriterion } from "../src/domain/criterion.mjs";
import { assertClaims, claimIdentity, next, observe, openLoop, openLoopStore } from "../src/domain/loop.mjs";

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

test("WN-02: the log holds one path form, whoever wrote it", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-form-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });

  // Whatever separator the caller types, the identity that reaches the log is
  // the same string. Two forms of one path digested differently and lost
  // containment altogether when a store was written on one platform and read
  // on another — the same bug as comparing on a hard-coded separator, only
  // deferred until somebody shared the repository.
  const identity = claimIdentity(root, path.join("src", "nested"));
  assert.equal(identity, "src/nested", "one form, not this platform's form");
  assert.equal(claimIdentity(root, "src/nested"), identity);
  assert.equal(digestOf([identity]), digestOf(["src/nested"]), "and so one digest, on any machine");
  // The pair round-trips on every platform. The conversion itself only does
  // anything where `path.sep` is not `/` — and it must not do anything here,
  // since a backslash is a legal character in a POSIX filename. So this pins
  // the contract; only Windows CI can catch the conversion going missing.
  assert.equal(canonicalPath(["src", "nested"].join(path.sep)), "src/nested");
  assert.equal(systemPath(canonicalPath(["a b", "c"].join(path.sep))), ["a b", "c"].join(path.sep));

  assert.equal(pathContains("src/nested", "src"), true);
  assert.equal(pathContains("src", "src/nested"), true);
  assert.equal(pathContains("src", "srcs"), false, "a shared prefix is not containment");
  assert.equal(pathContains(".", "anything"), true, "the root contains everything");
  // Directional, for exclusions: `.` overlaps everything but is not inside it.
  assert.equal(isUnder("src/nested", "src"), true);
  assert.equal(isUnder(".", "src"), false);
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
  // Nested, expressed the way a caller on this platform would express it. It
  // is canonicalised on the way in, so the overlap is seen wherever it runs.
  assert.throws(() => open([path.join("src", "nested")], "inner"), (error) => error.code === "CLAIM_TAKEN");
  // And within a single loop's own claims.
  assert.throws(() => assertClaims(root, ["src", path.join("src", "nested")]), (error) => error.code === "CLAIM_OVERLAP");
});

// A stand-in for `taskkill` that reports whatever the test needs, so the
// Windows branch runs wherever these tests run. A branch that can only execute
// on the machine that has the bug is a branch nobody checks.
const fakeKiller = (outcomes) => {
  let call = 0;
  return () => {
    const outcome = outcomes[Math.min(call, outcomes.length - 1)];
    call += 1;
    const emitter = new EventEmitter();
    queueMicrotask(() => {
      if (outcome === "unlaunchable") emitter.emit("error", new Error("ENOENT"));
      else emitter.emit("close", outcome === "felled" ? 0 : 1);
    });
    return emitter;
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("WN-04: an exited process is not killed again", () => {
  let attempted = false;
  killTree({ exitCode: 0, signalCode: null, pid: 1 }, () => {}, {
    platform: "win32", spawnKiller: () => { attempted = true; return new EventEmitter(); },
  });
  assert.equal(attempted, false, "nothing to fell, nothing attempted");
});

test("WN-04: the tree kill retries once before giving up", async () => {
  const child = { exitCode: null, signalCode: null, pid: 1, kill() { this.killed = true; } };
  let reported = null;
  killTree(child, (felled) => { reported = felled; }, {
    platform: "win32", spawnKiller: fakeKiller(["failed", "felled"]),
  });
  await settle();
  assert.equal(reported, true, "a transient failure is the common one, so it is retried");
  assert.notEqual(child.killed, true, "and the fallback was not needed");
});

test("WN-04: a kill mechanism that cannot even start counts as a failure, not a success", async () => {
  // The shape that made this necessary: `spawn` does not throw when the
  // executable is missing, it emits `error` afterwards. An implementation that
  // only guarded the call reported every Windows kill as successful —
  // including the one case the fallback existed for.
  const child = { exitCode: null, signalCode: null, pid: 1, kill() { this.killed = true; } };
  let reported = null;
  killTree(child, (felled) => { reported = felled; }, {
    platform: "win32", spawnKiller: fakeKiller(["unlaunchable"]),
  });
  await settle();
  assert.equal(reported, false, "an unlaunchable killer is not a felled tree");
  assert.equal(child.killed, true, "the child itself is still ended");
});

test("D-03: a criterion left running by a killed runtime is reaped by whoever comes back", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workloop-orphan-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "criterion.pid");

  // A real process standing in for the group a SIGKILLed runtime left behind.
  const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });
  fs.writeFileSync(pidFile, String(orphan.pid));
  assert.equal(reapOrphanedCriterion(pidFile), orphan.pid, "it is found and named");
  assert.equal(fs.existsSync(pidFile), false, "and the note is cleared behind it");

  return new Promise((resolve) => setTimeout(resolve, 200)).then(() => {
    assert.throws(() => process.kill(orphan.pid, 0), (error) => error.code === "ESRCH", "the process really is gone");

    // A pid file whose process has already exited is the ordinary case: the
    // file outlived it, and that says nothing worth reporting.
    fs.writeFileSync(pidFile, String(orphan.pid));
    assert.equal(reapOrphanedCriterion(pidFile), null);
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(reapOrphanedCriterion(pidFile), null, "and no note at all is not an event either");
  });
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
