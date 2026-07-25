// The graph: edges between loops in one store, and what they gate.
//
// v1 has one edge type. `depends_on` says "this loop cannot be certified until
// that one is" — it does not schedule, does not dispatch, and does not stop
// anyone from working. It gates the certification, which is the only place a
// dependency can be checked against evidence rather than against intent.
import { refuse } from "./error.mjs";
import { achieved, isLive } from "./projection.mjs";
import { DEPENDENCY, TERMINAL } from "./vocabulary.mjs";

export { DEPENDENCY };

// Why a dependency is not satisfied. Distinguishable, because "the upstream is
// not finished" and "the upstream finished with different evidence than I
// pinned" call for entirely different responses from whoever reads it.
export const UNMET = Object.freeze({
  UNKNOWN: "upstream_unknown",
  UNFINISHED: "upstream_unfinished",
  ABANDONED: "upstream_abandoned",
  PIN_MISMATCH: "pin_mismatch",
  NOT_ANCESTOR: "upstream_not_ancestor",
});

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * Parses and validates the edges a loop is being opened with.
 *
 * Everything checkable is checked here, before anything is written: an edge
 * that cannot be validated at open time could only be validated at
 * certification time, and by then the loop has spent its rounds.
 */
export function assertEdges(edges, { loops }) {
  if (edges === undefined || edges === null) return [];
  if (!Array.isArray(edges)) refuse("EDGE_SHAPE", "depends_on must be a list");
  const parsed = edges.map((edge) => {
    // The wire form is the command-line form: <loop_id>[@<certification>].
    // Split on the separator only when it is actually there — a loop id is
    // itself a `sha256:` string, so the pin marker has to be looked for as the
    // whole `@sha256:` and its absence must leave the id untouched.
    const raw = typeof edge === "string" ? edge : null;
    const at = raw === null ? -1 : raw.indexOf("@sha256:");
    const [loopId, pin] = raw === null
      ? [edge?.loop_id, edge?.pinned_certification_digest ?? null]
      : at === -1 ? [raw, null] : [raw.slice(0, at), raw.slice(at + 1)];
    if (typeof loopId !== "string" || !DIGEST.test(loopId)) refuse("EDGE_SHAPE", `${loopId} is not a loop id`);
    if (pin !== null && !DIGEST.test(pin)) refuse("EDGE_SHAPE", `${pin} is not a certification digest`);
    return { loop_id: loopId, pinned_certification_digest: pin };
  });

  const seen = new Set();
  for (const edge of parsed) {
    if (seen.has(edge.loop_id)) refuse("EDGE_DUPLICATE", `${edge.loop_id} is depended on twice`);
    seen.add(edge.loop_id);
    const upstream = loops[edge.loop_id];
    if (upstream === undefined) refuse("EDGE_UNKNOWN_UPSTREAM", `${edge.loop_id} is not a loop in this store`);
    if (upstream.outcome === TERMINAL.ABANDONED) refuse("EDGE_ABANDONED_UPSTREAM", `${edge.loop_id} was abandoned`);
  }
  return parsed;
}

/**
 * Whether one loop's dependencies are met, and if not, which one and why.
 *
 * `isAncestor` is supplied by the caller rather than looked up here, because
 * answering it means asking git — and this file, like the policy it feeds,
 * must stay a pure function of the log so that it can be reasoned about
 * without a repository on disk.
 */
export function dependencyState(loop, { loops }, { isAncestor = null } = {}) {
  if (loop.dependsOn.length === 0) return { state: DEPENDENCY.NONE, unmet: [] };
  // Refuse rather than guess. When an upstream certified on a commit, whether
  // that commit is still reachable is not in the log, and answering from the
  // log alone would report "satisfied" for the one condition that was never
  // checked. Success is the answer that must never happen by accident — the
  // same rule the criterion protocol is built on.
  if (isAncestor === null && loop.dependsOn.some((edge) => loops[edge.loop_id]?.certificationCommit != null)) {
    refuse("ANCESTRY_UNCHECKABLE", "this loop depends on work certified on a commit; checking it needs the workspace root");
  }
  const unmet = [];
  for (const edge of loop.dependsOn) {
    const upstream = loops[edge.loop_id];
    if (upstream === undefined) {
      unmet.push({ loop_id: edge.loop_id, reason: UNMET.UNKNOWN });
    } else if (upstream.outcome === TERMINAL.ABANDONED) {
      unmet.push({ loop_id: edge.loop_id, reason: UNMET.ABANDONED });
    } else if (!achieved(upstream)) {
      unmet.push({ loop_id: edge.loop_id, reason: UNMET.UNFINISHED });
    } else if (edge.pinned_certification_digest !== null && edge.pinned_certification_digest !== upstream.certification) {
      // Literal comparison. A pin exists precisely to say "that achievement,
      // not whichever one happens to be current".
      unmet.push({ loop_id: edge.loop_id, reason: UNMET.PIN_MISMATCH });
    } else if (isAncestor !== null && upstream.certificationCommit !== null && !isAncestor(upstream)) {
      unmet.push({ loop_id: edge.loop_id, reason: UNMET.NOT_ANCESTOR });
    }
  }
  return { state: unmet.length === 0 ? DEPENDENCY.SATISFIED : DEPENDENCY.UNMET, unmet };
}

// The frontier: live loops whose dependencies are all met. A read, and only a
// read — it says which loops *may* proceed, never which one to pick, and there
// is no path from here to anything being started.
export function ready(state, options = {}) {
  return Object.values(state.loops)
    .filter((loop) => loop.opened && isLive(loop) && dependencyState(loop, state, options).state !== DEPENDENCY.UNMET)
    .map((loop) => loop.id)
    .sort();
}

// Every loop whose claims would collide with the ones being proposed. Two
// loops that claim the same path cannot both be told what "my paths" means,
// and each would count the other's work as foreign content in its receipts.
export function claimConflicts(claims, { loops }, { fold = (value) => value } = {}) {
  const overlaps = (left, right) => left === right || left === "." || right === "."
    || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  return Object.values(loops)
    .filter((loop) => loop.opened && loop.lifecycle !== "terminal")
    .flatMap((loop) => loop.claims
      .filter((held) => claims.some((wanted) => overlaps(fold(held), fold(wanted))))
      .map((held) => ({ loop_id: loop.id, claim: held })));
}
