// Appends to a store and kills itself at a named phase. Used by the crash
// injection matrix: SIGKILL rather than a thrown error, because an exception
// unwinds cleanly through the very code paths the test is trying to interrupt.
import fs from "node:fs";
import { openStore } from "../../src/store.mjs";

const [location, phase, commandId, requestDigest, padding = "0", marker] = process.argv.slice(2);

const store = openStore(location, {
  reduce: (state, record) => ({ ...state, count: (state?.count ?? 0) + 1, seq: record.seq }),
  initial: {},
  snapshotEvery: 3,
  segmentMaxBytes: Number(process.env.SEGMENT_MAX_BYTES ?? 4 * 1024 * 1024),
  lockLeaseMs: Number(process.env.LOCK_LEASE_MS ?? 300),
  onPhase: (reached) => {
    if (reached !== phase) return;
    // Written before the kill, and synchronously, so the parent can tell "died
    // where it was told to" from "died on the way there". Windows has no
    // signals — `process.kill` there is TerminateProcess with exit code 1, the
    // same code a syntax error produces — so the signal alone cannot carry that
    // proof, and on POSIX it never carried more than "something sent SIGKILL".
    fs.writeFileSync(marker, reached);
    process.kill(process.pid, "SIGKILL");
  },
});

store.append({
  commandId,
  requestDigest,
  prepare: () => [{ kind: "crash", payload: { padding: "p".repeat(Number(padding)) } }],
});
process.stdout.write("completed\n");
