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

test("a green close surfaces the alignment's not-covered clause at both doors", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const criterion = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "const fs=require('fs');process.exit(fs.existsSync('ready')?0:1)",
  )}`;
  assert.equal(
    run(fx, [
      "open", "--repo", fx.repo, "--goal", "make ready",
      "--criterion", criterion,
      "--alignment", "green => ready exists; not covered: whether ready means the goal is truly met",
      "--files", "src/**",
    ]).status,
    0,
  );
  fs.writeFileSync(path.join(fx.repo, "ready"), "ok\n");

  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /criterion green — a machine check passed, not the goal/i);
  assert.match(done.stderr, /not covered by the criterion: whether ready means the goal is truly met/i);
  assert.match(done.stderr, /criterion input coverage: unknown/i); // no fingerprinted inputs here
});

test("the Stop gate surfaces the not-covered clause when it closes a task", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const criterion = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "const fs=require('fs');process.exit(fs.existsSync('ready')?0:1)",
  )}`;
  assert.equal(
    run(fx, [
      "open", "--repo", fx.repo, "--goal", "make ready",
      "--criterion", criterion,
      "--alignment", "green => ready exists; not covered: the deployment environment",
      "--files", "src/**",
    ]).status,
    0,
  );
  fs.writeFileSync(path.join(fx.repo, "ready"), "ok\n");
  const stop = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "close" });
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stderr, /not covered by the criterion: the deployment environment/i);
});

test("close reconciliation flags a declared write-area that saw no machine-witnessed write", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const criterion = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "const fs=require('fs');process.exit(fs.existsSync('ready')?0:1)",
  )}`;
  assert.equal(
    run(fx, [
      "open", "--repo", fx.repo, "--goal", "touch only src",
      "--criterion", criterion,
      "--alignment", "green => ready exists; not covered: the rest",
      "--files", "src/**", "--files", "docs/**",
    ]).status,
    0,
  );
  // The machine witnesses a write under src/** but never under docs/**.
  fs.mkdirSync(path.join(fx.repo, "src"), { recursive: true });
  const pre = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "recon",
    tool_name: "Write",
    tool_input: { file_path: path.join(fx.repo, "src", "a.txt") },
  });
  assert.equal(pre.status, 0, pre.stderr);
  fs.writeFileSync(path.join(fx.repo, "ready"), "ok\n");

  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /envelope reconciliation \(advisory telemetry, not a gate/i);
  // docs/** was declared but never machine-witnessed as written; src/** was.
  assert.match(done.stderr, /declared but not machine-witnessed as written: docs\/\*\*/i);
  assert.doesNotMatch(done.stderr, /declared but not machine-witnessed as written:[^\n]*src\/\*\*/i);
});

test("close reconciliation suppresses the attribution dimension when input coverage is unknown", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  // An opaque criterion (no fingerprinted inputs) has unknown coverage — every
  // declared area would read as "not attributed", so that dimension is silenced.
  assert.equal(
    run(fx, [
      "open", "--repo", fx.repo, "--goal", "opaque check",
      "--criterion", `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(require('fs').existsSync('ready')?0:1)")}`,
      "--alignment", "green => ready exists; not covered: the rest",
      "--files", "src/**",
    ]).status,
    0,
  );
  fs.writeFileSync(path.join(fx.repo, "ready"), "ok\n");
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stderr, /not attributed to any criterion input/i);
});

// --- --criterion-subject: an explicit, auditable drift exemption ---

// A criterion that fingerprints a repo file it also treats as the work subject:
// the token `data.md` is path-shaped and repo-local, so it enters the input
// fingerprint; editing it would normally read as a moved sensor.
function openSubjectFixture(fx, extra = []) {
  fs.writeFileSync(path.join(fx.repo, "data.md"), "draft\n");
  const code = "const fs=require('fs');process.exit(fs.readFileSync('data.md','utf8').includes('MARK')?0:1)";
  return run(fx, [
    "open", "--repo", fx.repo, "--goal", "write the marker into data.md",
    "--criterion", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} data.md`,
    "--alignment", "green => data.md carries MARK; not covered: whether MARK means the goal is met",
    "--files", "**",
    ...extra,
  ]);
}

test("a declared work subject changes without tripping the drift refusal", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(openSubjectFixture(fx, ["--criterion-subject", "data.md"]).status, 0);
  const task = readTask(fx);
  assert.deepEqual(task.criterion_subject, ["data.md"]);
  assert.ok(task.grants.some((g) => g.scope === "criterion-subject" && g.path === "data.md"));

  fs.writeFileSync(path.join(fx.repo, "data.md"), "draft\nMARK\n"); // edited directly: no machine-witnessed write
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /declared work subject changed \(drift exemption exercised/i);
  assert.match(done.stderr, /data\.md — not machine-witnessed/i);

  const closed = ledgerRows(fx).filter((r) => r.state === "done").at(-1);
  assert.equal(closed.criterion_subject, 1);
  assert.equal(closed.criterion_subject_changed, true);
});

test("a subject change written through the write gate is annotated as machine-witnessed", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(openSubjectFixture(fx, ["--criterion-subject", "data.md"]).status, 0);
  const pre = hook(fx, {
    hook_event_name: "PreToolUse", cwd: fx.repo, session_id: "subj",
    tool_name: "Write", tool_input: { file_path: path.join(fx.repo, "data.md") },
  });
  assert.equal(pre.status, 0, pre.stderr);
  fs.writeFileSync(path.join(fx.repo, "data.md"), "draft\nMARK\n");
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /data\.md — machine-witnessed write/i);
});

test("without the declaration the same subject edit still refuses as drift", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(openSubjectFixture(fx).status, 0);
  fs.writeFileSync(path.join(fx.repo, "data.md"), "draft\nMARK\n");
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /changed since they were fingerprinted: data\.md/i);
  assert.equal(readTask(fx).state, "open");
});

test("a mixed change still refuses, naming only the un-exempt sensor", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fx.repo, "data.md"), "draft\n");
  fs.writeFileSync(path.join(fx.repo, "sensor.md"), "baseline\n");
  const code = "const fs=require('fs');process.exit(fs.readFileSync('data.md','utf8').includes('MARK')?0:1)";
  assert.equal(
    run(fx, [
      "open", "--repo", fx.repo, "--goal", "write MARK into data.md",
      "--criterion", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} data.md sensor.md`,
      "--alignment", "green => data.md carries MARK; not covered: nothing",
      "--files", "**", "--criterion-subject", "data.md",
    ]).status,
    0,
  );
  fs.writeFileSync(path.join(fx.repo, "data.md"), "draft\nMARK\n"); // subject: exempt
  fs.writeFileSync(path.join(fx.repo, "sensor.md"), "tampered\n"); // real sensor: drift
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /changed since they were fingerprinted: sensor\.md/i);
  assert.doesNotMatch(done.stderr, /fingerprinted:[^\n]*data\.md/i);
  assert.match(done.stderr, /a declared work subject also changed and is exempt: data\.md/i);
});

test("open refuses ill-formed criterion-subject declarations", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  // glob
  assert.match(openSubjectFixture(fx, ["--criterion-subject", "*.md"]).stderr, /not a glob/i);
  assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop", "task.json")), false);
  // state dir
  assert.match(openSubjectFixture(fx, ["--criterion-subject", ".taskloop/x.md"]).stderr, /state dir/i);
  // outside the envelope
  const fx2 = fixture();
  t.after(() => fs.rmSync(fx2.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fx2.repo, "data.md"), "draft\n");
  fs.writeFileSync(path.join(fx2.repo, "outside.md"), "x\n");
  const code = "const fs=require('fs');process.exit(fs.readFileSync('data.md','utf8').includes('MARK')?0:1)";
  const outside = run(fx2, [
    "open", "--repo", fx2.repo, "--goal", "g",
    "--criterion", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} data.md`,
    "--alignment", "green => x; not covered: y",
    "--files", "data.md", "--criterion-subject", "outside.md",
  ]);
  assert.match(outside.stderr, /outside the envelope/i);
});

test("the criterion file itself cannot be declared a work subject", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fx.repo, "check.mjs"), "process.exit(1);\n");
  const refused = run(fx, [
    "open", "--repo", fx.repo, "--goal", "g",
    "--criterion-file", "check.mjs",
    "--alignment", "green => x; not covered: y",
    "--files", "**", "--criterion-subject", "check.mjs",
  ]);
  assert.match(refused.stderr, /cannot name the criterion file itself/i);
  assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop", "task.json")), false);
});

test("amend adds a subject, and amending the criterion drops the old exemption", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(openSubjectFixture(fx).status, 0);
  const added = run(fx, [
    "amend", "--repo", fx.repo, "--criterion-subject", "data.md",
    "--reason", "data.md is the artifact this task rewrites, not a sensor",
  ]);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(readTask(fx).criterion_subject, ["data.md"]);
  assert.ok(readTask(fx).amendments.some((a) => Array.isArray(a.criterion_subjects_added)));

  // Moving the sensor drops the exemption bound to the old check.
  const moved = run(fx, [
    "amend", "--repo", fx.repo,
    "--criterion", `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(0)")}`,
    "--reason", "switch to a different check entirely",
  ]);
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(readTask(fx).criterion_subject, undefined);
});

// --- --earn-red: the red's witness point generalized from open to before-close ---

// A criterion-file that is green until `flag` says "fail"; it reads `flag` (no
// extension, no slash) so `flag` is never a fingerprinted input — the checker
// file itself never changes, keeping drift out of these tests.
function earnRedFixture(fx, extra = []) {
  fs.writeFileSync(
    path.join(fx.repo, "check.mjs"),
    "import fs from 'node:fs';process.exit(fs.existsSync('flag')&&fs.readFileSync('flag','utf8').includes('fail')?1:0);\n",
  );
  return run(fx, [
    "open", "--repo", fx.repo, "--goal", "add a failing check then make it pass",
    "--criterion-file", "check.mjs",
    "--alignment", "green => the check passes; not covered: whether the check is meaningful",
    "--files", "**", ...extra,
  ]);
}
const setRed = (fx) => fs.writeFileSync(path.join(fx.repo, "flag"), "fail\n");
const setGreen = (fx) => fs.writeFileSync(path.join(fx.repo, "flag"), "ok\n");

test("earn-red opens on green but bars the close until a red is witnessed", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const open = earnRedFixture(fx, ["--earn-red", "--reason", "the failing check does not exist yet"]);
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stderr, /earn-red: opened without a birth red/i);
  const task = readTask(fx);
  assert.equal(task.earn_red, true);
  assert.equal(task.red_witnessed, false);

  // A green close with no red ever witnessed is barred at both doors.
  const early = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /has not been witnessed red/i);
  assert.equal(readTask(fx).state, "open");

  // Witness a red (a red `done` counts), then a fresh green closes.
  setRed(fx);
  const red = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(red.status, 1);
  assert.equal(readTask(fx).red_witnessed, true);
  setGreen(fx);
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 0, done.stderr);
  const row = ledgerRows(fx).filter((r) => r.state === "done").at(-1);
  assert.equal(row.earn_red, true);
  assert.equal(row.red_witnessed, true);
});

test("the Stop gate holds an unearned green and records the red it later witnesses", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(earnRedFixture(fx, ["--earn-red", "--reason", "no failing check yet"]).status, 0);
  // Green at the Stop gate but never red → held, not closed.
  const held = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "er" });
  assert.equal(held.status, 2, held.stderr);
  assert.match(held.stderr, /has not been witnessed red/i);
  assert.equal(readTask(fx).state, "open");
  // A red Stop witnesses the red; a later green Stop then closes.
  setRed(fx);
  const redStop = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "er" });
  assert.equal(redStop.status, 2, redStop.stderr);
  assert.equal(readTask(fx).red_witnessed, true);
  setGreen(fx);
  const greenStop = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "er" });
  assert.equal(greenStop.status, 0, greenStop.stderr);
  assert.equal(readTask(fx).state, "done");
});

test("birth-red and keep-green tasks are untouched by the earn-red gate", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  // Default open still refuses a green birth.
  const greenBirth = earnRedFixture(fx);
  assert.equal(greenBirth.status, 1);
  assert.match(greenBirth.stderr, /already green/i);
  // Birth-red opens on red and closes on green with no witness gate and no field.
  setRed(fx);
  assert.equal(earnRedFixture(fx).status, 0);
  assert.equal(readTask(fx).earn_red, undefined);
  setGreen(fx);
  assert.equal(run(fx, ["done", "--repo", fx.repo]).status, 0);

  // keep-green closes on its green steady state, never earn-red-barred.
  const fx2 = fixture();
  t.after(() => fs.rmSync(fx2.root, { recursive: true, force: true }));
  assert.equal(
    earnRedFixture(fx2, ["--keep-green", "--reason", "regression guard; green is the steady state"]).status,
    0,
  );
  assert.equal(run(fx2, ["done", "--repo", fx2.repo]).status, 0);
});

test("amending the criterion resets the earn-red witness", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(earnRedFixture(fx, ["--earn-red", "--reason", "no failing check yet"]).status, 0);
  setRed(fx);
  run(fx, ["done", "--repo", fx.repo]); // witness the red
  assert.equal(readTask(fx).red_witnessed, true);
  const amended = run(fx, [
    "amend", "--repo", fx.repo,
    "--criterion", `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(0)")}`,
    "--reason", "switch to a wholly different check",
  ]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.equal(readTask(fx).red_witnessed, false);
  // The new sensor is green but never witnessed red → barred again.
  const done = run(fx, ["done", "--repo", fx.repo]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /has not been witnessed red/i);
});

test("earn-red rejects a missing reason and a keep-green combination", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.match(earnRedFixture(fx, ["--earn-red"]).stderr, /--earn-red requires --reason/i);
  assert.match(
    earnRedFixture(fx, ["--earn-red", "--keep-green", "--reason", "x"]).stderr,
    /contradictory/i,
  );
  assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop", "task.json")), false);
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

test("a Stop while machine-suspended releases without burning a round or opening an episode", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "session-a" });
  }
  const suspended = readTask(fx);
  assert.equal(suspended.suspension.outcome, "stuck", "precondition: the task is machine-suspended");
  const rounds = suspended.spent.rounds;
  const episodes = suspended.episodes.length;

  for (let i = 0; i < 3; i += 1) {
    const again = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "session-a" });
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /"decision":"block"/);
  }
  const after = readTask(fx);
  assert.equal(after.state, "open");
  assert.equal(after.suspension.outcome, "stuck");
  assert.equal(after.spent.rounds, rounds, "a suspended Stop must not burn a round");
  assert.equal(after.episodes.length, episodes, "a suspended Stop must not open an episode");
});

test("a Stop after a user needs_input suspension releases without burning a round", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx).status, 0);
  hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "session-a" });
  const suspend = run(fx, [
    "suspend",
    "--repo",
    fx.repo,
    "--outcome",
    "needs_input",
    "--judgment",
    "remaining: input; failure: unknown to agent; next: ask the user",
  ]);
  assert.equal(suspend.status, 0, suspend.stderr);
  const before = readTask(fx);
  assert.equal(before.suspension.outcome, "needs_input");

  const stop = hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "session-a" });
  assert.equal(stop.status, 0, stop.stderr);
  assert.doesNotMatch(stop.stdout, /"decision":"block"/);
  const after = readTask(fx);
  assert.equal(after.spent.rounds, before.spent.rounds, "a suspended Stop must not burn a round");
  assert.equal(after.suspension.outcome, "needs_input", "the sticky suspension must survive the Stop");
});

test("repeated done refusals never push spent.rounds past the budget", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx, ["--rounds", "1"]).status, 0);

  for (let i = 0; i < 4; i += 1) {
    const refused = run(fx, ["done", "--repo", fx.repo]);
    assert.equal(refused.status, 1, refused.stderr);
  }
  const task = readTask(fx);
  assert.ok(
    task.spent.rounds <= task.budget.rounds,
    `spent rounds ${task.spent.rounds} must not exceed budget ${task.budget.rounds}`,
  );
});

test("a task failing to its round cap suspends as out_of_budget, not stuck", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx, ["--rounds", "3"]).status, 0);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "cap" });
  }
  const task = readTask(fx);
  assert.equal(task.spent.rounds, 3, "rounds cap exactly at the budget");
  // Once the budget is spent, out_of_budget outranks the stuck signature: the
  // task is write-blocked on resume regardless, so the guidance must point at
  // amend --rounds, not label it merely stuck.
  assert.equal(task.suspension.outcome, "out_of_budget");
});

test("repeated criterion-failure caps spent.rounds exactly at the budget", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  assert.equal(open(fx, ["--rounds", "2"]).status, 0);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    hook(fx, { hook_event_name: "Stop", cwd: fx.repo, session_id: "cap2" });
  }
  assert.equal(readTask(fx).spent.rounds, 2, "criterion-failure must cap exactly at budget, never over");
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
  // A stop on an already-suspended task releases without re-suspending, so the
  // stall suspension is written exactly once — no duplicate suspended rows, no
  // burned round; reads and verification stay free.
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

// --- P1: cross-worktree envelope overlap advisory ---

// A git repo with a `lib/a.js`, plus a sibling worktree sharing its .git.
function worktreePair(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-wt-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const home = path.join(rootDir, "home");
  const a = path.join(rootDir, "repo");
  const b = path.join(rootDir, "repo-b");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(a, "lib"), { recursive: true });
  fs.mkdirSync(path.join(a, "docs"), { recursive: true });
  fs.writeFileSync(path.join(a, "lib", "a.js"), "x\n");
  fs.writeFileSync(path.join(a, "docs", "x.md"), "x\n");
  const env = { HOME: home, USERPROFILE: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd, args) => spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  git(a, ["init", "-q"]); git(a, ["add", "-A"]); git(a, ["commit", "-q", "-m", "init"]);
  git(a, ["worktree", "add", "-q", "-b", "b", b]);
  const cli = (cwd, args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  const openIn = (cwd, files) =>
    cli(cwd, [
      "open", "--repo", cwd, "--probe", "--force", "--goal", "t",
      "--criterion", `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`,
      "--alignment", "green => x; not covered: y",
      ...files.flatMap((f) => ["--files", f]),
    ]);
  const amendIn = (cwd, files) => cli(cwd, ["amend", "--repo", cwd, ...files.flatMap((f) => ["--files", f]), "--reason", "widen"]);
  return { a, b, openIn, amendIn, cli };
}

test("opening a task warns when its envelope definitely overlaps a sibling worktree's open task", (t) => {
  const { a, b, openIn } = worktreePair(t);
  assert.equal(openIn(a, ["lib/**"]).status, 0); // owner in worktree A
  const opened = openIn(b, ["lib/**"]); // B overlaps: lib/a.js matches both
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /definite overlap on:[^\n]*lib\/\*\*/i);
  assert.ok(opened.stderr.includes(a), "should name the sibling worktree path");
});

test("a disjoint envelope in a sibling worktree stays silent", (t) => {
  const { a, b, openIn } = worktreePair(t);
  assert.equal(openIn(a, ["lib/**"]).status, 0);
  const opened = openIn(b, ["docs/**"]); // no file matches both, prefixes differ
  assert.equal(opened.status, 0, opened.stderr);
  assert.doesNotMatch(opened.stderr, /overlap/i);
});

test("prefix-compatible envelopes with no co-matching file warn only as potential", (t) => {
  const { a, b, openIn } = worktreePair(t);
  assert.equal(openIn(a, ["lib/**"]).status, 0);
  const opened = openIn(b, ["lib/*.md"]); // shares prefix lib/, but no lib/*.md file exists
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /potential overlap on:[^\n]*lib\/\*\.md/i);
  assert.doesNotMatch(opened.stderr, /definite overlap/i);
});

test("amend --files that newly overlaps a sibling worktree also warns", (t) => {
  const { a, b, openIn, amendIn } = worktreePair(t);
  assert.equal(openIn(a, ["lib/**"]).status, 0);
  assert.equal(openIn(b, ["docs/**"]).status, 0); // start disjoint
  const amended = amendIn(b, ["lib/**"]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.match(amended.stderr, /definite overlap on:[^\n]*lib\/\*\*/i);
});

test("suffix-incompatible globs in the same directory do not warn", (t) => {
  const { a, b, openIn } = worktreePair(t);
  assert.equal(openIn(a, ["lib/*.js"]).status, 0);
  const opened = openIn(b, ["lib/*.md"]); // shares lib/ but .js and .md never co-match
  assert.equal(opened.status, 0, opened.stderr);
  assert.doesNotMatch(opened.stderr, /overlap/i);
});

test("a sibling's closed task is not counted as an overlap", (t) => {
  const { a, b, openIn, cli } = worktreePair(t);
  assert.equal(openIn(a, ["lib/**"]).status, 0);
  assert.equal(cli(a, ["abandon", "--repo", a, "--reason", "done here"]).status, 0);
  const opened = openIn(b, ["lib/**"]); // A's task is closed → no open sibling
  assert.equal(opened.status, 0, opened.stderr);
  assert.doesNotMatch(opened.stderr, /overlap/i);
});

test("a file deleted in the sibling worktree downgrades definite to potential", (t) => {
  const { a, b, openIn } = worktreePair(t);
  fs.rmSync(path.join(a, "lib", "a.js")); // present in b, absent in a's checkout
  assert.equal(openIn(a, ["lib/**"]).status, 0);
  const opened = openIn(b, ["lib/**"]); // lib/a.js exists in b but not a → not definite
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, /potential overlap on:[^\n]*lib\/\*\*/i);
  assert.doesNotMatch(opened.stderr, /definite overlap/i);
});

test("a corrupt sibling task.json is skipped, not fatal", (t) => {
  const { a, b, openIn } = worktreePair(t);
  assert.equal(openIn(a, ["lib/**"]).status, 0);
  fs.writeFileSync(path.join(a, ".taskloop", "task.json"), "{ not json"); // corrupt A's task
  const opened = openIn(b, ["lib/**"]); // unreadable sibling → skipped, open still succeeds
  assert.equal(opened.status, 0, opened.stderr);
  assert.doesNotMatch(opened.stderr, /overlap/i);
});

test("the overlap warning carries the sibling task's opened-time and suspended context", (t) => {
  const { a, b, openIn, cli } = worktreePair(t);
  assert.equal(openIn(a, ["lib/**"]).status, 0);
  // Not suspended yet: the warning names when the sibling task opened.
  const live = openIn(b, ["lib/**"]);
  assert.match(live.stderr, /opened \d{4}-\d\d-\d\dT/);
  assert.doesNotMatch(live.stderr, /suspended:/i);
  // Suspend A: the same overlap now also reports the paused state (a context
  // line, not an "inactive" verdict — the task is still open and overlapping).
  assert.equal(cli(a, ["suspend", "--repo", a, "--outcome", "needs_input", "--judgment", "x; y; z"]).status, 0);
  const paused = openIn(b, ["lib/**"]);
  assert.match(paused.stderr, /suspended: needs_input/i);
  assert.match(paused.stderr, /overlap on:/i); // still flagged as an overlap
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
  // The allowed write lands before the next PreToolUse, as it would live: the
  // gate only counts prior entries that actually materialized on disk.
  fs.mkdirSync(path.join(fx.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, "src", "a file.txt"), "hi\n");
  const second = invoke("src/b file.txt");
  assert.match(second.stdout, /"permissionDecision":"deny"/);
  assert.match(second.stderr, /src\/a file\.txt.*src\/b file\.txt/i);
});

test("an armed untracked gate still releases outside-repo and target-less writes", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fx.repo, "src"), { recursive: true });
  const invoke = (command) =>
    hook(fx, {
      hook_event_name: "PreToolUse",
      cwd: fx.repo,
      session_id: "outside-release",
      tool_name: "Bash",
      tool_input: { command },
    });

  const first = invoke("printf a > src/a.txt");
  assert.equal(first.status, 0, first.stderr);
  fs.writeFileSync(path.join(fx.repo, "src", "a.txt"), "a\n");
  const armed = invoke("printf b > src/b.txt");
  assert.match(armed.stdout, /"permissionDecision":"deny"/);

  // The stated contract: writes outside this repo, and write-shaped calls with
  // no extractable target, nudge but never gate — even once the gate is armed.
  const outsideTarget = path.join(os.tmpdir(), `taskloop-armed-outside-${process.pid}.txt`);
  const outside = invoke(`printf hi > ${JSON.stringify(outsideTarget)}`);
  assert.equal(outside.status, 0, outside.stderr);
  assert.doesNotMatch(outside.stdout, /permissionDecision/);

  const targetless = invoke("sed -i -e s/a/b/ src/a.txt");
  assert.equal(targetless.status, 0, targetless.stderr);
  assert.doesNotMatch(targetless.stdout, /permissionDecision/);

  // Repo-attributed multi-file work stays gated: the release is per-target,
  // not a hole in the gate.
  const retry = invoke("printf b > src/b.txt");
  assert.match(retry.stdout, /"permissionDecision":"deny"/);
});

test("a misattributed compound-command redirect cannot poison the untracked gate", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-elsewhere-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fx.repo, "src"), { recursive: true });
  const invoke = (command) =>
    hook(fx, {
      hook_event_name: "PreToolUse",
      cwd: fx.repo,
      session_id: "cd-poison",
      tool_name: "Bash",
      tool_input: { command },
    });

  // The redirect target lives under the cd'd directory, but attribution folds
  // it against the payload cwd — a phantom entry that never appears in-repo.
  const phantom = invoke(`cd ${JSON.stringify(elsewhere)} && printf hi > notes.txt`);
  assert.equal(phantom.status, 0, phantom.stderr);

  const real = invoke("printf c > src/c.txt");
  assert.equal(real.status, 0, real.stderr);
  assert.doesNotMatch(real.stdout, /permissionDecision/);
  const scratch = JSON.parse(
    fs.readFileSync(path.join(fx.repo, ".taskloop", "untracked-writes.json"), "utf8"),
  );
  assert.deepEqual(scratch.sessions["cd-poison"].files, ["src/c.txt"]);
});

test("unexpanded environment-variable redirect targets never enter untracked accounting", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const result = hook(fx, {
    hook_event_name: "PreToolUse",
    cwd: fx.repo,
    session_id: "dollar-target",
    tool_name: "Bash",
    tool_input: { command: "printf hi > $SCRATCH/../notes.txt" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /permissionDecision/);
  const scratch = JSON.parse(
    fs.readFileSync(path.join(fx.repo, ".taskloop", "untracked-writes.json"), "utf8"),
  );
  assert.deepEqual(scratch.sessions["dollar-target"].files, []);
});

test("a failed outcome-ledger append says so on stderr instead of dropping silently", (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  // Occupy the ledger directory path with a file so the append cannot succeed —
  // the shape a sandboxed or broken home produces.
  fs.writeFileSync(path.join(fx.home, ".taskloop"), "occupied\n");
  const result = open(fx);
  assert.equal(result.status, 0, result.stderr); // telemetry failure must never trap the verb
  assert.doesNotThrow(() => readTask(fx));
  assert.match(result.stderr, /outcome ledger append failed/i);
});

// A read-only workspace (observed live: the Codex read-only sandbox tier) must
// refuse verbs with a clean one-line error, not an uncaught errno stack. State
// stays untouched either way; these pin the error CHANNEL.

test(
  "open in a read-only workspace refuses cleanly instead of dumping a raw stack",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  (t) => {
    const fx = fixture();
    t.after(() => {
      fs.chmodSync(fx.repo, 0o755);
      fs.rmSync(fx.root, { recursive: true, force: true });
    });
    fs.chmodSync(fx.repo, 0o555); // the state dir cannot be created
    const result = open(fx);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /cannot write task state/i);
    assert.doesNotMatch(result.stderr, /at Object\.|node:fs|node:internal/);
    assert.equal(fs.existsSync(path.join(fx.repo, ".taskloop")), false);
  },
);

test(
  "a write verb against an unwritable state dir refuses cleanly and mutates nothing",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  (t) => {
    const fx = fixture();
    const stateDir = path.join(fx.repo, ".taskloop");
    t.after(() => {
      try {
        fs.chmodSync(stateDir, 0o755);
      } catch {
        /* already writable or gone */
      }
      fs.rmSync(fx.root, { recursive: true, force: true });
    });
    assert.equal(open(fx).status, 0);
    fs.chmodSync(stateDir, 0o555); // the lock dir cannot be created
    const result = run(fx, [
      "suspend", "--repo", fx.repo,
      "--outcome", "needs_input",
      "--judgment", "remaining; failure; next",
    ]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /cannot write task state/i);
    assert.doesNotMatch(result.stderr, /at Object\.|node:fs|node:internal/);
    fs.chmodSync(stateDir, 0o755);
    assert.equal(readTask(fx).suspension, undefined, "a refused verb must not mutate task state");
  },
);

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
