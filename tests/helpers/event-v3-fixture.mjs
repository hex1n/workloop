import { createHash } from "node:crypto";

function deterministicId(seed, kind, index = 0) {
  const hex = createHash("sha256").update(`${seed}:${kind}:${index}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function makeTaskOpenedCommand({ seed = "workloop-v3", index = 0, atEpochMs }) {
  if (!Number.isSafeInteger(atEpochMs) || atEpochMs < 0) throw new Error("fixture requires non-negative integer atEpochMs");
  const at = new Date(atEpochMs).toISOString();
  const taskId = deterministicId(seed, "task", index);
  const episodeId = deterministicId(seed, "episode", index);
  return {
    type: "open",
    taskId,
    at,
    atEpochMs,
    goal: `fixture task ${index}`,
    criterion: {
      source: { kind: "command", value: "node check.mjs" },
      authored_by: "self",
      protocol: "binary",
      timeout_seconds: 120,
      declared_inputs: [],
      subjects: ["work.txt"],
      provenance: "repo",
      input_coverage: "full",
      criterion_definition_hash: `sha256:${createHash("sha256").update(`${seed}:criterion:${index}`).digest("hex")}`,
      criterion_generation_id: deterministicId(seed, "criterion-generation", index),
      criterion_input_fingerprint: null,
    },
    observation: {
      observation_id: deterministicId(seed, "observation", index),
      verdict: "unsatisfied",
      criterion_generation_id: null,
      observed_artifact_revision: null,
      observed_at: at,
      execution: {
        exit_code: 1,
        signal: null,
        duration_ms: 1,
        execution_error: null,
        output_tail: "fixture unsatisfied",
        timeout_seconds: 120,
      },
      changed_paths: [],
    },
    policyName: "default",
    policyRationale: null,
    alignment: { because: "event-store fixture", not_covered: [] },
    envelope: { files: ["work.txt"], git: [], destructive: false, network: false },
    grants: [],
    assurance: {
      declared_risk: "substantial",
      risk_reason: "event-store fixture",
      risk_declared_by: "default",
      change_classes: ["internal"],
      review_policy: "risk_based",
      required_review_level: null,
      review_waiver_reason: null,
      review_waiver_granted_by: null,
      proof_gap_acceptances: [],
      risk_floor_events: [],
    },
    budget: { rounds: 8, writes: null, wall_clock_minutes: null, output_tokens: 10000 },
    episodes: [{
      episode_id: episodeId,
      host_session_id: deterministicId(seed, "session", index),
      started_at: at,
      ended_at: null,
      start_task_revision: 1,
      end_task_revision: null,
      output_tokens_estimate: 0,
    }],
    actingSession: deterministicId(seed, "session", index),
  };
}

function* generateRecordFacts({ seed = "workloop-v3", count, startEpochMs }) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("record fixture count must be a positive integer");
  if (!Number.isSafeInteger(startEpochMs) || startEpochMs < 0) throw new Error("record fixture requires non-negative integer startEpochMs");
  const opened = makeTaskOpenedCommand({ seed, index: 0, atEpochMs: startEpochMs });
  const openedPayload = {
    goal: opened.goal,
    criterion: opened.criterion,
    observation: opened.observation,
    policy_name: opened.policyName,
    policy_rationale: opened.policyRationale,
    alignment: opened.alignment,
    envelope: opened.envelope,
    grants: opened.grants,
    assurance: opened.assurance,
    budget: opened.budget,
    episodes: opened.episodes,
  };
  for (let index = 0; index < count; index += 1) {
    const sequence = index + 1;
    const occurredAtEpochMs = startEpochMs + index;
    yield {
      transaction_id: deterministicId(seed, "transaction", index),
      command_id: null,
      repo_sequence: sequence,
      occurred_at_epoch_ms: occurredAtEpochMs,
      occurred_at: new Date(occurredAtEpochMs).toISOString(),
      actor: { kind: "cli", session_id: deterministicId(seed, "session", 0) },
      events: [{
        task_id: opened.taskId,
        task_event_sequence: sequence,
        kind: index === 0 ? "task_opened" : "write_authorized",
        payload_version: 1,
        payload: index === 0 ? openedPayload : { files: ["work.txt"] },
      }],
    };
  }
}

function makeTranscriptBytes({ seed = "workloop-v3", rows, lineEnding = "\n", finalPartial = false }) {
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error("transcript fixture rows must be a non-negative integer");
  if (!new Set(["\n", "\r\n"]).has(lineEnding)) throw new Error("transcript fixture line ending must be LF or CRLF");
  const lines = [];
  for (let index = 0; index < rows; index += 1) {
    lines.push(JSON.stringify({
      timestamp: new Date(1_784_000_000_000 + index).toISOString(),
      fixture_id: deterministicId(seed, "transcript-row", index),
      text: `雪-${index + 1}`,
      message: { usage: { output_tokens: index + 1 } },
    }));
  }
  const complete = lines.length ? `${lines.join(lineEnding)}${lineEnding}` : "";
  return Buffer.from(`${complete}${finalPartial ? "partial" : ""}`, "utf8");
}

export { deterministicId, generateRecordFacts, makeTaskOpenedCommand, makeTranscriptBytes };
