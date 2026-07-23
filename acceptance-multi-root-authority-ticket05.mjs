import { spawnSync } from "node:child_process";
import fs from "node:fs";

const files = [
  "tests/authority-transaction.test.mjs",
  "tests/git-main-authority.test.mjs",
  "tests/git-linked-worktree-authority.test.mjs",
  "tests/git-partitioned-multitask-authority.test.mjs",
  "tests/workloop-architecture.test.mjs",
  "tests/host-authority.test.mjs",
  "tests/host-hooks.test.mjs",
];
const required = [
  "lib/git-authority-provider.mjs",
  "lib/task-engine.mjs",
  ".github/workflows/test.yml",
  "tests/git-partitioned-multitask-authority.test.mjs",
];
if (required.some((target) => !fs.existsSync(target))) {
  process.stdout.write("WORKLOOP_CRITERION: ticket05 partitioned multi-task routing is absent\n");
  process.exit(3);
}
const result = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8", timeout: 75_000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status === null) {
  process.stderr.write(`ticket05 criterion unavailable: ${result.error?.message ?? result.signal ?? "test process unavailable"}\n`);
  process.stdout.write("WORKLOOP_CRITERION: ticket05 partitioned multi-task routing is indeterminate\n");
  process.exit(2);
}
const satisfied = result.status === 0;
process.stdout.write(`WORKLOOP_CRITERION: ticket05 partitioned multi-task routing is ${satisfied ? "satisfied" : "unsatisfied"}\n`);
process.exit(satisfied ? 4 : 3);
