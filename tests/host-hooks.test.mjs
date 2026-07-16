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
    stderr: "taskloop: criterion unsatisfied; Codex safe profile cannot resume this session; continue with an external driver or run taskloop achieve explicitly\n",
    exitCode: 0,
  });
});

test("only explicit blocking profiles encode a held Stop as decision:block", () => {
  for (const profile of ["claude", "codex-cli-legacy"]) {
    assert.deepEqual(encodeHook({
      invocation: { profile, event: "stop" },
      disposition: { event: "stop", action: "hold", code: "criterion_unsatisfied", reason: "criterion unsatisfied" },
    }), {
      stdout: '{"decision":"block","reason":"taskloop: criterion unsatisfied"}\n',
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
    }).stdout, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"taskloop: write outside envelope: outside.txt"}}\n');

    assert.equal(encodeHook({
      invocation: { profile, event: "pre_tool_use" },
      disposition: { event: "pre_tool_use", action: "rewrite", updatedInput: { command: "export TASKLOOP_SESSION_ID='owner'; taskloop status" } },
    }).stdout, '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"export TASKLOOP_SESSION_ID=\'owner\'; taskloop status"}}}\n');

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
    stderr: "taskloop: criterion unsatisfied; legacy hook invocation cannot safely resume Stop; regenerate hooks with an explicit profile\n",
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
      tool_input: { command: "taskloop status" },
    },
  }), {
    profile: "codex-safe",
    event: "pre_tool_use",
    repo: "/repo",
    sessionId: "owner",
    agentId: "child-agent",
    permissionModeRaw: "bypassPermissions",
    transcriptPath: null,
    toolName: "Bash",
    toolInput: { command: "taskloop status" },
  });

  assert.deepEqual(buildHookRecipe({ profile: "codex-safe", command: 'node "/path/taskloop.mjs"' }), {
    hooks: {
        PreToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell|mcp__.*", hooks: [{ type: "command", command: 'node "/path/taskloop.mjs" hook --profile codex-safe --mode nudge', timeout: 20 }] }],
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/path/taskloop.mjs" hook --profile codex-safe --mode nudge', timeout: 300 }] }],
    },
  });

  assert.throws(() => decodeHook({ profile: "codex-app", payload: {} }), /unsupported hook profile: codex-app/);
  assert.throws(() => buildHookRecipe({ profile: "unknown", command: "taskloop" }), /explicit hook profile required/);
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
