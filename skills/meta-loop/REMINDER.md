# Monthly host reminder

This binding is host-owned: workloop supplies the trusted aggregate and the
host supplies the monthly scheduler. The reminder stores only the previous
aggregate counts, never task or actor identifiers.

On Windows, save the following as a self-contained PowerShell action and bind
it monthly with Task Scheduler. Set `WORKLOOP_REPO` in that scheduled action.

```powershell
$ErrorActionPreference = 'Stop'
$repo = $env:WORKLOOP_REPO
if ([string]::IsNullOrWhiteSpace($repo)) { throw 'WORKLOOP_REPO is required' }
$stateDir = Join-Path $HOME '.workloop'
$baselinePath = Join-Path $stateDir 'meta-loop-reminder-baseline.json'
$duePath = Join-Path $stateDir 'meta-loop-due.txt'
$ledger = workloop ledger --json --repo $repo | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'workloop ledger failed' }
$prior = if (Test-Path $baselinePath) { Get-Content $baselinePath -Raw | ConvertFrom-Json } else { $null }
$terminal = [int64]$ledger.metrics.terminal
$abandoned = [int64]$ledger.metrics.terminal_outcomes.abandoned
$newTerminal = if ($null -eq $prior) { $terminal } else { [Math]::Max(0, $terminal - [int64]$prior.terminal) }
$newAbandoned = if ($null -eq $prior) { $abandoned } else { [Math]::Max(0, $abandoned - [int64]$prior.abandoned) }
$message = "workloop meta-loop due: $newTerminal new terminal task(s), $newAbandoned abandoned; evidence=$($ledger.integrity.evidence)"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
@{ terminal = $terminal; abandoned = $abandoned; observed_at = [DateTime]::UtcNow.ToString('o') } |
  ConvertTo-Json | Set-Content -Path $baselinePath -Encoding UTF8
$message | Set-Content -Path $duePath -Encoding UTF8
msg * $message
```

The scheduler runs this action once per month. A `0 new terminal task(s)`
message is intentional: the human can skip the run without learning to ignore
an opaque “due” alarm. If ledger integrity is not valid/covered, repair the
named gap before drawing a conclusion; do not advance the baseline after a
failed ledger invocation.
