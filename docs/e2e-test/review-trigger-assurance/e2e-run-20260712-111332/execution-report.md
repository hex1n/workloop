# Review trigger and assurance policy E2E report

## Result

Passed against a freshly installed runtime.

## Contract

- Runtime contract: 3
- Task schema: 2
- Ledger event schema: 2
- Ledger: `~/.taskloop/outcomes-v2.jsonl`

## Scenarios

1. A repository/full-coverage critical public-contract task opened satisfied but status required `second_model` and closure held `change_review_unaccepted`.
2. A current fresh-context review did not satisfy the critical task. A current second-model review with zero blocking findings made `achieve` terminal.
3. A state-directory criterion produced a proof assurance gap. `accept-proof-gap --granted-by user` changed proof to provisional but independently raised the review requirement to fresh-context and retained `change_review_unaccepted`.
4. The installed-runtime matrix directly covered routine/no-review, default substantial/fresh-context, critical/second-model, destructive critical floor, explicit waiver, review staleness after a write, proof acceptance, and insufficient review level. Source suites additionally cover required policy, semantic floors, ledger validation, and release activation recovery.
5. Explicit and automatic closeout paths echo advisory-finding counts; automatic Stop preserves empty release stdout and writes the closeout evidence to stderr. Waived closeout names the waiver reason and provenance.

## Verification

- `npm test`: 63 passed, 0 failed.
- `git diff --check`: passed.

## Limits

- Reviewer identity and review quality remain collaborative assertions rather than cryptographically verified facts.
- Live Windows execution is not covered; deterministic Windows command preparation remains unit-tested.
