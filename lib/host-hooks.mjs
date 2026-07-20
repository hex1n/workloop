import { isPlainObject } from "./prims.mjs";

const EXPLICIT_PROFILES = Object.freeze(["claude", "codex-safe", "codex-cli-legacy"]);
const ALL_PROFILES = new Set([...EXPLICIT_PROFILES, "unknown"]);
const CODEX_SAFE_HOLD_SUFFIX = "Codex safe profile cannot resume this session; continue with an external driver or run workloop achieve explicitly";
const UNKNOWN_HOLD_SUFFIX = "legacy hook invocation cannot safely resume Stop; regenerate hooks with an explicit profile";

function encoded(stdout = "", stderr = "") { return { stdout, stderr, exitCode: 0 }; }

function assertProfile(profile, { explicit = false } = {}) {
  if (explicit && profile === "unknown") throw new Error("explicit hook profile required");
  if (!ALL_PROFILES.has(profile)) throw new Error(`unsupported hook profile: ${profile}`);
  return profile;
}

function hostCommandId(source) {
  // Prefer an explicit host-neutral command_id; fall back to the per-tool-call
  // id hosts do emit (Claude's tool_use_id). This correlates a record with the
  // host command that produced it; it is not a crash-retry-stable exactly-once
  // key, so records still degrade to null when no host id is present.
  for (const key of ["command_id", "tool_use_id"]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function decodeHook({ profile, payload }) {
  assertProfile(profile);
  const source = isPlainObject(payload) ? payload : {};
  const namedEvent = String(source.hook_event_name ?? "").toLowerCase();
  const event = namedEvent === "pretooluse" ? "pre_tool_use" : namedEvent === "stop" ? "stop" : "unknown";
  return {
    profile,
    event,
    repo: String(source.cwd ?? "."),
    sessionId: typeof source.session_id === "string" ? source.session_id : null,
    agentId: typeof source.agent_id === "string" ? source.agent_id : null,
    commandId: hostCommandId(source),
    permissionModeRaw: typeof source.permission_mode === "string" ? source.permission_mode : null,
    transcriptPath: typeof source.transcript_path === "string" ? source.transcript_path : null,
    toolName: String(source.tool_name ?? ""),
    toolInput: isPlainObject(source.tool_input) ? source.tool_input : {},
  };
}

function buildHookRecipe({ profile, command, mode = "nudge" }) {
  assertProfile(profile, { explicit: true });
  if (!new Set(["observe", "nudge", "deny"]).has(mode)) throw new Error(`unsupported hook mode: ${mode}`);
  const handler = `${command} hook --profile ${profile} --mode ${mode}`;
  return {
    hooks: {
      PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command: handler, timeout: 20 }] }],
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: handler, timeout: 300 }] }],
    },
  };
}

function encodeHook({ invocation, disposition }) {
  assertProfile(invocation?.profile);
  if (invocation?.event !== disposition?.event) throw new Error(`hook event mismatch: ${invocation?.event} != ${disposition?.event}`);
  if (disposition?.event === "pre_tool_use" && disposition.action === "pass") return encoded();
  if (disposition?.event === "pre_tool_use" && disposition.action === "deny") {
    return encoded(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `workloop: ${disposition.reason}` } }) + "\n");
  }
  if (disposition?.event === "pre_tool_use" && disposition.action === "rewrite") {
    return encoded(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: disposition.updatedInput } }) + "\n");
  }
  if (disposition?.event === "stop" && disposition.action === "release") return encoded("", disposition.notice ? `workloop: ${disposition.notice}\n` : "");
  if (["claude", "codex-cli-legacy"].includes(invocation?.profile) && disposition?.event === "stop" && disposition?.action === "hold") {
    return encoded(JSON.stringify({ decision: "block", reason: `workloop: ${disposition.reason}` }) + "\n");
  }
  if (invocation?.profile === "codex-safe" && disposition?.event === "stop" && disposition?.action === "hold") {
    return encoded("", `workloop: ${disposition.reason}; ${CODEX_SAFE_HOLD_SUFFIX}\n`);
  }
  if (invocation?.profile === "unknown" && disposition?.event === "stop" && disposition?.action === "hold") {
    return encoded("", `workloop: ${disposition.reason}; ${UNKNOWN_HOLD_SUFFIX}\n`);
  }
  throw new Error("unsupported host hook encoding");
}

export { EXPLICIT_PROFILES, buildHookRecipe, decodeHook, encodeHook };
