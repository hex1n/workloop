# Review receipt — c54093c3

- review_id: c54093c3-b77b-48cc-b411-5adf0f2d4143
- task: d6e400cd — Expose recorded reviews with their finding counts in ledger --json so the meta-loop review can mine advisory clusters
- reviewed_at: 2026-07-19 · level: fresh_context · reviewer: fresh-context-reviews-query
- blocking: 1 · advisory: 2

## Findings

1. **BLOCKING — `skills/meta-loop/SKILL.md` (whole file unchanged)**: no mining discipline for `queries.reviews` was added, despite the task's stated purpose ("so the meta-loop review can mine advisory clusters"). The two prior same-day query additions each paired their query with a dedicated SKILL.md section (`authority_friction` → "Mine authority friction"; `terminal_write_sets` → "Join terminal write sets to repository history"). Since the skill is the sole reader of `ledger --json`, the data is technically emitted but practically un-mineable without attended guidance. Corroborating: the sibling adapter `acceptance-terminal-write-sets.mjs` enforces its skill section via a probe; this task's adapter has no equivalent, letting the gap pass acceptance.
2. **ADVISORY — `tests/taskloop.test.mjs` (new test)**: does not assert `task_id`/`review_id` presence (the acceptance adapter does), so a projection regression there would not be caught by the primary suite.
3. **ADVISORY — `lib/application.mjs`**: `metrics.reviews` (count) and `queries.reviews` (array) share a leaf name at different nesting levels — a minor readability/grep trap, no functional collision.

## Verification run by reviewer

`cmdLedger` builds the rows from the same `reviewRows` that spreads each `review_recorded` record — all seven projected fields exist on the record (confirmed against `cmdReview`). Degrades to `"unknown"` exactly on `authorityFailure`, matching the neighbouring queries. `schema_version` stays 1; `unanchored_review_claims` untouched. New test passes standalone; corrupt-authority degradation asserted; adapter exits 4 with npm test green.
