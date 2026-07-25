// FS-01 / FS-03 / FS-04 / FS-07: where a store lives, and every arrangement in
// which "where" has no single answer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore, openStore } from "../src/store.mjs";
import { KIND, assertKind, discover, resolveSite, scanForStores, siteForNewStore } from "../src/site.mjs";
import { artifactCheckpoint } from "../src/domain/loop.mjs";

const git = (root, ...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

function scratch(t, name = "workloop-site-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

const init = (root, options = {}) => {
  const site = siteForNewStore(root, options);
  fs.mkdirSync(site.location, { recursive: true });
  createStore({ location: site.location, storeKind: site.kind, commandId: "genesis" });
  return site;
};

test("FS-01: a plain root keeps its ledger inside itself, with an identity nothing can derive", (t) => {
  const root = scratch(t);
  const site = init(root);
  assert.equal(site.kind, KIND.FS);
  assert.equal(site.location, path.join(root, ".workloop"));
  for (const entry of ["manifest.json", "segments", "snapshots", "locks"]) {
    assert.ok(fs.existsSync(path.join(site.location, entry)), entry);
  }

  const manifest = openStore(site.location).manifest;
  assert.equal(manifest.store_kind, KIND.FS);
  assert.ok(manifest.anchor, "genesis records the physical anchor");

  // The id carries entropy, so a copy has the same id and a different anchor —
  // which is the only reason a collision can be detected at all.
  const other = scratch(t);
  assert.notEqual(openStore(init(other).location).manifest.store_id, manifest.store_id);
});

test("FS-01: nothing is created where nobody asked for it", (t) => {
  const root = scratch(t);
  assert.equal(discover(root), null, "an unclaimed directory holds no store");
  assert.equal(fs.existsSync(path.join(root, ".workloop")), false, "and asking did not make one");
});

test("FS-01: a git workspace keeps its ledger in the common directory, shared by worktrees", (t) => {
  const root = scratch(t);
  git(root, "init", "-q", ".");
  git(root, "config", "user.email", "gate@workloop.test");
  git(root, "config", "user.name", "gate");
  fs.writeFileSync(path.join(root, "README"), "seed\n");
  git(root, "add", "README");
  git(root, "commit", "-q", "-m", "seed");

  const site = init(root);
  assert.equal(site.kind, KIND.GIT);
  assert.equal(fs.realpathSync(site.location), fs.realpathSync(path.join(root, ".git", "workloop")));

  // A second worktree finds the same ledger: the history belongs to the
  // repository, not to whichever checkout happens to be on disk.
  const worktree = path.join(scratch(t), "wt");
  git(root, "worktree", "add", "-q", worktree, "-b", "side");
  const found = discover(worktree);
  assert.equal(fs.realpathSync(found.location), fs.realpathSync(site.location));
  assert.equal(openStore(found.location).manifest.store_kind, KIND.GIT);
});

test("FS-01: a git store found from a subdirectory reports the worktree, not the subdirectory", (t) => {
  const root = scratch(t);
  git(root, "init", "-q", ".");
  git(root, "config", "user.email", "gate@workloop.test");
  git(root, "config", "user.name", "gate");
  fs.writeFileSync(path.join(root, "README"), "seed\n");
  git(root, "add", "README");
  git(root, "commit", "-q", "-m", "seed");
  init(root);

  // `--git-common-dir` answers the same from any depth, so a search that used
  // it alone stopped at the first directory it tried and called *that* the
  // workspace. Every git-regime verb then measured claims against the wrong
  // tree and refused outright.
  const deep = path.join(root, "src", "nested");
  fs.mkdirSync(deep, { recursive: true });
  const found = discover(deep);
  assert.equal(found.kind, KIND.GIT);
  assert.equal(fs.realpathSync(found.root), root, "the workspace is the worktree, not where the search began");
});

test("FS-02: the runtime's own files are never artifacts", (t) => {
  const root = scratch(t);
  const site = init(root);
  fs.writeFileSync(path.join(root, "work.txt"), "a\n");

  const before = artifactCheckpoint(root, ["."], { storeLocation: site.location });
  // Writing to the ledger is not a change to the tree the loop is working on.
  // Counted as one, a loop claiming "." would see its artifacts move on every
  // append — its progress signature would never repeat, and stuck detection
  // would go on existing while never firing again.
  openStore(site.location).append({
    commandId: "unrelated", requestDigest: `sha256:${"0".repeat(64)}`,
    prepare: () => [{ kind: "store_created", payload: {} }],
  });
  assert.equal(artifactCheckpoint(root, ["."], { storeLocation: site.location }), before, "the ledger writing itself is not artifact drift");

  fs.writeFileSync(path.join(root, "work.txt"), "b\n");
  assert.notEqual(artifactCheckpoint(root, ["."], { storeLocation: site.location }), before, "and real work still moves it");
});

test("FS-03: moving a root keeps its identity; deleting it takes the history with it", (t) => {
  const parent = scratch(t);
  const root = path.join(parent, "before");
  fs.mkdirSync(root);
  const site = init(root);
  const identity = openStore(site.location).manifest.store_id;

  // Same object, new name. The anchor is the inode, so the store is the store.
  const moved = path.join(parent, "after");
  fs.renameSync(root, moved);
  const afterMove = discover(moved);
  assert.equal(openStore(afterMove.location).manifest.store_id, identity, "a move is not a new store");

  // Deleting the root deletes the ledger. This is the accepted cost of a store
  // that lives in the thing it describes; `export` is the counter-measure, and
  // it has to have been taken already.
  fs.rmSync(moved, { recursive: true, force: true });
  assert.equal(discover(parent), null);

  fs.mkdirSync(moved);
  const rebuilt = init(moved);
  assert.notEqual(openStore(rebuilt.location).manifest.store_id, identity, "the same path is not the same store");
});

test("FS-04: nested stores are refused in both directions", (t) => {
  const outer = scratch(t);
  const inner = path.join(outer, "nested", "deep");
  fs.mkdirSync(inner, { recursive: true });

  // Outer first, then inner: caught by walking up.
  init(outer);
  assert.throws(() => siteForNewStore(inner), (error) => error.code === "STORE_NESTED_INSIDE");

  // Inner first, then outer: caught by the bounded downward scan.
  const other = scratch(t);
  const child = path.join(other, "child");
  fs.mkdirSync(child);
  init(child);
  assert.throws(() => siteForNewStore(other), (error) => error.code === "STORE_CONTAINS_NESTED");
});

test("FS-04: a scan that could not finish says so instead of passing", (t) => {
  const root = scratch(t);
  let deep = root;
  for (let level = 0; level < 12; level += 1) {
    deep = path.join(deep, `level-${level}`);
    fs.mkdirSync(deep);
  }
  // A store below the scan's depth limit. The scan cannot see it, so the
  // creation must refuse rather than report a clean check it never completed.
  init(deep);
  const scan = scanForStores(root);
  assert.equal(scan.found.length, 0, "it genuinely cannot see it");
  assert.equal(scan.exhausted, true, "and it knows that it cannot");
  assert.throws(() => siteForNewStore(root), (error) => error.code === "STORE_SCAN_INCOMPLETE");
});

test("FS-07: a plain root that later becomes a repository is a kind conflict, not a migration", (t) => {
  const root = scratch(t);
  const site = init(root);
  const manifest = openStore(site.location).manifest;
  assert.equal(assertKind(root, manifest), KIND.FS, "before, it resolves cleanly");

  git(root, "init", "-q", ".");
  fs.mkdirSync(path.join(root, ".git", "workloop"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "workloop", "manifest.json"), "{}");

  // Two ledgers, one name. Choosing either would hide the other's history, so
  // the runtime refuses everything until a person decides.
  assert.throws(() => assertKind(root, manifest), (error) => error.code === "STORE_KIND_CONFLICT");
  assert.throws(() => resolveSite(root), (error) => error.code === "STORE_KIND_CONFLICT");
  assert.throws(() => discover(root), (error) => error.code === "STORE_KIND_CONFLICT");
});
