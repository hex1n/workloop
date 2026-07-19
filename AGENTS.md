# taskloop repository

## Start and verify

This repository is a dependency-free Node.js CLI plus the portable loop kernel skills (`skills/loop-core`, `skills/workloop`, `skills/judgmentloop`, `skills/meta-loop`). Run `npm test` for the behavioral, architecture, hook-protocol, installer, and skill-closure suites. Run `node bin/taskloop.mjs help` to exercise the source entry directly.

Windows compatibility is gated on fixed GitHub-hosted Windows versions with separately bounded suite groups; shell/install/path/lock/timeout coverage lives in `tests/windows.test.mjs` and `.github/workflows/test.yml`.

## Conventions

- `bin/taskloop.mjs` is only the process entry; `lib/application.mjs` is the single assembly module.
- Leaf modules may import only `lib/prims.mjs`, never sibling leaf modules. The architecture suite enforces this dependency direction.
- Lifecycle state changes belong in `lib/task-engine.mjs`. Critical task-state writes fail loudly; outcome projection and untracked-work telemetry degrade open.
- Tests assert public CLI/hook output and module interfaces. Keep byte-exact hook protocol compatibility unless a deliberate interface change is documented.
- Stop self-suspension is part of the hook contract: `out_of_budget` at budget exhaustion, `stuck` on three identical failure signatures or on seven revision-stagnant unsatisfied attempts (hosts force-release pure spinning around nine metered stops and reset their counters on intervening writes; probed live 2026-07-13).
- Host Hook recipes require `hook --profile`: `claude` owns hard Stop blocking, `codex-safe` releases held Stop with zero stdout, and the old no-argument handler is a migration-only safe release while retaining PreToolUse protection; the contract and recipe encoder live in `lib/host-hooks.mjs`.
- Out-of-budget `resume` transition events require a caller-captured integer `atEpochMs`; `lib/application.mjs` captures it once so wall-clock decisions never fall back to the second-resolution persisted timestamp.
- Runtime contract 5 uses stable, versionless core artifact names; `migrate-artifact-names --granted-by user` adopts legacy names and fails closed on dual-name authority. The evidence ledger is likewise versionless, versioned by each row's `schema_version` rather than the filename; it has no migrator, so a legacy `*-v1` ledger is rebuilt empty rather than adopted.
- Untracked nudge/deny messages carry criterion-sourcing discipline and route to the workloop skill by name; keep them host-neutral (no host-specific skill invocation syntax).
- Grant-gated command denies (destructive, network, install, publish) are actionable: after the tested `... grant` fragment they name the `taskloop amend` flag that lifts them, in the same host-neutral taskloop-verb style as the `run taskloop join` deny (reworded 2026-07-19 after a scratch-fixture cleanup deny left the agent without a next step).
- Destructive authority is two-tier: `--destructive-allowed` (full, sets `envelope.destructive`) or `--destructive-scope <root>` (a grant of literal subtree roots — never globs, because a single-star glob can match a directory while missing its grandchildren under recursive rm). The scoped gate covers only rm with enumerable literal targets; roots and targets both canonicalize through `canonicalWriteTarget` (symlink-resolved, fail-closed on variables/globs/`~`). In-scope use is attributed cleanup — marker `<command:destructive_scoped>` plus `<destructive-scoped:target>` entries instead of `<command:destructive>`/`<command>` — so the machine floor does not rise (`scopedDestructiveFailure`/`scopedDestructiveAttribution` in `lib/supervision.mjs`, added 2026-07-19).
- The engine's authorize-write deny path emits no event, so owner-path hook denies persist as `write_denied` evidence rows and `ledger --json` joins them to the task's next grant as `queries.authority_friction`; the meta-loop review mines recurring clusters there as authority-vocabulary candidates. Grow the grant vocabulary from that evidence, not speculatively (added 2026-07-19).
- Write policy is **target-scoped**: judged by the repository containing the operation's resolved target, not the hook's launch repo (`externalTargetDecision`/`gitExternalDelegation` share `externalRepoActiveTask`, `lib/supervision.mjs`; wired for the foreign and owner paths alike). A write or non-read-only `git -C` aimed outside this repo is decided by that repo's own taskloop state — control state always protected, an active-task envelope intersection a conflict there. `push`, destructive git, and the host-level risk floors never delegate (taskloop's one git classifier decides `git clean` is destructive; do not add a second), and a linked worktree is never external. The owner keeps in-repo trust: a shell writer outside the envelope is allowed and an unresolvable owner target is not fail-closed — that asymmetry, and same-repo multi-task parallelism (a worktree job), are intentional.
- Foreign-session denies use three distinct, host-neutral categories — protected resource, unresolvable target, host-level risk floor — and read as a scope/authorization question, never a bare prohibition; the `TASKLOOP_SESSION_ID conflicts with the host hook session id` deny is host-neutral for the same reason (it fires under the Claude profile too). Tests match reason fragments, so a reword is a deliberate interface change per the hook-compatibility rule above.
- Keep `skills/*/SKILL.md` task-facing. Shared task/envelope/criterion semantics belong in `skills/loop-core`; relative skill links must resolve inside this repository.
- Portable skills use Markdown and standard-library helpers only. Do not leak source-project names, fields, prompts, session ids, or local paths into them.

## Direction and danger

The runtime is the stop gate: it constrains writes and adjudicates fresh criteria. The bundled skills select and structure loop behavior. Schedulers that trigger another round remain outside this repository.

The loop kernel contains the runtime and skills that co-author a core runtime contract: `loop-core`, `workloop`, `judgmentloop`, and `meta-loop`. Skills that only consume an established contract live in their own repositories and compose through `loop-core`; keep the core skill texts free of references to any specific external skill or tool.

An armed Stop gate refuses to adjudicate — not release — when task state is unreadable, so a repository still holding schema-2 state hard-blocks every session until `archive-incompatible-state` renames it under `.taskloop/archive/` with a sha256 receipt. That verb hard-requires `--granted-by user` (`lib/task-store.mjs`) because the archive is a user provenance claim; never self-sign it.

`node install.mjs` writes a versioned runtime, stable shim, and digest-proven managed skill copies under the current user's home; use a temporary `TASKLOOP_INSTALL_HOME` when testing installation behavior manually. It must preserve unowned, locally modified, or externally taken-over skill trees, including when Claude and Codex skill roots alias the same directory. Never hand-edit generated files below `~/bin/.taskloop-runtime/`; modifying a managed skill intentionally releases it from automatic replacement/pruning.

Distributing a *new* managed skill blocks the release on any home that already holds a same-named tree: `install.mjs:872` returns before `activateRuntimeShims`, so the shim silently keeps serving the old runtime while the journal reads `needs_manual_intervention`. `LEGACY_CORE_DIGESTS` (`install.mjs:761`) grants one-time adoption to `loop-core` and `workloop` only; every other name needs the owner to remove or rename the tree first (found releasing `meta-loop` into the kernel, 2026-07-17).

## Docs gaps

Re-derived something a fresh contributor should have known? Add one line here with the fact and where it was found. Once an entry stabilizes, promote it into the section where a fresh reader would look for it.

- Non-shell tools (a Codex apply_patch, an Edit) also deliver `command` fields; shell-only semantics (identity-assignment parsing, session-injection rewrite) must guard on the tool first, or they crash the hook / degrade the task owner to "cli" and disarm foreign-session policy (found via a live Codex failure, 2026-07-18; diagnosis in `docs/plans/2026-07-18-hook-concurrency-resilience.md`).
