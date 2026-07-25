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
// The top of the working tree, or null outside a repository. `--git-common-dir`
// answers the same thing from any depth, which is exactly why it cannot stand
// in for this one: a command run three directories down would otherwise call
// that directory the workspace.
export function worktreeRoot(from) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: from, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  const top = result.stdout.trim();
  return top.length === 0 ? null : top;
}

// Paths the runtime keeps for itself. They are never artifacts, never receipt
// content, and never claimed work — a ledger that counted its own writes as
// changes to the tree would report drift on every append, and the loop that
// noticed would be the one whose stuck detection quietly stopped working.
export function controlPlanePaths(root, storeLocation) {
  const excluded = [".git"];
  if (typeof storeLocation === "string") {
    const relative = path.relative(realOf(root), realOf(storeLocation));
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) excluded.push(relative);
  }
  return excluded;
}

// `.native` deliberately: the JS implementation resolves symlinks but hands
// back whatever casing it was given, while the platform call reports the
// spelling actually on disk. On a case-insensitive volume that difference is
// the whole of CC-03 — without it `src` and `Src` stay two identities for one
// directory, and two loops can own the same files.
export const realOf = (target) => {
  try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
};

/**
 * Whether two workspace-relative paths name the same place or one inside the
 * other, on this platform's separator.
 *
 * Kept in one place because there used to be two, and one of them compared on
 * a hard-coded `/` while identities were built with the platform separator.
 * Both are now `/`: the log holds one form regardless of who wrote it, which
 * is what makes a claim mean the same thing — and digest the same — wherever
 * the store is read. The git-side comparison in the receipt adapter stays
 * separate, and now agrees by construction rather than by coincidence.
 */
export const pathContains = (left, right) =>
  left === right || left === "." || right === "."
  || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

// A workspace path as the log writes it, and as the log's readers compare it.
// One form, chosen once: `\` and `/` for the same place produced different
// digests and lost containment entirely when a store was written on one
// platform and read on another — the same class of bug as comparing on a
// hard-coded separator, only deferred until somebody shared the repository.
// Directional, unlike `pathContains`: "is this path inside that one". The
// symmetric form answers "do these two overlap", which is the right question
// for two claims and the wrong one for an exclusion — `.` overlaps everything,
// so asking it symmetrically excludes the whole tree.
export const isUnder = (candidate, prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`);

export const canonicalPath = (value) => value.split(path.sep).join("/");
export const systemPath = (value) => value.split("/").join(path.sep);

const swapCase = (name) => [...name].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("");

/**
 * Whether this volume tells `Src` and `src` apart.
 *
 * Asked of the volume, never inferred from the platform: macOS volumes can be
 * case-sensitive and Windows directories can be, so a platform check is a
 * check that is wrong on somebody's machine. Read-only — it looks for an
 * existing name under a second spelling rather than creating one.
 */
export function caseInsensitiveVolume(root) {
  const candidates = [path.basename(root), ...(() => {
    try { return fs.readdirSync(root).slice(0, 64); } catch { return []; }
  })()];
  for (const name of candidates) {
    const swapped = swapCase(name);
    if (swapped === name) continue;
    const base = name === path.basename(root) ? path.dirname(root) : root;
    return fs.existsSync(path.join(base, swapped));
  }
  return false;
}

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
    // A git store belongs to the working tree, not to whichever directory the
    // search started in — its ledger is shared by every worktree of the repo.
    ...(sites.git !== null && isStore(sites.git) ? [{ kind: KIND.GIT, location: sites.git, root: worktreeRoot(root) ?? root }] : []),
    ...(isStore(sites.fs) ? [{ kind: KIND.FS, location: sites.fs, root }] : []),
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
    if (found !== null) return { root: directory, ...found };
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
    // A git ledger lives at `<repo>/.git/workloop`, inside the one directory a
    // scan has every other reason to skip. Looked at directly rather than
    // descended into: without this the scan cannot see git stores at all, and
    // a store created above one would never learn it was there.
    if (isStore(path.join(directory, ".git", GIT_DIRECTORY))) found.push(path.join(directory, ".git", GIT_DIRECTORY));
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
// Whether a prospective store and one found above it describe different git
// repositories. Both must be git-kind: only then is there a boundary that
// something other than this runtime enforces.
function separateRepositories(root, other, chosenKind) {
  if (chosenKind !== KIND.GIT || other.kind !== KIND.GIT) return false;
  const mine = gitCommonDirectory(root);
  return mine !== null && realOf(mine) !== realOf(path.dirname(other.location));
}

// What a scanned location actually is, read from the store rather than guessed
// from the shape of its path. Guessing produced a regression: an fs ledger at
// `<dir>/.workloop` was treated as a git one, and a git store created above it
// was let through — two ledgers over one tree, which is the single thing this
// check exists to prevent.
function scannedStore(location) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(location, "manifest.json"), "utf8"));
    return { kind: manifest.store_kind === KIND.GIT ? KIND.GIT : KIND.FS, location };
  } catch {
    return { kind: KIND.FS, location };
  }
}

export function siteForNewStore(root, { kind } = {}) {
  if (!fs.existsSync(root)) refuse("NO_SUCH_ROOT", `${root} does not exist`);
  const existing = resolveSite(root);
  if (existing !== null) refuse("STORE_EXISTS", `${root} already holds a ${existing.kind} store at ${existing.location}`);

  if (kind !== undefined && !Object.values(KIND).includes(kind)) refuse("UNKNOWN_STORE_KIND", `${kind} is not a store kind; use ${Object.values(KIND).join(" or ")}`);
  const chosenKind = kind ?? (sitesFor(root).git === null ? KIND.FS : KIND.GIT);
  let directory = path.dirname(path.resolve(root));
  for (;;) {
    const above = resolveSite(directory);
    // Nesting is refused because two ledgers would claim one set of files —
    // but a nested *repository* is a different set of files, and git is what
    // says so: the outer repo does not track the inner one's contents and its
    // pathspecs cannot reach them. So the question is not "is this path
    // inside that one" but "do these two ledgers describe the same tree".
    // A filesystem store has no such boundary — its checkpoint walks
    // everything under the root — so the exemption is git-only.
    if (above !== null && !separateRepositories(root, above, chosenKind)) {
      refuse("STORE_NESTED_INSIDE", `${root} lies inside ${directory}, which already holds a store over the same tree`);
    }
    // An exempted ancestor is not the end of the walk. A store further up may
    // still cover this tree — a filesystem ledger three levels above reaches
    // straight through the repository boundary that exempted the nearer one.
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const below = scanForStores(root).found.filter((location) => {
    // Same rule from the other side: a store belonging to a nested repository
    // describes a tree this one does not reach.
    const other = scannedStore(location);
    const nested = other.kind === KIND.GIT ? path.dirname(path.dirname(location)) : path.dirname(location);
    return !separateRepositories(nested, other, chosenKind);
  });
  if (below.length > 0) refuse("STORE_CONTAINS_NESTED", `${root} contains a store at ${below[0]} over the same tree`);
  if (scanForStores(root).exhausted) {
    // Said out loud rather than passed over. A caller that is told the check
    // was complete when it was not would take a silence for a guarantee.
    refuse("STORE_SCAN_INCOMPLETE", `${root} is too large or too deep to check for nested stores (limits: depth ${MAX_SCAN_DEPTH}, entries ${MAX_SCAN_ENTRIES})`);
  }

  const sites = sitesFor(root);
  const chosen = chosenKind;
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
