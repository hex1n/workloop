// SL-03: the three-round cross-session repair loop, which is the acceptance
// scenario the whole design exists to make possible — and SL-07, SL-09, SL-10
// around it.
//
// Every process boundary here is real. A loop that only works inside one
// process would prove nothing about the thing being built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { EXIT, VERDICT_PREFIX, readVerdict } from "../src/domain/criterion.mjs";
import { abandon, amend, join, next, observe, openLoop, openLoopStore, resume, suspend } from "../src/domain/loop.mjs";
import { DECISION, VERDICT } from "../src/domain/vocabulary.mjs";

const OBSERVE_CHILD = path.resolve(import.meta.dirname, "helpers", "observe-child.mjs");

// A criterion that reads the work file and reports structured failures. It is
// a real process the runtime starts, not a stub the test hands back.
const CRITERION = `
import fs from "node:fs";
const text = fs.readFileSync("work.txt", "utf8").trim();
const failures = [];
if (!text.includes("alpha")) failures.push({ id: "missing-alpha", expected: "alpha", actual: text });
if (!text.includes("beta")) failures.push({ id: "missing-beta", expected: "beta", actual: text });
const verdict = failures.length === 0 ? "satisfied" : "unsatisfied";
console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict, failures }));
process.exit(failures.length === 0 ? ${EXIT.SATISFIED} : ${EXIT.UNSATISFIED});
`;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "work.txt"), "nothing yet\n");
  fs.writeFileSync(path.join(root, "check.mjs"), CRITERION);
  const location = path.join(root, "store");
  fs.mkdirSync(location);
  createStore({ location, commandId: "genesis" });
  // Each session opens the store fresh, exactly as a new process would.
  const session = () => openLoopStore(location);
  return { root, location, session, criterionFile: path.join(root, "check.mjs") };
}

const write = (root, text) => fs.writeFileSync(path.join(root, "work.txt"), text);

test("SL-03: three rounds, three sessions, one durable loop", async (t) => {
  const { root, location, session, criterionFile } = workspace(t);

  // Session 1 opens the loop and is told to implement.
  const { loopId } = openLoop(session(), { goal: "work.txt must mention alpha and beta", claims: ["work.txt"], criterionFile, roundsBudget: 3, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open" });
  const first = next(session(), { loopId });
  assert.equal(first.decision, DECISION.IMPLEMENT);
  assert.equal(first.round, 1);
  assert.equal(first.feedback, null, "there is nothing to repair yet");

  // Round 1: the agent does the wrong thing. The runtime runs the criterion
  // itself and records what it found.
  write(root, "gamma\n");
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });

  // Session 2 — a different process entirely — picks the loop up and is handed
  // the failure from round 1.
  const second = next(session(), { loopId });
  assert.equal(second.decision, DECISION.REPAIR);
  assert.equal(second.round, 2);
  assert.equal(second.feedback.verdict, VERDICT.UNSATISFIED);
  assert.ok(second.feedback.progress_signature, "the repair directive carries what failed");
  assert.equal(second.rounds_remaining, 2);

  // Round 2 runs in a real child process that then exits. Nothing but the
  // directory on disk carries the loop from round 1 to round 3 — which is the
  // claim the whole design rests on.
  write(root, "alpha\n");
  const child = spawnSync(process.execPath, [OBSERVE_CHILD, location, root, loopId, criterionFile, "s2", "observe-2"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { round: 2, decision: DECISION.REPAIR }, "the child was handed the repair directive");

  const third = next(session(), { loopId });
  assert.equal(third.decision, DECISION.REPAIR, "a changed failure is progress, not stuckness");
  assert.notEqual(third.feedback.progress_signature, second.feedback.progress_signature);

  // Round 3: satisfied.
  write(root, "alpha beta\n");
  await observe(session(), { loopId, root, session: "s3", criterionFile, commandId: "observe-3" });

  const terminal = next(session(), { loopId });
  assert.equal(terminal.decision, DECISION.ACHIEVED);
  assert.equal(terminal.terminal, true);
  // Asking again returns the same ending, byte for byte, forever.
  assert.equal(JSON.stringify(next(session(), { loopId })), JSON.stringify(terminal));

  const records = session().read();
  assert.deepEqual(
    records.filter((record) => record.kind === "round_observed").map((record) => record.payload.verdict),
    [VERDICT.UNSATISFIED, VERDICT.UNSATISFIED, VERDICT.SATISFIED],
  );
  assert.equal(records.at(-1).kind, "loop_terminal");
  assert.equal(records.at(-1).payload.outcome, "achieved");
  // The whole history replays from genesis in a process that never saw it happen.
  assert.deepEqual(session().replay({ useSnapshot: false }).state, session().replay().state);
});

test("SL-04: the same failure against unchanged artifacts becomes stuck", async (t) => {
  const { root, session, criterionFile } = workspace(t);
  const { loopId } = openLoop(session(), { goal: "g", claims: ["work.txt"], criterionFile, roundsBudget: 10, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open" });
  write(root, "gamma\n");
  for (const round of [1, 2, 3]) {
    await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: `observe-${round}` });
  }
  const directive = next(session(), { loopId });
  assert.equal(directive.decision, DECISION.SUSPEND, "a stuck loop stops asking for the same thing");
  const suspended = session().read().filter((record) => record.kind === "loop_suspended");
  assert.equal(suspended.length, 1);
  assert.match(suspended[0].payload.reason, /survived 3 rounds/u);
});

test("SL-05: an exhausted budget suspends, and an amendment brings the loop back", async (t) => {
  const { root, session, criterionFile } = workspace(t);
  const { loopId } = openLoop(session(), { goal: "g", claims: ["work.txt"], criterionFile, roundsBudget: 1, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open" });
  write(root, "gamma\n");
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });

  assert.equal(next(session(), { loopId }).decision, DECISION.SUSPEND);
  assert.equal(session().read().at(-1).payload.outcome, "out_of_budget");

  amend(session(), { loopId, roundsBudget: 3, reason: "worth another try", commandId: "amend" });
  // A session that has not taken part has no standing to move the loop, so it
  // says so explicitly first.
  assert.throws(() => resume(session(), { loopId, reason: "r", session: "s2", commandId: "resume-early" }), (error) => error.code === "NOT_A_PARTICIPANT");
  join(session(), { loopId, session: "s2", reason: "taking over after the budget was raised", commandId: "join-s2" });
  resume(session(), { loopId, reason: "budget raised", session: "s2", commandId: "resume" });
  assert.equal(next(session(), { loopId }).decision, DECISION.REPAIR);

  write(root, "alpha beta\n");
  await observe(session(), { loopId, root, session: "s2", criterionFile, commandId: "observe-2" });
  assert.equal(next(session(), { loopId }).decision, DECISION.ACHIEVED);
});

test("SL-07: a round written against a moved loop is refused, not merged", async (t) => {
  const { root, session, criterionFile } = workspace(t);
  const store = session();
  const { loopId } = openLoop(store, { goal: "g", claims: ["work.txt"], criterionFile, roundsBudget: 5, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open" });
  write(root, "gamma\n");

  // Another session suspends the loop while this one is mid-round. The
  // observation must not land on top of a loop that changed underneath it.
  join(session(), { loopId, session: "s2", reason: "second session joins", commandId: "join-s2" });
  const observing = observe(store, { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });
  suspend(session(), { loopId, outcome: "needs_input", reason: "hold on", session: "s2", commandId: "suspend" });
  await assert.rejects(observing, (error) => error.code === "ROUND_STALE");
  assert.equal(session().read().some((record) => record.kind === "round_observed"), false, "nothing was recorded");
});

test("SL-09: a criterion that never returns is killed and reads as indeterminate", async (t) => {
  const { root, session } = workspace(t);
  const slow = path.join(root, "slow.mjs");
  const pidFile = path.join(root, "descendant.pid");
  fs.writeFileSync(slow, `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  `);
  const { loopId } = openLoop(session(), { goal: "g", claims: ["work.txt"], criterionFile: slow, roundsBudget: 3, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open" });

  const started = Date.now();
  await observe(session(), { loopId, root, session: "s1", criterionFile: slow, timeoutMs: 700, commandId: "observe-1" });
  assert.ok(Date.now() - started < 10_000, "the timeout returns promptly");

  const observation = session().read().find((record) => record.kind === "round_observed");
  assert.equal(observation.payload.verdict, VERDICT.INDETERMINATE);
  assert.equal(observation.payload.progress_signature, null, "an unknown is not a failure with an identity");
  assert.equal(next(session(), { loopId }).decision, DECISION.COLLECT_EVIDENCE);

  // The whole process group dies, not just the child the runtime started.
  if (process.platform !== "win32" && fs.existsSync(pidFile)) {
    const descendant = Number(fs.readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(descendant, 0), (error) => error.code === "ESRCH", "a descendant of the criterion survived");
  }
});

test("SL-12: a finished loop refuses further work", async (t) => {
  const { root, session, criterionFile } = workspace(t);
  const { loopId } = openLoop(session(), { goal: "g", claims: ["work.txt"], criterionFile, roundsBudget: 3, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open" });
  write(root, "alpha beta\n");
  await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" });

  await assert.rejects(
    observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-2" }),
    (error) => error.code === "NOT_LIVE",
  );
  assert.throws(() => amend(session(), { loopId, goal: "something else", reason: "r", commandId: "amend" }), (error) => error.code === "ALREADY_TERMINAL");
  assert.throws(() => abandon(session(), { loopId, reason: "r", commandId: "abandon" }), (error) => error.code === "ALREADY_TERMINAL");
});

test("the criterion must be the one the loop was opened with", async (t) => {
  const { root, session, criterionFile } = workspace(t);
  const { loopId } = openLoop(session(), { goal: "g", claims: ["work.txt"], criterionFile, roundsBudget: 3, session: "s1", reason: "fixture", grantedBy: "self", receipts: "none", commandId: "open" });
  fs.appendFileSync(criterionFile, "\n// changed after opening\n");
  await assert.rejects(
    observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "observe-1" }),
    (error) => error.code === "CRITERION_CHANGED",
  );
});

test("SL-10: success never happens by accident", () => {
  // Exit 0 is what a missing file, a stray `true`, or a crashed interpreter
  // produces. None of them may read as green.
  assert.equal(readVerdict({ stdout: "", code: 0, signal: null }).verdict, VERDICT.INDETERMINATE);
  assert.equal(readVerdict({ stdout: "", code: 1, signal: null }).verdict, VERDICT.INDETERMINATE);
  assert.equal(readVerdict({ stdout: "", code: null, signal: "SIGKILL" }).verdict, VERDICT.INDETERMINATE);
  assert.equal(readVerdict({ stdout: "", code: EXIT.SATISFIED, signal: null }).verdict, VERDICT.SATISFIED);
  assert.equal(readVerdict({ stdout: "", code: EXIT.UNSATISFIED, signal: null }).verdict, VERDICT.UNSATISFIED);

  // A spoken verdict wins, but not when its own exit code contradicts it.
  const spoken = (verdict, code) => readVerdict({ stdout: `${VERDICT_PREFIX} ${JSON.stringify({ verdict, failures: [] })}\n`, code, signal: null });
  assert.equal(spoken("satisfied", EXIT.SATISFIED).verdict, VERDICT.SATISFIED);
  assert.equal(spoken("satisfied", EXIT.UNSATISFIED).verdict, VERDICT.INDETERMINATE);
  assert.equal(spoken("satisfied", 0).verdict, VERDICT.SATISFIED, "a silent exit code does not contradict anything");
  assert.equal(readVerdict({ stdout: `${VERDICT_PREFIX} not json\n`, code: EXIT.SATISFIED, signal: null }).verdict, VERDICT.INDETERMINATE);
  assert.equal(readVerdict({ stdout: `${VERDICT_PREFIX} {"verdict":"lovely"}\n`, code: EXIT.SATISFIED, signal: null }).verdict, VERDICT.INDETERMINATE);

  // The last verdict line wins, so a criterion that prints progress cannot be
  // read by an earlier, stale line.
  const twice = `${VERDICT_PREFIX} {"verdict":"unsatisfied","failures":[]}\n${VERDICT_PREFIX} {"verdict":"satisfied","failures":[]}\n`;
  assert.equal(readVerdict({ stdout: twice, code: EXIT.SATISFIED, signal: null }).verdict, VERDICT.SATISFIED);
});
