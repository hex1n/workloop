import { spawnSync } from "node:child_process";
import fs from "node:fs";

const files = [
  "tests/authority-transaction.test.mjs",
  "tests/git-main-authority.test.mjs",
  "tests/git-linked-worktree-authority.test.mjs",
  "tests/workloop-architecture.test.mjs",
  "tests/host-authority.test.mjs",
  "tests/host-hooks.test.mjs",
];
const required = [
  "lib/git-authority-provider.mjs",
  "lib/task-engine.mjs",
  ".github/workflows/test.yml",
  "tests/git-linked-worktree-authority.test.mjs",
];
if (required.some((target) => !fs.existsSync(target))) {
  process.stdout.write("WORKLOOP_CRITERION: ticket04 linked-worktree attachment lifecycle is absent\n");
  process.exit(3);
}
const result = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8", timeout: 60_000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status === null) {
  process.stderr.write(`ticket04 criterion indeterminate: ${result.error?.message ?? result.signal ?? "test process unavailable"}\n`);
  process.exit(2);
}
process.exit(result.status === 0 ? 4 : 3);
