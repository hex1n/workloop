#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { TRUSTED_REPOSITORY, TRUSTED_WORKFLOW_PATH } from "./spikes/multi-root-authority/receipt.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const issueRoot = path.join(root, ".scratch", "multi-root-authority", "issues");
const deterministicVerifier = path.join(root, "tests", "verify-full.mjs");
const proofFile = path.join(root, "docs", "e2e-test", "multi-root-authority-spike", "proof.json");
const receiptCli = path.join(root, "spikes", "multi-root-authority", "receipt-cli.mjs");
const failures = [];
const indeterminate = [];

function unavailable(result) {
  return Boolean(result.error || result.status === null);
}

function networkFailure(result) {
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /network|api\.github|could not resolve|name resolution|timed?\s*out|connection|ECONN|ENET|rate limit|service unavailable|502|503|504/i.test(detail);
}

for (let number = 1; number <= 13; number += 1) {
  const prefix = `${String(number).padStart(2, "0")}-`;
  let matches = [];
  try { matches = fs.readdirSync(issueRoot).filter((name) => name.startsWith(prefix) && name.endsWith(".md")); }
  catch { /* Reported as a missing ticket below. */ }
  if (matches.length !== 1) failures.push(`ticket-${prefix.slice(0, 2)}-missing-or-duplicate`);
  else {
    const ticket = fs.readFileSync(path.join(issueRoot, matches[0]), "utf8");
    const validStatus = number === 13
      ? /\*\*Status:\*\* (claimed|resolved)/.test(ticket)
      : ticket.includes("**Status:** resolved");
    if (!validStatus) failures.push(`ticket-${prefix.slice(0, 2)}-invalid-status`);
  }
}

if (!fs.existsSync(deterministicVerifier)) failures.push("deterministic-test-missing");
else {
  const result = spawnSync(process.execPath, [deterministicVerifier], { cwd: root, encoding: "utf8", timeout: 180_000 });
  if (unavailable(result)) indeterminate.push("deterministic-test-infrastructure-unavailable");
  else if (result.status !== 0) failures.push("deterministic-test-failed");
}

let proof = null;
try { proof = JSON.parse(fs.readFileSync(proofFile, "utf8")); }
catch { failures.push("attested-aggregate-proof-missing-or-malformed"); }

if (proof) {
  const structural = spawnSync(process.execPath, [receiptCli, "validate", "--proof", proofFile], { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (unavailable(structural)) indeterminate.push("aggregate-proof-validator-unavailable");
  else if (structural.status !== 0) failures.push("aggregate-proof-structure-or-source-mismatch");
  const candidateSha = String(proof.candidate_sha ?? "");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const currentSha = head.status === 0 ? head.stdout.trim() : null;
  if (proof.repository !== TRUSTED_REPOSITORY || candidateSha.length !== 40 || /[^0-9a-f]/.test(candidateSha) || candidateSha !== currentSha) failures.push("aggregate-proof-identity-invalid");
  else {
    const attestation = spawnSync("gh", [
      "attestation", "verify", proofFile,
      "--repo", TRUSTED_REPOSITORY,
      "--signer-workflow", `${TRUSTED_REPOSITORY}/${TRUSTED_WORKFLOW_PATH}`,
      "--source-digest", candidateSha,
      "--deny-self-hosted-runners",
      "--format", "json",
    ], { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (unavailable(attestation) || networkFailure(attestation)) indeterminate.push("aggregate-proof-attestation-infrastructure-unavailable");
    else if (attestation.status !== 0) failures.push("aggregate-proof-attestation-unverified");
    else {
      try {
        const verified = JSON.parse(attestation.stdout);
        if (!Array.isArray(verified) || verified.length < 1) failures.push("aggregate-proof-attestation-empty");
      } catch { failures.push("aggregate-proof-attestation-malformed"); }
    }
  }
}

if (failures.length) {
  process.stdout.write(`WORKLOOP_CRITERION: multi-root authority gate incomplete: ${[...new Set(failures)].sort().join(", ")}\n`);
  process.exit(3);
}

if (indeterminate.length) {
  process.stdout.write(`WORKLOOP_CRITERION: multi-root authority gate indeterminate: ${[...new Set(indeterminate)].sort().join(", ")}\n`);
  process.exit(2);
}

process.stdout.write("WORKLOOP_CRITERION: provider authority release gate and attested eight-cell proof passed\n");
process.exit(4);
