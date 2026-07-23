# 03 — Git Main-Worktree Authority Tracer Bullet

**What to build:** The smallest complete current-format Git flow: a user can open one partitioned task in a main worktree, inspect status and audit, record Hook evidence, and rebuild the same task from the Git common authority ledger after disposable projections are removed.

**Blocked by:** 02 — Provider-Neutral Authority Transaction Seam.

**Status:** resolved

- [x] Git containment selects the common-repository provider independently of tracked status or launch directory.
- [x] Opening a task publishes a final attachment claim and one replayable task authority without a worktree-local fallback.
- [x] Status, audit, and ledger output agree before and after deleting disposable snapshots and outcomes.
- [x] A failed append or locator finalization leaves an explicit non-routable state and never fabricates a successful open.
- [x] Existing host approval and default nonblocking Hook behavior remain unchanged.


## Comments

- 2026-07-23: Claimed after Ticket 02 achieved. The initial tri-state criterion is stably unsatisfied because the current-format Git provider and its public tracer-bullet tests do not exist. The implementation is an explicit new-Contract expand-side path only; it does not adapt, read, fall back to, or dual-write the old task authority.

- 2026-07-23: First fresh-context two-axis review returned NO-GO (Standards 3 blocking/2 advisory; Spec 3 blocking/0 advisory). The repair moves current authority lifecycle reduction and projection validation into `task-engine.mjs`, adds a separate exact persisted schema from `prims.mjs`, restores stage-intent → staged locator → provenance receipt → pending → claimed locator → final → task ordering, requires replayable command ID and provenance, degrades snapshot/outcome failures, reuses the existing Hook target classifier, expands routing/failure tests, and adds the fixed Windows runner gate. Formal criterion: 56/56; full suite: 284 pass, 0 fail, 10 Windows-only local skips.
