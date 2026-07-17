# taskloop repository

## Start and verify

This repository is a dependency-free Node.js CLI plus the portable loop kernel skills (`skills/loop-core`, `skills/workloop`, `skills/judgmentloop`, `skills/meta-loop`). Run `npm test` for the behavioral, architecture, hook-protocol, installer, and skill-closure suites. Run `node bin/taskloop.mjs help` to exercise the source entry directly.

## Conventions

- `bin/taskloop.mjs` is only the process entry; `lib/application.mjs` is the single assembly module.
- Leaf modules may import only `lib/prims.mjs`, never sibling leaf modules. The architecture suite enforces this dependency direction.
- Lifecycle state changes belong in `lib/task-engine.mjs`. Critical task-state writes fail loudly; outcome projection and untracked-work telemetry degrade open.
- Tests assert public CLI/hook output and module interfaces. Keep byte-exact hook protocol compatibility unless a deliberate interface change is documented.
- Stop self-suspension is part of the hook contract: `out_of_budget` at budget exhaustion, `stuck` on three identical failure signatures or on seven revision-stagnant unsatisfied attempts (hosts force-release pure spinning around nine metered stops and reset their counters on intervening writes; probed live 2026-07-13).
- Untracked nudge/deny messages carry criterion-sourcing discipline and route to the workloop skill by name; keep them host-neutral (no host-specific skill invocation syntax).
- Keep `skills/*/SKILL.md` task-facing. Shared task/envelope/criterion semantics belong in `skills/loop-core`; relative skill links must resolve inside this repository.
- Portable skills use Markdown and standard-library helpers only. Do not leak source-project names, fields, prompts, session ids, or local paths into them.

## Direction and danger

The runtime is the stop gate: it constrains writes and adjudicates fresh criteria. The bundled skills select and structure loop behavior. Schedulers that trigger another round remain outside this repository.

The loop kernel contains the runtime and skills that co-author a core runtime contract: `loop-core`, `workloop`, `judgmentloop`, and `meta-loop`. Skills that only consume an established contract live in their own repositories and compose through `loop-core`; keep the core skill texts free of references to any specific external skill or tool.

`node install.mjs` writes a versioned runtime, stable shim, and digest-proven managed skill copies under the current user's home; use a temporary `TASKLOOP_INSTALL_HOME` when testing installation behavior manually. It must preserve unowned, locally modified, or externally taken-over skill trees, including when Claude and Codex skill roots alias the same directory. Never hand-edit generated files below `~/bin/.taskloop-runtime/`; modifying a managed skill intentionally releases it from automatic replacement/pruning.

## Docs gaps

Re-derived something a fresh contributor should have known? Add one line here with the fact and where it was found.

- Windows compatibility is gated on fixed GitHub-hosted Windows versions with separately bounded suite groups; shell/install/path/lock/timeout coverage lives in `tests/windows.test.mjs` and `.github/workflows/test.yml`.
- Out-of-budget `resume` transition events require a caller-captured integer `atEpochMs`; `lib/application.mjs` captures it once so wall-clock decisions never fall back to the second-resolution persisted timestamp.
- Host Hook recipes require `hook --profile`: `claude` owns hard Stop blocking, `codex-safe` releases held Stop with zero stdout, and the old no-argument handler is a migration-only safe release while retaining PreToolUse protection; the contract and recipe encoder live in `lib/host-hooks.mjs`.
- Distributing a *new* managed skill blocks the release on any home that already holds a same-named tree: `install.mjs:872` returns before `activateRuntimeShims`, so the shim silently keeps serving the old runtime while the journal reads `needs_manual_intervention`. `LEGACY_CORE_DIGESTS` (`install.mjs:761`) grants one-time adoption to `loop-core` and `workloop` only; every other name needs the owner to remove or rename the tree first. Found releasing `meta-loop` into the kernel (2026-07-17).
- An armed Stop gate refuses to adjudicate — not release — when task state is unreadable, so a repository still holding schema-2 state hard-blocks every session until `archive-incompatible-state` renames it under `.taskloop/archive/` with a sha256 receipt. That verb hard-requires `--granted-by user` (`lib/task-store.mjs`) because the archive is a user provenance claim; never self-sign it.
