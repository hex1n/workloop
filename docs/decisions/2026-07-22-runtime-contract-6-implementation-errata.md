# Runtime Contract 6 implementation errata

Date: 2026-07-22

Applies to: `docs/plans/2026-07-22-host-adaptive-write-evidence-implementation.md`

Reviewed plan revision: `7fb3acc8e27a3f44a32d7aca58f1b48e5140cad7bf98ed3be222bc03a3efa21f`

This erratum records two implementation-time corrections discovered by fault injection and independent review. It does not weaken any evidence or closure requirement.

## PostToolUse exit semantics

The plan's unconditional “Post always exits 0” statement is replaced by this rule:

- exit 0 with no stdout when the completion receipt was durably committed;
- exit 0 with no stdout when the completion receipt failed but a durable `unknown` coverage degradation was committed;
- return nonzero with no stdout and a bounded stderr diagnostic when neither the receipt nor its conservative degradation can be persisted.

Rationale: a silent success is safe only after repository authority contains either the receipt or an explicit evidence gap. Returning success when both writes failed would fabricate observability and could leave an operator believing the task was conservatively downgraded when it was not.

## Contract 6 task amendment payload

The dispatch table entry that kept `task_amended` on payload v1 is replaced by:

- Contract 5 continues to read and write `task_amended` payload v1 unchanged;
- Contract 6 uses payload v2 and adds nullable `history_requirement`;
- a Contract 6 amendment may strengthen `artifact_only` to `complete`, but no event may relax `complete` or violate critical-risk and finite-write domain invariants.

Rationale: history requirements are authoritative task policy. Persisting the change in a versioned domain event is safer than hiding it in a projection-only field or overloading the frozen Contract 5 payload.
