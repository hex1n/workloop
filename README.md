# Workloop

A host-neutral **loop ledger runtime**: a goal can be advanced across processes,
sessions, and agents; any compatible host obtains a determinate next step,
submits a verifiable result, and a durable state machine decides whether to
continue, adjust, suspend, or finish.

The runtime owns **state and truth**. It never owns **execution or approval** —
it runs no tools, creates no branches, and overrides no host decision.

## Status: built, on this branch

A zero-inheritance rebuild. Every acceptance scenario the audit kept is either
implemented and tested or written down as deferred, with the reason — see the
coverage map, which a gate test keeps honest.

| | |
| --- | --- |
| Design | `docs/plans/2026-07-25-greenfield-redesign.md` |
| Specification | `greenfield/scenarios/` (86 scenarios; 20 ruled out by the audit) |
| Mechanism audit | `greenfield/scenarios/AUDIT-2026-07-25.md` |
| What is built, slice by slice | `greenfield/slices/` |
| Where each scenario lives | `greenfield/COVERAGE.md` |
| What is deliberately not built | `greenfield/DEBT.md` |
| How a host drives it | `skills/workloop/SKILL.md` |
| Working agreement | `AGENTS.md` |

Run it with `node --test`. There is no build step and no dependency.

The previous implementation — a provider-authority runtime with task-scoped Git
receipts and tri-state certification — remains on `main`.

## Shape of the thing being built

```text
Store       ledger boundary and identity
  Site      one working site inside it (a Git worktree, or the root itself)
  Loop      goal, claims, criterion, budget — a node of the graph
    Round     act → observe → judge → decide
  Edge      typed digest reference between nodes (v1: depends_on)
```

Verbs: `open · next · observe · amend · join · receipt · suspend · resume ·
abandon` for the loop, `status · log · ready` for read-only queries.

`next` is a pure read and is byte-identical while state is unchanged.
`observe` is the only entry point that produces a judgment and a decision.

```console
$ workloop init --root .
$ workloop open --goal "the suite passes" --claim src --criterion ./check.mjs \
    --budget 10 --session me --reason "starting" --granted-by user --receipts git
$ workloop next --loop <id>          # what to do, same answer until something moves
$ workloop receipt --loop <id> --mode commit --session me --command r1
$ workloop observe --loop <id> --session me --criterion ./check.mjs --command o1
```
