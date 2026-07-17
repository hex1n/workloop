import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(".");
const CLI = path.join(ROOT, "bin", "taskloop.mjs");
function run(args, { cwd = ROOT, env = process.env, input = "" } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: "utf8" });
}

test("roadmap E2E: dedicated criterion, host anchors, actual-use floor, and ledger converge", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-roadmap-e2e-"));
  const repo = path.join(root, "repo"); const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "check.mjs"), "import fs from 'node:fs'; if (fs.existsSync('done')) { console.log('TASKLOOP_CRITERION: roadmap behavior complete'); process.exit(4); } console.log('TASKLOOP_CRITERION: done marker missing'); process.exit(3);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], { cwd: repo });
  const env = { ...process.env, TZ: "UTC", HOME: home, USERPROFILE: home, TASKLOOP_SESSION_ID: "", TASKLOOP_ACTING_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" };

  const opened = run(["open", "--repo", repo, "--goal", "roadmap e2e", "--criterion-file", "check.mjs", "--criterion-protocol", "tri-state", "--criterion-policy", "default", "--alignment-because", "live roadmap chain", "--files", "work.txt", "--risk", "routine", "--risk-reason", "fixture"], { env });
  assert.equal(opened.status, 0, opened.stderr); assert.match(opened.stdout, /criterion unsatisfied/);

  const write = run(["hook", "--profile", "claude", "--mode", "nudge"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, session_id: "owner", agent_id: "child", permission_mode: "bypassPermissions", tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt") } }) });
  assert.equal(write.status, 0, write.stderr); assert.equal(write.stdout, "");
  fs.writeFileSync(path.join(repo, "done"), "yes\n");

  const stopped = run(["hook", "--profile", "claude", "--mode", "nudge"], { cwd: repo, env, input: JSON.stringify({ hook_event_name: "Stop", cwd: repo, session_id: "owner", agent_id: "child", permission_mode: "bypassPermissions" }) });
  assert.equal(stopped.status, 0, stopped.stderr); assert.match(stopped.stderr, /terminal\(achieved\)/);

  const ledger = run(["ledger", "--json", "--repo", repo], { env });
  assert.equal(ledger.status, 0, ledger.stderr); const payload = JSON.parse(ledger.stdout);
  assert.equal(payload.metrics.terminal_outcomes.achieved, 1);
  assert.equal(payload.metrics.writes, 1);
  assert.equal(payload.authority_use.host_key_bypass_seen, true);
  assert.equal(payload.integrity.record_count, 2);
  assert.equal(payload.integrity.coverage, "covered");
  const evidence = fs.readFileSync(path.join(repo, ".taskloop", "untracked-observations-v1.jsonl"), "utf8");
  assert.match(evidence, /"acting_session":"child"/); assert.match(evidence, /"permission_mode_raw":"bypassPermissions"/);
});
