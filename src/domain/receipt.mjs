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
import { controlPlanePaths as controlPlane, realOf as real, systemPath } from "../site.mjs";
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
// Bounds the reasons list. The vocabulary allows one more, for the line that
// says how many were dropped — and it reads that bound from here, so the two
// cannot drift into a receipt that the log then refuses to carry.
export const MAX_REASONS = 20;

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

const excludeSpecs = (excluded) => excluded.map((entry) => `:(exclude)${entry}`);

// A path belongs to this loop when it is a claim or lies under one. Literal
// comparison, which is the whole reason claims are literal paths. "." is the
// one claim that needs saying out loud: git prints "src/a.txt", never
// "./src/a.txt", so prefix matching alone would call the whole repository
// foreign to a loop that claimed all of it.
// Deliberately not `pathContains`: these are git's paths, and git uses `/` on
// every platform. The identical-looking comparison over workspace paths is
// separator-aware for exactly the opposite reason.
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

// Claims name intent, so a claim may legitimately point at nothing yet — the
// agent has not created that directory on its first round. git refuses a
// pathspec that matches nothing at all, which would turn "this loop has not
// produced its files yet" into a hard failure of the whole receipt. A claim
// git already knows about stays in even when it is gone from disk, so that a
// deletion is still staged as the change it is.
function livePathspecs(root, claims) {
  return claims.filter((claim) =>
    fs.existsSync(path.join(root, systemPath(claim)))
    || lines(git(root, ["ls-files", "--", claim]).stdout).length > 0);
}

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
  const live = livePathspecs(root, claims);
  const specs = ["--", ...live, ...excludeSpecs(excluded)];
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
  if (live.length > 0) git(root, ["add", ...specs]);

  if (mode === MODE.STAGE) {
    touched = stagedPaths(root);
  } else if (live.length === 0) {
    refuse("NOTHING_TO_COMMIT", "the claimed paths exist neither on disk nor in git");
  } else {
    // `--only` is git's default when paths are given: it commits the named
    // paths and leaves every other index entry staged, which is exactly the
    // task-scoped isolation this receipt is about.
    const attempt = git(root, ["commit", "--only", "-m", "workloop receipt", ...specs], { tolerate: [1] });
    if (attempt.status === 0) {
      commitOid = git(root, ["rev-parse", "HEAD"]).stdout.trim();
      touched = lines(git(root, ["diff-tree", "-r", "--no-commit-id", "--name-only", "--root", commitOid]).stdout);
    } else {
      // Nothing left to commit. That is not a failure: the host owns git and
      // may have committed the work by hand, which the host contract expressly
      // permits. Refusing here would leave such a loop unable to ever produce
      // evidence, and so unable to ever be certified. The runtime attests the
      // commit that already holds the task paths instead — it verified that
      // fact itself, which is all the anchor axiom asks. `commit_oid` equal to
      // `head_before` is what tells a reader the two cases apart.
      if (headBefore === null) refuse("NOTHING_TO_COMMIT", "the task paths are in no commit and there is nothing to commit");
      commitOid = headBefore;
      touched = lines(git(root, ["ls-tree", "-r", "--name-only", commitOid, "--", ...claims]).stdout);
      if (touched.filter(inScope).length === 0) {
        refuse("NOTHING_TO_COMMIT", "the task paths hold nothing to commit and appear in no commit");
      }
    }
    const parent = git(root, ["rev-parse", `${commitOid}^`], { tolerate: [128] });
    parentOid = parent.status === 0 ? parent.stdout.trim() : null;
  }

  const paths = touched.filter(inScope);

  // A claim that exists on disk but contributed nothing is an emptiness the
  // runtime cannot account for — and an unaccountable emptiness must never
  // read as `clean`. The case that found this: a directory renamed by case
  // only, which git still tracks under the old spelling, so every pathspec
  // matched nothing and a receipt that staged nothing reported that everything
  // was fine. The rule is written against that shape rather than that cause,
  // so the next cause with the same shape is caught too. A claim that names
  // nothing yet is a different thing and stays clean: `live` already excludes it.
  const silent = live.filter((claim) => !paths.some((entry) => claim === "." || entry === claim || entry.startsWith(`${claim}/`)));

  // The staged set is read after the operation, deliberately: `--only` leaves
  // foreign entries staged, so what remains is precisely the content this
  // receipt cannot account for.
  //
  // All the notes are built under one bound. An earlier shape appended after
  // the cap and could exceed what the vocabulary carries — so a repository
  // with enough foreign staged files made the git operation happen and *then*
  // made recording it throw, which is the one outcome this must never have.
  const notes = [
    ...silent.map((claim) => `${claim} exists but git matched nothing under it; a case-only rename git was never told about does this`),
    // Only meaningful for a commit, where `touched` is what the commit itself
    // carries. In stage mode `touched` is the whole index, so this would just
    // restate the line below about every foreign entry — and word it as though
    // the loop's own add had pulled in a file it never went near.
    ...(mode === MODE.COMMIT ? touched.filter((entry) => !inScope(entry)).map((entry) => `${entry} is in the commit but lies outside this loop's claims`) : []),
    ...stagedPaths(root).filter((entry) => !inScope(entry)).map((entry) => `${entry} is staged but lies outside this loop's claims`),
  ];
  const reasons = notes.slice(0, MAX_REASONS);
  if (notes.length > MAX_REASONS) reasons.push(`and ${notes.length - MAX_REASONS} more`);

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

// Whether a commit is still reachable from HEAD. The graph's cross-loop check
// needs the same question GR-06 asks within one loop, so it is answered in one
// place: an upstream certified on a commit that has since been rewritten away
// cannot support anything downstream either.
export function isAncestorCommit(root, commitOid) {
  if (typeof commitOid !== "string" || commitOid.length === 0) return true;
  assertGitWorkspace(root);
  return git(root, ["merge-base", "--is-ancestor", commitOid, "HEAD"], { tolerate: [1, 128] }).status === 0;
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
  if (!isAncestorCommit(root, receipt.commit_oid)) return { standing: STANDING.UNLANDED, drift: [] };

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
