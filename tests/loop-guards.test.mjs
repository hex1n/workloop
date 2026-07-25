// The guards slice 2's review found missing: SL-01 provenance, SL-02 claim
// shape, SL-11 standing, and the retry that must not pay for the criterion
// twice.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { EXIT, VERDICT_PREFIX, streamSink } from "../src/domain/criterion.mjs";
import { artifactCheckpoint, assertClaims, join, observe, openLoop, openLoopStore, suspend } from "../src/domain/loop.mjs";

const CRITERION = `
import fs from "node:fs";
fs.appendFileSync("runs.log", "ran\\n");
console.log("${VERDICT_PREFIX} " + JSON.stringify({ verdict: "unsatisfied", failures: [{ id: "still-red" }] }));
process.exit(${EXIT.UNSATISFIED});
`;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloop-guards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "work.txt"), "start\n");
  fs.writeFileSync(path.join(root, "check.mjs"), CRITERION);
  const location = path.join(root, "store");
  fs.mkdirSync(location);
  createStore({ location, commandId: "genesis" });
  return { root, location, session: () => openLoopStore(location), criterionFile: path.join(root, "check.mjs") };
}

const valid = (extra = {}) => ({
  goal: "g", claims: ["work.txt"], roundsBudget: 3, session: "s1",
  reason: "because", grantedBy: "self", receipts: "none", commandId: "open", ...extra,
});

test("SL-01: opening records who and why, and refuses to proceed without them", (t) => {
  const { root, session, criterionFile } = workspace(t);
  for (const [changes, code] of [
    [{ goal: "  " }, "GOAL_REQUIRED"],
    [{ session: "" }, "SESSION_REQUIRED"],
    [{ reason: "" }, "REASON_REQUIRED"],
    [{ grantedBy: "somebody" }, "PROVENANCE_REQUIRED"],
  ]) {
    assert.throws(() => openLoop(session(), { root, ...valid(changes), criterionFile }), (error) => error.code === code, code);
  }
  const { loopId } = openLoop(session(), { root, ...valid(), criterionFile });
  const record = session().read().find((entry) => entry.kind === "loop_opened");
  assert.equal(record.payload.reason, "because");
  assert.equal(record.payload.granted_by, "self");
});

test("SL-02: claims are literal, relative, distinct and non-overlapping paths", (t) => {
  const { root } = workspace(t);
  assert.deepEqual(assertClaims(root, ["src/b", "src/a"]), ["src/a", "src/b"], "claims are stored in a stable order");
  for (const [claims, code] of [
    [[], "CLAIMS_REQUIRED"],
    [["src/**"], "CLAIM_SHAPE"],
    [["src/*.mjs"], "CLAIM_SHAPE"],
    [["/etc/passwd"], "CLAIM_SHAPE"],
    [["../outside"], "CLAIM_SHAPE"],
    [["src/../../outside"], "CLAIM_SHAPE"],
    [["src", "src"], "CLAIM_SHAPE"],
    // Overlap would make "my paths" undecidable, which is the one thing
    // claims exist to decide.
    [["src", "src/nested"], "CLAIM_OVERLAP"],
  ]) {
    assert.throws(() => assertClaims(root, claims), (error) => error.code === code, JSON.stringify(claims));
  }
});

test("SL-11: only a session that has taken part may move the loop", (t) => {
  const { root, session, criterionFile } = workspace(t);
  const { loopId } = openLoop(session(), { root, ...valid(), criterionFile });
  assert.throws(
    () => suspend(session(), { loopId, outcome: "needs_input", reason: "r", session: "stranger", commandId: "s" }),
    (error) => error.code === "NOT_A_PARTICIPANT",
  );
  join(session(), { loopId, session: "stranger", reason: "invited", commandId: "join" });
  assert.ok(suspend(session(), { loopId, outcome: "needs_input", reason: "r", session: "stranger", commandId: "s" }));
  // Joining twice is refused rather than quietly accumulating duplicates.
  assert.throws(() => join(session(), { loopId, session: "stranger", reason: "again", commandId: "join-2" }), (error) => error.code === "ALREADY_PARTICIPANT");
});

test("a retried round does not pay for the criterion a second time", async (t) => {
  const { root, session, criterionFile } = workspace(t);
  const { loopId } = openLoop(session(), { root, ...valid(), criterionFile });
  const runs = () => (fs.existsSync(path.join(root, "runs.log")) ? fs.readFileSync(path.join(root, "runs.log"), "utf8").trim().split("\n").length : 0);

  const first = await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "round-1" });
  assert.equal(first.replayed, false);
  assert.equal(runs(), 1);

  // The same command again: recognised before the criterion is spawned, so a
  // retry after a crash costs nothing and cannot record a second round.
  const again = await observe(session(), { loopId, root, session: "s1", criterionFile, commandId: "round-1" });
  assert.equal(again.replayed, true);
  assert.equal(runs(), 1, "the criterion ran once, not twice");
  assert.deepEqual(again.records.map((entry) => entry.seq), first.records.map((entry) => entry.seq));
  assert.equal(session().read().filter((entry) => entry.kind === "round_observed").length, 1);
});

test("a stream digest can be asked for twice", () => {
  // A hash can only be finalised once. Both the failure path and the close
  // path build an execution record, and a spawn that fails can run both — the
  // second call then threw *after* the promise had settled, which surfaces as
  // an unhandled exception with nobody to catch it.
  const sink = streamSink();
  sink.write("some output");
  const first = sink.digest();
  assert.equal(sink.digest(), first, "asking again gives the same answer instead of throwing");
});

test("a checkpoint survives what a real tree contains", (t) => {
  const { root } = workspace(t);
  const claim = path.join(root, "tree");
  fs.mkdirSync(path.join(claim, "nested"), { recursive: true });
  fs.writeFileSync(path.join(claim, "nested", "file.txt"), "content");
  // A symlink that points at its own parent: following it would walk forever.
  fs.symlinkSync(claim, path.join(claim, "loop-link"));
  fs.symlinkSync(path.join(root, "does-not-exist"), path.join(claim, "dangling"));

  const first = artifactCheckpoint(root, ["tree"]);
  assert.match(first, /^sha256:/u);
  assert.equal(artifactCheckpoint(root, ["tree"]), first, "the checkpoint is stable");
  fs.writeFileSync(path.join(claim, "nested", "file.txt"), "changed");
  assert.notEqual(artifactCheckpoint(root, ["tree"]), first, "and it moves when the artifacts do");

  // A claim that names nothing is a fact, not an error.
  assert.match(artifactCheckpoint(root, ["never-created"]), /^sha256:/u);
});
