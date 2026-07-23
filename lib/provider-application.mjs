// Provider-only Workloop application assembly.
//
// This is the sole executable runtime Contract.  It never imports the retired
// repository-task event runtime and exposes no compatibility command aliases.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { sha256Hex } from "./prims.mjs";
import { resolveCriterionFile, runCriterionSource } from "./criterion.mjs";
import { evolveAllCurrentAuthority } from "./task-engine.mjs";
import { createLockManager, runAuthorityTransaction } from "./authority-transaction.mjs";
import { publishAuthorityOutcome } from "./authority-outcome-projection.mjs";
import { analyzeToolCall, writeFileTargets } from "./supervision.mjs";
import { EXPLICIT_PROFILES, buildHookRecipe, decodeHook, encodeHook } from "./host-hooks.mjs";
import { commitCurrentGitTask, certifyCurrentGitTask, forkCurrentGitIdentity, mutateCurrentGitTask, openCurrentGitTask, prepareCurrentGitCertification, queryCurrentGit, recordCurrentGitHook, recoverCurrentGitAttachment, resolveGitAuthorityTarget, stageCurrentGitTask } from "./git-authority-provider.mjs";
import { abandonStagedFilesystemAuthority, certifyCurrentFilesystemTask, forkCurrentFilesystemIdentity, mutateCurrentFilesystemTask, openCurrentFilesystemTask, prepareCurrentFilesystemCertification, queryCurrentFilesystem, queryCurrentFilesystemAuthority, recordCurrentFilesystemHook, recoverCurrentFilesystemAttachment, resolveFilesystemAuthorityTarget } from "./filesystem-authority-provider.mjs";

const OPTION = { type: "string" };
const OPTIONS = Object.freeze({
  open: { target: OPTION, "filesystem-root": OPTION, placement: OPTION, "worktree-path": OPTION, branch: OPTION, base: OPTION, goal: OPTION, "write-path": { type: "string", multiple: true }, "write-root": { type: "string", multiple: true }, "command-id": OPTION, reason: OPTION, "granted-by": OPTION },
  stage: { target: OPTION, "task-id": OPTION, "command-id": OPTION, reason: OPTION, "granted-by": OPTION },
  commit: { target: OPTION, "task-id": OPTION, message: OPTION, "command-id": OPTION, reason: OPTION, "granted-by": OPTION },
  certify: { target: OPTION, authority: OPTION, "task-id": OPTION, "criterion-file": OPTION, "criterion-timeout-seconds": OPTION, "command-id": OPTION, reason: OPTION, "granted-by": OPTION },
  status: { target: OPTION, authority: OPTION, "task-id": OPTION }, audit: { target: OPTION, authority: OPTION, "task-id": OPTION }, ledger: { target: OPTION, authority: OPTION }, tasks: { target: OPTION, authority: OPTION },
  join: { target: OPTION, authority: OPTION, "task-id": OPTION, "command-id": OPTION, reason: OPTION, "granted-by": OPTION }, suspend: { target: OPTION, authority: OPTION, "task-id": OPTION, "command-id": OPTION, reason: OPTION, "granted-by": OPTION }, resume: { target: OPTION, authority: OPTION, "task-id": OPTION, "command-id": OPTION, reason: OPTION, "granted-by": OPTION }, abandon: { target: OPTION, authority: OPTION, "task-id": OPTION, "command-id": OPTION, reason: OPTION, "granted-by": OPTION },
  "recover-attachment": { target: OPTION, authority: OPTION, attachment: OPTION, "command-id": OPTION, "expect-epoch": OPTION, "expect-locator-digest": OPTION, "expect-pending-digest": OPTION, reason: OPTION, "granted-by": OPTION },
  "cleanup-staged-locator": { target: OPTION, authority: OPTION, attachment: OPTION, "command-id": OPTION, "expect-locator-digest": OPTION, reason: OPTION, "granted-by": OPTION },
  reattach: { target: OPTION, authority: OPTION, attachment: OPTION, "command-id": OPTION, "expect-epoch": OPTION, "expect-locator-digest": OPTION, reason: OPTION, "granted-by": OPTION },
  "abandon-staged-authority": { authority: OPTION, "command-id": OPTION, "expect-genesis-digest": OPTION, reason: OPTION, "granted-by": OPTION },
  "fork-identity": { target: OPTION, attachment: OPTION, "command-id": OPTION, "expect-epoch": OPTION, "expect-locator-digest": OPTION, reason: OPTION, "granted-by": OPTION },
  "archive-incompatible-state": { target: OPTION, reason: OPTION, "granted-by": OPTION },
  hook: { profile: OPTION, mode: OPTION }, hooks: { profile: OPTION, mode: OPTION, command: OPTION },
});
const RUNTIME = Object.freeze({ createLockManager, runAuthorityTransaction, evolveAllCurrentAuthority });
const identity = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const error = (message) => { process.stderr.write(`workloop: ${message}\n`); return 2; };
const sessionId = () => identity(process.env.WORKLOOP_SESSION_ID) ?? identity(process.env.CLAUDE_CODE_SESSION_ID) ?? "cli";
function print(value) { process.stdout.write(`${JSON.stringify(publish(value), null, 2)}\n`); return 0; }
function publish(value, { silent = false } = {}) {
  if (!value?.authority_id || !new Set(["git_common", "filesystem_detached"]).has(value.provider) || (!Array.isArray(value.repository_tasks) && !Array.isArray(value.filesystem_tasks))) return value;
  try { const outcome = publishAuthorityOutcome(value, RUNTIME); return { ...value, outcome_path: outcome.outcome_path, outcome_cursor_path: outcome.cursor_path, outcome_source_sequence: outcome.source_sequence }; }
  catch (cause) { return silent ? value : { ...value, warnings: [...(value.warnings ?? []), `outcome projection deferred: ${cause.message}`] }; }
}
function isFilesystem(target) { try { resolveFilesystemAuthorityTarget(target); return true; } catch (cause) { if (cause?.code === "FILESYSTEM_AUTHORITY_REQUIRED") return false; throw cause; } }
function input(values, action = null) { return { action, target: identity(values.target), authorityId: identity(values.authority), taskId: values["task-id"], commandId: values["command-id"], sessionId: sessionId(), grantedBy: values["granted-by"], reason: values.reason }; }
function cmdOpen(values) { const command = { target: identity(values.target), filesystemRoot: values["filesystem-root"], placement: values.placement, worktreePath: values["worktree-path"], branch: values.branch, base: values.base, goal: values.goal, writePaths: values["write-path"] ?? [], writeRoots: values["write-root"] ?? [], commandId: values["command-id"], sessionId: sessionId(), grantedBy: values["granted-by"], reason: values.reason }; return print(values["filesystem-root"] ? openCurrentFilesystemTask(command, RUNTIME) : openCurrentGitTask(command, RUNTIME)); }
function cmdReceipt(values, action) { const target = identity(values.target); if (!target) return error(`${action} requires --target`); if (isFilesystem(target)) return error(`${action} is unavailable for detached filesystem authorities`); const command = { target, taskId: values["task-id"], message: values.message, commandId: values["command-id"], sessionId: sessionId(), grantedBy: values["granted-by"], reason: values.reason }; return print(action === "stage" ? stageCurrentGitTask(command, RUNTIME) : commitCurrentGitTask(command, RUNTIME)); }
function cmdCertify(values) { const command = input(values); if (!command.target && !command.authorityId) return error("certify requires --target or --authority"); if (command.target && command.authorityId) return error("certify accepts exactly one selector"); const filesystem = command.authorityId || isFilesystem(command.target); const prepared = filesystem ? prepareCurrentFilesystemCertification(command, RUNTIME) : prepareCurrentGitCertification(command, RUNTIME); const observation = runCriterionSource({ kind: "file", value: resolveCriterionFile(prepared.criterion_root, values["criterion-file"]) }, prepared.criterion_root, Number(values["criterion-timeout-seconds"] ?? 120), "tri-state"); if (observation.verdict !== "satisfied") return error(`certify criterion ${observation.verdict}: ${observation.execution.output_tail ?? "no criterion receipt"}`); const digest = sha256Hex(JSON.stringify({ verdict: observation.verdict, execution: observation.execution, changed_paths: observation.changed_paths })); return print(filesystem ? certifyCurrentFilesystemTask(command, prepared, digest, RUNTIME) : certifyCurrentGitTask(command, prepared, digest, RUNTIME)); }
function cmdQuery(values, kind) { const command = input(values); if (!command.target && !command.authorityId) return error(`${kind} requires --target or --authority`); if (command.target && command.authorityId) return error(`${kind} accepts exactly one selector`); const selection = { taskId: values["task-id"] ?? null, sessionId: sessionId() === "cli" ? null : sessionId() }; if (command.authorityId) return print(queryCurrentFilesystemAuthority(command.authorityId, kind, RUNTIME, selection)); return print(isFilesystem(command.target) ? queryCurrentFilesystem(command.target, kind, RUNTIME, selection) : queryCurrentGit(command.target, kind, RUNTIME, selection)); }
function cmdMutation(values, action) { const command = input(values, action); if (!command.target && !command.authorityId) return error(`${action} requires --target or --authority`); if (command.authorityId) return print(mutateCurrentFilesystemTask(command, RUNTIME)); return print(isFilesystem(command.target) ? mutateCurrentFilesystemTask(command, RUNTIME) : mutateCurrentGitTask(command, RUNTIME)); }
function cmdRecovery(values, action) { const command = { action, target: values.target, authorityId: values.authority, attachmentId: values.attachment, commandId: values["command-id"], expectedEpoch: values["expect-epoch"], expectedLocatorDigest: values["expect-locator-digest"], expectedPendingDigest: values["expect-pending-digest"], grantedBy: values["granted-by"], reason: values.reason }; return print(command.authorityId || isFilesystem(command.target) ? recoverCurrentFilesystemAttachment(command, RUNTIME) : recoverCurrentGitAttachment(command, RUNTIME)); }
function cmdFork(values) { const command = { target: values.target, attachmentId: values.attachment, commandId: values["command-id"], expectedEpoch: values["expect-epoch"], expectedLocatorDigest: values["expect-locator-digest"], grantedBy: values["granted-by"], reason: values.reason }; return print(isFilesystem(command.target) ? forkCurrentFilesystemIdentity(command, RUNTIME) : forkCurrentGitIdentity(command, RUNTIME)); }
function payload() { try { return JSON.parse(fs.readFileSync(0, "utf8")); } catch { return {}; } }
function emit(invocation, disposition) { const encoded = encodeHook({ invocation, disposition }); if (encoded.stdout) process.stdout.write(encoded.stdout); if (encoded.stderr) process.stderr.write(encoded.stderr); return encoded.exitCode; }
function cmdHook(values) { const mode = values.mode ?? "nudge"; if (!new Set(["observe", "nudge", "deny"]).has(mode)) return error("--mode must be observe, nudge, or deny"); if (!EXPLICIT_PROFILES.includes(values.profile)) { if (mode === "deny") return error(`unsupported hook profile; expected ${EXPLICIT_PROFILES.join("|")}`); return 0; } const invocation = { ...decodeHook({ profile: values.profile, payload: payload() }), mode }; const disposition = invocation.event === "pre_tool_use" ? { event: invocation.event, action: "pass" } : new Set(["post_tool_use", "post_tool_use_failure"]).has(invocation.event) ? { event: invocation.event, action: "record" } : { event: "stop", action: "release" }; if (invocation.event === "stop" || invocation.event === "unknown") return emit(invocation, disposition); const targets = [...new Set(writeFileTargets(invocation.toolName, invocation.toolInput, analyzeToolCall(invocation.toolName, invocation.toolInput)).map((target) => path.resolve(invocation.repo, target)))]; const failures = []; if (!targets.length) failures.push("TARGET_ROUTING_UNAVAILABLE"); for (const target of targets) { try { publish(isFilesystem(target) ? recordCurrentFilesystemHook({ target, invocation }, RUNTIME) : recordCurrentGitHook({ target, invocation }, RUNTIME), { silent: true }); } catch (cause) { failures.push(String(cause?.code ?? cause?.message ?? cause).split("\n")[0]); } } if (failures.length) { if (mode === "deny" && invocation.event === "pre_tool_use") return emit(invocation, { event: invocation.event, action: "deny", reason: `provider evidence unavailable (${failures.join("; ")})` }); process.stderr.write(`workloop: provider evidence unavailable; host retains execution authority: ${failures.join("; ")}\n`); } return emit(invocation, disposition); }
function fileDigest(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function fsync(file) { if (process.platform === "win32") return; const descriptor = fs.openSync(file, "r"); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
function cmdArchive(values) {
  if (values["granted-by"] !== "user" || !identity(values.reason)) return error("archive-incompatible-state requires --granted-by user and --reason");
  let root; try { root = resolveGitAuthorityTarget(values.target).worktree_root; } catch { root = path.resolve(values.target); }
  const source = path.join(root, ".workloop");
  const files = ["events.jsonl", "events-v3.jsonl", "task.json", "outcomes-v3.jsonl"].map((name) => path.join(source, name)).filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!files.length) return error("no incompatible repository artifacts found; no bytes were changed");
  const archive = path.join(root, ".workloop-incompatible-archive", `${Date.now()}-${process.pid}`);
  const artifacts = [];
  try {
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const destination = path.join(archive, path.basename(file));
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.copyFileSync(file, temporary, fs.constants.COPYFILE_EXCL);
      const digest = fileDigest(file);
      if (digest !== fileDigest(temporary)) throw new Error(`opaque archive digest mismatch for ${path.basename(file)}`);
      fsync(temporary);
      fs.renameSync(temporary, destination);
      artifacts.push({ name: path.basename(file), sha256: digest, bytes: fs.statSync(file).size });
    }
    fsync(archive);
  } catch (cause) { return error(`incompatible archive failed before publication: ${cause.message}`); }
  process.stdout.write(`${JSON.stringify({ archived: true, archive_path: archive, granted_by: "user", reason: values.reason, artifacts }, null, 2)}\n`);
  return 0;
}
function cmdHooks(values) { if (!EXPLICIT_PROFILES.includes(values.profile)) return error(`unsupported hooks profile; expected ${EXPLICIT_PROFILES.join("|")}`); process.stdout.write(`${JSON.stringify(buildHookRecipe({ profile: values.profile, command: values.command ?? process.argv[1], mode: values.mode ?? "nudge" }), null, 2)}\n`); return 0; }
function help() { process.stdout.write("workloop — provider authority Contract\n\nopen|stage|commit|certify|status|audit|ledger|tasks|join|suspend|resume|abandon|recover-attachment|cleanup-staged-locator|reattach|abandon-staged-authority|fork-identity|archive-incompatible-state|hook|hooks\n\nHooks observe and record by default; the host exclusively decides tool execution approval.\n"); return 0; }
const COMMANDS = Object.freeze({ open: cmdOpen, stage: (v) => cmdReceipt(v, "stage"), commit: (v) => cmdReceipt(v, "commit"), certify: cmdCertify, status: (v) => cmdQuery(v, "status"), audit: (v) => cmdQuery(v, "audit"), ledger: (v) => cmdQuery(v, "ledger"), tasks: (v) => cmdQuery(v, "tasks"), join: (v) => cmdMutation(v, "join"), suspend: (v) => cmdMutation(v, "suspend"), resume: (v) => cmdMutation(v, "resume"), abandon: (v) => cmdMutation(v, "abandon"), "recover-attachment": (v) => cmdRecovery(v, "recover"), "cleanup-staged-locator": (v) => cmdRecovery(v, "cleanup"), reattach: (v) => cmdRecovery(v, "reattach"), "abandon-staged-authority": (v) => print(abandonStagedFilesystemAuthority({ authorityId: v.authority, commandId: v["command-id"], expectedGenesisDigest: v["expect-genesis-digest"], grantedBy: v["granted-by"], reason: v.reason }, RUNTIME)), "fork-identity": cmdFork, "archive-incompatible-state": cmdArchive, hook: cmdHook, hooks: cmdHooks });
function main() { const argv = process.argv.slice(2); if (!argv.length || ["help", "--help", "-h"].includes(argv[0])) return help(); const verb = argv[0]; if (!Object.hasOwn(OPTIONS, verb)) return error(`unknown command: ${verb}; this runtime accepts only the provider Contract`); try { const { values } = parseArgs({ args: argv.slice(1), options: OPTIONS[verb], allowPositionals: false }); return COMMANDS[verb](values); } catch (cause) { return error(cause?.message ?? cause); } }

export { main };
