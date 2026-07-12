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
budgets deny further writes while keeping reads and verification available.
Repeated equivalent failures suspend as `stuck`; exhausting rounds suspends as
`out_of_budget`.

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
taskloop not-needed --evidence "read-only probe showed the goal already holds"
taskloop abandon --reason "superseded"
```

Weak sensors require an accepted independent review on the current
`criterion_generation_id` and artifact revision:

```sh
taskloop review --level fresh-context --reviewer peer \
  --blocking-findings 0 --advisory-findings 0
```

`task.json` is schema v1 only. Archive an incompatible task without interpreting
it using `archive-incompatible-state --reason ... --granted-by user`, then open
a new task. The new runtime writes only `~/.taskloop/outcomes-v1.jsonl`.

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
