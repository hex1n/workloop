# Workloop repository (greenfield rebuild)

## What this branch is

A zero-inheritance rebuild of the Workloop loop-engineering runtime. **There is
no implementation yet.** The previous implementation still exists on `main` and
in history; it was deliberately removed here so that it cannot leak back into
the new design.

## Read this before writing any code

- `docs/plans/2026-07-25-greenfield-redesign.md` — the design: five axioms,
  domain model, storage, addressing, verbs, delivery slices.
- `greenfield/scenarios/` — **the specification**. 86 acceptance scenarios,
  translated from the previous implementation's green test gate and then put
  through a first-principles audit. Implementation is complete when the retained
  scenarios pass.
- `greenfield/scenarios/AUDIT-2026-07-25.md` — which mechanisms were ruled out
  and why. Read it before reintroducing any concept it killed.

## The one rule that this branch exists to enforce

**Do not consult the previous implementation for how to build this.** Its code
is not a reference. The only thing carried forward is behavioral evidence, and
that already lives in the scenario corpus.

If a scenario is unclear, resolve it from the design axioms — or from the old
*test* it cites, retrievable with `git show main:tests/<file>`. Never from the
old `lib/`.

The same applies to prose: everything under `docs/plans/`, `docs/decisions/`,
and `docs/research/` dated before 2026-07-25 describes the previous
implementation and its rulings. Read it as history, never as instruction. The
current documents are the three listed above.

Concepts already ruled out (audit M1–M8): bypass evidence channel (hooks),
target-first routing, locator files, home-managed store data, exclusive worktree
creation by the runtime, attachment recovery verbs, cross-store global
projections, session uniqueness. Each has a documented flip condition; none may
return without re-running its Value Gate.

## Start and verify

- `npm test` is bare `node --test`, which discovers every `*.test.mjs` in the
  repository. The gate globs by design: a test that exists is a test that runs.
  Never reduce it to an explicit file list — that is how the previous
  implementation ended up with a third of its suite rotting outside the gate.
- Today the gate contains only the spec-integrity check, because there is no
  runtime to test. Slice 1 adds the log-kernel property tests.

## Change contract

- Scenarios first, then implementation. A new invariant means a new scenario in
  the corpus, not only a new test.
- Assert behavior at public seams; the application service is the semantic
  entry point and the CLI is a shell over it.
- Fail closed: corrupt state, unknown vocabulary, and failed validation are
  refusals with diagnostics, never silent degradation.
- The runtime never executes tools, never creates worktrees or branches, and
  never overrides host approval.
