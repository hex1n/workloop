import { spawnSync } from "node:child_process";

const files = ["tests/authority-transaction.test.mjs", "tests/workloop-architecture.test.mjs", "tests/host-authority.test.mjs", "tests/host-hooks.test.mjs"];
const result = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8", timeout: 30_000 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status === null) {
  process.stderr.write(`ticket02 criterion indeterminate: ${result.error?.message ?? result.signal ?? "test process unavailable"}\n`);
  process.exit(2);
}
process.exit(result.status === 0 ? 4 : 3);
