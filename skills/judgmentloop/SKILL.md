---
name: judgmentloop
description: Run a taste-based deliverable through a pre-registered rubric, independent review, and explicit human acceptance as the terminal verb.
argument-hint: "[deliverable + rubric + envelope]"
---

# Judgmentloop

Read `../loop-core/REFERENCE.md` for the shared task, observation, lifecycle,
closure, policy, review, envelope, session-ownership, budget, and git
vocabulary. Read `../loop-core/ADAPTERS.md` for the adapter contract this loop
depends on. Use this loop when the deliverable is judged by taste — prose,
design, naming, teaching material — and the done-when cannot be a plain
machine check. If no rubric can be written at all, the work is exploratory:
do not open a loop, just work.

## 1. Pre-register the rubric

Write the rubric before drafting: the named qualities the deliverable must
show, each concrete enough that a reviewer can point at a passage and say
which quality it fails. The rubric lives inside the adapter itself — one
criterion file that states the qualities and reads the recorded human
verdict — so `--criterion-file` fingerprints rubric and adjudication logic
together at open: a rubric rewritten mid-loop to fit the draft is a new
generation, never a silent edit.

## 2. Open

Open with the rubric-bearing adapter as the criterion (`--criterion-file`
with `--criterion-protocol tri-state`) and `steady-satisfied --reason` as the
policy: adjudication is human, so closure stays explicit and Stop never
auto-closes. The birth observation is unsatisfied — acceptance does not hold
yet — which is determinate and honest. The envelope names the deliverable
files; the criterion file stays outside the envelope.

## 3. Draft against the rubric

Draft, then self-check each rubric quality before asking anyone else. The
adapter reads recorded adjudication evidence, not the draft itself: with no
verdict recorded it reports unsatisfied, because the done-when — human
acceptance — does not hold yet; indeterminate is reserved for a malformed or
stale adjudication record. Do not fabricate acceptance evidence to move it.

## 4. Independent review before acceptance

Ask at least a `fresh_context` reviewer to judge the draft against the
pre-registered rubric only, then feed blocking findings back into the draft
and record the review. Reviewer prose never substitutes for the human
verdict; it earns the right to ask for one.

## 5. Human acceptance closes

The terminal verb belongs to the human. Record their verdict through the
adapter (accepted, rejected with reasons, or cannot-judge), rerun the
criterion fresh, and close with `achieve` only on satisfied. Rejection
reasons are the next round's input. Report as workloop does: lifecycle,
rubric generation, reviews, touched targets versus envelope, and what the
rubric never covered.
