import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const runDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const attachments = path.join(runDir, "attachments");
fs.mkdirSync(attachments, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const baselineHead = run("git", ["rev-parse", "HEAD"]);
const branch = run("git", ["branch", "--show-current"]);
const changed = run("git", ["diff", "--name-status", "--no-renames", "HEAD"])
  .split("\n").filter(Boolean).map((line) => {
    const [status, ...parts] = line.split("\t");
    return { status: status === "D" ? "deleted" : "tracked-change", path: parts.join("\t") };
  });
const untracked = run("git", ["ls-files", "--others", "--exclude-standard"])
  .split("\n").filter(Boolean).map((file) => ({ status: "untracked", path: file }));

const excludedPrefixes = [
  "output/",
  "tmp/",
  "docs/e2e-test/schema-v3-event-sourcing/e2e-run-schema-v3-event-sourcing-20260714/fixture/",
  "docs/e2e-test/schema-v3-event-sourcing/e2e-rerun-release-gates-20260714/attachments/",
];
const self = path.relative(root, path.join(attachments, "release-candidate-manifest.json")).split(path.sep).join("/");
const entries = [...changed, ...untracked]
  .filter((entry) => entry.path !== self && !excludedPrefixes.some((prefix) => entry.path.startsWith(prefix)))
  .sort((left, right) => left.path.localeCompare(right.path))
  .map((entry) => {
    if (entry.status === "deleted") return { ...entry, byte_count: 0, sha256: null };
    const bytes = fs.readFileSync(path.join(root, entry.path));
    return { ...entry, byte_count: bytes.length, sha256: sha256(bytes) };
  });

const candidatePreimage = { baseline_head: baselineHead, branch, excluded_prefixes: excludedPrefixes, entries };
const manifest = {
  schema_version: 1,
  purpose: "pre-commit release-candidate fingerprint; not a Git commit or Oracle-13 receipt",
  generated_at: new Date().toISOString(),
  ...candidatePreimage,
  entry_count: entries.length,
  candidate_digest: sha256(Buffer.from(JSON.stringify(candidatePreimage), "utf8")),
  self_excluded: path.relative(root, path.join(attachments, "release-candidate-manifest.json")).split(path.sep).join("/"),
};
fs.writeFileSync(path.join(attachments, "release-candidate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const workflowRuns = JSON.parse(run("gh", [
  "run", "list", "--limit", "10", "--json",
  "databaseId,headSha,headBranch,status,conclusion,workflowName,createdAt,url",
]));
const remoteWorkflow = `${run("gh", ["workflow", "view", "test", "--yaml"])}\n`;
const remoteWorkflowAttachment = path.join(attachments, "remote-workflow-baseline.yml");
fs.writeFileSync(remoteWorkflowAttachment, remoteWorkflow);
const remote = {
  queried_at: new Date().toISOString(),
  repository: JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner,url"])),
  baseline_head: baselineHead,
  candidate_digest: manifest.candidate_digest,
  exact_candidate_run_exists: false,
  reason: "the candidate is an uncommitted working tree and therefore has no Git head SHA",
  remote_workflow_attachment: path.basename(remoteWorkflowAttachment),
  remote_workflow_sha256: sha256(Buffer.from(remoteWorkflow, "utf8")),
  recent_runs: workflowRuns,
};
fs.writeFileSync(path.join(attachments, "github-run-preflight.json"), `${JSON.stringify(remote, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ manifest: path.join(attachments, "release-candidate-manifest.json"), entry_count: entries.length, candidate_digest: manifest.candidate_digest, exact_candidate_run_exists: false })}\n`);
