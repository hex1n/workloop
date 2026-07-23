# 06 — Exclusive Worktree Placement

**What to build:** A user can explicitly open a task in its own linked worktree when independent branch, index, HEAD, history, or repo-wide verification is required, while Workloop leaves worktree lifecycle authority with the host.

**Blocked by:** 04 — Git Attachment and Linked-Worktree Lifecycle; 05 — Partitioned Multi-Task and Target-First Routing.

**Status:** complete

- [x] Explicit exclusive placement creates or selects one linked attachment and permits at most one live task there.
- [x] Placement, branch intent, base, and write scope are recorded without silently changing the caller's current directory.
- [x] Workloop does not automatically remove, prune, merge, rebase, or delete the worktree or branch.
- [x] Missing or removed exclusive placement preserves the task as unavailable and prevents clean terminal certification.
- [x] Partitioned behavior in other worktrees remains independent.
