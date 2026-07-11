---
name: workloop
description: >
  The one work loop for approved, machine-verifiable work. Use after a plan is
  approved or to implement/land/apply/proceed (按方案落地, 开始实现, 改), to
  diagnose and fix a live failure (排查, 定位, 根因, 修到通过, fix until green),
  or to self-drive until a criterion holds (循环到X为止, 授权一次自驱). Needs a
  machine-checkable done-when criterion and an envelope before editing. It
  consumes handoffs from any skill through a producer-agnostic contract.
argument-hint: "[approved work or failure scene + done-when criterion + optional envelope]"
---

# Workloop

One shell, three criterion sources; the only real fork is **where the red comes
from**, and the body after it is identical. If the prompt asks only for
analysis, options, or a taste-judged deliverable, do not force it through
taskloop — answer read-only or let the host pick an external skill.

`../loop-core/REFERENCE.md` defines every term this workflow names — task,
envelope, terminal states, the independence ladder, concurrency, git — so read
it for any definition below rather than expecting the definition here. Read
`../loop-core/ADAPTERS.md` before hand-writing a criterion that reads external
evidence.

## Composition Seam

Consume the handoff — `goal`, `criterion`/`criterion-file`, `alignment`,
`files`, and optional evidence/failure/resume metadata — as opaque data.
Validate those fields and run the same body whoever produced them; never
require, invoke, or branch on the upstream skill's name. An adapter using the
three-way exit contract also passes `--criterion-protocol tri-state`; ordinary
test commands stay `binary`.

## 1. Source The Criterion

Pick where the red comes from — **given** (restate the plan's check and open),
**recovered** (you hold only a failure), or **absent (keep-green)**. A
**recovered** red is earned from the world first: replay the input, fix the
environment, capture the real failure — and when an upstream producer hands you
a failure report, consume its failed items, freshness metadata, and resume
snapshot instead of re-deriving the problem from one error line.

Completion criterion: goal, envelope, and the criterion with its alignment line
are explicit — red-at-birth for a given/recovered source, or a legitimate green
birth for keep-green (steady-green) or earn-red (the red is deferred, not
absent, so the close stays barred until one red is witnessed); a recovered red
replays from the report or scene, not from memory.

## 2. Open The Task

Open with exactly one sensor form — `--criterion <command>` or `--criterion-file
<repo-relative script>` — plus `--goal`, `--alignment`, and `--files`. Prefer
the file form when the checker is already a repo script; it skips shell parsing
and fingerprints the script directly. `open` refuses an already-green criterion
(unless opened `--keep-green` or `--earn-red` with a reason) or one it cannot
execute. Do not hand-write `task.json`.

Completion criterion: the task is open; or, if the work was analysis-only and
did not belong in taskloop, that call is stated with why.

## 3. Run The Body

Make the narrowest change that can satisfy the criterion; run the smallest
relevant verification after each meaningful change; `status`-check each round
that nothing left the envelope. A **recovered** source adds a freshness gate —
replay only against the changed build/process/config/data, since a green on the
old world's evidence does not count. Keep at least two plausible causes alive
until one distinguishing check separates them.

A green criterion proves the check passed, not that the change is structurally
right. For **criterion-weak** work — where the alignment line already admits
green leaves the real done-ness unjudged — the load-bearing sensor is an
independent review, not the criterion. Take the strongest the runtime supports
(prefer second-model, then fresh-context; self-reread never counts), feed its
findings back into this body, and record it with `taskloop review --level
<...>`; record any downgrade.

Completion criterion: the criterion passes; for **criterion-weak** work, an
independent review fed its findings back and its level is recorded — including,
when the runtime forced a weaker rung than wanted, which rung was taken.

## 4. Stop Without Drifting

Close exactly one of three ways — `done`, `not_needed` (with evidence), or
`abandoned` (with reason); a `suspend` is not a close but a sticky pause that
keeps reads and verification free. Resume only with `resume --reason`; a
direction change first `amend`s the goal or criterion. Stop before touching
anything outside the envelope, and do not restart planning after approval unless
new blocking evidence appears. Continue between rounds without asking unless the
loop needs an envelope expansion, user-only input, or irreversible/high-risk
approval; the default cap is eight rounds. Autonomy across turns needs a
host-provided driver — taskloop schedules no next turn — so with none, state the
single-pass downgrade. Per-host driver and sandbox recipes live in
`../loop-core/HOSTS.md`.

Completion criterion: the loop reached a terminal state or an evidence-backed
suspension, and which one is named.

## 5. Report

Report the closeout — terminal state, the verification result or why it cannot
run, actual touched targets versus the declared envelope, evidence for every
completion claim, and remaining risks. For a suspend, add the three judgment
lines; for rework, apply the rework-log rule.

Completion criterion: a follow-up agent can continue or audit the work from the
report without rediscovering the scene or guessing why the loop stopped.
