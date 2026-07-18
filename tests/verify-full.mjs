import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const result = spawnSync(
  process.execPath,
  ["--test", "tests/taskloop.test.mjs", "tests/taskloop-architecture.test.mjs", "tests/event-store.test.mjs", "tests/task-snapshot-v3.test.mjs", "tests/runtime-v5.test.mjs", "tests/installer.test.mjs", "tests/skills.test.mjs"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
process.stdout.write(String(result.stdout ?? ""));
process.stderr.write(String(result.stderr ?? ""));
process.exit(Number.isInteger(result.status) ? result.status : 1);
