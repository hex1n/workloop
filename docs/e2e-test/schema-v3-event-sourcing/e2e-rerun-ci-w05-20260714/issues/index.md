# Local fix queue

| Issue | Disposition | Type | Severity | Affected scenarios | Suspected area | Post-fix E2E rerun |
|---|---|---|---|---|---|---|
| [ISSUE-001](ISSUE-001-hook-stdin-eagain.md) | CLOSED | product/concurrency | P0 | W05, E2E-009, Oracle 7/8 | `lib/application.mjs` Hook stdin boundary | run `29337249679`, 8/8 success |
| [ISSUE-002](ISSUE-002-windows-reaper-eperm.md) | CLOSED | product/Windows concurrency | P0 | W05/W06, E2E-009, Oracle 8 | `lib/task-store.mjs` reaper acquisition | run `29337249679`, four Windows cells plus full matrix |
