import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runId = process.env.WORKLOOP_E2E_RUN_ID;
if (!runId) throw new Error("WORKLOOP_E2E_RUN_ID is required; choose a fresh YYYYMMDDTHHMMSS value");
if (!/^\d{8}T\d{6}$/.test(runId)) throw new Error("WORKLOOP_E2E_RUN_ID must use YYYYMMDDTHHMMSS");
const root = path.join(os.tmpdir(), `workloop-stop-hook-liveness-${runId}`);
const sentinelRoot = path.join(root, "sentinels");
const workloop = path.join(os.homedir(), "bin", "workloop.mjs");

if (fs.existsSync(root)) throw new Error(`run root already exists; preserve it as evidence and choose a fresh WORKLOOP_E2E_RUN_ID: ${runId}`);
fs.mkdirSync(sentinelRoot, { recursive: true });

function run(file, args, cwd) {
  return execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitCriterion(sentinel, waitMs, resultExpression = "1") {
  return [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(sentinel)}, "started\\n");`,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${waitMs});`,
    `process.exit(${resultExpression});`,
    "",
  ].join("\n");
}

function prepareFixture({
  name,
  timeout,
  criterion = "check.mjs",
  waitMs = null,
  proof = false,
  profile,
  recordUnsatisfiedWitness = false,
}) {
  const repo = path.join(root, name);
  const sentinel = path.join(sentinelRoot, `${name}.started`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(
    path.join(repo, "check.mjs"),
    'import fs from "node:fs";\nprocess.exit(fs.existsSync("done") ? 0 : 1);\n',
  );
  fs.writeFileSync(path.join(repo, "ignored.txt"), "before\n");
  if (waitMs !== null) {
    const resultExpression = proof ? 'fs.existsSync("done") ? 0 : 1' : "1";
    fs.writeFileSync(path.join(repo, criterion), waitCriterion(sentinel, waitMs, resultExpression));
  }

  run("git", ["init", "-b", "main"], repo);
  run("git", ["config", "user.name", "Workloop E2E"], repo);
  run("git", ["config", "user.email", "workloop-e2e@example.invalid"], repo);
  run("git", ["add", ".gitignore", "check.mjs"], repo);
  run("git", ["add", "-f", "ignored.txt"], repo);
  if (waitMs !== null) run("git", ["add", criterion], repo);
  run("git", ["commit", "-m", "Initialize isolated Stop liveness fixture"], repo);

  run(
    "node",
    [
      workloop,
      "open",
      "--repo",
      ".",
      "--goal",
      "stop liveness probe",
      "--criterion-file",
      "check.mjs",
      "--criterion-policy",
      "default",
      "--criterion-timeout-seconds",
      String(timeout),
      "--alignment-because",
      "the checker exercises the live Stop path",
      "--not-covered",
      "host transport outside this fixture",
      "--files",
      "done",
      "--files",
      "ignored.txt",
      "--risk",
      "routine",
      "--risk-reason",
      "isolated reversible Host fixture",
      "--review-policy",
      "risk-based",
      "--reason",
      "prepare isolated live Host fixture",
    ],
    repo,
  );
  if (criterion !== "check.mjs") {
    run(
      "node",
      [
        workloop,
        "amend",
        "--repo",
        ".",
        "--criterion-file",
        criterion,
        "--reason",
        "live Host liveness characterization",
      ],
      repo,
    );
  }
  if (recordUnsatisfiedWitness) {
    try {
      run("node", [workloop, "verify", "--record", "--repo", "."], repo);
    } catch (error) {
      if (error.status !== 1 || !/\"verdict\":\"unsatisfied\"/.test(error.stdout ?? "")) throw error;
    }
    fs.rmSync(sentinel);
  }
  run(
    "node",
    [workloop, "hooks", "--profile", profile, "--mode", "nudge", "--action", "record-install", "--repo", "."],
    repo,
  );
  return { name, repo, sentinel, profile, timeout, criterion };
}

const fixtures = [
  prepareFixture({ name: "codex-cli", timeout: 900, criterion: "long-60.mjs", waitMs: 60_000, profile: "codex-safe" }),
  prepareFixture({ name: "codex-app", timeout: 900, criterion: "long-60.mjs", waitMs: 60_000, profile: "codex-safe" }),
  prepareFixture({ name: "claude-short", timeout: 5, profile: "claude" }),
  prepareFixture({ name: "claude-over-budget", timeout: 31, criterion: "long-60.mjs", waitMs: 60_000, profile: "claude" }),
  prepareFixture({ name: "claude-in-progress", timeout: 30, criterion: "slow-25.mjs", waitMs: 25_000, profile: "claude" }),
  prepareFixture({ name: "claude-stale", timeout: 5, criterion: "slow-5.mjs", waitMs: 5_000, profile: "claude" }),
  prepareFixture({ name: "explicit-proof", timeout: 900, criterion: "proof-5.mjs", waitMs: 5_000, proof: true, profile: "codex-safe" }),
  prepareFixture({
    name: "explicit-proof-terminal",
    timeout: 900,
    criterion: "proof-5.mjs",
    waitMs: 5_000,
    proof: true,
    profile: "codex-safe",
    recordUnsatisfiedWitness: true,
  }),
];

const manifest = { run_id: runId, root, fixtures };
fs.writeFileSync(path.join(root, "fixture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${path.join(root, "fixture-manifest.json")}\n`);
