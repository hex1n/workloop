import fs from "node:fs";
import path from "node:path";

import { STATE_DIR, isPlainObject, withOwnedDirectoryLock } from "./prims.mjs";

const EVIDENCE_FILE = "untracked-observations.jsonl";
const EVIDENCE_SEQUENCE_FILE = "evidence-sequences.json";
const EVIDENCE_LOCK_DIR = "evidence-ledger.lock";
const EVIDENCE_LOSS_DIR = "evidence-loss";
const EVIDENCE_LOCK_TIMEOUT_MS = 5000;
const EVIDENCE_LOCK_STALE_MS = 30000;
const EVIDENCE_MAX_BYTES = 1024 * 1024;
const EVIDENCE_RETAIN_BYTES = 512 * 1024;
const EVIDENCE_MAX_RECORD_BYTES = 64 * 1024;
const PRETOOLUSE_KINDS = new Set(["actor_anchor", "pretooluse_observation", "untracked_write"]);

function evidencePath(repo) {
  return path.join(repo, STATE_DIR, EVIDENCE_FILE);
}

function sequencePath(repo) {
  return path.join(repo, STATE_DIR, EVIDENCE_SEQUENCE_FILE);
}

function lockPath(repo) {
  return path.join(repo, STATE_DIR, EVIDENCE_LOCK_DIR);
}

function recordKnownEvidenceLoss(repo, error) {
  try {
    const directory = path.join(repo, STATE_DIR, EVIDENCE_LOSS_DIR);
    fs.mkdirSync(directory, { recursive: true });
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const target = path.join(directory, `${Date.now()}-${process.pid}-${suffix}.json`);
      try {
        fs.writeFileSync(target, JSON.stringify({ at: new Date().toISOString(), reason: error?.message ?? String(error) }) + "\n", { encoding: "utf8", flag: "wx" });
        return;
      } catch (writeError) { if (writeError?.code !== "EEXIST") return; }
    }
  } catch { /* loss telemetry itself degrades open */ }
}

function knownEvidenceLosses(repo) {
  try { return fs.readdirSync(path.join(repo, STATE_DIR, EVIDENCE_LOSS_DIR)).filter((name) => name.endsWith(".json")).length; }
  catch (error) { return error?.code === "ENOENT" ? 0 : 1; }
}

// The telemetry lock rides the shared directory-lock implementation with
// degrade-open policy: a failed owner write removes the half-acquired lock so
// the next hook is never blocked by this session's debris, and release errors
// are swallowed because the ledger must never break the tool call.
function withEvidenceLock(repo, action, { timeoutMs = EVIDENCE_LOCK_TIMEOUT_MS } = {}) {
  return withOwnedDirectoryLock(lockPath(repo), action, {
    timeoutMs,
    staleMs: EVIDENCE_LOCK_STALE_MS,
    removeOnOwnerWriteFailure: true,
    timeoutError: () => new Error("evidence ledger lock timeout"),
    onReleaseError: () => { /* telemetry lock cleanup degrades open */ },
  });
}

function validEvidenceRecord(row) {
  return isPlainObject(row)
    && row.schema_version === 1
    && Number.isSafeInteger(row.seq)
    && row.seq >= 1
    && typeof row.kind === "string"
    && Number.isFinite(Date.parse(row.at));
}

function writeEvidenceState(repo, state) {
  const temporary = `${sequencePath(repo)}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, sequencePath(repo));
}

function rebuildEvidenceState(repo) {
  const rows = readEvidence(repo);
  const lossy = foldEvidence(rows).coverage === "gapped";
  const state = { sequences: {}, pretooluse_sessions: {}, pretooluse_index_complete: !lossy, pretooluse_index_lossy: lossy };
  for (const row of rows) {
    const existingKey = row.sequence_session ?? row.acting_session ?? "<control>";
    state.sequences[existingKey] = Math.max(state.sequences[existingKey] ?? 0, row.seq);
    if (PRETOOLUSE_KINDS.has(row.kind)) state.pretooluse_sessions[existingKey] = true;
  }
  return state;
}

function reserveEvidenceSequence(repo, key) {
  let state;
  try {
    const parsed = JSON.parse(fs.readFileSync(sequencePath(repo), "utf8"));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.sequences)) throw new Error("invalid evidence sequence state");
    if (isPlainObject(parsed.pretooluse_sessions) && typeof parsed.pretooluse_index_complete === "boolean" && typeof parsed.pretooluse_index_lossy === "boolean") state = parsed;
    else {
      state = rebuildEvidenceState(repo);
      for (const [session, value] of Object.entries(parsed.sequences)) {
        if (Number.isSafeInteger(value) && value >= 0) state.sequences[session] = Math.max(state.sequences[session] ?? 0, value);
      }
    }
  } catch {
    // The counter is scratch, never evidence. Rebuild it from the append-only
    // stream after absence or corruption; the locked rewrite repairs it.
    try { state = rebuildEvidenceState(repo); }
    catch { state = { sequences: {}, pretooluse_sessions: {}, pretooluse_index_complete: false, pretooluse_index_lossy: false }; }
  }
  const prior = Number.isSafeInteger(state.sequences[key]) && state.sequences[key] >= 0 ? state.sequences[key] : 0;
  const seq = prior + 1;
  state.sequences[key] = seq;
  // Persist the reservation before the row by design. If telemetry cannot be
  // appended, that hook observation is missing evidence; reusing its number
  // would falsely claim continuous coverage. The next durable row exposes the
  // loss as a sequence gap, even when the loss came from a benign I/O failure.
  writeEvidenceState(repo, state);
  return { seq, state };
}

function repairEvidenceTail(repo) {
  const target = evidencePath(repo);
  let descriptor;
  try { descriptor = fs.openSync(target, "r+"); }
  catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
  try {
    const size = fs.fstatSync(descriptor).size;
    if (!size) return 0;
    const last = Buffer.allocUnsafe(1);
    fs.readSync(descriptor, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    const chunkSize = 64 * 1024;
    let cursor = size; let newlineAt = -1; const chunks = [];
    while (cursor > 0 && newlineAt < 0) {
      const start = Math.max(0, cursor - chunkSize);
      const chunk = Buffer.allocUnsafe(cursor - start);
      fs.readSync(descriptor, chunk, 0, chunk.length, start);
      const local = chunk.lastIndexOf(0x0a);
      chunks.unshift(local >= 0 ? chunk.subarray(local + 1) : chunk);
      if (local >= 0) newlineAt = start + local;
      cursor = start;
    }
    const tail = Buffer.concat(chunks).toString("utf8");
    let row = null;
    try { row = JSON.parse(tail); } catch { /* torn tail */ }
    if (validEvidenceRecord(row)) {
      fs.writeSync(descriptor, "\n", size, "utf8");
      return 0;
    }
    fs.ftruncateSync(descriptor, newlineAt + 1);
    return 1;
  } finally { fs.closeSync(descriptor); }
}

function compactEvidenceIfNeeded(repo) {
  const target = evidencePath(repo);
  let size;
  try { size = fs.statSync(target).size; }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (size <= EVIDENCE_MAX_BYTES) return;
  const rows = readEvidence(repo);
  const retained = []; let retainedBytes = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const line = JSON.stringify(rows[index]) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > EVIDENCE_MAX_RECORD_BYTES || retainedBytes + bytes > EVIDENCE_RETAIN_BYTES) continue;
    retained.unshift(line); retainedBytes += bytes;
  }
  const skipped = rows.integrity ?? { corrupt_rows: 0, unknown_schema_rows: 0 };
  const droppedRecords = rows.length - retained.length + skipped.corrupt_rows + skipped.unknown_schema_rows;
  const marker = JSON.stringify({
    schema_version: 1,
    at: new Date().toISOString(),
    kind: "history_truncated",
    sequence_session: `<compaction:${Date.now()}:${process.pid}>`,
    seq: 1,
    dropped_records: droppedRecords,
  }) + "\n";
  const temporary = `${target}.${process.pid}.compact.tmp`;
  fs.writeFileSync(temporary, marker + retained.join(""), "utf8");
  fs.renameSync(temporary, target);
}

function appendEvidence(repo, record, { timeoutMs = EVIDENCE_LOCK_TIMEOUT_MS } = {}) {
  let sequenceReserved = false;
  try {
    fs.mkdirSync(path.join(repo, STATE_DIR), { recursive: true });
    try { fs.writeFileSync(path.join(repo, STATE_DIR, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" }); } catch {}
    return withEvidenceLock(repo, () => {
      const sequenceSession = typeof record.sequence_session === "string" && record.sequence_session
        ? record.sequence_session
        : typeof record.acting_session === "string" && record.acting_session ? record.acting_session : "<control>";
      const { seq, state } = reserveEvidenceSequence(repo, sequenceSession);
      sequenceReserved = true;
      const pretooluseIndexWasComplete = state.pretooluse_index_complete === true;
      if (PRETOOLUSE_KINDS.has(record.kind)) {
        // A failed PreToolUse append must make the fast index unknown. Claiming
        // completeness after dropping that row would turn absence into evidence.
        state.pretooluse_index_complete = false;
        writeEvidenceState(repo, state);
      }
      const recoveredTornRows = repairEvidenceTail(repo);
      try { compactEvidenceIfNeeded(repo); }
      catch {
        try {
          if (fs.statSync(evidencePath(repo)).size > EVIDENCE_MAX_BYTES) {
            if (PRETOOLUSE_KINDS.has(record.kind)) recordKnownEvidenceLoss(repo, new Error("evidence compaction refused a PreToolUse row"));
            return false;
          }
        } catch (error) {
          if (PRETOOLUSE_KINDS.has(record.kind)) recordKnownEvidenceLoss(repo, error);
          return false;
        }
      }
      const row = { schema_version: 1, ...record, sequence_session: sequenceSession, seq, ...(recoveredTornRows ? { recovered_torn_rows: recoveredTornRows } : {}) };
      const line = JSON.stringify(row) + "\n";
      if (Buffer.byteLength(line, "utf8") > EVIDENCE_MAX_RECORD_BYTES) {
        if (PRETOOLUSE_KINDS.has(record.kind)) recordKnownEvidenceLoss(repo, new Error("oversized PreToolUse evidence row"));
        return false;
      }
      fs.appendFileSync(evidencePath(repo), line, "utf8");
      if (PRETOOLUSE_KINDS.has(row.kind)) {
        state.pretooluse_sessions[sequenceSession] = true;
        state.pretooluse_index_complete = pretooluseIndexWasComplete;
        writeEvidenceState(repo, state);
      }
      try { compactEvidenceIfNeeded(repo); } catch { /* the durable row remains; a later append retries compaction */ }
      return true;
    }, { timeoutMs });
  } catch (error) {
    if (!sequenceReserved || PRETOOLUSE_KINDS.has(record.kind)) recordKnownEvidenceLoss(repo, error);
    return false;
  }
}

function readEvidence(repo) {
  let text = "";
  try { text = fs.readFileSync(evidencePath(repo), "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const rows = []; let corruptRows = 0; let unknownSchemaRows = 0;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { corruptRows += 1; continue; }
    if (isPlainObject(row) && row.schema_version !== 1) { unknownSchemaRows += 1; continue; }
    if (!validEvidenceRecord(row)) { corruptRows += 1; continue; }
    rows.push(row);
  }
  // The array interface is the module's public seam, so the loss counters ride
  // as a non-enumerable side property. Hazard: any map/filter copy silently
  // drops it, which is why foldEvidence also accepts integrity as an explicit
  // argument — pass it when the rows array is anything but this direct result.
  Object.defineProperty(rows, "integrity", { value: { corrupt_rows: corruptRows, unknown_schema_rows: unknownSchemaRows, known_lost_rows: knownEvidenceLosses(repo) }, enumerable: false });
  return rows;
}

function pretooluseEvidenceState(repo, sequenceSession) {
  try {
    const state = JSON.parse(fs.readFileSync(sequencePath(repo), "utf8"));
    if (!isPlainObject(state) || !isPlainObject(state.pretooluse_sessions) || state.pretooluse_index_complete !== true) return "unknown";
    return state.pretooluse_sessions[sequenceSession] === true;
  } catch (error) {
    return error?.code === "ENOENT" && !fs.existsSync(evidencePath(repo)) ? false : "unknown";
  }
}

function foldEvidence(rows, integrity = rows.integrity ?? null) {
  const bySession = new Map(); const gaps = []; const resets = [];
  for (const row of rows) {
    const key = row.sequence_session ?? row.acting_session ?? "<control>";
    const previous = bySession.get(key) ?? 0;
    if (previous && row.seq <= previous) resets.push({ acting_session: key, previous, next: row.seq });
    else if (previous && row.seq > previous + 1) gaps.push({ acting_session: key, from: previous + 1, to: row.seq - 1 });
    else if (!previous && row.seq > 1) gaps.push({ acting_session: key, from: 1, to: row.seq - 1 });
    bySession.set(key, row.seq);
  }
  const transitions = rows.filter((row) => row.kind === "hook_transition");
  const lastTransition = transitions.at(-1) ?? null;
  const censuses = rows.filter((row) => row.kind === "stop_census");
  const lastCensus = censuses.at(-1) ?? null;
  const censusIsCurrent = Boolean(lastCensus && (!lastTransition || rows.indexOf(lastCensus) > rows.indexOf(lastTransition)));
  const corruptRows = integrity?.corrupt_rows ?? 0;
  const unknownSchemaRows = integrity?.unknown_schema_rows ?? 0;
  const knownLostRows = integrity?.known_lost_rows ?? 0;
  const historyTruncatedRecords = rows.filter((row) => row.kind === "history_truncated").reduce((sum, row) => sum + (Number.isSafeInteger(row.dropped_records) ? row.dropped_records : 0), 0);
  const recoveredTornRows = rows.reduce((sum, row) => sum + (Number.isSafeInteger(row.recovered_torn_rows) ? row.recovered_torn_rows : 0), 0);
  const damaged = corruptRows || unknownSchemaRows || knownLostRows || historyTruncatedRecords || recoveredTornRows || resets.length || gaps.length;
  return {
    record_count: rows.length,
    corrupt_rows: corruptRows,
    unknown_schema_rows: unknownSchemaRows,
    known_lost_rows: knownLostRows,
    history_truncated_records: historyTruncatedRecords,
    recovered_torn_rows: recoveredTornRows,
    pretooluse_armed: censusIsCurrent
      ? (lastCensus.pretooluse_armed === true ? true : lastCensus.pretooluse_armed === false ? false : "unknown")
      : "unknown",
    mode: censusIsCurrent ? (lastCensus.mode ?? "unknown") : "unknown",
    transitions,
    censuses,
    sequence_gaps: gaps,
    sequence_resets: resets,
    coverage: damaged ? "gapped" : censusIsCurrent && lastCensus.pretooluse_armed === true ? "covered" : "unknown",
  };
}

export { EVIDENCE_FILE, EVIDENCE_LOCK_DIR, EVIDENCE_LOSS_DIR, EVIDENCE_MAX_BYTES, EVIDENCE_SEQUENCE_FILE, appendEvidence, evidencePath, foldEvidence, pretooluseEvidenceState, readEvidence };
