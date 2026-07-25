// LK-01..LK-04 and property P7 (single writer) from
// greenfield/slices/01-log-kernel.md §3. P7 uses real child processes on
// purpose: a lock is a filesystem fact, and an in-process simulation would
// prove nothing about it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CLASSES, createLockManager } from "../src/locks.mjs";

const MODULE_URL = pathToFileURL(path.resolve(import.meta.dirname, "..", "src", "locks.mjs")).href;

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-locks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const managerAt = (dir, options = {}) => createLockManager({
  resolveLockPath: ({ lockClass, resourceId }) => path.join(dir, `${lockClass}-${encodeURIComponent(resourceId)}.lock`),
  defaults: { timeoutMs: 200, leaseMs: 30_000, ...options },
});

const nest = (locks, outer, inner) => () => locks.withLock(outer, `${outer}-r`, () => locks.withLock(inner, `${inner}-r`, () => "ok"));

test("the lock order permits outer classes to reach the store and nothing else", (t) => {
  const locks = managerAt(root(t));
  for (const outer of [CLASSES.GIT_INDEX, CLASSES.CRITERION]) assert.equal(nest(locks, outer, CLASSES.STORE)(), "ok");
  for (const [outer, inner] of [
    [CLASSES.STORE, CLASSES.GIT_INDEX],
    [CLASSES.STORE, CLASSES.CRITERION],
    [CLASSES.GIT_INDEX, CLASSES.CRITERION],
    [CLASSES.CRITERION, CLASSES.GIT_INDEX],
  ]) {
    assert.throws(nest(locks, outer, inner), (error) => error.code === "LOCK_ORDER_VIOLATION", `${outer} -> ${inner}`);
  }
});

test("locks are non-reentrant, and two stores name their own invariant", (t) => {
  const locks = managerAt(root(t));
  for (const lockClass of [CLASSES.GIT_INDEX, CLASSES.CRITERION]) {
    assert.throws(nest(locks, lockClass, lockClass), (error) => error.code === "NON_REENTRANT");
  }
  assert.throws(
    () => locks.withLock(CLASSES.STORE, "a", () => locks.withLock(CLASSES.STORE, "b", () => assert.fail("must not enter"))),
    (error) => error.code === "TWO_STORES",
  );
});

test("a critical section must be synchronous", (t) => {
  const locks = managerAt(root(t));
  assert.throws(() => locks.withLock(CLASSES.STORE, "r", async () => {}), (error) => error.code === "ASYNC_CRITICAL_SECTION");
});

test("the lock is released after the action throws, and the action's error survives", (t) => {
  const dir = root(t);
  const locks = managerAt(dir);
  assert.throws(() => locks.withLock(CLASSES.STORE, "r", () => { throw new Error("action failed"); }), /action failed/u);
  assert.equal(locks.withLock(CLASSES.STORE, "r", () => "reacquired"), "reacquired");
});

test("owner metadata records the holder and reserved fields cannot be forged", (t) => {
  const dir = root(t);
  const locks = managerAt(dir);
  let owner;
  locks.withLock(CLASSES.STORE, "r", () => {
    owner = JSON.parse(fs.readFileSync(path.join(dir, "store-r.lock", "owner.json"), "utf8"));
  }, { ownerExtra: { note: "kept" } });
  assert.equal(owner.lock_class, CLASSES.STORE);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.note, "kept");
  for (const field of ["pid", "token", "lock_class", "deadline_ms"]) {
    assert.throws(
      () => locks.withLock(CLASSES.STORE, "r", () => assert.fail("must not enter"), { ownerExtra: { [field]: "forged" } }),
      (error) => error.code === "RESERVED_OWNER_FIELD",
    );
    assert.equal(fs.existsSync(path.join(dir, "store-r.lock")), false, `${field}: no lock may survive the refusal`);
  }
});

test("a live holder excludes another manager until it releases", (t) => {
  const dir = root(t);
  const holder = managerAt(dir);
  const contender = managerAt(dir);
  holder.withLock(CLASSES.STORE, "r", () => {
    assert.throws(() => contender.withLock(CLASSES.STORE, "r", () => assert.fail("must not enter")), (error) => error.code === "LOCK_UNAVAILABLE");
  });
  assert.equal(contender.withLock(CLASSES.STORE, "r", () => "free"), "free");
});

test("a dead holder is only reaped once its declared lease has also expired", (t) => {
  const dir = root(t);
  const lockPath = path.join(dir, "store-r.lock");
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const deadPid = Number(exited.stdout);
  const write = (deadlineOffset) => {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      lock_class: CLASSES.STORE, resource_id: "r", pid: deadPid, token: "dead",
      acquired_at_ms: Date.now() - 60_000, deadline_ms: Date.now() + deadlineOffset,
    }));
  };

  // Dead process, lease still running: another holder may legitimately be
  // finishing work this process started, so the lock stands.
  write(60_000);
  assert.throws(() => managerAt(dir).withLock(CLASSES.STORE, "r", () => assert.fail("must not enter")), (error) => error.code === "LOCK_UNAVAILABLE");
  assert.equal(fs.existsSync(lockPath), true);

  write(-20_000);
  assert.equal(managerAt(dir).withLock(CLASSES.STORE, "r", () => "reaped"), "reaped");
  assert.equal(fs.existsSync(lockPath), false);
});

test("a live holder is never reaped, however old its lease looks", (t) => {
  const dir = root(t);
  const lockPath = path.join(dir, "store-r.lock");
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
    lock_class: CLASSES.STORE, resource_id: "r", pid: process.pid, token: "live",
    acquired_at_ms: 0, deadline_ms: 1,
  }));
  assert.throws(() => managerAt(dir).withLock(CLASSES.STORE, "r", () => assert.fail("must not enter")), (error) => error.code === "LOCK_UNAVAILABLE");
  assert.equal(fs.existsSync(lockPath), true);
});

test("a release that cannot be verified poisons every later acquisition", (t) => {
  const dir = root(t);
  const locks = managerAt(dir);
  assert.throws(
    () => locks.withLock(CLASSES.STORE, "r", () => {
      // Simulates the lock vanishing underneath us: after this, we cannot claim
      // to know whether anyone else entered.
      fs.rmSync(path.join(dir, "store-r.lock"), { recursive: true, force: true });
    }),
    (error) => error.code === "LOCK_RELEASE_FAILED",
  );
  assert.ok(locks.poisoned);
  for (const lockClass of Object.values(CLASSES)) {
    assert.throws(() => locks.withLock(lockClass, "other", () => assert.fail("must not enter")), (error) => error.code === "LOCK_STATE_POISONED");
  }
  // Poisoning is confined to the manager that lost track, not the directory.
  assert.equal(managerAt(dir).withLock(CLASSES.STORE, "r", () => "fresh"), "fresh");
});

test("when the action and the release both fail, neither error is lost", (t) => {
  const dir = root(t);
  const locks = managerAt(dir);
  assert.throws(
    () => locks.withLock(CLASSES.STORE, "r", () => {
      fs.rmSync(path.join(dir, "store-r.lock"), { recursive: true, force: true });
      throw Object.assign(new Error("action failed"), { code: "ACTION_FAILED" });
    }),
    (error) => error.code === "LOCK_RELEASE_FAILED" && error.actionError?.code === "ACTION_FAILED",
  );
});

test("P7: concurrent processes serialize, and no writer is lost", async (t) => {
  const dir = root(t);
  const ledger = path.join(dir, "ledger");
  const WRITERS = 6;
  const PER_WRITER = 8;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { createLockManager, CLASSES } from ${JSON.stringify(MODULE_URL)};
    // Under --eval there is no script path in argv, so the caller's arguments
    // start at index 1.
    const [dir, ledger, id] = process.argv.slice(1);
    const locks = createLockManager({
      resolveLockPath: ({ lockClass, resourceId }) => path.join(dir, lockClass + "-" + resourceId + ".lock"),
      defaults: { timeoutMs: 20000, leaseMs: 30000 },
    });
    for (let i = 0; i < ${PER_WRITER}; i += 1) {
      locks.withLock(CLASSES.STORE, "shared", () => {
        // Read-modify-write with a deliberate gap: without real exclusion the
        // interleaving shows up as lost lines.
        const before = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : "";
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        fs.writeFileSync(ledger, before + id + ":" + i + "\\n");
      });
    }
  `;
  // spawn, not spawnSync: synchronous spawning would run the writers one after
  // another, and a test where nothing overlaps proves nothing about exclusion.
  const results = await Promise.all(Array.from({ length: WRITERS }, (_, index) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, "--", dir, ledger, `w${index}`], { encoding: "utf8" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (status) => resolve({ index, status, stderr }));
  })));
  for (const child of results) {
    assert.equal(child.status, 0, `writer ${child.index}: ${child.stderr}`);
  }
  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
  assert.equal(lines.length, WRITERS * PER_WRITER, "every writer's every append survived");
  assert.equal(new Set(lines).size, lines.length, "no line was written twice");
  assert.equal(fs.existsSync(path.join(dir, "store-shared.lock")), false, "the lock is left clean");
});
