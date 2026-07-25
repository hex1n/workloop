// Git receipts: what the runtime itself observed about the task's paths.
//
// The criterion side of the anchor axiom was already honoured — the runtime
// spawns the check and reads its exit code. This is the other side. A digest
// handed in by a caller is the caller's word for it; a commit oid the runtime
// produced and then re-verified against HEAD is a fact.
//
// The runtime does not own the git index. The host, the user, an editor and
// another agent can all move it, and none of them tell this file. So a receipt
// has exactly two honest states: "I confirm these paths and nothing else", and
// "I do not confirm". `clean` is never inferred, only witnessed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { digestOf } from "../canonical.mjs";
import { refuse } from "./error.mjs";

export const MODE = Object.freeze({ STAGE: "stage", COMMIT: "commit" });
export const STATUS = Object.freeze({ CLEAN: "clean", UNCERTAIN: "uncertain" });

// Why a receipt is not in force. `none` and `drifted` are different situations
// for whoever is debugging, and a bare null digest cannot tell them apart.
export const STANDING = Object.freeze({
  NONE: "none",
  IN_FORCE: "in_force",
  UNCERTAIN: "uncertain",
  UNLANDED: "unlanded",
  DRIFTED: "drifted",
});

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_REASONS = 20;

function git(cwd, args, { tolerate = [] } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT });
  if (result.error !== undefined) {
    refuse(result.error.code === "ENOENT" ? "GIT_UNAVAILABLE" : "GIT_FAILED", `git ${args[0]}: ${result.error.message}`);
  }
  if (result.status !== 0 && !tolerate.includes(result.status)) {
    refuse("GIT_FAILED", `git ${args[0]} exited ${result.status}: ${(result.stderr ?? "").trim().split("\n").at(-1) ?? ""}`);
  }
  return { status: result.status, stdout: result.stdout ?? "" };
}

const lines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

const real = (target) => {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
};

// The workspace root must *be* the repository root. Otherwise claims are
// relative to one origin while git's own path output is relative to another,
// and every comparison in this file would silently compare the wrong strings.
export function assertGitWorkspace(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (real(top) !== real(root)) {
    refuse("NOT_REPOSITORY_ROOT", `${root} is not the root of its repository (${top} is)`);
  }
  return top;
}

// Paths git must never touch on this runtime's behalf. The ledger may live
// inside the repository it records, and a claim of "." would otherwise stage
// the ledger into the very repository it is the record of.
function controlPlane(root, storeLocation) {
  const excluded = [".git"];
  if (typeof storeLocation === "string") {
    const relative = path.relative(real(root), real(storeLocation));
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) excluded.push(relative);
  }
  return excluded;
}

const excludeSpecs = (excluded) => excluded.map((entry) => `:(exclude)${entry}`);

// A path belongs to this loop when it is a claim or lies under one. Literal
// comparison, which is the whole reason claims are literal paths. "." is the
// one claim that needs saying out loud: git prints "src/a.txt", never
// "./src/a.txt", so prefix matching alone would call the whole repository
// foreign to a loop that claimed all of it.
const under = (prefixes) => (candidate) =>
  prefixes.some((prefix) => prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`));

// What this receipt is allowed to speak for: claimed, and not the runtime's
// own control plane. `git add` and `git commit` take the exclusion as a
// pathspec because they act and cannot be filtered afterwards; the read-only
// commands are filtered here instead, because `ls-tree` rejects exclude magic
// and a receipt should not depend on which commands accept which pathspecs.
const scopeOf = (claims, excluded) => {
  const owned = under(claims);
  const control = under(excluded);
  return (candidate) => owned(candidate) && !control(candidate);
};

const stagedPaths = (root) => lines(git(root, ["diff", "--cached", "--name-only"]).stdout);

const headOid = (root) => {
  const result = git(root, ["rev-parse", "HEAD"], { tolerate: [128] });
  return result.status === 0 ? result.stdout.trim() : null;
};

// The blob oids git recorded for the task paths — content-addressed, so it is
// a claim about what is there rather than about when it was looked at.
function treeDigest(root, { claims, inScope, commit }) {
  const specs = ["--", ...claims];
  const entries = commit === null
    ? lines(git(root, ["ls-files", "--stage", ...specs]).stdout).map((line) => {
      const [meta, file] = line.split("\t");
      return [file, meta.split(/\s+/u)[1]];
    })
    : lines(git(root, ["ls-tree", "-r", commit, ...specs]).stdout).map((line) => {
      const [meta, file] = line.split("\t");
      return [file, meta.split(/\s+/u)[2]];
    });
  return digestOf(entries.filter(([file]) => inScope(file)).sort((left, right) => (left[0] < right[0] ? -1 : 1)));
}

/**
 * Runs one task-scoped git operation and reports what it saw.
 *
 * The host's operation is never failed because somebody else's content is in
 * the index — the runtime is not the approver, and refusing here would be it
 * acting as one. It simply declines to vouch: the operation happens, and the
 * receipt says `uncertain`.
 */
export function takeReceipt({ root, mode, claims, storeLocation }) {
  if (mode !== MODE.STAGE && mode !== MODE.COMMIT) refuse("UNKNOWN_RECEIPT_MODE", `${mode} is not a receipt mode`);
  assertGitWorkspace(root);
  const excluded = controlPlane(root, storeLocation);
  const specs = ["--", ...claims, ...excludeSpecs(excluded)];
  const inScope = scopeOf(claims, excluded);
  const headBefore = headOid(root);

  let commitOid = null;
  let parentOid = null;
  // What the operation touched, before scoping. Kept separate from `paths` so
  // that anything outside the claims can still be reported: filtering first and
  // reporting second would make the check that catches it structurally unable
  // to fire.
  let touched;

  // The same task-scoped add in both modes. `--only` sees tracked files only —
  // it refuses a pathspec that matches nothing git knows about — so a commit
  // receipt over a file the loop has just created would fail without this.
  // Staging first is also what makes the two modes mean the same thing about
  // scope: the add is the operation that decides what "the task's paths" are.
  git(root, ["add", ...specs]);

  if (mode === MODE.STAGE) {
    touched = stagedPaths(root);
  } else {
    // `--only` is git's default when paths are given: it commits the named
    // paths and leaves every other index entry staged, which is exactly the
    // task-scoped isolation this receipt is about.
    const attempt = git(root, ["commit", "--only", "-m", "workloop receipt", ...specs], { tolerate: [1] });
    if (attempt.status !== 0) refuse("NOTHING_TO_COMMIT", "the task paths hold nothing new to commit");
    commitOid = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const parent = git(root, ["rev-parse", `${commitOid}^`], { tolerate: [128] });
    parentOid = parent.status === 0 ? parent.stdout.trim() : null;
    touched = lines(git(root, ["diff-tree", "-r", "--no-commit-id", "--name-only", "--root", commitOid]).stdout);
  }

  // Read after the operation, deliberately: `--only` leaves foreign entries
  // staged, so what remains is precisely the content this receipt cannot
  // account for.
  const foreign = stagedPaths(root).filter((entry) => !inScope(entry));
  const reasons = foreign.slice(0, MAX_REASONS).map((entry) => `${entry} is staged but lies outside this loop's claims`);
  if (foreign.length > MAX_REASONS) reasons.push(`and ${foreign.length - MAX_REASONS} more`);
  const unscoped = touched.filter((entry) => !inScope(entry));
  if (unscoped.length > 0) reasons.push(`${unscoped[0]} entered the operation without being claimed`);
  const paths = touched.filter(inScope);

  return {
    mode,
    status: reasons.length === 0 ? STATUS.CLEAN : STATUS.UNCERTAIN,
    reasons,
    paths: [...paths].sort(),
    head_before: headBefore,
    commit_oid: commitOid,
    parent_oid: parentOid,
    tree_digest: treeDigest(root, { claims, inScope, commit: commitOid }),
  };
}

/**
 * Does a recorded receipt still describe reality?
 *
 * Drift is measured only over the task paths. A neighbouring loop changing its
 * own files must not unseat this loop's evidence — that "a disjoint neighbour
 * invalidates my certification" failure is the one this whole design is built
 * to not have.
 */
export function receiptStanding({ root, receipt, claims, storeLocation }) {
  if (receipt === null || receipt === undefined) return { standing: STANDING.NONE, drift: [] };
  if (receipt.status !== STATUS.CLEAN) return { standing: STANDING.UNCERTAIN, drift: [] };
  // Staging is not durable: nothing about an index entry survives a checkout,
  // and nothing can be shown to be an ancestor of HEAD. Only a commit lands.
  if (receipt.mode !== MODE.COMMIT || receipt.commit_oid === null) return { standing: STANDING.UNLANDED, drift: [] };

  assertGitWorkspace(root);
  const landed = git(root, ["merge-base", "--is-ancestor", receipt.commit_oid, "HEAD"], { tolerate: [1, 128] });
  if (landed.status !== 0) return { standing: STANDING.UNLANDED, drift: [] };

  const excluded = controlPlane(root, storeLocation);
  const specs = ["--", ...claims, ...excludeSpecs(excluded)];
  const drift = [
    // Everything that could have moved the task paths since the receipt: a
    // later commit, an unstaged edit, a staged edit, and a new file nobody has
    // tracked yet. The last one is not in the corpus, but it is reachable with
    // one `touch`, and certifying a commit that lacks a file the criterion
    // just ran against would be certifying something that was never checked.
    ...lines(git(root, ["diff", "--name-only", receipt.commit_oid, "HEAD", ...specs]).stdout).map((file) => `committed:${file}`),
    ...lines(git(root, ["diff", "--name-only", ...specs]).stdout).map((file) => `unstaged:${file}`),
    ...lines(git(root, ["diff", "--cached", "--name-only", ...specs]).stdout).map((file) => `staged:${file}`),
    ...lines(git(root, ["ls-files", "--others", "--exclude-standard", ...specs]).stdout).map((file) => `untracked:${file}`),
  ];
  return { standing: drift.length === 0 ? STANDING.IN_FORCE : STANDING.DRIFTED, drift: drift.slice(0, MAX_REASONS) };
}
