# Criterion Adapter Contract

The done-when criterion is the loop's only sensor. Hand-written checks have
three known correctness traps, observed in real loops rather than imagined:

1. **Vacuous pass** — a check like "all reported items passed" passes when a
   required item is missing from the report entirely.
2. **Stale green** — the evidence predates the current build/state, so the
   check passes on yesterday's world.
3. **Collapsed verdicts** — "cannot adjudicate" (evidence absent, malformed,
   stale) gets reported as pass or as failure, sending the loop body the
   wrong next move.

A **criterion adapter** is a read-only checker whose interface makes those
traps unrepresentable. This file is the socket; adapters are the plugs, and
new plugs are built only when a real criterion-writing failure warrants one.

## Interface requirements

Any adapter pluggable into the stop gate must satisfy all of:

- **Read-only and idempotent.** The gate re-runs the criterion on every stop;
  the adapter must never mutate state or trigger the evidence producer. A Python
  adapter sets `PYTHONDONTWRITEBYTECODE=1` so re-running it leaves no
  `__pycache__` in the tree.
- **Three-way exit code.**
  - exit 0 — every required item passed on fresh evidence;
  - exit 1 — a required item failed or is missing (fix the work);
  - exit 2 — cannot adjudicate: evidence absent, malformed, or stale
    (regenerate the evidence; do not touch the work). Exit 2 exists so the
    loop body can tell "the code is wrong" from "the proof is missing".
- **Failing items named in the output tail.** The gate re-injects only the
  output tail as feedback; the adapter's last lines must say what failed or why
  it could not adjudicate, not just print a count.

Open an adapter-backed task with `--criterion-protocol tri-state`. The default
`binary` protocol treats every executable nonzero exit as failure, preserving
normal test-runner semantics.

## Conditional evidence patterns

These protections are required only when the evidence shape makes them real:

- **Required set for collections.** If success means a named collection of
  checks passed, the caller supplies that set and a missing item fails. Scalar
  thresholds and property checks do not invent item IDs.
- **Freshness for snapshots.** If evidence derives from a build, artifact, or
  dataset, compare its recorded fingerprint with the current one; mismatch is
  exit 2. A live probe adjudicating the current world needs no fake fingerprint.

## Plugs live with their producers

taskloop ships this socket, not format-specific plugs. Each adapter lives with
the skill, tool, or project that owns its evidence format. The core learns only
the executable command and the three-way verdict, so adding or replacing a
producer never changes the loop runtime or `workloop`.

## Two-domain fit

The same socket shapes a data-reconciliation adapter without modification: the
required set is the assertion list, the freshness fingerprint is the dataset
or migration snapshot id, exit 2 covers "the reconciliation query cannot run
or targets a stale snapshot". A build-report adapter uses the same interface:
required checks, artifact fingerprint, and exit 2 for missing or stale output.
Neither adapter ships here; each belongs with its evidence producer or consumer.
