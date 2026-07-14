# taskloop

taskloop is a dependency-free Node.js CLI and portable workloop kernel for
machine-verifiable agent work. The runtime constrains writes and adjudicates a
fresh done-when criterion; schedulers remain outside this repository.

## Model

Criterion observations are `unsatisfied`, `satisfied`, and `indeterminate`.
Task lifecycle is `active`, `suspended(reason)`, or `terminal(outcome)` where
terminal outcomes are `achieved`, `not_needed`, and `abandoned`. Criterion
satisfied is evidence, not task completion; closure is separately projected as
`not_ready`, `held`, or `eligible`.

Three policies define open, witness, and close behavior:

- `default`: open unsatisfied, require an unsatisfied witness, close automatically;
- `deferred-witness` (`deferred_witness` in state): open determinate, require a witness, close automatically;
- `steady-satisfied` (`steady_satisfied` in state): open determinate, no witness, close explicitly.

## Use

```sh
node bin/taskloop.mjs open --repo . --goal "observable outcome" \
  --criterion "npm test" --criterion-policy default \
  --alignment-because "the suite exercises the requested behavior" \
  --not-covered "deployed environment" --files "lib/**" --files "tests/**"

node bin/taskloop.mjs status --repo .
node bin/taskloop.mjs verify --repo .
node bin/taskloop.mjs achieve --repo .
```

Rounds are bounded by default. Optional write, wall-clock, and output-token
budgets can add independent bounds. Exhausting any configured budget denies
further writes while keeping reads and verification available. A fresh
unsatisfied Stop or explicit `achieve` suspends as `out_of_budget`; a fresh
satisfied criterion can still close the task. Repeated equivalent failures
suspend as `stuck`.

Command safety is deny-by-default. Git mutations and authority expansions are
explicit grants with provenance:

```sh
taskloop amend --repo . --git-allowed add \
  --git-reason "prepare the user-requested commit" \
  --granted-by user --reason "user requested staging"
```

Network, destructive, and install-script commands use `--network-allowed`,
`--destructive-allowed`, and `--install-scripts-allowed` with a non-empty
`--reason`. Remote download-to-shell execution requires both network and
destructive grants. Secret dumps remain denied.

Other lifecycle commands:

```sh
taskloop suspend --reason needs-input --remaining "credential" \
  --failure "cannot authenticate" --next-action "provide test access"
taskloop resume --reason "access supplied"
taskloop join --reason "continue this active task in the current host session"
taskloop not-needed --evidence "read-only probe showed the goal already holds"
taskloop abandon --reason "superseded"
```

An active task's latest episode owns Stop adjudication and its envelope. Other
host sessions stop freely, cannot write the envelope or task/git control state,
and should use a separate worktree for parallel work. `join` is the explicit
active-task handoff; suspended tasks continue with `resume`.

Host Hook recipes require an explicit protocol profile:

```sh
taskloop hooks --profile codex-safe
taskloop hooks --profile claude
```

`codex-safe` preserves PreToolUse deny/rewrite behavior but releases a held
Stop with zero stdout and an explanatory stderr warning; use explicit
`taskloop achieve` or an external driver for another round. `claude` preserves
Claude Code's session-internal `decision:block` continuation. The
`codex-cli-legacy` profile exposes that legacy block only as a version-pinned,
explicit experiment and must never be used in Codex App. Old no-argument Hook
commands retain PreToolUse protection but release held Stop safely and warn to
regenerate the recipe.

Proof assurance and change assurance are separate. Weak criterion inputs cause
`criterion_assurance_gap`; strengthen the criterion or explicitly record a
proof downgrade with `accept-proof-gap`. Change review is driven by declared
risk plus machine floors:

```sh
taskloop review --level fresh-context --reviewer peer \
  --blocking-findings 0 --advisory-findings 0
```

`routine` risk needs no review by default, `substantial` requires
fresh-context, and `critical` requires second-model. Use `--review-policy
required|waived` for an explicit override; every waiver requires a reason and is
audited. `status` reports `proof_assurance`, `machine_risk_floor`, and
`review_requirement` without launching a reviewer.

Runtime contract 4 uses `.taskloop/events-v3.jsonl` as the only repository
authority. `.taskloop/task.json` is a schema-v3 snapshot that may be deleted and
rebuilt; it is never promoted to authority. Every public mutation commits one
hash-chained transaction before refreshing the snapshot. Transcript byte ranges
and output-token deltas are events in that same transaction, so retries cannot
double-count a committed range.

Schema-2 tasks and orphan/mixed snapshots fail closed. Preserve an incompatible
`task.json` byte-for-byte with `archive-incompatible-state --reason ...
--granted-by user`; no v2 state is interpreted or migrated. Runtime contract 3
is not a supported rollback target after the cutover.

`~/.taskloop/outcomes-v3.jsonl` is a best-effort HOME projection, not task
authority. Rebuild it idempotently with `taskloop sync-outcomes --repo .`; use
`taskloop audit --repo .` for repository authority and `taskloop audit-outcomes`
for the HOME projection. Old `outcomes-v2.jsonl`, `transcript-cursors.json`, and
`history/` artifacts are ignored and are never removed automatically.

Persisted authority timestamps are epoch milliseconds plus UTC ISO strings.
Generated diagnostic artifact names remain local `YYYYMMDD-HHmmss` labels.

## Install and verify

```sh
node install.mjs
npm test
npm run bench:event-store -- --json
node bin/taskloop.mjs help
```

Use `TASKLOOP_INSTALL_HOME` for manual install tests. Installation distributes
the runtime, `skills/loop-core`, and `skills/workloop` as one release. It
preserves unowned, locally modified, symlinked, or externally taken-over skill
trees and deduplicates aliased Claude/Codex roots.

The installer reads user-level Codex Hook configuration only to warn about
legacy taskloop Stop commands. It never rewrites Hook configuration;
`--configure-codex` remains limited to the outcome-projection writable root.

`status`, `verify`, `report --json`, `audit`, and `info` include the independent
runtime, snapshot, event-record, and outcome-projection version fields. The
Windows release gate runs W01–W08 on Windows 2022/2025 with Node 22/24.

See [loop-core reference](skills/loop-core/REFERENCE.md) for the full contract.
