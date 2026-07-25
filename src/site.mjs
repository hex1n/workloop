// Where a store lives, and how a command finds it.
//
// Two worlds, two places. A git root keeps its ledger in the common directory
// so that several worktrees share one history and deleting a worktree loses
// nothing; a plain root keeps it inside itself. Which one a store belongs to
// is recorded when it is created and checked afterwards — never re-derived,
// because a root that gains a `.git` would otherwise start resolving to a
// different directory holding a different history under the same name.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StoreError } from "./store.mjs";

export const KIND = Object.freeze({ GIT: "git", FS: "fs" });
export const FS_DIRECTORY = ".workloop";
export const GIT_DIRECTORY = "workloop";

// Bounds on the downward scan in §4 of the slice spec. Creation is rare, so a
// scan is affordable there and nowhere else.
export const MAX_SCAN_DEPTH = 8;
export const MAX_SCAN_ENTRIES = 20_000;
const SKIP = new Set([".git", "node_modules"]);

const refuse = (code, message) => {
  throw new StoreError(code, message);
};

const isStore = (directory) => fs.existsSync(path.join(directory, "manifest.json"));

// The git common directory, or null when this is not a git workspace. Asked of
// git rather than guessed, because worktrees, submodules and `GIT_DIR` all put
// it somewhere a rule of thumb would get wrong.
export function gitCommonDirectory(root) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  const directory = result.stdout.trim();
  return directory.length === 0 ? null : directory;
}

/**
 * Both places a store could sit for this root, and which of them exist.
 *
 * Returning both is the point: when two exist, no rule can pick one without
 * hiding a history, so the caller refuses instead of choosing.
 */
export function sitesFor(root) {
  const common = gitCommonDirectory(root);
  return {
    git: common === null ? null : path.join(common, GIT_DIRECTORY),
    fs: path.join(root, FS_DIRECTORY),
  };
}

/**
 * The store for a root, or a refusal saying why there is not exactly one.
 *
 * A root holding both an fs ledger and a git ledger is the kind conflict of
 * FS-07: two histories, one name, and nothing in either that says which the
 * user meant.
 */
export function resolveSite(root) {
  const sites = sitesFor(root);
  const present = [
    ...(sites.git !== null && isStore(sites.git) ? [{ kind: KIND.GIT, location: sites.git }] : []),
    ...(isStore(sites.fs) ? [{ kind: KIND.FS, location: sites.fs }] : []),
  ];
  if (present.length > 1) {
    refuse("STORE_KIND_CONFLICT", `${root} holds both a git ledger (${sites.git}) and a filesystem ledger (${sites.fs}); one of them must be moved or exported before either can be used`);
  }
  return present[0] ?? null;
}

/**
 * Walks up from a directory looking for a store, the way git finds `.git`.
 *
 * Nothing is created and nothing is guessed: a caller that finds no store is
 * told to name one or to initialise one, because a runtime that quietly
 * creates a ledger where somebody happened to be standing is a runtime whose
 * history nobody can account for.
 */
export function discover(from) {
  let directory = path.resolve(from);
  for (;;) {
    const found = resolveSite(directory);
    if (found !== null) return { ...found, root: directory };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// Every store at or below a directory, bounded. Reports whether the bound was
// hit so the caller can say "I did not finish looking" instead of implying a
// clean bill of health.
export function scanForStores(root, { maxDepth = MAX_SCAN_DEPTH, maxEntries = MAX_SCAN_ENTRIES } = {}) {
  const found = [];
  let entries = 0;
  let exhausted = false;
  const walk = (directory, depth) => {
    if (depth > maxDepth) { exhausted = true; return; }
    let names;
    try {
      names = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      entries += 1;
      if (entries > maxEntries) { exhausted = true; return; }
      const full = path.join(directory, entry.name);
      if (isStore(full)) { found.push(full); continue; }
      if (SKIP.has(entry.name)) continue;
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return { found, exhausted };
}

/**
 * Decides where a new store goes, and refuses every arrangement in which a
 * path would belong to two ledgers at once.
 *
 * Nesting is refused in both directions (FS-04). Upwards is cheap — walk the
 * parents. Downwards costs a bounded scan, paid once, here, because creating a
 * store is rare and being wrong about this is not recoverable by any later
 * check: by then both ledgers have history.
 */
export function siteForNewStore(root, { kind } = {}) {
  if (!fs.existsSync(root)) refuse("NO_SUCH_ROOT", `${root} does not exist`);
  const existing = resolveSite(root);
  if (existing !== null) refuse("STORE_EXISTS", `${root} already holds a ${existing.kind} store at ${existing.location}`);

  let directory = path.dirname(path.resolve(root));
  for (;;) {
    const above = resolveSite(directory);
    if (above !== null) refuse("STORE_NESTED_INSIDE", `${root} lies inside ${directory}, which already holds a store`);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const below = scanForStores(root);
  if (below.found.length > 0) {
    refuse("STORE_CONTAINS_NESTED", `${root} contains a store at ${below.found[0]}`);
  }
  if (below.exhausted) {
    // Said out loud rather than passed over. A caller that is told the check
    // was complete when it was not would take a silence for a guarantee.
    refuse("STORE_SCAN_INCOMPLETE", `${root} is too large or too deep to check for nested stores (limits: depth ${MAX_SCAN_DEPTH}, entries ${MAX_SCAN_ENTRIES})`);
  }

  const sites = sitesFor(root);
  const chosen = kind ?? (sites.git === null ? KIND.FS : KIND.GIT);
  if (chosen === KIND.GIT && sites.git === null) refuse("NOT_A_GIT_WORKSPACE", `${root} is not inside a git repository`);
  return { kind: chosen, location: chosen === KIND.GIT ? sites.git : sites.fs, root };
}

// Checks that a store still sits where its recorded kind says it should. The
// world can change under a store — `git init` inside a plain root is the case
// FS-07 names — and the answer is to refuse, not to migrate: choosing either
// ledger silently would hide the other one's history.
export function assertKind(root, manifest) {
  const sites = sitesFor(root);
  if (manifest.store_kind === KIND.FS && sites.git !== null && isStore(sites.git)) {
    refuse("STORE_KIND_CONFLICT", `${root} was claimed as a filesystem store but now also holds a git ledger at ${sites.git}`);
  }
  return manifest.store_kind;
}
