// Current-format detached filesystem authority provider.
//
// A filesystem root contains only a hash-chained locator.  The replayable
// authority ledger, snapshot, and locks live in the user control area; no
// root-local file is task authority.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS, canonicalJson, compareCodeUnits, foldCasePath, hasExactKeys, isPlainObject, sha256Hex } from "./prims.mjs";

const AUTHORITY_SCHEMA_VERSION = 1;
const LOCATOR_SCHEMA_VERSION = 1;
const AUTHORITY_FILE = "authority.jsonl";
const SNAPSHOT_FILE = "snapshot.json";
const LOCATOR_FILE = ".workloop-filesystem-root.jsonl";
const MAX_AUTHORITY_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;

function providerError(code, message, fields = {}, cause = undefined) { return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, ...fields }); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function pathInside(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

function canonicalTarget(target) {
  const requested = path.resolve(target);
  let cursor = requested;
  for (;;) {
    try {
      const stat = fs.statSync(cursor);
      const canonical = fs.realpathSync.native(cursor);
      return { requested: path.resolve(canonical, path.relative(cursor, requested)), cwd: stat.isDirectory() ? canonical : path.dirname(canonical) };
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
  if (!first.isDirectory() || !second.isDirectory() || fields.some((value) => typeof value !== "bigint" || value <= 0n)) throw providerError("FILESYSTEM_ANCHOR_UNAVAILABLE", "filesystem root has no stable object identity");
  const firstId = `${first.dev}:${first.ino}:${first.birthtimeNs}`;
  const secondId = `${second.dev}:${second.ino}:${second.birthtimeNs}`;
  if (firstId !== secondId) throw providerError("FILESYSTEM_ANCHOR_UNSTABLE", "filesystem root identity changed during discovery");
  return sha256Hex(`${process.platform}:${firstId}`);
}

function gitTopLevel(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
function assertNonGitRoot(root) {
  if (gitTopLevel(root)) throw providerError("AUTHORITY_KIND_CONFLICT", "a claimed filesystem root is now contained by Git; explicit attended authority resolution is required");
}
function controlHome() { return path.resolve(process.env.WORKLOOP_AUTHORITY_HOME || path.join(os.homedir(), ".workloop")); }
function authorityRoot(authorityId) { return path.join(controlHome(), "authorities", authorityId); }
function authorityPath(discovery) { return path.join(discovery.authority_root, AUTHORITY_FILE); }
function snapshotPath(discovery) { return path.join(discovery.authority_root, SNAPSHOT_FILE); }
function locatorPath(root) { return path.join(root, LOCATOR_FILE); }

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function ensureParent(target) {
  const parent = path.dirname(target);
  const first = fs.mkdirSync(parent, { recursive: true });
  if (first === undefined || process.platform === "win32") return;
  let cursor = parent;
  for (;;) {
    syncDirectory(cursor);
    if (path.resolve(cursor) === path.resolve(first)) { syncDirectory(path.dirname(cursor)); return; }
    const ancestor = path.dirname(cursor);
    if (ancestor === cursor) throw providerError("DIRECTORY_SYNC_FAILED", "created directory is outside requested parent chain");
    cursor = ancestor;
  }
}
function writeAll(descriptor, bytes) { let offset = 0; while (offset < bytes.length) { const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, null); if (!Number.isSafeInteger(written) || written <= 0) throw providerError("SHORT_WRITE", "authority write made no progress"); offset += written; } }
function appendDurably(target, bytes, { exclusive = false } = {}) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!payload.length || payload.at(-1) !== 0x0a || payload.length > MAX_RECORD_BYTES) throw providerError("INVALID_FRAME", "authority frame is invalid or too large");
  ensureParent(target);
  const descriptor = fs.openSync(target, exclusive ? "ax" : "a", 0o600);
  try { writeAll(descriptor, payload); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  syncDirectory(path.dirname(target));
}
function writeProjection(target, value) {
  ensureParent(target);
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { writeAll(descriptor, Buffer.from(`${canonicalJson(value)}\n`)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target); syncDirectory(path.dirname(target));
}
function readJsonLines(target, kind, { missing = [] } = {}) {
  let bytes;
  try { const stat = fs.statSync(target); if (stat.size > MAX_AUTHORITY_BYTES) throw providerError("JOURNAL_LIMIT_EXCEEDED", `${kind} exceeds bounded replay size`); bytes = fs.readFileSync(target, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return missing; throw error; }
  if (!bytes.endsWith("\n")) throw providerError(`${kind.toUpperCase()}_TORN`, `${kind} has a torn tail`);
  return bytes.trim().split("\n").filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch (cause) { throw providerError(`${kind.toUpperCase()}_CORRUPT`, `${kind} record ${index + 1} is invalid JSON`, {}, cause); } });
}
function recordDigest(record) { const { record_digest: ignored, ...unsigned } = record; return sha256Hex(canonicalJson(unsigned)); }
function makeRecord({ sequence, previousDigest, commandId, kind, payload }) { const record = { authority_schema_version: AUTHORITY_SCHEMA_VERSION, sequence, previous_digest: previousDigest, record_id: randomUUID(), command_id: commandId, kind, payload }; return Object.freeze({ ...record, record_digest: recordDigest(record) }); }
function findCommand(records, commandId) { return records.find((record) => record.command_id === commandId) ?? null; }
function validateAuthority(records, evolveAllCurrentAuthority) {
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]; const fields = CURRENT_AUTHORITY_EVENT_PAYLOAD_FIELDS[record?.kind];
    if (!isPlainObject(record) || !hasExactKeys(record, ["authority_schema_version", "sequence", "previous_digest", "record_id", "command_id", "kind", "payload", "record_digest"]) || !fields || !isPlainObject(record.payload) || !hasExactKeys(record.payload, fields) || record.authority_schema_version !== AUTHORITY_SCHEMA_VERSION || record.sequence !== index + 1 || record.previous_digest !== previous || record.record_digest !== recordDigest(record)) throw providerError("AUTHORITY_CORRUPT", `authority record ${index + 1} violates the persisted-record contract`);
    previous = record.record_digest;
  }
  evolveAllCurrentAuthority(null, records); return records;
}
function readAuthority(discovery, evolveAllCurrentAuthority) { return validateAuthority(readJsonLines(authorityPath(discovery), "authority"), evolveAllCurrentAuthority); }
function appendAuthority(discovery, records, input, evolveAllCurrentAuthority) {
  const prior = findCommand(records, input.commandId);
  if (prior) { if (prior.kind !== input.kind || canonicalJson(prior.payload) !== canonicalJson(input.payload)) throw providerError("COMMAND_CONFLICT", `command id conflicts with authority history: ${input.commandId}`); return prior; }
  const record = makeRecord({ sequence: records.length + 1, previousDigest: records.at(-1)?.record_digest ?? null, ...input });
  validateAuthority([...records, record], evolveAllCurrentAuthority);
  const frame = Buffer.from(`${canonicalJson(record)}\n`);
  let size = 0; try { size = fs.statSync(authorityPath(discovery)).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (size + frame.length > MAX_AUTHORITY_BYTES) throw providerError("JOURNAL_LIMIT_EXCEEDED", "authority append exceeds bounded replay size");
  appendDurably(authorityPath(discovery), frame); records.push(record); return record;
}

function locatorRecord({ sequence, previousDigest, state, authorityId, attachmentId, claimToken, claimEpoch, anchorId, rootPath }) {
  const record = { locator_schema_version: LOCATOR_SCHEMA_VERSION, sequence, previous_digest: previousDigest, state, authority_id: authorityId, attachment_id: attachmentId, claim_token: claimToken, claim_epoch: claimEpoch, anchor_id: anchorId, root_path: rootPath };
  return Object.freeze({ ...record, record_digest: sha256Hex(canonicalJson(record)) });
}
function readLocator(root) {
  const target = locatorPath(root); let present = false;
  try { fs.statSync(target); present = true; } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
  const records = readJsonLines(target, "locator");
  if (present && records.length === 0) throw providerError("LOCATOR_CORRUPT", "locator exists without a claim record");
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]; const { record_digest: ignored, ...unsigned } = record;
    if (!isPlainObject(record) || !hasExactKeys(record, ["locator_schema_version", "sequence", "previous_digest", "state", "authority_id", "attachment_id", "claim_token", "claim_epoch", "anchor_id", "root_path", "record_digest"]) || record.locator_schema_version !== LOCATOR_SCHEMA_VERSION || record.sequence !== index + 1 || record.previous_digest !== previous || !new Set(["staged", "claimed"]).has(record.state) || !Number.isSafeInteger(record.claim_epoch) || record.claim_epoch < 1 || !nonempty(record.anchor_id) || record.record_digest !== sha256Hex(canonicalJson(unsigned))) throw providerError("LOCATOR_CORRUPT", `locator record ${index + 1} violates the hash-chain contract`);
    previous = record.record_digest;
  }
  return records;
}
function finalLocator(root) { const records = readLocator(root); return records.at(-1)?.state === "claimed" ? records.at(-1) : null; }
function scanLocator(target) {
  const canonical = canonicalTarget(target); if (!canonical) return null;
  let cursor = canonical.cwd;
  for (;;) {
    const locator = finalLocator(cursor);
    if (locator) return { canonical, root_path: cursor, locator };
    const parent = path.dirname(cursor); if (parent === cursor) return null; cursor = parent;
  }
}
function discoveryFromLocator(target) {
  const scanned = scanLocator(target);
  if (!scanned) throw providerError("FILESYSTEM_AUTHORITY_REQUIRED", "target is outside Git and has no explicitly claimed filesystem authority");
  assertNonGitRoot(scanned.root_path);
  const anchorId = stableDirectoryAnchor(scanned.root_path);
  return Object.freeze({ provider: "filesystem_detached", target: scanned.canonical.requested, root_path: scanned.root_path, anchor_id: anchorId, authority_root: authorityRoot(scanned.locator.authority_id), attachment_root: scanned.root_path, locator: scanned.locator });
}
function discoveryFromAuthorityId(authorityId, runtime) {
  const selectorParts = String(authorityId ?? "").split("-"); if (selectorParts.length !== 5 || ![8, 4, 4, 4, 12].every((length, index) => selectorParts[index].length === length) || selectorParts.some((part) => [...part].some((character) => !"0123456789abcdefABCDEF".includes(character)))) throw providerError("INVALID_AUTHORITY_ID", "filesystem authority selector must be a UUID");
  const preliminary = { authority_root: authorityRoot(authorityId) };
  const records = readAuthority(preliminary, runtime.evolveAllCurrentAuthority);
  const state = records.length ? runtime.evolveAllCurrentAuthority(null, records) : null;
  const liveAttachments = state?.attachments.filter((attachment) => attachment.lifecycle !== "cleaned") ?? [];
  if (!state || state.provider !== "filesystem_detached" || liveAttachments.length !== 1) throw providerError("AUTHORITY_UNAVAILABLE", "filesystem authority selector does not name one live detached attachment");
  const attachment = liveAttachments[0];
  return Object.freeze({ provider: "filesystem_detached", target: attachment.root_path, root_path: attachment.root_path, anchor_id: attachment.anchor_id, authority_root: preliminary.authority_root, attachment_root: attachment.root_path, locator: { authority_id: state.authority_id, attachment_id: attachment.attachment_id }, authority_id: state.authority_id });
}
const MAX_BOUNDARY_SCAN_ENTRIES = 8192;
function hasFilesystemLocator(root) { return readLocator(root).length > 0; }
function assertFilesystemBoundaryAvailable(root) {
  let ancestor = path.dirname(root);
  for (;;) {
    if (hasFilesystemLocator(ancestor)) throw providerError("AUTHORITY_BOUNDARY_CONFLICT", "filesystem root overlaps an existing claimed filesystem authority");
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  let observed = 0; const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (cause) { throw providerError("AUTHORITY_BOUNDARY_UNRESOLVABLE", "filesystem root boundary cannot be fully scanned", {}, cause); }
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      observed += 1; if (observed > MAX_BOUNDARY_SCAN_ENTRIES) throw providerError("AUTHORITY_BOUNDARY_UNRESOLVABLE", "filesystem root boundary scan exceeded its bounded entry limit");
      const child = path.join(directory, entry.name);
      if (entry.name === LOCATOR_FILE && path.resolve(directory) !== path.resolve(root) && hasFilesystemLocator(directory)) throw providerError("AUTHORITY_BOUNDARY_CONFLICT", "filesystem root contains an existing claimed filesystem authority");
      if (entry.isDirectory() && entry.name !== ".git") pending.push(child);
    }
  }
}
function authorityIdForAnchor(anchorId) { const digest = sha256Hex("filesystem-detached:" + anchorId).slice("sha256:".length); return digest.slice(0, 8) + "-" + digest.slice(8, 12) + "-4" + digest.slice(13, 16) + "-8" + digest.slice(17, 20) + "-" + digest.slice(20, 32); }

function discoveryForOpen(target, filesystemRoot) {
  if (!nonempty(filesystemRoot)) throw providerError("FILESYSTEM_ROOT_REQUIRED", "filesystem authority open requires explicit --filesystem-root");
  const rootCanonical = canonicalTarget(filesystemRoot);
  if (!rootCanonical || rootCanonical.requested !== rootCanonical.cwd) throw providerError("INVALID_FILESYSTEM_ROOT", "filesystem root must be an existing directory");
  assertNonGitRoot(rootCanonical.cwd);
  const targetCanonical = canonicalTarget(target);
  if (!targetCanonical || !pathInside(rootCanonical.cwd, targetCanonical.requested)) throw providerError("TARGET_SCOPE_UNAVAILABLE", "target must be contained by the explicit filesystem root");
  const locatorRecords = readLocator(rootCanonical.cwd);
  const locator = locatorRecords.at(-1)?.state === "claimed" ? locatorRecords.at(-1) : null;
  if (locatorRecords.length && !locator) throw providerError("RECOVERY_REQUIRED", "filesystem root has an incomplete locator claim; explicit attended recovery is required");
  assertFilesystemBoundaryAvailable(rootCanonical.cwd);
  if (locator) return discoveryFromLocator(target);
  const anchorId = stableDirectoryAnchor(rootCanonical.cwd); const authorityId = authorityIdForAnchor(anchorId);
  return Object.freeze({ provider: "filesystem_detached", target: targetCanonical.requested, root_path: rootCanonical.cwd, anchor_id: anchorId, authority_root: authorityRoot(authorityId), attachment_root: rootCanonical.cwd, locator: null, authority_id: authorityId });
}

function claimContains(claim, target) { return claim.kind === "path" ? claim.path === target : claim.path === "." || claim.path === target || target.startsWith(`${claim.path}/`); }
function claimsOverlap(left, right) { if (left.kind === "path" && right.kind === "path") return left.path === right.path; if (left.kind === "root") return claimContains(left, right.path); return claimContains(right, left.path); }
function claimCompare(left, right) { return compareCodeUnits(left.path, right.path) || compareCodeUnits(left.kind, right.kind); }
function canonicalClaim(discovery, value, kind) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/"); const normalized = path.posix.normalize(raw.replace(/^(?:\.\/)+/u, "") || ".");
  const root = kind === "root" && normalized === ".";
  const parts = normalized.split("/");
  if (!raw || (!root && (normalized === "." || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || /[*?[\]{}]/u.test(normalized) || parts.some((part) => !part || part === "." || part === "..") || parts[0] === LOCATOR_FILE))) throw providerError("INVALID_WRITE_CLAIM", "write claims must be structured filesystem-root-relative paths outside control locators");
  const canonical = canonicalTarget(path.resolve(discovery.root_path, normalized));
  if (!canonical || !pathInside(discovery.root_path, canonical.requested)) throw providerError("INVALID_WRITE_CLAIM", "write claims must resolve inside the selected filesystem root");
  const relative = path.relative(discovery.root_path, canonical.requested).replaceAll("\\", "/");
  if ((!root && !relative) || (!root && relative === LOCATOR_FILE) || relative === ".." || relative.startsWith("../")) throw providerError("INVALID_WRITE_CLAIM", "write claims must resolve outside control locators");
  return { kind, path: root ? "." : foldCasePath(relative) };
}
function canonicalClaims(discovery, writePaths, writeRoots) {
  const claims = [...(Array.isArray(writePaths) ? writePaths : []).map((value) => canonicalClaim(discovery, value, "path")), ...(Array.isArray(writeRoots) ? writeRoots : []).map((value) => canonicalClaim(discovery, value, "root"))];
  if (!claims.length) throw providerError("INVALID_WRITE_CLAIM", "current task requires at least one --write-path or --write-root");
  const unique = [...new Map(claims.map((claim) => [`${claim.kind}:${claim.path}`, claim])).values()].sort(claimCompare);
  for (let index = 0; index < unique.length; index += 1) for (let peer = index + 1; peer < unique.length; peer += 1) if (claimsOverlap(unique[index], unique[peer])) throw providerError("REDUNDANT_WRITE_CLAIM", "one task cannot declare overlapping write claims");
  return unique;
}
function targetRelative(discovery, target) { const canonical = canonicalTarget(target); const relative = path.relative(discovery.root_path, canonical?.requested ?? path.resolve(target)).split(path.sep).join("/"); if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative) || relative === LOCATOR_FILE) throw providerError("TARGET_SCOPE_UNAVAILABLE", "target is outside filesystem task scope or is control state"); return relative || "."; }
function validateOpen(input) { if (!nonempty(input.goal) || input.goal.trim().length > 4096 || !nonempty(input.commandId) || input.commandId.trim().length > 256 || !new Set(["self", "user"]).has(input.grantedBy) || !nonempty(input.reason) || input.reason.trim().length > 2048 || !nonempty(input.sessionId) || input.sessionId.trim() === "cli") throw providerError("INVALID_OPEN", "filesystem open requires bounded goal, command, provenance, and real host session identity"); }
function boundedOpenInput(input, discovery) {
  validateOpen(input); const writeClaims = canonicalClaims(discovery, input.writePaths, input.writeRoots);
  if (writeClaims.length > 64 || writeClaims.some((claim) => claim.path.length > 512)) throw providerError("INVALID_WRITE_CLAIM", "filesystem task write claims exceed the bounded open contract");
  const relative = targetRelative(discovery, discovery.target);
  if (!writeClaims.some((claim) => claimContains(claim, relative))) throw providerError("INVALID_OPEN_TARGET", "filesystem open target is outside its canonical write claims");
  return { ...input, goal: input.goal.trim(), commandId: input.commandId.trim(), sessionId: input.sessionId.trim(), reason: input.reason.trim(), writeClaims };
}

function locatorMatchesAttachment(locator, attachment, authorityId) {
  return Boolean(locator && attachment && locator.state === "claimed" && locator.record_digest === attachment.claimed_locator_digest && locator.authority_id === authorityId && locator.attachment_id === attachment.attachment_id && locator.claim_epoch === attachment.claim_epoch && locator.anchor_id === attachment.anchor_id && sha256Hex(locator.claim_token) === attachment.claim_token_digest);
}
function unavailableFilesystemAttachment(attachment, reason) { return { attachment_id: attachment?.attachment_id ?? null, lifecycle: attachment?.lifecycle ?? "unknown", availability: "unavailable", unavailable_reason: reason, claimed_root_path: attachment?.root_path ?? null, observed_root_path: null, path_status: "unavailable" }; }
function attachmentView(discovery, attachment, authorityId) {
  if (!attachment) return unavailableFilesystemAttachment(attachment, "attachment_unavailable");
  if (attachment.lifecycle === "collision") return unavailableFilesystemAttachment(attachment, "attachment_collision");
  if (attachment.lifecycle === "reattach_pending") return unavailableFilesystemAttachment(attachment, "reattach_pending");
  if (attachment.lifecycle !== "claimed") return unavailableFilesystemAttachment(attachment, "attachment_unavailable");
  let observedAnchor;
  try { observedAnchor = stableDirectoryAnchor(discovery.root_path); } catch { return unavailableFilesystemAttachment(attachment, "root_unavailable"); }
  if (observedAnchor !== attachment.anchor_id) return unavailableFilesystemAttachment(attachment, "anchor_mismatch");
  const moved = path.resolve(attachment.root_path) !== path.resolve(discovery.root_path);
  if (moved) {
    try { stableDirectoryAnchor(attachment.root_path); return unavailableFilesystemAttachment(attachment, "attachment_collision"); }
    catch (cause) { if (cause?.code !== "ENOENT") return unavailableFilesystemAttachment(attachment, "claimed_root_unreadable"); }
  }
  if (!locatorMatchesAttachment(discovery.locator, attachment, authorityId)) return unavailableFilesystemAttachment(attachment, "locator_unavailable");
  return { attachment_id: attachment.attachment_id, lifecycle: attachment.lifecycle, availability: "available", unavailable_reason: null, claimed_root_path: attachment.root_path, observed_root_path: discovery.root_path, path_status: moved ? "moved" : "unchanged" };
}
function project(discovery, evolveAllCurrentAuthority, records = null, selection = {}) {
  const current = records ?? readAuthority(discovery, evolveAllCurrentAuthority); const state = current.length ? evolveAllCurrentAuthority(null, current) : null;
  const attachment = state?.attachments.find((item) => item.attachment_id === discovery.locator?.attachment_id) ?? null; const view = attachmentView(discovery, attachment, state?.authority_id ?? null);
  const relative = targetRelative(discovery, discovery.target);
  const candidates = state?.tasks.filter((task) => task.attachment_id === attachment?.attachment_id && (selection.taskId ? task.task_id === selection.taskId : task.lifecycle.state !== "terminal" && task.write_claims.some((claim) => claimContains(claim, relative)))) ?? [];
  const task = selection.taskId ? candidates.find((item) => item.task_id === selection.taskId) ?? null : candidates.length === 1 ? candidates[0] : null;
  const reason = view.availability !== "available" ? view.unavailable_reason : candidates.length > 1 && !selection.taskId ? "task_scope_ambiguous" : !task ? "task_scope_unclaimed" : selection.sessionId && !task.participant_session_ids.includes(selection.sessionId) ? "session_task_mismatch" : null;
  return { provider: "filesystem_detached", authority_id: state?.authority_id ?? discovery.locator?.authority_id ?? discovery.authority_id ?? null, attachment_id: attachment?.attachment_id ?? discovery.locator?.attachment_id ?? null, placement: task?.placement ?? "partitioned", routable: reason === null, routing_reason: reason, authority_sequence: current.length, attachment: view, task, filesystem_attachments: (state?.attachments ?? []).map((item) => attachmentView(discovery, item, state?.authority_id ?? null)), filesystem_tasks: state?.tasks ?? [] };
}
function writeSnapshot(discovery, value) { writeProjection(snapshotPath(discovery), value); }
function lockManagerFor(discovery, createLockManager) {
  ensureParent(authorityPath(discovery));
  return createLockManager({
    resolveLockPath: ({ lockClass, resourceId }) => path.join(discovery.authority_root, `.workloop-${lockClass}-${sha256Hex(resourceId).slice(7, 23)}.lock`),
    optionsForLock: () => ({ timeoutMs: 15_000, staleMs: 5_000 }),
  });
}
function ensureAttachment(discovery, input, runtime) {
  if (discovery.locator) {
    const preflightRecords = readAuthority(discovery, runtime.evolveAllCurrentAuthority); const preflightState = preflightRecords.length ? runtime.evolveAllCurrentAuthority(null, preflightRecords) : null; const preflightAttachment = preflightState?.attachments.find((item) => item.attachment_id === discovery.locator.attachment_id) ?? null;
    if (!preflightState || !preflightAttachment || preflightAttachment.lifecycle !== "claimed" || preflightAttachment.anchor_id !== discovery.anchor_id || !locatorMatchesAttachment(discovery.locator, preflightAttachment, preflightState.authority_id)) throw providerError("RECOVERY_REQUIRED", "filesystem locator requires explicit attended recovery");
  }
  const lockManager = lockManagerFor(discovery, runtime.createLockManager); let attached;
  lockManager.withLock("authority", discovery.authority_root, () => {
    const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority);
    let state = records.length ? runtime.evolveAllCurrentAuthority(null, records) : null;
    if (discovery.locator) {
      if (!state) throw providerError("RECOVERY_REQUIRED", "filesystem locator has no replayable authority; explicit attended recovery is required");
      const existing = state.attachments.find((item) => item.attachment_id === discovery.locator.attachment_id) ?? null;
      if (!existing || existing.lifecycle !== "claimed" || existing.anchor_id !== discovery.anchor_id || !locatorMatchesAttachment(discovery.locator, existing, state.authority_id)) throw providerError("RECOVERY_REQUIRED", "filesystem locator requires explicit attended recovery");
      attached = existing; return;
    }
    if (!state) { appendAuthority(discovery, records, { commandId: "authority:genesis", kind: "authority_genesis", payload: { authority_id: discovery.authority_id, provider: "filesystem_detached" } }, runtime.evolveAllCurrentAuthority); state = runtime.evolveAllCurrentAuthority(null, records); }
    else if (state.attachments.some((attachment) => attachment.lifecycle !== "cleaned")) throw providerError("RECOVERY_REQUIRED", "filesystem root has an unpublished staged authority; use its deterministic authority selector for attended recovery");
    const attachmentId = randomUUID(); const claimToken = randomUUID(); const stageCommand = `${input.commandId}:attachment-stage`;
    const staged = locatorRecord({ sequence: 1, previousDigest: null, state: "staged", authorityId: state.authority_id, attachmentId, claimToken, claimEpoch: 1, anchorId: discovery.anchor_id, rootPath: discovery.root_path });
    const claimed = locatorRecord({ sequence: 2, previousDigest: staged.record_digest, state: "claimed", authorityId: state.authority_id, attachmentId, claimToken, claimEpoch: 1, anchorId: discovery.anchor_id, rootPath: discovery.root_path });
    const stage = appendAuthority(discovery, records, { commandId: stageCommand, kind: "attachment_stage_intent", payload: { authority_id: state.authority_id, attachment_id: attachmentId, claim_token: claimToken, claim_epoch: 1, anchor_id: discovery.anchor_id, staged_locator_digest: staged.record_digest, claimed_locator_digest: claimed.record_digest, root_path: discovery.root_path, control_path: discovery.authority_root, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority);
    appendDurably(locatorPath(discovery.root_path), Buffer.from(canonicalJson(staged) + "\n"), { exclusive: true });
    const stagedReceipt = appendAuthority(discovery, records, { commandId: `${input.commandId}:attachment-staged`, kind: "attachment_staged", payload: { authority_id: state.authority_id, attachment_id: attachmentId, stage_intent_digest: stage.record_digest, staged_locator_digest: staged.record_digest, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority);
    const pending = appendAuthority(discovery, records, { commandId: `${input.commandId}:attachment-pending`, kind: "attachment_claim_pending", payload: { authority_id: state.authority_id, attachment_id: attachmentId, staged_receipt_digest: stagedReceipt.record_digest, claimed_locator_digest: claimed.record_digest } }, runtime.evolveAllCurrentAuthority);
    appendDurably(locatorPath(discovery.root_path), Buffer.from(`${canonicalJson(claimed)}\n`));
    appendAuthority(discovery, records, { commandId: `${input.commandId}:attachment-claimed`, kind: "attachment_claimed", payload: { authority_id: state.authority_id, attachment_id: attachmentId, pending_record_digest: pending.record_digest, locator_digest: claimed.record_digest } }, runtime.evolveAllCurrentAuthority);
    attached = runtime.evolveAllCurrentAuthority(null, records).attachments.find((item) => item.attachment_id === attachmentId);
  });
  return attached;
}

function taskIntentMatchesInput(intent, input, writeClaims, attachmentId) { return intent?.attachment_id === attachmentId && intent.goal === input.goal && canonicalJson(intent.write_claims) === canonicalJson(writeClaims) && intent.placement === "partitioned" && intent.branch_intent === null && intent.base_oid === null && intent.placement_intent_digest === null && intent.coordinator_session_id === input.sessionId && canonicalJson(intent.participant_session_ids) === canonicalJson([input.sessionId]) && intent.granted_by === input.grantedBy && intent.reason === input.reason; }
function openCurrentFilesystemTask(input, runtime) {
  if (input.placement && String(input.placement).replaceAll("-", "_") !== "partitioned") throw providerError("INVALID_PLACEMENT", "filesystem tasks support partitioned placement only");
  let discovery = discoveryForOpen(input.target, input.filesystemRoot); const prepared = boundedOpenInput(input, discovery); const attached = ensureAttachment(discovery, prepared, runtime); if (!discovery.locator) discovery = discoveryFromLocator(input.target);
  input = prepared; const writeClaims = input.writeClaims; const lockManager = lockManagerFor(discovery, runtime.createLockManager);
  runtime.runAuthorityTransaction({ lockManager, authorityId: discovery.authority_root, append: () => {
    const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); const state = runtime.evolveAllCurrentAuthority(null, records); const intentCommand = input.commandId + ":task-intent"; const existing = findCommand(records, intentCommand);
    if (existing) {
      if (existing.kind !== "task_open_intent" || !taskIntentMatchesInput(existing.payload, prepared, writeClaims, attached.attachment_id)) throw providerError("COMMAND_CONFLICT", "filesystem task open command conflicts with its durable intent");
      const opened = findCommand(records, input.commandId + ":task-opened");
      if (!opened || opened.kind !== "task_opened" || opened.payload.task_id !== existing.payload.task_id || opened.payload.attachment_id !== attached.attachment_id || opened.payload.open_intent_digest !== existing.record_digest || opened.payload.attachment_final_digest !== attached.final_record_digest) throw providerError("RECOVERY_REQUIRED", "filesystem task open has a durable incomplete or mismatched intent; explicit attended recovery is required");
      return opened;
    }
    const live = [...state.tasks.filter((task) => task.attachment_id === attached.attachment_id && task.lifecycle.state !== "terminal"), ...state.task_intents.filter((task) => task.attachment_id === attached.attachment_id && task.status === "pending")];
    if (live.some((task) => task.participant_session_ids.includes(input.sessionId))) throw providerError("SESSION_UNIQUENESS", "filesystem attachment already has a live task for this session");
    if (live.some((task) => writeClaims.some((claim) => task.write_claims.some((other) => claimsOverlap(claim, other))))) throw providerError("WRITE_SCOPE_OVERLAP", "filesystem task write scope overlaps a live task");
    const taskId = randomUUID(); const intent = appendAuthority(discovery, records, { commandId: intentCommand, kind: "task_open_intent", payload: { task_id: taskId, attachment_id: attached.attachment_id, goal: input.goal.trim(), write_claims: writeClaims, placement: "partitioned", branch_intent: null, base_oid: null, placement_intent_digest: null, coordinator_session_id: input.sessionId.trim(), participant_session_ids: [input.sessionId.trim()], granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority);
    return appendAuthority(discovery, records, { commandId: `${input.commandId}:task-opened`, kind: "task_opened", payload: { task_id: taskId, attachment_id: attached.attachment_id, open_intent_digest: intent.record_digest, attachment_final_digest: attached.final_record_digest } }, runtime.evolveAllCurrentAuthority);
  }, publishSnapshot: () => { const value = project(discovery, runtime.evolveAllCurrentAuthority, null, { sessionId: input.sessionId }); writeSnapshot(discovery, value); return value.authority_sequence; } });
  const value = project(discovery, runtime.evolveAllCurrentAuthority, null, { sessionId: input.sessionId }); return { ...value, storage: { authority_root: discovery.authority_root, locator_path: locatorPath(discovery.root_path) } };
}
function queryCurrentFilesystemDiscovery(discovery, kind, runtime, selection = {}) {
  const lockManager = lockManagerFor(discovery, runtime.createLockManager); let value; let records;
  lockManager.withLock("authority", discovery.authority_root, () => { records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); reconcileFilesystemLocatorCollision(discovery, records, runtime); value = project(discovery, runtime.evolveAllCurrentAuthority, records, selection); if (kind !== "ledger") writeSnapshot(discovery, value); });
  if (kind === "ledger") return { provider: "filesystem_detached", authority_id: value.authority_id, authority_sequence: value.authority_sequence, records, storage: { authority_root: discovery.authority_root, locator_path: locatorPath(discovery.root_path) } };
  if (kind === "audit") return { integrity: value.routable ? "valid" : ["root_unavailable", "attachment_collision", "claimed_root_unreadable", "locator_unavailable"].includes(value.routing_reason) ? "pending" : "invalid", ...value };
  if (kind === "tasks") return { provider: value.provider, authority_id: value.authority_id, authority_sequence: value.authority_sequence, filesystem_attachments: value.filesystem_attachments, filesystem_tasks: value.filesystem_tasks };
  return value;
}
function queryCurrentFilesystem(target, kind, runtime, selection = {}) { return queryCurrentFilesystemDiscovery(discoveryFromLocator(target), kind, runtime, selection); }
function queryCurrentFilesystemAuthority(authorityId, kind, runtime, selection = {}) { return queryCurrentFilesystemDiscovery(discoveryFromAuthorityId(authorityId, runtime), kind, runtime, selection); }
function mutateCurrentFilesystemTask(input, runtime) {
  if (!new Set(["join", "suspend", "resume", "abandon"]).has(input.action) || (!nonempty(input.target) && !nonempty(input.authorityId)) || (nonempty(input.target) && nonempty(input.authorityId)) || !nonempty(input.taskId) || !nonempty(input.commandId) || !nonempty(input.sessionId) || input.sessionId === "cli" || !new Set(["self", "user"]).has(input.grantedBy) || !nonempty(input.reason)) throw providerError("INVALID_TASK_MUTATION", "filesystem task mutation requires one authority selector, task, command, session, and provenance");
  const discovery = nonempty(input.authorityId) ? discoveryFromAuthorityId(input.authorityId, runtime) : discoveryFromLocator(input.target); const lockManager = lockManagerFor(discovery, runtime.createLockManager); const kind = { join: "task_joined", suspend: "task_suspended", resume: "task_resumed", abandon: "task_terminal" }[input.action];
  runtime.runAuthorityTransaction({ lockManager, authorityId: discovery.authority_root, append: () => { const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); const state = runtime.evolveAllCurrentAuthority(null, records); const task = state.tasks.find((item) => item.task_id === input.taskId) ?? null; const attachment = state.attachments.find((item) => item.attachment_id === discovery.locator.attachment_id) ?? null; if (!task || task.attachment_id !== discovery.locator.attachment_id) throw providerError("TASK_ATTACHMENT_MISMATCH", "filesystem mutation target does not own this task"); if (input.action !== "abandon" && attachmentView(discovery, attachment, state.authority_id).availability !== "available") throw providerError("ATTACHMENT_UNAVAILABLE", "filesystem non-terminal mutation requires a live bound attachment"); if (input.action !== "join" && !task.participant_session_ids.includes(input.sessionId)) throw providerError("TASK_SESSION_MISMATCH", "filesystem mutation requires a participant session"); const payload = input.action === "join" ? { task_id: input.taskId, session_id: input.sessionId, reason: input.reason, granted_by: input.grantedBy } : input.action === "abandon" ? { task_id: input.taskId, session_id: input.sessionId, outcome: "abandoned", reason: input.reason, granted_by: input.grantedBy } : { task_id: input.taskId, session_id: input.sessionId, reason: input.reason, granted_by: input.grantedBy }; return appendAuthority(discovery, records, { commandId: input.commandId, kind, payload }, runtime.evolveAllCurrentAuthority); }, publishSnapshot: () => { const value = project(discovery, runtime.evolveAllCurrentAuthority, null, { taskId: input.taskId, sessionId: input.sessionId }); writeSnapshot(discovery, value); return value.authority_sequence; } });
  return project(discovery, runtime.evolveAllCurrentAuthority, null, { taskId: input.taskId, sessionId: input.sessionId });
}
function recordCurrentFilesystemHook({ target, invocation }, runtime) {
  const discovery = discoveryFromLocator(target); const lockManager = lockManagerFor(discovery, runtime.createLockManager); const sessionId = nonempty(invocation.sessionId) ? invocation.sessionId : "unknown"; let before; lockManager.withLock("authority", discovery.authority_root, () => { const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); reconcileFilesystemLocatorCollision(discovery, records, runtime); before = project(discovery, runtime.evolveAllCurrentAuthority, records, { sessionId }); });
  if (!before.routable || !before.task) throw providerError("HOOK_ROUTE_UNAVAILABLE", `current task routing unavailable: ${before.routing_reason}`);
  const kind = invocation.event === "pre_tool_use" ? "operation_intent_recorded" : invocation.event === "post_tool_use" || invocation.event === "post_tool_use_failure" ? "tool_completed" : null; if (!kind) return before;
  const relative = targetRelative(discovery, target); const operationId = nonempty(invocation.commandId) ? invocation.commandId : `unmatched:${randomUUID()}`; const commandId = `hook:${before.attachment_id}:${before.task.task_id}:${invocation.event}:${operationId}:${sha256Hex(sessionId).slice(7, 23)}:${sha256Hex(relative).slice(7, 23)}`;
  runtime.runAuthorityTransaction({ lockManager, authorityId: discovery.authority_root, append: () => { const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); const current = project(discovery, runtime.evolveAllCurrentAuthority, records, { sessionId }); if (!current.routable || current.task.task_id !== before.task.task_id) throw providerError("HOOK_ROUTE_STALE", "filesystem task route changed before receipt commit"); return appendAuthority(discovery, records, { commandId, kind, payload: { task_id: current.task.task_id, operation_id: operationId, session_id: sessionId, tool: nonempty(invocation.toolName) ? invocation.toolName : "unknown", target: relative, permission_mode: nonempty(invocation.permissionModeRaw) ? invocation.permissionModeRaw : null, ...(kind === "tool_completed" ? { outcome: String(invocation.completionOutcome ?? "unknown"), receipt_quality: String(invocation.receiptQuality ?? "unknown") } : {}) } }, runtime.evolveAllCurrentAuthority); }, publishSnapshot: () => writeSnapshot(discovery, project(discovery, runtime.evolveAllCurrentAuthority, null, { sessionId })) });
  return project(discovery, runtime.evolveAllCurrentAuthority, null, { sessionId });
}

export { discoveryFromLocator as resolveFilesystemAuthorityTarget, abandonStagedFilesystemAuthority, openCurrentFilesystemTask, queryCurrentFilesystem, queryCurrentFilesystemAuthority, mutateCurrentFilesystemTask, forkCurrentFilesystemIdentity, recordCurrentFilesystemHook, recoverCurrentFilesystemAttachment };

function recoveryFilesystemDiscovery(target) {
  const canonical = canonicalTarget(target); if (!canonical) throw providerError("TARGET_SCOPE_UNAVAILABLE", "recovery target cannot be resolved");
  let cursor = canonical.cwd;
  for (;;) {
    const records = readLocator(cursor);
    const locator = records.at(-1) ?? null;
    if (locator) return Object.freeze({ provider: "filesystem_detached", target: canonical.requested, root_path: cursor, anchor_id: stableDirectoryAnchor(cursor), authority_root: authorityRoot(locator.authority_id), attachment_root: cursor, locator });
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const anchorId = stableDirectoryAnchor(canonical.cwd); const authorityId = authorityIdForAnchor(anchorId); const candidate = Object.freeze({ provider: "filesystem_detached", target: canonical.requested, root_path: canonical.cwd, anchor_id: anchorId, authority_root: authorityRoot(authorityId), attachment_root: canonical.cwd, locator: null, authority_id: authorityId });
  if (fs.existsSync(authorityPath(candidate))) return candidate;
  throw providerError("FILESYSTEM_AUTHORITY_REQUIRED", "recovery target has no filesystem locator or staged authority");
}
function explicitFilesystemRecoveryInput(input, actions) {
  if (!actions.has(input.action) || (nonempty(input.target) === nonempty(input.authorityId)) || !nonempty(input.commandId) || input.grantedBy !== "user" || !nonempty(input.reason)) throw providerError("RECOVERY_AUTHORIZATION_REQUIRED", "filesystem recovery commands require exact user provenance and command identity");
}
function recoveryDigest(value, label) { if (!/^sha256:[0-9a-f]{64}$/u.test(String(value ?? ""))) throw providerError("RECOVERY_PRECONDITION_REQUIRED", `${label} must be an exact sha256 digest`); return value; }
function recoveryEpoch(value) { const epoch = Number(value); if (!Number.isSafeInteger(epoch) || epoch < 1) throw providerError("RECOVERY_PRECONDITION_REQUIRED", "--expect-epoch must be a positive integer"); return epoch; }
function filesystemAttachment(state, attachmentId) { const attachment = state?.attachments.find((item) => item.attachment_id === attachmentId) ?? null; if (!attachment) throw providerError("ATTACHMENT_UNAVAILABLE", "selected filesystem attachment is absent"); return attachment; }
function recoverFilesystemPending(discovery, state, records, input, attachment, runtime) {
  const expected = recoveryDigest(input.expectedLocatorDigest, "--expect-locator-digest"); const pendingDigest = recoveryDigest(input.expectedPendingDigest, "--expect-pending-digest"); const epoch = recoveryEpoch(input.expectedEpoch);
  if (attachment.lifecycle !== "pending" || attachment.claim_epoch !== epoch || attachment.pending_record_digest !== pendingDigest || attachment.claimed_locator_digest !== expected || attachment.claim_token_digest !== sha256Hex(locatorTokenForFilesystem(discovery, attachment.staged_locator_digest)) || attachment.anchor_id !== discovery.anchor_id) throw providerError("RECOVERY_PRECONDITION_FAILED", "pending filesystem claim no longer matches explicit proof");
  const original = records.find((record) => record.record_digest === pendingDigest) ?? null; const rootCommand = original?.command_id?.replace(/:attachment-pending$/u, ""); if (!original || rootCommand === original.command_id) throw providerError("RECOVERY_PRECONDITION_FAILED", "pending claim is not replayable");
  const intent = appendAuthority(discovery, records, { commandId: `${input.commandId}:recovery-intent`, kind: "attachment_recovery_intent", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, claim_epoch: epoch, pending_record_digest: pendingDigest, expected_locator_digest: expected, claim_token_digest: attachment.claim_token_digest, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority);
  let locator = readLocator(discovery.root_path);
  if (locator.at(-1)?.record_digest === attachment.staged_locator_digest) {
    const claimed = locatorRecord({ sequence: locator.length + 1, previousDigest: locator.at(-1).record_digest, state: "claimed", authorityId: state.authority_id, attachmentId: attachment.attachment_id, claimToken: locatorTokenForFilesystem(discovery, attachment.staged_locator_digest), claimEpoch: epoch, anchorId: attachment.anchor_id, rootPath: attachment.root_path });
    if (claimed.record_digest !== expected) throw providerError("RECOVERY_PRECONDITION_FAILED", "claim token cannot reproduce pending filesystem locator");
    appendDurably(locatorPath(discovery.root_path), Buffer.from(`${canonicalJson(claimed)}\n`)); locator = readLocator(discovery.root_path);
  }
  if (locator.at(-1)?.record_digest !== expected) throw providerError("RECOVERY_PRECONDITION_FAILED", "filesystem locator changed outside recovery");
  const final = appendAuthority(discovery, records, { commandId: `${rootCommand}:attachment-claimed`, kind: "attachment_claimed", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: pendingDigest, locator_digest: expected } }, runtime.evolveAllCurrentAuthority);
  const receipt = appendAuthority(discovery, records, { commandId: input.commandId, kind: "attachment_recovery_completed", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, recovery_intent_digest: intent.record_digest, attachment_final_digest: final.record_digest } }, runtime.evolveAllCurrentAuthority);
  return { command_id: input.commandId, final_record_digest: final.record_digest, receipt_digest: receipt.record_digest };
}
function cleanupFilesystemStaged(discovery, state, records, input, attachment, runtime) {
  const expected = recoveryDigest(input.expectedLocatorDigest, "--expect-locator-digest");
  if (!new Set(["staging", "staged"]).has(attachment.lifecycle) || attachment.staged_locator_digest !== expected || state.tasks.some((task) => task.attachment_id === attachment.attachment_id) || state.task_intents.some((task) => task.attachment_id === attachment.attachment_id)) throw providerError("RECOVERY_PRECONDITION_FAILED", "only an unclaimed staged filesystem locator can be cleaned");
  const pending = appendAuthority(discovery, records, { commandId: `${input.commandId}:cleanup-pending`, kind: "attachment_staged_locator_cleanup_pending", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, locator_digest: expected, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority);
  const locator = readLocator(discovery.root_path); if (locator.length) { if (locator.length !== 1 || locator[0].state !== "staged" || locator[0].record_digest !== expected) throw providerError("RECOVERY_PRECONDITION_FAILED", "filesystem locator is not the exact staged artifact"); fs.unlinkSync(locatorPath(discovery.root_path)); syncDirectory(discovery.root_path); } else if (attachment.lifecycle !== "staging") throw providerError("RECOVERY_PRECONDITION_FAILED", "staged locator is absent after publication began");
  const final = appendAuthority(discovery, records, { commandId: input.commandId, kind: "attachment_staged_locator_cleaned", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: pending.record_digest } }, runtime.evolveAllCurrentAuthority);
  return { command_id: input.commandId, locator_digest: expected, receipt_digest: final.record_digest };
}
function reattachFilesystem(discovery, state, records, input, attachment, runtime) {
  if (records.some((record) => record.kind === "attachment_fork_intent" && record.payload.attachment_id === attachment.attachment_id && !findCommand(records, record.command_id.slice(0, -":intent".length)))) throw providerError("RECOVERY_REQUIRED", "an earlier identity fork must complete before reattach");
  const prior = recoveryDigest(input.expectedLocatorDigest, "--expect-locator-digest"); const epoch = recoveryEpoch(input.expectedEpoch); const priorPending = findCommand(records, input.commandId + ":reattach-pending"); if (priorPending) { const payload = priorPending.payload; if (priorPending.kind !== "attachment_reattach_pending" || payload.authority_id !== state.authority_id || payload.attachment_id !== attachment.attachment_id || payload.previous_final_digest !== attachment.final_record_digest || payload.previous_epoch !== epoch || payload.previous_claim_token_digest !== sha256Hex(locatorTokenForFilesystem(discovery, prior)) || payload.prior_locator_digest !== prior || payload.granted_by !== input.grantedBy || payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "reattach command id conflicts with its durable pending intent"); const locator = readLocator(discovery.root_path); const claimed = locatorRecord({ sequence: locator.at(-1)?.record_digest === prior ? locator.length + 1 : locator.length, previousDigest: prior, state: "claimed", authorityId: state.authority_id, attachmentId: attachment.attachment_id, claimToken: payload.claim_token, claimEpoch: payload.claim_epoch, anchorId: payload.anchor_id, rootPath: payload.root_path }); if (claimed.record_digest !== payload.claimed_locator_digest) throw providerError("AUTHORITY_CORRUPT", "reattach pending intent cannot reproduce its locator"); const current = locator.at(-1); if (current?.record_digest === prior) appendDurably(locatorPath(discovery.root_path), Buffer.from(canonicalJson(claimed) + "\n")); else if (current?.record_digest !== claimed.record_digest) throw providerError("RECOVERY_PRECONDITION_FAILED", "filesystem locator changed outside reattach recovery"); const final = appendAuthority(discovery, records, { commandId: input.commandId, kind: "attachment_reattached", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: priorPending.record_digest, locator_digest: claimed.record_digest } }, runtime.evolveAllCurrentAuthority); return { command_id: input.commandId, attachment_id: attachment.attachment_id, previous_epoch: epoch, claim_epoch: payload.claim_epoch, locator_digest: claimed.record_digest, receipt_digest: final.record_digest }; }
  if (attachment.claim_epoch !== epoch || attachment.claimed_locator_digest !== prior || attachment.claim_token_digest !== sha256Hex(locatorTokenForFilesystem(discovery, attachment.staged_locator_digest))) throw providerError("RECOVERY_PRECONDITION_FAILED", "filesystem reattach optimistic proof changed");
  if (attachment.lifecycle === "claimed" && attachment.anchor_id !== discovery.anchor_id) appendAuthority(discovery, records, { commandId: `${input.commandId}:collision`, kind: "attachment_collision_detected", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, claim_epoch: epoch, locator_digest: prior, observed_anchor_id: discovery.anchor_id } }, runtime.evolveAllCurrentAuthority);
  state = runtime.evolveAllCurrentAuthority(null, records); attachment = filesystemAttachment(state, attachment.attachment_id);
  if (!new Set(["collision", "claimed"]).has(attachment.lifecycle) || attachment.lifecycle === "claimed" && attachment.anchor_id === discovery.anchor_id) throw providerError("RECOVERY_NOT_REQUIRED", "filesystem reattach requires an explicit collision or unavailable old root");
  const locator = readLocator(discovery.root_path); if (locator.at(-1)?.record_digest !== prior) throw providerError("RECOVERY_PRECONDITION_FAILED", "selected filesystem locator does not carry expected old claim");
  const token = randomUUID(); const claimed = locatorRecord({ sequence: locator.length + 1, previousDigest: prior, state: "claimed", authorityId: state.authority_id, attachmentId: attachment.attachment_id, claimToken: token, claimEpoch: epoch + 1, anchorId: discovery.anchor_id, rootPath: discovery.root_path });
  const pending = appendAuthority(discovery, records, { commandId: `${input.commandId}:reattach-pending`, kind: "attachment_reattach_pending", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, previous_final_digest: attachment.final_record_digest, previous_epoch: epoch, previous_claim_token_digest: attachment.claim_token_digest, claim_token: token, claim_epoch: epoch + 1, anchor_id: discovery.anchor_id, prior_locator_digest: prior, claimed_locator_digest: claimed.record_digest, root_path: discovery.root_path, control_path: discovery.authority_root, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority);
  appendDurably(locatorPath(discovery.root_path), Buffer.from(`${canonicalJson(claimed)}\n`));
  const final = appendAuthority(discovery, records, { commandId: input.commandId, kind: "attachment_reattached", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, pending_record_digest: pending.record_digest, locator_digest: claimed.record_digest } }, runtime.evolveAllCurrentAuthority);
  return { command_id: input.commandId, attachment_id: attachment.attachment_id, previous_epoch: epoch, claim_epoch: epoch + 1, locator_digest: claimed.record_digest, receipt_digest: final.record_digest };
}
function assertFilesystemRecoveryReplay(records, input, existing) { const attachmentId = existing.payload.attachment_id; if (input.action === "recover") { const intent = findCommand(records, input.commandId + ":recovery-intent"); if (!intent || intent.kind !== "attachment_recovery_intent" || intent.payload.attachment_id !== attachmentId || intent.payload.claim_epoch !== recoveryEpoch(input.expectedEpoch) || intent.payload.pending_record_digest !== recoveryDigest(input.expectedPendingDigest, "--expect-pending-digest") || intent.payload.expected_locator_digest !== recoveryDigest(input.expectedLocatorDigest, "--expect-locator-digest") || intent.payload.granted_by !== input.grantedBy || intent.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "recovery replay input differs from its durable intent"); } else if (input.action === "cleanup") { const pending = findCommand(records, input.commandId + ":cleanup-pending"); if (!pending || pending.kind !== "attachment_staged_locator_cleanup_pending" || pending.payload.attachment_id !== attachmentId || pending.payload.locator_digest !== recoveryDigest(input.expectedLocatorDigest, "--expect-locator-digest") || pending.payload.granted_by !== input.grantedBy || pending.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "cleanup replay input differs from its durable intent"); } else { const pending = findCommand(records, input.commandId + ":reattach-pending"); if (!pending || pending.kind !== "attachment_reattach_pending" || pending.payload.attachment_id !== attachmentId || pending.payload.previous_epoch !== recoveryEpoch(input.expectedEpoch) || pending.payload.prior_locator_digest !== recoveryDigest(input.expectedLocatorDigest, "--expect-locator-digest") || pending.payload.granted_by !== input.grantedBy || pending.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "reattach replay input differs from its durable intent"); } }


function recoverCurrentFilesystemAttachment(input, runtime) {
  explicitFilesystemRecoveryInput(input, new Set(["recover", "cleanup", "reattach"])); const discovery = nonempty(input.authorityId) ? discoveryFromAuthorityId(input.authorityId, runtime) : recoveryFilesystemDiscovery(input.target); const lockManager = lockManagerFor(discovery, runtime.createLockManager); let receipt;
  lockManager.withLock("authority", discovery.authority_root, () => { const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); const state = runtime.evolveAllCurrentAuthority(null, records); const attachment = filesystemAttachment(state, input.attachmentId); const existing = findCommand(records, input.commandId); if (existing) { const expectedKind = input.action === "recover" ? "attachment_recovery_completed" : input.action === "cleanup" ? "attachment_staged_locator_cleaned" : "attachment_reattached"; if (existing.kind !== expectedKind) throw providerError("COMMAND_CONFLICT", "recovery command id is already bound to another operation"); assertFilesystemRecoveryReplay(records, input, existing); receipt = { command_id: input.commandId, receipt_digest: existing.record_digest, replayed: true }; } else receipt = input.action === "recover" ? recoverFilesystemPending(discovery, state, records, input, attachment, runtime) : input.action === "cleanup" ? cleanupFilesystemStaged(discovery, state, records, input, attachment, runtime) : reattachFilesystem(discovery, state, records, input, attachment, runtime); writeSnapshot(refreshedFilesystemDiscovery(discovery), project(refreshedFilesystemDiscovery(discovery), runtime.evolveAllCurrentAuthority, records)); });
  const refreshed = refreshedFilesystemDiscovery(discovery);
  return { ...project(refreshed, runtime.evolveAllCurrentAuthority), recovery: receipt, storage: { authority_root: refreshed.authority_root, locator_path: locatorPath(refreshed.root_path) } };
}
function abandonStagedFilesystemAuthority(input, runtime) {
  if (!nonempty(input.authorityId) || !nonempty(input.commandId) || input.grantedBy !== "user" || !nonempty(input.reason)) throw providerError("RECOVERY_AUTHORIZATION_REQUIRED", "staged authority abandonment requires exact user provenance and command identity");
  const discovery = discoveryFromAuthorityId(input.authorityId, runtime); const lockManager = lockManagerFor(discovery, runtime.createLockManager); let receipt;
  lockManager.withLock("authority", discovery.authority_root, () => { const records = readAuthority(discovery, runtime.evolveAllCurrentAuthority); const state = runtime.evolveAllCurrentAuthority(null, records); const genesis = records[0]; const expected = recoveryDigest(input.expectedGenesisDigest, "--expect-genesis-digest"); if (genesis.record_digest !== expected || state.provider !== "filesystem_detached" || state.tasks.length || state.task_intents.length || state.attachments.some((item) => !new Set(["staging", "staged", "cleanup_pending", "cleaned"]).has(item.lifecycle))) throw providerError("RECOVERY_PRECONDITION_FAILED", "authority is not an abandonable staging shard"); const record = appendAuthority(discovery, records, { commandId: input.commandId, kind: "authority_staging_abandoned", payload: { authority_id: state.authority_id, genesis_digest: expected, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority); receipt = { command_id: input.commandId, receipt_digest: record.record_digest, authority_lifecycle: "abandoned" }; writeSnapshot(discovery, project(discovery, runtime.evolveAllCurrentAuthority, records)); });
  return receipt;
}

function reconcileFilesystemLocatorCollision(discovery, records, runtime) {
  const state = records.length ? runtime.evolveAllCurrentAuthority(null, records) : null; if (!state) return state;
  const attachment = state.attachments.find((item) => item.attachment_id === discovery.locator?.attachment_id) ?? null;
  if (attachment?.lifecycle === "claimed" && discovery.locator?.state === "claimed" && discovery.locator.authority_id === state.authority_id && discovery.locator.attachment_id === attachment.attachment_id && discovery.locator.claim_epoch === attachment.claim_epoch && discovery.locator.record_digest === attachment.claimed_locator_digest && discovery.locator.anchor_id !== discovery.anchor_id) {
    appendAuthority(discovery, records, { commandId: `collision:${attachment.attachment_id}:${discovery.locator.record_digest}:${discovery.anchor_id}`, kind: "attachment_collision_detected", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, claim_epoch: attachment.claim_epoch, locator_digest: discovery.locator.record_digest, observed_anchor_id: discovery.anchor_id } }, runtime.evolveAllCurrentAuthority);
    return runtime.evolveAllCurrentAuthority(null, records);
  }
  return state;
}

function refreshedFilesystemDiscovery(discovery) { return Object.freeze({ ...discovery, locator: readLocator(discovery.root_path).at(-1) ?? discovery.locator }); }

function forkCurrentFilesystemIdentity(input, runtime) {
  if (!nonempty(input.target) || !nonempty(input.commandId) || input.grantedBy !== "user" || !nonempty(input.reason) || !/^sha256:[0-9a-f]{64}$/u.test(String(input.expectedLocatorDigest ?? "")) || !Number.isSafeInteger(Number(input.expectedEpoch)) || Number(input.expectedEpoch) < 1) throw providerError("RECOVERY_AUTHORIZATION_REQUIRED", "identity fork requires exact user provenance and optimistic source proof");
  const selected = recoveryFilesystemDiscovery(input.target); let source = selected; const selectedRecords = readAuthority(selected, runtime.evolveAllCurrentAuthority); const selectedFork = findCommand(selectedRecords, input.commandId + ":destination"); if (selectedFork) { const payload = selectedFork.payload; if (selectedFork.kind !== "attachment_forked" || payload.source_attachment_id !== input.attachmentId || payload.source_locator_digest !== input.expectedLocatorDigest || payload.granted_by !== input.grantedBy || payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "fork replay input differs from its destination receipt"); source = discoveryFromAuthorityId(payload.source_authority_id, runtime); } const sourceLocks = lockManagerFor(source, runtime.createLockManager); let intentPayload; let sourceState;
  sourceLocks.withLock("authority", source.authority_root, () => { const records = readAuthority(source, runtime.evolveAllCurrentAuthority); sourceState = runtime.evolveAllCurrentAuthority(null, records); const attachment = filesystemAttachment(sourceState, input.attachmentId); const prior = findCommand(records, `${input.commandId}:intent`); if (prior) { if (prior.kind !== "attachment_fork_intent" || prior.payload.attachment_id !== input.attachmentId || prior.payload.expected_epoch !== Number(input.expectedEpoch) || prior.payload.expected_locator_digest !== input.expectedLocatorDigest || prior.payload.granted_by !== input.grantedBy || prior.payload.reason !== input.reason) throw providerError("COMMAND_CONFLICT", "fork replay input differs from its durable intent"); intentPayload = prior.payload; return; } if (attachment.lifecycle !== "collision" || attachment.claim_epoch !== Number(input.expectedEpoch) || attachment.claimed_locator_digest !== input.expectedLocatorDigest || attachment.claim_token_digest !== sha256Hex(locatorTokenForFilesystem(source, input.expectedLocatorDigest))) throw providerError("RECOVERY_PRECONDITION_FAILED", "identity fork requires an unresolved collision with the exact source proof"); const locator = readLocator(selected.root_path).at(-1); if (locator?.record_digest !== input.expectedLocatorDigest) throw providerError("RECOVERY_PRECONDITION_FAILED", "selected source locator changed"); intentPayload = { authority_id: sourceState.authority_id, attachment_id: attachment.attachment_id, expected_epoch: attachment.claim_epoch, expected_locator_digest: attachment.claimed_locator_digest, new_authority_id: randomUUID(), new_attachment_id: randomUUID(), new_claim_token: randomUUID(), selected_anchor_id: selected.anchor_id, granted_by: input.grantedBy, reason: input.reason }; appendAuthority(source, records, { commandId: `${input.commandId}:intent`, kind: "attachment_fork_intent", payload: intentPayload }, runtime.evolveAllCurrentAuthority); });
  const locator = readLocator(selected.root_path); const prior = locator.find((record) => record.record_digest === intentPayload.expected_locator_digest) ?? null; if (!prior) throw providerError("RECOVERY_PRECONDITION_FAILED", "fork locator no longer contains its source claim");
  const destination = Object.freeze({ provider: "filesystem_detached", target: selected.target, root_path: selected.root_path, anchor_id: selected.anchor_id, authority_root: authorityRoot(intentPayload.new_authority_id), attachment_root: selected.root_path, locator: prior, authority_id: intentPayload.new_authority_id }); const destinationLocks = lockManagerFor(destination, runtime.createLockManager); let forked;
  destinationLocks.withLock("authority", destination.authority_root, () => { const records = readAuthority(destination, runtime.evolveAllCurrentAuthority); let state = records.length ? runtime.evolveAllCurrentAuthority(null, records) : null; if (!state) { appendAuthority(destination, records, { commandId: "authority:genesis", kind: "authority_genesis", payload: { authority_id: intentPayload.new_authority_id, provider: "filesystem_detached" } }, runtime.evolveAllCurrentAuthority); state = runtime.evolveAllCurrentAuthority(null, records); } if (state.authority_id !== intentPayload.new_authority_id || state.provider !== "filesystem_detached") throw providerError("FORK_DESTINATION_CONFLICT", "fork destination is not the reserved detached authority"); const claimed = locatorRecord({ sequence: prior.sequence + 1, previousDigest: prior.record_digest, state: "claimed", authorityId: intentPayload.new_authority_id, attachmentId: intentPayload.new_attachment_id, claimToken: intentPayload.new_claim_token, claimEpoch: 1, anchorId: selected.anchor_id, rootPath: selected.root_path }); forked = appendAuthority(destination, records, { commandId: `${input.commandId}:destination`, kind: "attachment_forked", payload: { authority_id: intentPayload.new_authority_id, attachment_id: intentPayload.new_attachment_id, source_authority_id: intentPayload.authority_id, source_attachment_id: intentPayload.attachment_id, source_locator_digest: prior.record_digest, claim_token: intentPayload.new_claim_token, claim_epoch: 1, anchor_id: selected.anchor_id, claimed_locator_digest: claimed.record_digest, root_path: selected.root_path, control_path: destination.authority_root, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority); const current = readLocator(selected.root_path).at(-1); if (current.record_digest === prior.record_digest) appendDurably(locatorPath(selected.root_path), Buffer.from(`${canonicalJson(claimed)}\n`)); else if (current.record_digest !== claimed.record_digest) throw providerError("FORK_DESTINATION_CONFLICT", "selected locator changed during fork"); writeSnapshot(destination, project(Object.freeze({ ...destination, locator: readLocator(selected.root_path).at(-1) }), runtime.evolveAllCurrentAuthority, records)); });
  sourceLocks.withLock("authority", source.authority_root, () => { const records = readAuthority(source, runtime.evolveAllCurrentAuthority); const state = runtime.evolveAllCurrentAuthority(null, records); const attachment = filesystemAttachment(state, intentPayload.attachment_id); const priorResolution = findCommand(records, input.commandId); if (priorResolution) { if (priorResolution.kind !== "attachment_identity_forked") throw providerError("COMMAND_CONFLICT", "fork command id is already bound"); return; } if (attachment.lifecycle !== "collision") throw providerError("RECOVERY_PRECONDITION_FAILED", "source collision was resolved by another command"); appendAuthority(source, records, { commandId: input.commandId, kind: "attachment_identity_forked", payload: { authority_id: state.authority_id, attachment_id: attachment.attachment_id, forked_attachment_id: intentPayload.new_attachment_id, forked_authority_id: intentPayload.new_authority_id, source_locator_digest: intentPayload.expected_locator_digest, granted_by: input.grantedBy, reason: input.reason } }, runtime.evolveAllCurrentAuthority); writeSnapshot(source, project(source, runtime.evolveAllCurrentAuthority, records)); });
  const refreshed = recoveryFilesystemDiscovery(input.target); return { ...project(refreshed, runtime.evolveAllCurrentAuthority), recovery: { command_id: input.commandId, forked_authority_id: intentPayload.new_authority_id, forked_attachment_id: intentPayload.new_attachment_id, destination_digest: forked.record_digest }, storage: { authority_root: refreshed.authority_root, locator_path: locatorPath(refreshed.root_path) } };
}

function locatorTokenForFilesystem(discovery, digest) { const record = readLocator(discovery.root_path).find((item) => item.record_digest === digest) ?? null; if (!record || !nonempty(record.claim_token)) throw providerError("RECOVERY_PRECONDITION_FAILED", "selected locator does not carry the expected claim token"); return record.claim_token; }
