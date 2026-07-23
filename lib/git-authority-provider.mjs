// Current-format Git common authority provider.
//
// The module owns Git containment, the replayable authority journal, the
// attachment locator, and disposable projections. Transaction and lock
// mechanics are injected by the application assembly so this remains a leaf.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS, canonicalJson, hasExactKeys, isPlainObject, sha256Hex } from "./prims.mjs";

const AUTHORITY_SCHEMA_VERSION = 1;
const LOCATOR_SCHEMA_VERSION = 1;
const SNAPSHOT_SCHEMA_VERSION = 1;
const OUTCOME_SCHEMA_VERSION = 1;
const AUTHORITY_FILE = "authority.jsonl";
const LOCATOR_FILE = ".workloop-root.jsonl";
const SNAPSHOT_FILE = "snapshot.json";
const MAX_AUTHORITY_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;

function providerError(code, message, fields = {}, cause = undefined) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, ...fields });
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalTarget(target) {
  const requested = path.resolve(target);
  let cursor = requested;
  for (;;) {
    try {
      const stat = fs.statSync(cursor);
      const canonical = fs.realpathSync.native(cursor);
      return {
        requested: path.resolve(canonical, path.relative(cursor, requested)),
        cwd: stat.isDirectory() ? canonical : path.dirname(canonical),
      };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

function stableDirectoryAnchor(directory) {
  const real = fs.realpathSync.native(directory);
  const first = fs.statSync(real, { bigint: true });
  const second = fs.statSync(real, { bigint: true });
  const fields = [first.dev, first.ino, first.birthtimeNs, second.dev, second.ino, second.birthtimeNs];
  if (!first.isDirectory() || !second.isDirectory() || fields.some((value) => typeof value !== "bigint" || value <= 0n)) {
    throw providerError("GIT_ANCHOR_UNAVAILABLE", "Git administration directory has no stable object identity");
  }
  const firstId = `${first.dev}:${first.ino}:${first.birthtimeNs}`;
  const secondId = `${second.dev}:${second.ino}:${second.birthtimeNs}`;
  if (firstId !== secondId) throw providerError("GIT_ANCHOR_UNSTABLE", "Git administration directory identity changed during discovery");
  return sha256Hex(`${process.platform}:${firstId}`);
}

function gitQuery(cwd, argument) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", argument], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveGitAuthorityTarget(target) {
  if (!nonempty(target)) throw providerError("INVALID_TARGET", "current Git authority requires a target path");
  const canonical = canonicalTarget(target);
  if (!canonical) throw providerError("TARGET_UNAVAILABLE", `target has no available ancestor: ${path.resolve(target)}`);
  const { requested, cwd } = canonical;
  const worktreeRoot = gitQuery(cwd, "--show-toplevel");
  const gitCommonDir = gitQuery(cwd, "--git-common-dir");
  const gitDir = gitQuery(cwd, "--git-dir");
  if (!worktreeRoot || !gitCommonDir || !gitDir || !pathInside(worktreeRoot, requested)) {
    throw providerError("GIT_TARGET_REQUIRED", "target is not contained by a Git worktree");
  }
  const controls = [gitCommonDir, gitDir, path.join(worktreeRoot, ".workloop")];
  if (controls.some((control) => pathInside(control, requested))) throw providerError("CONTROL_TARGET", "Git and Workloop control paths cannot be task targets");
  return Object.freeze({
    provider: "git_common",
    target: requested,
    worktree_root: path.resolve(worktreeRoot),
    git_common_dir: path.resolve(gitCommonDir),
    git_dir: path.resolve(gitDir),
    anchor_id: stableDirectoryAnchor(gitDir),
    authority_root: path.join(path.resolve(gitCommonDir), "workloop"),
    attachment_root: path.resolve(gitDir),
  });
}

function authorityPath(discovery) { return path.join(discovery.authority_root, AUTHORITY_FILE); }
function locatorPath(discovery) { return path.join(discovery.attachment_root, LOCATOR_FILE); }
function snapshotPath(discovery) { return path.join(discovery.authority_root, SNAPSHOT_FILE); }
function outcomePath(discovery, authorityId) { return path.join(discovery.git_common_dir, "workloop-outcomes", `${authorityId}.json`); }

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function ensureParent(target) {
  const parent = path.dirname(target);
  const firstCreated = fs.mkdirSync(parent, { recursive: true });
  if (firstCreated === undefined || process.platform === "win32") return;
  let cursor = parent;
  for (;;) {
    syncDirectory(cursor);
    if (path.resolve(cursor) === path.resolve(firstCreated)) {
      syncDirectory(path.dirname(cursor));
      return;
    }
    const ancestor = path.dirname(cursor);
    if (ancestor === cursor) throw providerError("DIRECTORY_SYNC_FAILED", "created directory is outside its requested parent chain");
    cursor = ancestor;
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) throw providerError("SHORT_WRITE", "authority write made no progress");
    offset += written;
  }
}

function appendDurably(target, bytes, { exclusive = false } = {}) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!payload.length || payload.at(-1) !== 0x0a) throw providerError("INVALID_FRAME", "authority frames must end with a newline");
  if (payload.length > MAX_RECORD_BYTES) throw providerError("JOURNAL_LIMIT_EXCEEDED", "authority frame exceeds the bounded record size");
  ensureParent(target);
  const descriptor = fs.openSync(target, exclusive ? "ax" : "a", 0o600);
  try { writeAll(descriptor, payload); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  syncDirectory(path.dirname(target));
}

function writeProjection(target, value) {
  ensureParent(target);
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { writeAll(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target);
  syncDirectory(path.dirname(target));
}

function recordDigest(record) {
  const { record_digest: ignored, ...unsigned } = record;
  return sha256Hex(canonicalJson(unsigned));
}

function makeRecord({ sequence, previousDigest, commandId, kind, payload }) {
  const record = {
    authority_schema_version: AUTHORITY_SCHEMA_VERSION,
    sequence,
    previous_digest: previousDigest,
    record_id: randomUUID(),
    command_id: commandId,
    kind,
    payload,
  };
  return Object.freeze({ ...record, record_digest: recordDigest(record) });
}

function readJsonLines(target, kind, { missing = [] } = {}) {
  let bytes;
  try {
    const stat = fs.statSync(target);
    if (stat.size > MAX_AUTHORITY_BYTES) throw providerError("JOURNAL_LIMIT_EXCEEDED", `${kind} exceeds bounded replay size`);
    bytes = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw error;
  }
  if (!bytes.endsWith("\n")) throw providerError(`${kind.toUpperCase()}_TORN`, `${kind} has a torn tail`);
  return bytes.trim().split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (cause) { throw providerError(`${kind.toUpperCase()}_CORRUPT`, `${kind} record ${index + 1} is invalid JSON`, {}, cause); }
  });
}

function validateAuthorityRecords(records, evolveAllCurrentAuthority) {
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const payloadFields = CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS[record?.kind];
    if (!isPlainObject(record) || !hasExactKeys(record, ["authority_schema_version", "sequence", "previous_digest", "record_id", "command_id", "kind", "payload", "record_digest"]) ||
        !payloadFields || !isPlainObject(record.payload) || !hasExactKeys(record.payload, payloadFields) ||
        record.authority_schema_version !== AUTHORITY_SCHEMA_VERSION || record.sequence !== index + 1 || record.previous_digest !== previous || record.record_digest !== recordDigest(record)) {
      throw providerError("AUTHORITY_CORRUPT", `authority record ${index + 1} violates the persisted-record contract`);
    }
    previous = record.record_digest;
  }
  evolveAllCurrentAuthority(null, records);
  return records;
}

function readAuthority(discovery, evolveAllCurrentAuthority) {
  return validateAuthorityRecords(readJsonLines(authorityPath(discovery), "authority"), evolveAllCurrentAuthority);
}

function findCommand(records, commandId) {
  return records.find((record) => record.command_id === commandId) ?? null;
}

function appendAuthorityRecord(discovery, records, { commandId, kind, payload }, evolveAllCurrentAuthority) {
  const prior = findCommand(records, commandId);
  if (prior) {
    if (prior.kind !== kind || canonicalJson(prior.payload) !== canonicalJson(payload)) throw providerError("COMMAND_CONFLICT", `command id conflicts with authority history: ${commandId}`);
    return prior;
  }
  const record = makeRecord({ sequence: records.length + 1, previousDigest: records.at(-1)?.record_digest ?? null, commandId, kind, payload });
  validateAuthorityRecords([...records, record], evolveAllCurrentAuthority);
  const frame = Buffer.from(`${canonicalJson(record)}\n`);
  let size = 0;
  try { size = fs.statSync(authorityPath(discovery)).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (size + frame.length > MAX_AUTHORITY_BYTES) throw providerError("JOURNAL_LIMIT_EXCEEDED", "authority append exceeds bounded replay size");
  appendDurably(authorityPath(discovery), frame);
  records.push(record);
  return record;
}

function locatorRecord({ sequence, previousDigest, state, authorityId, attachmentId, claimToken, claimEpoch, anchorId, worktreeRoot, gitDir }) {
  const record = {
    locator_schema_version: LOCATOR_SCHEMA_VERSION,
    sequence,
    previous_digest: previousDigest,
    state,
    authority_id: authorityId,
    attachment_id: attachmentId,
    claim_token: claimToken,
    claim_epoch: claimEpoch,
    anchor_id: anchorId,
    worktree_root: worktreeRoot,
    git_dir: gitDir,
  };
  return Object.freeze({ ...record, record_digest: sha256Hex(canonicalJson(record)) });
}

function readLocator(discovery) {
  const records = readJsonLines(locatorPath(discovery), "locator");
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const { record_digest: ignored, ...unsigned } = record;
    if (!isPlainObject(record) || !hasExactKeys(record, ["locator_schema_version", "sequence", "previous_digest", "state", "authority_id", "attachment_id", "claim_token", "claim_epoch", "anchor_id", "worktree_root", "git_dir", "record_digest"]) || record.locator_schema_version !== LOCATOR_SCHEMA_VERSION || record.sequence !== index + 1 || record.previous_digest !== previous || !new Set(["staged", "claimed"]).has(record.state) || record.claim_epoch !== 1 || typeof record.anchor_id !== "string" || record.record_digest !== sha256Hex(canonicalJson(unsigned))) {
      throw providerError("LOCATOR_CORRUPT", `locator record ${index + 1} violates the hash-chain contract`);
    }
    previous = record.record_digest;
  }
  return records;
}

function canonicalFiles(files) {
  if (!Array.isArray(files) || !files.length) throw providerError("INVALID_TASK_FILES", "current task requires at least one file scope");
  const normalized = files.map((file) => String(file).trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "")).filter(Boolean);
  if (!normalized.length || normalized.some((file) => {
    const segments = file.split("/");
    return path.posix.isAbsolute(file) || segments.includes("..") || new Set([".git", ".workloop"]).has(segments[0]);
  })) throw providerError("INVALID_TASK_FILES", "task file scopes must be repository-relative and exclude control roots");
  return [...new Set(normalized)].sort();
}


function openContext(discovery, input, intent, attachment) {
  const staged = locatorRecord({ sequence: 1, previousDigest: null, state: "staged", authorityId: intent.payload.authority_id, attachmentId: intent.payload.attachment_id, claimToken: intent.payload.claim_token, claimEpoch: intent.payload.claim_epoch, anchorId: intent.payload.anchor_id, worktreeRoot: intent.payload.worktree_root, gitDir: intent.payload.git_dir });
  const claimed = locatorRecord({ sequence: 2, previousDigest: staged.record_digest, state: "claimed", authorityId: intent.payload.authority_id, attachmentId: intent.payload.attachment_id, claimToken: intent.payload.claim_token, claimEpoch: intent.payload.claim_epoch, anchorId: intent.payload.anchor_id, worktreeRoot: intent.payload.worktree_root, gitDir: intent.payload.git_dir });
  if (staged.record_digest !== intent.payload.staged_locator_digest || claimed.record_digest !== intent.payload.claimed_locator_digest) throw providerError("AUTHORITY_CORRUPT", "stage intent locator preimages do not match their digests");
  if (intent.payload.anchor_id !== discovery.anchor_id) throw providerError("REATTACH_REQUIRED", "Git attachment anchor no longer matches the stage intent");
  if (intent.payload.goal !== input.goal || canonicalJson(intent.payload.files) !== canonicalJson(input.files) || intent.payload.session_id !== input.sessionId || intent.payload.granted_by !== input.grantedBy || intent.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "open command conflicts with its staged input");
  return Object.freeze({ authorityId: intent.payload.authority_id, attachmentId: intent.payload.attachment_id, taskId: intent.payload.task_id, intentDigest: intent.record_digest, attachment, staged, claimed });
}

function prepareOpen(discovery, input, evolveAllCurrentAuthority) {
  const records = readAuthority(discovery, evolveAllCurrentAuthority);
  let state = evolveAllCurrentAuthority(null, records);
  if (state === null) {
    appendAuthorityRecord(discovery, records, { commandId: "authority:genesis", kind: "authority_genesis", payload: { authority_id: randomUUID(), provider: "git_common" } }, evolveAllCurrentAuthority);
    state = evolveAllCurrentAuthority(null, records);
  }
  const stageCommand = `${input.commandId}:stage-intent`;
  let intent = findCommand(records, stageCommand);
  if (!intent) {
    if (state.tasks.length) throw providerError("TASK_ALREADY_OPEN", "Ticket 03 supports one partitioned task in the attachment");
    if (state.attachments.length) throw providerError("ATTACHMENT_PENDING", "another attachment command is pending; retry that exact command id or use explicit recovery");
    const attachmentId = randomUUID();
    const taskId = randomUUID();
    const claimToken = randomUUID();
    const claimEpoch = 1;
    const staged = locatorRecord({ sequence: 1, previousDigest: null, state: "staged", authorityId: state.authority_id, attachmentId, claimToken, claimEpoch, anchorId: discovery.anchor_id, worktreeRoot: discovery.worktree_root, gitDir: discovery.git_dir });
    const claimed = locatorRecord({ sequence: 2, previousDigest: staged.record_digest, state: "claimed", authorityId: state.authority_id, attachmentId, claimToken, claimEpoch, anchorId: discovery.anchor_id, worktreeRoot: discovery.worktree_root, gitDir: discovery.git_dir });
    intent = appendAuthorityRecord(discovery, records, { commandId: stageCommand, kind: "attachment_stage_intent", payload: { authority_id: state.authority_id, attachment_id: attachmentId, task_id: taskId, claim_token: claimToken, claim_epoch: claimEpoch, anchor_id: discovery.anchor_id, staged_locator_digest: staged.record_digest, claimed_locator_digest: claimed.record_digest, goal: input.goal, files: input.files, session_id: input.sessionId, placement: "partitioned", worktree_root: discovery.worktree_root, git_dir: discovery.git_dir, granted_by: input.grantedBy, reason: input.reason } }, evolveAllCurrentAuthority);
    state = evolveAllCurrentAuthority(null, records);
  }
  const attachment = state.attachments.find((item) => item.stage_command_id === stageCommand);
  if (!attachment) throw providerError("COMMAND_CONFLICT", "open command does not own the current attachment stage");
  return openContext(discovery, input, intent, attachment);
}

function publishLocatorAndTask(discovery, input, context, evolveAllCurrentAuthority) {
  const target = locatorPath(discovery);
  let locator;
  try { locator = readLocator(discovery); }
  catch (error) {
    if (error?.code === "LOCATOR_TORN") throw providerError("RECOVERY_REQUIRED", "locator has a torn frame; explicit claim recovery is required", {}, error);
    throw providerError("LOCATOR_CONFLICT", `locator cannot continue this open: ${error.message}`, {}, error);
  }
  if (!locator.length) {
    try { appendDurably(target, Buffer.from(`${canonicalJson(context.staged)}\n`), { exclusive: true }); }
    catch (error) { throw providerError("LOCATOR_CONFLICT", `locator staging failed: ${error.message}`, {}, error); }
    locator = [context.staged];
  }
  if (locator[0]?.record_digest !== context.staged.record_digest) throw providerError("LOCATOR_CONFLICT", "existing locator is not the staged claim for this command");

  const records = readAuthority(discovery, evolveAllCurrentAuthority);
  const stagedReceipt = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:staged`, kind: "attachment_staged", payload: { authority_id: context.authorityId, attachment_id: context.attachmentId, stage_intent_digest: context.intentDigest, staged_locator_digest: context.staged.record_digest, granted_by: input.grantedBy, reason: input.reason } }, evolveAllCurrentAuthority);
  const pending = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:pending`, kind: "attachment_claim_pending", payload: { authority_id: context.authorityId, attachment_id: context.attachmentId, staged_receipt_digest: stagedReceipt.record_digest, claimed_locator_digest: context.claimed.record_digest } }, evolveAllCurrentAuthority);

  if (locator.length === 1) appendDurably(target, Buffer.from(`${canonicalJson(context.claimed)}\n`));
  else if (locator.length !== 2 || locator[1]?.record_digest !== context.claimed.record_digest) throw providerError("LOCATOR_CONFLICT", "existing locator does not finalize this attachment claim");
  const verified = readLocator(discovery);
  if (verified.length !== 2 || verified[1].record_digest !== context.claimed.record_digest) throw providerError("LOCATOR_CONFLICT", "claimed locator reread did not match the staged intent");

  const final = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:final`, kind: "attachment_claimed", payload: { authority_id: context.authorityId, attachment_id: context.attachmentId, pending_record_digest: pending.record_digest, locator_digest: context.claimed.record_digest } }, evolveAllCurrentAuthority);
  const task = appendAuthorityRecord(discovery, records, { commandId: input.commandId, kind: "task_opened", payload: { task_id: context.taskId, attachment_id: context.attachmentId, goal: input.goal, files: input.files, placement: "partitioned", session_id: input.sessionId, attachment_final_digest: final.record_digest } }, evolveAllCurrentAuthority);
  return { final_digest: final.record_digest, task_digest: task.record_digest };
}

function project(discovery, evolveAllCurrentAuthority, suppliedRecords = null) {
  const records = suppliedRecords ?? readAuthority(discovery, evolveAllCurrentAuthority);
  const state = evolveAllCurrentAuthority(null, records);
  const attachment = state?.attachments.at(-1) ?? null;
  const task = attachment ? state.tasks.find((item) => item.attachment_id === attachment.attachment_id) ?? null : null;
  let locatorMatches = false;
  if (attachment?.lifecycle === "claimed") {
    try {
      const locator = readLocator(discovery).at(-1);
      locatorMatches = locator?.state === "claimed" && locator.record_digest === attachment.claimed_locator_digest && locator.authority_id === state.authority_id && locator.attachment_id === attachment.attachment_id && locator.claim_epoch === attachment.claim_epoch && locator.anchor_id === attachment.anchor_id;
    } catch { locatorMatches = false; }
  }
  const anchorMatches = Boolean(attachment && attachment.anchor_id === discovery.anchor_id);
  const routable = Boolean(state && attachment?.lifecycle === "claimed" && task && anchorMatches && locatorMatches && task.attachment_final_digest === attachment.final_record_digest);
  const reason = routable ? null : !state ? "authority_uninitialized" : !attachment ? "attachment_uninitialized" : attachment.lifecycle !== "claimed" ? "attachment_pending" : !anchorMatches ? "anchor_mismatch" : !locatorMatches ? "locator_unavailable" : !task ? "task_not_open" : "authority_inconsistent";
  return { provider: "git_common", authority_id: state?.authority_id ?? null, attachment_id: attachment?.attachment_id ?? null, placement: task?.placement ?? attachment?.placement ?? "partitioned", routable, routing_reason: reason, authority_sequence: records.length, task };
}

function storageFields(discovery, authorityId) {
  return {
    authority_root: discovery.authority_root,
    attachment_root: discovery.attachment_root,
    locator_path: locatorPath(discovery),
    snapshot_path: snapshotPath(discovery),
    outcome_path: outcomePath(discovery, authorityId ?? "uninitialized"),
  };
}

function lockManagerFor(discovery, createLockManager) {
  return createLockManager({
    resolveLockPath: ({ lockClass, resourceId }) => path.join(
      discovery.git_common_dir,
      `.workloop-${lockClass}-${sha256Hex(resourceId).slice(7, 23)}.lock`,
    ),
    optionsForLock: () => ({ timeoutMs: 15_000, staleMs: 5_000 }),
  });
}


function snapshotValue(value) {
  return { snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION, source_sequence: value.authority_sequence, projection: value };
}

function outcomeValue(value) {
  return { outcome_schema_version: OUTCOME_SCHEMA_VERSION, authority_id: value.authority_id, source_sequence: value.authority_sequence, tasks: value.task ? [value.task] : [] };
}

function writeCurrentSnapshot(discovery, value) { writeProjection(snapshotPath(discovery), snapshotValue(value)); }
function writeCurrentOutcome(discovery, value) { writeProjection(outcomePath(discovery, value.authority_id ?? "uninitialized"), outcomeValue(value)); }

function boundedOpenInput(input) {
  if (!nonempty(input?.goal) || input.goal.trim().length > 4096 || !nonempty(input?.commandId) || input.commandId.trim().length > 256) throw providerError("INVALID_OPEN", "current open requires bounded goal and explicit command id");
  if (!new Set(["self", "user"]).has(input?.grantedBy) || !nonempty(input?.reason) || input.reason.trim().length > 2048) throw providerError("INVALID_PROVENANCE", "current open requires --granted-by self|user and a bounded reason");
  const files = canonicalFiles(input.files);
  if (files.length > 64 || files.some((file) => file.length > 512)) throw providerError("INVALID_TASK_FILES", "current task file scopes exceed the bounded open contract");
  return { ...input, goal: input.goal.trim(), commandId: input.commandId.trim(), files, sessionId: nonempty(input.sessionId) ? input.sessionId.trim() : "cli", grantedBy: input.grantedBy, reason: input.reason.trim() };
}

function openCurrentGitTask(input, { createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority }) {
  const normalized = boundedOpenInput(input);
  const discovery = resolveGitAuthorityTarget(normalized.target);
  const lockManager = lockManagerFor(discovery, createLockManager);
  const warnings = [];
  try {
    runAuthorityTransaction({
      lockManager,
      authorityId: discovery.authority_root,
      append: () => prepareOpen(discovery, normalized, evolveAllCurrentAuthority),
      publishLocator: ({ append }) => publishLocatorAndTask(discovery, normalized, append, evolveAllCurrentAuthority),
      publishSnapshot: () => { const value = project(discovery, evolveAllCurrentAuthority); writeCurrentSnapshot(discovery, value); return value.authority_sequence; },
    });
  } catch (cause) {
    if (cause?.phase !== "snapshot_operation" || cause?.append_committed !== true || !cause?.completed_operations?.includes("locator")) throw cause;
    let committed;
    lockManager.withLock("authority", discovery.authority_root, () => { committed = project(discovery, evolveAllCurrentAuthority); });
    if (!committed?.routable) throw cause;
    warnings.push(`snapshot projection deferred: ${cause.cause?.message ?? cause.message}`);
  }
  let value;
  lockManager.withLock("authority", discovery.authority_root, () => { value = project(discovery, evolveAllCurrentAuthority); });
  if (!value.routable) throw providerError("OPEN_NOT_ROUTABLE", `current task open is not routable: ${value.routing_reason}`);
  try { lockManager.withLock("outcome", discovery.git_common_dir, () => writeCurrentOutcome(discovery, value)); }
  catch (cause) { warnings.push(`outcome projection deferred: ${cause.message}`); }
  return { ...value, warnings, ...storageFields(discovery, value.authority_id) };
}

function queryCurrentGit(target, kind = "status", { createLockManager, evolveAllCurrentAuthority }) {
  const discovery = resolveGitAuthorityTarget(target);
  const lockManager = lockManagerFor(discovery, createLockManager);
  const warnings = [];
  let records;
  let value;
  lockManager.withLock("authority", discovery.authority_root, () => {
    records = readAuthority(discovery, evolveAllCurrentAuthority);
    value = project(discovery, evolveAllCurrentAuthority, records);
    if (kind !== "ledger") {
      try { writeCurrentSnapshot(discovery, value); }
      catch (cause) { warnings.push(`snapshot projection deferred: ${cause.message}`); }
    }
  });
  if (kind === "ledger") return { provider: "git_common", authority_id: value.authority_id, authority_sequence: value.authority_sequence, records, warnings, ...storageFields(discovery, value.authority_id) };
  try { lockManager.withLock("outcome", discovery.git_common_dir, () => writeCurrentOutcome(discovery, value)); }
  catch (cause) { warnings.push(`outcome projection deferred: ${cause.message}`); }
  if (kind === "audit") return { integrity: value.routable ? "valid" : value.routing_reason === "attachment_pending" ? "pending" : "invalid", ...value, warnings, ...storageFields(discovery, value.authority_id) };
  return { ...value, warnings, ...storageFields(discovery, value.authority_id) };
}

function recordCurrentGitHook({ target, invocation }, { createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority }) {
  const discovery = resolveGitAuthorityTarget(target);
  const lockManager = lockManagerFor(discovery, createLockManager);
  let before;
  lockManager.withLock("authority", discovery.authority_root, () => { before = project(discovery, evolveAllCurrentAuthority); });
  if (!before.routable || !before.task) throw providerError("HOOK_ROUTE_UNAVAILABLE", `current task routing unavailable: ${before.routing_reason}`);
  if (!new Set(["pre_tool_use", "post_tool_use", "post_tool_use_failure"]).has(invocation.event)) return before;
  const operationId = nonempty(invocation.commandId) ? invocation.commandId : `unmatched:${randomUUID()}`;
  const kind = invocation.event === "pre_tool_use" ? "operation_intent_recorded" : "tool_completed";
  const commandId = `hook:${invocation.event}:${operationId}`;
  runAuthorityTransaction({
    lockManager,
    authorityId: discovery.authority_root,
    append: () => {
      const records = readAuthority(discovery, evolveAllCurrentAuthority);
      const current = project(discovery, evolveAllCurrentAuthority, records);
      if (!current.routable || current.task.task_id !== before.task.task_id) throw providerError("HOOK_ROUTE_STALE", "current task route changed before receipt commit");
      return appendAuthorityRecord(discovery, records, { commandId, kind, payload: {
        task_id: current.task.task_id,
        operation_id: operationId,
        session_id: nonempty(invocation.sessionId) ? invocation.sessionId : "unknown",
        tool: nonempty(invocation.toolName) ? invocation.toolName : "unknown",
        target: path.relative(discovery.worktree_root, path.resolve(target)).replaceAll("\\", "/"),
        permission_mode: nonempty(invocation.permissionModeRaw) ? invocation.permissionModeRaw : null,
        ...(kind === "tool_completed" ? { outcome: String(invocation.completionOutcome ?? "unknown"), receipt_quality: String(invocation.receiptQuality ?? "unknown") } : {}),
      } }, evolveAllCurrentAuthority);
    },
    publishSnapshot: () => { const value = project(discovery, evolveAllCurrentAuthority); writeCurrentSnapshot(discovery, value); },
  });
  const value = project(discovery, evolveAllCurrentAuthority);
  try { lockManager.withLock("outcome", discovery.git_common_dir, () => writeCurrentOutcome(discovery, value)); } catch { /* Hook telemetry projections degrade open */ }
  return value;
}

export { openCurrentGitTask, queryCurrentGit, recordCurrentGitHook, resolveGitAuthorityTarget };

