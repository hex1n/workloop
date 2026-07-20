# Criterion Adapter Contract

A criterion adapter is a read-only, idempotent translator from external
evidence to workloop's observation contract. Open it with
`--criterion-protocol tri-state`.

- exit 4 — every required item is present on fresh evidence: `satisfied`;
- exit 3 — a required item failed or is missing: `unsatisfied`;
- exit 2 — evidence is absent, malformed, or stale: `indeterminate`.
- exit 0 — the adapter was silent: `indeterminate` (`adapter_silent`).

Other exits, spawn failures, timeouts and signals are indeterminate execution
errors. The output tail must name failed items or explain why adjudication was
impossible.

This dedicated-code table is the one-time v3 cutover contract. A pre-cutover
tri-state adapter that used 0/1 must be updated before the runtime upgrade;
workloop deliberately maps 0 to `adapter_silent` and 1 to
`invalid_adapter_exit` instead of guessing an old verdict. That compatibility
failure is named in CLI and hook feedback and automatically suspends the task
as `needs_input`, so an old adapter cannot create an unbounded Stop hold.
Neither old 0 nor old 1 is reinterpreted as satisfied. Codes 3 and 4 were
previously invalid and are deliberately assigned meanings by protocol version
2; adapters must not pass through arbitrary child-process exit codes.
`workloop info` exposes `criterion_adapter_protocol_version: 2` as the
programmatic cutover signal; the broader runtime contract remains 4 because
its persisted task/event interfaces are versioned independently.

On POSIX, a `.sh` criterion with a shebang is dispatched through that declared
interpreter even when the file itself is not executable. A `.sh` file without
a shebang falls back to `/bin/sh`; use a shebang when Bash or another shell is
required. Windows rejects `.sh` criteria rather than guessing an interpreter.

Adapters may put one stable reason on stdout as
`WORKLOOP_CRITERION: <message>`. The runtime uses the last matching non-empty
line for failure identity and feedback; this line never determines the verdict.
Do not put timestamps, random identifiers, or run-specific paths in it.
Without a matching line, `signature` is intentionally null and cannot trigger
the three-identical-failures suspension. The independent seven-attempt guard
still suspends revision-stagnant unsatisfied work; intervening artifact writes
are progress and therefore reset that guard.

For seal criteria, keep three boundaries: never read an actor-writable verdict
field as business truth; obtain the unsatisfied witness from the machine-side
check; bind receipts by content fingerprint rather than a mutable status field.
Evidence and review receipts must remain with the versioned change history.

Collections require an explicit required set so missing items cannot pass
vacuously. Snapshot evidence requires a current build/data fingerprint so stale
evidence cannot pass. A live probe needs no invented fingerprint.

Adapters live with the producer or consuming project, not in loop-core. They
must never mutate state or trigger the producer: workloop reruns the adapter at
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
