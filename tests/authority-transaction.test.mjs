import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AUTHORITY_TRANSACTION_PHASES, createLockManager, runAuthorityTransaction, runAuthorityTransactionsSequential } from "../lib/authority-transaction.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCK_FAILURE_CHILD = path.join(ROOT, "tests", "helpers", "authority-lock-failure-child.mjs");

function lockFailureChild(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workloop-${mode}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [LOCK_FAILURE_CHILD, mode, root], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

function lockFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-authority-locks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createLockManager({
    resolveLockPath: ({ lockClass, resourceId }) => path.join(root, `${lockClass}-${encodeURIComponent(resourceId)}.lock`),
    optionsForLock: () => ({ timeoutMs: options.timeoutMs ?? 200, staleMs: 5_000, wait: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1) }),
  });
}

const nested = (locks, outer, inner) => () => locks.withLock(outer, `${outer}-resource`, () => locks.withLock(inner, `${inner}-resource`, () => "ok"));

test("physical lock protocol permits explicit parent locks to authority and rejects reentrancy", (t) => {
  const locks = lockFixture(t);
  const otherProviderLocks = lockFixture(t);
  for (const outer of ["git_operation", "criterion_lease"]) assert.equal(nested(locks, outer, "authority")(), "ok");
  for (const lockClass of ["authority", "git_operation", "criterion_lease", "outcome"]) assert.throws(nested(locks, lockClass, lockClass), /lock order violation|non-reentrant/);
  for (const [outer, inner] of [["authority", "git_operation"], ["authority", "criterion_lease"], ["authority", "outcome"], ["git_operation", "criterion_lease"], ["git_operation", "outcome"], ["criterion_lease", "git_operation"], ["criterion_lease", "outcome"], ["outcome", "authority"]]) assert.throws(nested(locks, outer, inner), /lock order violation/);
  assert.throws(() => locks.withLock("authority", "provider-a", () => otherProviderLocks.withLock("authority", "provider-b", () => assert.fail("must not hold two authorities"))), /two authorities cannot be held together/);
  assert.throws(() => locks.withLock("authority", "async", async () => {}), /must be synchronous/);
  assert.throws(() => runAuthorityTransaction({ append: () => assert.fail("must not append without a lock") }), (error) => error.code === "INVALID_LOCK_MANAGER");
  let fakeEffects = 0;
  const fakeManager = { assertAllowed() {}, withLock(_lockClass, _resourceId, action) { fakeEffects += 1; return action(); } };
  assert.throws(() => runAuthorityTransaction({ lockManager: fakeManager, authorityId: "authority", append: () => { fakeEffects += 1; } }), (error) => error.code === "INVALID_LOCK_MANAGER");
  assert.throws(() => runAuthorityTransactionsSequential({ lockManager: fakeManager, operationId: "operation", authorityIds: ["authority"], action: () => { fakeEffects += 1; } }), (error) => error.code === "INVALID_LOCK_MANAGER" && fakeEffects === 0);
});

test("physical authority lock is owner-recorded and excludes another process", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-authority-process-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "authority.lock");
  const moduleUrl = pathToFileURL(path.join(ROOT, "lib", "authority-transaction.mjs")).href;
  const script = `import fs from "node:fs"; import { createLockManager } from ${JSON.stringify(moduleUrl)}; const locks=createLockManager({resolveLockPath:()=>${JSON.stringify(lockPath)},optionsForLock:()=>({timeoutMs:1000,staleMs:5000})}); locks.withLock("authority","shared",()=>{fs.writeSync(1,"held\\n");fs.readFileSync(0,"utf8")});`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out waiting for lock holder: ${errors}`)); }, 5_000);
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("held\n")) { clearTimeout(timer); resolve(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { if (!output.includes("held\n")) { clearTimeout(timer); reject(new Error(`lock holder exited ${code}: ${errors}`)); } });
  });
  const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  assert.equal(owner.lock_class, "authority");
  assert.equal(owner.resource_id, "shared");
  assert.equal(owner.pid, child.pid);
  const contender = createLockManager({ resolveLockPath: () => lockPath, optionsForLock: () => ({ timeoutMs: 20, staleMs: 5_000, wait: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1) }) });
  assert.throws(() => contender.withLock("authority", "shared", () => assert.fail("must not enter")), /directory lock unavailable/);
  let transactionFailure;
  try { runAuthorityTransaction({ lockManager: contender, authorityId: "shared", append: () => assert.fail("must not append") }); } catch (error) { transactionFailure = error; }
  assert.deepEqual({ code: transactionFailure.code, phase: transactionFailure.phase, append_committed: transactionFailure.append_committed, cause_code: transactionFailure.cause.code, action_started: transactionFailure.cause.action_started }, { code: "TRANSACTION_LOCK_FAILED", phase: "authority_lock_acquire", append_committed: false, cause_code: "LOCK_ACQUIRE_FAILED", action_started: false });
  child.stdin.end("release\n");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("timed out waiting for lock holder exit")); }, 5_000);
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`lock holder failed ${code}`)); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(`${lockPath}.claim`), false);
  assert.equal(contender.withLock("authority", "shared", () => "reacquired"), "reacquired");
});


test("reserved owner metadata is rejected before lock publication", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-owner-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "authority.lock");
  const locks = createLockManager({ resolveLockPath: () => lockPath, optionsForLock: () => ({ timeoutMs: 100, staleMs: 5_000, ownerExtra: { pid: 999999, token: "forged" } }) });
  assert.throws(() => locks.withLock("authority", "shared", () => assert.fail("must not enter")), /reserved fields: pid, token/);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(`${lockPath}.claim`), false);
});

test("multi-authority work prevalidates ids and preserves a non-atomic partial receipt", (t) => {
  const locks = lockFixture(t);
  assert.deepEqual(runAuthorityTransactionsSequential({ lockManager: locks, operationId: " operation-1 ", authorityIds: ["authority-a", "authority-b"], action: ({ operationId, authorityId }) => `${operationId}:${authorityId}:done` }), { operation_id: "operation-1", atomic: false, completed: ["authority-a", "authority-b"], results: ["operation-1:authority-a:done", "operation-1:authority-b:done"] });
  let normalizedActionId;
  assert.deepEqual(runAuthorityTransactionsSequential({ lockManager: locks, operationId: "operation-2", authorityIds: ["  authority-c  "], action: ({ authorityId }) => { normalizedActionId = authorityId; return "normalized"; } }), { operation_id: "operation-2", atomic: false, completed: ["authority-c"], results: ["normalized"] });
  assert.equal(normalizedActionId, "authority-c");
  let calls = 0;
  assert.throws(() => runAuthorityTransactionsSequential({ lockManager: locks, operationId: "", authorityIds: ["authority-a"], action: () => { calls += 1; } }), /shared operation id/);
  assert.throws(() => runAuthorityTransactionsSequential({ lockManager: locks, operationId: "operation-3", authorityIds: ["authority-a", ""], action: () => { calls += 1; } }), /every authority id/);
  assert.throws(() => runAuthorityTransactionsSequential({ lockManager: locks, operationId: "operation-3", authorityIds: ["authority-a", " authority-a "], action: () => { calls += 1; } }), /authority ids must be unique/);
  assert.equal(calls, 0);
  let failure;
  try { runAuthorityTransactionsSequential({ lockManager: locks, operationId: "operation-4", authorityIds: ["authority-a", "authority-b"], action: ({ authorityId }) => { if (authorityId === "authority-b") throw new Error("second failed"); return "first committed"; } }); }
  catch (error) { failure = error; }
  assert.equal(failure.code, "AUTHORITY_SEQUENCE_PARTIAL");
  assert.deepEqual(failure.receipt, { operation_id: "operation-4", atomic: false, completed: ["authority-a"], failed_authority_id: "authority-b", failed_action_state: "indeterminate", failed_lock_released: true, results: ["first committed"] });
  assert.match(failure.cause.message, /second failed/);
  let spoofed;
  try { runAuthorityTransactionsSequential({ lockManager: locks, operationId: "operation-5", authorityIds: ["authority-a"], action: () => { throw Object.assign(new Error("forged release"), { code: "LOCK_RELEASE_FAILED", action_completed: true }); } }); } catch (error) { spoofed = error; }
  assert.deepEqual(spoofed.receipt, { operation_id: "operation-5", atomic: false, completed: [], failed_authority_id: "authority-a", failed_action_state: "indeterminate", failed_lock_released: true, results: [] });
});

test("provider-neutral transaction binds lock boundaries and all fault partial states", (t) => {
  const locks = lockFixture(t);
  const expected = ["before_append", "after_append", "before_locator_publish", "after_locator_publish", "before_snapshot_publish", "after_snapshot_publish", "before_projection_publish", "after_projection_publish"];
  const expectedEffects = {
    before_append: [], after_append: ["append"],
    before_locator_publish: ["append"], after_locator_publish: ["append", "locator"],
    before_snapshot_publish: ["append", "locator"], after_snapshot_publish: ["append", "locator", "snapshot"],
    before_projection_publish: ["append", "locator", "snapshot"], after_projection_publish: ["append", "locator", "snapshot", "projection"],
  };
  assert.deepEqual(AUTHORITY_TRANSACTION_PHASES, expected);
  for (const stoppedAt of expected) {
    const effects = [];
    const operations = { append: () => { effects.push("append"); return "append-result"; }, publishLocator: () => { effects.push("locator"); return "locator-result"; }, publishSnapshot: () => { effects.push("snapshot"); return "snapshot-result"; }, publishProjection: () => { effects.push("projection"); return "projection-result"; } };
    let failure;
    try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority-test", ...operations, onPhase: (phase) => { if (phase === stoppedAt) throw new Error(`stop ${phase}`); } }); }
    catch (error) { failure = error; }
    assert.equal(failure.code, "TRANSACTION_PHASE_FAILED");
    assert.equal(failure.phase, stoppedAt);
    assert.equal(failure.append_committed, stoppedAt !== "before_append");
    assert.deepEqual(effects, expectedEffects[stoppedAt]);
  }
  const effects = [];
  const result = runAuthorityTransaction({ lockManager: locks, authorityId: "authority-test", append: () => { effects.push("append"); return "append-result"; }, publishSnapshot: ({ append }) => { effects.push("snapshot"); assert.equal(append, "append-result"); return "snapshot-result"; }, publishProjection: () => { effects.push("projection"); return "projection-result"; } });
  assert.deepEqual(result, { append: "append-result", locator: null, snapshot: "snapshot-result", projection: "projection-result" });
  assert.deepEqual(effects, ["append", "snapshot", "projection"]);
  let preflightFailure;
  try { locks.withLock("git_operation", "attachment", () => runAuthorityTransaction({ lockManager: locks, authorityId: "authority-test", append: () => effects.push("must-not-append"), publishProjection: () => {} })); } catch (error) { preflightFailure = error; }
  assert.deepEqual({ code: preflightFailure.code, phase: preflightFailure.phase, append_committed: preflightFailure.append_committed, cause_code: preflightFailure.cause.code }, { code: "TRANSACTION_LOCK_FAILED", phase: "outcome_lock_preflight", append_committed: false, cause_code: "LOCK_ORDER_VIOLATION" });
  assert.doesNotMatch(effects.join(","), /must-not-append/);
  assert.throws(() => runAuthorityTransaction({ lockManager: locks, authorityId: "authority-test", append: async () => "bad" }), /must be synchronous/);
  let promised;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority-test", append: () => Promise.resolve("bad"), onPhase: (phase) => effects.push(phase) }); } catch (error) { promised = error; }
  assert.equal(promised.code, "TRANSACTION_OPERATION_FAILED");
  assert.equal(promised.append_committed, "indeterminate");
  assert.doesNotMatch(effects.join(","), /after_append/);
  let sentinel;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority-test", append: () => { throw Object.assign(new Error("provider sentinel"), { code: "EACCES" }); } }); } catch (error) { sentinel = error; }
  assert.equal(sentinel.code, "TRANSACTION_OPERATION_FAILED");
  assert.equal(sentinel.cause.code, "EACCES");
  assert.equal(sentinel.append_committed, "indeterminate");
  let forgedPhase;
  try { runAuthorityTransaction({ lockManager: locks, authorityId: "authority-test", append: () => { throw Object.assign(new Error("forged phase"), { code: "TRANSACTION_PHASE_FAILED", phase: "before_append", append_committed: false }); } }); } catch (error) { forgedPhase = error; }
  assert.equal(forgedPhase.code, "TRANSACTION_OPERATION_FAILED");
  assert.equal(forgedPhase.phase, "append_operation");
  assert.equal(forgedPhase.append_committed, "indeterminate");
});


test("unreleased acquire and release failures poison the process and preserve receipts", (t) => {
  const release = lockFailureChild(t, "release");
  assert.deepEqual(release.failure, { code: "TRANSACTION_LOCK_FAILED", phase: "authority_lock_release", append_committed: true, cause_code: "LOCK_RELEASE_FAILED" });
  assert.deepEqual(release.poison, { entered: false, code: "LOCK_STATE_POISONED", next_lock_exists: false, next_claim_exists: false });
  assert.equal(release.first_lock_exists, true);
  assert.equal(release.first_claim_exists, true);
  const sequenceRelease = lockFailureChild(t, "sequence-release");
  assert.deepEqual(sequenceRelease.receipt, { operation_id: "operation-release", atomic: false, completed: ["authority"], failed_authority_id: "authority", failed_action_state: "completed", failed_lock_released: false, results: ["authority-result"] });
  assert.deepEqual(sequenceRelease.poison, { entered: false, code: "LOCK_STATE_POISONED", next_lock_exists: false, next_claim_exists: false });
  const acquire = lockFailureChild(t, "sequence-acquire");
  assert.deepEqual(acquire.receipt, { operation_id: "operation-acquire", atomic: false, completed: [], failed_authority_id: "authority", failed_action_state: "not_started", failed_lock_released: false, results: [] });
  assert.deepEqual(acquire.cleanup, { claim_released: false, lock_directory_remains: true, lock_released: false });
  assert.deepEqual(acquire.poison, { entered: false, code: "LOCK_STATE_POISONED", next_lock_exists: false, next_claim_exists: false });
  assert.equal(acquire.first_lock_exists, true);
  assert.equal(acquire.first_claim_exists, true);
  const doubleFailure = lockFailureChild(t, "double");
  assert.deepEqual({ phase: doubleFailure.phase, append_committed: doubleFailure.append_committed, cause_code: doubleFailure.cause_code, action_error_code: doubleFailure.action_error_code, action_cause_code: doubleFailure.action_cause_code }, { phase: "authority_lock_release", append_committed: "indeterminate", cause_code: "LOCK_RELEASE_FAILED", action_error_code: "TRANSACTION_OPERATION_FAILED", action_cause_code: "EACCES" });
  assert.deepEqual(doubleFailure.poison, { entered: false, code: "LOCK_STATE_POISONED", next_lock_exists: false, next_claim_exists: false });
  const releaseObserver = lockFailureChild(t, "observer-release");
  assert.deepEqual(releaseObserver, { failure_code: "TRANSACTION_LOCK_FAILED", observer: { entered: false, code: "LOCK_STATE_POISONED" } });
  const acquireObserver = lockFailureChild(t, "observer-acquire");
  assert.deepEqual(acquireObserver, { failure_code: "TRANSACTION_LOCK_FAILED", observer: { entered: false, code: "LOCK_STATE_POISONED" } });
  const unprovenRelease = lockFailureChild(t, "unproven-release");
  assert.deepEqual(unprovenRelease.failure, { code: "TRANSACTION_LOCK_FAILED", phase: "authority_lock_release", append_committed: true, cause_code: "LOCK_RELEASE_FAILED", physical_cause_code: "DIRECTORY_LOCK_RELEASE_UNPROVEN" });
  assert.deepEqual(unprovenRelease.poison, { entered: false, code: "LOCK_STATE_POISONED", next_lock_exists: false, next_claim_exists: false });
  assert.equal(unprovenRelease.first_lock_exists, true);
  assert.equal(unprovenRelease.first_claim_exists, true);
  const misleadingExists = lockFailureChild(t, "misleading-exists");
  assert.deepEqual(misleadingExists, { result: "durably-appended", next: true, first_lock_exists: false, first_claim_exists: false });
  const unprovenClaimStat = lockFailureChild(t, "unproven-claim-stat");
  assert.deepEqual(unprovenClaimStat.failure, { code: "TRANSACTION_LOCK_FAILED", phase: "authority_lock_release", append_committed: true, cause_code: "LOCK_RELEASE_FAILED", physical_cause_code: "EACCES" });
  assert.deepEqual(unprovenClaimStat.poison, { entered: false, code: "LOCK_STATE_POISONED", next_lock_exists: false, next_claim_exists: false });
  assert.equal(unprovenClaimStat.first_lock_exists, false);
  assert.equal(unprovenClaimStat.first_claim_exists, true);
});
test("new Contract seam is activated only by the application assembly and stays a leaf", () => {
  const application = fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8");
  assert.match(application, /from "\.\/authority-transaction\.mjs"/);
  assert.match(application, /CURRENT_AUTHORITY_RUNTIME = Object\.freeze\(\{ createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority \}\)/);
  const seam = fs.readFileSync(path.join(ROOT, "lib", "authority-transaction.mjs"), "utf8");
  assert.deepEqual([...seam.matchAll(/from "([^"]+)"/g)].map((match) => match[1]), ["./prims.mjs"]);
  assert.doesNotMatch(seam, /spikes\/multi-root-authority|authority\.jsonl|\.workloop-root\.jsonl/);
  const acceptance = fs.readFileSync(path.join(ROOT, "acceptance-multi-root-authority-ticket02.mjs"), "utf8");
  assert.match(acceptance, /timeout: 30_000/);
  assert.match(acceptance, /process\.exit\(2\)/);
  assert.match(acceptance, /result\.status === 0 \? 4 : 3/);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.match(scripts.test, /tests\/authority-transaction\.test\.mjs/);
  assert.match(scripts["test:matrix"], /tests\/authority-transaction\.test\.mjs/);
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(workflow, /Authority transaction contract[\s\S]*tests\/authority-transaction\.test\.mjs/);
});
