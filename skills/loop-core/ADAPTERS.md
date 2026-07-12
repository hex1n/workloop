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
