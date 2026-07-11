# Loop Core

Shared reference for the `workloop` skill and for any external skill that
composes with taskloop through this contract. This directory intentionally has
no `SKILL.md`: it is supporting material, not an invocable workflow. The loop
system is **taskloop** (`~/bin/taskloop.mjs`); this file is its shared vocabulary,
organized around the task-first object model.

## The Task

The **task** is the durable unit of one loop run. Everything else — episodes, rounds, evidence — lives underneath it.

- **Goal**: the user-visible outcome, stated without naming an implementation unless the user already approved one.
- **Criterion**: a machine-checkable done-when (see *Sourcing The Criterion*). There is no claim-based success — green always comes from a fresh criterion run.
- **Alignment**: one required line — "green ⇒ goal because <what the check exercises>; not covered: <gaps>" (see *Criterion-Goal Alignment*).
- **Envelope**: the files/tables/interfaces/git surface the task may touch (see *The Envelope*).
- **Budgets**: rounds (default eight), and opt-in writes / wall-clock / output tokens — all **task-level**, never refilled by resuming (see *Episodes, Suspend, And Resume*). Token spend is tallied per episode from the runtime transcript (best-effort telemetry) and lands on the outcome ledger as `output_tokens_estimate`, so external analysis can see what a loop costs, not just whether it closed green.

Task state lives in `.taskloop/task.json`, created only by `taskloop open`. It is gitignored, private to the loop, and **non-authoritative** — never a project policy source. **Evidence** for any completion claim is real tool output, status/diff, command output, SQL/API response, read-only verification, or an execution report. Prose alone is not evidence.

## Skill Composition Seam

taskloop composes through data, not routing. Any upstream skill may produce a
goal, executable criterion (or criterion file), alignment line, write envelope,
and optional evidence/resume metadata. `workloop` validates that handoff and
drives the task without knowing who produced it. No upstream skill name is part
of taskloop's interface, and taskloop never requires a planner, test framework,
reviewer, report format, or scheduler to be installed.

When an evidence format needs interpretation, keep its producer outside the
core and provide a read-only criterion adapter satisfying
[ADAPTERS.md](ADAPTERS.md). Adapters translate external evidence into the stable
exit-code contract while the loop state machine remains unchanged. Declare that
contract with `--criterion-protocol tri-state`; binary remains the default for
ordinary commands whose exit 2 is a failure.

## Sourcing The Criterion

The only real fork in the work loop is where the red comes from:

- **given** — the approved plan already carries the check.
- **recovered** — reproduce the failure first; the red is earned from the world, not declared.
- **absent (keep-green)** — a verification task whose criterion is legitimately green; open with the keep-green reason. Green is such a task's steady state, not a success event: the stop gate never auto-closes it, only the explicit verbs (`done`, `not-needed`, `abandon`) do — a red, by contrast, is the regression alarm and burns rounds as usual.

Open the task with:

```text
node ~/bin/taskloop.mjs open --repo <repo> --goal "<one line>" \
  --criterion "<executable check, red until done>" \
  [--criterion-protocol binary|tri-state] \
  --alignment "green ⇒ goal because <...>; not covered: <...>" \
  --files "<glob>" [--rounds 8] [--writes N] [--wall-clock-minutes M] [--token-budget T]
```

`taskloop open` runs the criterion once and refuses an already-green start (red at birth — an already-green criterion cannot prove the task) or one the machine cannot execute. Do not hand-write `task.json`; the CLI owns it. Prefer a **criterion adapter** over a hand-written check when the done-when reads evidence produced elsewhere; the adapter interface in [ADAPTERS.md](ADAPTERS.md) makes the known traps — vacuous pass, stale green, collapsed verdicts — unrepresentable. Adapters live with their evidence producer or consuming project; taskloop ships no format-specific adapter.

Red-at-birth is the strict default, but the invariant it enforces is not "red at open" — it is *a green close requires the criterion to have been witnessed red at least once on this sensor*. When the failing check does not exist yet (the write-the-failing-check-first flow: an aggregate criterion — a test suite, an assertion set, a lint gate, whatever the project runs — still passes until you add the case that fails), open with `--earn-red --reason <why no red exists yet>`. The task opens on green but the close stays **barred** until one red is witnessed by a metered gate — a red Stop gate or a red `done` (a read-only `verify` stays free and does not flip the witness) — after which a fresh green closes it. A never-red task runs out of budget rather than closing, so the discrimination proof cannot be skipped, only deferred. `--earn-red` and `--keep-green` are opposite intents (a red still to come vs. a green steady state) and cannot combine. Amending the criterion resets the witness: the red vouched for the old sensor, so the moved one must earn its own. The state rides the ledger as `earn_red` / `red_witnessed`.

The criterion's own input files are fingerprinted at open; a green whose check files changed since (editing the test instead of the code) is a moved sensor, not a proof — both close doors refuse it until the move is re-blessed through `amend --criterion --reason`, which re-fingerprints. The drift event stays on the outcome ledger as `criterion_input_drift` even after the re-bless.

When the criterion reads the very file the task rewrites — a marker written into a doc, a migration whose check greps its own output — that file's change is the work, not a moved sensor. Declare it with `--criterion-subject <repo-relative file>` (at open or `amend`): its change is exempt from the drift refusal, while every other input still trips it. The exemption is a trust grant, never an inference — it names exact files (no globs), must sit inside the envelope, and can never be the criterion file itself; a checker moves only through `amend --criterion`. Envelope membership is necessary but not sufficient: write permission and proof exemption are separate authorizations, granted separately and recorded separately (`self`/`user`). The declaration rides the ledger (`criterion_subject`, `criterion_subject_changed`), the close echoes each exempt change with whether it was machine-witnessed, and amending the criterion drops the exemption bound to the old check.

## Criterion-Goal Alignment

Red-at-birth proves the criterion can tell "done" from "not started"; it cannot prove the criterion covers the goal. A weak criterion (a file exists, a command merely runs) turns the stop gate into a rubber stamp.

- The `--alignment` line is required at open. If the honest line is "green proves little", strengthen the criterion before starting.
- Verification outside the machine criterion (slow suites, manual checks, deployment smoke) must be named in the alignment line and reported as closeout evidence, not silently dropped.
- At closeout, re-read the alignment line: when the work revealed the criterion under-covers the goal, `amend` it with a reason — or report the gap — before claiming `done`.

Two-domain fit: a backend loop whose criterion runs focused API tests but not the data backfill it also changed; a docs loop whose criterion checks that links resolve but not that the new section renders in the published site.

### The Independence Ladder (a second sensor for criterion-weak work)

The criterion is the loop's one sensor, and it is self-administered: the same agent runs it, reads the verdict, writes `done`. That is enough when the criterion is objective and complete (a given test for a bug fix). It is not enough for **criterion-weak** work — refactors, migrations, design-shaped changes — where the machine check passes while the real done-ness (structure, coverage, "is this the right thing") goes unjudged. There the load-bearing sensor is an **independent review**, and its value scales with how uncorrelated the reviewer's failure modes are with the author's:

- **self-reread** — never independent; the author's context is what is compromised.
- **fresh-context** — a read-only reviewer with only the artifact and the standard, none of the authoring context; washes session-state contamination (optimism, sunk cost, tunnel vision), not model-level blind spots.
- **second-model** — a different model; washes model-level blind spots too. Prefer it when available.

Record the level reached with `taskloop review --level <second-model|fresh-context|self-reread>`. The engine records the provenance (which level, not a verdict — a review is a probabilistic signal fed back into the loop body, never a machine gate) so the outcome ledger shows how independently each task was checked; external analysis can compare review independence with rework. When the runtime cannot supply the strongest level, drop a rung and record the downgrade. The ledger's `review_level` is the strongest level *ever* recorded on the task, not tied to the closed state — so review late, after the last substantive edit, or it can overstate what actually closed.

## The Envelope

The envelope is the write boundary, declared at open and enforced by the PreToolUse hook. Writes outside it are denied; **reads are never blocked**, so a task can always still read and verify. The opt-in write, wall-clock, and token budgets bound the never-stopping side, and reads and verification commands never burn or hit them.

Every authority expansion — destructive, network, install scripts, a git op, a whole-repo envelope — is recorded on the task as a **grant with provenance**: `self` unless the human's blessing is recorded with `--granted-by user`. The machine cannot verify the judgment behind an expansion, only who made it; the ledger's `self_granted` count makes self-authorized power visible to external analysis. Provenance is a record, never a gate.

Run `git add`, `commit`, `push`, `reset`, `restore`, `checkout`, or `clean` only after the user explicitly asks, and only when the envelope authorizes it — `open`/`amend` with `--git-allowed <op> --git-reason <why>`. Destructive git, remote execution (`curl | sh`), install scripts, and secret dumps stay denied unless the envelope opens them. Destructive operations still require explicit user intent even when authorized.

## Episodes, Suspend, And Resume

An **episode** is one continuous run of a task under a single session. Budgets are task-level, so resuming never refills them — repeated equivalent failure suspends as `stuck`; the round cap suspends as `out_of_budget`; missing input suspends as `needs_input`.

Suspend is **not a closure** — the task stays open with a sticky `suspension` object. Writes pause; reads and verification stay free. Clear it only with `resume --reason <what changed>`; a direction change first uses `amend --goal/--criterion --reason`. A user suspend closes the current episode; a machine suspend does not invent a session boundary. The snapshot has two halves: the machine records changed files, while the human supplies the three judgment lines (remaining criterion, current failure, next safe action). The machine also keeps the **attempt ledger**; the next real episode's banner repeats the current goal, snapshot, and dead ends. A different session supersedes the previous episode rather than sharing it.

## Terminal States

A task closes exactly one of three ways; only the first is machine-written:

| State | Meaning |
| --- | --- |
| `done` | Criterion green from a fresh run (the stop gate or the `done` verb). The only machine-written success. |
| `not_needed` | Read-only verification showed no change was needed (`not-needed --evidence`). |
| `abandoned` | Superseded or dropped (`abandon --reason`). |

`taskloop open` also writes a `state: open` row to the outcome ledger, and the terminal row carries the same task id — so a task that vanishes without a closing verb (state dir deleted, work silently dropped) remains visible as an open with no matching close.

The stop gate never writes success on a red criterion. `stuck` and `out_of_budget` create sticky suspension events while the task remains open; an `out_of_budget` run whose every round failed differently is reported as still-moving. Raise the round budget with `amend --rounds --reason` before `resume --reason` when more writes are needed.

## Concurrency

Default to one writer task per worktree. For parallel work use separate git worktrees — each carries its own `.taskloop/` task, and one integrator session owns the cross-worktree git operations and merges after each writer's task reaches a terminal state. There is no shared-worktree partitioned mode: a second writer gets its own worktree, not a claim inside yours.

## Closeout And Rework

Every closeout report includes the terminal state; the done-when verification result or why it cannot run; the actual touched targets (machine-observed in `evidence.touched_files`) versus the declared envelope; evidence links or command outputs for completion claims; remaining risks; and, for a suspend, the three judgment lines.

Treat a task as rework when it repairs previously delivered work or resumes a prior non-green close. If the target repo has `docs/rework-log.md` or its workflow contract names that file, append a compact rework cause line; otherwise include the rework cause in the closeout report. The default round budget is eight unless the user or target repo states a different cap.

## Structural Tasks (delete, rename, migrate)

The visible act of a structural task — a file removed — is only one part of the
move; a criterion that checks only that part goes green while stale references
and the old positioning survive (the observed shape: a migration "done" with the
old files still present and the README still pointing home). A structural
criterion must assert the *whole* move: the removal, the absence of any live
reference to what moved, and the new positioning stated where ownership lives.

## Generalization Samples

These primitives must fit at least two different domains:

- backend sample: change an API handler, verify with focused tests and a response assertion;
- frontend sample: change a UI workflow, verify with a browser check and DOM or screenshot evidence.

Rules that only fit one project, product, table name, enum, or business term do not belong in this shared reference.
