import assert from "node:assert/strict";
import test from "node:test";

import {
  PRE_TOOL_USE_RECIPE_TIMEOUT_SECONDS,
  POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS,
  STOP_INLINE_CRITERION_SECONDS,
  STOP_RECIPE_TIMEOUT_SECONDS,
  STOP_RUNTIME_DEADLINE_SECONDS,
  buildHookRecipe,
  decodeHook,
  encodeHook,
  hostProfileCapability,
} from "../lib/host-hooks.mjs";

test("Stop capabilities separate release-only profiles from the hard gate", () => {
  assert.deepEqual(hostProfileCapability("claude"), {
    stop_control: "hard",
    inline_criterion_budget_seconds: STOP_INLINE_CRITERION_SECONDS,
    capability_id: "hostcap:v1:claude-2.1.216-pending-live-probe",
    exhaustive_surface: false,
    completion_events: ["PostToolUse", "PostToolUseFailure"],
    receipt_quality: "unknown",
  });
  for (const profile of ["codex-safe", "codex-cli-legacy"]) {
    assert.deepEqual(hostProfileCapability(profile), {
      stop_control: "release_only",
      inline_criterion_budget_seconds: 0,
      capability_id: "hostcap:v1:codex-0.144.5-codex-safe-direct",
      exhaustive_surface: false,
      completion_events: ["PostToolUse"],
      receipt_quality: "tool_specific",
    });
  }
  assert.deepEqual(hostProfileCapability("unknown"), {
    stop_control: "release_only", inline_criterion_budget_seconds: 0,
    capability_id: null, exhaustive_surface: false, completion_events: [], receipt_quality: "unknown",
  });
  assert.ok(STOP_INLINE_CRITERION_SECONDS > 0);
  assert.ok(STOP_INLINE_CRITERION_SECONDS < STOP_RUNTIME_DEADLINE_SECONDS);
  assert.ok(STOP_RUNTIME_DEADLINE_SECONDS < STOP_RECIPE_TIMEOUT_SECONDS);
});

test("codex-safe releases a held Stop without emitting resumable stdout", () => {
  const encoded = encodeHook({
    invocation: { profile: "codex-safe", event: "stop" },
    disposition: { event: "stop", action: "hold", code: "criterion_unsatisfied", reason: "criterion unsatisfied" },
  });

  assert.deepEqual(encoded, {
    stdout: "",
    stderr: "workloop: criterion unsatisfied; Codex safe profile cannot resume this session; continue with an external driver or run workloop achieve explicitly\n",
    exitCode: 0,
  });
});

test("only hard profiles encode a held Stop as decision:block", () => {
  assert.deepEqual(encodeHook({
    invocation: { profile: "claude", event: "stop" },
    disposition: { event: "stop", action: "hold", code: "criterion_unsatisfied", reason: "criterion unsatisfied" },
  }), {
    stdout: '{"decision":"block","reason":"workloop: criterion unsatisfied"}\n',
    stderr: "",
    exitCode: 0,
  });

  assert.deepEqual(encodeHook({
    invocation: { profile: "codex-cli-legacy", event: "stop" },
    disposition: { event: "stop", action: "hold", code: "criterion_unsatisfied", reason: "criterion unsatisfied" },
  }), {
    stdout: "",
    stderr: "workloop: criterion unsatisfied; Codex legacy profile is release-only; regenerate hooks with codex-safe or run explicit verification\n",
    exitCode: 0,
  });
});

test("PreToolUse deny, rewrite, and pass stay byte-exact across profiles", () => {
  for (const profile of ["claude", "codex-safe", "codex-cli-legacy", "unknown"]) {
    assert.equal(encodeHook({
      invocation: { profile, event: "pre_tool_use" },
      disposition: { event: "pre_tool_use", action: "deny", reason: "write outside envelope: outside.txt" },
    }).stdout, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"workloop: write outside envelope: outside.txt"}}\n');

    assert.equal(encodeHook({
      invocation: { profile, event: "pre_tool_use" },
      disposition: { event: "pre_tool_use", action: "rewrite", updatedInput: { command: "export WORKLOOP_SESSION_ID='owner'; workloop status" } },
    }).stdout, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"export WORKLOOP_SESSION_ID=\'owner\'; workloop status"}}}\n');

    assert.deepEqual(encodeHook({
      invocation: { profile, event: "pre_tool_use" },
      disposition: { event: "pre_tool_use", action: "pass" },
    }), { stdout: "", stderr: "", exitCode: 0 });
  }
});

test("Stop release is silent and an unknown held Stop is migration-safe", () => {
  for (const profile of ["claude", "codex-safe", "codex-cli-legacy", "unknown"]) {
    assert.deepEqual(encodeHook({
      invocation: { profile, event: "stop" },
      disposition: { event: "stop", action: "release" },
    }), { stdout: "", stderr: "", exitCode: 0 });
  }

  assert.deepEqual(encodeHook({
    invocation: { profile: "unknown", event: "stop" },
    disposition: { event: "stop", action: "hold", code: "criterion_unsatisfied", reason: "criterion unsatisfied" },
  }), {
    stdout: "",
    stderr: "workloop: criterion unsatisfied; legacy hook invocation cannot safely resume Stop; regenerate hooks with an explicit profile\n",
    exitCode: 0,
  });
});

test("explicit profiles decode payloads and generate self-identifying recipes", () => {
  assert.deepEqual(decodeHook({
    profile: "codex-safe",
    payload: {
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      session_id: "owner",
      agent_id: "child-agent",
      permission_mode: "bypassPermissions",
      transcript_path: null,
      tool_name: "Bash",
      tool_input: { command: "workloop status" },
    },
  }), {
    profile: "codex-safe",
    event: "pre_tool_use",
    repo: "/repo",
    sessionId: "owner",
    agentId: "child-agent",
    commandId: null,
    permissionModeRaw: "bypassPermissions",
    transcriptPath: null,
    toolName: "Bash",
    toolInput: { command: "workloop status" },
  });

  assert.deepEqual(buildHookRecipe({ profile: "codex-safe", command: 'node "/path/workloop.mjs"' }), {
    hooks: {
      PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command: 'node "/path/workloop.mjs" hook --profile codex-safe --mode nudge', statusMessage: "Checking workloop envelope", timeout: PRE_TOOL_USE_RECIPE_TIMEOUT_SECONDS }] }],
      PostToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command: 'node "/path/workloop.mjs" hook --profile codex-safe --mode nudge', statusMessage: "Recording workloop tool receipt", timeout: POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS }] }],
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/path/workloop.mjs" hook --profile codex-safe --mode nudge', statusMessage: "Checking workloop completion state", timeout: STOP_RECIPE_TIMEOUT_SECONDS }] }],
    },
  });

  const claudeRecipe = buildHookRecipe({ profile: "claude", command: "workloop" });
  assert.equal("statusMessage" in claudeRecipe.hooks.PreToolUse[0].hooks[0], false);
  assert.equal("statusMessage" in claudeRecipe.hooks.PostToolUse[0].hooks[0], false);
  assert.equal("statusMessage" in claudeRecipe.hooks.PostToolUseFailure[0].hooks[0], false);
  assert.equal("statusMessage" in claudeRecipe.hooks.Stop[0].hooks[0], false);

  const legacyCodexRecipe = buildHookRecipe({ profile: "codex-cli-legacy", command: "workloop" });
  assert.equal(legacyCodexRecipe.hooks.PreToolUse[0].hooks[0].statusMessage, "Checking workloop envelope");
  assert.equal(legacyCodexRecipe.hooks.PostToolUse[0].hooks[0].statusMessage, "Recording workloop tool receipt");
  assert.equal(legacyCodexRecipe.hooks.Stop[0].hooks[0].statusMessage, "Checking workloop completion state");

  assert.throws(() => decodeHook({ profile: "codex-app", payload: {} }), /unsupported hook profile: codex-app/);
  assert.throws(() => buildHookRecipe({ profile: "unknown", command: "workloop" }), /explicit hook profile required/);
});

test("PostToolUse adapters preserve correlation and emit silent acknowledgements", () => {
  const codex = decodeHook({ profile: "codex-safe", payload: {
    hook_event_name: "PostToolUse", cwd: "/repo", session_id: "session", tool_use_id: "operation-1",
    tool_name: "apply_patch", tool_input: { command: "sanitized" }, tool_response: { success: true },
  } });
  assert.equal(codex.event, "post_tool_use");
  assert.equal(codex.commandId, "operation-1");
  assert.equal(codex.completionOutcome, "success");
  assert.equal(codex.receiptQuality, "tool_specific");
  assert.deepEqual(encodeHook({ invocation: codex, disposition: { event: "post_tool_use", action: "record" } }), { stdout: "", stderr: "", exitCode: 0 });

  const claudeFailure = decodeHook({ profile: "claude", payload: {
    hook_event_name: "PostToolUseFailure", cwd: "/repo", tool_use_id: "operation-2",
    tool_name: "Bash", tool_input: {}, error: "sanitized",
  } });
  assert.equal(claudeFailure.event, "post_tool_use_failure");
  assert.equal(claudeFailure.completionOutcome, "failure");
  assert.equal(claudeFailure.receiptQuality, "unknown");
  assert.deepEqual(encodeHook({ invocation: claudeFailure, disposition: { event: "post_tool_use_failure", action: "record" } }), { stdout: "", stderr: "", exitCode: 0 });
});

test("host recipes include only completion events supported by each host", () => {
  const claude = buildHookRecipe({ profile: "claude", command: "workloop" }).hooks;
  assert.equal(claude.PostToolUse[0].hooks[0].timeout, POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS);
  assert.equal(claude.PostToolUseFailure[0].hooks[0].timeout, POST_TOOL_USE_RECIPE_TIMEOUT_SECONDS);

  const codex = buildHookRecipe({ profile: "codex-safe", command: "workloop" }).hooks;
  assert.equal(codex.PostToolUse[0].hooks[0].statusMessage, "Recording workloop tool receipt");
  assert.equal("PostToolUseFailure" in codex, false);
});

test("decodeHook passes through a host command id, preferring explicit command_id over tool_use_id", () => {
  const base = { profile: "claude", event: "pre_tool_use", repo: ".", sessionId: null, agentId: null, permissionModeRaw: null, transcriptPath: null, toolName: "", toolInput: {} };
  const commandId = (payload) => decodeHook({ profile: "claude", payload }).commandId;
  assert.equal(decodeHook({ profile: "claude", payload: {} }).commandId, null, "absent host id degrades to null");
  assert.equal(commandId({ tool_use_id: "toolu_01ABC" }), "toolu_01ABC", "Claude tool_use_id flows through");
  assert.equal(commandId({ command_id: "cmd-1" }), "cmd-1", "explicit command_id flows through");
  assert.equal(commandId({ command_id: "cmd-1", tool_use_id: "toolu_01ABC" }), "cmd-1", "explicit command_id wins");
  assert.equal(commandId({ tool_use_id: "" }), null, "empty host id is rejected");
  assert.equal(commandId({ tool_use_id: 42 }), null, "non-string host id is rejected");
  assert.deepEqual(decodeHook({ profile: "claude", payload: { hook_event_name: "PreToolUse", tool_use_id: "toolu_09XYZ" } }), { ...base, commandId: "toolu_09XYZ" });
});

test("encoding rejects unknown explicit profiles and mismatched event results", () => {
  assert.throws(() => encodeHook({
    invocation: { profile: "codex-app", event: "pre_tool_use" },
    disposition: { event: "pre_tool_use", action: "pass" },
  }), /unsupported hook profile: codex-app/);
  assert.throws(() => encodeHook({
    invocation: { profile: "claude", event: "stop" },
    disposition: { event: "pre_tool_use", action: "pass" },
  }), /hook event mismatch/);
});
