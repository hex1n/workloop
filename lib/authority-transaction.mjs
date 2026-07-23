// Provider-neutral authority transaction and physical lock protocol.
// This leaf owns ordering, receipts, and fault semantics. Provider-specific
// paths and storage callbacks are injected by the application assembly.

import { withOwnedDirectoryLock } from "./prims.mjs";

const LOCK_CLASSES = new Set(["authority", "git_operation", "criterion_lease", "outcome", "maintenance"]);
const AUTHORITY_PARENTS = new Set(["git_operation", "criterion_lease"]);
const RESERVED_OWNER_FIELDS = new Set(["pid", "token", "lock_class", "resource_id"]);
const PROCESS_LOCK_STACK = [];
let PROCESS_LOCK_POISON = null;
const OWNED_LOCK_FAILURE = Symbol("owned-lock-failure");
const PHYSICAL_LOCK_MANAGER = Symbol("physical-lock-manager");
const OWNED_TRANSACTION_FAILURE = Symbol("owned-transaction-failure");
const AUTHORITY_TRANSACTION_PHASES = Object.freeze([
  "before_append", "after_append",
  "before_locator_publish", "after_locator_publish",
  "before_snapshot_publish", "after_snapshot_publish",
  "before_projection_publish", "after_projection_publish",
]);

function seamError(code, message, fields = {}, cause = undefined) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, ...fields });
}

function ownedLockFailure(code, message, fields = {}, cause = undefined) {
  const error = seamError(code, message, fields, cause);
  Object.defineProperty(error, OWNED_LOCK_FAILURE, { value: true });
  return error;
}

function isOwnedLockFailure(error, code = null) {
  return error?.[OWNED_LOCK_FAILURE] === true && (code === null || error.code === code);
}

function isPhysicalLockManager(manager) {
  return manager?.[PHYSICAL_LOCK_MANAGER] === true && typeof manager.withLock === "function" && typeof manager.assertAllowed === "function";
}

function transactionFailure(code, message, fields = {}, cause = undefined) {
  const error = seamError(code, message, fields, cause);
  Object.defineProperty(error, OWNED_TRANSACTION_FAILURE, { value: true });
  return error;
}

function isOwnedTransactionFailure(error) {
  return error?.[OWNED_TRANSACTION_FAILURE] === true;
}

function poisonProcessLock(failure) {
  if (PROCESS_LOCK_POISON !== null) return;
  PROCESS_LOCK_POISON = Object.freeze({ code: failure.code, lock_class: failure.lock_class, resource_id: failure.resource_id, lock_released: false });
}

function validResourceId(resourceId) {
  return typeof resourceId === "string" && resourceId.trim().length > 0;
}

function assertSynchronousCallback(callback, name) {
  if (typeof callback !== "function") throw seamError("INVALID_CALLBACK", `${name} must be a function`);
  if (callback.constructor?.name === "AsyncFunction") throw seamError("ASYNC_CALLBACK_UNSUPPORTED", `${name} must be synchronous`);
}

function synchronousResult(value, name) {
  if (value && typeof value.then === "function") throw seamError("ASYNC_CALLBACK_UNSUPPORTED", `${name} returned a promise; authority durability callbacks must be synchronous`);
  return value;
}

function createLockManager({ resolveLockPath, optionsForLock = () => ({}) } = {}) {
  assertSynchronousCallback(resolveLockPath, "resolveLockPath");
  assertSynchronousCallback(optionsForLock, "optionsForLock");
  function assertAllowed(lockClass) {
    if (!LOCK_CLASSES.has(lockClass)) throw seamError("UNKNOWN_LOCK_CLASS", `unknown lock class: ${lockClass}`);
    if (PROCESS_LOCK_POISON !== null) throw seamError("LOCK_STATE_POISONED", "an earlier lock could not be proven released; restart the process before further lock work", { unreleased_lock: PROCESS_LOCK_POISON });
    const stack = PROCESS_LOCK_STACK;
    const parent = stack.at(-1) ?? null;
    if (lockClass === "authority" && stack.some((lock) => lock.lockClass === "authority")) throw seamError("AUTHORITY_LOCK_NON_REENTRANT", "authority lock is non-reentrant and two authorities cannot be held together");
    const allowed = parent === null || (stack.length === 1 && lockClass === "authority" && AUTHORITY_PARENTS.has(parent.lockClass));
    if (!allowed) throw seamError("LOCK_ORDER_VIOLATION", `lock order violation: ${lockClass} cannot nest under ${parent.lockClass}`);
  }

  function withLock(lockClass, resourceId, action) {
    if (!validResourceId(resourceId)) throw seamError("INVALID_LOCK_RESOURCE", "lock resource must be a non-empty string");
    assertSynchronousCallback(action, "lock action");
    assertAllowed(lockClass);
    const normalizedResourceId = resourceId.trim();
    const lockPath = synchronousResult(resolveLockPath({ lockClass, resourceId: normalizedResourceId }), "resolveLockPath");
    if (typeof lockPath !== "string" || !lockPath) throw seamError("INVALID_LOCK_PATH", "lock path resolver must return a non-empty string");
    const configured = synchronousResult(optionsForLock({ lockClass, resourceId: normalizedResourceId }), "optionsForLock") ?? {};
    const timeoutMs = configured.timeoutMs ?? 15_000;
    const staleMs = configured.staleMs ?? 5_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(staleMs) || staleMs <= 0) throw seamError("INVALID_LOCK_OPTIONS", "lock timeout and stale window must be positive finite numbers");
    const ownerExtra = configured.ownerExtra ?? {};
    if (!ownerExtra || typeof ownerExtra !== "object" || Array.isArray(ownerExtra)) throw seamError("INVALID_LOCK_OWNER_METADATA", "lock owner metadata must be an object");
    const reserved = Object.keys(ownerExtra).filter((field) => RESERVED_OWNER_FIELDS.has(field));
    if (reserved.length) throw seamError("RESERVED_LOCK_OWNER_METADATA", `lock owner metadata cannot override reserved fields: ${reserved.sort().join(", ")}`);
    const context = Object.freeze({ lockClass, resourceId: normalizedResourceId });
    let actionStarted = false;
    let actionCompleted = false;
    let actionResult;
    let actionFailure = null;
    let releaseFailure = null;
    let acquireFailure = null;
    let acquireFailureState = null;
    try {
      actionResult = withOwnedDirectoryLock(lockPath, () => {
        PROCESS_LOCK_STACK.push(context);
        try {
          actionStarted = true;
          const value = synchronousResult(action(), "lock action");
          actionResult = value;
          actionCompleted = true;
          return value;
        } catch (cause) {
          actionFailure = cause;
          throw cause;
        } finally {
          PROCESS_LOCK_STACK.pop();
        }
      }, {
        ...configured,
        timeoutMs,
        staleMs,
        ownerExtra: { ...ownerExtra, lock_class: lockClass, resource_id: normalizedResourceId },
        onAcquireError: (error, state) => {
          acquireFailure = ownedLockFailure("LOCK_ACQUIRE_FAILED", error.message, {
            lock_class: lockClass,
            resource_id: normalizedResourceId,
            action_started: false,
            action_completed: false,
            lock_released: state?.lock_released === true,
            acquisition_cleanup: state,
          }, error);
          acquireFailureState = state;
          if (!acquireFailure.lock_released) poisonProcessLock(acquireFailure);
          try { configured.onAcquireError?.(error, state); } catch { /* acquisition truth must not be replaced by an observer failure */ }
        },
        onReleaseError: (error) => {
          releaseFailure = ownedLockFailure("LOCK_RELEASE_FAILED", error.message, {
            lock_class: lockClass,
            resource_id: normalizedResourceId,
            action_started: actionStarted,
            action_completed: actionCompleted,
            action_result: actionCompleted ? actionResult : null,
            action_error: actionFailure,
            lock_released: false,
          }, error);
          poisonProcessLock(releaseFailure);
          try { configured.onReleaseError?.(error); } catch { /* release truth must not be replaced by an observer failure */ }
        },
      });
    } catch (cause) { if (actionFailure === null) actionFailure = cause; }
    if (releaseFailure) {
      throw releaseFailure;
    }
    if (actionFailure) {
      if (!actionStarted) {
        const failure = acquireFailure ?? ownedLockFailure("LOCK_ACQUIRE_FAILED", actionFailure.message, {
          lock_class: lockClass,
          resource_id: normalizedResourceId,
          action_started: false,
          action_completed: false,
          lock_released: acquireFailureState?.lock_released ?? true,
          acquisition_cleanup: acquireFailureState,
        }, actionFailure);
        if (!failure.lock_released) poisonProcessLock(failure);
        throw failure;
      }
      throw actionFailure;
    }
    return actionResult;
  }

  const manager = { assertAllowed, withLock };
  Object.defineProperty(manager, PHYSICAL_LOCK_MANAGER, { value: true });
  return Object.freeze(manager);
}

function transactionOperation(value, name, required = false) {
  if (value === null || value === undefined) {
    if (required) throw seamError("MISSING_TRANSACTION_OPERATION", `${name} operation is required`);
    return null;
  }
  assertSynchronousCallback(value, `${name} operation`);
  return value;
}

function partialState(phase, started, completed, results) {
  return {
    phase,
    append_committed: completed.has("append") ? true : started.has("append") ? "indeterminate" : false,
    started_operations: [...started],
    completed_operations: [...completed],
    partial_results: { ...results },
  };
}

function runAuthorityTransaction({ lockManager, authorityId, outcomeId = authorityId, append, publishLocator = null, publishSnapshot = null, publishProjection = null, onPhase = null } = {}) {
  const authorityOperations = [["append", transactionOperation(append, "append", true)], ["locator", transactionOperation(publishLocator, "locator publication")], ["snapshot", transactionOperation(publishSnapshot, "snapshot publication")]];
  const projectionOperation = transactionOperation(publishProjection, "projection publication");
  const results = { append: null, locator: null, snapshot: null, projection: null };
  const started = new Set();
  const completed = new Set();
  if (onPhase !== null) assertSynchronousCallback(onPhase, "transaction phase observer");
  if (!isPhysicalLockManager(lockManager)) throw seamError("INVALID_LOCK_MANAGER", "authority transactions require a physical lockManager exposing withLock and assertAllowed");
  if (!validResourceId(authorityId) || projectionOperation !== null && !validResourceId(outcomeId)) throw seamError("INVALID_TRANSACTION_RESOURCE", "authority transactions require authority and outcome resource ids");
  if (projectionOperation !== null) {
    try { lockManager.assertAllowed("outcome"); }
    catch (cause) {
      throw transactionFailure("TRANSACTION_LOCK_FAILED", cause?.message ?? String(cause), partialState("outcome_lock_preflight", started, completed, results), cause);
    }
  }
  const observe = (phase) => {
    if (onPhase === null) return;
    try { synchronousResult(onPhase(phase), "transaction phase observer"); }
    catch (cause) { throw transactionFailure("TRANSACTION_PHASE_FAILED", `transaction stopped at ${phase}: ${cause?.message ?? cause}`, partialState(phase, started, completed, results), cause); }
  };
  const execute = (name, callback) => {
    const phaseName = name === "locator" ? "locator_publish" : name === "snapshot" ? "snapshot_publish" : name === "projection" ? "projection_publish" : name;
    observe(`before_${phaseName}`);
    started.add(name);
    try { results[name] = synchronousResult(callback(Object.freeze({ ...results })), `${name} operation`); }
    catch (cause) {
      throw transactionFailure("TRANSACTION_OPERATION_FAILED", cause?.message ?? String(cause), partialState(`${name}_operation`, started, completed, results), cause);
    }
    completed.add(name);
    observe(`after_${phaseName}`);
  };
  const runLocked = (lockClass, resourceId, action) => {
    try { return lockManager.withLock(lockClass, resourceId, action); }
    catch (cause) {
      if (isOwnedTransactionFailure(cause)) throw cause;
      const phase = isOwnedLockFailure(cause, "LOCK_RELEASE_FAILED")
        ? `${lockClass}_lock_release`
        : isOwnedLockFailure(cause, "LOCK_ACQUIRE_FAILED")
          ? `${lockClass}_lock_acquire`
          : `${lockClass}_lock_preflight`;
      throw transactionFailure("TRANSACTION_LOCK_FAILED", cause?.message ?? String(cause), partialState(phase, started, completed, results), cause);
    }
  };
  const authorityAction = () => { for (const [name, callback] of authorityOperations) if (callback !== null) execute(name, callback); };
  runLocked("authority", authorityId, authorityAction);
  if (projectionOperation !== null) {
    runLocked("outcome", outcomeId, () => execute("projection", projectionOperation));
  }
  return results;
}

function runAuthorityTransactionsSequential({ lockManager, operationId, authorityIds, action } = {}) {
  if (!isPhysicalLockManager(lockManager)) throw seamError("INVALID_LOCK_MANAGER", "multi-authority work requires a createLockManager physical lock manager");
  if (!validResourceId(operationId)) throw seamError("INVALID_OPERATION_ID", "multi-authority work requires a shared operation id");
  if (!Array.isArray(authorityIds)) throw seamError("INVALID_AUTHORITY_LIST", "authority ids must be an array");
  assertSynchronousCallback(action, "authority action");
  const normalizedOperationId = operationId.trim();
  const normalizedAuthorityIds = authorityIds.map((authorityId) => {
    if (!validResourceId(authorityId)) throw seamError("INVALID_LOCK_RESOURCE", "every authority id must be a non-empty string");
    return authorityId.trim();
  });
  if (new Set(normalizedAuthorityIds).size !== normalizedAuthorityIds.length) throw seamError("DUPLICATE_AUTHORITY_ID", "authority ids must be unique after normalization");
  const completed = [];
  const results = [];
  for (const authorityId of normalizedAuthorityIds) {
    try {
      results.push(lockManager.withLock("authority", authorityId, () => action(Object.freeze({ operationId: normalizedOperationId, authorityId }))));
      completed.push(authorityId);
    } catch (cause) {
      const actionCompleted = isOwnedLockFailure(cause, "LOCK_RELEASE_FAILED") && cause.action_completed === true;
      if (actionCompleted) { completed.push(authorityId); results.push(cause.action_result); }
      const receipt = {
        operation_id: normalizedOperationId,
        atomic: false,
        completed: [...completed],
        failed_authority_id: authorityId,
        failed_action_state: actionCompleted ? "completed" : isOwnedLockFailure(cause, "LOCK_ACQUIRE_FAILED") ? "not_started" : "indeterminate",
        failed_lock_released: isOwnedLockFailure(cause) ? cause.lock_released === true : true,
        results: [...results],
      };
      throw seamError("AUTHORITY_SEQUENCE_PARTIAL", `non-atomic authority sequence failed at ${authorityId}`, { receipt }, cause);
    }
  }
  return { operation_id: normalizedOperationId, atomic: false, completed, results };
}

export { AUTHORITY_TRANSACTION_PHASES, createLockManager, runAuthorityTransaction, runAuthorityTransactionsSequential };
