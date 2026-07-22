import { isPlainObject } from "./prims.mjs";

const EXPLICIT_PROFILES = Object.freeze(["claude", "codex-safe", "codex-cli-legacy"]);
const ALL_PROFILES = new Set([...EXPLICIT_PROFILES, "unknown"]);
const WRITE_TOOL_MATCHER = "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*";
const PRE_TOOL_USE_MATCHER = WRITE_TOOL_MATCHER;
const POST_TOOL_USE_MATCHER = WRITE_TOOL_MATCHER;
const STOP_MATCHER = "*";
const PRE_TOOL_USE_RECIPE_TIMEOUT_SECONDS = 20;
const POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS = 30;
const STOP_INLINE_CRITERION_SECONDS = 30;
const STOP_RUNTIME_DEADLINE_SECONDS = 35;
const STOP_RECIPE_TIMEOUT_SECONDS = 45;
const HOST_PROFILE_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    stop_control: "hard", inline_criterion_budget_seconds: STOP_INLINE_CRITERION_SECONDS,
    capability_id: "hostcap:v1:claude-2.1.216-pending-live-probe", exhaustive_surface: false,
    completion_events: Object.freeze(["PostToolUse", "PostToolUseFailure"]), receipt_quality: "unknown",
  }),
  "codex-safe": Object.freeze({
    stop_control: "release_only", inline_criterion_budget_seconds: 0,
    capability_id: "hostcap:v1:codex-0.144.5-codex-safe-direct", exhaustive_surface: false,
    completion_events: Object.freeze(["PostToolUse"]), receipt_quality: "tool_specific",
  }),
  "codex-cli-legacy": Object.freeze({
    stop_control: "release_only", inline_criterion_budget_seconds: 0,
    capability_id: "hostcap:v1:codex-0.144.5-codex-safe-direct", exhaustive_surface: false,
    completion_events: Object.freeze(["PostToolUse"]), receipt_quality: "tool_specific",
  }),
  unknown: Object.freeze({
    stop_control: "release_only", inline_criterion_budget_seconds: 0,
    capability_id: null, exhaustive_surface: false, completion_events: Object.freeze([]), receipt_quality: "unknown",
  }),
});
const RELEASE_ONLY_HOLD_SUFFIXES = Object.freeze({
  "codex-safe": "Codex safe profile cannot resume this session; continue with an external driver or run workloop achieve explicitly",
  "codex-cli-legacy": "Codex legacy profile is release-only; regenerate hooks with codex-safe or run explicit verification",
  unknown: "legacy hook invocation cannot safely resume Stop; regenerate hooks with an explicit profile",
});

function encoded(stdout = "", stderr = "") { return { stdout, stderr, exitCode: 0 }; }

function assertProfile(profile, { explicit = false } = {}) {
  if (explicit && profile === "unknown") throw new Error("explicit hook profile required");
  if (!ALL_PROFILES.has(profile)) throw new Error(`unsupported hook profile: ${profile}`);
  return profile;
}

function hostProfileCapability(profile) {
  assertProfile(profile);
  return HOST_PROFILE_CAPABILITIES[profile];
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

function hostCompletionOutcome(profile, event, source) {
  if (event === "post_tool_use_failure") return "failure";
  const response = isPlainObject(source.tool_response) ? source.tool_response : {};
  const exitCode = response.exit_code ?? response.exitCode;
  if (Number.isSafeInteger(exitCode) && exitCode !== 0) return "nonzero";
  if (response.success === false || response.is_error === true) return "failure";
  return profile.startsWith("codex-") ? "success" : "unknown";
}

function decodeHook({ profile, payload }) {
  assertProfile(profile);
  const source = isPlainObject(payload) ? payload : {};
  const namedEvent = String(source.hook_event_name ?? "").toLowerCase();
  const event = namedEvent === "pretooluse" ? "pre_tool_use"
    : namedEvent === "posttooluse" ? "post_tool_use"
      : namedEvent === "posttoolusefailure" ? "post_tool_use_failure"
        : namedEvent === "stop" ? "stop" : "unknown";
  const capability = hostProfileCapability(profile);
  const completionEvent = new Set(["post_tool_use", "post_tool_use_failure"]).has(event);
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
    ...(completionEvent ? {
      completionOutcome: hostCompletionOutcome(profile, event, source),
      receiptQuality: capability.receipt_quality,
    } : {}),
  };
}

function buildHookRecipe({ profile, command, mode = "nudge" }) {
  assertProfile(profile, { explicit: true });
  if (!new Set(["observe", "nudge", "deny"]).has(mode)) throw new Error(`unsupported hook mode: ${mode}`);
  const handler = `${command} hook --profile ${profile} --mode ${mode}`;
  const codex = profile.startsWith("codex-");
  return {
    hooks: {
      PreToolUse: [{ matcher: PRE_TOOL_USE_MATCHER, hooks: [{ type: "command", command: handler, ...(codex ? { statusMessage: "Checking workloop envelope" } : {}), timeout: PRE_TOOL_USE_RECIPE_TIMEOUT_SECONDS }] }],
      PostToolUse: [{ matcher: POST_TOOL_USE_MATCHER, hooks: [{ type: "command", command: handler, ...(codex ? { statusMessage: "Recording workloop tool receipt" } : {}), timeout: POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS }] }],
      ...(profile === "claude" ? {
        PostToolUseFailure: [{ matcher: POST_TOOL_USE_MATCHER, hooks: [{ type: "command", command: handler, timeout: POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS }] }],
      } : {}),
      Stop: [{ matcher: STOP_MATCHER, hooks: [{ type: "command", command: handler, ...(codex ? { statusMessage: "Checking workloop completion state" } : {}), timeout: STOP_RECIPE_TIMEOUT_SECONDS }] }],
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
  if (new Set(["post_tool_use", "post_tool_use_failure"]).has(disposition?.event) && disposition.action === "record") return encoded();
  if (disposition?.event === "stop" && disposition.action === "release") return encoded("", disposition.notice ? `workloop: ${disposition.notice}\n` : "");
  if (disposition?.event === "stop" && disposition?.action === "hold") {
    if (hostProfileCapability(invocation.profile).stop_control === "hard") {
      return encoded(JSON.stringify({ decision: "block", reason: `workloop: ${disposition.reason}` }) + "\n");
    }
    return encoded("", `workloop: ${disposition.reason}; ${RELEASE_ONLY_HOLD_SUFFIXES[invocation.profile]}\n`);
  }
  throw new Error("unsupported host hook encoding");
}

export {
  EXPLICIT_PROFILES,
  PRE_TOOL_USE_MATCHER,
  PRE_TOOL_USE_RECIPE_TIMEOUT_SECONDS,
  POST_TOOL_USE_MATCHER,
  POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS,
  STOP_MATCHER,
  STOP_INLINE_CRITERION_SECONDS,
  STOP_RECIPE_TIMEOUT_SECONDS,
  STOP_RUNTIME_DEADLINE_SECONDS,
  buildHookRecipe,
  decodeHook,
  encodeHook,
  hostProfileCapability,
};
