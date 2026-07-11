import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = path.resolve("bin/taskloop.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-test-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, repo, home };
}

function run(fx, args = [], { input = "", env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: fx.repo,
    env: { ...process.env, HOME: fx.home, USERPROFILE: fx.home, ...env },
    input,
    encoding: "utf8",
  });
}

function open(fx, extra = []) {
  return run(fx, [
    "open",
    "--repo",
    fx.repo,
    "--goal",
    "exercise the public taskloop seam",
    "--criterion",
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`,
    "--alignment",
    "green implies the fixture behavior; not covered: unrelated verbs",
    "--files",
    "src/**",
    ...extra,
  ]);
}

function openWithCriterion(fx, criterion, extra = []) {
  return run(fx, [
    "open",
    "--repo",
    fx.repo,
    "--goal",
    "exercise the public taskloop seam",
    "--criterion",
    criterion,
    "--alignment",
    "green implies the fixture behavior; not covered: unrelated verbs",
    "--files",
    "src/**",
    ...extra,
  ]);
}

function readTask(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.repo, ".taskloop", "task.json"), "utf8"));
}

function hook(fx, payload, env = {}) {
  return run(fx, [], { input: JSON.stringify(payload), env });
}

function ledgerRows(fx) {
  const file = path.join(fx.home, ".taskloop", "outcomes.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("open records unknown coverage and warns when the criterion has no file inputs", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const result = open(fx);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readTask(fx).criterion_input_coverage, "unknown");
  assert.match(result.stderr, /criterion inputs.*unknown/i);
});

test("tri-state adapters preserve indeterminate without burning failure rounds", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fx.repo, "check.mjs"),
    "import fs from 'node:fs'; const mode = fs.existsSync('mode') ? fs.readFileSync('mode', 'utf8').trim() : 'fail'; process.exit(mode === 'pass' ? 0 : mode === 'unknown' ? 2 : 1);\n",
  );
  fs.writeFileSync(path.join(fx.repo, "mode"), "unknown\n");
  const args = [
    "open", "--repo", fx.repo,
    "--goal", "exercise a producer-neutral adapter",
    "--criterion-file", "check.mjs",
    "--criterion-protocol", "tri-state",
    "--alignment", "green proves the adapter fixture; not covered: external systems",
    "--files", "src/**",
  ];
  const refused = run(fx, args);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /could not adjudicate|exit 2/i);
  assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop", "task.json")), false);

  fs.writeFileSync(path.join(fx.repo, "mode"), "fail\n");
  const opened = run(fx, args);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(readTask(fx).criterion_protocol, "tri-state");
  fs.writeFileSync(path.join(fx.repo, "mode"), "unknown\n");

  const verified = run(fx, ["verify", "--repo", fx.repo]);
  assert.equal(verified.status, 2, verified.stderr);
  assert.match(verified.stdout, /indeterminate/);
  const stopped = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "adapter-session" });
  assert.equal(stopped.status, 2, stopped.stderr);
  assert.match(stopped.stderr, /no round was burned/i);
  assert.equal(readTask(fx).spent.rounds, 0);
  assert.equal(readTask(fx).suspension, undefined);

  const doneUnknown = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(doneUnknown.status, 1);
  assert.match(doneUnknown.stderr, /did not burn a round/i);
  assert.equal(readTask(fx).spent.rounds, 0);

  fs.writeFileSync(path.join(fx.repo, "mode"), "pass\n");
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 0, done.stderr);
});

test("binary criteria keep exit 2 as an ordinary failure", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const opened = openWithCriterion(
    fx,
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(2)")}`,
  );
  assert.equal(opened.status, 0, opened.stderr);
  const stopped = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "binary-session" });
  assert.equal(stopped.status, 2, stopped.stderr);
  assert.equal(readTask(fx).spent.rounds, 1);
});

test("changing criterion protocol changes sensor identity and clears failure stall", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const opened = open(fx);
  assert.equal(opened.status, 0, opened.stderr);
  const stopped = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "protocol-session" });
  assert.equal(stopped.status, 2, stopped.stderr);
  const before = readTask(fx);
  assert.equal(before.stall.count, 1);

  const amended = run(fx, [
    "amend", "--repo", fx.repo,
    "--criterion-protocol", "tri-state",
    "--reason", "the criterion is now an adapter with an indeterminate state",
  ]);
  assert.equal(amended.status, 0, amended.stderr);
  const after = readTask(fx);
  assert.equal(after.criterion_protocol, "tri-state");
  assert.notEqual(after.criterion_hash, before.criterion_hash);
  assert.equal(after.stall.count, 0);
});

test("an encoded command stays visibly unknown instead of claiming full input coverage", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const criterion =
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")} -- -EncodedCommand Zm9v`;

  const result = openWithCriterion(fx, criterion);

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(readTask(fx).criterion_input_coverage, "full");
  assert.match(result.stderr, /criterion inputs.*unknown/i);
});

test("open records unresolved provenance for a path-shaped input it cannot inspect", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const criterion = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")} missing/check.mjs`;

  const result = openWithCriterion(fx, criterion);

  assert.equal(result.status, 0, result.stderr);
  const task = readTask(fx);
  assert.equal(task.criterion_provenance, "unresolved");
  assert.notEqual(task.criterion_input_coverage, "full");
  assert.deepEqual(task.criterion_unresolved_inputs, ["missing/check.mjs"]);
  assert.match(result.stderr, /unresolved.*missing\/check\.mjs/i);
});

test(
  "a direct repo-relative executable criterion remains fingerprinted",
  { skip: process.platform === "win32" },
  (t) => {
    const fx = fixture();
    t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
    const checker = path.join(fx.repo, "check.sh");
    fs.writeFileSync(checker, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const opened = openWithCriterion(fx, "./check.sh");

    assert.equal(opened.status, 0, opened.stderr);
    const task = readTask(fx);
    assert.equal(task.criterion_input_coverage, "full");
    assert.equal(task.criterion_provenance, "repo");
    assert.deepEqual(task.criterion_inputs.map((entry) => entry.path), ["check.sh"]);
  },
);

test("an unresolved criterion cannot close without independent review or provisional status", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const code = "process.exit(require('fs').existsSync('ready') ? 0 : 1)";
  const criterion = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} missing/check.mjs`;
  const opened = openWithCriterion(fx, criterion);
  assert.equal(opened.status, 0, opened.stderr);
  fs.writeFileSync(path.join(fx.repo, "ready"), "ready\n");

  const done = run(fx, ["done", "--repo", fx.repo]);

  assert.equal(done.status, 1);
  assert.match(done.stderr, /unresolved.*fresh-context|weak.*fresh-context/i);
  assert.equal(readTask(fx).state, "open");
});

test("a provisional weak close persists and reports its downgrade", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const stateDir = path.join(fx.repo, ".taskloop");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "weak.mjs"),
    "import fs from 'node:fs'; process.exit(fs.existsSync('ready') ? 0 : 1);\n",
  );
  const opened = run(fx, [
    "open", "--repo", fx.repo,
    "--goal", "exercise provisional close",
    "--criterion-file", ".taskloop/weak.mjs",
    "--alignment", "green proves the weak fixture; not covered: independent correctness",
    "--files", "src/**",
  ]);
  assert.equal(opened.status, 0, opened.stderr);
  fs.writeFileSync(path.join(fx.repo, "ready"), "ready\n");

  const done = run(fx, ["done", "--repo", fx.repo, "--provisional"]);

  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /provisional/);
  assert.equal(readTask(fx).state, "done");
  assert.equal(readTask(fx).provisional, true);
});

test("amend recomputes unknown criterion coverage and warns", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fx.repo, "check.mjs"), "process.exit(1);\n");
  const opened = openWithCriterion(fx, `${JSON.stringify(process.execPath)} check.mjs`);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(readTask(fx).criterion_input_coverage, "full");

  const amended = run(fx, [
    "amend",
    "--repo",
    fx.repo,
    "--criterion",
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`,
    "--reason",
    "switch to a deliberately input-free fixture",
  ]);

  assert.equal(amended.status, 0, amended.stderr);
  assert.equal(readTask(fx).criterion_input_coverage, "unknown");
  assert.match(amended.stderr, /criterion inputs.*unknown/i);
});

test("machine suspension is sticky until resume while reads remain free", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const opened = open(fx);
  assert.equal(opened.status, 0, opened.stderr);

  let stopped;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    stopped = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "session-a" });
    assert.equal(stopped.status, attempt < 3 ? 2 : 0, stopped.stderr);
  }
  const suspended = readTask(fx);
  assert.equal(suspended.state, "open");
  assert.equal(suspended.suspension.outcome, "stuck");
  assert.equal(ledgerRows(fx).at(-1).state, "suspended");

  const deniedWrite = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "session-a",
    tool_name: "Write",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });
  assert.match(deniedWrite.stdout, /"permissionDecision":"deny"/);
  assert.match(deniedWrite.stderr, /resume .*--reason/i);

  const allowedRead = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "session-a",
    tool_name: "Read",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });
  assert.equal(allowedRead.status, 0, allowedRead.stderr);
  assert.doesNotMatch(allowedRead.stdout, /permissionDecision/);

  const resumed = run(fx, ["resume", "--repo", fx.repo, "--reason", "new evidence is available"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readTask(fx).suspension, undefined);
  assert.equal(ledgerRows(fx).at(-1).state, "resumed");
  const audit = run(fx, ["audit"]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /state:\s+open 1/i);

  const allowedWrite = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "session-a",
    tool_name: "Write",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });
  assert.equal(allowedWrite.status, 0, allowedWrite.stderr);
  assert.doesNotMatch(allowedWrite.stdout, /permissionDecision/);
});

test("spent round budget denies writes but never reads", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const opened = open(fx, ["--rounds", "1"]);
  assert.equal(opened.status, 0, opened.stderr);
  const refusedDone = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(refusedDone.status, 1);
  assert.equal(readTask(fx).spent.rounds, 1);
  assert.equal(readTask(fx).suspension, undefined);

  const deniedWrite = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "session-budget",
    tool_name: "Write",
    tool_input: { file_path: path.join(fx.repo, "src", "budget.txt") },
  });
  assert.match(deniedWrite.stdout, /"permissionDecision":"deny"/);
  assert.match(deniedWrite.stderr, /round budget.*1\/1/i);

  const allowedRead = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "session-budget",
    tool_name: "Read",
    tool_input: { file_path: path.join(fx.repo, "src", "budget.txt") },
  });
  assert.equal(allowedRead.status, 0, allowedRead.stderr);
  assert.doesNotMatch(allowedRead.stdout, /permissionDecision/);
});

test("redirect parsing ignores shell data but still denies a real outside redirect", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const opened = open(fx);
  assert.equal(opened.status, 0, opened.stderr);

  for (const command of [
    "node -e \"process.exit(0)\" 2>&1",
    "node -e \"process.exit(0)\" >/dev/null",
    "grep needle <<< \"body > phantom.txt\" src/a.txt",
  ]) {
    const result = hook(fx, {
      hook_event_name: "PreToolUse",
      cwd: fx.repo,
      session_id: "redirect-session",
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  }
  assert.equal(readTask(fx).evidence.writes, 0);

  const patch = [
    "apply_patch <<'PATCH'",
    "*** Begin Patch",
    "*** Update File: src/a.txt",
    "@@",
    "+documentation says value > phantom.txt",
    "*** End Patch",
    "PATCH",
  ].join("\n");
  const allowedPatch = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "redirect-session",
    tool_name: "Bash",
    tool_input: { command: patch },
  });
  assert.equal(allowedPatch.status, 0, allowedPatch.stderr);
  assert.doesNotMatch(allowedPatch.stdout, /permissionDecision/);
  assert.deepEqual(readTask(fx).evidence.touched_files, ["src/a.txt"]);

  const denied = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "redirect-session",
    tool_name: "Bash",
    tool_input: { command: "printf hi > outside.txt" },
  });
  assert.match(denied.stdout, /"permissionDecision":"deny"/);
  assert.match(denied.stderr, /outside the envelope: outside\.txt/i);

  const deniedBothStreams = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "redirect-session",
    tool_name: "Bash",
    tool_input: { command: "printf hi >& outside-both.log" },
  });
  assert.match(deniedBothStreams.stdout, /"permissionDecision":"deny"/);
  assert.match(deniedBothStreams.stderr, /outside the envelope: outside-both\.log/i);
  assert.doesNotMatch(JSON.stringify(readTask(fx).evidence.touched_files), /phantom/);
});

test("a torn task file fails open with a loud state-unreadable warning", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const stateDir = path.join(fx.repo, ".taskloop");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "task.json"), "{\"state\":");

  const result = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "torn-state",
    tool_name: "Read",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /state-unreadable.*task\.json/i);
  assert.equal(fs.readFileSync(path.join(stateDir, "task.json"), "utf8"), "{\"state\":");
});

test("amend goal records the pivot and resume banner repeats the current goal", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);
  hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "goal-session-a",
    tool_name: "Read",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });
  const suspended = run(fx, [
    "suspend",
    "--repo",
    fx.repo,
    "--outcome",
    "needs_input",
    "--judgment",
    "old criterion remains; direction changed; amend the goal",
  ]);
  assert.equal(suspended.status, 0, suspended.stderr);
  assert.match(suspended.stdout, /direction changed.*amend --goal.*--criterion/i);

  const amended = run(fx, [
    "amend",
    "--repo",
    fx.repo,
    "--goal",
    "the redirected goal",
    "--reason",
    "the user changed direction",
  ]);
  assert.equal(amended.status, 0, amended.stderr);
  const task = readTask(fx);
  assert.equal(task.goal, "the redirected goal");
  assert.deepEqual(task.amendments.at(-1).goal, {
    from: "exercise the public taskloop seam",
    to: "the redirected goal",
  });

  assert.equal(run(fx, ["resume", "--repo", fx.repo, "--reason", "goal is aligned"]).status, 0);
  const nextEpisode = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "goal-session-b",
    tool_name: "Read",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });
  assert.match(nextEpisode.stderr, /current goal: the redirected goal/i);

  const help = run(fx, ["help"]);
  assert.match(help.stdout, /amend.*--goal/s);
});

test("token cursors count each transcript tail once across alternating sessions", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);
  const transcriptA = path.join(fx.root, "session-a.jsonl");
  const transcriptB = path.join(fx.root, "session-b.jsonl");
  fs.writeFileSync(transcriptA, '{"output_tokens":10}\n{"output_tokens":5}\n');
  fs.writeFileSync(transcriptB, '{"output_tokens":7}\n');

  const readPayload = (session_id, transcript_path) => ({
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id,
    transcript_path,
    tool_name: "Read",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });
  // Cross-session token counting happens on legitimate handoff, not fresh
  // concurrent contention: with P0 a fresh foreign session is a bystander that
  // never takes over. A tiny lease TTL makes each session switch a stale-lease
  // handoff, so the alternation exercises the take-over path the cursor dedup
  // is meant to cover.
  const H = (payload) => hook(fx, payload, { TASKLOOP_LEASE_TTL_MS: "1" });
  H(readPayload("session-a", transcriptA));
  H(readPayload("session-b", transcriptB));
  fs.appendFileSync(transcriptA, '{"output_tokens":3}\n');
  H(readPayload("session-a", transcriptA));

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const stopped = H({
      hook_event_name: "Stop",
      cwd: fx.repo,
      session_id: "session-a",
      transcript_path: transcriptA,
    });
    assert.equal(stopped.status, attempt < 3 ? 2 : 0, stopped.stderr);
  }

  const repeatedSuspension = H({
    hook_event_name: "Stop",
    cwd: fx.repo,
    session_id: "session-a",
    transcript_path: transcriptA,
  });
  assert.equal(repeatedSuspension.status, 0, repeatedSuspension.stderr);

  const task = readTask(fx);
  assert.equal(task.episodes.length, 3);
  assert.equal(task.episodes.at(-1).closed_at, undefined);
  assert.equal(task.suspension.outcome, "stuck");
  assert.equal(
    task.episodes.reduce((sum, episode) => sum + (episode.output_tokens ?? 0), 0),
    25,
  );
  assert.equal(task.transcript_cursors[fs.realpathSync.native(transcriptA)].offset, fs.statSync(transcriptA).size);
  assert.equal(task.transcript_cursors[fs.realpathSync.native(transcriptB)].offset, fs.statSync(transcriptB).size);
  // A stop on an already-suspended task now releases without re-suspending, so
  // the suspend is recorded exactly once — no duplicate suspended rows.
  assert.equal(ledgerRows(fx).filter((row) => row.state === "suspended").length, 1);
});

// --- P0: cross-session Stop/PreToolUse attribution ---

const readBy = (fx, session_id) => ({
  hook_event_name: "PreToolUse",
  cwd: fx.repo,
  session_id,
  tool_name: "Read",
  tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
});

test("a fresh foreign session's Stop releases without adjudicating or detaching the owner", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);
  assert.equal(hook(fx, readBy(fx, "owner")).status, 0); // owner claims the episode + a fresh lease
  assert.equal(readTask(fx).episodes.length, 1);

  const bystander = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "intruder" });
  assert.equal(bystander.status, 0, bystander.stderr); // released, not block(2)
  assert.match(bystander.stderr, /bystander|single-writer|separate .*worktree/i);
  assert.doesNotMatch(bystander.stderr, /criterion red|task done|green held/i);
  const after = readTask(fx);
  assert.equal(after.episodes.length, 1); // no take-over episode
  assert.equal(after.episodes.at(-1).session, "owner");
  assert.equal(after.episodes.at(-1).closed_at, undefined); // owner not detached
});

test("a fresh foreign session's write is not gated by the owner's envelope", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0); // envelope is src/**
  assert.equal(hook(fx, readBy(fx, "owner")).status, 0);
  const foreign = hook(fx, {
    hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "intruder",
    tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "docs", "x.md") },
  });
  const out = (foreign.stdout ?? "") + (foreign.stderr ?? "");
  assert.doesNotMatch(out, /write outside the envelope/i); // owner envelope does not govern a foreign session
  assert.match(out, /bystander|single-writer|separate .*worktree/i);
  assert.equal(readTask(fx).episodes.length, 1); // owner intact
});

test("a stale owner lease lets a foreign session take over (handoff escape)", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);
  assert.equal(hook(fx, readBy(fx, "owner")).status, 0);
  // A 1ms TTL makes the owner's lease already stale, so the newcomer is a
  // handoff (take-over), not a bystander.
  assert.equal(hook(fx, readBy(fx, "successor"), { TASKLOOP_LEASE_TTL_MS: "1" }).status, 0);
  const t2 = readTask(fx);
  assert.ok(t2.episodes.some((e) => e.session === "owner" && e.outcome === "detached"));
  assert.equal(t2.episodes.at(-1).session, "successor");
});

test("a suspended task is not adjudicated, closed, or episode-mutated by any hook", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  // A repo-owned criterion-file (clean provenance, no weak-close gate) that is
  // red until `flag` exists, so a green close is possible if the gate misfires.
  fs.writeFileSync(path.join(fx.repo, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.existsSync('flag') ? 0 : 1);\n");
  assert.equal(
    run(fx, [
      "open", "--repo", fx.repo, "--goal", "guarded", "--criterion-file", "check.mjs",
      "--alignment", "green => flag exists; not covered: nothing", "--files", "src/**",
    ]).status,
    0,
  );
  assert.equal(hook(fx, readBy(fx, "owner")).status, 0); // owner claims the episode
  fs.writeFileSync(path.join(fx.repo, "flag"), "1"); // criterion is now green
  assert.equal(run(fx, ["suspend", "--repo", fx.repo, "--outcome", "needs_input", "--judgment", "a; b; c"]).status, 0);
  const snapshot = JSON.stringify(readTask(fx).episodes);

  const stillPaused = () => {
    const tk = readTask(fx);
    assert.equal(tk.state, "open"); // not closed to done
    assert.ok(tk.suspension && tk.suspension.outcome === "needs_input"); // still suspended
    assert.equal(JSON.stringify(tk.episodes), snapshot); // episode list unchanged (no create/detach/transfer)
  };

  for (const session of ["intruder", "owner"]) {
    // Stop: released, never adjudicates or mutates the episode list.
    const stop = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: session });
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stderr, /suspended/i);
    stillPaused();
    // Read: free, no episode mutation.
    const read = hook(fx, { hook_event_name: "PreToolUse", cwd: fx.repo, session_id: session, tool_name: "Read", tool_input: { file_path: path.join(fx.repo, "src", "a.txt") } });
    assert.equal(read.status, 0, read.stderr);
    stillPaused();
    // Write: denied with the resume message, no episode mutation.
    const write = hook(fx, { hook_event_name: "PreToolUse", cwd: fx.repo, session_id: session, tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "src", "b.txt") } });
    const wout = (write.stdout ?? "") + (write.stderr ?? "");
    assert.match(wout, /suspended/i);
    assert.match(wout, /resume/i);
    stillPaused();
  }
});

test("the first hook on a fresh task claims ownership (first-touch); a documented open race", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0); // no episodes yet
  // `open` records no session identity, so whichever session hooks first owns
  // the task — including a foreign Stop. This is an accepted limitation of the
  // fail-open model, asserted here so a change to it is a conscious one.
  const first = hook(fx, { hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "first", tool_name: "Read", tool_input: { file_path: path.join(fx.repo, "src", "a.txt") } });
  assert.equal(first.status, 0, first.stderr);
  const t1 = readTask(fx);
  assert.equal(t1.episodes.length, 1);
  assert.equal(t1.episodes[0].session, "first");
  // A now-foreign second session is a bystander (owner's lease is fresh).
  const second = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "second" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /bystander|single-writer/i);
  assert.equal(readTask(fx).episodes.length, 1); // not taken over
});

test("open and amend reject semicolon-joined envelope patterns", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const rejectedOpen = open(fx, ["--files", "src/**;tests/**"]);
  assert.equal(rejectedOpen.status, 2);
  assert.match(rejectedOpen.stderr, /semicolon.*repeat --files/i);

  assert.equal(open(fx).status, 0);
  const rejectedAmend = run(fx, [
    "amend",
    "--repo",
    fx.repo,
    "--files",
    "app/**;docs/**",
    "--reason",
    "expand the envelope",
  ]);
  assert.equal(rejectedAmend.status, 2);
  assert.match(rejectedAmend.stderr, /semicolon.*repeat --files/i);
});

test("zero-match envelope patterns warn and every expansion records provenance", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const opened = open(fx);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /envelope pattern "src\/\*\*" matches no current files/i);

  const amended = run(fx, [
    "amend",
    "--repo",
    fx.repo,
    "--files",
    "app/**",
    "--reason",
    "the approved implementation moved into app",
    "--granted-by",
    "user",
  ]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.match(amended.stderr, /envelope pattern "app\/\*\*" matches no current files/i);
  const grant = readTask(fx).grants.at(-1);
  assert.equal(grant.scope, "envelope");
  assert.equal(grant.pattern, "app/**");
  assert.equal(grant.reason, "the approved implementation moved into app");
  assert.equal(grant.granted_by, "user");

  const star = run(fx, [
    "amend",
    "--repo",
    fx.repo,
    "--files",
    "*",
    "--reason",
    "allow one root-level file",
  ]);
  assert.equal(star.status, 0, star.stderr);
  assert.doesNotMatch(star.stderr, /whole-repo envelope "\*"/i);
});

test("failed force-open attempts do not archive the current task repeatedly", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);
  const originalId = readTask(fx).id;
  const impossible = path.join(fx.root, "missing-taskloop-command");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = openWithCriterion(fx, impossible, ["--force"]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /cannot execute/i);
    assert.equal(readTask(fx).id, originalId);
  }
  const history = path.join(fx.repo, ".taskloop", "history");
  assert.equal(fs.existsSync(history) ? fs.readdirSync(history).length : 0, 0);

  const replaced = open(fx, ["--force"]);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.notEqual(readTask(fx).id, originalId);
  assert.equal(fs.readdirSync(history).length, 1);
});

test("force-open refuses replacement when current-task history cannot be archived", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);
  const originalId = readTask(fx).id;
  const history = path.join(fx.repo, ".taskloop", "history");
  fs.writeFileSync(history, "not a directory\n");

  const replaced = open(fx, ["--force"]);

  assert.equal(replaced.status, 1);
  assert.match(replaced.stderr, /cannot archive the current task.*existing task remains current/i);
  assert.equal(readTask(fx).id, originalId);
});

test("criterion-file executes directly and fingerprints the repo-relative script", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fx.repo, "checks"), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, "checks", "red check.mjs"), "process.exit(1);\n");

  const opened = run(fx, [
    "open",
    "--repo",
    fx.repo,
    "--goal",
    "exercise criterion-file",
    "--criterion-file",
    "checks/red check.mjs",
    "--alignment",
    "green implies the direct script passes; not covered: other runtimes",
    "--files",
    "src/**",
  ]);
  assert.equal(opened.status, 0, opened.stderr);
  let task = readTask(fx);
  assert.equal(task.criterion, "criterion-file:checks/red check.mjs");
  assert.equal(task.criterion_file, "checks/red check.mjs");
  assert.equal(task.criterion_input_coverage, "full");
  assert.equal(task.criterion_provenance, "repo");
  assert.deepEqual(task.criterion_inputs.map((entry) => entry.path), ["checks/red check.mjs"]);
  assert.equal(ledgerRows(fx).at(-1).criterion, "criterion-file:checks/red check.mjs");

  fs.writeFileSync(path.join(fx.repo, ".taskloop", "weak.mjs"), "process.exit(1);\n");
  const amended = run(fx, [
    "amend",
    "--repo",
    fx.repo,
    "--criterion-file",
    ".taskloop/weak.mjs",
    "--reason",
    "the external criterion is temporarily unavailable",
  ]);
  assert.equal(amended.status, 0, amended.stderr);
  task = readTask(fx);
  assert.equal(task.criterion_file, ".taskloop/weak.mjs");
  assert.equal(task.criterion_provenance, "state-dir");
  assert.deepEqual(task.criterion_inputs.map((entry) => entry.path), [".taskloop/weak.mjs"]);

  assert.match(run(fx, ["help"]).stdout, /--criterion-file/);
});

test("repeated state replacements stay valid and leave no temporary task files", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);

  for (let index = 0; index < 12; index += 1) {
    const result = hook(fx, {
      hook_event_name: "PreToolUse",
      cwd: fx.repo,
      session_id: "atomic-session",
      tool_name: "Read",
      tool_input: { file_path: path.join(fx.repo, "src", `${index}.txt`) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => readTask(fx));
  }
  const leftovers = fs.readdirSync(path.join(fx.repo, ".taskloop")).filter((name) => /^\.task\.json\..*\.tmp$/.test(name));
  assert.deepEqual(leftovers, []);
});

test(
  "Windows atomic rename replaces an existing task.json repeatedly",
  { skip: process.platform !== "win32" },
  (t) => {
    const fx = fixture();
    t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
    assert.equal(open(fx).status, 0);

    for (let index = 0; index < 4; index += 1) {
      const result = hook(fx, {
        hook_event_name: "PreToolUse",
        cwd: fx.repo,
        session_id: "windows-atomic-session",
        tool_name: "Read",
        tool_input: { file_path: path.join(fx.repo, "src", `${index}.txt`) },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotThrow(() => readTask(fx));
    }
  },
);

test("writes under the system temp directory do not enter untracked file accounting", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const tempTarget = path.join(os.tmpdir(), `taskloop-outside-${process.pid}.txt`);
  const result = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "temp-write",
    tool_name: "Bash",
    tool_input: { command: `printf hi > ${JSON.stringify(tempTarget)}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /permissionDecision/);
  const scratchPath = path.join(fx.repo, ".taskloop", "untracked-writes.json");
  if (fs.existsSync(scratchPath)) {
    const scratch = JSON.parse(fs.readFileSync(scratchPath, "utf8"));
    assert.deepEqual(scratch.sessions["temp-write"].files, []);
  }
});

test("untracked write accounting recognizes quoted redirect targets inside the repo", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const invoke = (target) =>
    hook(fx, {
      hook_event_name: "PreToolUse",
      cwd: fx.repo,
      session_id: "quoted-redirect",
      tool_name: "Bash",
      tool_input: { command: `printf hi > ${JSON.stringify(target)}` },
    });

  const first = invoke("src/a file.txt");
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /permissionDecision/);
  const second = invoke("src/b file.txt");
  assert.match(second.stdout, /"permissionDecision":"deny"/);
  assert.match(second.stderr, /src\/a file\.txt.*src\/b file\.txt/i);
});

test(
  "Windows criterion paths normalize native, MSYS, and slash-drive forms and remain weak",
  { skip: process.platform !== "win32" },
  (t) => {
    for (const form of ["native", "msys", "slash-drive"]) {
      const fx = fixture();
      t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
      const stateDir = path.join(fx.repo, ".taskloop");
      fs.mkdirSync(stateDir, { recursive: true });
      const checker = path.join(stateDir, `${form}.mjs`);
      fs.writeFileSync(checker, "process.exit(require('fs').existsSync('ready') ? 0 : 1);\n");
      const slash = checker.replace(/\\/g, "/");
      const drive = slash[0];
      const variant =
        form === "native" ? checker : form === "msys" ? `/${drive.toLowerCase()}/${slash.slice(3)}` : `/${slash}`;

      const opened = openWithCriterion(
        fx,
        `${JSON.stringify(process.execPath)} ${JSON.stringify(variant)}`,
      );
      assert.equal(opened.status, 0, opened.stderr);
      assert.equal(readTask(fx).criterion_provenance, "state-dir");
      fs.writeFileSync(path.join(fx.repo, "ready"), "ready\n");
      const done = run(fx, ["done", "--repo", fx.repo]);
      assert.equal(done.status, 1);
      assert.match(done.stderr, /state-dir.*fresh-context|weak.*fresh-context/i);
      assert.equal(readTask(fx).state, "open");
    }
  },
);
