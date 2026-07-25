// Appends to a store and kills itself at a named phase. Used by the crash
// injection matrix: SIGKILL rather than a thrown error, because an exception
// unwinds cleanly through the very code paths the test is trying to interrupt.
import { openStore } from "../../src/store.mjs";

const [location, phase, commandId, requestDigest, padding = "0"] = process.argv.slice(2);

const store = openStore(location, {
  reduce: (state, record) => ({ ...state, count: (state?.count ?? 0) + 1, seq: record.seq }),
  initial: {},
  snapshotEvery: 3,
  segmentMaxBytes: Number(process.env.SEGMENT_MAX_BYTES ?? 4 * 1024 * 1024),
  lockLeaseMs: Number(process.env.LOCK_LEASE_MS ?? 300),
  onPhase: (reached) => {
    if (reached === phase) process.kill(process.pid, "SIGKILL");
  },
});

store.append({
  commandId,
  requestDigest,
  prepare: () => [{ kind: "crash", payload: { padding: "p".repeat(Number(padding)) } }],
});
process.stdout.write("completed\n");
