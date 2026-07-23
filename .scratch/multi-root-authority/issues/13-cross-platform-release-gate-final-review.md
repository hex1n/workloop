# 13 — Cross-Platform Release Gate and Final Review

**What to build:** One exact release candidate proves the entire provider-based authority contract through public behavior on every supported platform and receives the required independent technical GO.

**Blocked by:** 12 — Current-Format Hard Cut and Install Activation.

**Status:** resolved

- [x] Public CLI and Hook behavior, real Git and filesystem lifecycle, crash recovery, routing, placement, Git receipts, criteria, outcomes, hard cut, and installation all pass locally.
- [x] Portable macOS/Linux and Windows 2022/2025 matrices pass for every supported Node version on the exact candidate SHA.
- [x] Release evidence contains no duplicate sequence, split authority, simultaneous lock ownership, unsafe recovery, path-based identity reuse, or clean evidence from protected/pending/collided targets.
- [x] Default Hook modes never block host execution because of authority, telemetry, or projection failure.
- [x] A fresh independent complete review reports zero blocking findings on the exact candidate revision.
- [x] The final report names any advisory findings, unsupported lifecycle boundary, and deliberately deferred live-host evidence without promoting it to a pass.

## Comments

- 2026-07-23: Resolved at runtime candidate `12c452360a408620ce32507c2fd68224b8b91b5c`.
  Local provider suite passed 61/61. GitHub's provider and mechanism matrices
  passed across macOS/Linux/Windows 2022/2025 × Node 22/24; the mechanism
  proof digest is `sha256:055d8ecf078d63ea99f83a7df705dc1dbbd51b484a736f25727d19e1e9e6fbed`.
  A clean clone ran the explicit-proof gate successfully (criterion exit 4),
  and GitHub-hosted attestation verification passed. Independent final review
  returned GO after exercising stale/valid profile Stop, null, and unknown
  Hook payloads, Windows archive durability, and release-boundary behavior.
- Advisory only: `networkFailure` is intentionally conservative; an overly
  broad match can make attestation verification indeterminate, never passing.
  Tightening it is deferred. No automatic migration of legacy runtime state is
  supported by design, and live user-host Hook installation is not promoted to
  release evidence; host configuration remains owner-managed.
