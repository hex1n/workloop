import assert from "node:assert/strict";
import test from "node:test";

import { buildHookRecipe, decodeHook, encodeHook } from "../lib/host-hooks.mjs";

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

test("only explicit blocking profiles encode a held Stop as decision:block", () => {
  for (const profile of ["claude", "codex-cli-legacy"]) {
    assert.deepEqual(encodeHook({
      invocation: { profile, event: "stop" },
      disposition: { event: "stop", action: "hold", code: "criterion_unsatisfied", reason: "criterion unsatisfied" },
    }), {
      stdout: '{"decision":"block","reason":"workloop: criterion unsatisfied"}\n',
      stderr: "",
      exitCode: 0,
    });
  }
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
        PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command: 'node "/path/workloop.mjs" hook --profile codex-safe --mode nudge', timeout: 20 }] }],
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/path/workloop.mjs" hook --profile codex-safe --mode nudge', timeout: 300 }] }],
    },
  });

  assert.throws(() => decodeHook({ profile: "codex-app", payload: {} }), /unsupported hook profile: codex-app/);
  assert.throws(() => buildHookRecipe({ profile: "unknown", command: "workloop" }), /explicit hook profile required/);
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
