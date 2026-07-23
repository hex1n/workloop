import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../lib/prims.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
const PROVENANCE = ["--reason", "Ticket 07 filesystem authority", "--granted-by", "self"];

function fixture(t, name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `workloop-filesystem-${name}-`));
  const root = path.join(base, "root");
  const home = path.join(base, "home");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, home };
}
function run(fx, args, { session = null, cwd = ROOT, input = "" } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, WORKLOOP_AUTHORITY_HOME: fx.home, WORKLOOP_SESSION_ID: session ?? "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" },
  });
}
function json(result) { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); }
function open(fx, { target = null, root = fx.root, id = "open", session = "filesystem-session", writeRoot = "src" } = {}) {
  target ??= path.join(root, writeRoot, "future.txt");
  return json(run(fx, [
    "current-open", "--target", target, "--filesystem-root", root, "--goal", `filesystem ${id}`,
    "--write-root", writeRoot, "--command-id", id, ...PROVENANCE,
  ], { session }));
}
function records(fx, authorityId) { return fs.readFileSync(path.join(fx.home, "authorities", authorityId, "authority.jsonl"), "utf8").trim().split("\n").map(JSON.parse); }

test("explicit filesystem root creates a detached authority and locator-only root with partitioned lifecycle", (t) => {
  const fx = fixture(t, "open");
  const implicit = run(fx, [
    "current-open", "--target", path.join(fx.root, "src", "future.txt"), "--goal", "must be explicit",
    "--write-root", "src", "--command-id", "implicit", ...PROVENANCE,
  ], { session: "implicit" });
  assert.equal(implicit.status, 2);
  assert.match(implicit.stderr, /Git worktree|filesystem-root/);

  const alpha = open(fx, { id: "open-alpha", session: "session-alpha", writeRoot: "alpha" });
  assert.equal(alpha.provider, "filesystem_detached");
  assert.equal(alpha.routable, true);
  assert.equal(fs.existsSync(path.join(fx.root, ".workloop-filesystem-root.jsonl")), true);
  assert.equal(fs.existsSync(path.join(fx.root, "authority.jsonl")), false);
  assert.equal(fs.existsSync(path.join(fx.home, "authorities", alpha.authority_id, "authority.jsonl")), true);
  assert.deepEqual(fs.readdirSync(fx.root), [".workloop-filesystem-root.jsonl"]);

  const beta = open(fx, { id: "open-beta", session: "session-beta", writeRoot: "beta" });
  assert.equal(beta.authority_id, alpha.authority_id);
  assert.notEqual(beta.task.task_id, alpha.task.task_id);
  const alphaStatus = json(run(fx, ["current-status", "--target", path.join(fx.root, "alpha", "later.txt")], { session: "session-alpha" }));
  assert.equal(alphaStatus.task.task_id, alpha.task.task_id);
  assert.equal(alphaStatus.routable, true);
  const overlap = run(fx, [
    "current-open", "--target", path.join(fx.root, "alpha", "nested", "later.txt"), "--filesystem-root", fx.root,
    "--goal", "overlap", "--write-root", "alpha/nested", "--command-id", "overlap", ...PROVENANCE,
  ], { session: "session-overlap" });
  assert.equal(overlap.status, 2);
  assert.match(overlap.stderr, /write scope overlap/);
  const joined = json(run(fx, ["current-join", "--target", fx.root, "--task-id", beta.task.task_id, "--command-id", "join-beta", ...PROVENANCE], { session: "session-third" }));
  assert.deepEqual(joined.task.participant_session_ids, ["session-beta", "session-third"]);
  const suspended = json(run(fx, ["current-suspend", "--target", fx.root, "--task-id", alpha.task.task_id, "--command-id", "suspend-alpha", ...PROVENANCE], { session: "session-alpha" }));
  assert.equal(suspended.task.lifecycle.state, "suspended");
  const resumed = json(run(fx, ["current-resume", "--target", fx.root, "--task-id", alpha.task.task_id, "--command-id", "resume-alpha", ...PROVENANCE], { session: "session-alpha" }));
  assert.equal(resumed.task.lifecycle.state, "active");
  const audit = json(run(fx, ["current-audit", "--target", path.join(fx.root, "beta", "later.txt")], { session: "session-beta" }));
  assert.equal(audit.integrity, "valid");
  const ledger = json(run(fx, ["current-ledger", "--target", fx.root]));
  assert.equal(ledger.provider, "filesystem_detached");
  assert.ok(ledger.records.some((record) => record.kind === "task_opened"));
});

test("same-object move keeps detached identity; deletion retains shard and same-path recreation gets a new authority", (t) => {
  const fx = fixture(t, "lifecycle");
  const opened = open(fx, { id: "open-move", session: "session-move", writeRoot: "src" });
  const oldAuthority = opened.authority_id;
  const oldRecords = records(fx, oldAuthority);
  const moved = path.join(fx.base, "moved-root");
  fs.renameSync(fx.root, moved);
  const status = json(run(fx, ["current-status", "--target", path.join(moved, "src", "later.txt")], { session: "session-move" }));
  assert.equal(status.authority_id, oldAuthority);
  assert.equal(status.attachment.observed_root_path, fs.realpathSync.native(moved));
  assert.equal(status.attachment.path_status, "moved");
  fs.rmSync(moved, { recursive: true, force: true });
  assert.deepEqual(records(fx, oldAuthority), oldRecords);
  fs.mkdirSync(fx.root);
  const replacement = open(fx, { id: "open-recreated", session: "session-recreated", writeRoot: "src" });
  assert.notEqual(replacement.authority_id, oldAuthority);
  assert.equal(fs.existsSync(path.join(fx.home, "authorities", oldAuthority, "authority.jsonl")), true);
});

test("detached roots reject nested authority claims in either order", (t) => {
  const parent = fixture(t, "nested-parent");
  const child = path.join(parent.root, "child");
  fs.mkdirSync(child);
  open(parent, { id: "parent-open", session: "parent-session", writeRoot: "src" });
  const nested = run(parent, ["current-open", "--target", path.join(child, "work.txt"), "--filesystem-root", child, "--goal", "nested", "--write-root", "work", "--command-id", "nested-open", ...PROVENANCE], { session: "child-session" });
  assert.equal(nested.status, 2);
  assert.match(nested.stderr, /overlaps an existing claimed filesystem authority/);
  assert.equal(fs.existsSync(path.join(child, ".workloop-filesystem-root.jsonl")), false);

  const inverse = fixture(t, "nested-child");
  const inverseChild = path.join(inverse.root, "child");
  fs.mkdirSync(inverseChild);
  open(inverse, { root: inverseChild, id: "child-open", session: "child-session", writeRoot: "src" });
  const parentClaim = run(inverse, ["current-open", "--target", path.join(inverse.root, "work.txt"), "--filesystem-root", inverse.root, "--goal", "parent", "--write-root", "work", "--command-id", "parent-open", ...PROVENANCE], { session: "parent-session" });
  assert.equal(parentClaim.status, 2);
  assert.match(parentClaim.stderr, /contains an existing claimed filesystem authority/);
  assert.equal(fs.existsSync(path.join(inverse.root, ".workloop-filesystem-root.jsonl")), false);
});

test("deleted filesystem root remains auditable and can be abandoned only by its bounded authority selector", (t) => {
  const fx = fixture(t, "deleted-selector");
  const opened = open(fx, { id: "deleted-open", session: "deleted-session", writeRoot: "src" });
  fs.rmSync(fx.root, { recursive: true, force: true });
  const status = json(run(fx, ["current-status", "--authority", opened.authority_id, "--task-id", opened.task.task_id], { session: "deleted-session" }));
  assert.equal(status.routable, false);
  assert.equal(status.routing_reason, "root_unavailable");
  const audit = json(run(fx, ["current-audit", "--authority", opened.authority_id]));
  assert.equal(audit.integrity, "pending");
  const beforeSuspend = records(fx, opened.authority_id).length;
  const suspended = run(fx, ["current-suspend", "--authority", opened.authority_id, "--task-id", opened.task.task_id, "--command-id", "deleted-suspend", ...PROVENANCE], { session: "deleted-session" });
  assert.equal(suspended.status, 2);
  assert.match(suspended.stderr, /live bound attachment/);
  assert.equal(records(fx, opened.authority_id).length, beforeSuspend);
  const abandoned = json(run(fx, ["current-abandon", "--authority", opened.authority_id, "--task-id", opened.task.task_id, "--command-id", "deleted-abandon", ...PROVENANCE], { session: "deleted-session" }));
  assert.equal(abandoned.task.lifecycle.state, "terminal");
  const ledger = json(run(fx, ["current-ledger", "--authority", opened.authority_id]));
  assert.ok(ledger.records.some((record) => record.command_id === "deleted-abandon" && record.kind === "task_terminal"));
});

test("orphaned and staged locators reject open before creating authority records", (t) => {
  const fx = fixture(t, "orphan-preflight");
  const opened = open(fx, { id: "orphan-open", session: "orphan-session", writeRoot: "src" });
  const authorityDirectory = path.join(fx.home, "authorities", opened.authority_id);
  fs.rmSync(authorityDirectory, { recursive: true, force: true });
  const orphan = run(fx, ["current-open", "--target", path.join(fx.root, "src", "retry.txt"), "--filesystem-root", fx.root, "--goal", "orphan retry", "--write-root", "src", "--command-id", "orphan-retry", ...PROVENANCE], { session: "orphan-session" });
  assert.equal(orphan.status, 2);
  assert.match(orphan.stderr, /explicit attended recovery/);
  assert.equal(fs.existsSync(path.join(authorityDirectory, "authority.jsonl")), false);

  const stagedRoot = path.join(fx.base, "staged-root");
  fs.mkdirSync(stagedRoot);
  const staged = fs.readFileSync(path.join(fx.root, ".workloop-filesystem-root.jsonl"), "utf8").split("\n")[0] + "\n";
  fs.writeFileSync(path.join(stagedRoot, ".workloop-filesystem-root.jsonl"), staged);
  const beforeAuthorities = fs.readdirSync(path.join(fx.home, "authorities")).sort();
  const incomplete = run(fx, ["current-open", "--target", path.join(stagedRoot, "retry.txt"), "--filesystem-root", stagedRoot, "--goal", "staged retry", "--write-root", "src", "--command-id", "staged-retry", ...PROVENANCE], { session: "staged-session" });
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /incomplete locator claim/);
  assert.deepEqual(fs.readdirSync(path.join(fx.home, "authorities")).sort(), beforeAuthorities);

  const emptyRoot = path.join(fx.base, "empty-root");
  fs.mkdirSync(emptyRoot);
  fs.writeFileSync(path.join(emptyRoot, ".workloop-filesystem-root.jsonl"), "\n");
  const empty = run(fx, ["current-open", "--target", path.join(emptyRoot, "retry.txt"), "--filesystem-root", emptyRoot, "--goal", "empty retry", "--write-root", "src", "--command-id", "empty-retry", ...PROVENANCE], { session: "empty-session" });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /locator exists without a claim record/);
  assert.deepEqual(fs.readdirSync(path.join(fx.home, "authorities")).sort(), beforeAuthorities);
});

test("locator must exactly bind its ledger attachment and default Hook mode fails open", (t) => {
  const fx = fixture(t, "locator-binding");
  const opened = open(fx, { id: "binding-open", session: "binding-session", writeRoot: "src" });
  const locatorPath = path.join(fx.root, ".workloop-filesystem-root.jsonl");
  const [staged, claimed] = fs.readFileSync(locatorPath, "utf8").trim().split("\n").map(JSON.parse);
  const forged = { ...claimed, claim_token: "00000000-0000-4000-8000-000000000001" };
  delete forged.record_digest; forged.record_digest = sha256Hex(canonicalJson(forged));
  fs.writeFileSync(locatorPath, canonicalJson(staged) + "\n" + canonicalJson(forged) + "\n");
  const status = json(run(fx, ["current-status", "--target", path.join(fx.root, "src", "later.txt")], { session: "binding-session" }));
  assert.equal(status.routable, false);
  assert.equal(status.routing_reason, "locator_unavailable");
  const before = records(fx, opened.authority_id).length;
  const reopened = run(fx, ["current-open", "--target", path.join(fx.root, "src", "reopen.txt"), "--filesystem-root", fx.root, "--goal", "rejected forged locator", "--write-root", "src", "--command-id", "forged-reopen", ...PROVENANCE], { session: "binding-session" });
  assert.equal(reopened.status, 2);
  assert.match(reopened.stderr, /explicit attended recovery/);
  assert.equal(records(fx, opened.authority_id).length, before);
  const hook = run(fx, ["current-hook", "--profile", "codex-safe", "--mode", "nudge"], { cwd: fx.root, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.root, session_id: "binding-session", tool_use_id: "binding-hook", tool_name: "Write", tool_input: { file_path: path.join(fx.root, "src", "later.txt") } }) });
  assert.equal(hook.status, 0);
  assert.match(hook.stderr, /host retains execution authority/);
  assert.equal(records(fx, opened.authority_id).length, before);
});

test("reused filesystem command ids must bind scope and provenance", (t) => {
  const fx = fixture(t, "command-binding");
  open(fx, { id: "same-command", session: "same-session", writeRoot: "src" });
  const changed = run(fx, ["current-open", "--target", path.join(fx.root, "src", "future.txt"), "--filesystem-root", fx.root, "--goal", "filesystem same-command", "--write-root", "src", "--command-id", "same-command", "--reason", "changed provenance", "--granted-by", "self"], { session: "same-session" });
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /command conflicts with its durable intent/);
});

test("copied locator is never accepted as an automatic move after its original root disappears", (t) => {
  const fx = fixture(t, "copied-locator");
  open(fx, { id: "copy-open", session: "copy-session", writeRoot: "src" });
  const copied = path.join(fx.base, "copied-root");
  fs.cpSync(fx.root, copied, { recursive: true });
  fs.rmSync(fx.root, { recursive: true, force: true });
  const status = json(run(fx, ["current-status", "--target", path.join(copied, "src", "later.txt")], { session: "copy-session" }));
  assert.equal(status.routable, false);
  assert.equal(status.routing_reason, "attachment_collision");
});

test("a Git initialization inside a claimed filesystem root is an authority-kind conflict and filesystem exposes no Git operation surface", (t) => {
  const fx = fixture(t, "git-conflict");
  open(fx, { id: "open-conflict", session: "session-conflict", writeRoot: "src" });
  execFileSync("git", ["init", "-q"], { cwd: fx.root });
  const status = run(fx, ["current-status", "--target", path.join(fx.root, "src", "later.txt")], { session: "session-conflict" });
  assert.equal(status.status, 2);
  assert.match(status.stderr, /authority.*conflict|contained by Git/i);
  const help = run(fx, ["help"]);
  assert.doesNotMatch(help.stdout, /current-(?:stage|commit)/);
});

test("filesystem Hook records receipts without claiming host execution authority", (t) => {
  const fx = fixture(t, "hook");
  const opened = open(fx, { id: "open-hook", session: "session-hook", writeRoot: "src" });
  const target = path.join(fx.root, "src", "written.txt");
  const result = run(fx, ["current-hook", "--profile", "codex-safe", "--mode", "nudge"], {
    cwd: fx.root, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.root, session_id: "session-hook", permission_mode: "bypassPermissions", tool_use_id: "filesystem-hook", tool_name: "Write", tool_input: { file_path: target } }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(records(fx, opened.authority_id).filter((record) => record.kind === "operation_intent_recorded").length, 1);
});
