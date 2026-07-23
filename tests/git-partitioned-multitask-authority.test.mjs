import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
const PROVENANCE = ["--reason", "Ticket 05 partitioned routing", "--granted-by", "self"];

function run(args, { cwd = ROOT, input = "", session = null } = {}) {
  const env = { ...process.env, WORKLOOP_SESSION_ID: session ?? "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, input, env, encoding: "utf8", timeout: 15_000 });
}
function json(result) { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); }
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

function initRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Workloop Test"]);
  git(repo, ["config", "user.email", "workloop@example.invalid"]);
  for (const directory of ["alpha", "beta", "gamma", "work", "src"]) fs.mkdirSync(path.join(repo, directory));
  for (const file of ["alpha/tracked.txt", "beta/tracked.txt", "gamma/tracked.txt", "work/tracked.txt", "src/tracked.txt"]) fs.writeFileSync(path.join(repo, file), file + "\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "work/ignored.txt\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(repo, "work", "untracked.txt"), "untracked\n");
  fs.writeFileSync(path.join(repo, "work", "ignored.txt"), "ignored\n");
  return repo;
}
function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workloop-partitioned-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo: initRepo(root, "repo") };
}
function openTask(repo, { id, session, writeRoot, writePath = null, target = null }) {
  const claims = writePath === null ? ["--write-root", writeRoot] : ["--write-path", writePath];
  return json(run([
    "current-open", "--target", target ?? path.join(repo, writeRoot ?? path.dirname(writePath), "future.txt"),
    "--goal", `task ${id}`, ...claims, "--command-id", id, ...PROVENANCE,
  ], { cwd: repo, session }));
}
function mutate(repo, action, taskId, commandId, session) {
  return run([
    `current-${action}`, "--target", repo, "--task-id", taskId,
    "--command-id", commandId, "--reason", `${action} for Ticket 05`, "--granted-by", "self",
  ], { cwd: repo, session });
}
function ledger(target) { return json(run(["current-ledger", "--target", target], { cwd: ROOT })).records; }
function preHook({ cwd, session, operationId, toolName = "Write", toolInput }) {
  return run(["current-hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", cwd, session_id: session, permission_mode: "bypassPermissions",
      tool_use_id: operationId, tool_name: toolName, tool_input: toolInput,
    }),
  });
}

test("one attachment hosts disjoint tasks; live claims and session bindings follow lifecycle", (t) => {
  const fx = fixture(t, "lifecycle");
  const commonDir = path.resolve(git(fx.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const withoutSession = run([
    "current-open", "--target", path.join(fx.repo, "alpha", "future.txt"), "--goal", "host session required",
    "--write-root", "alpha", "--command-id", "missing-session", ...PROVENANCE,
  ], { cwd: fx.repo });
  assert.equal(withoutSession.status, 2);
  assert.match(withoutSession.stderr, /real host session identity/);
  assert.equal(fs.existsSync(path.join(commonDir, "workloop", "authority.jsonl")), false);

  const legacy = run([
    "current-open", "--target", fx.repo, "--goal", "legacy is forbidden",
    "--files", "alpha/**", "--command-id", "legacy-open", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-legacy" });
  assert.equal(legacy.status, 2);
  assert.match(legacy.stderr, /Unknown option '--files'/);
  const glob = run([
    "current-open", "--target", fx.repo, "--goal", "glob is forbidden",
    "--write-root", "alpha/**", "--command-id", "glob-open", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-glob" });
  assert.equal(glob.status, 2);
  assert.match(glob.stderr, /structured repository-relative paths/);

  const alpha = openTask(fx.repo, { id: "open-alpha", session: "session-alpha", writeRoot: "alpha" });
  const beta = openTask(fx.repo, { id: "open-beta", session: "session-beta", writeRoot: "beta" });
  assert.equal(beta.authority_id, alpha.authority_id);
  assert.equal(beta.attachment_id, alpha.attachment_id);
  assert.notEqual(beta.task.task_id, alpha.task.task_id);
  const catalog = json(run(["current-tasks", "--target", fx.repo], { cwd: fx.repo }));
  assert.equal(catalog.repository_attachments.length, 1);
  assert.equal(catalog.repository_tasks.length, 2);

  const alphaStatus = json(run(["current-status", "--target", path.join(fx.repo, "alpha", "tracked.txt")], { cwd: fx.repo, session: "session-alpha" }));
  const betaStatus = json(run(["current-status", "--target", path.join(fx.repo, "beta", "tracked.txt")], { cwd: fx.repo, session: "session-beta" }));
  assert.equal(alphaStatus.task.task_id, alpha.task.task_id);
  assert.equal(betaStatus.task.task_id, beta.task.task_id);
  const wrongSession = json(run(["current-status", "--target", path.join(fx.repo, "alpha", "tracked.txt")], { cwd: fx.repo, session: "session-beta" }));
  assert.equal(wrongSession.routable, false);
  assert.equal(wrongSession.routing_reason, "session_task_mismatch");
  const ambiguousRoot = json(run(["current-status", "--target", fx.repo], { cwd: fx.repo }));
  assert.equal(ambiguousRoot.routable, false);
  assert.equal(ambiguousRoot.routing_reason, "task_scope_unclaimed");

  const overlap = run([
    "current-open", "--target", path.join(fx.repo, "alpha", "nested", "future.txt"), "--goal", "overlap",
    "--write-root", "alpha/nested", "--command-id", "open-overlap", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-overlap" });
  assert.equal(overlap.status, 2);
  assert.match(overlap.stderr, /write scope overlap/);
  const sameSession = run([
    "current-open", "--target", path.join(fx.repo, "gamma", "future.txt"), "--goal", "same session",
    "--write-root", "gamma", "--command-id", "open-same-session", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-alpha" });
  assert.equal(sameSession.status, 2);
  assert.match(sameSession.stderr, /session uniqueness/);

  const suspended = json(mutate(fx.repo, "suspend", alpha.task.task_id, "suspend-alpha", "session-alpha"));
  assert.equal(suspended.task.lifecycle.state, "suspended");
  const retained = run([
    "current-open", "--target", path.join(fx.repo, "alpha", "future-2.txt"), "--goal", "retained claim",
    "--write-root", "alpha", "--command-id", "open-retained", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-new" });
  assert.equal(retained.status, 2);
  assert.match(retained.stderr, /write scope overlap/);

  const joined = json(mutate(fx.repo, "join", beta.task.task_id, "join-beta", "session-third"));
  assert.deepEqual(joined.task.participant_session_ids, ["session-beta", "session-third"]);
  const collision = mutate(fx.repo, "join", beta.task.task_id, "join-beta-alpha", "session-alpha");
  assert.equal(collision.status, 2);
  assert.match(collision.stderr, /session uniqueness/);
  const abandoned = json(mutate(fx.repo, "abandon", alpha.task.task_id, "abandon-alpha", "session-alpha"));
  assert.equal(abandoned.task.lifecycle.state, "terminal");
  const replacement = openTask(fx.repo, { id: "open-alpha-replacement", session: "session-alpha", writeRoot: "alpha" });
  assert.notEqual(replacement.task.task_id, alpha.task.task_id);
  assert.equal(replacement.routable, true);
});

test("tracked state never selects authority and control targets are excluded before task routing", (t) => {
  const fx = fixture(t, "target-classes");
  const opened = openTask(fx.repo, { id: "open-work", session: "session-work", writeRoot: "work" });
  const targets = [
    path.join(fx.repo, "work", "tracked.txt"),
    path.join(fx.repo, "work", "untracked.txt"),
    path.join(fx.repo, "work", "ignored.txt"),
    path.join(fx.repo, "work", "not-created", "future.txt"),
  ];
  for (const target of targets) {
    const status = json(run(["current-status", "--target", target], { cwd: fx.repo }));
    assert.equal(status.authority_id, opened.authority_id);
    assert.equal(status.attachment_id, opened.attachment_id);
    assert.equal(status.task.task_id, opened.task.task_id);
    assert.equal(status.routable, true);
  }
  const commonDir = path.resolve(git(fx.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const before = ledger(fx.repo).length;
  for (const control of [path.join(commonDir, "config"), path.join(fx.repo, ".workloop", "private")]) {
    const status = run(["current-status", "--target", control], { cwd: fx.repo, session: "session-work" });
    assert.equal(status.status, 2);
    assert.match(status.stderr, /control paths/);
    const hook = preHook({ cwd: fx.repo, session: "session-work", operationId: "control-" + path.basename(control), toolInput: { file_path: control } });
    assert.equal(hook.status, 0);
    assert.equal(hook.stdout, "");
    assert.match(hook.stderr, /host retains execution authority/);
  }
  assert.equal(ledger(fx.repo).length, before);
});

test("external and multi-authority Hook targets are target-owned and shard-local", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-multi-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoA = initRepo(root, "repo-a");
  const repoB = initRepo(root, "repo-b");
  const unsupervised = path.join(root, "unmanaged");
  fs.mkdirSync(unsupervised);
  const session = "session-shared-authorities";
  const taskA = openTask(repoA, { id: "open-a", session, writeRoot: "src" });
  const taskB = openTask(repoB, { id: "open-b", session, writeRoot: "src" });
  const targetA = path.join(repoA, "src", "tracked.txt");
  const targetB = path.join(repoB, "src", "tracked.txt");

  const beforeA = ledger(repoA).length;
  const beforeB = ledger(repoB).length;
  const external = preHook({ cwd: repoA, session, operationId: "external-b", toolInput: { file_path: targetB } });
  assert.equal(external.status, 0, external.stderr);
  assert.equal(external.stderr, "");
  assert.equal(ledger(repoA).length, beforeA);
  assert.equal(ledger(repoB).length, beforeB + 1);
  assert.equal(ledger(repoB).at(-1).payload.task_id, taskB.task.task_id);

  const unmanaged = preHook({ cwd: repoA, session, operationId: "unmanaged", toolInput: { file_path: path.join(unsupervised, "future.txt") } });
  assert.equal(unmanaged.status, 0);
  assert.equal(unmanaged.stdout, "");
  assert.match(unmanaged.stderr, /host retains execution authority/);
  assert.equal(ledger(repoA).length, beforeA);
  assert.equal(ledger(repoB).length, beforeB + 1);

  const multi = preHook({
    cwd: repoA, session, operationId: "shared-operation", toolName: "apply_patch",
    toolInput: { patch: "*** Begin Patch\n*** Update File: " + targetA + "\n*** Update File: " + targetB + "\n*** End Patch" },
  });
  assert.equal(multi.status, 0, multi.stderr);
  assert.equal(multi.stderr, "");
  const receiptA = ledger(repoA).filter((record) => record.kind === "operation_intent_recorded" && record.payload.operation_id === "shared-operation");
  const receiptB = ledger(repoB).filter((record) => record.kind === "operation_intent_recorded" && record.payload.operation_id === "shared-operation");
  assert.equal(receiptA.length, 1);
  assert.equal(receiptB.length, 1);
  assert.equal(receiptA[0].payload.task_id, taskA.task.task_id);
  assert.equal(receiptB[0].payload.task_id, taskB.task.task_id);
  assert.notEqual(receiptA[0].payload.task_id, receiptB[0].payload.task_id);
});


test("repository-root routing requires an explicit root claim", (t) => {
  const fx = fixture(t, "root-routing");
  fs.mkdirSync(path.join(fx.repo, "..."));
  const dottedRoot = run([
    "current-open", "--target", fx.repo, "--goal", "dot-named directory must not expand",
    "--write-root", "...", "--command-id", "open-dot-name-at-root", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-dot-name" });
  assert.equal(dottedRoot.status, 2);
  assert.match(dottedRoot.stderr, /outside its canonical write claims/);
  const commonDir = path.resolve(git(fx.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  assert.equal(fs.existsSync(path.join(commonDir, "workloop", "authority.jsonl")), false);

  const dotted = openTask(fx.repo, {
    id: "open-dot-name", session: "session-dot-name", writeRoot: "...",
    target: path.join(fx.repo, "...", "future.txt"),
  });
  assert.deepEqual(dotted.task.write_claims, [{ kind: "root", path: "..." }]);
  json(mutate(fx.repo, "abandon", dotted.task.task_id, "abandon-dot-name", "session-dot-name"));

  const alpha = openTask(fx.repo, { id: "open-root-alpha", session: "session-alpha", writeRoot: "alpha" });

  const explicit = json(run([
    "current-status", "--target", fx.repo, "--task-id", alpha.task.task_id,
  ], { cwd: fx.repo, session: "session-alpha" }));
  assert.equal(explicit.routable, false);
  assert.equal(explicit.routing_reason, "task_scope_unclaimed");

  const implicit = json(run(["current-status", "--target", fx.repo], { cwd: fx.repo, session: "session-alpha" }));
  assert.equal(implicit.routable, false);
  assert.equal(implicit.routing_reason, "task_scope_unclaimed");

  const beforeMismatchedOpen = ledger(fx.repo).length;
  const mismatchedOpen = run([
    "current-open", "--target", fx.repo, "--goal", "root target with child claim",
    "--write-root", "beta", "--command-id", "open-root-mismatch", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-beta" });
  assert.equal(mismatchedOpen.status, 2);
  assert.match(mismatchedOpen.stderr, /outside its canonical write claims/);
  assert.equal(ledger(fx.repo).length, beforeMismatchedOpen);

  json(mutate(fx.repo, "abandon", alpha.task.task_id, "abandon-root-alpha", "session-alpha"));
  const rootTask = openTask(fx.repo, {
    id: "open-repository-root", session: "session-root", writeRoot: ".", target: fx.repo,
  });
  assert.deepEqual(rootTask.task.write_claims, [{ kind: "root", path: "." }]);
  assert.equal(rootTask.routable, true);
  const nested = json(run(["current-status", "--target", path.join(fx.repo, "beta", "tracked.txt")], {
    cwd: fx.repo, session: "session-root",
  }));
  assert.equal(nested.task.task_id, rootTask.task.task_id);

  const beforeOverlap = ledger(fx.repo).length;
  const overlap = run([
    "current-open", "--target", path.join(fx.repo, "gamma", "future.txt"), "--goal", "root overlap",
    "--write-root", "gamma", "--command-id", "open-root-overlap", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-gamma" });
  assert.equal(overlap.status, 2);
  assert.match(overlap.stderr, /write scope overlap/);
  assert.equal(ledger(fx.repo).length, beforeOverlap);
});

test("canonical claim identity closes symlink and case aliases and sorts without locale", (t) => {
  const fx = fixture(t, "claim-identity");
  const alias = path.join(fx.repo, "alias-alpha");
  fs.symlinkSync(path.join(fx.repo, "alpha"), alias, process.platform === "win32" ? "junction" : "dir");
  const aliased = openTask(fx.repo, {
    id: "open-alias",
    session: "session-alias",
    writeRoot: "alias-alpha",
    target: path.join(alias, "future.txt"),
  });
  assert.deepEqual(aliased.task.write_claims, [{ kind: "root", path: "alpha" }]);

  const beforeOverlap = ledger(fx.repo).length;
  const physicalOverlap = run([
    "current-open", "--target", path.join(fx.repo, "alpha", "nested", "future.txt"), "--goal", "physical overlap",
    "--write-root", "alpha/nested", "--command-id", "open-physical-overlap", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-physical-overlap" });
  assert.equal(physicalOverlap.status, 2);
  assert.match(physicalOverlap.stderr, /write scope overlap/);
  assert.equal(ledger(fx.repo).length, beforeOverlap);

  if (process.platform === "win32" || process.platform === "darwin") {
    const caseOverlap = run([
      "current-open", "--target", path.join(fx.repo, "ALPHA", "other.txt"), "--goal", "case overlap",
      "--write-root", "ALPHA", "--command-id", "open-case-overlap", ...PROVENANCE,
    ], { cwd: fx.repo, session: "session-case-overlap" });
    assert.equal(caseOverlap.status, 2);
    assert.match(caseOverlap.stderr, /write scope overlap/);
    assert.equal(ledger(fx.repo).length, beforeOverlap);
  }

  const ordered = json(run([
    "current-open", "--target", path.join(fx.repo, "gamma", "Z.txt"), "--goal", "deterministic claim order",
    "--write-path", "gamma/©.txt", "--write-path", "gamma/Z.txt", "--write-path", "gamma/a.txt",
    "--command-id", "open-ordered", ...PROVENANCE,
  ], { cwd: fx.repo, session: "session-ordered" }));
  const keys = ordered.task.write_claims.map((claim) => `${claim.path}\0${claim.kind}`);
  assert.deepEqual(keys, [...keys].sort());
});

test("explicit task selection and lifecycle mutations cannot cross target attachment or session", (t) => {
  const fx = fixture(t, "explicit-routing");
  const alpha = openTask(fx.repo, { id: "open-explicit-alpha", session: "session-alpha", writeRoot: "alpha" });
  openTask(fx.repo, { id: "open-explicit-beta", session: "session-beta", writeRoot: "beta" });

  const wrongScope = json(run([
    "current-status", "--target", path.join(fx.repo, "beta", "tracked.txt"), "--task-id", alpha.task.task_id,
  ], { cwd: fx.repo, session: "session-alpha" }));
  assert.equal(wrongScope.routable, false);
  assert.equal(wrongScope.routing_reason, "task_scope_unclaimed");
  const wrongSession = json(run([
    "current-status", "--target", path.join(fx.repo, "alpha", "tracked.txt"), "--task-id", alpha.task.task_id,
  ], { cwd: fx.repo, session: "session-beta" }));
  assert.equal(wrongSession.routable, false);
  assert.equal(wrongSession.routing_reason, "session_task_mismatch");

  const linked = path.join(fx.root, "linked");
  git(fx.repo, ["worktree", "add", "-q", "-b", "linked-ticket05", linked]);
  const linkedTask = openTask(linked, {
    id: "open-linked-lifecycle",
    session: "session-linked",
    writeRoot: "src",
    target: path.join(linked, "src", "tracked.txt"),
  });
  const wrongAttachment = mutate(fx.repo, "suspend", linkedTask.task.task_id, "suspend-linked-from-main", "session-linked");
  assert.equal(wrongAttachment.status, 2);
  assert.match(wrongAttachment.stderr, /task attachment/);
  const outsider = mutate(linked, "suspend", linkedTask.task.task_id, "suspend-linked-outsider", "session-outsider");
  assert.equal(outsider.status, 2);
  assert.match(outsider.stderr, /participant session/);

  const suspended = json(mutate(linked, "suspend", linkedTask.task.task_id, "suspend-linked-owner", "session-linked"));
  assert.equal(suspended.task.lifecycle.state, "suspended");
  const resumed = json(mutate(linked, "resume", linkedTask.task.task_id, "resume-linked-owner", "session-linked"));
  assert.equal(resumed.task.lifecycle.state, "active");
});

test("same host operation id from two participant sessions keeps both receipts", (t) => {
  const fx = fixture(t, "participant-receipts");
  const task = openTask(fx.repo, { id: "open-participants", session: "session-one", writeRoot: "beta" });
  json(mutate(fx.repo, "join", task.task.task_id, "join-participant-two", "session-two"));
  const target = path.join(fx.repo, "beta", "tracked.txt");
  for (const session of ["session-one", "session-two"]) {
    const receipt = preHook({ cwd: fx.repo, session, operationId: "shared-session-operation", toolInput: { file_path: target } });
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.equal(receipt.stderr, "");
  }
  const receipts = ledger(fx.repo).filter((record) =>
    record.kind === "operation_intent_recorded" && record.payload.operation_id === "shared-session-operation");
  assert.equal(receipts.length, 2);
  assert.deepEqual(new Set(receipts.map((record) => record.payload.session_id)), new Set(["session-one", "session-two"]));
});
