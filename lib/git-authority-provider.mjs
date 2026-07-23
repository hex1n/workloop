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


function gitCommand(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status === null) throw providerError("GIT_COMMAND_UNAVAILABLE", `git ${args[0] ?? "command"} did not complete`, {}, result.error);
  if (result.status !== 0 && !allowFailure) throw providerError("GIT_COMMAND_FAILED", (result.stderr || result.stdout || `git ${args[0] ?? "command"} failed`).trim());
  return result;
}

function gitOutput(cwd, args) {
  const result = gitCommand(cwd, args);
  const output = result.stdout.trim();
  if (!output) throw providerError("GIT_COMMAND_EMPTY", `git ${args[0] ?? "command"} returned no identity`);
  return output;
}

function boundedBranch(cwd, value) {
  const branch = String(value ?? "").trim();
  if (!branch || branch.length > 240) throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive placement requires a bounded --branch");
  const checked = gitCommand(cwd, ["check-ref-format", "--branch", branch], { allowFailure: true });
  if (checked.status !== 0) throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive placement branch is not a valid Git branch name");
  return branch;
}

function taskTargetForWorktree(worktreeRoot, input) {
  const candidate = [...(input.writePaths ?? []), ...(input.writeRoots ?? [])].find((value) => nonempty(value)) ?? ".";
  return path.resolve(worktreeRoot, String(candidate));
}

function sameGitCommon(left, right) {
  return path.resolve(left.git_common_dir) === path.resolve(right.git_common_dir);
}

function observeExclusiveWorktree(discovery) {
  const result = gitCommand(discovery.worktree_root, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
  const lines = result.stdout.split(/\r?\n/u);
  const head = lines.find((line) => line.startsWith("# branch.head "))?.slice("# branch.head ".length) ?? null;
  const oid = lines.find((line) => line.startsWith("# branch.oid "))?.slice("# branch.oid ".length) ?? null;
  if (!head || head === "(detached)" || !/^[0-9a-f]{40,64}$/u.test(oid ?? "")) throw providerError("EXCLUSIVE_BRANCH_MISMATCH", "exclusive worktree must expose one symbolic branch and HEAD object");
  return { branchRef: "refs/heads/" + head, headOid: oid };
}

function verifyExclusiveWorktree(discovery, branch, baseOid, sourceDiscovery) {
  if (!sameGitCommon(discovery, sourceDiscovery)) throw providerError("EXCLUSIVE_AUTHORITY_MISMATCH", "exclusive worktree must belong to the selected Git common repository");
  if (path.resolve(discovery.git_dir) === path.resolve(discovery.git_common_dir)) throw providerError("EXCLUSIVE_LINKED_WORKTREE_REQUIRED", "exclusive placement requires a linked worktree attachment");
  const { branchRef, headOid } = observeExclusiveWorktree(discovery);
  if (branchRef !== "refs/heads/" + branch) throw providerError("EXCLUSIVE_BRANCH_MISMATCH", "exclusive worktree branch does not match --branch: " + branchRef + " vs " + branch);
  if (headOid !== baseOid) throw providerError("EXCLUSIVE_BASE_MISMATCH", "exclusive worktree HEAD does not match --base");
  return { branchRef, headOid };
}

function registeredWorktreeRoots(discovery) {
  const result = gitCommand(discovery.worktree_root, ["worktree", "list", "--porcelain", "-z"]);
  return result.stdout.split("\0").filter((line) => line.startsWith("worktree ")).map((line) => {
    const canonical = canonicalTarget(line.slice("worktree ".length));
    if (!canonical) throw providerError("GIT_WORKTREE_LIST_INVALID", "registered Git worktree has no canonical path");
    return canonical.requested;
  });
}

function assertExclusiveWorktreeBoundary(sourceDiscovery, requestedWorktree, targetDiscovery) {
  for (const root of registeredWorktreeRoots(sourceDiscovery)) {
    if (targetDiscovery && path.resolve(root) === path.resolve(targetDiscovery.worktree_root)) continue;
    if (pathInside(root, requestedWorktree) || pathInside(requestedWorktree, root)) {
      throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive worktree path cannot contain or nest inside a registered worktree");
    }
  }
  const canonical = canonicalTarget(requestedWorktree);
  const containingRoot = canonical ? gitQuery(canonical.cwd, "--show-toplevel") : null;
  const containingCommon = canonical ? gitQuery(canonical.cwd, "--git-common-dir") : null;
  if (containingRoot && pathInside(containingRoot, requestedWorktree) && (!containingCommon || path.resolve(containingCommon) !== path.resolve(sourceDiscovery.git_common_dir))) {
    throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive worktree path cannot nest inside an unrelated Git worktree");
  }
}

function exclusiveRequestDigest(input, sourceDiscovery, branch, baseOid, requestedWorktree) {
  return sha256Hex(canonicalJson({ target: sourceDiscovery.target, goal: input.goal, write_claims: input.writeClaims, placement: "exclusive_worktree", worktree_path: requestedWorktree, branch_intent: branch, base_oid: baseOid, session_id: input.sessionId, granted_by: input.grantedBy, reason: input.reason }));
}

function sameDiscoveryIdentity(left, right) {
  return sameGitCommon(left, right) && left.anchor_id === right.anchor_id && path.resolve(left.worktree_root) === path.resolve(right.worktree_root) && path.resolve(left.git_dir) === path.resolve(right.git_dir);
}

function revalidateExclusiveDiscoveries(sourceTarget, requestedWorktree, input, expectedSource, expectedTarget, branch, baseOid) {
  let source;
  let target;
  try {
    source = resolveGitAuthorityTarget(sourceTarget);
    target = resolveGitAuthorityTarget(taskTargetForWorktree(requestedWorktree, input));
  } catch (cause) {
    throw providerError("RECOVERY_REQUIRED", "exclusive worktree identity cannot be rediscovered; explicit attended recovery is required", {}, cause);
  }
  if (path.resolve(requestedWorktree) !== path.resolve(target.worktree_root) || !sameDiscoveryIdentity(source, expectedSource) || !sameDiscoveryIdentity(target, expectedTarget) || !sameGitCommon(source, target)) {
    throw providerError("RECOVERY_REQUIRED", "exclusive worktree identity changed after placement observation; explicit attended recovery is required");
  }
  return { source, target, observation: verifyExclusiveWorktree(target, branch, baseOid, source) };
}

function validateOpenMetadata(input) {
  if (!nonempty(input?.goal) || input.goal.trim().length > 4096 || !nonempty(input?.commandId) || input.commandId.trim().length > 256) throw providerError("INVALID_OPEN", "current open requires bounded goal and explicit command id");
  if (!new Set(["self", "user"]).has(input?.grantedBy) || !nonempty(input?.reason) || input.reason.trim().length > 2048) throw providerError("INVALID_PROVENANCE", "current open requires --granted-by self|user and a bounded reason");
  if (!nonempty(input?.sessionId) || input.sessionId.trim() === "cli") throw providerError("HOST_SESSION_REQUIRED", "current open requires a real host session identity");
}

function preparePlacement(input, { createLockManager, evolveAllCurrentAuthority }) {
  validateOpenMetadata(input);
  const sourceDiscovery = resolveGitAuthorityTarget(input.target);
  const sourceInput = boundedOpenInput(input, sourceDiscovery);
  const placement = String(input.placement ?? "partitioned").trim().replaceAll("-", "_");
  if (!new Set(["partitioned", "exclusive_worktree"]).has(placement)) throw providerError("INVALID_PLACEMENT", "current open placement must be partitioned or exclusive-worktree");
  if (placement === "partitioned") {
    if ([sourceInput.worktreePath, sourceInput.branch, sourceInput.base].some(nonempty)) throw providerError("INVALID_PLACEMENT", "partitioned placement does not accept worktree, branch, or base options");
    return { discovery: sourceDiscovery, sourceDiscovery, input: { ...sourceInput, placement, branchIntent: null, baseOid: null, placementIntentDigest: null, placementWorktreePath: null, placementObservation: null } };
  }

  const branch = boundedBranch(sourceDiscovery.worktree_root, sourceInput.branch);
  if (!nonempty(sourceInput.base) || sourceInput.base.trim().length > 240) throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive placement requires a bounded --base");
  const baseOid = gitOutput(sourceDiscovery.worktree_root, ["rev-parse", "--verify", sourceInput.base.trim() + "^{commit}"]);
  const requestedInput = nonempty(sourceInput.worktreePath) ? path.resolve(sourceInput.worktreePath.trim()) : sourceDiscovery.worktree_root;
  const requestedWorktree = canonicalTarget(requestedInput)?.requested ?? requestedInput;
  if (requestedWorktree === sourceDiscovery.worktree_root && nonempty(sourceInput.worktreePath)) throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "--worktree-path must name a distinct linked worktree");
  if (requestedWorktree.length > 4096) throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive worktree path is too long");
  if (nonempty(sourceInput.worktreePath) && (pathInside(sourceDiscovery.worktree_root, requestedWorktree) || pathInside(sourceDiscovery.git_common_dir, requestedWorktree) || pathInside(sourceDiscovery.authority_root, requestedWorktree))) throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive worktree path cannot nest inside the source worktree or Git control roots");

  let targetDiscovery = null;
  if (fs.existsSync(requestedWorktree)) {
    targetDiscovery = resolveGitAuthorityTarget(taskTargetForWorktree(requestedWorktree, sourceInput));
    if (path.resolve(requestedWorktree) !== path.resolve(targetDiscovery.worktree_root)) throw providerError("INVALID_EXCLUSIVE_PLACEMENT", "exclusive worktree path must name the linked worktree root");
    verifyExclusiveWorktree(targetDiscovery, branch, baseOid, sourceDiscovery);
  } else if (!nonempty(sourceInput.worktreePath)) {
    throw providerError("EXCLUSIVE_LINKED_WORKTREE_REQUIRED", "selecting exclusive placement requires a linked-worktree target or --worktree-path");
  }
  assertExclusiveWorktreeBoundary(sourceDiscovery, requestedWorktree, targetDiscovery);

  const branchProbe = gitCommand(sourceDiscovery.worktree_root, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch], { allowFailure: true });
  const branchExists = branchProbe.status === 0;
  const lockManager = lockManagerFor(sourceDiscovery, createLockManager);
  const intentCommand = sourceInput.commandId + ":exclusive-intent";
  let intentRecord;
  let priorIntent = false;
  lockManager.withLock("authority", sourceDiscovery.authority_root, () => {
    const records = readAuthority(sourceDiscovery, evolveAllCurrentAuthority);
    let state = evolveAllCurrentAuthority(null, records);
    if (state === null) {
      appendAuthorityRecord(sourceDiscovery, records, { commandId: "authority:genesis", kind: "authority_genesis", payload: { authority_id: randomUUID(), provider: "git_common" } }, evolveAllCurrentAuthority);
      state = evolveAllCurrentAuthority(null, records);
    }
    const prior = findCommand(records, intentCommand);
    priorIntent = prior !== null;
    const action = prior?.payload.action ?? (targetDiscovery ? "select" : "create");
    const payload = { authority_id: state.authority_id, action, worktree_path: requestedWorktree, branch_intent: branch, base_oid: baseOid, source_anchor_id: sourceDiscovery.anchor_id, session_id: sourceInput.sessionId, request_digest: exclusiveRequestDigest(sourceInput, sourceDiscovery, branch, baseOid, requestedWorktree), granted_by: sourceInput.grantedBy, reason: sourceInput.reason };
    intentRecord = prior;
    if (intentRecord) {
      if (intentRecord.kind !== "exclusive_worktree_intent" || canonicalJson(intentRecord.payload) !== canonicalJson(payload)) throw providerError("COMMAND_CONFLICT", "exclusive placement command conflicts with its durable intent");
      const existingReady = findCommand(records, sourceInput.commandId + ":exclusive-ready");
      if (!existingReady && action === "create") throw providerError("RECOVERY_REQUIRED", "exclusive worktree creation has a durable intent but no ready receipt; explicit attended recovery is required", { intent_digest: intentRecord.record_digest });
    } else {
      if (!targetDiscovery && branchExists) throw providerError("EXCLUSIVE_BRANCH_EXISTS", "exclusive worktree creation refuses an existing branch");
      if (state.placement_intents.some((item) => item.status === "pending")) throw providerError("EXCLUSIVE_PLACEMENT_PENDING", "another exclusive placement intent requires exact-command continuation");
      intentRecord = appendAuthorityRecord(sourceDiscovery, records, { commandId: intentCommand, kind: "exclusive_worktree_intent", payload }, evolveAllCurrentAuthority);
    }
  });

  if (!targetDiscovery) {
    if (priorIntent || intentRecord.payload.action === "select") throw providerError("RECOVERY_REQUIRED", "selected exclusive worktree is unavailable; explicit attended recovery is required", { intent_digest: intentRecord.record_digest });
    const created = gitCommand(sourceDiscovery.worktree_root, ["worktree", "add", "-q", "-b", branch, requestedWorktree, baseOid], { allowFailure: true });
    if (created.status !== 0) throw providerError("EXCLUSIVE_WORKTREE_ADD_FAILED", (created.stderr || created.stdout || "git worktree add failed").trim(), { phase: "git_worktree_add", intent_digest: intentRecord.record_digest });
    targetDiscovery = resolveGitAuthorityTarget(taskTargetForWorktree(requestedWorktree, sourceInput));
  }
  const livePlacement = revalidateExclusiveDiscoveries(sourceInput.target, requestedWorktree, sourceInput, sourceDiscovery, targetDiscovery, branch, baseOid);
  targetDiscovery = livePlacement.target;
  const verified = livePlacement.observation;

  const readyCommand = sourceInput.commandId + ":exclusive-ready";
  lockManager.withLock("authority", sourceDiscovery.authority_root, () => {
    const records = readAuthority(sourceDiscovery, evolveAllCurrentAuthority);
    const existing = findCommand(records, readyCommand);
    const payload = { intent_record_digest: intentRecord.record_digest, worktree_path: requestedWorktree, branch_ref: verified.branchRef, head_oid: verified.headOid, anchor_id: targetDiscovery.anchor_id };
    if (existing) {
      if (existing.kind !== "exclusive_worktree_ready" || canonicalJson(existing.payload) !== canonicalJson(payload)) throw providerError("COMMAND_CONFLICT", "exclusive placement ready receipt conflicts with the observed worktree");
    } else appendAuthorityRecord(sourceDiscovery, records, { commandId: readyCommand, kind: "exclusive_worktree_ready", payload }, evolveAllCurrentAuthority);
  });

  return { discovery: targetDiscovery, sourceDiscovery, input: { ...sourceInput, placement, branchIntent: branch, baseOid, placementIntentDigest: intentRecord.record_digest, placementWorktreePath: requestedWorktree, placementObservation: verified } };
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
    if (!isPlainObject(record) || !hasExactKeys(record, ["locator_schema_version", "sequence", "previous_digest", "state", "authority_id", "attachment_id", "claim_token", "claim_epoch", "anchor_id", "worktree_root", "git_dir", "record_digest"]) || record.locator_schema_version !== LOCATOR_SCHEMA_VERSION || record.sequence !== index + 1 || record.previous_digest !== previous || !new Set(["staged", "claimed"]).has(record.state) || !Number.isSafeInteger(record.claim_epoch) || record.claim_epoch < 1 || typeof record.anchor_id !== "string" || record.record_digest !== sha256Hex(canonicalJson(unsigned))) {
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
    intent.placement === input.placement &&
    intent.branch_intent === input.branchIntent &&
    intent.base_oid === input.baseOid &&
    intent.placement_intent_digest === input.placementIntentDigest &&
    intent.coordinator_session_id === input.sessionId &&
    canonicalJson(intent.participant_session_ids) === canonicalJson([input.sessionId]) &&
    intent.granted_by === input.grantedBy && intent.reason === input.reason;
}

function openContext(discovery, input, authorityId, stageIntent, attachment, taskIntentRecord) {
  const taskIntent = taskIntentRecord.payload;
  let staged = null;
  let claimed = null;
  if (stageIntent) {
    staged = locatorRecord({ sequence: 1, previousDigest: null, state: "staged", authorityId: stageIntent.payload.authority_id, attachmentId: stageIntent.payload.attachment_id, claimToken: stageIntent.payload.claim_token, claimEpoch: stageIntent.payload.claim_epoch, anchorId: stageIntent.payload.anchor_id, worktreeRoot: stageIntent.payload.root_path, gitDir: stageIntent.payload.control_path });
    claimed = locatorRecord({ sequence: 2, previousDigest: staged.record_digest, state: "claimed", authorityId: stageIntent.payload.authority_id, attachmentId: stageIntent.payload.attachment_id, claimToken: stageIntent.payload.claim_token, claimEpoch: stageIntent.payload.claim_epoch, anchorId: stageIntent.payload.anchor_id, worktreeRoot: stageIntent.payload.root_path, gitDir: stageIntent.payload.control_path });
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
    stageIntent = appendAuthorityRecord(discovery, records, { commandId: stageCommand, kind: "attachment_stage_intent", payload: { authority_id: state.authority_id, attachment_id: attachmentId, claim_token: claimToken, claim_epoch: claimEpoch, anchor_id: discovery.anchor_id, staged_locator_digest: staged.record_digest, claimed_locator_digest: claimed.record_digest, root_path: discovery.worktree_root, control_path: discovery.git_dir, granted_by: input.grantedBy, reason: input.reason } }, evolveAllCurrentAuthority);
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
    taskIntentRecord = appendAuthorityRecord(discovery, records, { commandId: intentCommand, kind: "task_open_intent", payload: { task_id: randomUUID(), attachment_id: attachment.attachment_id, goal: input.goal, write_claims: input.writeClaims, placement: input.placement, branch_intent: input.branchIntent, base_oid: input.baseOid, placement_intent_digest: input.placementIntentDigest, coordinator_session_id: input.sessionId, participant_session_ids: [input.sessionId], granted_by: input.grantedBy, reason: input.reason } }, evolveAllCurrentAuthority);
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
  const pointerPath = path.join(attachment.control_path, "gitdir");
  let pointer;
  try { pointer = fs.readFileSync(pointerPath, "utf8").trim(); }
  catch (error) { if (error?.code === "ENOENT") return fs.realpathSync.native(attachment.root_path); throw error; }
  if (!pointer) throw providerError("WORKTREE_POINTER_INVALID", "linked-worktree admin directory has an empty gitdir pointer");
  const gitFile = path.resolve(attachment.control_path, pointer);
  const observed = fs.realpathSync.native(path.dirname(gitFile));
  const backlink = fs.readFileSync(gitFile, "utf8").trim();
  if (!backlink.toLowerCase().startsWith("gitdir:")) throw providerError("WORKTREE_POINTER_INVALID", "linked worktree has no Git administration backlink");
  const linkedAdmin = fs.realpathSync.native(path.resolve(observed, backlink.slice(7).trim()));
  const expectedAdmin = fs.realpathSync.native(attachment.control_path);
  if (path.relative(expectedAdmin, linkedAdmin) !== "") throw providerError("WORKTREE_POINTER_INVALID", "linked worktree backlink does not match its authority attachment");
  return observed;
}

function unavailableAttachmentView(attachment, unavailableReason) {
  return { attachment_id: attachment.attachment_id, lifecycle: attachment.lifecycle, availability: "unavailable", unavailable_reason: unavailableReason, claimed_worktree_root: attachment.root_path, observed_worktree_root: null, path_status: "unavailable" };
}

function observeAttachment(attachment, authorityId, currentDiscovery = null) {
  const currentAnchor = currentDiscovery?.anchor_id === attachment.anchor_id ? currentDiscovery : null;
  const observedGitDir = currentAnchor?.git_dir ?? attachment.control_path;
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
  return { attachment_id: attachment.attachment_id, lifecycle: attachment.lifecycle, availability: "available", unavailable_reason: null, claimed_worktree_root: attachment.root_path, observed_worktree_root: observed, path_status: path.relative(attachment.root_path, observed) === "" ? "unchanged" : "moved" };
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
  const routable = Boolean(attachmentRoutable && task?.lifecycle.state === "active" && selected.reason === null);
  const reason = routable ? null : !state ? "authority_uninitialized" : !attachment ? "attachment_uninitialized" : attachment.lifecycle === "collision" ? "attachment_collision" : attachment.lifecycle === "reattach_pending" ? "reattach_pending" : attachment.lifecycle !== "claimed" ? "attachment_pending" : !anchorMatches ? "anchor_mismatch" : !locatorMatches ? "locator_unavailable" : selected.reason ?? "authority_inconsistent";
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
  validateOpenMetadata(input);
  const writeClaims = canonicalWriteClaims(discovery, input.writePaths, input.writeRoots);
  if (writeClaims.length > 64 || writeClaims.some((claim) => claim.path.length > 512)) throw providerError("INVALID_WRITE_CLAIM", "current task write claims exceed the bounded open contract");
  const openRelative = targetRelative(discovery, discovery.target);
  if (!writeClaims.some((claim) => claimContains(claim, openRelative))) throw providerError("INVALID_OPEN_TARGET", "current open target is outside its canonical write claims");
  return { ...input, goal: input.goal.trim(), commandId: input.commandId.trim(), writeClaims, sessionId: input.sessionId.trim(), grantedBy: input.grantedBy, reason: input.reason.trim() };
}

function openCurrentGitTask(input, { createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority }) {
  const prepared = preparePlacement(input, { createLockManager, evolveAllCurrentAuthority });
  let discovery = prepared.discovery;
  if (prepared.input.placement === "exclusive_worktree") {
    const livePlacement = revalidateExclusiveDiscoveries(prepared.input.target, prepared.input.placementWorktreePath, prepared.input, prepared.sourceDiscovery, discovery, prepared.input.branchIntent, prepared.input.baseOid);
    if (canonicalJson(livePlacement.observation) !== canonicalJson(prepared.input.placementObservation)) throw providerError("RECOVERY_REQUIRED", "exclusive worktree changed between durable observation and task open; explicit attended recovery is required", { intent_digest: prepared.input.placementIntentDigest });
    discovery = livePlacement.target;
  }
  const normalized = boundedOpenInput(prepared.input, discovery);
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
    reconcileGitLocatorCollision(discovery, records, evolveAllCurrentAuthority);
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
  lockManager.withLock("authority", discovery.authority_root, () => { const records = readAuthority(discovery, evolveAllCurrentAuthority); reconcileGitLocatorCollision(discovery, records, evolveAllCurrentAuthority); before = project(discovery, evolveAllCurrentAuthority, records, { sessionId }); });
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

export { mutateCurrentGitTask, openCurrentGitTask, queryCurrentGit, recordCurrentGitHook, recoverCurrentGitAttachment, forkCurrentGitIdentity, resolveGitAuthorityTarget };

function explicitRecoveryInput(input, actions) {
  if (!actions.has(input.action) || !nonempty(input.target) || !nonempty(input.commandId) || input.grantedBy !== "user" || !nonempty(input.reason)) throw providerError("RECOVERY_AUTHORIZATION_REQUIRED", "recovery commands require a target, command identity, exact user provenance, and reason");
}
function expectedDigest(value, label) { if (!/^sha256:[0-9a-f]{64}$/u.test(String(value ?? ""))) throw providerError("RECOVERY_PRECONDITION_REQUIRED", `${label} must be an exact sha256 digest`); return value; }
function expectedEpoch(value) { const epoch = Number(value); if (!Number.isSafeInteger(epoch) || epoch < 1) throw providerError("RECOVERY_PRECONDITION_REQUIRED", "--expect-epoch must be a positive integer"); return epoch; }
function recoveryAttachment(state, attachmentId) {
  const attachment = state?.attachments.find((item) => item.attachment_id === attachmentId) ?? null;
  if (!attachment) throw providerError("ATTACHMENT_UNAVAILABLE", "selected attachment is not present in this authority");
  return attachment;
}
function publishGitRecovery(discovery, state, records, input, attachment) {
  const expected = expectedDigest(input.expectedLocatorDigest, "--expect-locator-digest");
  const pendingDigest = expectedDigest(input.expectedPendingDigest, "--expect-pending-digest");
  const epoch = expectedEpoch(input.expectedEpoch);
  if (attachment.lifecycle !== "pending" || attachment.claim_epoch !== epoch || attachment.pending_record_digest !== pendingDigest || attachment.claimed_locator_digest !== expected || attachment.claim_token_digest !== sha256Hex(locatorTokenForGit(discovery, attachment.staged_locator_digest)) || attachment.anchor_id !== discovery.anchor_id) throw providerError("RECOVERY_PRECONDITION_FAILED", "pending attachment no longer matches the explicit recovery proof");
  const original = records.find((record) => record.record_digest === pendingDigest) ?? null;
  if (!original || original.kind !== "attachment_claim_pending") throw providerError("RECOVERY_PRECONDITION_FAILED", "pending receipt is not replayable");
  const rootCommand = original.command_id.replace(/:attachment-pending$/u, "");
  if (rootCommand === original.command_id) throw providerError("RECOVERY_PRECONDITION_FAILED", "pending receipt has no recoverable command identity");
  const intentPayload = { authority_id: state.authority_id, attachment_id: attachment.attachment_id, claim_epoch: epoch, pending_record_digest: pendingDigest, expected_locator_digest: expected, claim_token_digest: attachment.claim_token_digest, granted_by: input.grantedBy, reason: input.reason };
  const intent = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:recovery-intent`, kind: "attachment_recovery_intent", payload: intentPayload }, input.evolve);
  let locator = readLocator(discovery);
  const staged = locator.at(-1)?.record_digest;
  if (staged === attachment.staged_locator_digest) {
    const stage = records.find((record) => record.record_digest === attachment.stage_intent_digest);
    if (!stage) throw providerError("AUTHORITY_CORRUPT", "pending attachment lacks its stage intent");
    const claimed = locatorRecord({ sequence: locator.length + 1, previousDigest: locator.at(-1).record_digest, state: "claimed", authorityId: state.authority_id, attachmentId: attachment.attachment_id, claimToken: locatorTokenForGit(discovery, attachment.staged_locator_digest), claimEpoch: attachment.claim_epoch, anchorId: attachment.anchor_id, worktreeRoot: attachment.root_path, gitDir: attachment.control_path });
    if (claimed.record_digest !== attachment.claimed_locator_digest) throw providerError("RECOVERY_PRECONDITION_FAILED", "claim token cannot reproduce the pending locator");
    appendDurably(locatorPath(discovery), Buffer.from(`${canonicalJson(claimed)}\n`)); locator = readLocator(discovery);
  }
  if (locator.at(-1)?.record_digest !== attachment.claimed_locator_digest) throw providerError("RECOVERY_PRECONDITION_FAILED", "locator changed outside the pending recovery");
  const final = appendAuthorityRecord(discovery, records, { commandId: `${rootCommand}:attachment-final`, kind: "attachment_claimed", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: pendingDigest, locator_digest: attachment.claimed_locator_digest } }, input.evolve);
  const receipt = appendAuthorityRecord(discovery, records, { commandId: input.commandId, kind: "attachment_recovery_completed", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, recovery_intent_digest: intent.record_digest, attachment_final_digest: final.record_digest } }, input.evolve);
  return { command_id: input.commandId, recovered_command_id: rootCommand, final_record_digest: final.record_digest, receipt_digest: receipt.record_digest };
}
function cleanupGitStagedLocator(discovery, state, records, input, attachment) {
  const expected = expectedDigest(input.expectedLocatorDigest, "--expect-locator-digest");
  if (!new Set(["staging", "staged"]).has(attachment.lifecycle) || attachment.staged_locator_digest !== expected || state.tasks.some((task) => task.attachment_id === attachment.attachment_id) || state.task_intents.some((task) => task.attachment_id === attachment.attachment_id)) throw providerError("RECOVERY_PRECONDITION_FAILED", "only an unclaimed staged locator without task history can be cleaned");
  const pending = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:cleanup-pending`, kind: "attachment_staged_locator_cleanup_pending", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, locator_digest: expected, granted_by: input.grantedBy, reason: input.reason } }, input.evolve);
  const locator = readLocator(discovery);
  if (locator.length !== 1 || locator[0].state !== "staged" || locator[0].record_digest !== expected) throw providerError("RECOVERY_PRECONDITION_FAILED", "locator is not the exact staged artifact");
  fs.unlinkSync(locatorPath(discovery)); syncDirectory(path.dirname(locatorPath(discovery)));
  const final = appendAuthorityRecord(discovery, records, { commandId: input.commandId, kind: "attachment_staged_locator_cleaned", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: pending.record_digest } }, input.evolve);
  return { command_id: input.commandId, locator_digest: expected, receipt_digest: final.record_digest };
}
function reattachGitAttachment(discovery, state, records, input, attachment) {
  if (records.some((record) => record.kind === "attachment_fork_intent" && record.payload.attachment_id === attachment.attachment_id && !findCommand(records, record.command_id.slice(0, -":intent".length)))) throw providerError("RECOVERY_REQUIRED", "an earlier identity fork must complete before reattach");
  const prior = expectedDigest(input.expectedLocatorDigest, "--expect-locator-digest"); const epoch = expectedEpoch(input.expectedEpoch); const priorPending = findCommand(records, input.commandId + ":reattach-pending"); if (priorPending) { const payload = priorPending.payload; if (priorPending.kind !== "attachment_reattach_pending" || payload.authority_id !== state.authority_id || payload.attachment_id !== attachment.attachment_id || payload.previous_final_digest !== attachment.final_record_digest || payload.previous_epoch !== epoch || payload.previous_claim_token_digest !== sha256Hex(locatorTokenForGit(discovery, prior)) || payload.prior_locator_digest !== prior || payload.granted_by !== input.grantedBy || payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "reattach command id conflicts with its durable pending intent"); const locator = readLocator(discovery); const claimed = locatorRecord({ sequence: locator.at(-1)?.record_digest === prior ? locator.length + 1 : locator.length, previousDigest: prior, state: "claimed", authorityId: state.authority_id, attachmentId: attachment.attachment_id, claimToken: payload.claim_token, claimEpoch: payload.claim_epoch, anchorId: payload.anchor_id, worktreeRoot: payload.root_path, gitDir: payload.control_path }); if (claimed.record_digest !== payload.claimed_locator_digest) throw providerError("AUTHORITY_CORRUPT", "reattach pending intent cannot reproduce its locator"); const current = locator.at(-1); if (current?.record_digest === prior) appendDurably(locatorPath(discovery), Buffer.from(canonicalJson(claimed) + "\n")); else if (current?.record_digest !== claimed.record_digest) throw providerError("RECOVERY_PRECONDITION_FAILED", "Git locator changed outside reattach recovery"); const final = appendAuthorityRecord(discovery, records, { commandId: input.commandId, kind: "attachment_reattached", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: priorPending.record_digest, locator_digest: claimed.record_digest } }, input.evolve); return { command_id: input.commandId, attachment_id: attachment.attachment_id, previous_epoch: epoch, claim_epoch: payload.claim_epoch, locator_digest: claimed.record_digest, receipt_digest: final.record_digest }; }
  if (attachment.claim_epoch !== epoch || attachment.claimed_locator_digest !== prior || attachment.claim_token_digest !== sha256Hex(locatorTokenForGit(discovery, attachment.staged_locator_digest))) throw providerError("RECOVERY_PRECONDITION_FAILED", "reattach optimistic claim changed");
  if (attachment.lifecycle === "claimed" && attachment.anchor_id !== discovery.anchor_id) appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:collision`, kind: "attachment_collision_detected", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, claim_epoch: attachment.claim_epoch, locator_digest: attachment.claimed_locator_digest, observed_anchor_id: discovery.anchor_id } }, input.evolve);
  state = input.evolve(null, records); attachment = recoveryAttachment(state, attachment.attachment_id);
  if (!new Set(["collision", "claimed"]).has(attachment.lifecycle) || attachment.anchor_id === discovery.anchor_id && attachment.lifecycle === "claimed") throw providerError("RECOVERY_NOT_REQUIRED", "reattach requires a collision or an unavailable prior anchor");
  const locator = readLocator(discovery); if (locator.at(-1)?.record_digest !== prior) throw providerError("RECOVERY_PRECONDITION_FAILED", "selected locator is not the expected old claim");
  const claimToken = randomUUID(); const claimed = locatorRecord({ sequence: locator.length + 1, previousDigest: prior, state: "claimed", authorityId: state.authority_id, attachmentId: attachment.attachment_id, claimToken, claimEpoch: epoch + 1, anchorId: discovery.anchor_id, worktreeRoot: discovery.worktree_root, gitDir: discovery.git_dir });
  const pending = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:reattach-pending`, kind: "attachment_reattach_pending", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, previous_final_digest: attachment.final_record_digest, previous_epoch: epoch, previous_claim_token_digest: attachment.claim_token_digest, claim_token: claimToken, claim_epoch: epoch + 1, anchor_id: discovery.anchor_id, prior_locator_digest: prior, claimed_locator_digest: claimed.record_digest, root_path: discovery.worktree_root, control_path: discovery.git_dir, granted_by: input.grantedBy, reason: input.reason } }, input.evolve);
  appendDurably(locatorPath(discovery), Buffer.from(`${canonicalJson(claimed)}\n`));
  const final = appendAuthorityRecord(discovery, records, { commandId: input.commandId, kind: "attachment_reattached", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: pending.record_digest, locator_digest: claimed.record_digest } }, input.evolve);
  return { command_id: input.commandId, attachment_id: attachment.attachment_id, previous_epoch: epoch, claim_epoch: epoch + 1, locator_digest: claimed.record_digest, receipt_digest: final.record_digest };
}
function assertGitRecoveryReplay(records, input, existing) { const attachmentId = existing.payload.attachment_id; if (input.action === "recover") { const intent = findCommand(records, input.commandId + ":recovery-intent"); if (!intent || intent.kind !== "attachment_recovery_intent" || intent.payload.attachment_id !== attachmentId || intent.payload.claim_epoch !== expectedEpoch(input.expectedEpoch) || intent.payload.pending_record_digest !== expectedDigest(input.expectedPendingDigest, "--expect-pending-digest") || intent.payload.expected_locator_digest !== expectedDigest(input.expectedLocatorDigest, "--expect-locator-digest") || intent.payload.granted_by !== input.grantedBy || intent.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "recovery replay input differs from its durable intent"); } else if (input.action === "cleanup") { const pending = findCommand(records, input.commandId + ":cleanup-pending"); if (!pending || pending.kind !== "attachment_staged_locator_cleanup_pending" || pending.payload.attachment_id !== attachmentId || pending.payload.locator_digest !== expectedDigest(input.expectedLocatorDigest, "--expect-locator-digest") || pending.payload.granted_by !== input.grantedBy || pending.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "cleanup replay input differs from its durable intent"); } else { const pending = findCommand(records, input.commandId + ":reattach-pending"); if (!pending || pending.kind !== "attachment_reattach_pending" || pending.payload.attachment_id !== attachmentId || pending.payload.previous_epoch !== expectedEpoch(input.expectedEpoch) || pending.payload.prior_locator_digest !== expectedDigest(input.expectedLocatorDigest, "--expect-locator-digest") || pending.payload.granted_by !== input.grantedBy || pending.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "reattach replay input differs from its durable intent"); } }


function recoverCurrentGitAttachment(input, runtime) {
  explicitRecoveryInput(input, new Set(["recover", "cleanup", "reattach"]));
  const discovery = resolveGitAuthorityTarget(input.target); const lockManager = lockManagerFor(discovery, runtime.createLockManager); let receipt;
  lockManager.withLock("authority", discovery.authority_root, () => {
    const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); const state = runtime.evolveAllCurrentAuthority(null, records); const attachment = recoveryAttachment(state, input.attachmentId);
    const existing = findCommand(records, input.commandId);
    if (existing) {
      const expectedKind = input.action === "recover" ? "attachment_recovery_completed" : input.action === "cleanup" ? "attachment_staged_locator_cleaned" : "attachment_reattached";
      if (existing.kind !== expectedKind) throw providerError("COMMAND_CONFLICT", "recovery command id is already bound to another operation");
      assertGitRecoveryReplay(records, input, existing);
      receipt = { command_id: input.commandId, receipt_digest: existing.record_digest, replayed: true };
    } else {
      const prepared = { ...input, evolve: runtime.evolveAllCurrentAuthority };
      receipt = input.action === "recover" ? publishGitRecovery(discovery, state, records, prepared, attachment) : input.action === "cleanup" ? cleanupGitStagedLocator(discovery, state, records, prepared, attachment) : reattachGitAttachment(discovery, state, records, prepared, attachment);
    }
    writeCurrentSnapshot(discovery, project(discovery, runtime.evolveAllCurrentAuthority, records));
  });
  return { ...project(discovery, runtime.evolveAllCurrentAuthority), recovery: receipt, ...storageFields(discovery, null) };
}

function reconcileGitLocatorCollision(discovery, records, evolveAllCurrentAuthority) {
  const state = evolveAllCurrentAuthority(null, records); if (!state) return state;
  let locator; try { locator = readLocator(discovery).at(-1) ?? null; } catch { return state; }
  const attachment = state.attachments.find((item) => item.attachment_id === locator?.attachment_id) ?? null;
  if (attachment?.lifecycle === "claimed" && locator?.state === "claimed" && locator.authority_id === state.authority_id && locator.attachment_id === attachment.attachment_id && locator.claim_epoch === attachment.claim_epoch && locator.record_digest === attachment.claimed_locator_digest && locator.anchor_id !== discovery.anchor_id) {
    appendAuthorityRecord(discovery, records, { commandId: `collision:${attachment.attachment_id}:${locator.record_digest}:${discovery.anchor_id}`, kind: "attachment_collision_detected", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, claim_epoch: attachment.claim_epoch, locator_digest: locator.record_digest, observed_anchor_id: discovery.anchor_id } }, evolveAllCurrentAuthority);
    return evolveAllCurrentAuthority(null, records);
  }
  return state;
}

function forkCurrentGitIdentity(input, runtime) {
  if (!nonempty(input.target) || !nonempty(input.commandId) || input.grantedBy !== "user" || !nonempty(input.reason) || !/^sha256:[0-9a-f]{64}$/u.test(String(input.expectedLocatorDigest ?? "")) || !Number.isSafeInteger(Number(input.expectedEpoch)) || Number(input.expectedEpoch) < 1) throw providerError("RECOVERY_AUTHORIZATION_REQUIRED", "Git identity fork requires exact user provenance and optimistic source proof");
  const discovery = resolveGitAuthorityTarget(input.target); const locks = lockManagerFor(discovery, runtime.createLockManager); let receipt;
  locks.withLock("authority", discovery.authority_root, () => { const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); let state = runtime.evolveAllCurrentAuthority(null, records); let attachment = recoveryAttachment(state, input.attachmentId); const complete = findCommand(records, input.commandId); if (complete) { const intent = findCommand(records, input.commandId + ":intent"); if (complete.kind !== "attachment_identity_forked" || !intent || intent.kind !== "attachment_fork_intent" || intent.payload.attachment_id !== input.attachmentId || intent.payload.expected_epoch !== Number(input.expectedEpoch) || intent.payload.expected_locator_digest !== input.expectedLocatorDigest || intent.payload.granted_by !== input.grantedBy || intent.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "fork replay input differs from its durable intent"); receipt = { command_id: input.commandId, receipt_digest: complete.record_digest, replayed: true }; return; } let intent = findCommand(records, `${input.commandId}:intent`); if (!intent) { if (attachment.lifecycle !== "collision" || attachment.claim_epoch !== Number(input.expectedEpoch) || attachment.claimed_locator_digest !== input.expectedLocatorDigest || attachment.claim_token_digest !== sha256Hex(locatorTokenForGit(discovery, attachment.staged_locator_digest))) throw providerError("RECOVERY_PRECONDITION_FAILED", "Git identity fork requires the exact unresolved collision"); const locator = readLocator(discovery).at(-1); if (locator?.record_digest !== input.expectedLocatorDigest) throw providerError("RECOVERY_PRECONDITION_FAILED", "selected Git locator changed"); intent = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:intent`, kind: "attachment_fork_intent", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, expected_epoch: attachment.claim_epoch, expected_locator_digest: attachment.claimed_locator_digest, new_authority_id: state.authority_id, new_attachment_id: randomUUID(), new_claim_token: randomUUID(), selected_anchor_id: discovery.anchor_id, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority); }
    const payload = intent.payload; const locator = readLocator(discovery); const prior = locator.at(-1); if (prior?.record_digest !== payload.expected_locator_digest) { const current = locator.at(-1); if (current?.authority_id !== payload.new_authority_id || current?.attachment_id !== payload.new_attachment_id) throw providerError("RECOVERY_PRECONDITION_FAILED", "Git fork locator changed"); }
    const claimed = locatorRecord({ sequence: prior?.record_digest === payload.expected_locator_digest ? prior.sequence + 1 : locator.length, previousDigest: prior?.record_digest === payload.expected_locator_digest ? prior.record_digest : locator.at(-2)?.record_digest ?? null, state: "claimed", authorityId: payload.new_authority_id, attachmentId: payload.new_attachment_id, claimToken: payload.new_claim_token, claimEpoch: 1, anchorId: discovery.anchor_id, worktreeRoot: discovery.worktree_root, gitDir: discovery.git_dir });
    const forked = appendAuthorityRecord(discovery, records, { commandId: `${input.commandId}:destination`, kind: "attachment_forked", payload: { authority_id: payload.new_authority_id, attachment_id: payload.new_attachment_id, source_authority_id: payload.authority_id, source_attachment_id: payload.attachment_id, source_locator_digest: payload.expected_locator_digest, claim_token: payload.new_claim_token, claim_epoch: 1, anchor_id: discovery.anchor_id, claimed_locator_digest: claimed.record_digest, root_path: discovery.worktree_root, control_path: discovery.git_dir, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority);
    const current = readLocator(discovery).at(-1); if (current.record_digest === payload.expected_locator_digest) appendDurably(locatorPath(discovery), Buffer.from(`${canonicalJson(claimed)}\n`)); else if (current.record_digest !== claimed.record_digest) throw providerError("FORK_DESTINATION_CONFLICT", "Git fork locator differs from the reserved claim");
    state = runtime.evolveAllCurrentAuthority(null, records); attachment = recoveryAttachment(state, payload.attachment_id); if (attachment.lifecycle !== "collision") throw providerError("RECOVERY_PRECONDITION_FAILED", "source collision was resolved before fork completion"); const final = appendAuthorityRecord(discovery, records, { commandId: input.commandId, kind: "attachment_identity_forked", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, forked_attachment_id: payload.new_attachment_id, forked_authority_id: payload.new_authority_id, source_locator_digest: payload.expected_locator_digest, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority); writeCurrentSnapshot(discovery, project(discovery, runtime.evolveAllCurrentAuthority, records)); receipt = { command_id: input.commandId, forked_attachment_id: payload.new_attachment_id, destination_digest: forked.record_digest, receipt_digest: final.record_digest }; });
  return { ...project(discovery, runtime.evolveAllCurrentAuthority), recovery: receipt, ...storageFields(discovery, null) };
}

function locatorTokenForGit(discovery, digest) { const record = readLocator(discovery).find((item) => item.record_digest === digest) ?? null; if (!record || !nonempty(record.claim_token)) throw providerError("RECOVERY_PRECONDITION_FAILED", "selected locator does not carry the expected claim token"); return record.claim_token; }
