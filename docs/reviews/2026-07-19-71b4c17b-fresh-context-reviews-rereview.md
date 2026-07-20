# Review receipt — 71b4c17b

- review_id: 71b4c17b-5293-41d0-8eec-91ce8d404a4b
- task: d6e400cd — Expose recorded reviews with their finding counts in ledger --json so the meta-loop review can mine advisory clusters
- reviewed_at: 2026-07-19 · level: fresh_context · reviewer: fresh-context-reviews-rereview
- blocking: 0 · advisory: 3

## Findings

Prior blocking finding (no mining discipline in the skill) — **resolved**: `skills/meta-loop/SKILL.md` gained a "Mine review findings" section naming `queries.reviews`, giving clustering discipline, keeping counts-as-observation vs interpretation-as-attended separate, and routing to the single-candidate handoff; structure mirrors the sibling "Mine authority friction" section; host-neutral.

1. **ADVISORY — `acceptance-review-findings-query.mjs`**: the probe set never reads `skills/meta-loop/SKILL.md`. Its sibling `acceptance-terminal-write-sets.mjs` asserts its skill coupling by probe; here a future edit silently stripping the "Mine review findings" section would still report SATISFIED. Failure scenario: revert/merge over the section; npm test and AGENTS.md still pass; adapter exits 4 with no signal the discipline regressed.
2. **ADVISORY — `skills/meta-loop/SKILL.md`**: "Blocking findings gate acceptance and are resolved by the time a task reaches a terminal outcome" is true for `achieved` only — `abandon`/`not-needed` deciders do not check the review hold, so a task can reach `abandoned` with unresolved blocking findings. Motivating prose, not corrupt discipline, but a careful reader could over-trust it.
3. **ADVISORY — `tests/taskloop.test.mjs`**: the new test never asserts `row.task_id`/`row.review_id` presence/type, unlike the sibling terminal-write-sets test; the adapter covers it independently.

## Verification run by reviewer

Implementation re-verified (rows from `reviewRows`, seven fields, `"unknown"` on `authorityFailure`, additive-only). `blocking_findings_count === 0` confirmed as the gate on the achieved path (`change_review_unaccepted` hold). Focused test pass; full suite 214 tests, 207 pass, 0 fail, 7 Windows-only skipped; adapter read-only with fixture in OS temp, exits 4.
