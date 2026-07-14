const description = {
  interface_version: 1,
  production_module: "lib/event-store.mjs",
  snapshot_module: "lib/task-store.mjs",
  operations: ["create-genesis", "append", "recover", "write-snapshot"],
  seams: [
    "before-genesis-temp-create",
    "during-genesis-write",
    "after-genesis-temp-fsync",
    "after-genesis-rename",
    "before-append",
    "during-append",
    "after-record-write",
    "after-event-fsync",
    "during-snapshot-write",
    "after-snapshot-rename",
    "after-quarantine-receipt-fsync",
  ],
  required_arguments: ["--repo", "--operation", "--seam", "--command-file"],
  notification_fields: ["protocol_version", "operation", "seam", "pid", "repo", "at_epoch_ms"],
  notification_protocol: "newline JSON on stdout after a production seam is reached",
  termination_protocol: "parent process terminates this child after the requested notification",
};

if (process.argv.slice(2).length === 1 && process.argv[2] === "--describe") {
  process.stdout.write(`${JSON.stringify(description)}\n`);
} else {
  const args = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) values[args[index]] = args[index + 1];
  const repo = path.resolve(String(values["--repo"] ?? ""));
  const operation = values["--operation"];
  const seam = values["--seam"];
  const commandFile = path.resolve(String(values["--command-file"] ?? ""));
  if (!description.operations.includes(operation) || !description.seams.includes(seam) || !values["--repo"] || !values["--command-file"]) {
    process.stderr.write("event-store crash child requires --repo, --operation, --seam, and --command-file\n");
    process.exitCode = 2;
  } else {
    let notified = false;
    const notify = (reached) => {
      if (reached !== seam || notified) return;
      notified = true;
      fs.writeSync(1, `${JSON.stringify({ protocol_version: 1, operation, seam, pid: process.pid, repo, at_epoch_ms: Date.now() })}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    const capWrite = seam === "during-genesis-write" || seam === "during-append" || seam === "during-snapshot-write";
    let capped = false;
    const fsOps = new Proxy(fs, {
      get(target, property) {
        if (property !== "writeSync") return target[property];
        return (fd, buffer, offset, length, position) => {
          const bounded = capWrite && !capped ? Math.max(1, Math.floor(length / 2)) : length;
          capped = true;
          return target.writeSync(fd, buffer, offset, bounded, position);
        };
      },
    });
    try {
      if (operation === "recover") readEventStore(repo, { fsOps, onSeam: notify, recoverTornTail: true });
      else if (operation === "write-snapshot") {
        const snapshot = JSON.parse(fs.readFileSync(commandFile, "utf8"));
        saveTaskSnapshot(repo, snapshot, { fsOps, onSeam: notify, validateProjection: assertV3TaskProjection });
      }
      else {
        const record = JSON.parse(fs.readFileSync(commandFile, "utf8"));
        commitRecord(repo, record, { fsOps, onSeam: notify });
      }
      if (!notified) throw new Error(`requested seam was not reached: ${seam}`);
    } catch (error) {
      if (!notified) {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = 2;
      }
    }
  }
}
import fs from "node:fs";
import path from "node:path";

import { commitRecord, readEventStore } from "../../lib/event-store.mjs";
import { saveTaskSnapshot } from "../../lib/task-store.mjs";
import { assertV3TaskProjection } from "../../lib/task-engine.mjs";
