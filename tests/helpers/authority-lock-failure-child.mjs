import fs from "node:fs";
import path from "node:path";

import { createLockManager, runAuthorityTransaction, runAuthorityTransactionsSequential } from "../../lib/authority-transaction.mjs";

const [mode, root] = process.argv.slice(2);
const lockPath = (resourceId) => path.join(root, `${resourceId}.lock`);

function failureFs({ release = false, owner = false, unreadableClaim = false, unreadableOwner = false, misleadingClaimExists = false, unreadableClaimStat = false } = {}) {
  return new Proxy(fs, { get(target, property) {
    if (property === "existsSync" && misleadingClaimExists) return (targetPath) => String(targetPath).endsWith(".lock.claim") ? false : fs.existsSync(targetPath);
    if (property === "lstatSync" && unreadableClaimStat) return (targetPath, ...args) => {
      if (String(targetPath).endsWith(".lock.claim")) throw Object.assign(new Error("claim stat sentinel"), { code: "EACCES" });
      return fs.lstatSync(targetPath, ...args);
    };
    if (property === "renameSync" && release) return (source, destination) => {
      if (String(source).endsWith(".lock")) throw Object.assign(new Error("release sentinel"), { code: "EIO" });
      return fs.renameSync(source, destination);
    };
    if (property === "writeFileSync" && owner) return (targetPath, ...args) => {
      if (String(targetPath).endsWith(path.join(".lock", "owner.json"))) throw Object.assign(new Error("owner write sentinel"), { code: "EIO" });
      return fs.writeFileSync(targetPath, ...args);
    };
    if (property === "readFileSync" && (unreadableClaim || unreadableOwner)) return (targetPath, ...args) => {
      if (String(targetPath).endsWith(".lock.claim")) throw Object.assign(new Error("claim read sentinel"), { code: "EIO" });
      if (unreadableOwner && String(targetPath).endsWith(path.join(".lock", "owner.json"))) throw Object.assign(new Error("owner read sentinel"), { code: "EIO" });
      return fs.readFileSync(targetPath, ...args);
    };
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function manager(fsOps, options = {}) {
  return createLockManager({
    resolveLockPath: ({ resourceId }) => lockPath(resourceId),
    optionsForLock: () => ({ timeoutMs: 100, staleMs: 5_000, fsOps, ...options }),
  });
}

function poisonProbe(locks) {
  let entered = false;
  let failure = null;
  try { locks.withLock("authority", "next", () => { entered = true; }); } catch (error) { failure = error; }
  return { entered, code: failure?.code ?? null, next_lock_exists: fs.existsSync(lockPath("next")), next_claim_exists: fs.existsSync(`${lockPath("next")}.claim`) };
}

let output;
if (mode === "release") {
  const locks = manager(failureFs({ release: true }));
  let failure;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority", append: () => "durably-appended" }); } catch (error) { failure = error; }
  output = {
    failure: { code: failure.code, phase: failure.phase, append_committed: failure.append_committed, cause_code: failure.cause.code },
    poison: poisonProbe(locks),
    first_lock_exists: fs.existsSync(lockPath("authority")),
    first_claim_exists: fs.existsSync(`${lockPath("authority")}.claim`),
  };
} else if (mode === "observer-release") {
  const observer = { entered: false, code: null };
  let locks;
  locks = manager(failureFs({ release: true }), { onReleaseError: () => {
    try { locks.withLock("authority", "observer-next", () => { observer.entered = true; }); }
    catch (error) { observer.code = error.code; }
  } });
  let failure;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority", append: () => "durably-appended" }); } catch (error) { failure = error; }
  output = { failure_code: failure.code, observer };
} else if (mode === "observer-acquire") {
  const observer = { entered: false, code: null };
  let locks;
  locks = manager(failureFs({ owner: true, unreadableClaim: true }), { onAcquireError: () => {
    try { locks.withLock("authority", "observer-next", () => { observer.entered = true; }); }
    catch (error) { observer.code = error.code; }
  } });
  let failure;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority", append: () => "must-not-run" }); } catch (error) { failure = error; }
  output = { failure_code: failure.code, observer };
} else if (mode === "unproven-release") {
  const locks = manager(failureFs({ unreadableOwner: true }));
  let failure;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority", append: () => "durably-appended" }); } catch (error) { failure = error; }
  output = {
    failure: {
      code: failure.code,
      phase: failure.phase,
      append_committed: failure.append_committed,
      cause_code: failure.cause.code,
      physical_cause_code: failure.cause.cause.code,
    },
    poison: poisonProbe(locks),
    first_lock_exists: fs.existsSync(lockPath("authority")),
    first_claim_exists: fs.existsSync(`${lockPath("authority")}.claim`),
  };
} else if (mode === "misleading-exists") {
  const locks = manager(failureFs({ misleadingClaimExists: true }));
  const result = runAuthorityTransaction({ lockManager: locks, authorityId: "authority", append: () => "durably-appended" });
  let next = false;
  locks.withLock("authority", "next", () => { next = true; });
  output = {
    result: result.append,
    next,
    first_lock_exists: fs.existsSync(lockPath("authority")),
    first_claim_exists: fs.existsSync(`${lockPath("authority")}.claim`),
  };
} else if (mode === "unproven-claim-stat") {
  const locks = manager(failureFs({ unreadableClaimStat: true }));
  let failure;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority", append: () => "durably-appended" }); } catch (error) { failure = error; }
  output = {
    failure: { code: failure.code, phase: failure.phase, append_committed: failure.append_committed, cause_code: failure.cause.code, physical_cause_code: failure.cause.cause.code },
    poison: poisonProbe(locks),
    first_lock_exists: fs.existsSync(lockPath("authority")),
    first_claim_exists: fs.existsSync(`${lockPath("authority")}.claim`),
  };
} else if (mode === "double") {
  const locks = manager(failureFs({ release: true }));
  let failure;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority", append: () => { throw Object.assign(new Error("append sentinel"), { code: "EACCES" }); } }); } catch (error) { failure = error; }
  output = {
    phase: failure.phase,
    append_committed: failure.append_committed,
    cause_code: failure.cause.code,
    action_error_code: failure.cause.action_error.code,
    action_cause_code: failure.cause.action_error.cause.code,
    poison: poisonProbe(locks),
  };
} else if (mode === "sequence-release") {
  const locks = manager(failureFs({ release: true }));
  let failure;
  try { runAuthorityTransactionsSequential({ lockManager: locks, operationId: "operation-release", authorityIds: ["authority"], action: () => "authority-result" }); } catch (error) { failure = error; }
  output = { receipt: failure.receipt, poison: poisonProbe(locks) };
} else if (mode === "sequence-acquire") {
  const locks = manager(failureFs({ owner: true, unreadableClaim: true }));
  let failure;
  try { runAuthorityTransactionsSequential({ lockManager: locks, operationId: "operation-acquire", authorityIds: ["authority"], action: () => "must-not-run" }); } catch (error) { failure = error; }
  output = {
    receipt: failure.receipt,
    cleanup: failure.cause.acquisition_cleanup,
    poison: poisonProbe(locks),
    first_lock_exists: fs.existsSync(lockPath("authority")),
    first_claim_exists: fs.existsSync(`${lockPath("authority")}.claim`),
  };
} else {
  throw new Error(`unknown mode: ${mode}`);
}

process.stdout.write(`${JSON.stringify(output)}\n`);
