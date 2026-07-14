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

`task.json` is schema v2 only. Archive an incompatible task without interpreting
it using `archive-incompatible-state --reason ... --granted-by user`, then open
a new task. The new runtime writes only `~/.taskloop/outcomes-v2.jsonl`.
Persisted taskloop times use local wall-clock `YYYY-MM-DD HH:mm:ss`; generated
artifact names use `YYYYMMDD-HHmmss`. Both forms are intentionally
timezone-free and second-granular.

## Install and verify

```sh
node install.mjs
npm test
node bin/taskloop.mjs help
```

Use `TASKLOOP_INSTALL_HOME` for manual install tests. Installation distributes
the runtime, `skills/loop-core`, and `skills/workloop` as one release. It
preserves unowned, locally modified, symlinked, or externally taken-over skill
trees and deduplicates aliased Claude/Codex roots.

See [loop-core reference](skills/loop-core/REFERENCE.md) for the full contract.
