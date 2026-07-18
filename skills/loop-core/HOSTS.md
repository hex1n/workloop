# Host Binding Recipes

taskloop is the stop gate, not the driver: something else asks for another
round (a human, a recurring goal, a scheduler), and the host decides what a
session may touch (sandbox). These recipes bind the gate to specific hosts.
The original binding mechanics were earned in a live dual-host spike (Claude
Code 2.1.207, Codex CLI 0.144.1). Hook output support is now explicit per host
profile because Codex App and Codex CLI cannot be treated as one wire surface.

## Any driver

- Phrase the driver's stop condition as: the task reaches a
  **terminal state or suspends**. Suspension means blocked-on-the-world; a driver that keeps
  pushing a suspended task gets a clean release each time (the Stop hook does
  not burn budget on a suspended task), so every extra push is pure driver
  waste.
- Judge success from the rebuildable outcome projection
  (`~/.taskloop/outcomes.jsonl`), not from the transcript: the terminal event
  is the machine's verdict, while repository authority remains
  `.taskloop/events.jsonl`.
- Give the driver itself an outer wall-clock budget: a wedged host session
  (observed live: one `codex exec` hung for twenty minutes) must die by
  timeout, not by a human noticing.

## Claude Code

- Generate the recipe with `taskloop hooks --profile claude`. Its handler
  command identifies the adapter explicitly.

- Hook payload `session_id` and `CLAUDE_CODE_SESSION_ID` are the ownership
  binding pair and must remain in the same identity domain. Parent and Task
  subagent payloads share that session identity, so they intentionally share
  one envelope. Optional `agent_id` identifies the acting subagent separately
  for evidence and review provenance; it never replaces ownership identity.
- Session-internal continuation needs nothing beyond hook wiring: the Stop
  hook's block feedback is the resume prompt.
- Recurring goals (`/goal`, `/loop`): use the stop condition above. Claude Code
  force-releases a Stop hook after 8 consecutive blocks — the same constant as
  the default rounds budget — so a goal condition blind to suspension spends
  its pushes against that limit for nothing.
- Headless runs (`claude -p`) have no sandbox flag: permission modes and
  `--allowedTools` are collaborative filters, not an OS wall. For unattended
  headless Claude the wall is an external container/VM; interactive sessions
  can use `/sandbox`.

## Codex CLI

- Generate the supported recipe with `taskloop hooks --profile codex-safe`.
  A held Stop records the normal taskloop observation but returns zero stdout
  plus a warning: Codex gets no injected resume prompt. Continue through an
  external driver or invoke `taskloop achieve` explicitly.

- Hook payloads carry `session_id`, while exec shells export
  `CODEX_THREAD_ID`, and the two values differ; taskloop binds only from the
  payload `session_id`. On an allowed Bash/PowerShell call that invokes
  taskloop, its PreToolUse hook uses Codex's documented `updatedInput`
  response to inject the payload-domain `session_id` as `TASKLOOP_SESSION_ID`
  for that command only; the injection is stateless and persists no
  thread-to-session mapping. Missing or malformed payload identities degrade to
  unbound gate-all behavior. An explicit conflicting override is denied
  instead of silently changing owner.
- Codex parent and subagent hook events share the parent session ID, so taskloop
  treats them as one ownership domain. Current payloads also carry an optional
  `agent_id`; taskloop records it as the acting identity while retaining the
  parent session for ownership. The acting-identity environment variable is
  host-managed; a command that supplies its own value is denied rather than
  accepted as review or authority-change provenance.
- Current Codex PreToolUse payloads also carry the raw `permission_mode` value
  (live capture: `default`); taskloop records it without translating host
  vocabulary. During an active owned task, publish and shared-push shapes
  require a non-bypass observed value plus the ordinary task envelope grant.
  This is a capability floor rather than a guessed numeric host-version floor:
  a host that omits `permission_mode` is unsupported for those calls and gets
  a capability-specific denial; `bypassPermissions` gets a distinct bypass
  denial. The gate remains active in `observe` mode. Foreign-session publication is denied by the ownership guard;
  no-task and terminal calls are outside task authority mediation.
  Keep taskloop as the only matching hook that rewrites `updatedInput` for its
  CLI calls: matching hooks run concurrently, so independent command rewriters
  have no reliable composition order. PreToolUse remains a policy guardrail,
  not an OS security boundary.
- `taskloop hooks --profile codex-cli-legacy` retains the historical
  `decision:block` behavior only for explicit, version-pinned CLI experiments.
  It was observed on Codex CLI 0.144.1, is not part of the supported Codex
  contract, and must never be copied into Codex App configuration.
- The default workspace-write sandbox does not cover the projection home:
  agent-run CLI verbs inside the sandbox may defer their projection rows. Pair sessions
  with `--add-dir ~/.taskloop` (or grant the home). `node install.mjs` detects a
  missing persistent binding without editing user config; opt in with
  `node install.mjs --configure-codex` to merge the projection root into
  `sandbox_workspace_write.writable_roots`. The failure is visible as
  `warning: outcome-v3 projection deferred: ...` on stderr — treat that line
  as "the sandbox split the write surface", not as noise.
- Keep hooks configuration single-source: hooks living in both
  `~/.codex/hooks.json` and `config.toml` draw a startup warning and can
  diverge; pick one layer and delete the other.
- The read-only tier cannot host tasks: every verb needs a writable workspace
  for `.taskloop/` and refuses with `cannot write task state` when it cannot
  get one. Use read-only for inspection sessions; loops need workspace-write.
- Cross-session driving belongs to Codex scheduled tasks (untested binding;
  the gate itself is driver-agnostic).

## Codex App

- Use only `codex-safe`. A legacy `decision:block` Stop was observed being
  persisted as a user-shaped hook prompt with a UUID message id; later API
  replay rejected that id because API message ids require the `msg` prefix.
  taskloop supplies the Stop reason, while Codex App creates the message id.
- `codex-safe` therefore emits no Stop stdout while held. PreToolUse remains a
  policy guardrail, but session-internal continuation is unavailable until
  Codex exposes and taskloop verifies a stable continuation contract.
- Never infer App versus CLI from `session_id`, model name, executable path, or
  environment variables. Current Hook payloads expose no stable surface field;
  the generated command must carry the profile.
- A no-argument legacy taskloop Hook invocation is migration-only: PreToolUse
  remains active, held Stop releases with a stderr warning, and the user should
  regenerate an explicit recipe.

## What stays out

No recipe here schedules another turn or enforces an OS boundary. Drivers and
sandboxes remain host property; taskloop only adjudicates "may this round
close". With no driver at all, the loop degrades to a single supervised pass
(see [SKILL.md](../workloop/SKILL.md)).

## PreToolUse modes

Generated recipes default to `--mode nudge`. Every invoked mode writes the repo-local
evidence stream: `observe` records without messaging, `nudge` records and
prompts without denying, and `deny` may reject wider untracked work. The
`hooks` command prints a recipe and does not claim it was installed. After the
host configuration is actually changed, record that human-confirmed transition
with `--action record-install|record-mode|record-uninstall`; a later live Stop
census is still required before `ledger --json` reports covered evidence.
Direct settings edits without that evidence remain unknown.

The repository-local evidence stream is bounded telemetry, not task authority.
Malformed or future-version rows are skipped and counted, torn tails recover on
the next append, and compaction records discarded history; each condition makes
ledger coverage `gapped` rather than wedging hooks or claiming complete history.
The first evidence append creates a private `.taskloop/.gitignore` only when one
does not already exist, so no-task actor anchors remain local without polluting
repository status or overwriting repository policy.
After the evidence lock is acquired, sequence reservation intentionally
precedes every write attempt: I/O failures, compaction refusal, and oversized
records burn a number so dropped telemetry is visible as a gap. A known lost
PreToolUse row also writes a unique loss sidecar immediately, so cross-session
reads do not wait for a future same-session gap. A lock timeout cannot safely
reserve through the contested counter and uses the same sidecar. Readers count
these markers and report coverage as `gapped` rather than complete.
Legacy hook commands that omit `--mode` retain the conservative `deny` default;
regenerated recipes move intentionally to `nudge`.

## Overnight interactive recipe

Admit only a criterion that can run without a person or external-system action.
Use one interactive sandboxed host session with the Stop gate, `--rounds 30`,
and no wall-clock or output-token budget. Suspension is the honest overnight
terminal-for-the-driver. Plan for the morning independent review to be the
normal final step; meta-loop work is always human-in-the-loop and is never an
overnight candidate.
