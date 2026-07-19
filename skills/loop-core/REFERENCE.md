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
still be held by drift, a missing unsatisfied witness, a criterion assurance
gap, or an unaccepted change review. Command exit codes are mapped at the execution boundary; tri-state
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
held(sensor_drift | unsatisfied_not_witnessed | criterion_assurance_gap | change_review_unaccepted)
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

No other tuple is valid in schema v3. Non-default policies require a rationale.
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
  --files "<glob>" \
  --risk routine|substantial|critical --risk-reason "<why>" \
  --change-class internal|public-contract|schema|security|permissions|migration \
  --review-policy risk-based|required|waived
```

Use `deferred-witness --reason` when the failing check still needs to be
written. Use `steady-satisfied --reason` for a guard or observation task whose
normal birth observation may already be satisfied.

The envelope authorizes writes; it does not exempt proof inputs. Exact
`--criterion-subject` paths are explicit trust exemptions for files that are
both criterion inputs and intended work. They must remain inside the envelope
and cannot name the criterion file itself.

## Assurance and review acceptance

Proof assurance and change assurance are orthogonal. Criterion shape and path
do not establish trust. `criterion.authored_by` records the author claim, while
the proof hold is raised only when a criterion or policy is amended after an
artifact write. A review never removes that hold. Strengthen the criterion, or
explicitly record the downgrade with `accept-proof-gap --reason ...
--granted-by user|self`; the latter makes proof provisional and raises the
machine risk floor to substantial.

Criterion authorship uses its own `--criterion-authored-by self|user` flag and
defaults to `self`; `--granted-by` is reserved for grant, waiver, and risk
provenance. Authorship is an audit claim, not a gate. Failure identity is also
explicit: binary and tri-state criteria must emit a stable
`TASKLOOP_CRITERION: <message>` stdout line to participate in the
three-identical-failures suspension. Without it the signature is null; the
seven-attempt revision-stagnation guard and configured round budget remain.

Tasks declare `routine`, `substantial`, or `critical` risk. The default is
substantial. Under `risk-based`, routine needs no review, substantial requires
fresh-context, and critical requires second-model. `required` names an explicit
minimum level; `waived` requires a reason and remains visible in the ledger,
but it cannot erase a non-routine machine floor. The close-time floor reads
actual touched roots, broad touched-file sets, unattributed writes, actual
command shapes, post-write criterion/policy amendments, and proof acceptance.
Unused grants and `change_classes` remain declaration records rather than gate
keys. Actual publish/shared-push shapes are critical. Raw host permission mode
is recorded; the kernel consumes only its `bypassPermissions`/other projection.

This observed-use floor is intentionally conditional on an active PreToolUse
sensor. Unknown or gapped sensor coverage remains ledger integrity metadata; it
does not invent an authority use or silently replace the task's declared risk.
On a Stop-only or plain CLI host, choose the declared risk and explicit review
policy accordingly because taskloop cannot observe or mediate tool calls. An
explicit waiver may therefore waive declared risk when no authority use was
observed; an unused grant does not raise the machine floor.

A destructive grant is either full (`--destructive-allowed`) or path-scoped
(`--destructive-scope <root>`, repeatable, literal paths only). A scoped grant
covers only rm commands whose every target canonicalizes — symlinks resolved,
no variables, globs, or `~` — inside a granted root; every other destructive
shape and every unprovable target fails closed to a deny. In-scope use is
attributed cleanup: the ledger records the resolved targets and the machine
floor does not rise, while full-grant destructive use still prices as
substantial.

Evidence append failures intentionally burn their reserved sequence number:
the resulting gap means an observation was lost and must not be hidden by
number reuse. Ledger consumers must treat evidence-derived negatives as
tri-state. When the
bounded stream is corrupt, gapped, or truncated, unanchored-review claims and
unseen authority-use history are `unknown`, never an empty list or `false`.

An accepted review is bound to the current `criterion_generation_id`, last
substantive task revision, and artifact revision, with zero blocking findings
and at least the requested level. `self_reread` is telemetry only. Every write
and substantive amendment expires review acceptance. Runtime status exposes
`proof_assurance`, `machine_risk_floor`, and `review_requirement`; the runtime
never launches a reviewer.

```text
taskloop review --level second-model --reviewer <id> \
  --blocking-findings 0 --advisory-findings 1
```

CLI enums use kebab-case; persisted enums use snake_case.

## Suspension and structural work

Suspension is sticky. Stop releases without mutation; reads and `verify` remain
free; writes and terminal-success verbs require `resume --reason`. An
out-of-budget task must first use `amend` to increase every task-level budget
that remains exhausted. After a fresh unsatisfied criterion, any exhausted
round, write, wall-clock, or output-token budget takes precedence over stuck
classification; a fresh satisfied criterion remains eligible to close.

A structural criterion asserts the whole move: the removal, absence of live
references, and the new positioning where ownership lives. Checking only that
one file disappeared is not sufficient.

## Session ownership

The latest episode owns the active task and its envelope when its
`host_session_id` is a real host identity. A foreign session reads and
verifies freely; its Stop hooks release without criterion execution or
telemetry mutation, and its writes to the envelope or runtime/git control
state are refused. Provably outside-envelope work follows the untracked path;
parallel work belongs in a separate worktree. Empty, missing, whitespace, or
`cli` episode
identities are unbound and retain gate-all compatibility.

Two verbs move ownership: `join --reason` transfers an active task to the
current session; `resume --reason` continues a suspended one. Ownership stays
bound to the host session, while episode-less authority changes such as
`amend`, `accept-proof-gap`, and `review` record the injected acting agent when
the host exposes one.
`TASKLOOP_SESSION_ID` is an explicit override and must carry an identity from
the host hook payload's domain. Per-host binding mechanics are in
[HOSTS.md](HOSTS.md).

## State, projection, and hard cutover

Runtime contract 5 treats `.taskloop/events.jsonl` as the only repository
authority. `task.json` is a disposable schema-v3 snapshot; missing or damaged
snapshots rebuild from the event genesis, while internal event corruption fails
closed. Schema-2 and orphan/mixed snapshots are never interpreted or migrated.

Contract 5 removes schema versions from active artifact names, not from their
content. If the runtime reports legacy versioned names, preserve both names and
run `migrate-artifact-names --repo <repo> --reason <reason> --granted-by user`;
it refuses ambiguous dual-name authority.
Preserve an incompatible snapshot byte-for-byte with explicit authorization:

```text
taskloop archive-incompatible-state --repo <repo> \
  --reason "runtime-contract-5 hard cutover" --granted-by user
```

The runtime projects repository events to `~/.taskloop/outcomes.jsonl` on a
best-effort basis. Task adjudication never reads that projection. Rebuild it
with `sync-outcomes --repo`; audit repository authority with `audit --repo` and
the HOME projection with `audit-outcomes`. A HOME failure never rolls back a
committed repository event. Runtime contract 3 is not a rollback target.

Old `outcomes-v2.jsonl`, `transcript-cursors.json`, and `history/` artifacts are
non-authoritative diagnostics: runtime 5 ignores them and never auto-deletes
them.

Git mutations still require explicit user intent and an envelope grant.
