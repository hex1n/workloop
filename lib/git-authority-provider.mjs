// Current-format Git common authority provider.
//
// The module owns Git containment, the replayable authority journal, the
// attachment locator, and disposable projections. Transaction and lock
// mechanics are injected by the application assembly so this remains a leaf.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS, canonicalJson, compareCodeUnits, foldCasePath, hasExactKeys, isPlainObject, sha256Hex } from "./prims.mjs";

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
  const gitCommonDir = gitQuery(cwd, "--git-common-dir");
  const gitDir = gitQuery(cwd, "--git-dir");
  if ([gitCommonDir, gitDir].filter(Boolean).some((control) => pathInside(control, requested))) {
    throw providerError("CONTROL_TARGET", "Git and Workloop control paths cannot be task targets");
  }
  const worktreeRoot = gitQuery(cwd, "--show-toplevel");
  if (!worktreeRoot || !gitCommonDir || !gitDir || !pathInside(worktreeRoot, requested)) {
    throw providerError("GIT_TARGET_REQUIRED", "target is not contained by a Git worktree");
  }
  const controls = [path.join(worktreeRoot, ".git"), path.join(worktreeRoot, ".workloop")];
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

function currentClaimCompare(left, right) {
  return compareCodeUnits(left.path, right.path) || compareCodeUnits(left.kind, right.kind);
}

function canonicalClaimPath(discovery, value, kind) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  const portable = raw.replace(/^(?:\.\/)+/u, "").replace(/\/$/u, "");
  const normalized = path.posix.normalize(portable || ".");
  const rootParts = raw.split("/");
  const repositoryRoot = kind === "root" && !path.posix.isAbsolute(raw) && rootParts.some((part) => part === ".") && rootParts.every((part) => part === "." || part === "");
  const lexicalParts = normalized.split("/");
  if (!raw || (!repositoryRoot && (normalized === "." || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || /[*?[\]{}]/u.test(normalized) || lexicalParts.some((part) => !part || part === "." || part === "..") || new Set([".git", ".workloop"]).has(lexicalParts[0])))) {
    throw providerError("INVALID_WRITE_CLAIM", "write claims must be structured repository-relative paths outside control roots");
  }
  const canonical = canonicalTarget(path.resolve(discovery.worktree_root, normalized));
  if (!canonical || !pathInside(discovery.worktree_root, canonical.requested)) {
    throw providerError("INVALID_WRITE_CLAIM", "write claims must resolve inside the selected Git worktree");
  }
  const relative = path.relative(discovery.worktree_root, canonical.requested).replaceAll("\\", "/");
  const canonicalParts = relative.split("/");
  if ((relative === "" && !repositoryRoot) || (repositoryRoot && relative !== "") || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative) || new Set([".git", ".workloop"]).has(canonicalParts[0])) {
    throw providerError("INVALID_WRITE_CLAIM", "write claims must resolve outside Git and Workloop control roots");
  }
  return Object.freeze({ kind, path: repositoryRoot ? "." : foldCasePath(relative) });
}

function claimContains(claim, target) {
  if (claim.kind === "path") return claim.path === target;
  if (claim.path === ".") return true;
  return claim.path === target || target.startsWith(`${claim.path}/`);
}

function claimsOverlap(left, right) {
  if (left.kind === "path" && right.kind === "path") return left.path === right.path;
  if (left.kind === "root" && right.kind === "root") return claimContains(left, right.path) || claimContains(right, left.path);
  if (left.kind === "root") return claimContains(left, right.path);
  return claimContains(right, left.path);
}

function canonicalWriteClaims(discovery, writePaths, writeRoots) {
  const claims = [
    ...(Array.isArray(writePaths) ? writePaths : []).map((value) => canonicalClaimPath(discovery, value, "path")),
    ...(Array.isArray(writeRoots) ? writeRoots : []).map((value) => canonicalClaimPath(discovery, value, "root")),
  ];
  if (!claims.length) throw providerError("INVALID_WRITE_CLAIM", "current task requires at least one --write-path or --write-root");
  const unique = [...new Map(claims.map((claim) => [`${claim.kind}:${claim.path}`, claim])).values()]
    .sort(currentClaimCompare);
  for (let index = 0; index < unique.length; index += 1) {
    for (let peer = index + 1; peer < unique.length; peer += 1) {
      if (claimsOverlap(unique[index], unique[peer])) throw providerError("REDUNDANT_WRITE_CLAIM", "one task cannot declare overlapping write claims");
    }
  }
  return unique;
}

function targetRelative(discovery, target) {
  const relative = path.relative(discovery.worktree_root, path.resolve(target)).replaceAll("\\", "/");
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) throw providerError("TARGET_SCOPE_UNAVAILABLE", "target is outside the selected Git worktree");
  return relative === "" ? "." : foldCasePath(relative);
}

function taskIntentMatchesInput(intent, input, attachmentId) {
  return intent.attachment_id === attachmentId && intent.goal === input.goal &&
    canonicalJson(intent.write_claims) === canonicalJson(input.writeClaims) &&
    intent.placement === "partitioned" &&
    intent.coordinator_session_id === input.sessionId &&
    canonicalJson(intent.participant_session_ids) === canonicalJson([input.sessionId]);
}

function openContext(discovery, input, authorityId, stageIntent, attachment, taskIntentRecord) {
  const taskIntent = taskIntentRecord.payload;
  let staged = null;
  let claimed = null;
  if (stageIntent) {
    staged = locatorRecord({ sequence: 1, previousDigest: null, state: "staged", authorityId: stageIntent.payload.authority_id, attachmentId: stageIntent.payload.attachment_id, claimToken: stageIntent.payload.claim_token, claimEpoch: stageIntent.payload.claim_epoch, anchorId: stageIntent.payload.anchor_id, worktreeRoot: stageIntent.payload.worktree_root, gitDir: stageIntent.payload.git_dir });
    claimed = locatorRecord({ sequence: 2, previousDigest: staged.record_digest, state: "claimed", authorityId: stageIntent.payload.authority_id, attachmentId: stageIntent.payload.attachment_id, claimToken: stageIntent.payload.claim_token, claimEpoch: stageIntent.payload.claim_epoch, anchorId: stageIntent.payload.anchor_id, worktreeRoot: stageIntent.payload.worktree_root, gitDir: stageIntent.payload.git_dir });
    if (staged.record_digest !== stageIntent.payload.staged_locator_digest || claimed.record_digest !== stageIntent.payload.claimed_locator_digest) throw providerError("AUTHORITY_CORRUPT", "stage intent locator preimages do not match their digests");
    if (stageIntent.payload.anchor_id !== discovery.anchor_id || stageIntent.payload.granted_by !== input.grantedBy || stageIntent.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "attachment stage command conflicts with its durable input");
  }
  if (!taskIntentMatchesInput(taskIntent, input, attachment.attachment_id)) throw providerError("COMMAND_CONFLICT", "task open command conflicts with its durable intent");
  return Object.freeze({ authorityId, attachmentId: attachment.attachment_id, taskId: taskIntent.task_id, openIntentDigest: taskIntentRecord.record_digest, stageIntentDigest: stageIntent?.record_digest ?? null, attachment, staged, claimed });
}

function assertClaimedLocator(discovery, state, attachment) {
  let locator;
  try { locator = readLocator(discovery).at(-1) ?? null; }
  catch (error) { throw providerError("RECOVERY_REQUIRED", "current attachment locator is unreadable", {}, error); }
  const matches = locator?.state === "claimed" && locator.record_digest === attachment.claimed_locator_digest && locator.authority_id === state.authority_id && locator.attachment_id === attachment.attachment_id && locator.claim_epoch === attachment.claim_epoch && locator.anchor_id === attachment.anchor_id;
  if (!matches) throw providerError("RECOVERY_REQUIRED", "current attachment claim is not provable");
}

function prepareOpen(discovery, input, evolveAllCurrentAuthority) {
  const records = readAuthority(discovery, evolveAllCurrentAuthority);
  let state = evolveAllCurrentAuthority(null, records);
  if (state === null) {
    appendAuthorityRecord(discovery, records, { commandId: "authority:genesis", kind: "authority_genesis", payload: { authority_id: randomUUID(), provider: "git_common" } }, evolveAllCurrentAuthority);
    state = evolveAllCurrentAuthority(null, records);
  }

  const existingOpen = findCommand(records, input.commandId);
  if (existingOpen) {
    if (existingOpen.kind !== "task_opened") throw providerError("COMMAND_CONFLICT", "open command id is already used by another authority event");
    const intent = state.task_intents.find((item) => item.task_id === existingOpen.payload.task_id) ?? null;
    const attachment = state.attachments.find((item) => item.attachment_id === existingOpen.payload.attachment_id) ?? null;
    const intentRecord = intent ? findCommand(records, intent.command_id) : null;
    if (!intent || !attachment || !intentRecord || !taskIntentMatchesInput(intent, input, attachment.attachment_id)) throw providerError("COMMAND_CONFLICT", "completed task open conflicts with its replay input");
    assertClaimedLocator(discovery, state, attachment);
    return openContext(discovery, input, state.authority_id, null, attachment, intentRecord);
  }

  if (state.task_intents.some((item) => item.status === "pending" && item.command_id !== `${input.commandId}:task-intent`)) {
    throw providerError("TASK_OPEN_PENDING", "another task open intent is pending; retry that exact command id or use explicit recovery");
  }

  const stageCommand = `${input.commandId}:attachment-stage`;
  let stageIntent = findCommand(records, stageCommand);
  let attachment = state.attachments.find((item) => item.anchor_id === discovery.anchor_id) ?? null;
  if (!attachment) {
    if (state.attachments.some((item) => item.lifecycle !== "claimed")) throw providerError("ATTACHMENT_PENDING", "another attachment command is pending; retry that exact command id or use explicit recovery");
    const attachmentId = randomUUID();
    const claimToken = randomUUID();
    const claimEpoch = 1;
    const staged = locatorRecord({ sequence: 1, previousDigest: null, state: "staged", authorityId: state.authority_id, attachmentId, claimToken, claimEpoch, anchorId: discovery.anchor_id, worktreeRoot: discovery.worktree_root, gitDir: discovery.git_dir });
    const claimed = locatorRecord({ sequence: 2, previousDigest: staged.record_digest, state: "claimed", authorityId: state.authority_id, attachmentId, claimToken, claimEpoch, anchorId: discovery.anchor_id, worktreeRoot: discovery.worktree_root, gitDir: discovery.git_dir });
    stageIntent = appendAuthorityRecord(discovery, records, { commandId: stageCommand, kind: "attachment_stage_intent", payload: { authority_id: state.authority_id, attachment_id: attachmentId, claim_token: claimToken, claim_epoch: claimEpoch, anchor_id: discovery.anchor_id, staged_locator_digest: staged.record_digest, claimed_locator_digest: claimed.record_digest, worktree_root: discovery.worktree_root, git_dir: discovery.git_dir, granted_by: input.grantedBy, reason: input.reason } }, evolveAllCurrentAuthority);
    state = evolveAllCurrentAuthority(null, records);
    attachment = state.attachments.find((item) => item.attachment_id === attachmentId) ?? null;
  } else if (attachment.lifecycle === "claimed") {
    assertClaimedLocator(discovery, state, attachment);
    stageIntent = null;
  } else {
    if (!stageIntent || attachment.stage_command_id !== stageCommand) throw providerError("RECOVERY_REQUIRED", "the current Git attachment has an incomplete claim owned by another command");
  }

  const intentCommand = `${input.commandId}:task-intent`;
  let taskIntentRecord = findCommand(records, intentCommand);
  if (!taskIntentRecord) {
    taskIntentRecord = appendAuthorityRecord(discovery, records, { commandId: intentCommand, kind: "task_open_intent", payload: { task_id: randomUUID(), attachment_id: attachment.attachment_id, goal: input.goal, write_claims: input.writeClaims, placement: "partitioned", coordinator_session_id: input.sessionId, participant_session_ids: [input.sessionId] } }, evolveAllCurrentAuthority);
  }
  state = evolveAllCurrentAuthority(null, records);
  attachment = state.attachments.find((item) => item.attachment_id === attachment.attachment_id);
  return openContext(discovery, input, state.authority_id, stageIntent, attachment, taskIntentRecord);
}

function publishLocatorAndTask(discovery, input, context, evolveAllCurrentAuthority) {
  let finalDigest = context.attachment.final_record_digest;
  if (context.attachment.lifecycle !== "claimed") {
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
    const stagedReceipt = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:attachment-staged`, kind: "attachment_staged", payload: { authority_id: context.authorityId, attachment_id: context.attachmentId, stage_intent_digest: context.stageIntentDigest, staged_locator_digest: context.staged.record_digest, granted_by: input.grantedBy, reason: input.reason } }, evolveAllCurrentAuthority);
    const pending = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:attachment-pending`, kind: "attachment_claim_pending", payload: { authority_id: context.authorityId, attachment_id: context.attachmentId, staged_receipt_digest: stagedReceipt.record_digest, claimed_locator_digest: context.claimed.record_digest } }, evolveAllCurrentAuthority);

    if (locator.length === 1) appendDurably(target, Buffer.from(`${canonicalJson(context.claimed)}\n`));
    else if (locator.length !== 2 || locator[1]?.record_digest !== context.claimed.record_digest) throw providerError("LOCATOR_CONFLICT", "existing locator does not finalize this attachment claim");
    const verified = readLocator(discovery);
    if (verified.length !== 2 || verified[1].record_digest !== context.claimed.record_digest) throw providerError("LOCATOR_CONFLICT", "claimed locator reread did not match the staged intent");

    const final = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:attachment-final`, kind: "attachment_claimed", payload: { authority_id: context.authorityId, attachment_id: context.attachmentId, pending_record_digest: pending.record_digest, locator_digest: context.claimed.record_digest } }, evolveAllCurrentAuthority);
    finalDigest = final.record_digest;
  }

  const records = readAuthority(discovery, evolveAllCurrentAuthority);
  const task = appendAuthorityRecord(discovery, records, { commandId: input.commandId, kind: "task_opened", payload: { task_id: context.taskId, attachment_id: context.attachmentId, open_intent_digest: context.openIntentDigest, attachment_final_digest: finalDigest } }, evolveAllCurrentAuthority);
  return { final_digest: finalDigest, task_digest: task.record_digest };
}

function observedWorktreeRoot(attachment) {
  const pointerPath = path.join(attachment.git_dir, "gitdir");
  let pointer;
  try { pointer = fs.readFileSync(pointerPath, "utf8").trim(); }
  catch (error) { if (error?.code === "ENOENT") return fs.realpathSync.native(attachment.worktree_root); throw error; }
  if (!pointer) throw providerError("WORKTREE_POINTER_INVALID", "linked-worktree admin directory has an empty gitdir pointer");
  const gitFile = path.resolve(attachment.git_dir, pointer);
  const observed = fs.realpathSync.native(path.dirname(gitFile));
  const backlink = fs.readFileSync(gitFile, "utf8").trim();
  if (!backlink.toLowerCase().startsWith("gitdir:")) throw providerError("WORKTREE_POINTER_INVALID", "linked worktree has no Git administration backlink");
  const linkedAdmin = fs.realpathSync.native(path.resolve(observed, backlink.slice(7).trim()));
  const expectedAdmin = fs.realpathSync.native(attachment.git_dir);
  if (path.relative(expectedAdmin, linkedAdmin) !== "") throw providerError("WORKTREE_POINTER_INVALID", "linked worktree backlink does not match its authority attachment");
  return observed;
}

function unavailableAttachmentView(attachment, unavailableReason) {
  return { attachment_id: attachment.attachment_id, lifecycle: attachment.lifecycle, availability: "unavailable", unavailable_reason: unavailableReason, claimed_worktree_root: attachment.worktree_root, observed_worktree_root: null, path_status: "unavailable" };
}

function observeAttachment(attachment, authorityId, currentDiscovery = null) {
  const currentAnchor = currentDiscovery?.anchor_id === attachment.anchor_id ? currentDiscovery : null;
  const observedGitDir = currentAnchor?.git_dir ?? attachment.git_dir;
  let observedAnchor;
  try { observedAnchor = stableDirectoryAnchor(observedGitDir); }
  catch (error) { return unavailableAttachmentView(attachment, error?.code === "ENOENT" ? "git_admin_unavailable" : "git_admin_unreadable"); }
  if (observedAnchor !== attachment.anchor_id) return unavailableAttachmentView(attachment, "anchor_mismatch");
  let locator;
  try { locator = readLocator({ attachment_root: observedGitDir }).at(-1) ?? null; }
  catch { return unavailableAttachmentView(attachment, "locator_unreadable"); }
  const locatorMatches = locator?.state === "claimed" && locator.record_digest === attachment.claimed_locator_digest && locator.authority_id === authorityId && locator.attachment_id === attachment.attachment_id && locator.claim_epoch === attachment.claim_epoch && locator.anchor_id === attachment.anchor_id;
  if (!locatorMatches) return unavailableAttachmentView(attachment, "locator_unavailable");
  let observed;
  try { observed = currentAnchor?.worktree_root ?? observedWorktreeRoot(attachment); }
  catch { return unavailableAttachmentView(attachment, "worktree_unavailable"); }
  return { attachment_id: attachment.attachment_id, lifecycle: attachment.lifecycle, availability: "available", unavailable_reason: null, claimed_worktree_root: attachment.worktree_root, observed_worktree_root: observed, path_status: path.relative(attachment.worktree_root, observed) === "" ? "unchanged" : "moved" };
}

function selectCurrentTask(state, attachment, discovery, { taskId = null, sessionId = null } = {}) {
  if (!state || !attachment) return { task: null, reason: "attachment_uninitialized" };
  const tasks = state.tasks.filter((item) => item.attachment_id === attachment.attachment_id);
  if (taskId) {
    const task = state.tasks.find((item) => item.task_id === taskId) ?? null;
    if (!task) return { task: null, reason: "task_unavailable" };
    if (task.attachment_id !== attachment.attachment_id) return { task: null, reason: "task_attachment_mismatch" };
    const relative = targetRelative(discovery, discovery.target);
    if (!task.write_claims.some((claim) => claimContains(claim, relative))) return { task, reason: "task_scope_unclaimed" };
    if (sessionId && !task.participant_session_ids.includes(sessionId)) return { task, reason: "session_task_mismatch" };
    if (task.lifecycle.state !== "active") return { task, reason: task.lifecycle.state === "suspended" ? "task_suspended" : "task_terminal" };
    return { task, reason: null };
  }

  const relative = targetRelative(discovery, discovery.target);
  let candidates = tasks.filter((task) => task.lifecycle.state === "active" && task.write_claims.some((claim) => claimContains(claim, relative)));
  if (sessionId) {
    const sessionTasks = candidates.filter((task) => task.participant_session_ids.includes(sessionId));
    if (!sessionTasks.length && candidates.length) return { task: null, reason: "session_task_mismatch" };
    candidates = sessionTasks;
  }
  if (candidates.length === 1) return { task: candidates[0], reason: null };
  return { task: null, reason: !candidates.length ? "task_scope_unclaimed" : "task_unselected" };
}

function project(discovery, evolveAllCurrentAuthority, suppliedRecords = null, selection = {}) {
  const records = suppliedRecords ?? readAuthority(discovery, evolveAllCurrentAuthority);
  const state = evolveAllCurrentAuthority(null, records);
  const repositoryAttachments = state ? state.attachments.map((item) => observeAttachment(item, state.authority_id, discovery)) : [];
  const repositoryTasks = state ? state.tasks.map((task) => {
    const attachment = repositoryAttachments.find((item) => item.attachment_id === task.attachment_id) ?? null;
    return { ...(attachment ?? unavailableAttachmentView({ attachment_id: task.attachment_id, lifecycle: "unknown", worktree_root: null }, "attachment_unavailable")), task };
  }) : [];
  let currentLocator = null;
  try { currentLocator = readLocator(discovery).at(-1) ?? null; } catch { currentLocator = null; }
  let attachment = currentLocator && state ? state.attachments.find((item) => item.attachment_id === currentLocator.attachment_id) ?? null : null;
  if (!attachment && state) attachment = state.attachments.find((item) => item.anchor_id === discovery.anchor_id) ?? null;
  const attachmentView = attachment ? repositoryAttachments.find((item) => item.attachment_id === attachment.attachment_id) ?? null : null;
  const selected = selectCurrentTask(state, attachment, discovery, selection);
  const task = selected.task;
  const locatorMatches = Boolean(attachment && currentLocator?.state === "claimed" && currentLocator.record_digest === attachment.claimed_locator_digest && currentLocator.authority_id === state.authority_id && currentLocator.attachment_id === attachment.attachment_id && currentLocator.claim_epoch === attachment.claim_epoch && currentLocator.anchor_id === attachment.anchor_id);
  const anchorMatches = Boolean(attachment && attachment.anchor_id === discovery.anchor_id);
  const attachmentRoutable = Boolean(state && attachment?.lifecycle === "claimed" && anchorMatches && locatorMatches);
  const routable = Boolean(attachmentRoutable && task?.lifecycle.state === "active" && selected.reason === null && task.attachment_final_digest === attachment.final_record_digest);
  const reason = routable ? null : !state ? "authority_uninitialized" : !attachment ? "attachment_uninitialized" : attachment.lifecycle !== "claimed" ? "attachment_pending" : !anchorMatches ? "anchor_mismatch" : !locatorMatches ? "locator_unavailable" : selected.reason ?? "authority_inconsistent";
  return { provider: "git_common", authority_id: state?.authority_id ?? null, attachment_id: attachment?.attachment_id ?? null, placement: task?.placement ?? "partitioned", routable, routing_reason: reason, authority_sequence: records.length, attachment: attachmentView, task, repository_attachments: repositoryAttachments, repository_tasks: repositoryTasks };
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
  return { outcome_schema_version: OUTCOME_SCHEMA_VERSION, authority_id: value.authority_id, source_sequence: value.authority_sequence, tasks: value.repository_tasks.filter((item) => item.task).map((item) => ({ ...item.task, attachment_availability: item.availability, attachment_path_status: item.path_status })) };
}

function writeCurrentSnapshot(discovery, value) { writeProjection(snapshotPath(discovery), snapshotValue(value)); }
function writeCurrentOutcome(discovery, value) { writeProjection(outcomePath(discovery, value.authority_id ?? "uninitialized"), outcomeValue(value)); }

function boundedOpenInput(input, discovery) {
  if (!nonempty(input?.goal) || input.goal.trim().length > 4096 || !nonempty(input?.commandId) || input.commandId.trim().length > 256) throw providerError("INVALID_OPEN", "current open requires bounded goal and explicit command id");
  if (!new Set(["self", "user"]).has(input?.grantedBy) || !nonempty(input?.reason) || input.reason.trim().length > 2048) throw providerError("INVALID_PROVENANCE", "current open requires --granted-by self|user and a bounded reason");
  if (!nonempty(input?.sessionId) || input.sessionId.trim() === "cli") throw providerError("HOST_SESSION_REQUIRED", "current open requires a real host session identity");
  const writeClaims = canonicalWriteClaims(discovery, input.writePaths, input.writeRoots);
  if (writeClaims.length > 64 || writeClaims.some((claim) => claim.path.length > 512)) throw providerError("INVALID_WRITE_CLAIM", "current task write claims exceed the bounded open contract");
  const openRelative = targetRelative(discovery, discovery.target);
  if (!writeClaims.some((claim) => claimContains(claim, openRelative))) throw providerError("INVALID_OPEN_TARGET", "current open target is outside its canonical write claims");
  return { ...input, goal: input.goal.trim(), commandId: input.commandId.trim(), writeClaims, sessionId: input.sessionId.trim(), grantedBy: input.grantedBy, reason: input.reason.trim() };
}

function openCurrentGitTask(input, { createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority }) {
  const discovery = resolveGitAuthorityTarget(input.target);
  const normalized = boundedOpenInput(input, discovery);
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
    lockManager.withLock("authority", discovery.authority_root, () => { committed = project(discovery, evolveAllCurrentAuthority, null, { sessionId: normalized.sessionId }); });
    if (!committed?.routable) throw cause;
    warnings.push(`snapshot projection deferred: ${cause.cause?.message ?? cause.message}`);
  }
  let value;
  lockManager.withLock("authority", discovery.authority_root, () => { value = project(discovery, evolveAllCurrentAuthority, null, { sessionId: normalized.sessionId }); });
  if (!value.routable) throw providerError("OPEN_NOT_ROUTABLE", `current task open is not routable: ${value.routing_reason}`);
  try { lockManager.withLock("outcome", discovery.git_common_dir, () => writeCurrentOutcome(discovery, value)); }
  catch (cause) { warnings.push(`outcome projection deferred: ${cause.message}`); }
  return { ...value, warnings, ...storageFields(discovery, value.authority_id) };
}

function queryCurrentGit(target, kind = "status", { createLockManager, evolveAllCurrentAuthority }, selection = {}) {
  const discovery = resolveGitAuthorityTarget(target);
  const lockManager = lockManagerFor(discovery, createLockManager);
  const warnings = [];
  let records;
  let value;
  lockManager.withLock("authority", discovery.authority_root, () => {
    records = readAuthority(discovery, evolveAllCurrentAuthority);
    value = project(discovery, evolveAllCurrentAuthority, records, selection);
    if (kind !== "ledger") {
      try { writeCurrentSnapshot(discovery, value); }
      catch (cause) { warnings.push(`snapshot projection deferred: ${cause.message}`); }
    }
  });
  if (kind === "ledger") return { provider: "git_common", authority_id: value.authority_id, authority_sequence: value.authority_sequence, records, warnings, ...storageFields(discovery, value.authority_id) };
  try { lockManager.withLock("outcome", discovery.git_common_dir, () => writeCurrentOutcome(discovery, value)); }
  catch (cause) { warnings.push(`outcome projection deferred: ${cause.message}`); }
  if (kind === "audit") return { integrity: value.routable ? "valid" : value.routing_reason === "attachment_pending" ? "pending" : "invalid", ...value, warnings, ...storageFields(discovery, value.authority_id) };
  if (kind === "tasks") return { provider: value.provider, authority_id: value.authority_id, authority_sequence: value.authority_sequence, repository_attachments: value.repository_attachments, repository_tasks: value.repository_tasks, warnings, ...storageFields(discovery, value.authority_id) };
  return { ...value, warnings, ...storageFields(discovery, value.authority_id) };
}

function boundedTaskMutation(input) {
  if (!nonempty(input?.target) || !nonempty(input?.taskId) || !nonempty(input?.commandId) || input.commandId.trim().length > 256) throw providerError("INVALID_TASK_MUTATION", "current task mutation requires target, task id, and bounded command id");
  if (!new Set(["join", "suspend", "resume", "abandon"]).has(input.action)) throw providerError("INVALID_TASK_MUTATION", "unsupported current task mutation");
  if (!new Set(["self", "user"]).has(input.grantedBy) || !nonempty(input.reason) || input.reason.trim().length > 2048) throw providerError("INVALID_PROVENANCE", "current task mutation requires --granted-by self|user and a bounded reason");
  const sessionId = nonempty(input.sessionId) ? input.sessionId.trim() : "cli";
  if (sessionId === "cli") throw providerError("INVALID_TASK_MUTATION", "current task mutation requires a real host session identity");
  return { ...input, taskId: input.taskId.trim(), commandId: input.commandId.trim(), sessionId, reason: input.reason.trim() };
}

function mutateCurrentGitTask(input, { createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority }) {
  const normalized = boundedTaskMutation(input);
  const discovery = resolveGitAuthorityTarget(normalized.target);
  const lockManager = lockManagerFor(discovery, createLockManager);
  const warnings = [];
  const kind = { join: "task_joined", suspend: "task_suspended", resume: "task_resumed", abandon: "task_terminal" }[normalized.action];
  const payload = normalized.action === "join"
    ? { task_id: normalized.taskId, session_id: normalized.sessionId, reason: normalized.reason, granted_by: normalized.grantedBy }
    : normalized.action === "abandon"
      ? { task_id: normalized.taskId, session_id: normalized.sessionId, outcome: "abandoned", reason: normalized.reason, granted_by: normalized.grantedBy }
      : { task_id: normalized.taskId, session_id: normalized.sessionId, reason: normalized.reason, granted_by: normalized.grantedBy };
  try {
    runAuthorityTransaction({
      lockManager,
      authorityId: discovery.authority_root,
      append: () => {
        const records = readAuthority(discovery, evolveAllCurrentAuthority);
        const state = evolveAllCurrentAuthority(null, records);
        const attachmentView = project(discovery, evolveAllCurrentAuthority, records);
        const task = state?.tasks.find((item) => item.task_id === normalized.taskId) ?? null;
        if (!task || task.attachment_id !== attachmentView.attachment_id || attachmentView.attachment?.availability !== "available") throw providerError("TASK_ATTACHMENT_MISMATCH", "current task mutation target does not own this task attachment");
        if (normalized.action !== "join" && !task.participant_session_ids.includes(normalized.sessionId)) throw providerError("TASK_SESSION_MISMATCH", "current task mutation requires a participant session");
        return appendAuthorityRecord(discovery, records, { commandId: normalized.commandId, kind, payload }, evolveAllCurrentAuthority);
      },
      publishSnapshot: () => { const value = project(discovery, evolveAllCurrentAuthority, null, { taskId: normalized.taskId, sessionId: normalized.sessionId }); writeCurrentSnapshot(discovery, value); return value.authority_sequence; },
    });
  } catch (cause) {
    if (cause?.phase !== "snapshot_operation" || cause?.append_committed !== true) throw cause;
    warnings.push(`snapshot projection deferred: ${cause.cause?.message ?? cause.message}`);
  }
  let value;
  lockManager.withLock("authority", discovery.authority_root, () => { value = project(discovery, evolveAllCurrentAuthority, null, { taskId: normalized.taskId, sessionId: normalized.sessionId }); });
  try { lockManager.withLock("outcome", discovery.git_common_dir, () => writeCurrentOutcome(discovery, value)); }
  catch (cause) { warnings.push(`outcome projection deferred: ${cause.message}`); }
  return { ...value, warnings, ...storageFields(discovery, value.authority_id) };
}

function recordCurrentGitHook({ target, invocation }, { createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority }) {
  const discovery = resolveGitAuthorityTarget(target);
  const lockManager = lockManagerFor(discovery, createLockManager);
  const sessionId = nonempty(invocation.sessionId) ? invocation.sessionId : "unknown";
  let before;
  lockManager.withLock("authority", discovery.authority_root, () => { before = project(discovery, evolveAllCurrentAuthority, null, { sessionId }); });
  if (!before.routable || !before.task) throw providerError("HOOK_ROUTE_UNAVAILABLE", `current task routing unavailable: ${before.routing_reason}`);
  if (!new Set(["pre_tool_use", "post_tool_use", "post_tool_use_failure"]).has(invocation.event)) return before;
  const operationId = nonempty(invocation.commandId) ? invocation.commandId : `unmatched:${randomUUID()}`;
  const kind = invocation.event === "pre_tool_use" ? "operation_intent_recorded" : "tool_completed";
  const relativeTarget = targetRelative(discovery, discovery.target);
  const commandId = `hook:${before.attachment_id}:${before.task.task_id}:${invocation.event}:${operationId}:${sha256Hex(sessionId).slice(7, 23)}:${sha256Hex(relativeTarget).slice(7, 23)}`;
  runAuthorityTransaction({
    lockManager,
    authorityId: discovery.authority_root,
    append: () => {
      const records = readAuthority(discovery, evolveAllCurrentAuthority);
      const current = project(discovery, evolveAllCurrentAuthority, records, { sessionId });
      if (!current.routable || current.task.task_id !== before.task.task_id) throw providerError("HOOK_ROUTE_STALE", "current task route changed before receipt commit");
      return appendAuthorityRecord(discovery, records, { commandId, kind, payload: {
        task_id: current.task.task_id,
        operation_id: operationId,
        session_id: sessionId,
        tool: nonempty(invocation.toolName) ? invocation.toolName : "unknown",
        target: relativeTarget,
        permission_mode: nonempty(invocation.permissionModeRaw) ? invocation.permissionModeRaw : null,
        ...(kind === "tool_completed" ? { outcome: String(invocation.completionOutcome ?? "unknown"), receipt_quality: String(invocation.receiptQuality ?? "unknown") } : {}),
      } }, evolveAllCurrentAuthority);
    },
    publishSnapshot: () => { const value = project(discovery, evolveAllCurrentAuthority, null, { sessionId }); writeCurrentSnapshot(discovery, value); },
  });
  const value = project(discovery, evolveAllCurrentAuthority, null, { sessionId });
  try { lockManager.withLock("outcome", discovery.git_common_dir, () => writeCurrentOutcome(discovery, value)); } catch { /* Hook telemetry projections degrade open */ }
  return value;
}

export { mutateCurrentGitTask, openCurrentGitTask, queryCurrentGit, recordCurrentGitHook, resolveGitAuthorityTarget };
