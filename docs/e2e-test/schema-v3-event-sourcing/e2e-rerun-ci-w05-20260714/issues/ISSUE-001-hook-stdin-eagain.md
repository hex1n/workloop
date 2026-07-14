# ISSUE-001 — Hook stdin EAGAIN silently loses authority writes

- Issue ID: `ISSUE-001`
- Type: product/concurrency
- Severity: P0
- Disposition: `CLOSED`
- Affected scenarios / edges: W05, E2E-009, Oracle 7/8; Hook payload → write authorization → event authority append.
- Expected: every accepted PreToolUse write produces one `write_authorized` event; 20 concurrent writes produce 21 records including genesis.
- Actual: exact CI lost two records on both Ubuntu jobs; Windows 2025 + Node 22 returned one supervisor-unavailable deny. Amplified local Node 22 stress produced 29 records instead of 101 while every child exited 0 with empty output.
- Evidence / scene: [execution report](../execution-report.md#w05-repro--silent-authority-loss) and GitHub Actions run [29335557499](https://github.com/hex1n/taskloop/actions/runs/29335557499).
- Suspected code area: confirmed at `lib/application.mjs` `loadPayload`; `fs.readFileSync(0)` can throw `EAGAIN` on a temporarily empty nonblocking pipe, and the catch returned `{}`.
- Reproduction steps: `TASKLOOP_W05_CONCURRENCY=100 <node22> --test --test-reporter=spec --test-name-pattern='\[W05\]' tests/runtime-v4.test.mjs` before the fix.
- Fix constraints: retain byte-exact valid Hook output; do not weaken W05, increase lock timeouts, or bypass authority; retry only `EAGAIN`/`EWOULDBLOCK` at the stdin boundary with a finite wait.
- Verification command or scenario: delayed-stdin W05 regression, 100-concurrency W05 stress, `npm test`, `node tests/verify-full.mjs`.
- Post-fix E2E rerun: push the exact fix SHA and require all portable jobs plus Windows 2022/2025 × Node 22/24 to pass; inspect W01–W08 in every Windows job.
- Closure rule: move to `CLOSED` only after the exact fix SHA passes all eight matrix jobs and this report records the run/SHA; then rerun the final docs-only release SHA if the report/issue change is committed.
- Cleanup / data impact: temporary repositories self-clean; preserve GitHub run evidence and this issue document.
- Closure evidence: SHA `d89e8871924ddeb9ddbb8f8b030ebedc8d186fd6`, run `29337249679`, all eight jobs successful including four Windows W01–W08 cells.
