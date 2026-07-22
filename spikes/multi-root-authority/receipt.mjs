import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, sha256Hex } from "../../lib/prims.mjs";

const TRUSTED_REPOSITORY = "hex1n/workloop";
const TRUSTED_WORKFLOW_PATH = ".github/workflows/multi-root-authority-spike.yml";

const REQUIRED_CELLS = Object.freeze([
  ["linux", "22"],
  ["linux", "24"],
  ["macos", "22"],
  ["macos", "24"],
  ["windows-2022", "22"],
  ["windows-2022", "24"],
  ["windows-2025", "22"],
  ["windows-2025", "24"],
]);

const SOURCE_PATHS = Object.freeze([
  TRUSTED_WORKFLOW_PATH,
  "acceptance-multi-root-authority-gate.mjs",
  "spikes/multi-root-authority/adapter.mjs",
  "spikes/multi-root-authority/hook-cli.mjs",
  "spikes/multi-root-authority/receipt-cli.mjs",
  "spikes/multi-root-authority/receipt.mjs",
  "spikes/multi-root-authority/worker.mjs",
  "tests/multi-root-authority-adapter.test.mjs",
  "tests/multi-root-authority-receipt.test.mjs",
  "lib/host-hooks.mjs",
  "lib/prims.mjs",
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function runGit(root, args, code, encoding) {
  const result = spawnSync("git", args, { cwd: root, encoding });
  if (result.error) fail(code, result.error.message);
  if (result.status !== 0) {
    const stderr = result.stderr == null ? "" : String(result.stderr).trim();
    fail(code, stderr || "git exited with status " + String(result.status));
  }
  return result.stdout;
}

function gitText(root, args, code) {
  return String(runGit(root, args, code, "utf8")).trim();
}

function gitBytes(root, args, code) {
  return runGit(root, args, code);
}

function gitHead(root) {
  return gitText(root, ["rev-parse", "--verify", "HEAD"], "GIT_HEAD_UNAVAILABLE");
}

function sourceManifest(root, sourcePaths = SOURCE_PATHS) {
  const entries = sourcePaths.map((relative) => {
    const bytes = gitBytes(root, ["cat-file", "blob", "HEAD:" + relative], "SOURCE_OBJECT_UNAVAILABLE");
    return { path: relative, sha256: sha256Hex(bytes), size: bytes.length };
  });
  return { entries, manifest_digest: sha256Hex(canonicalJson(entries)) };
}

function assertPortableSourceAttributes(root, relative) {
  const output = String(runGit(root, ["check-attr", "-z", "filter", "ident", "working-tree-encoding", "--", relative], "SOURCE_ATTRIBUTE_UNAVAILABLE", "utf8"));
  const fields = output.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (value !== "unspecified" && value !== "unset") fail("UNSUPPORTED_SOURCE_ATTRIBUTE", relative + " uses unsupported " + attribute + "=" + value);
  }
}

function assertSourceWorktreeMatchesHead(root, sourcePaths = SOURCE_PATHS) {
  for (const relative of sourcePaths) {
    assertPortableSourceAttributes(root, relative);
    const committed = gitText(root, ["rev-parse", "HEAD:" + relative], "SOURCE_OBJECT_UNAVAILABLE");
    const working = gitText(root, ["hash-object", "--path=" + relative, "--", relative], "SOURCE_WORKTREE_UNAVAILABLE");
    if (working !== committed) fail("SOURCE_WORKTREE_MISMATCH", relative + " differs from the checked-out commit");
  }
}

function normalizedPlatform(label) {
  return ({ "ubuntu-latest": "linux", "macos-latest": "macos", "windows-2022": "windows-2022", "windows-2025": "windows-2025" })[label] ?? null;
}

function cellContext(platform) {
  if (platform === "linux") return { job: "spike", runner_label: "ubuntu-latest" };
  if (platform === "macos") return { job: "spike", runner_label: "macos-latest" };
  if (platform === "windows-2022" || platform === "windows-2025") return { job: "spike", runner_label: platform };
  fail("UNSUPPORTED_CELL", "unsupported platform " + platform);
}

function buildReceipt(root, env = process.env) {
  const platform = normalizedPlatform(env.WORKLOOP_SPIKE_PLATFORM);
  const nodeMajor = process.versions.node.split(".")[0];
  if (!platform || !REQUIRED_CELLS.some(([expectedPlatform, expectedNode]) => expectedPlatform === platform && expectedNode === nodeMajor)) fail("UNSUPPORTED_CELL", `unsupported cell ${env.WORKLOOP_SPIKE_PLATFORM}/Node ${nodeMajor}`);
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "")) fail("INVALID_GITHUB_SHA", "GITHUB_SHA must be a full commit SHA");
  if (gitHead(root) !== env.GITHUB_SHA) fail("CHECKOUT_SHA_MISMATCH", "checked-out HEAD does not equal GITHUB_SHA");
  for (const key of ["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_REF", "GITHUB_JOB"]) {
    if (!String(env[key] ?? "").trim()) fail("MISSING_GITHUB_CONTEXT", `${key} is required`);
  }
  if (env.GITHUB_REPOSITORY !== TRUSTED_REPOSITORY) fail("UNTRUSTED_REPOSITORY", "receipt repository is not the canonical repository");
  if (!env.GITHUB_WORKFLOW_REF.startsWith(TRUSTED_REPOSITORY + "/" + TRUSTED_WORKFLOW_PATH + "@")) fail("UNTRUSTED_WORKFLOW", "receipt workflow is not canonical");
  assertSourceWorktreeMatchesHead(root);
  const manifest = sourceManifest(root);
  return {
    receipt_schema_version: 1,
    status: "passed",
    repository: env.GITHUB_REPOSITORY,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    workflow_ref: env.GITHUB_WORKFLOW_REF,
    job: env.GITHUB_JOB,
    commit_sha: env.GITHUB_SHA,
    platform,
    runner_label: env.WORKLOOP_SPIKE_PLATFORM,
    node: process.version,
    node_major: nodeMajor,
    source_manifest_digest: manifest.manifest_digest,
  };
}

function receiptFileName(receipt) {
  return `receipt-${receipt.platform}-node-${receipt.node_major}.json`;
}

function writeReceipt(root, outputDirectory, env = process.env) {
  const receipt = buildReceipt(root, env);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const target = path.join(outputDirectory, receiptFileName(receipt));
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, target };
}

function validateReceipt(receipt, expected, manifestDigest) {
  const fields = ["receipt_schema_version", "status", "repository", "run_id", "run_attempt", "workflow_ref", "job", "commit_sha", "platform", "runner_label", "node", "node_major", "source_manifest_digest"];
  if (!exactKeys(receipt, fields)) fail("INVALID_RECEIPT", "receipt shape mismatch");
  for (const [key, value] of Object.entries(expected)) if (receipt[key] !== value) fail("INVALID_RECEIPT", `${key} mismatch for ${receipt.platform}/Node ${receipt.node_major}`);
  if (receipt.receipt_schema_version !== 1 || receipt.status !== "passed" || receipt.source_manifest_digest !== manifestDigest) fail("INVALID_RECEIPT", `invalid receipt claim for ${receipt.platform}/Node ${receipt.node_major}`);
  if (receipt.node !== `v${receipt.node_major}` && !receipt.node.startsWith(`v${receipt.node_major}.`)) fail("INVALID_RECEIPT", "Node version does not match node_major");
}

function aggregateReceipts(root, inputDirectory, env = process.env) {
  if (env.GITHUB_REPOSITORY !== TRUSTED_REPOSITORY) fail("UNTRUSTED_REPOSITORY", "aggregate repository is not canonical");
  if (!String(env.GITHUB_WORKFLOW_REF).startsWith(TRUSTED_REPOSITORY + "/" + TRUSTED_WORKFLOW_PATH + "@")) fail("UNTRUSTED_WORKFLOW", "aggregate workflow is not canonical");
  const expectedFiles = REQUIRED_CELLS.map(([platform, node]) => `receipt-${platform}-node-${node}.json`).sort();
  const actualFiles = fs.readdirSync(inputDirectory).filter((name) => name.endsWith(".json")).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) fail("RECEIPT_SET_MISMATCH", `expected ${expectedFiles.join(", ")}; got ${actualFiles.join(", ")}`);
  if (gitHead(root) !== env.GITHUB_SHA) fail("CHECKOUT_SHA_MISMATCH", "aggregate checkout does not equal GITHUB_SHA");
  assertSourceWorktreeMatchesHead(root);
  const manifest = sourceManifest(root);
  const cells = [];
  for (const [platform, nodeMajor] of REQUIRED_CELLS) {
    const receipt = JSON.parse(fs.readFileSync(path.join(inputDirectory, `receipt-${platform}-node-${nodeMajor}.json`), "utf8"));
    const context = cellContext(platform);
    validateReceipt(receipt, {
      repository: env.GITHUB_REPOSITORY,
      job: context.job,
      runner_label: context.runner_label,
      run_id: env.GITHUB_RUN_ID,
      run_attempt: env.GITHUB_RUN_ATTEMPT,
      workflow_ref: env.GITHUB_WORKFLOW_REF,
      commit_sha: env.GITHUB_SHA,
      platform,
      node_major: nodeMajor,
    }, manifest.manifest_digest);
    cells.push(receipt);
  }
  const preimage = {
    proof_schema_version: 1,
    status: "passed",
    repository: env.GITHUB_REPOSITORY,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    workflow_ref: env.GITHUB_WORKFLOW_REF,
    candidate_sha: env.GITHUB_SHA,
    source_manifest: manifest,
    cells,
  };
  return { ...preimage, proof_digest: sha256Hex(canonicalJson(preimage)) };
}

function validateAggregateProof(root, proof) {
  if (!exactKeys(proof, ["proof_schema_version", "status", "repository", "run_id", "run_attempt", "workflow_ref", "candidate_sha", "source_manifest", "cells", "proof_digest"])) fail("INVALID_PROOF", "proof shape mismatch");
  const preimage = { ...proof };
  delete preimage.proof_digest;
  if (proof.proof_digest !== sha256Hex(canonicalJson(preimage))) fail("INVALID_PROOF", "proof digest mismatch");
  if (proof.repository !== TRUSTED_REPOSITORY || !String(proof.workflow_ref).startsWith(TRUSTED_REPOSITORY + "/" + TRUSTED_WORKFLOW_PATH + "@")) fail("UNTRUSTED_PROOF", "proof repository or workflow is not canonical");
  if (proof.proof_schema_version !== 1 || proof.status !== "passed" || !/^[0-9a-f]{40}$/.test(proof.candidate_sha)) fail("INVALID_PROOF", "invalid proof header");
  if (gitHead(root) !== proof.candidate_sha) fail("CHECKOUT_SHA_MISMATCH", "current HEAD does not equal the attested candidate SHA");
  assertSourceWorktreeMatchesHead(root);
  const manifest = sourceManifest(root);
  if (canonicalJson(proof.source_manifest) !== canonicalJson(manifest)) fail("SOURCE_MANIFEST_MISMATCH", "current spike sources differ from attested candidate");
  if (!Array.isArray(proof.cells) || proof.cells.length !== REQUIRED_CELLS.length) fail("INVALID_PROOF", "proof must contain eight cells");
  for (const [platform, nodeMajor] of REQUIRED_CELLS) {
    const matches = proof.cells.filter((cell) => cell.platform === platform && cell.node_major === nodeMajor);
    if (matches.length !== 1) fail("INVALID_PROOF", `missing or duplicate ${platform}/Node ${nodeMajor}`);
    const context = cellContext(platform);
    validateReceipt(matches[0], {
      repository: proof.repository,
      job: context.job,
      runner_label: context.runner_label,
      run_id: proof.run_id,
      run_attempt: proof.run_attempt,
      workflow_ref: proof.workflow_ref,
      commit_sha: proof.candidate_sha,
      platform,
      node_major: nodeMajor,
    }, manifest.manifest_digest);
  }
  return proof;
}

export {
  TRUSTED_REPOSITORY,
  TRUSTED_WORKFLOW_PATH,
  REQUIRED_CELLS,
  SOURCE_PATHS,
  aggregateReceipts,
  assertSourceWorktreeMatchesHead,
  buildReceipt,
  receiptFileName,
  sourceManifest,
  validateAggregateProof,
  writeReceipt,
};
