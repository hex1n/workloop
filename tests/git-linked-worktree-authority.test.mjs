import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../lib/prims.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
const TEST_AUTHORITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-linked-authority-home-"));
process.env.WORKLOOP_AUTHORITY_HOME = TEST_AUTHORITY_HOME;
process.once("exit", () => fs.rmSync(TEST_AUTHORITY_HOME, { recursive: true, force: true }));
const PROVENANCE = ["--reason", "Ticket 04 lifecycle", "--granted-by", "self"];

function run(args, { cwd = ROOT, env = process.env, input = undefined } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8", timeout: 15_000 });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workloop-linked-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "main");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Workloop Test"]);
  git(repo, ["config", "user.email", "workloop@example.invalid"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "tracked.txt"), "tracked\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  return { root, repo };
}

function addWorktree(fx, name, target) {
  git(fx.repo, ["worktree", "add", "-q", "-b", name, target]);
}

function openTask(fx, target, commandId, goal) {
  return json(run([
    "current-open", "--target", path.join(target, "src", "tracked.txt"), "--goal", goal, "--write-root", "src",
    "--command-id", commandId, ...PROVENANCE,
  ], { cwd: fx.root, env: { ...process.env, WORKLOOP_SESSION_ID: `session-${commandId}` } }));
}

function repositoryTasks(fx) {
  return json(run(["current-tasks", "--target", fx.repo], { cwd: fx.root }));
}

test("main and linked worktrees share authority while target routing preserves attachment identity across move", (t) => {
  const fx = fixture(t, "move");
  const main = openTask(fx, fx.repo, "open-main", "main task");
  const linkedRoot = path.join(fx.root, "linked-one");
  addWorktree(fx, "linked-one", linkedRoot);
  const linked = openTask(fx, linkedRoot, "open-linked", "linked task");
  const linkedCanonical = fs.realpathSync.native(linkedRoot);

  assert.equal(linked.authority_id, main.authority_id);
  assert.notEqual(linked.attachment_id, main.attachment_id);
  assert.notEqual(linked.task.task_id, main.task.task_id);

  const sharedOperationId = "shared-host-operation";
  const hookPayload = (target, sessionId) => JSON.stringify({
    hook_event_name: "PreToolUse", cwd: fx.root, session_id: sessionId, permission_mode: "bypassPermissions",
    tool_use_id: sharedOperationId, tool_name: "Write", tool_input: { file_path: target },
  });
  for (const [target, sessionId] of [[path.join(fx.repo, "src", "tracked.txt"), "session-open-main"], [path.join(linkedRoot, "src", "tracked.txt"), "session-open-linked"]]) {
    const receipt = run(["current-hook", "--profile", "codex-safe", "--mode", "nudge"], { cwd: fx.root, input: hookPayload(target, sessionId) });
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.equal(receipt.stderr, "");
  }
  const sharedReceipts = json(run(["current-ledger", "--target", fx.repo])).records.filter((record) => record.kind === "operation_intent_recorded" && record.payload.operation_id === sharedOperationId);
  assert.equal(sharedReceipts.length, 2);
  assert.deepEqual(new Set(sharedReceipts.map((record) => record.payload.task_id)), new Set([main.task.task_id, linked.task.task_id]));

  assert.equal(json(run(["current-status", "--target", path.join(fx.repo, "src", "tracked.txt")])).task.task_id, main.task.task_id);
  assert.equal(json(run(["current-status", "--target", path.join(linkedRoot, "src", "tracked.txt")])).task.task_id, linked.task.task_id);

  const before = repositoryTasks(fx);
  assert.equal(before.repository_tasks.length, 2);
  assert.deepEqual(before.repository_tasks.map((item) => item.availability), ["available", "available"]);
  const linkedBefore = before.repository_tasks.find((item) => item.attachment_id === linked.attachment_id);
  assert.equal(linkedBefore.path_status, "unchanged");
  assert.equal(linkedBefore.claimed_worktree_root, linkedCanonical);
  assert.equal(linkedBefore.observed_worktree_root, linkedCanonical);

  const movedRoot = path.join(fx.root, "linked-moved");
  git(fx.repo, ["worktree", "move", linkedRoot, movedRoot]);
  const movedCanonical = fs.realpathSync.native(movedRoot);
  const moved = json(run(["current-status", "--target", path.join(movedRoot, "src", "tracked.txt")], { cwd: fx.root }));
  assert.equal(moved.routable, true);
  assert.equal(moved.attachment_id, linked.attachment_id);
  assert.equal(moved.task.task_id, linked.task.task_id);
  assert.equal(moved.attachment.path_status, "moved");
  assert.equal(moved.attachment.claimed_worktree_root, linkedCanonical);
  assert.equal(moved.attachment.observed_worktree_root, movedCanonical);

  fs.rmSync(moved.snapshot_path, { force: true });
  fs.rmSync(moved.outcome_path, { force: true });
  const replayed = repositoryTasks(fx);
  assert.equal(replayed.repository_tasks.length, 2);
  assert.equal(replayed.repository_tasks.find((item) => item.attachment_id === linked.attachment_id).task.task_id, linked.task.task_id);
});

test("remove, prune, and same-path recreation retain old tasks without reusing attachment identity", (t) => {
  const fx = fixture(t, "reuse");
  const oldRoot = path.join(fx.root, "reused");
  addWorktree(fx, "reuse-old", oldRoot);
  const oldTask = openTask(fx, oldRoot, "open-old", "old linked task");

  git(fx.repo, ["worktree", "remove", "--force", oldRoot]);
  const removed = repositoryTasks(fx);
  const removedRow = removed.repository_tasks.find((item) => item.attachment_id === oldTask.attachment_id);
  assert.equal(removedRow.availability, "unavailable");
  assert.equal(removedRow.unavailable_reason, "git_admin_unavailable");
  assert.equal(removedRow.task.task_id, oldTask.task.task_id);

  addWorktree(fx, "reuse-new", oldRoot);
  const replacement = openTask(fx, oldRoot, "open-replacement", "replacement linked task");
  assert.equal(replacement.authority_id, oldTask.authority_id);
  assert.notEqual(replacement.attachment_id, oldTask.attachment_id);
  assert.notEqual(replacement.task.task_id, oldTask.task.task_id);
  assert.equal(json(run(["current-status", "--target", path.join(oldRoot, "src", "tracked.txt")])).task.task_id, replacement.task.task_id);

  const afterReuse = repositoryTasks(fx);
  assert.equal(afterReuse.repository_tasks.length, 2);
  const oldAfterReuse = afterReuse.repository_tasks.find((item) => item.attachment_id === oldTask.attachment_id);
  const newAfterReuse = afterReuse.repository_tasks.find((item) => item.attachment_id === replacement.attachment_id);
  assert.equal(oldAfterReuse.availability, "unavailable");
  assert.equal(oldAfterReuse.unavailable_reason, "anchor_mismatch");
  assert.equal(newAfterReuse.availability, "available");

  const pruneRoot = path.join(fx.root, "pruned");
  addWorktree(fx, "prune-old", pruneRoot);
  const prunedTask = openTask(fx, pruneRoot, "open-pruned", "pruned linked task");
  fs.rmSync(pruneRoot, { recursive: true, force: true });
  git(fx.repo, ["worktree", "prune", "--expire", "now"]);
  const afterPrune = repositoryTasks(fx);
  const prunedRow = afterPrune.repository_tasks.find((item) => item.attachment_id === prunedTask.attachment_id);
  assert.equal(prunedRow.availability, "unavailable");
  assert.equal(prunedRow.task.task_id, prunedTask.task.task_id);
  assert.equal(afterPrune.repository_tasks.length, 3);
});

test("main worktree move preserves attachment identity and changes only path observation", (t) => {
  const fx = fixture(t, "main-move");
  const opened = openTask(fx, fx.repo, "open-main-move", "movable main task");
  const claimedRoot = fs.realpathSync.native(fx.repo);
  const movedRoot = path.join(fx.root, "main-moved");
  fs.renameSync(fx.repo, movedRoot);
  const observedRoot = fs.realpathSync.native(movedRoot);

  const moved = json(run(["current-status", "--target", path.join(movedRoot, "src", "tracked.txt")], { cwd: fx.root }));
  assert.equal(moved.routable, true);
  assert.equal(moved.attachment_id, opened.attachment_id);
  assert.equal(moved.task.task_id, opened.task.task_id);
  assert.equal(moved.attachment.availability, "available");
  assert.equal(moved.attachment.path_status, "moved");
  assert.equal(moved.attachment.claimed_worktree_root, claimedRoot);
  assert.equal(moved.attachment.observed_worktree_root, observedRoot);
});

test("hash-valid duplicate stable anchors are rejected by replay", (t) => {
  const fx = fixture(t, "duplicate-anchor");
  openTask(fx, fx.repo, "open-anchor-source", "anchor source");
  const records = json(run(["current-ledger", "--target", fx.repo])).records;
  const prior = records.at(-1);
  const stage = records.find((record) => record.kind === "attachment_stage_intent");
  const invalid = {
    authority_schema_version: 1, sequence: prior.sequence + 1, previous_digest: prior.record_digest,
    record_id: randomUUID(), command_id: "duplicate-stable-anchor", kind: "attachment_stage_intent",
    payload: { ...stage.payload, attachment_id: randomUUID(), claim_token: randomUUID() },
  };
  invalid.record_digest = sha256Hex(canonicalJson(invalid));
  const commonDir = path.resolve(git(fx.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  fs.appendFileSync(path.join(commonDir, "workloop", "authority.jsonl"), canonicalJson(invalid) + "\n");

  const rejected = run(["current-status", "--target", path.join(fx.repo, "src", "tracked.txt")]);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /attachment anchor uniqueness/);
});

test("a copied locator cannot route old task history at another live Git admin anchor", (t) => {
  const fx = fixture(t, "copied-locator");
  const main = openTask(fx, fx.repo, "open-copy-source", "copy source");
  const linkedRoot = path.join(fx.root, "copy-target");
  addWorktree(fx, "copy-target", linkedRoot);
  const linkedGitDir = path.resolve(git(linkedRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  fs.copyFileSync(main.locator_path, path.join(linkedGitDir, ".workloop-root.jsonl"));

  const copied = json(run(["current-status", "--target", path.join(linkedRoot, "src", "tracked.txt")], { cwd: fx.root }));
  assert.equal(copied.authority_id, main.authority_id);
  assert.equal(copied.attachment_id, main.attachment_id);
  assert.equal(copied.routable, false);
  assert.equal(copied.routing_reason, "attachment_collision");

  const provider = fs.readFileSync(path.join(ROOT, "lib", "git-authority-provider.mjs"), "utf8");
  assert.match(provider, /worktree["']?\s*,\s*["']list|worktree list/);
  const application = fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8");
  assert.match(application, /"current-tasks"/);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  for (const name of ["test", "test:matrix", "test:windows"]) assert.match(scripts[name], /tests\/git-linked-worktree-authority\.test\.mjs/);
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(workflow, /Current Git authority[\s\S]*tests\/git-linked-worktree-authority\.test\.mjs/);
});
