# Loop Core

taskloop supervises one durable **task**. A task owns a goal, executable
criterion, structured alignment, write envelope, budgets, evidence, reviews,
attempts, and episodes. The runtime is `~/bin/taskloop.mjs`; task state is
private repository state under `.taskloop/`, never project policy.

## Criterion observations

The criterion has exactly three observations:

- `unsatisfied`: the done-when does not hold yet;
- `satisfied`: the done-when holds now;
- `indeterminate`: the runtime cannot adjudicate it.

Criterion satisfied is not task achieved. A fresh satisfied observation may
still be held by drift, a missing unsatisfied witness, or an unreviewed weak
sensor. Command exit codes are mapped at the execution boundary; tri-state
adapters follow [ADAPTERS.md](ADAPTERS.md).

Every criterion definition has a stable `criterion_definition_hash` and a
non-reusable `criterion_generation_id`. Any criterion, policy, declared-input,
or trust-exemption amendment creates a new generation. Witnesses and reviews
bind to the generation and never carry across that boundary.

Criterion execution is read-only. The runtime snapshots tracked and untracked
repository content before and after every open, Stop, `verify`, and `achieve`
run. A changed path makes the observation indeterminate with
`criterion_side_effect`; on an existing task it also advances artifact and
substantive revision so old reviews expire.

## Lifecycle and closure

Lifecycle is a closed sum type:

```text
active
suspended(needs_input | stuck | out_of_budget)
terminal(achieved | not_needed | abandoned)
```

Closure is derived only for active tasks:

```text
not_ready(criterion_unobserved | criterion_unsatisfied | criterion_indeterminate)
held(sensor_drift | unsatisfied_not_witnessed | weak_sensor_unreviewed)
eligible
```

`eligible` is advisory. Automatic policy closes only when a Stop runs the
criterion again and still sees satisfied. Explicit policy closes only through
`achieve`, which also runs the criterion again. `not-needed --evidence` and
`abandon --reason` are separate terminal paths; not-needed is allowed only
before any witnessed write.

## Criterion policies

The CLI accepts three named policies and persists only their tuple:

| CLI | Stored name in discussion | Open | Witness | Close |
|---|---|---|---|---|
| `default` | `default` | unsatisfied | required | automatic |
| `deferred-witness` | `deferred_witness` | determinate | required | automatic |
| `steady-satisfied` | `steady_satisfied` | determinate | none | explicit |

No other tuple is valid in schema v1. Non-default policies require a rationale.
Default open takes its unsatisfied witness immediately. Deferred witness can
open satisfied, but closure remains held until a metered Stop or `achieve`
observes unsatisfied. Diagnostic `verify` never records an observation,
witness, attempt, or round. Steady satisfied never auto-closes on Stop.

## Opening a task

```text
node ~/bin/taskloop.mjs open --repo <repo> --goal "<outcome>" \
  (--criterion "<command>" | --criterion-file <repo-relative-file>) \
  --criterion-policy default \
  --alignment-because "<what the check exercises>" \
  --not-covered "<gap>" \
  --files "<glob>"
```

Use `deferred-witness --reason` when the failing check still needs to be
written. Use `steady-satisfied --reason` for a guard or observation task whose
normal birth observation may already be satisfied.

The envelope authorizes writes; it does not exempt proof inputs. Exact
`--criterion-subject` paths are explicit trust exemptions for files that are
both criterion inputs and intended work. They must remain inside the envelope
and cannot name the criterion file itself.

## Review acceptance

Weak sensors are those outside the repository or without full declared-input
coverage. They require a review at `fresh_context` or `second_model`, bound to
the current `criterion_generation_id`, last substantive task revision and
artifact revision, with zero blocking findings. `self_reread` is telemetry only.
Every write-shaped call and every substantive amendment expires the review.
`achieve --provisional` may bypass only `weak_sensor_unreviewed`, never drift or
a missing witness.

```text
taskloop review --level second-model --reviewer <id> \
  --blocking-findings 0 --advisory-findings 1
```

CLI enums use kebab-case; persisted enums use snake_case.

## Suspension and structural work

Suspension is sticky. Stop releases without mutation; reads and `verify` remain
free; writes and terminal-success verbs require `resume --reason`. An
out-of-budget task must first increase its task-level budget with `amend`.

A structural criterion asserts the whole move: the removal, absence of live
references, and the new positioning where ownership lives. Checking only that
one file disappeared is not sufficient.

## State, ledger, and upgrade

`task.json` accepts only `schema_version: 1`. Incompatible state is never
interpreted or migrated. Preserve it byte-for-byte with explicit authorization:

```text
taskloop archive-incompatible-state --repo <repo> \
  --reason "upgrade to schema v1" --granted-by user
```

The runtime writes only `~/.taskloop/outcomes-v1.jsonl`. Ledger events use
`event_schema_version: 1`; task adjudication never reads the ledger. Appends are
best-effort and report task id, revision, and allocated sequence on failure.
`audit` reports gaps as incomplete telemetry and isolates corrupt rows.

Git mutations still require explicit user intent and an envelope grant. Use one
writer per worktree. Host-specific binding is in [HOSTS.md](HOSTS.md).
