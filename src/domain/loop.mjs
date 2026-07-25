// The loop service: the verbs a host drives.
//
// One call advances one transition. There is no background runner, no timer,
// and no path by which this file executes the work it asks for — it decides
// what the next legal step is and records what came back.
import fs from "node:fs";
import path from "node:path";
import { digestOf, sha256Hex } from "../canonical.mjs";
import { CLASSES } from "../locks.mjs";
import { caseInsensitiveVolume, controlPlanePaths, realOf } from "../site.mjs";
import { openStore } from "../store.mjs";
import { runCriterion } from "./criterion.mjs";
import { LoopError, refuse } from "./error.mjs";
import { decide, nextDirective, progressSignature } from "./policy.mjs";
import { DEPENDENCY, assertEdges, claimConflicts, dependencyState, ready as readyLoops } from "./graph.mjs";
import { EMPTY, EMPTY_STORE, isLive, reduceLoop, reduceStore, roundsSpent } from "./projection.mjs";
import { STANDING, isAncestorCommit, receiptStanding, takeReceipt } from "./receipt.mjs";
import { DECISION, KIND, RECEIPTS, SUSPENSION, TERMINAL, VERDICT, loopVocabulary } from "./vocabulary.mjs";

export { LoopError };

// Every record this service writes goes through the vocabulary first, so an
// unvalidated payload cannot reach the log by way of a code path that forgot.
const checked = (kind, payload) => ({ kind, payload: loopVocabulary.assert(kind, payload) });

export function openLoopStore(location, options = {}) {
  return openStore(location, { reduce: reduceStore, initial: EMPTY_STORE, ...options });
}

// A store holds a graph. Every verb but `open` names the loop it addresses,
// and looking one up is where "no such loop" is caught once instead of in
// nine places.
export function loopOf(state, loopId) {
  const loop = state.loops[loopId];
  if (loop === undefined || !loop.opened) refuse("NO_SUCH_LOOP", `${loopId} is not a loop in this store`);
  return loop;
}

// The frontier. A read: it changes nothing, and it hands back ids, not work.
export function ready(store, { root, ...options } = {}) {
  return readyLoops(store.replay().state, { ...options, ...ancestryCheck(root) });
}

// Supplied only when the host offers a workspace: the question needs git, and
// a read that cannot reach git must say so rather than assume the answer.
export const ancestryCheck = (root) =>
  (typeof root === "string" ? { isAncestor: (upstream) => isAncestorCommit(root, upstream.certificationCommit) } : {});

export const criterionDigestOf = (file) => sha256Hex(fs.readFileSync(file));

// A workspace that is not there is not a failing round. Spawning the criterion
// into a directory that no longer exists produces "could not reach a verdict",
// which reads as a fact about the work — so the loop would spend a round, and
// the log would say the check was inconclusive, over a worktree somebody
// removed. Those are different answers and the loop is entitled to the right one.
function assertWorkspace(root) {
  if (typeof root !== "string" || root.length === 0) refuse("ROOT_REQUIRED", "this verb needs the workspace root");
  if (!fs.existsSync(root)) refuse("NO_SUCH_WORKSPACE", `${root} does not exist; the workspace it names is gone`);
}

// A checkpoint over the claimed paths: what the artifacts looked like when the
// round was observed. Two rounds with the same checkpoint changed nothing the
// loop is responsible for.
export const MAX_CHECKPOINT_ENTRIES = 20_000;

export function artifactCheckpoint(root, claims, { storeLocation = null } = {}) {
  // The runtime's own files are not artifacts (FS-02). Without this a loop
  // that claims "." sees its own ledger change on every append, so its progress
  // signature moves every round and it can never be found stuck — the check
  // would still be there, and it would never fire again.
  const excluded = controlPlanePaths(root, storeLocation);
  const entries = [];
  const walk = (relative, depth) => {
    if (entries.length >= MAX_CHECKPOINT_ENTRIES) refuse("CLAIM_TOO_LARGE", `a claim expands past ${MAX_CHECKPOINT_ENTRIES} entries`);
    // Depth is bounded rather than trusted: a symlink loop under a claim would
    // otherwise walk until the stack gives out, and a checkpoint that crashes
    // is worse than one that refuses.
    if (depth > 64) refuse("CLAIM_TOO_DEEP", `${relative} nests deeper than 64 levels`);
    if (excluded.some((entry) => relative === entry || relative.startsWith(`${entry}${path.sep}`))) return;
    const absolute = path.join(root, relative);
    let stat;
    try {
      // lstat, not stat: a symlink is recorded as the link it is, so the walk
      // cannot be led outside the claim or around in a circle.
      stat = fs.lstatSync(absolute);
    } catch {
      entries.push([relative, "absent"]);
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push([relative, `symlink:${sha256Hex(fs.readlinkSync(absolute))}`]);
      return;
    }
    if (stat.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(absolute).sort();
      } catch (error) {
        // Unreadable is a fact about the artifacts, not a reason to lose the
        // whole observation: the criterion has already run by now.
        entries.push([relative, `unreadable:${error.code ?? "unknown"}`]);
        return;
      }
      for (const name of names) walk(path.join(relative, name), depth + 1);
      return;
    }
    if (!stat.isFile()) {
      // Sockets, FIFOs and devices have no content worth hashing, and reading
      // one could block forever.
      entries.push([relative, `special:${stat.mode & fs.constants.S_IFMT}`]);
      return;
    }
    try {
      entries.push([relative, sha256Hex(fs.readFileSync(absolute))]);
    } catch (error) {
      entries.push([relative, `unreadable:${error.code ?? "unknown"}`]);
    }
  };
  for (const claim of [...claims].sort()) walk(claim, 0);
  return digestOf(entries);
}

/**
 * Claims name paths inside the workspace, and what is recorded is the path's
 * *physical* identity rather than the string the caller typed.
 *
 * Comparing the strings is not enough, and the gap is one keystroke wide: on a
 * case-insensitive volume `Src` and `src` are one directory, and a symlink is
 * one on every volume. Two loops owning the same files would each issue
 * receipts contradicting the other — and being able to decide "my paths" is
 * the single reason claims exist.
 *
 * Resolving to the deepest existing ancestor closes both aliases at once:
 * `realpath` is the definition of the first, and on a case-insensitive volume
 * it reports the spelling actually on disk, which closes the second. Case
 * sensitivity is a property of the volume, never of the platform — macOS
 * volumes can be sensitive and Windows directories can be — so it is resolved,
 * never assumed.
 */
// On a volume that does not tell `Src` from `src`, two claims that differ only
// in case name one directory. Identity resolves that for paths already on
// disk; for a path nobody has created yet there is nothing to resolve against,
// so the comparison folds instead — otherwise two loops could claim `Src/new`
// and `src/new` today and find themselves sharing a tree tomorrow.
export const folder = (root) => (caseInsensitiveVolume(root) ? (value) => value.toLowerCase() : (value) => value);

export const overlaps = (left, right) =>
  left === right || left === "." || right === "." || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);

export function claimIdentity(root, claim) {
  const normalized = path.normalize(claim);
  const base = realOf(root);
  const segments = normalized === "." ? [] : normalized.split(path.sep).filter((part) => part.length > 0);
  let resolved = base;
  let index = 0;
  for (; index < segments.length; index += 1) {
    const candidate = path.join(resolved, segments[index]);
    if (!fs.existsSync(candidate)) break;
    resolved = realOf(candidate);
  }
  // Whatever does not exist yet keeps the spelling the caller gave it: nobody
  // has created that directory, so nothing on disk can say what it is called.
  const identity = path.relative(base, path.join(resolved, ...segments.slice(index)));
  // Re-checked after resolving, because a symlink can leave the workspace by a
  // route the textual `..` check below cannot see at all.
  if (identity.split(path.sep).includes("..") || path.isAbsolute(identity)) {
    refuse("CLAIM_ESCAPES_ROOT", `${claim} resolves to ${identity}, which is outside the workspace`);
  }
  return identity.length === 0 ? "." : identity;
}

/**
 * Validates a loop's claims and returns their identities, in a stable order.
 *
 * Shape first (relative, literal, distinct), then physical identity, then
 * overlap — because "is this the same path" only means something once both
 * sides have been resolved to what is actually on disk.
 */
export function assertClaims(root, claims, { storeLocation = null } = {}) {
  if (!Array.isArray(claims) || claims.length === 0) refuse("CLAIMS_REQUIRED", "a loop needs at least one write claim");
  for (const claim of claims) {
    if (typeof claim !== "string" || claim.length === 0) refuse("CLAIM_SHAPE", "a claim must be a non-empty path");
    if (path.isAbsolute(claim)) refuse("CLAIM_SHAPE", `${claim} must be relative to the workspace root`);
    if (/[*?[\]{}]/u.test(claim)) refuse("CLAIM_SHAPE", `${claim} is a pattern; claims are literal paths`);
    const normalized = path.normalize(claim);
    if (normalized.split(path.sep).includes("..")) refuse("CLAIM_SHAPE", `${claim} escapes the workspace root`);
  }
  const normalized = claims.map((claim) => claimIdentity(root, claim));
  // The runtime's own files are excluded from every checkpoint and receipt
  // (FS-02), so a loop that claimed them would be one that can never observe
  // or vouch for its own scope — an unwinnable loop, accepted in silence.
  const control = controlPlanePaths(root, storeLocation);
  for (const claim of normalized) {
    if (control.some((entry) => claim === entry || claim.startsWith(`${entry}${path.sep}`))) {
      refuse("CLAIM_IS_CONTROL_PLANE", `${claim} belongs to the runtime, which never treats it as work`);
    }
  }
  const fold = folder(root);
  if (new Set(normalized.map(fold)).size !== normalized.length) refuse("CLAIM_SHAPE", "claims must be distinct");
  // Overlap makes "my paths" undecidable, which is the one thing claims exist
  // to make decidable.
  for (const outer of normalized) {
    for (const inner of normalized) {
      if (outer !== inner && overlaps(fold(inner), fold(outer))) refuse("CLAIM_OVERLAP", `${inner} lies inside ${outer}`);
    }
  }
  // Code unit order, never `localeCompare`: this ordering goes into a digest,
  // and an order that changes with the machine's language would give the same
  // claims two different identities on two machines.
  return [...normalized].sort();
}

export function openLoop(store, { root, goal, claims, criterionFile, roundsBudget, session, reason, grantedBy, receipts, dependsOn = [], commandId }) {
  if (typeof goal !== "string" || goal.trim().length === 0) refuse("GOAL_REQUIRED", "a loop needs a goal");
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "a loop records who opened it");
  // Provenance is required at the seam, not merely allowed: a loop that cannot
  // say who opened it and why is a loop nobody can audit later.
  if (typeof reason !== "string" || reason.trim().length === 0) refuse("REASON_REQUIRED", "opening a loop records why");
  if (grantedBy !== "self" && grantedBy !== "user") refuse("PROVENANCE_REQUIRED", "granted_by must be self or user");
  // No default. This is the standard the loop will be certified against, and a
  // certification standard that nobody stated is one nobody agreed to.
  if (!Object.values(RECEIPTS).includes(receipts)) refuse("RECEIPTS_REQUIRED", `receipts must be one of ${Object.values(RECEIPTS)}`);
  // Checked here rather than left to the vocabulary, so the refusal names the
  // thing the caller left out. A shell filling this in on the caller's behalf
  // would be deciding how long a loop may run, somewhere nobody would look.
  if (!Number.isSafeInteger(roundsBudget) || roundsBudget < 1) refuse("BUDGET_REQUIRED", "a loop needs a rounds budget of at least 1");
  // A claim's identity is a fact about a filesystem; without knowing which
  // filesystem there is nothing to resolve it against.
  if (typeof root !== "string" || root.length === 0) refuse("ROOT_REQUIRED", "opening a loop needs the workspace root its claims are relative to");
  const criterionDigest = criterionDigestOf(criterionFile);
  const wanted = assertClaims(root, claims, { storeLocation: store.location });
  const base = {
    goal, claims: wanted, criterion_digest: criterionDigest,
    rounds_budget: roundsBudget, opened_by: session, reason, granted_by: grantedBy, receipts,
  };
  const result = store.append({
    commandId,
    requestDigest: digestOf({ ...base, depends_on: dependsOn }),
    prepare: (state) => {
      // Both checks refuse before anything is written, so a rejected open
      // leaves the log byte-for-byte unchanged.
      const conflicts = claimConflicts(wanted, state, { fold: folder(root) });
      if (conflicts.length > 0) {
        refuse("CLAIM_TAKEN", `${conflicts[0].claim} is already claimed by loop ${conflicts[0].loop_id.slice(0, 19)}`);
      }
      return [checked(KIND.OPENED, { ...base, depends_on: assertEdges(dependsOn, state) })];
    },
  });
  // The opening record's own digest is the loop's identity: content-addressed,
  // unique by construction, and the same material an edge pins.
  return { ...result, loopId: result.records[0].digest };
}

// Pure read. While the state does not move, this returns the same directive,
// which is what lets a host ask again after a crash without wondering whether
// it has been given new work.
export function next(store, { loopId, root, ...options } = {}) {
  const { state } = store.replay();
  const loop = loopOf(state, loopId);
  const checked_ = { ...options, ...ancestryCheck(root) };
  return {
    loop_id: loopId,
    ...nextDirective(loop, { ...checked_, dependency: dependencyState(loop, state, checked_) }),
  };
}

/**
 * Produces a receipt: the runtime performs one task-scoped git operation and
 * records what it saw.
 *
 * Held under the git_index lock, which is declared outer to the store lock, so
 * the order here is git_index → store. The criterion runs outside every lock
 * because it takes minutes; this takes milliseconds, and the index is the one
 * piece of genuinely shared mutable state in the picture.
 *
 * Unlike the criterion, this leaves a mark on the world before it can be
 * written down. Everything below is arranged so that the gap between the two
 * cannot produce a commit nobody recorded.
 */
export function receipt(store, { root, loopId, mode, session, commandId }) {
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "a receipt records who took it");
  const before = loopOf(store.replay().state, loopId);
  if (!isLive(before)) refuse("NOT_LIVE", `the loop is ${before.lifecycle}`);
  if (before.receipts !== RECEIPTS.GIT) refuse("NO_RECEIPT_REGIME", `this loop was opened with receipts: ${before.receipts}`);
  assertWorkspace(root);

  const replay = (records) => ({ seq: records.at(-1).seq, records, replayed: true });
  const applied = store.commandRecords(commandId);
  if (applied !== null) return replay(applied);

  return store.withLock(CLASSES.GIT_INDEX, root, () => {
    // Checked again, now that nobody else can be mid-operation. The check
    // outside the lock only saves work; this one is what stops a retry racing
    // its original from committing twice and having the second commit thrown
    // away as a duplicate at the append. Untested: reaching it needs two
    // callers to interleave *and* the working tree to move between them, which
    // no test here can force. Kept because it is cheap and the alternative is
    // a commit nobody recorded.
    const raced = store.commandRecords(commandId);
    if (raced !== null) return replay(raced);

    const taken = takeReceipt({ root, mode, claims: before.claims, storeLocation: store.location });
    const payload = { ...taken, loop_id: loopId, recorded_by: session };
    return store.append({
      commandId,
      requestDigest: digestOf({ loopId, mode, session, claims: before.claims }),
      // No liveness check here, deliberately. If the loop was ended while the
      // git operation ran, the commit still happened, and refusing to write it
      // down would leave the repository holding a change the ledger denies. A
      // receipt is a fact about git, not a transition of the loop.
      prepare: () => [checked(KIND.RECEIPT, payload)],
    });
  });
}

/**
 * Submits the result of a round: the host says what it did, the runtime runs
 * the criterion itself and records the judgment and the decision that follows.
 *
 * The criterion runs outside the store lock, because it can take minutes and
 * holding a lock for that long would make the loop unusable. Staleness is
 * caught instead by comparing the loop's own revision when the result is
 * written — so work happening elsewhere cannot invalidate this round, and a
 * change to *this* loop cannot be silently overwritten.
 */

export async function observe(store, { root, loopId, session, commandId, timeoutMs, criterionFile, stuckThreshold }) {
  if (typeof session !== "string" || session.length === 0) refuse("SESSION_REQUIRED", "an observation records who made it");
  const storeState = store.replay().state;
  const before = loopOf(storeState, loopId);
  if (!isLive(before)) refuse("NOT_LIVE", `the loop is ${before.lifecycle}`);
  assertWorkspace(root);

  // A retry of a round that already landed must not run the criterion again.
  // Discovering the replay only at the append layer would mean paying for the
  // whole check — minutes, sometimes — to be told the work was already done.
  const alreadyApplied = store.commandRecords(commandId);
  if (alreadyApplied !== null) return { seq: alreadyApplied.at(-1).seq, records: alreadyApplied, replayed: true };

  const expectedRevision = before.revision;
  const round = roundsSpent(before) + 1;
  if (criterionDigestOf(criterionFile) !== before.criterionDigest) {
    refuse("CRITERION_CHANGED", "the criterion file no longer matches the one this loop was opened with");
  }

  const outcome = await runCriterion({ executable: process.execPath, args: [criterionFile], cwd: root, timeoutMs });
  const checkpoint = artifactCheckpoint(root, before.claims, { storeLocation: store.location });

  // The receipt is re-verified here rather than taken on trust — and rather
  // than accepted from the caller, which is what this used to do and what made
  // the anchor axiom half-honoured. A receipt that no longer describes the task
  // paths is simply not in force: the round records the observation and says
  // why, instead of throwing away a criterion run that already happened.
  const standing = before.receipts === RECEIPTS.GIT
    ? receiptStanding({ root, receipt: before.receipt, claims: before.claims, storeLocation: store.location })
    : { standing: STANDING.NONE };
  const receiptDigest = standing.standing === STANDING.IN_FORCE ? before.receipt.digest : null;

  // The dependency gate, evaluated now for the same reason the receipt is: the
  // ancestry half of it has to ask git, and the policy stays pure.
  const dependency = dependencyState(before, storeState, ancestryCheck(root));

  const signature = outcome.verdict === VERDICT.UNSATISFIED
    ? progressSignature({ criterionDigest: before.criterionDigest, artifactCheckpoint: checkpoint, receiptDigest, failures: outcome.failures })
    : null;

  return store.append({
    commandId,
    // The request, not the result: what the caller asked for is what makes a
    // retry recognisable. Digesting the outcome would make every retry look
    // like a different command, because the criterion may legitimately say
    // something new each time it runs.
    requestDigest: digestOf({ loopId, round, session, criterion: before.criterionDigest }),
    prepare: (storeState) => {
      const state = loopOf(storeState, loopId);
      // The optimistic check. It compares this loop's own revision, so a
      // neighbouring loop's activity can never invalidate this round — the
      // failure mode that made the previous implementation's certification
      // unusable under concurrency.
      if (state.revision !== expectedRevision) {
        refuse("ROUND_STALE", `the loop moved from revision ${expectedRevision} to ${state.revision} while the criterion ran`);
      }
      const observation = checked(KIND.OBSERVED, {
        loop_id: loopId,
        round,
        verdict: outcome.verdict,
        progress_signature: signature,
        artifact_checkpoint: checkpoint,
        receipt_digest: receiptDigest,
        receipt_state: standing.standing,
        dependency_state: dependency.state,
        // The tail again, not the head. output_tail is already the end of what
        // the criterion printed; taking its first 2000 characters would throw
        // away precisely the part that says what went wrong.
        summary: outcome.execution.output_tail.slice(-2000),
        observed_by: session,
      });
      const projected = reduceLoop(state, { seq: state.revision + 1, ...observation });
      const verdictOfRound = decide(projected, { stuckThreshold, dependency });
      const records = [observation, checked(KIND.DECIDED, { loop_id: loopId, round, decision: verdictOfRound.decision, reason: verdictOfRound.reason })];

      // A decision that ends or pauses the loop is written in the same command
      // as the observation that caused it: a reader can never find a loop that
      // was judged achieved but never closed.
      if (verdictOfRound.decision === DECISION.ACHIEVED) {
        records.push(checked(KIND.TERMINAL, { loop_id: loopId, outcome: TERMINAL.ACHIEVED, reason: verdictOfRound.reason, receipt_digest: receiptDigest, granted_by: "self" }));
      } else if (verdictOfRound.decision === DECISION.SUSPEND) {
        records.push(checked(KIND.SUSPENDED, { loop_id: loopId, outcome: verdictOfRound.suspension ?? SUSPENSION.NEEDS_INPUT, reason: verdictOfRound.reason, suspended_by: session }));
      } else if (verdictOfRound.decision === DECISION.STUCK) {
        records.push(checked(KIND.SUSPENDED, { loop_id: loopId, outcome: SUSPENSION.NEEDS_INPUT, reason: verdictOfRound.reason, suspended_by: session }));
      }
      return records;
    },
  });
}

// Pausing and resuming are decisions about someone else's work unless the
// session making them is part of the loop. Knowing a loop's address is not
// the same as having standing to move it.
const assertParticipant = (state, session) => {
  if (!state.participants.includes(session)) {
    refuse("NOT_A_PARTICIPANT", `session ${session} has not taken part in this loop`);
  }
};

export function suspend(store, { loopId, outcome, reason, session, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ loopId, outcome, reason, session }),
    prepare: (storeState) => {
      const state = loopOf(storeState, loopId);
      if (!isLive(state)) refuse("NOT_LIVE", `the loop is already ${state.lifecycle}`);
      assertParticipant(state, session);
      return [checked(KIND.SUSPENDED, { loop_id: loopId, outcome, reason, suspended_by: session })];
    },
  });
}

export function resume(store, { loopId, reason, session, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ loopId, reason, session }),
    prepare: (storeState) => {
      const state = loopOf(storeState, loopId);
      if (state.lifecycle !== "suspended") refuse("NOT_SUSPENDED", `the loop is ${state.lifecycle}`);
      assertParticipant(state, session);
      return [checked(KIND.RESUMED, { loop_id: loopId, reason, resumed_by: session })];
    },
  });
}

// Joining is how a new session gains standing. It is deliberately explicit:
// the alternative is standing that accrues by accident.
export function join(store, { loopId, session, reason, commandId }) {
  return store.append({
    commandId,
    requestDigest: digestOf({ loopId, session, reason }),
    prepare: (storeState) => {
      const state = loopOf(storeState, loopId);
      if (state.lifecycle === "terminal") refuse("ALREADY_TERMINAL", "a finished loop cannot be joined");
      if (state.participants.includes(session)) refuse("ALREADY_PARTICIPANT", `session ${session} is already taking part`);
      return [checked(KIND.JOINED, { loop_id: loopId, session, reason })];
    },
  });
}

// Changing what the loop is for is a person's act, never the runtime's, so the
// vocabulary itself refuses any provenance but "user".
export function amend(store, { loopId, roundsBudget = null, criterionFile = null, goal = null, reason, dependsOn, commandId }) {
  // Named, only to be refused. Dropping an unrecognised argument would leave
  // the caller believing the dependency changed, and it is that silence —
  // not the immutability — that would make the graph untrustworthy.
  if (dependsOn !== undefined) refuse("EDGE_IMMUTABLE", "edges are declared when a loop is opened; a different dependency is a different loop");
  const criterionDigest = criterionFile === null ? null : criterionDigestOf(criterionFile);
  const payload = { loop_id: loopId, rounds_budget: roundsBudget, criterion_digest: criterionDigest, goal, reason, granted_by: "user" };
  return store.append({
    commandId,
    requestDigest: digestOf(payload),
    prepare: (storeState) => {
      const state = loopOf(storeState, loopId);
      if (state.lifecycle === "terminal") refuse("ALREADY_TERMINAL", "a finished loop cannot be amended");
      return [checked(KIND.AMENDED, payload)];
    },
  });
}

export function abandon(store, { loopId, reason, commandId }) {
  const payload = { loop_id: loopId, outcome: TERMINAL.ABANDONED, reason, receipt_digest: null, granted_by: "user" };
  return store.append({
    commandId,
    requestDigest: digestOf(payload),
    prepare: (storeState) => {
      const state = loopOf(storeState, loopId);
      if (state.lifecycle === "terminal") refuse("ALREADY_TERMINAL", "the loop is already finished");
      return [checked(KIND.TERMINAL, payload)];
    },
  });
}
