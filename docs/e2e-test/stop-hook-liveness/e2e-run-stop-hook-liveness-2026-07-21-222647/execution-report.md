# Stop Hook liveness Slice 4 execution report

## Execution Summary

```yaml
plan_id: stop-hook-liveness-e2e/2026-07-21
run_id: 2026-07-22-002112
prior_run_id: 2026-07-21-233911
overall_result: BLOCKED
release_commit: pending final review and commit
runtime_digest: 8589aab54dd4
passed: 3
failed: 0
blocked: 7
required_follow_up: run SHL-E2E-003 through the visible Codex App UI and authenticate Claude Code with an existing entitlement or API key for SHL-E2E-004 through SHL-E2E-007
```

The locally verified candidate, installer migration, Codex CLI probe, explicit-proof lock probe, and supporting app-server protocol probe passed on the fresh run. The app-server result is not counted as the visible Codex App UI Oracle: Computer Use is explicitly prohibited from controlling Codex, so SHL-E2E-003 remains blocked pending a user-operated visible task. The installed Claude hard-path contract also passed direct production-subprocess probes, but the required real Claude model sessions could not start because the local client is logged out and requires an existing entitlement or API key. The prior release commit's Windows matrix passed; the final candidate matrix remains pending until the review fixes are committed and pushed. No subscription, purchase, API key creation, or credential grant was attempted.

## Run Lineage & Emergent Scenarios

- Source plan: `docs/plans/2026-07-21-stop-hook-liveness-root-fix.md`.
- E2E plan: `docs/e2e-test/stop-hook-liveness/2026-07-21-stop-hook-liveness-e2e-test-plan.md`.
- Release candidate: reviewed working tree based on commit `6484ff3f6a6d2edd8677f3e74e6db83416bfcd4d`, draft PR #1; final commit pending.
- Execution mode: approved Core Slice, preserve traces, isolated fixture repositories, sanitized in-repository receipt.
- Emergent `E-001`: changing a Hook timeout invalidates Codex's saved command trust. `hooks/list` reported both reviewed workloop handlers as `modified`; exact current hashes were written through `config/batchWrite`, after which both reported `trusted`.
- Emergent `E-002`: Desktop tasks created before trust was written retained their loaded configuration. A new task consumed the trusted Hook immediately, so no app restart was required.
- Emergent `E-003`: the App PreToolUse anchor legitimately appended one synthetic `output_tokens_tallied` task event. A strict rerun took its baseline after that preparation step; the following ten no-tool Stop probes plus the next turn appended no task event and made no proof mutation.
- Emergent `E-004`: an unsatisfied witness does not cross a criterion generation created by `amend`. The explicit-proof fixture now records an unsatisfied observation in the amended generation before its satisfied observation.
- Emergent `E-005`: the Computer Use runtime refuses to control the Codex app itself. Codex's app-server protocol passed as supporting evidence, but it cannot replace the plan's visible UI requirement; no screenshot or UI recording was claimed.
- Emergent `E-006`: fresh adversarial review found deadline, lock-publication, pre-commit evidence, optional-ledger latency, Hook-trust duplication, fixture-reuse, descendant-process, and dual-race gaps. The runtime now uses deadline-aware chunked snapshots, process-tree termination, hard-link claims with a safe exclusive-copy fallback, content hashing outside the task lock, bounded locked revalidation, retained side-effect evidence across same-task suspension, and a 25ms release-only evidence budget. The new run uses fresh one-shot fixtures and versioned Hook trust writes.

## Environment State Ledger

| State | Before | After | Evidence |
|---|---|---|---|
| Source branch | release candidate committed and pushed | unchanged during live probes | commit and remote branch agree |
| Installed runtime | digest `6a2ff00f7012` | digest `8589aab54dd4` | installer activation manifest and `info` |
| Codex Stop recipe | `codex-safe`, `nudge`, timeout 300, old trust hash | `codex-safe`, `nudge`, timeout 45, trusted | parsed recipe plus `hooks/list` |
| Claude Stop recipe | `claude`, `nudge`, timeout 300 | `claude`, `nudge`, timeout 45 | parsed recipe and installer zero-warning check |
| Codex ledger binding | missing | configured | installer dry-run changed from one binding warning to none |
| Codex configuration backup | absent for this run | exact pre-migration bytes retained | backup SHA-256 matched source SHA-256 at creation |
| Claude configuration backup | absent for this run | exact pre-migration bytes retained | backup SHA-256 matched source SHA-256 at creation |
| Claude authentication | logged out | logged out | `claude auth status`; OAuth entitlement page |
| Final Codex Stop state | trusted release-only command | unchanged and trusted | real CLI census plus supporting app-server census |
| Final Claude Stop state | stale timeout | hard recipe configured; live model blocked | direct Hook probes, no live session claim |

## Run Metadata

```yaml
host_versions:
  node_local: 26.0.0
  codex_cli: 0.144.5
  codex_app: 26.715.52143 (visible UI oracle blocked; app-server supporting probe only)
  claude_code: 2.1.216
recipes:
  codex: { profile: codex-safe, mode: nudge, timeout_seconds: 45, trusted: true }
  claude: { profile: claude, mode: nudge, timeout_seconds: 45, configured: true, live_trust: blocked_by_authentication }
windows_ci:
  run_url: https://github.com/hex1n/workloop/actions/runs/29839787141
  commit: 6484ff3f6a6d2edd8677f3e74e6db83416bfcd4d
  conclusion: prior_candidate_success; final_candidate_pending
```

The local fixture runner used only Node standard-library process APIs. Raw model streams, full Hook payloads, account data, process identifiers, and local fixture locations were not copied into this report.

## Environment & Capability Map

| Capability | Result | Consequence |
|---|---|---|
| Local Node/Git/runtime installation | available | migration and all subprocess probes executed |
| GitHub push and Actions | available | Linux, macOS, and four Windows jobs executed |
| Codex CLI login | available | one same-session 10-Stop probe plus next turn executed |
| Codex App visible UI | blocked by Computer Use host policy | SHL-E2E-003 requires a user-operated visible task |
| Codex app-server protocol | available | supporting same-thread 10-Stop probe passed; not counted as SHL-E2E-003 |
| Codex Hook trust API | available | exact reviewed handlers re-trusted and hot-loaded by a new task |
| Computer Use against Codex | prohibited by host safety policy | supporting app-server probe only; visible UI evidence absent |
| Claude Code binary | available | installed Hook protocol/subprocess probes executed |
| Claude model authentication | unavailable | SHL-E2E-004 through SHL-E2E-007 remain blocked as live Host scenarios |
| Existing paid entitlement/API key | not available to the executor | no purchase or credential creation attempted |

## DAG Schedule

| Node | Scenario | Status | Dependency result |
|---|---|---|---|
| N0 | preflight | completed | tools, configuration hashes, and auth state captured |
| N9 | Windows gate | pending | prior candidate passed all eight jobs; final candidate awaits commit/push |
| N1 | migration | completed | exact runtime installed; recipes merged and verified |
| N2 | Codex CLI | completed | 10 probes plus next turn passed |
| N3 | Codex App | blocked | supporting app-server path passed, but visible UI path is prohibited to Computer Use |
| N4–N7 | Claude live scenarios | blocked | authentication/entitlement gate unavailable |
| N8 | explicit proof | completed | lock liveness and terminal proof passed |
| N10 | receipt/closeout | blocked | receipt exists, but required Claude live rows are not pass |

## Scenario Results

| Scenario | Final status | Source evidence | Notes |
|---|---|---|---|
| SHL-E2E-001 | PASS | installer pre/post diagnostics; recipe parser; `hooks/list`; real census | runtime `8589aab54dd4`; both Stop timeouts 45 and trusted; installer `0 warning / 24 ok` |
| SHL-E2E-002 | PASS | real Codex CLI JSON event stream plus fixture ledger/status | probe census delta 10; next-turn delta 11; sentinel absent; proof state unchanged |
| SHL-E2E-003 | BLOCKED | Computer Use prohibition; supporting app-server ledger/status probe | app-server completed 10 probes plus next turn with zero mutation/errors, but no visible UI task was executed |
| SHL-E2E-004 | BLOCKED | direct installed-runtime short hard-Stop probe passed | first Stop held unsatisfied; second released and terminal; real Claude continuation not executed |
| SHL-E2E-005 | BLOCKED | direct installed-runtime over-budget probe passed | 71.5ms; actionable code/verb present; sentinel absent; real Claude feedback loop not executed |
| SHL-E2E-006 | BLOCKED | direct installed-runtime lease contender probe passed | contender 73.0ms; status 68.9ms; suspend 80.7ms; lease released; real Claude contender not executed |
| SHL-E2E-007 | BLOCKED | direct installed-runtime stale-write probe passed | stale code; round 0; artifact +1; changed path `ignored.txt`; real Claude continuation not executed |
| SHL-E2E-008 | PASS | structured two-process explicit-proof runner | running status 92.1ms; satisfied owner exited 0; final lifecycle terminal |
| SHL-E2E-009 | BLOCKED | prior GitHub Actions run `29839787141` passed | final review-fix commit has not yet run Ubuntu/macOS/Windows matrix |
| SHL-E2E-010 | BLOCKED | this receipt and final-state checks | privacy/safe-state checks pass, but required Claude live rows remain blocked |

## Evidence & Failure Scenes

### Codex CLI

```yaml
codex_cli:
  stop_probe_turns: 10
  probe_stop_census_delta: 10
  post_next_turn_stop_census_delta: 11
  next_turn_ok: true
  sentinel_started: false
  task_event_delta: 0
  round_delta: 0
  observation_delta: 0
  lifecycle: active
  pretooluse_armed: true
```

The CLI automation used the reviewed Hook-trust bypass only for the isolated fixture. It established one successful PreToolUse anchor, then executed nine no-tool probe turns and one ordinary next turn in the same session. The event-store hash stayed unchanged and the 60-second sentinel never appeared.

### Codex app-server supporting protocol (not the App UI Oracle)

```yaml
codex_app:
  stop_probe_turns: 10
  probe_stop_census_delta: 10
  post_next_turn_stop_census_delta: 11
  next_turn_ok: true
  api_error_count: 0
  bad_id_count: 0
  task_event_delta: 0
  preparation_anchor_event_delta: 1
  round_delta: 0
  observation_delta: 0
  pretooluse_armed: true
```

The fresh app-server thread used the same fixture and Hook configuration, then executed ten no-tool probe turns plus one next turn from a post-anchor baseline. Its event-store hash stayed byte-for-byte unchanged; every turn completed, no hook-shaped prompt was persisted, and no workloop proof state changed. This proves the protocol path only. The visible Codex App UI was not operated because the Computer Use runtime returned `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons`; SHL-E2E-003 therefore remains BLOCKED.

### Claude installed-runtime contract

```yaml
claude_contract:
  short: { first_hold: true, second_silent_release: true, terminal: true }
  over_budget: { duration_ms: 71.5, actionable: true, sentinel_started: false, round_delta: 0 }
  in_progress: { contender_duration_ms: 73.0, status_duration_ms: 68.9, suspend_duration_ms: 80.7, lease_released: true }
  stale: { stale_code: true, round_delta: 0, artifact_revision_delta: 1, changed_paths: [ignored.txt] }
claude_live:
  result: blocked
  logged_in: false
  entitlement_page: Max_or_Pro_or_API_key_required
```

These subprocess probes execute runtime digest `8589aab54dd4` through the same installed stable shim and `claude` profile used by the recipe, but they do not prove model-session continuation. They are supporting evidence only.

### Explicit proof

The initial explicit-proof attempt correctly held a satisfied observation because its unsatisfied witness belonged to the pre-amend generation. The corrected fresh fixture first recorded an unsatisfied observation in the amended generation, then created `done` and ran the same five-second criterion. A concurrent status read completed in 92.1ms while the criterion process was active, and the final task became terminal.

### Windows CI

Run `29839787141` completed successfully on the prior candidate. All portable jobs passed on Ubuntu/macOS with Node 22 and 24. Windows 2022 and 2025 with Node 22 and 24 each passed runtime versions, shell resolution, all three Hook transports, child termination, stale-lock recovery, W01–W08, architecture, installer, and the combined behavioral/Hook suite. The final claim/deadline review fixes require a new matrix run before SHL-E2E-009 can return to PASS.

## Failures / Defects / Plan Gaps

| ID | Type | Status | Impact / disposition |
|---|---|---|---|
| ENV-CLAUDE-001 | environment blocker | open | Real Claude sessions require an entitlement or API key not present on this host. User action is required; no code fix is implied. |
| ENV-CODEX-UI-001 | environment blocker | open | Computer Use is prohibited from controlling Codex. A user must run the visible same-task UI probe; app-server evidence cannot replace it. |
| PLAN-GAP-001 | fixture semantics | fixed in runner | `amend` resets the witness generation; the explicit-proof fixture now records an unsatisfied witness after amend. |
| PLAN-GAP-002 | oracle precision | resolved in execution | App's preparation anchor emitted synthetic token telemetry. The strict rerun took its baseline after the anchor and then proved zero event delta across all ten probes plus the next turn. |
| HOST-GAP-001 | UI automation | open | Computer Use is prohibited from controlling Codex itself. The supporting app-server path passed, while the required visible UI scenario remains blocked. |
| HOST-GAP-002 | config reload | bounded | Existing App tasks did not reload Hook trust written by a separate app-server; a new task consumed it immediately. |
| TEST-GAP-001 | Windows fixture portability | fixed in release | Bash-shaped Windows fixture paths now use forward slashes; the same pre-existing failure was reproduced on the default branch and all Windows jobs now pass. |
| REVIEW-001 | product concurrency | fixed locally | Full repository hashing moved outside `.task.lock`; observed before/after/pre-commit differences become side-effect evidence and reject the observation. |
| REVIEW-002 | product liveness | fixed locally | Snapshot traversal/content reads share the runtime deadline and criterion timeout uses hard termination even when the child traps SIGTERM or descendants inherit pipes. |
| REVIEW-003 | lock correctness | fixed locally | A complete owner claim is atomically published before the directory; filesystems without hard links use an exclusive-copy fallback whose partial window is age-gated; live paused claims cannot be stolen. |
| REVIEW-004 | release-only latency | fixed locally | Optional Stop census uses a 25ms evidence-lock budget and degrades open; a held-lock regression completed below 500ms. |
| REVIEW-005 | E2E safety | fixed locally | Hook trust rejects duplicate/unexpected handlers and uses config version compare-and-write; reruns require a fresh run id. |
| REVIEW-006 | dual concurrency | fixed locally | A direct repository write observed alongside an authority change is retained on the same active/suspended task, advancing artifact revision without counting a round. |

There are no remaining observed local product failures in the executable evidence obtained so far. The overall result remains blocked by the visible Codex App scenario, four required live Claude scenarios, and, until the final commit is pushed, the final cross-platform matrix.

## Data Created & Cleanup

- Eight isolated Git fixture repositories and sentinel controls were created under the operating system's temporary area and intentionally preserved as forensic evidence. They are not reusable test inputs after terminal and mutation scenarios run.
- Three timestamped pre-migration configuration backups were retained. Each backup hash matched the source file at creation.
- The new safe recipes remain active: Codex Stop is trusted release-only; Claude Stop is configured hard with the runtime-owned budget; both PreToolUse handlers remain present.
- Supporting app-server tasks contain only fixed probe tokens and a read-only status call; they were archived after evidence collection. No visible UI task is claimed.
- Raw CLI JSON, raw App task content, OAuth URLs, and full user configuration were not copied into the repository.
- No cleanup is required before rerun: choose a fresh `WORKLOOP_E2E_RUN_ID` so the preserved run remains immutable. Removing preserved fixtures or backups requires a separate explicit cleanup decision.

## Privacy and Safe-State Scan

```yaml
privacy_scan:
  raw_transcript: 0
  account_identifier: 0
  session_or_thread_id: 0
  pid: 0
  local_absolute_path: 0
final_host_state:
  codex_stop: release_only
  claude_stop: hard
  claude_live_authentication: blocked
  pretooluse_preserved: true
  dangerous_legacy_block_restored: false
```

The report permits the release commit and public CI URL. The scan excludes the report's schema labels and checks for actual identifiers, user-home/temp prefixes, raw JSONL/transcript markers, and process-id values.

## Re-run Instructions

1. In a fresh visible Codex App task rooted at the prepared fixture, manually execute the same ten fixed-token no-tool Stop turns plus one next turn; record only the sanitized counts and state deltas required by SHL-E2E-003.
2. Authenticate the existing Claude Code installation without creating or purchasing credentials on behalf of the executor, and confirm `claude auth status` reports logged in.
3. Choose a fresh timestamp-shaped `WORKLOOP_E2E_RUN_ID` and run the repository-relative fixture preparation script. It fails closed if that run root already exists; never reuse terminal or mutated fixtures.
4. Execute SHL-E2E-004 through SHL-E2E-007 as real Claude model sessions using the already configured `claude` Hook profile.
5. Replace the five blocked Host scenario rows with live results, update the App/Claude evidence blocks, and rerun the privacy scan.
6. Run `npm test`, `git diff --check`, and `node install.mjs --dry-run`.
7. Re-run independent review against the final diff, record its receipt, then run `workloop verify --record` for the repository task.
8. Push the closeout commit and require the full CI matrix to remain green.

Useful evidence re-query commands:

```text
gh run view 29839787141
node install.mjs --dry-run
node bin/workloop.mjs status --repo .
node bin/workloop.mjs ledger --json --repo .
WORKLOOP_E2E_RUN_ID=20260722T010203 node docs/e2e-test/stop-hook-liveness/e2e-run-stop-hook-liveness-2026-07-21-222647/scripts/prepare-fixtures.mjs
WORKLOOP_E2E_RUN_ID=20260722T010203 node docs/e2e-test/stop-hook-liveness/e2e-run-stop-hook-liveness-2026-07-21-222647/scripts/run-codex-cli.mjs
WORKLOOP_E2E_RUN_ID=20260722T010203 node docs/e2e-test/stop-hook-liveness/e2e-run-stop-hook-liveness-2026-07-21-222647/scripts/run-codex-app.mjs
WORKLOOP_E2E_RUN_ID=20260722T010203 node docs/e2e-test/stop-hook-liveness/e2e-run-stop-hook-liveness-2026-07-21-222647/scripts/run-claude-contracts.mjs
WORKLOOP_E2E_RUN_ID=20260722T010203 node docs/e2e-test/stop-hook-liveness/e2e-run-stop-hook-liveness-2026-07-21-222647/scripts/run-explicit-proof.mjs
```

## Next Actions

1. User runs the visible Codex App probe and authenticates Claude Code using an already held entitlement or API key through their own secure environment.
2. Executor reruns the four live Claude scenarios and updates this report from `BLOCKED` to `PASS` only if every required oracle is observed.
3. Executor completes final criterion recording, closeout commit/push, CI confirmation, and Workloop/native goal closure.
