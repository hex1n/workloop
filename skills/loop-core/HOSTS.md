# Host Binding Recipes

taskloop is the stop gate, not the driver: something else asks for another
round (a human, a recurring goal, a scheduler), and the host decides what a
session may touch (sandbox). These recipes bind the gate to specific hosts.
Each line was earned in a live dual-host spike (Claude Code 2.1.207, Codex CLI
0.144.1), not designed on paper.

## Any driver

- Phrase the driver's stop condition as: the task reaches a
  **terminal state or suspends**. Suspension means blocked-on-the-world; a driver that keeps
  pushing a suspended task gets a clean release each time (the Stop hook does
  not burn budget on a suspended task), so every extra push is pure driver
  waste.
- Judge success from the outcome ledger (`~/.taskloop/outcomes-v1.jsonl`), not
  from the transcript: the terminal row is the machine's verdict, the
  transcript is the story.
- Give the driver itself an outer wall-clock budget: a wedged host session
  (observed live: one `codex exec` hung for twenty minutes) must die by
  timeout, not by a human noticing.

## Claude Code

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

- Session-internal stop-block driving works out of the box in `codex exec`;
  the block reason arrives as the resume message.
- The default workspace-write sandbox does not cover the ledger home:
  agent-run CLI verbs inside the sandbox lose their ledger rows. Pair sessions
  with `--add-dir ~/.taskloop` (or grant the home). `node install.mjs` detects a
  missing persistent binding without editing user config; opt in with
  `node install.mjs --configure-codex` to merge the ledger root into
  `sandbox_workspace_write.writable_roots`. The failure is visible as
  `taskloop: outcome ledger append failed (...)` on stderr — treat that line
  as "the sandbox split the write surface", not as noise.
- Keep hooks configuration single-source: hooks living in both
  `~/.codex/hooks.json` and `config.toml` draw a startup warning and can
  diverge; pick one layer and delete the other.
- The read-only tier cannot host tasks: every verb needs a writable workspace
  for `.taskloop/` and refuses with `cannot write task state` when it cannot
  get one. Use read-only for inspection sessions; loops need workspace-write.
- Cross-session driving belongs to Codex scheduled tasks (untested binding;
  the gate itself is driver-agnostic).

## What stays out

No recipe here schedules another turn or enforces an OS boundary. Drivers and
sandboxes remain host property; taskloop only adjudicates "may this round
close". With no driver at all, the loop degrades to a single supervised pass
(see [SKILL.md](../workloop/SKILL.md)).
