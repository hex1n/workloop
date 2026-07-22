# Host-authority non-blocking Hook implementation

## Decision

The host permission system is the sole authority for whether a tool executes.
Workloop is an evidence recorder and terminal certifier by default. It may
refuse to certify a task as complete, but it must not veto execution or Stop
unless the user explicitly installs `--mode deny`.

This requires Runtime Contract 7. Reinterpreting Contract 6
`write_authorized` rows would corrupt replay semantics, so Contract 7 adds an
`operation_intent_recorded` fact and keeps Contract 5/6 replay frozen.

## Invariants

1. `observe` and `nudge` never emit `permissionDecision: deny` or
   `decision: block`; Hook authority/telemetry failures fail open.
   Omitting `--mode` is defined as `nudge`, so enforcement cannot be entered
   accidentally through a legacy or partially specified invocation.
2. A non-enforcing Workloop command rewrite may emit `updatedInput`, but omits
   `permissionDecision`; the host still decides whether the rewritten call
   executes.
3. Pre records intent, policy disposition, reasons, host profile, session
   relation, and receipt expectation. It never records an execution grant.
4. Post records a correlated completion receipt and reconciles the repository.
   Artifact changes come only from reconciliation, never from intent count.
   Unknown MCP actions are conservatively treated as possible side effects;
   explicit read-verb MCP actions remain outside the operation budget.
5. Budgets, grants, session relation, envelope findings, host approval-key
   findings, and evidence gaps affect risk, review, coverage, and terminal
   certification. In `observe`/`nudge` they do not affect host execution.
   Expanding an envelope immediately reclassifies the current authoritative
   checkpoint, so a resolved scope violation cannot remain latched merely
   because no repository byte changed afterward. The amendment and no-delta
   reclassification share one authority record and preserve checkpoint ID,
   capture time, and artifact revision.
6. `deny` remains an explicit enforcement mode. It fails closed, may reject
   Pre policy violations, and permits the Claude hard-Stop adapter. Codex Stop
   remains release-only.
7. Contract 7 activation is blocked by active Contract 5 or 6 tasks. Installer
   manifests permanently pin valid Contract 5 and Contract 6 escape runtimes.
8. External absolute targets are represented in task authority by the stable
   synthetic marker `<external-target>`; local telemetry may retain the parsed
   target for diagnosis.

## Verification contract

- Red-to-green acceptance covers default non-blocking Pre/Stop, explicit deny,
  Hook failure injection, budget-overrun certification, intent/receipt
  correlation, deterministic artifact checkpoints, and external targets.
- Frozen Contract 5 and Contract 6 fixtures remain replayable; Contract 7 has a
  separate fixture and outcome projection schema 5.
- Full local tests include behavioral, hook wire, event/snapshot, installer,
  packaging, failure injection, concurrency, and Windows-selected suites.
- Installer tests prove active Contract 5/6 activation blocks and persistent
  compatibility pins.
- Release acceptance requires a real Codex CLI/App-server Pre/Post receipt and
  a live Hook census after installation. Claude live acceptance remains
  explicitly unverified until login is authorized.

## Rollout

Finish any active Contract 6 task with its pinned Contract 6 runtime. Install
Contract 7 only after the source task is terminal, then regenerate/merge the
`codex-safe --mode nudge` recipe and perform the live Codex probes. Do not infer
Claude conformance from Codex evidence.
