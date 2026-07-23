import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
const PROVENANCE = ["--reason", "Ticket 06 exclusive placement", "--granted-by", "user"];

function run(args, { cwd = ROOT, session = "session-exclusive" } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, WORKLOOP_SESSION_ID: session, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" },
  });
}
function json(result) { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); }
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workloop-exclusive-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "main");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Workloop Test"]);
  git(repo, ["config", "user.email", "workloop@example.invalid"]);
  for (const directory of ["src", "other"]) fs.mkdirSync(path.join(repo, directory));
  fs.writeFileSync(path.join(repo, "src", "tracked.txt"), "src\n");
  fs.writeFileSync(path.join(repo, "other", "tracked.txt"), "other\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  return { root, repo, base: git(repo, ["rev-parse", "HEAD"]) };
}
function createExclusive(fx, { id = "exclusive-open", session = "session-exclusive", linked = path.join(fx.root, "linked"), branch = "workloop/exclusive-one" } = {}) {
  return json(run([
    "current-open", "--target", path.join(fx.repo, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--worktree-path", linked,
    "--branch", branch, "--base", fx.base,
    "--goal", "exclusive task", "--write-root", "src",
    "--command-id", id, ...PROVENANCE,
  ], { cwd: fx.repo, session }));
}
function ledger(target) { return json(run(["current-ledger", "--target", target], { cwd: ROOT })).records; }

test("explicit exclusive placement creates one linked attachment without changing caller cwd or main HEAD", (t) => {
  const fx = fixture(t, "create");
  const linked = path.join(fx.root, "linked");
  const callerCwd = process.cwd();
  const opened = createExclusive(fx, { linked });
  assert.equal(opened.placement, "exclusive_worktree");
  assert.equal(opened.task.placement, "exclusive_worktree");
  assert.equal(opened.task.branch_intent, "workloop/exclusive-one");
  assert.equal(opened.task.base_oid, fx.base);
  assert.equal(opened.attachment.observed_worktree_root, fs.realpathSync.native(linked));
  assert.equal(git(fx.repo, ["rev-parse", "HEAD"]), fx.base);
  assert.equal(git(linked, ["rev-parse", "HEAD"]), fx.base);
  assert.equal(git(linked, ["symbolic-ref", "--short", "HEAD"]), "workloop/exclusive-one");
  assert.equal(process.cwd(), callerCwd);

  const kinds = ledger(fx.repo).map((record) => record.kind);
  assert.deepEqual(kinds.slice(0, 3), ["authority_genesis", "exclusive_worktree_intent", "exclusive_worktree_ready"]);
  assert.equal(kinds.at(-1), "task_opened");
  const status = json(run(["current-status", "--target", path.join(linked, "src", "tracked.txt")], { cwd: fx.repo }));
  assert.equal(status.task.task_id, opened.task.task_id);
  assert.equal(status.routable, true);

  const second = run([
    "current-open", "--target", path.join(linked, "other", "tracked.txt"),
    "--placement", "partitioned", "--goal", "must not share exclusive attachment",
    "--write-root", "other", "--command-id", "second-live", ...PROVENANCE,
  ], { cwd: linked, session: "session-second" });
  assert.equal(second.status, 2);
  assert.match(second.stderr, /exclusive|placement/i);

  const mainTask = json(run([
    "current-open", "--target", path.join(fx.repo, "other", "tracked.txt"),
    "--placement", "partitioned", "--goal", "main partitioned task",
    "--write-root", "other", "--command-id", "main-partitioned", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-main" }));
  assert.equal(mainTask.placement, "partitioned");
  assert.notEqual(mainTask.attachment_id, opened.attachment_id);
});

test("existing linked worktree selection verifies explicit branch and base before any task append", (t) => {
  const fx = fixture(t, "select");
  const linked = path.join(fx.root, "selected");
  git(fx.repo, ["worktree", "add", "-q", "-b", "workloop/selected", linked, fx.base]);

  const wrong = run([
    "current-open", "--target", path.join(linked, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--branch", "workloop/wrong", "--base", fx.base,
    "--goal", "wrong branch", "--write-root", "src", "--command-id", "wrong-select", ...PROVENANCE,
  ], { cwd: fx.repo });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /branch/i);
  assert.equal(fs.existsSync(path.join(path.resolve(git(fx.repo, ["rev-parse", "--git-common-dir"])), "workloop", "authority.jsonl")), false);

  const selected = json(run([
    "current-open", "--target", path.join(linked, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--branch", "workloop/selected", "--base", fx.base,
    "--goal", "selected task", "--write-root", "src", "--command-id", "selected-open", ...PROVENANCE,
  ], { cwd: fx.repo }));
  assert.equal(selected.task.placement, "exclusive_worktree");
  assert.equal(selected.task.branch_intent, "workloop/selected");
  assert.equal(selected.task.base_oid, fx.base);
});

test("exclusive worktree removal preserves unavailable task truth and never cleans branch lifecycle", (t) => {
  const fx = fixture(t, "unavailable");
  const linked = path.join(fx.root, "linked");
  const opened = createExclusive(fx, { linked, branch: "workloop/retained" });
  fs.rmSync(linked, { recursive: true, force: true });
  git(fx.repo, ["worktree", "prune", "--expire", "now"]);

  const tasks = json(run(["current-tasks", "--target", fx.repo], { cwd: fx.repo }));
  const row = tasks.repository_tasks.find((item) => item.task.task_id === opened.task.task_id);
  assert.equal(row.availability, "unavailable");
  assert.equal(row.task.placement, "exclusive_worktree");
  assert.equal(git(fx.repo, ["show-ref", "--verify", "--hash", "refs/heads/workloop/retained"]), fx.base);
  assert.equal(fs.existsSync(linked), false);
  const retry = run([
    "current-open", "--target", path.join(fx.repo, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--worktree-path", linked, "--branch", "workloop/retained", "--base", fx.base,
    "--goal", "exclusive task", "--write-root", "src", "--command-id", "exclusive-open", ...PROVENANCE,
  ], { cwd: fx.repo });
  assert.equal(retry.status, 2);
  assert.match(retry.stderr, /explicit attended recovery/i);
  assert.equal(fs.existsSync(linked), false);
});

test("exclusive placement input is explicit, bounded, idempotent, and never guesses cleanup", (t) => {
  const fx = fixture(t, "contract");
  const linked = path.join(fx.root, "linked");
  for (const args of [
    ["--placement", "exclusive-worktree", "--worktree-path", linked, "--base", fx.base],
    ["--placement", "exclusive-worktree", "--worktree-path", linked, "--branch", "workloop/missing-base"],
    ["--placement", "partitioned", "--worktree-path", linked],
  ]) {
    const result = run([
      "current-open", "--target", path.join(fx.repo, "src", "tracked.txt"), ...args,
      "--goal", "invalid placement", "--write-root", "src", "--command-id", `invalid-${args.join("-")}`, ...PROVENANCE,
    ], { cwd: fx.repo });
    assert.equal(result.status, 2);
  }
  assert.equal(fs.existsSync(linked), false);

  const first = createExclusive(fx, { linked, id: "stable-exclusive" });
  const repeated = createExclusive(fx, { linked, id: "stable-exclusive" });
  assert.equal(repeated.task.task_id, first.task.task_id);
  assert.equal(ledger(fx.repo).filter((record) => record.kind === "exclusive_worktree_intent").length, 1);
  assert.equal(ledger(fx.repo).filter((record) => record.kind === "exclusive_worktree_ready").length, 1);

  const branchStillExists = git(fx.repo, ["show-ref", "--verify", "--hash", "refs/heads/workloop/exclusive-one"]);
  assert.equal(branchStillExists, fx.base);
  assert.equal(fs.existsSync(linked), true);
});


test("exclusive placement rejects invalid claims and nested Git worktrees before durable or Git side effects", (t) => {
  const fx = fixture(t, "preflight");
  const linked = path.join(fx.root, "linked");
  const excessive = Array.from({ length: 65 }, (_, index) => ["--write-root", "src/claim-" + index]).flat();
  const invalid = run([
    "current-open", "--target", path.join(fx.repo, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--worktree-path", linked, "--branch", "workloop/invalid-claims", "--base", fx.base,
    "--goal", "invalid claims", ...excessive, "--command-id", "invalid-claims", ...PROVENANCE,
  ], { cwd: fx.repo });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /write claims exceed/);
  assert.equal(fs.existsSync(linked), false);
  const common = path.resolve(git(fx.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  assert.equal(fs.existsSync(path.join(common, "workloop", "authority.jsonl")), false);

  const first = path.join(fx.root, "first");
  git(fx.repo, ["worktree", "add", "-q", "-b", "workloop/first", first, fx.base]);
  const nested = path.join(first, "nested");
  const nestedResult = run([
    "current-open", "--target", path.join(fx.repo, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--worktree-path", nested, "--branch", "workloop/nested", "--base", fx.base,
    "--goal", "nested", "--write-root", "src", "--command-id", "nested-reject", ...PROVENANCE,
  ], { cwd: fx.repo });
  assert.equal(nestedResult.status, 2);
  assert.match(nestedResult.stderr, /nested|contain/i);
  assert.equal(fs.existsSync(nested), false);

  const foreign = path.join(fx.root, "foreign");
  fs.mkdirSync(foreign);
  git(foreign, ["init", "-q"]);
  const foreignNested = path.join(foreign, "nested");
  const foreignResult = run([
    "current-open", "--target", path.join(fx.repo, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--worktree-path", foreignNested, "--branch", "workloop/foreign", "--base", fx.base,
    "--goal", "foreign nested", "--write-root", "src", "--command-id", "foreign-reject", ...PROVENANCE,
  ], { cwd: fx.repo });
  assert.equal(foreignResult.status, 2);
  assert.match(foreignResult.stderr, /unrelated|nested/i);
  assert.equal(fs.existsSync(foreignNested), false);
});

test("pending exclusive creation binds the complete request and never adopts partial Git state", (t) => {
  const fx = fixture(t, "pending");
  const blockedParent = path.join(fx.root, "not-a-directory");
  fs.writeFileSync(blockedParent, "file");
  const linked = path.join(blockedParent, "linked");
  const args = [
    "current-open", "--target", path.join(fx.repo, "src", "tracked.txt"),
    "--placement", "exclusive-worktree", "--worktree-path", linked, "--branch", "workloop/pending", "--base", fx.base,
    "--goal", "pending create", "--write-root", "src", "--command-id", "pending-create", ...PROVENANCE,
  ];
  const first = run(args, { cwd: fx.repo, session: "session-pending" });
  assert.equal(first.status, 2);
  assert.match(first.stderr, /worktree add failed|Not a directory/i);
  const records = ledger(fx.repo);
  const intent = records.find((record) => record.kind === "exclusive_worktree_intent");
  assert.equal(intent.payload.action, "create");
  assert.equal(intent.payload.session_id, "session-pending");
  assert.match(intent.payload.request_digest, /^sha256:/);
  assert.equal(Object.hasOwn(intent.payload, "source_attachment_id"), false);
  assert.equal(records.some((record) => record.kind === "exclusive_worktree_ready"), false);

  const repeated = run(args, { cwd: fx.repo, session: "session-pending" });
  assert.equal(repeated.status, 2);
  assert.match(repeated.stderr, /explicit attended recovery/i);
  const drifted = run(args.map((value) => value === "pending create" ? "different request" : value), { cwd: fx.repo, session: "session-other" });
  assert.equal(drifted.status, 2);
  assert.match(drifted.stderr, /conflicts with its durable intent/i);
  assert.equal(ledger(fx.repo).filter((record) => record.kind === "exclusive_worktree_intent").length, 1);
  assert.equal(fs.existsSync(linked), false);
});
