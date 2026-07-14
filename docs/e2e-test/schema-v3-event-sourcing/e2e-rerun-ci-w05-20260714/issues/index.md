# Local fix queue

| Issue | Disposition | Type | Severity | Affected scenarios | Suspected area | Post-fix E2E rerun |
|---|---|---|---|---|---|---|
| [ISSUE-001](ISSUE-001-hook-stdin-eagain.md) | OPEN | product/concurrency | P0 | W05, E2E-009, Oracle 7/8 | `lib/application.mjs` Hook stdin boundary | exact `test` workflow, all eight matrix jobs |
