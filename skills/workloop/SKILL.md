---
name: workloop
description: Run approved, machine-verifiable work until its criterion is satisfied and the task can reach a terminal outcome.
argument-hint: "[approved work + done-when criterion + envelope]"
---

# Workloop

Read `../loop-core/REFERENCE.md` for the shared task, observation, lifecycle,
closure, policy, review, envelope, session-ownership, budget, and git
vocabulary. Read
`../loop-core/ADAPTERS.md` before using external evidence.

## 1. Source the criterion

Make the goal, executable criterion, structured alignment and envelope
explicit. Use `default` when the criterion is currently unsatisfied,
`deferred_witness` when the failing check must be written first, and
`steady_satisfied` only for an explicitly closed guard task.

Elicit the criterion when none arrives with the work: interview the requester
for the done-when, the write envelope, and the not-covered gaps — the
interview's product is the open command. Never invent a check to make the
gate pass; `open` structurally requires an executable check, so when no honest
criterion exists yet, stay out of the loop and ask — the interview comes
first. Provenance maps to policy: a given check opens `default`;
recovering the failure first — writing the failing check before the fix —
opens `deferred-witness`; an absent criterion guarding a steady state opens
`steady-satisfied`.

## 2. Open

Open exactly one command or criterion file:

```text
taskloop open --goal "<goal>" --criterion "<check>" \
  --criterion-policy default \
  --alignment-because "<coverage>" --not-covered "<gap>" \
  --files "<glob>"
```

The task must open with a determinate observation allowed by the policy.
Indeterminate refuses creation. Do not hand-write task state. When the
repository already holds an active task from another host session, take it
over with `join --reason` or work in a separate worktree; continue a
suspended task with `resume --reason`.

## 3. Work

Make the narrowest aligned change, run focused checks, and inspect `status`
after each meaningful write. Criterion unsatisfied guides the next round;
criterion indeterminate means repair evidence or environment, not product work.
Never weaken or mutate the criterion to obtain satisfied.

After roughly three consecutive unsatisfied rounds on the same cause, suspend
as stuck with the dead-end list and resume in a fresh session: task state
survives the context switch, and a clean session with a sharper prompt beats
grinding polluted context.

Read `status` after the last substantive write. A `criterion_assurance_gap`
requires a stronger criterion or an explicit `accept-proof-gap`; reviewer prose
cannot repair machine proof. When `review_requirement.level` is non-null and
not accepted, ask a reviewer at least that independent (`fresh_context` or
`second_model`), feed blocking findings back into the loop, then record the
current generation/revisions and blocking/advisory counts with `review`.
taskloop only emits the requirement; reviewer scheduling belongs to the host.
Feed only blocking findings back; never widen the envelope to chase advisory
findings.

### Steering

Mid-loop requester input maps to one verb. A clarification is a plain
revision — absorb it, restate the updated envelope, continue. A goal change
is `amend --goal --reason`. A criterion change is `amend --criterion --reason`
and a policy change is `amend --criterion-policy --reason` (either way a new
generation is minted; old witnesses and reviews expire). An envelope extension
is `amend --files --reason` (risk recomputes).
A different objective altogether closes this task (`abandon --reason`) and
opens a new one. Queueing later work belongs to the driver, not the loop.

## 4. Close without drift

Automatic policy closes on a fresh satisfied Stop only when closure is
eligible. Explicit policy uses `achieve`. Otherwise choose exactly one honest
path: `not-needed --evidence` before writes, or `abandon --reason`. Suspension
is a pause, not a terminal outcome, and requires a complete judgment snapshot.
A `needs_input` suspension must carry instructions the human can execute
verbatim.

## 5. Report

Name the terminal lifecycle, criterion evidence, actual touched targets versus
the declared envelope, reviews and advisory findings, not-covered clauses, and
remaining risks. Include actual rounds, writes, wall-clock time, and estimated
output-token use against their configured limits. Mark unbounded limits and
unavailable or degraded telemetry explicitly; token accounting is a best-effort
estimate. A follow-up agent must be able to audit the result without
reconstructing the scene.
