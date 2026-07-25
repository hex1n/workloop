// Directory locks, lock ordering, and the poisoning rule.
//
// A lock here is a directory, because mkdir is the one filesystem operation
// that is atomic and fails loudly on every platform we target. Everything else
// in this file exists to answer one question honestly: do we still hold what we
// think we hold? When that becomes unknowable, the process stops taking locks
// rather than guessing.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLASSES = Object.freeze({ STORE: "store", GIT_INDEX: "git_index", CRITERION: "criterion" });

// `store` is innermost: it is the lock that serializes durable writes, so it is
// taken last and held for the shortest time. The two outer classes protect
// slow, external work (a Git index, a criterion process) and never nest with
// each other, because nothing legitimately needs both.
const OUTER = new Set([CLASSES.GIT_INDEX, CLASSES.CRITERION]);
const RESERVED_OWNER_FIELDS = ["lock_class", "resource_id", "pid", "token", "acquired_at_ms", "deadline_ms"];

export class LockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LockError";
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new LockError(code, message);
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else, which is
    // still "alive" for our purposes. Only ESRCH proves it is gone.
    return error.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

// A rename can fail because somebody is *reading* the lock, not because the
// lock was lost. Windows refuses to rename a directory while any handle inside
// it is open, and every waiter peeks at owner.json every 20ms — so the proof of
// a release races the polling of the very process waiting for it. Retrying the
// proof is not a guess: mkdir still says this process holds the lock, and
// nothing else can take the path until the rename succeeds.
//
// These are the codes Windows reports for that sharing violation, and the retry
// is Windows-only on purpose. The same codes mean something permanent on POSIX
// — an unwritable parent directory raises EACCES and will raise it forever —
// so treating them as contention everywhere would turn "you may not do this"
// into half a second of hope. The phenomenon is the platform's, and saying so
// is truer than pretending the codes carry one meaning.
const CONTENDED = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 25;

export function createLockManager({ resolveLockPath, now = () => Date.now(), defaults = {}, rename = fs.renameSync, platform = process.platform } = {}) {
  if (typeof resolveLockPath !== "function") refuse("INVALID_LOCK_MANAGER", "a lock manager needs resolveLockPath");

  const renameContended = (from, to) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        rename(from, to);
        return;
      } catch (error) {
        // Anything that is not a reader in the way is a real failure, and one
        // more attempt would only delay saying so.
        if (attempt >= RENAME_ATTEMPTS || platform !== "win32" || !CONTENDED.has(error.code)) throw error;
        sleep(20);
      }
    }
  };
  // Poisoning is per-manager and irreversible by design. A release we could not
  // verify means the lock's state is unknown; taking another one after that
  // would be a guess dressed up as mutual exclusion.
  let poison = null;
  const held = [];

  const assertOrder = (lockClass, resourceId) => {
    if (poison) refuse("LOCK_STATE_POISONED", `lock state is poisoned: ${poison}`);
    if (!Object.values(CLASSES).includes(lockClass)) refuse("UNKNOWN_LOCK_CLASS", `unknown lock class ${lockClass}`);
    // Two distinct invariants that a class-only check would conflate: taking
    // the same lock again is reentrancy, while holding two different stores at
    // once is the thing that must never happen however it was reached. The
    // resource id is what tells them apart.
    if (held.some((entry) => entry.lockClass === lockClass && entry.resourceId === resourceId)) {
      refuse("NON_REENTRANT", `${lockClass} locks are non-reentrant`);
    }
    if (lockClass === CLASSES.STORE && held.some((entry) => entry.lockClass === CLASSES.STORE)) {
      refuse("TWO_STORES", "two stores cannot be held together");
    }
    if (OUTER.has(lockClass) && held.some((entry) => entry.lockClass === CLASSES.STORE)) {
      refuse("LOCK_ORDER_VIOLATION", `${lockClass} cannot be taken while a store lock is held`);
    }
    if (OUTER.has(lockClass) && held.some((entry) => OUTER.has(entry.lockClass))) {
      refuse("LOCK_ORDER_VIOLATION", `${lockClass} cannot be taken while ${held.find((entry) => OUTER.has(entry.lockClass)).lockClass} is held`);
    }
    void resourceId;
  };

  const reap = (lockPath, owner) => {
    // Renaming first makes the reap itself atomic: whoever wins the rename owns
    // the cleanup, so two reapers cannot both decide they freed the lock.
    const tombstone = `${lockPath}.reaped.${randomUUID()}`;
    try {
      fs.renameSync(lockPath, tombstone);
    } catch {
      return false;
    }
    const observed = readOwner(tombstone);
    if (observed && owner && observed.token !== owner.token) {
      // Someone re-acquired between our inspection and our rename.
      try { fs.renameSync(tombstone, lockPath); } catch { /* the new holder already published its own */ }
      return false;
    }
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
  };

  function acquire(lockClass, resourceId, options) {
    const lockPath = resolveLockPath({ lockClass, resourceId });
    const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? 5_000;
    const leaseMs = options.leaseMs ?? defaults.leaseMs ?? 30_000;
    const token = randomUUID();
    const deadline = now() + timeoutMs;
    for (;;) {
      try {
        fs.mkdirSync(lockPath, { recursive: false });
        const owner = { lock_class: lockClass, resource_id: resourceId, pid: process.pid, token, acquired_at_ms: now(), deadline_ms: now() + leaseMs };
        for (const [key, value] of Object.entries(options.ownerExtra ?? {})) {
          if (RESERVED_OWNER_FIELDS.includes(key)) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            refuse("RESERVED_OWNER_FIELD", `owner metadata may not set reserved fields: ${key}`);
          }
          owner[key] = value;
        }
        fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner));
        return { lockPath, token };
      } catch (error) {
        if (error instanceof LockError) throw error;
        if (error.code !== "EEXIST") refuse("LOCK_ACQUIRE_FAILED", `cannot acquire ${lockClass} lock: ${error.message}`);
      }
      const owner = readOwner(lockPath);
      // Both conditions are required. A dead pid alone would let pid reuse
      // steal a live lock; an expired lease alone would leave a crashed
      // holder's lock standing until it happened to expire.
      if (owner && !processIsAlive(owner.pid) && now() > owner.deadline_ms) {
        reap(lockPath, owner);
        continue;
      }
      if (now() >= deadline) refuse("LOCK_UNAVAILABLE", `${lockClass} lock on ${resourceId} is held by another process`);
      sleep(20);
    }
  }

  function release(entry) {
    const observed = readOwner(entry.lockPath);
    if (!observed || observed.token !== entry.token) {
      poison = `released a ${entry.lockClass} lock that no longer belonged to this process`;
      refuse("LOCK_RELEASE_FAILED", poison);
    }
    // Release is a rename, not a recursive delete. Renaming is atomic, so the
    // moment it returns the lock path is free and the release is proven — no
    // second look is needed, and none would be trustworthy anyway, since the
    // next holder may already have taken the path.
    //
    // The rename also protects the evidence. A recursive delete removes
    // owner.json first and only then fails on the directory, which would
    // destroy the record of who held the lock in exactly the case where
    // somebody needs to read it.
    const tombstone = `${entry.lockPath}.released.${entry.token}`;
    try {
      renameContended(entry.lockPath, tombstone);
    } catch (error) {
      poison = `could not release the ${entry.lockClass} lock: ${error.message}`;
      refuse("LOCK_RELEASE_FAILED", poison);
    }
    // The lock is already released; a tombstone that outlives us is litter,
    // not a correctness problem, and is not worth poisoning a healthy process.
    // `force` only forgives a missing path, so the same reader that delayed the
    // rename could still make this throw — and throwing here would turn a
    // completed release into an error the caller cannot act on.
    try {
      fs.rmSync(tombstone, { recursive: true, force: true });
    } catch { /* litter */ }
  }

  return {
    get poisoned() { return poison; },
    withLock(lockClass, resourceId, action, options = {}) {
      assertOrder(lockClass, resourceId);
      const { lockPath, token } = acquire(lockClass, resourceId, options);
      const entry = { lockClass, resourceId, lockPath, token };
      held.push(entry);
      let result;
      let actionError = null;
      try {
        result = action();
        if (result instanceof Promise) refuse("ASYNC_CRITICAL_SECTION", "a critical section must be synchronous");
      } catch (error) {
        actionError = error;
      }
      held.pop();
      // Release runs even when the action threw: the action's failure is the
      // caller's problem, but an unreleased lock is everyone's.
      try {
        release(entry);
      } catch (releaseError) {
        // When both failed, the release failure is the more serious one (the
        // process is now poisoned) but the action failure is why anyone was
        // here. Losing either would make the receipt a lie.
        if (actionError) releaseError.actionError = actionError;
        throw releaseError;
      }
      if (actionError) throw actionError;
      return result;
    },
  };
}
