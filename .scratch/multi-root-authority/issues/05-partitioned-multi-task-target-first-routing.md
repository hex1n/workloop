# 05 — Partitioned Multi-Task and Target-First Routing

**What to build:** Multiple sessions can run independent partitioned tasks in one Git worktree, with task ownership and evidence selected from canonical targets and non-overlapping write scopes rather than launch context.

**Blocked by:** 03 — Git Main-Worktree Authority Tracer Bullet.

**Status:** complete

- [x] One attachment can hold multiple live partitioned tasks whose structured write scopes are disjoint.
- [x] Overlapping live scopes are rejected; suspended tasks retain claims and terminal tasks release them.
- [x] A session joins one live task per attachment, while another session can join a different task on the same attachment.
- [x] Tracked, untracked, ignored, and not-yet-created targets route to the same Git authority.
- [x] External Git targets are judged by their containing authority, unsupervised targets do not inherit the launch task, and multi-authority operations remain shard-local.
- [x] Git and Workloop control-plane targets are excluded before task routing and can never satisfy task evidence.
