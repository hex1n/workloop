# Opus 4.8 follow-up execution report

## Result

Passed. The four follow-up findings were reproduced with failing regression tests, fixed, and verified through both the source CLI and a freshly installed runtime.

## Evidence

- `npm test`: 53 tests passed, 0 failed.
- State-directory criterion: a freshly installed runtime opened `.taskloop/check.mjs` with `provenance: state_dir`; `achieve` was held by `weak_sensor_unreviewed`.
- Token budget: a transcript row containing 3 output tokens was counted once; a task with `--token-budget 3` denied the next write with `output-token budget exhausted (3/3)` and persisted `spent.output_tokens_estimate: 3`.
- Envelope supervision: comma/semicolon-joined `--files` values are rejected, zero-match patterns warn, dirty envelopes and sibling-worktree overlaps produce advisories, and sibling task discovery reads the v1 lifecycle shape.
- Timestamp consistency: untracked-write timestamps now use UTC ISO strings; the obsolete local-time renderer and its stale single-rendering claim were removed.

## Installed runtime

Fresh temporary-home release: `0bf15834b4ae`.

The installer emitted the expected temporary-home warning about Codex outcome-ledger binding; it does not affect runtime behavior exercised here.

## Remaining limits

- Transcript token accounting is intentionally best-effort and recognizes the supported `message.usage.output_tokens`, `usage.output_tokens`, and top-level `output_tokens` JSONL shapes.
- Windows behavior remains covered by deterministic preparation tests rather than a live Windows host.
