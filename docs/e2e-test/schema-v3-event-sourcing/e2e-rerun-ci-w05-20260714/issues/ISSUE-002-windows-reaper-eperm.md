# ISSUE-002 — Windows reaper mkdir EPERM aborts live contention

- Issue ID: `ISSUE-002`
- Type: product/Windows concurrency
- Severity: P0
- Disposition: `CLOSED`
- Affected scenarios / edges: W05/W06, E2E-009, Oracle 8; task-lock contention → optional stale-lock reaper acquisition → authority mutation.
- Expected: a contender that cannot acquire `.task.lock.reaper` waits for the real `.task.lock`; no authorized Hook write is lost or spuriously denied.
- Actual: diagnostic run `29336791375` failed Windows 2022 + Node 22 and Windows 2025 + Node 24 because `mkdir('.task.lock.reaper')` returned transient `EPERM`, which propagated to the generic supervisor-unavailable deny. The other two Windows cells passed the same SHA.
- Evidence / scene: [execution report](../execution-report.md#w05-windows-reaper--transient-eperm) and GitHub Actions run [29336791375](https://github.com/hex1n/taskloop/actions/runs/29336791375).
- Suspected code area: confirmed at `lib/task-store.mjs` `reapDeadTaskLock`; the reaper mkdir catch recognized only `EEXIST`.
- Reproduction steps: run the exact W01–W08 selection with 20 W05 contenders on GitHub-hosted Windows; diagnostic assertion prints the child stderr on failure.
- Fix constraints: never execute the mutation without `.task.lock`; do not increase the timeout or reap a live lock; only classify Windows `EPERM/EACCES` at reaper-directory acquisition as retryable contention.
- Verification command or scenario: local W05/W06 and full suites, followed by four exact Windows matrix cells.
- Post-fix E2E rerun: push the exact fix SHA and require all eight `test` workflow jobs to pass, with W01–W08 green in each Windows job.
- Closure rule: move to `CLOSED` only after the exact fix SHA passes all four Windows cells and all portable dependents; a later committed closeout-doc change must itself receive exact matrix proof.
- Cleanup / data impact: no persistent local fixture; preserve runs `29336558086` and `29336791375` as failure evidence.
- Closure evidence: SHA `d89e8871924ddeb9ddbb8f8b030ebedc8d186fd6`, run `29337249679`, all four Windows cells and all portable jobs successful.
