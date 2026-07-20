# Review receipt — cae23995

- review_id: cae23995-2e6a-46f2-984c-b264dc19087c
- task: dd7a078e — Make advisory mining honest and minable: state the counts-versus-kinds data boundary in the meta-loop section, give review receipts their version-controlled home in loop-core, and backfill this session's five receipts under docs/reviews
- reviewed_at: 2026-07-20 · level: fresh_context · reviewer: fresh-context-receipts
- blocking: 0 · advisory: 1
- note: transcribed immediately after task close — an in-envelope receipt write before close would have expired the review acceptance it records; the gating review's receipt therefore post-dates its task's terminal event by design.

## Findings

**Spec axis: 0 blocking.** All four goal clauses verified directly: the mining section states the counts-versus-kinds boundary honestly ("counts locate ... receipts name what kind keeps recurring"; missing receipt = "coverage gap to report, not a silence to skip") and narrows the prior over-strong wording to "resolved before a task reaches achieved"; loop-core names the receipts' home; all 5 backfilled receipts cross-check against real `review_recorded` events (filename ids, task, level, reviewer, counts all match); the adapter's three new probes are real regression pins, confirmed non-vacuous against `git show HEAD` (neither `docs/reviews` nor the receipts wording existed pre-diff).

**Standards axis: 1 advisory** — `skills/loop-core/REFERENCE.md` (echoed in `skills/meta-loop/SKILL.md` and `AGENTS.md`): prose says receipts are "one file per review named by its `review_id`", but actual filenames use date + 8-character id truncation + reviewer slug, not the full UUID. A reader searching by the full ledger `review_id` string finds no exact filename match. Consistently implemented and probe-pinned, so a documentation-precision gap, not a functional one.

## Verification run by reviewer

Focused suite test pass; adapter run end-to-end read-only, exit 4 with npm test green; receipt-to-event cross-checks via `.taskloop/events.jsonl`; post-record status confirmed closure moved from held(change_review_unaccepted) to eligible.
