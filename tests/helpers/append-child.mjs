// Appends a run of commands to a shared store. Used by the single-writer
// property: several of these run at once against one store.
import { digestOf } from "../../src/canonical.mjs";
import { openStore } from "../../src/store.mjs";

const [location, id, count] = process.argv.slice(2);

const store = openStore(location, {
  reduce: (state, record) => ({ ...state, count: (state?.count ?? 0) + 1, seq: record.seq }),
  initial: {},
  snapshotEvery: 4,
  lockTimeoutMs: 30_000,
});

for (let index = 0; index < Number(count); index += 1) {
  const commandId = `${id}-${index}`;
  store.append({
    commandId,
    requestDigest: digestOf({ commandId }),
    // Two records per command, so an interleaving would show up as a command
    // whose halves are separated by somebody else's record.
    prepare: () => [
      { kind: "open", payload: { writer: id, index } },
      { kind: "close", payload: { writer: id, index } },
    ],
  });
}
