// Per-authority, disposable outcome projection.
//
// This module owns only observation shards.  Authority providers pass it a
// projection that they have already derived from verified authority records;
// it never reads, validates, repairs, or writes an authority journal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalJson, sha256Hex } from "./prims.mjs";

const OUTCOME_SCHEMA_VERSION = 1;
const AUTHORITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function controlHome() {
  return path.resolve(process.env.WORKLOOP_AUTHORITY_HOME || path.join(os.homedir(), ".workloop"));
}

function assertAuthorityId(authorityId) {
  if (!AUTHORITY_ID.test(String(authorityId ?? ""))) throw new Error("outcome projection requires a UUID authority id");
  return String(authorityId).toLowerCase();
}

function outcomeDirectory(authorityId) {
  return path.join(controlHome(), "outcomes", assertAuthorityId(authorityId));
}

function outcomePaths(authorityId) {
  const directory = outcomeDirectory(authorityId);
  return Object.freeze({ directory, outcome_path: path.join(directory, "outcome.json"), cursor_path: path.join(directory, "cursor.json") });
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort temp cleanup */ }
  }
}

function taskRows(value) {
  const rows = value.provider === "git_common" ? value.repository_tasks : value.filesystem_tasks;
  if (!Array.isArray(rows)) throw new Error("verified authority projection has no task rows");
  if (value.provider === "git_common") return rows.filter((row) => row?.task).map((row) => ({ ...row.task, attachment_availability: row.availability, attachment_path_status: row.path_status }));
  const attachments = new Map((value.filesystem_attachments ?? []).map((attachment) => [attachment.attachment_id, attachment]));
  return rows.map((task) => {
    const attachment = attachments.get(task.attachment_id) ?? null;
    return { ...task, attachment_availability: attachment?.availability ?? "unavailable", attachment_path_status: attachment?.path_status ?? "unavailable" };
  });
}

function outcomeValue(value) {
  const authorityId = assertAuthorityId(value?.authority_id);
  if (!new Set(["git_common", "filesystem_detached"]).has(value?.provider)) throw new Error("outcome projection has unsupported provider");
  if (!Number.isSafeInteger(value?.authority_sequence) || value.authority_sequence < 1) throw new Error("outcome projection requires verified positive source sequence");
  return Object.freeze({ outcome_schema_version: OUTCOME_SCHEMA_VERSION, authority_id: authorityId, provider: value.provider, source_sequence: value.authority_sequence, tasks: taskRows(value) });
}

function publishAuthorityOutcome(value, { createLockManager }) {
  if (typeof createLockManager !== "function") throw new Error("outcome projection requires a lock manager factory");
  const outcome = outcomeValue(value);
  const paths = outcomePaths(outcome.authority_id);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const locks = createLockManager({
    resolveLockPath: ({ lockClass, resourceId }) => {
      if (lockClass !== "outcome" || resourceId !== outcome.authority_id) throw new Error("outcome publisher accepts only its own outcome lock");
      return path.join(paths.directory, ".outcome.lock");
    },
    optionsForLock: () => ({ timeoutMs: 15_000, staleMs: 5_000 }),
  });
  locks.withLock("outcome", outcome.authority_id, () => {
    atomicWrite(paths.outcome_path, outcome);
    atomicWrite(paths.cursor_path, { authority_id: outcome.authority_id, provider: outcome.provider, source_sequence: outcome.source_sequence, outcome_digest: sha256Hex(canonicalJson(outcome)) });
  });
  return Object.freeze({ ...paths, source_sequence: outcome.source_sequence });
}

export { outcomePaths, publishAuthorityOutcome };
