# Workloop

A host-neutral **loop ledger runtime**: a goal can be advanced across processes,
sessions, and agents; any compatible host obtains a determinate next step,
submits a verifiable result, and a durable state machine decides whether to
continue, adjust, suspend, or finish.

The runtime owns **state and truth**. It never owns **execution or approval** —
it runs no tools, creates no branches, and overrides no host decision.

## Status: greenfield rebuild, no implementation yet

This branch is a zero-inheritance rebuild. The specification and design are
complete; the runtime is not written.

| | |
| --- | --- |
| Design | `docs/plans/2026-07-25-greenfield-redesign.md` |
| Specification | `greenfield/scenarios/` (86 acceptance scenarios) |
| Mechanism audit | `greenfield/scenarios/AUDIT-2026-07-25.md` |
| Working agreement | `AGENTS.md` |

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
