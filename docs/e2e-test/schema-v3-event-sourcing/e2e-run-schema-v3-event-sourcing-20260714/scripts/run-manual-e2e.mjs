import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(process.cwd());
const runDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const repo = path.join(runDir, "fixture", "repo");
const home = path.join(runDir, "fixture", "home");
const cli = path.join(root, "bin", "taskloop.mjs");
const env = { ...process.env, HOME: home, USERPROFILE: home, TASKLOOP_SESSION_ID: "owner-e2e" };
const results = [];

function invoke(args, input = "") {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, input, encoding: "utf8" });
  const row = { command: `node bin/taskloop.mjs ${args.join(" ")}`.trim(), status: result.status, stdout: result.stdout, stderr: result.stderr };
  results.push(row);
  return row;
}

function requireStatus(row, allowed = [0]) {
  if (!allowed.includes(row.status)) throw new Error(`${row.command}: ${row.stderr || row.stdout}`);
  return row;
}

function digest(file) {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

requireStatus(invoke(["info"]));
requireStatus(invoke(["open", "--repo", repo, "--goal", "schema-v3 manual E2E", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "the fixture checker covers terminal behavior", "--files", "work.txt", "--risk", "routine", "--risk-reason", "isolated self-owned E2E fixture"]));
const before = requireStatus(invoke(["status", "--repo", repo]));
const eventStore = path.join(repo, ".taskloop", "events-v3.jsonl");
const eventDigestBeforeRecovery = digest(eventStore);
fs.unlinkSync(path.join(repo, ".taskloop", "task.json"));
const after = requireStatus(invoke(["status", "--repo", repo]));
const eventDigestAfterRecovery = digest(eventStore);

const hookPayload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, session_id: "owner-e2e", tool_name: "Write", tool_input: { file_path: path.join(repo, "work.txt"), content: "changed\n" } });
requireStatus(invoke([], hookPayload));
requireStatus(invoke(["suspend", "--repo", repo, "--reason", "needs-input", "--remaining", "continue", "--failure", "manual pause", "--next-action", "resume"]));
requireStatus(invoke(["resume", "--repo", repo, "--reason", "continue E2E"]));
requireStatus(invoke(["review", "--repo", repo, "--level", "fresh-context", "--reviewer", "e2e-peer", "--blocking-findings", "0", "--advisory-findings", "1"]));
requireStatus(invoke(["amend", "--repo", repo, "--reason", "raise test write budget", "--writes", "5"]));
requireStatus(invoke(["abandon", "--repo", repo, "--reason", "finish first E2E task"]));
const firstAudit = requireStatus(invoke(["audit", "--repo", repo]));
requireStatus(invoke(["open", "--repo", repo, "--goal", "second task in same authority", "--criterion-file", "check.mjs", "--criterion-policy", "default", "--alignment-because", "the second task proves multi-task replay", "--files", "work.txt", "--risk", "routine", "--risk-reason", "isolated self-owned E2E fixture"]));
const secondAudit = requireStatus(invoke(["audit", "--repo", repo]));
const firstSync = requireStatus(invoke(["sync-outcomes", "--repo", repo]));
const secondSync = requireStatus(invoke(["sync-outcomes", "--repo", repo]));
const projectionPath = path.join(home, ".taskloop", "outcomes-v3.jsonl");
fs.unlinkSync(projectionPath);
const rebuildSync = requireStatus(invoke(["sync-outcomes", "--repo", repo]));
const outcomeAudit = requireStatus(invoke(["audit-outcomes"]));

const beforePayload = JSON.parse(before.stdout);
const afterPayload = JSON.parse(after.stdout);
const eventLines = fs.readFileSync(eventStore, "utf8").trim().split("\n").map(JSON.parse);
const evidence = {
  owner: "schema-v3-e2e-20260714",
  repo,
  home,
  checks: {
    snapshot_recovery_semantically_equal: isDeepStrictEqual(beforePayload, afterPayload),
    event_digest_unchanged_by_snapshot_recovery: eventDigestBeforeRecovery === eventDigestAfterRecovery,
    repo_sequences: eventLines.map((row) => row.repo_sequence),
    task_opened_sequences: eventLines.flatMap((row) => row.events).filter((event) => event.kind === "task_opened").map((event) => event.task_event_sequence),
    first_audit: JSON.parse(firstAudit.stdout),
    second_audit: JSON.parse(secondAudit.stdout),
    first_sync: JSON.parse(firstSync.stdout),
    second_sync: JSON.parse(secondSync.stdout),
    rebuild_sync: JSON.parse(rebuildSync.stdout),
    outcome_audit: JSON.parse(outcomeAudit.stdout),
  },
  results,
};
const attachments = path.join(runDir, "attachments");
fs.mkdirSync(attachments, { recursive: true });
const target = path.join(attachments, "manual-e2e-result.json");
fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
const retained = [
  { id: "event-authority", source: eventStore, target: path.join(attachments, "events-v3.jsonl") },
  { id: "task-snapshot", source: path.join(repo, ".taskloop", "task.json"), target: path.join(attachments, "task-snapshot-v3.json") },
  { id: "outcome-projection", source: projectionPath, target: path.join(attachments, "outcomes-v3.jsonl") },
];
for (const artifact of retained) fs.copyFileSync(artifact.source, artifact.target);
const manifest = {
  owner: evidence.owner,
  generated_at: new Date().toISOString(),
  artifacts: retained.map((artifact) => ({
    id: artifact.id,
    attachment: path.basename(artifact.target),
    byte_count: fs.statSync(artifact.target).size,
    sha256: digest(artifact.target),
  })),
  authority: {
    record_count: eventLines.length,
    event_count: eventLines.flatMap((row) => row.events).length,
    repo_sequences: evidence.checks.repo_sequences,
    task_ids: [...new Set(eventLines.flatMap((row) => row.events).map((event) => event.task_id))],
    record_digests: eventLines.map((row) => row.record_digest),
  },
};
fs.writeFileSync(path.join(attachments, "retained-artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ attachment: target, ...evidence.checks })}\n`);
