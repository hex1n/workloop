# 02 — Provider-Neutral Authority Transaction Seam

**What to build:** The isolated transaction and locking foundation for the one new provider-based Contract: one provider-neutral authority boundary, explicit lock classes, deterministic fault seams, and structured partial receipts. It must not wrap or preserve the old production authority path.

**Blocked by:** 01 — Cross-Platform Authority Mechanism Spike.

**Status:** resolved

- [x] Existing production CLI and Hook behavior is unchanged because the seam remains inactive, and the existing test suite stays green.
- [x] Authority, Git-operation, criterion-lease, outcome, and maintenance locks enforce the approved non-reentrant ordering and reject forbidden nesting.
- [x] Multi-authority work holds at most one authority lock at a time and never claims cross-authority atomicity.
- [x] Fault injection can stop before/after append, locator publication, snapshot publication, and projection publication without provider-specific test APIs.
- [x] The new seam remains inactive as task authority until the final hard cut; no adapter, fallback, dual read, or dual write is introduced.


## Comments

- 2026-07-23: Claimed after Ticket 01 resolved. The initial criterion is stably unsatisfied only because `lib/authority-transaction.mjs` does not exist; 42 existing architecture and Hook regression checks pass.
- 2026-07-23: Direction corrected after user review: Ticket 02 builds only the isolated new-Contract seam. The attempted transitional `publishLegacyTaskTransaction` wiring was removed; production activation happens once, at the hard-cut ticket, after the provider chain is complete.
- 2026-07-23: Resolved after the current-tree fresh-context reliability review returned GO with 0 blocking and 0 advisory findings; targeted authority tests passed 7/7 and all release-proof counterexamples were replayed. Production activation remains deferred to the hard cut.
