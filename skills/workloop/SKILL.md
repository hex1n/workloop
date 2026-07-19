---
name: workloop
description: Run approved, machine-verifiable work until its criterion is satisfied and the task can reach a terminal outcome. Use when work arrives with an executable done-when check, when a taskloop nudge or deny routes untracked work here, or when a fix must first recover the failure as a failing check.
argument-hint: "[approved work + done-when criterion + envelope]"
---

# Workloop

Read `../loop-core/REFERENCE.md` for the shared task, observation, lifecycle,
closure, policy, review, envelope, session-ownership, budget, and git
vocabulary. Read
`../loop-core/ADAPTERS.md` before using external evidence.

## 1. Source the criterion

Open the task before the first product write. Make the goal, executable
criterion, structured alignment, and envelope explicit. Provenance picks the
policy: a check that arrives with the work opens `default`; investigation and
diagnosis work writes the read-only failing check first, observes the expected
failure, and opens `deferred-witness`; a guard task over an already-satisfied
steady state opens `steady-satisfied`, where closure stays explicit.

When no criterion arrives with the work, interview the requester for the
done-when, the write envelope, and the not-covered gaps — the interview's
product is the open command. Never manufacture a check to make the gate pass:
`open` structurally requires an executable check, so when no honest one
exists, stay outside the loop and ask, or choose a judgment workflow.

At admission ask whether the criterion can run unattended tonight and whether
the machine can reach the business truth. If either answer is no, do not treat
an unattended run as eligible. When truth exists but only an artifact shadow is
machine-reachable, declare a seal task up front: machine-side criterion,
fingerprint binding, receipt plan, and the later acceptance path. Seal and
review receipts belong in version control with the artifact history.

## 2. Open

Prefer a dedicated repository-relative `.mjs` criterion that emits one bounded
`TASKLOOP_CRITERION: ...` summary on stdout and exits with the tri-state
protocol (4 satisfied, 3 unsatisfied, 2 indeterminate). This avoids shell-text
transport and keeps the failure identity portable. Open it with:

```text
taskloop open --goal "<goal>" --criterion-file "acceptance.mjs" \
  --criterion-protocol tri-state --criterion-policy default \
  --criterion-authored-by self \
  --alignment-because "<coverage>" --not-covered "<gap>" \
  --files "<glob>"
```

Inline binary criteria remain available for simple local checks, but they are
not the canonical portable recipe.

Declare foreseeable authority at open. Work that will delete files it creates
— scratch fixtures, generated trees — should request a path-scoped destructive
grant up front (`--destructive-scope <root> --reason`): in-scope cleanup
prices as ordinary work, and an unused grant stays a declaration record either
way. Reserve `--destructive-allowed` for deletions that cannot be confined to
declared roots. Fixtures placed under the host's transient scratch area need
no cleanup at all: leave them for the host to reap.

The task must open with a determinate observation allowed by the policy;
indeterminate refuses creation. Do not hand-write task state. When the
repository already holds an active task from another host session, take it
over with `join --reason` or work in a separate worktree; continue a
suspended task with `resume --reason`.

## 3. Work

Make the narrowest aligned change, run focused checks, and inspect `status`
after each meaningful write. Criterion unsatisfied guides the next round;
criterion indeterminate means repair evidence or environment, not product work.
Never weaken or mutate the criterion to obtain satisfied.

A command-safety deny mid-loop is an authority gap: the message names the
`amend` flag that lifts it. Either drop the effect — prefer leaving transient
files in place over deleting them — or record the narrowest grant that covers
the work (a scoped root over full destructive authority) and continue.

After roughly three consecutive unsatisfied rounds on the same cause, suspend
as stuck with the dead-end list and resume in a fresh session: task state
survives the context switch, and a clean session with a sharper prompt beats
grinding polluted context.

Read `status` after the last substantive write. A `criterion_assurance_gap`
requires a stronger criterion or an explicit `accept-proof-gap`; reviewer prose
cannot repair machine proof. When `review_requirement.level` is non-null and
not accepted, ask a reviewer at least that independent (`fresh_context` or
`second_model`), feed the blocking findings — only the blocking ones; never
widen the envelope to chase advisory findings — back into the loop, then
record the current generation/revisions and blocking/advisory counts with
`review`. taskloop only emits the requirement; reviewer scheduling belongs to
the host.

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
