// Internal taskloop module. Its public seam is the export list at the end.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { STATE_DIR, TASK_FILE, TASK_SCHEMA_VERSION, artifactTimestamp, fnv1aHex, isPlainObject, localTimestamp } from "./prims.mjs";

// saveTask's rename is atomic per write, but a hook's load -> transition -> save
// spans three steps: two parallel processes (e.g. concurrent PreToolUse calls,
// or a PreToolUse racing a Stop) can each read the same task and clobber one
// another's counter, losing rounds/writes/episode/suspension updates. This is
// the same cross-process mkdir lock install.mjs uses, scoped to one task dir, so
// that load-transition-save runs serialized. Reads never take it.

function taskLockProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but is not ours — still a live owner.
    return err?.code === "EPERM";
  }
}

const TASK_LOCK_STALE_MS = 5000;

// A one-slot shared buffer for Atomics.wait — a synchronous, CPU-friendly sleep
// (Node offers no other) that backs off the lock-acquire retry instead of
// hot-spinning while another process holds the lock.
const LOCK_SPIN = new Int32Array(new SharedArrayBuffer(4));

function reapDeadTaskLock(lock) {
  // Reclaim a lock whose owner process is gone (crashed mid-hold). A nested
  // reaper lock lets only one process reap at a time, so two reapers cannot both
  // "win" the same stale lock and rename it out from under each other.
  const reaper = `${lock}.reaper`;
  const reaperToken = randomUUID();
  try {
    fs.mkdirSync(reaper);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    // A reaper lock orphaned by a crash would otherwise force every future
    // contender to degrade forever. Reclaim it once it is clearly stale, then let
    // this attempt retry; a live reaper (held for microseconds) is never this old.
    try {
      if (Date.now() - fs.statSync(reaper).mtimeMs > TASK_LOCK_STALE_MS) {
        fs.rmSync(reaper, { recursive: true, force: true });
      }
    } catch {
      /* reaper vanished under us: the next acquire attempt retries cleanly */
    }
    return false;
  }
  try {
    fs.writeFileSync(path.join(reaper, "owner.json"), JSON.stringify({ pid: process.pid, token: reaperToken }));
    let stat;
    try {
      stat = fs.statSync(lock);
    } catch (err) {
      if (err?.code === "ENOENT") return true; // already gone; retry the mkdir
      throw err;
    }
    // A just-created lock has not written owner.json yet. Without this grace
    // window a contender would read no owner, call it stale, and steal a live
    // lock mid-acquire — exactly the race that leaked concurrent write updates.
    if (Date.now() - stat.mtimeMs <= TASK_LOCK_STALE_MS) return false;
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
    } catch {
      owner = null; // unreadable owner on an aged lock: treat as reapable
    }
    if (owner && taskLockProcessAlive(owner.pid)) return false;
    const quarantine = `${lock}.stale.${process.pid}.${randomUUID()}`;
    try {
      fs.renameSync(lock, quarantine);
    } catch (err) {
      if (err?.code === "ENOENT") return true;
      throw err;
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
    return true;
  } finally {
    // Release only our own reaper: one reclaimed after a long pause must not
    // delete the successor reaper now holding the path.
    let mine = false;
    try {
      mine = JSON.parse(fs.readFileSync(path.join(reaper, "owner.json"), "utf8"))?.token === reaperToken;
    } catch {
      mine = false;
    }
    if (mine) {
      try {
        fs.rmSync(reaper, { recursive: true, force: true });
      } catch {
        /* a stuck reaper lock just makes the next contender retry, never steal */
      }
    }
  }
}

function resolveLockTimeoutMs(timeoutMs) {
  // An explicit arg wins, then TASKLOOP_LOCK_TIMEOUT_MS, else 15s — but only a
  // finite, positive value counts. NaN is the dangerous one: an unchecked NaN
  // deadline makes the acquire loop's `Date.now() >= deadline` forever false, so
  // the lock could never fail closed and would spin indefinitely. Negative and
  // zero would flip it the other way (instant timeout). Reject all three and
  // fall through to the next real bound.
  const envMs = Number.parseInt(process.env.TASKLOOP_LOCK_TIMEOUT_MS ?? "", 10);
  for (const candidate of [timeoutMs, envMs]) {
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return 15000;
}

function withTaskLock(repo, action, { timeoutMs } = {}) {
  const limitMs = resolveLockTimeoutMs(timeoutMs);
  const dir = path.join(repo, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".task.lock");
  const token = randomUUID();
  const deadline = Date.now() + limitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock); // atomic: throws EEXIST while the lock is held
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (reapDeadTaskLock(lock)) continue;
      if (Date.now() >= deadline) {
        // Fail closed, not open: never run the mutating callback without the
        // lock, or we reopen the very lost-update window this lock exists to
        // close. Throw so a hook releases (main's supervisor catch returns 0)
        // and a verb reports a clean error — neither touches task state. A
        // missed record-write undercounts; it never corrupts a concurrent update.
        throw Object.assign(
          new Error(`taskloop: task lock unavailable after ${limitMs}ms; released without mutating task state`),
          { code: "TASKLOCK_TIMEOUT" },
        );
      }
      Atomics.wait(LOCK_SPIN, 0, 0, 5); // brief backoff, not a hot spin, while contended
      continue; // the lock is held only for a load-transition-save
    }
    try {
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token, at: localTimestamp() }));
      return action();
    } finally {
      // Release only our own lock: a reaper may have already handed it on.
      let ours = false;
      try {
        ours = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"))?.token === token;
      } catch {
        // Unreadable owner means the lock we hold was reaped and the path may now
        // belong to a successor: do NOT remove it, or we delete a live lock. The
        // grace window plus reaper reclaims a genuinely orphaned dir instead.
        ours = false;
      }
      if (ours) fs.rmSync(lock, { recursive: true, force: true });
    }
  }
}

function taskPath(repo) {
  return path.join(repo, STATE_DIR, TASK_FILE);
}

function loadTask(repo) {
  const file = taskPath(repo);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isPlainObject(parsed)) throw new Error("root must be a JSON object");
    if (parsed.schema_version !== TASK_SCHEMA_VERSION) {
      throw Object.assign(
        new Error(`taskloop: incompatible task schema at ${file}; run archive-incompatible-state with explicit user authorization, then open a new task`),
        { code: "INCOMPATIBLE_TASK_SCHEMA", file },
      );
    }
    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function saveTask(repo, task) {
  const dir = path.join(repo, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  // The state dir ignores itself: task state and session-authored checkers
  // must never surface in a target repo's diff (observed live: .taskloop/
  // scripts sitting untracked in a repo whose team had never heard of the
  // loop). Help-text advice did not create the ignore; the dir carries it.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    try {
      fs.writeFileSync(ignore, "*\n", "utf8");
    } catch {
      /* advisory: a read-only checkout still gets a working task file */
    }
  }
  const target = taskPath(repo);
  const temporary = path.join(
    dir,
    `.${TASK_FILE}.${process.pid}.${process.hrtime.bigint().toString(36)}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(task, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, target);
  } catch (err) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* preserve the original write failure */
    }
    throw err;
  }
}

function archiveTask(repo, task, at) {
  const archive = path.join(repo, STATE_DIR, "history");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(
    path.join(archive, `task-${artifactTimestamp(at)}-${task.task_id ?? "unknown"}-${randomUUID()}.json`),
    JSON.stringify(task, null, 2) + "\n",
    "utf8",
  );
}

function archiveIncompatibleState(repo, { reason, grantedBy, at }) {
  if (grantedBy !== "user") throw new Error("archive-incompatible-state requires --granted-by user");
  if (!String(reason ?? "").trim()) throw new Error("archive-incompatible-state requires --reason");
  const source = taskPath(repo);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("incompatible task state must be a regular non-symlink file");
  const raw = fs.readFileSync(source);
  const digest = fnv1aHex(raw.toString("latin1"));
  const dir = path.join(repo, STATE_DIR, "archive");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = artifactTimestamp(at);
  const archive = path.join(dir, `incompatible-${stamp}-${digest}-${randomUUID()}.json`);
  fs.renameSync(source, archive);
  const receipt = {
    source_path: path.relative(repo, source).replaceAll("\\", "/"),
    archive_path: path.relative(repo, archive).replaceAll("\\", "/"),
    digest,
    reason,
    granted_by: grantedBy,
    archived_at: at,
  };
  fs.writeFileSync(`${archive}.receipt.json`, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return receipt;
}

export {
  taskPath,
  loadTask,
  saveTask,
  archiveTask,
  archiveIncompatibleState,
  withTaskLock,
};
