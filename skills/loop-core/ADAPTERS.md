# Criterion Adapter Contract

A criterion adapter is a read-only, idempotent translator from external
evidence to taskloop's observation contract. Open it with
`--criterion-protocol tri-state`.

- exit 0 — every required item is present on fresh evidence: `satisfied`;
- exit 1 — a required item failed or is missing: `unsatisfied`;
- exit 2 — evidence is absent, malformed, or stale: `indeterminate`.

Other exits, spawn failures, timeouts and signals are indeterminate execution
errors. The output tail must name failed items or explain why adjudication was
impossible.

Collections require an explicit required set so missing items cannot pass
vacuously. Snapshot evidence requires a current build/data fingerprint so stale
evidence cannot pass. A live probe needs no invented fingerprint.

Adapters live with the producer or consuming project, not in loop-core. They
must never mutate state or trigger the producer: taskloop reruns the adapter at
every close door and rejects any repository side effect.

## Human adjudication

A human is a tri-state sensor read through a rubric-bearing adapter: one
criterion file that states the pre-registered rubric and reads the recorded
verdict. Acceptance holds — `satisfied`; acceptance does not hold, whether
rejected with reasons or simply not adjudicated yet — `unsatisfied`; the
adjudication record is malformed, stale, or the human cannot judge —
`indeterminate`. Fingerprinting that one file makes a mid-loop rubric rewrite
a new generation. Pair it with an explicit-close policy: the terminal verb
stays with the human.
