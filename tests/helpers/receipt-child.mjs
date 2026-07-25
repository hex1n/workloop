// Takes one commit receipt and exits. Two of these run at once with the same
// command id: a retry racing its original is the case the in-lock idempotence
// check exists for, and it cannot happen inside a single process.
//
// The barrier is what makes the race real. Without it the first process has
// already appended by the time the second starts, so both callers never sit
// inside the window at once and the test passes whether the guard is there or
// not — a green that proves nothing.
import fs from "node:fs";
import path from "node:path";
import { openLoopStore, receipt } from "../../src/domain/loop.mjs";

const [location, root, session, commandId, barrier, expected] = process.argv.slice(2);

fs.writeFileSync(path.join(barrier, `${session}.ready`), "");
const deadline = Date.now() + 10_000;
while (fs.readdirSync(barrier).length < Number(expected) && Date.now() < deadline) {
  // Spin: a sleep would reintroduce the skew the barrier exists to remove.
}

try {
  const result = receipt(openLoopStore(location, { lockTimeoutMs: 30_000 }), { root, mode: "commit", session, commandId });
  process.stdout.write(`${result.replayed ? "replayed" : "recorded"}\n`);
} catch (error) {
  process.stdout.write(`refused:${error.code}\n`);
}
