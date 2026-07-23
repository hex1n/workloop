import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "workloop.mjs");
function fixture(t) { const base = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-ticket08-")); const root = path.join(base, "root"); const home = path.join(base, "home"); fs.mkdirSync(root); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return { base, root, home }; }
function run(fx, args, session = "ticket08") { return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", timeout: 20_000, env: { ...process.env, WORKLOOP_AUTHORITY_HOME: fx.home, WORKLOOP_SESSION_ID: session, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" } }); }
function json(result) { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); }
function open(fx) { return json(run(fx, ["current-open", "--target", path.join(fx.root, "src", "future.txt"), "--filesystem-root", fx.root, "--goal", "ticket08 fixture", "--write-root", "src", "--command-id", "ticket08-open", "--reason", "fixture", "--granted-by", "self"])); }

test("filesystem copied identity enters collision, explicit reattach advances epoch, and command replay is idempotent", (t) => {
  const fx = fixture(t); const opened = open(fx); const oldLocator = JSON.parse(fs.readFileSync(opened.storage.locator_path, "utf8").trim().split("\n").at(-1));
  const copied = path.join(fx.base, "copy"); fs.cpSync(fx.root, copied, { recursive: true });
  const collision = json(run(fx, ["current-status", "--target", path.join(copied, "src", "next.txt")], "ticket08-copy"));
  assert.equal(collision.routable, false); assert.equal(collision.routing_reason, "attachment_collision");
  const args = ["current-reattach", "--target", path.join(copied, "src", "next.txt"), "--attachment", opened.attachment_id, "--command-id", "ticket08-reattach", "--expect-epoch", "1", "--expect-locator-digest", oldLocator.record_digest, "--reason", "select copied root", "--granted-by", "user"];
  const attached = json(run(fx, args, "ticket08-copy"));
  assert.equal(attached.recovery.claim_epoch, 2); assert.equal(attached.routable, true, JSON.stringify(attached, null, 2));
  const replay = json(run(fx, args, "ticket08-copy")); assert.equal(replay.recovery.replayed, true);
  const current = JSON.parse(fs.readFileSync(path.join(copied, ".workloop-filesystem-root.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(current.claim_epoch, 2); assert.notEqual(current.record_digest, oldLocator.record_digest);
  const original = json(run(fx, ["current-status", "--target", path.join(fx.root, "src", "next.txt")], "ticket08-original"));
  assert.equal(original.routable, false);
});

test("filesystem identity fork creates a fresh detached authority without copying source tasks", (t) => {
  const fx = fixture(t); const opened = open(fx); const old = JSON.parse(fs.readFileSync(opened.storage.locator_path, "utf8").trim().split("\n").at(-1)); const copied = path.join(fx.base, "fork-copy"); fs.cpSync(fx.root, copied, { recursive: true });
  const collision = json(run(fx, ["current-status", "--target", path.join(copied, "src", "next.txt")], "ticket08-fork")); assert.equal(collision.routing_reason, "attachment_collision");
  const args = ["current-fork-identity", "--target", path.join(copied, "src", "next.txt"), "--attachment", opened.attachment_id, "--command-id", "ticket08-fork", "--expect-epoch", "1", "--expect-locator-digest", old.record_digest, "--reason", "select copied identity as a new authority", "--granted-by", "user"];
  const forked = json(run(fx, args, "ticket08-fork")); assert.notEqual(forked.authority_id, opened.authority_id); assert.notEqual(forked.attachment_id, opened.attachment_id); assert.equal(forked.filesystem_tasks.length, 0); assert.equal(forked.routable, false);
  const replay = json(run(fx, args, "ticket08-fork")); assert.equal(replay.recovery.command_id, "ticket08-fork"); assert.equal(replay.recovery.forked_authority_id, forked.authority_id);
  const conflictingArgs = [...args]; conflictingArgs[conflictingArgs.indexOf("--reason") + 1] = "different attended decision"; const conflict = run(fx, conflictingArgs, "ticket08-fork"); assert.equal(conflict.status, 2); assert.match(conflict.stderr, /fork replay input differs/);
  const source = json(run(fx, ["current-status", "--target", path.join(fx.root, "src", "next.txt")], "ticket08-source")); assert.equal(source.routable, false);
});
