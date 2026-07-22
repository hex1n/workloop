# Runtime Contract 7 host-authority two-axis review

Date: 2026-07-22
Candidate: current uncommitted Contract 7 source tree; exact-SHA release review remains pending commit authorization.

## Scope

The review covers the Runtime Contract 7 migration that makes the host the sole
tool-execution approval authority, makes `observe`/`nudge` passive
intent/receipt sensors, preserves explicit `deny` enforcement, and gates
terminal certification on evidence, policy, review, and budget invariants.

## Specification axis

Reviewer: independent subagent `contract7_spec_review`.

Initial findings:

- omitted Hook mode still defaulted to historical `deny`;
- non-write budget overruns did not all hold terminal certification;
- opaque MCP side effects could miss intent and completion receipts.

Resolution verified by the reviewer:

- dispatcher, CLI, wire encoder, and untracked paths all default omission to
  `nudge`, with default Pre/Stop and lock-timeout fail-open regressions;
- Contract 7 checks round, intent/write, wall-clock, and output-token overruns
  at terminal certification while allowing the exact limit;
- unknown MCP actions receive intent/Post receipts, known pure reads remain
  free, and ambiguous `resolve_thread` / `read_and_mark_seen` shapes are
  conservatively observed.

Final result: **0 blocking findings, 0 advisory findings**.

## Terminal-scope follow-up

The live Contract 6 close attempt exposed a stale scope-violation edge after an
envelope expansion with no later byte change. The first repair was rejected by
the standards reviewer because two records left a crash window and advanced
`captured_at_ms` without a new capture. The final repair moves
`task_amended` plus same-checkpoint `artifact_reconciled` into one pure-engine
decision and one authority record. Regression coverage proves the scope
violation clears while checkpoint ID, capture time, and artifact revision stay
unchanged.

Both reviewers re-reviewed this increment: **0 blocking findings, 0 advisory
findings** on each axis.

## Standards axis

Reviewer: independent subagent `contract7_standards_review`.

Initial findings:

- public help overstated Claude hard Stop outside explicit `deny`;
- Contract 7 episode boundaries were labeled `runtime-contract-6`;
- two cross-contract helpers retained misleading Contract 6 names.

Resolution verified by the reviewer:

- help and tests state that only explicit `--mode deny` may hard-block Claude;
- coverage labels derive from the actual task runtime;
- artifact-evidence terminal and episode-coverage helpers use semantic names;
- separate Contract 6 enforcement and Contract 7 observation orchestration is
  accepted because the replay-frozen contracts have different invariants and
  already share the pure classification primitives.

Final result: **0 blocking findings, 0 advisory findings**.

## Verification evidence

- Focused final regression set: 93 passed, 0 failed.
- Full behavioral suite: 149 passed, 0 failed.
- Full matrix: 270 passed, 10 Windows-only skips, 0 failed.
- Event-store benchmark: pass at 10,001 records; full replay max 113.16 ms,
  incremental-tail p95 0.59 ms, append-fsync p95 4.25 ms.
- Artifact checkpoint benchmark: 128 files p50 3.70 ms / max 4.91 ms;
  4,096 files p50 87.58 ms / max 88.53 ms.
- `git diff --check`: pass.

## Remaining release boundary

The code candidate is locally accepted. Exact-SHA CI, installation, global
Codex Hook merge, and live Codex CLI/app-server receipts require a committed
candidate. Claude login and live verification remain explicitly deferred.
