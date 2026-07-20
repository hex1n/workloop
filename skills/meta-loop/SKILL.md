---
name: meta-loop
description: Diagnose whether supervised loops converge, where they fail, how adoption behaves, and whether landed work survives after close, from taskloop's machine ledger joined to repository history. Use for the periodic ledger review, when the monthly reminder reports new terminal or abandoned counts, when asked why loops stall, suspend, or bypass supervision, or whether achieved work was later reverted or superseded.
argument-hint: "[review window or operating question]"
---

# Meta-loop

Meta-loop is the human-in-the-loop reader and co-author of taskloop's aggregate
contract. It never reads raw event schemas or legacy projections directly.

## Read the ledger

Run `taskloop ledger --json --repo <repo>` for every repository in scope. Treat
the returned `integrity` object as part of every number:

- `covered` evidence supports claims about the selected window;
- `gapped` evidence names sequence holes, resets, skipped corrupt/unknown rows,
  recovered torn tails, or bounded-history truncation;
- `unknown` means the sensor's presence cannot be established;
- invalid authority or evidence stops quantitative conclusions until repaired.

Do not silently convert missing rows into zero. Operational repair uses
`sync-outcomes`, but ledger reading itself remains read-only.

`unanchored_review_claims` specifically means that no host-observed,
agent-bearing `actor_anchor` matches the review's acting session. A root-session
anchor has no `agent_id`, so a parent-session review intentionally remains in
this query: the anchor distinguishes a subagent context from a root self-sign,
but cannot prove that the subagent independently formed the judgment. When the
bounded evidence window is gapped or truncated, this query is the string
`unknown` rather than an accusation based on missing history. Authority-use
booleans and command shapes likewise become `unknown` when absence cannot be
established from the surviving window.

## Join terminal write sets to repository history

The ledger stops observing at the terminal event; whether landed work
survived afterwards lives only in repository history, an independent sensor
the runtime does not produce. `queries.terminal_write_sets` lists each
terminal task's outcome, close time, and non-synthetic write set. Before
reading terminal counts as convergence, join each achieved task's write set
against version-control history after its close time, in this attended
session. The product is one verdict per achieved task — survived, superseded,
or unknown — each carrying the commit and file evidence behind it.

Discipline for the join:

- exclude the task's own landing commit or commits, identified by subject and
  close-adjacent timing — landing happens after close, and one commit may land
  several tasks. A later sweeping refactor touches as much of the write set as
  the landing does, so a "most of the write set overlaps" rule swallows the
  very supersede you are hunting; attribute each excluded commit by its content
  and role, never by how large its overlap is;
- plain modifications inside the write set are background noise in an active
  repository; candidate signals are deletions or renames of write-set files,
  replacement of the task's criterion anchors such as tests and fixtures,
  and explicit revert language. Match a rename against the write set by the
  file's pre-rename path: version control lists a rename under its new name,
  so the write-set entry is the rename source, and a supersede that renames a
  criterion anchor stays invisible to a match on the new name;
- no commits after close reads as `unknown`, not as survival — the usual
  coverage discipline applies.

A superseded achievement — its contract replaced, its artifacts renamed — is
a candidate observation for the handoff below, not a failure by itself. Turn
it into a mechanism hypothesis like any other symptom.

## Form one symptom hypothesis

Ask one question: are loops converging, where are they failing, or what shape of
work bypasses supervision? Use the smallest relevant combination of terminal
outcomes, rounds, writes, reviews, touched-file shape, suspension causes,
untracked observations, and anchor queries. State the coverage alongside the
observation.

Turn the observation into one falsifiable mechanism hypothesis. Examples of
useful shapes are repeated suspension at the same reason, abandoned work after
large write sets, or review claims without a host anchor. A count without a
mechanism is not a candidate.

## Mine authority friction

`queries.authority_friction` lists each deny the supervisor persisted on the
owner path — control-plane and foreign-session denies live outside it — with
its reason and whether the same task recorded a grant afterwards
(`followed_by_grant` carries the grant kinds and the delay in minutes). The
usual coverage discipline applies: the string `unknown` means absence cannot
be established.

Cluster the denies by the reason's leading clause. Two shapes are candidates:

- one clause recurring across tasks — the authority vocabulary lacks a
  narrower grant for that work, and the candidate is that missing word (the
  path-scoped destructive grant began as exactly this cluster);
- heterogeneous denies each answered by an immediate broad grant — reflexive
  escalation, which argues for a narrower general form rather than more broad
  grants.

A deny with no following grant on a task that still reached achieved is the
gate working as designed, not a candidate — but draw that reading only from
covered evidence and valid authority, never from a gapped window. Vocabulary
candidates go through the same single-candidate handoff below.

## Mine review findings

`queries.reviews` lists each recorded review — level, reviewer, and its
blocking and advisory finding counts. Blocking findings gate acceptance and
are resolved before a task reaches achieved; advisory findings never gate, so
they are the ones that accumulate unread. The usual coverage discipline
applies: the string `unknown` means absence cannot be established.

The rows carry counts; the findings themselves live in the review receipts
under `docs/reviews/`, one file per review named by its `review_id`. Mine from
both: counts locate where advisory findings accumulate — which tasks,
reviewers, levels — and the receipts name what kind keeps recurring. Read a
recurring kind as a standards axis the criterion never encoded — the criterion
says the work is done, the advisory says the work still drifts from a
convention no check enforces. A kind recurring across tasks is a candidate: it
names a standard worth turning into a check or a documented rule, so the loop
stops shipping it review after review. A one-off advisory on an otherwise
clean task is not a candidate, and a recorded review whose receipt is missing
is a coverage gap to report, not a silence to skip. Counts and receipts are
observations; which standard a cluster names is attended interpretation.
Candidates go through the same single-candidate handoff below.

## Protect evidence pointers

Remove repository, session, agent, and personal identifiers from shared prose.
Keep exact local evidence pointers only where the authorized reviewer can open
them. Never copy credentials, raw personal data, transcripts, or unredacted
logs into a candidate.

The ledger itself is the deduplication baseline. A repaired symptom disappears;
an abandoned attempt remains in task history; a still-live signal should be
derived again from fresher evidence rather than hidden in a separate rework log.

## Hand off exactly one candidate

Classify the candidate by its terminal verb:

- machine-verifiable change → open one workloop task with an executable
  criterion and narrow envelope;
- taste or human acceptance → open one judgmentloop task with its rubric and
  explicit acceptance path.

Do not batch candidates into one task and do not rewrite loop rules unattended.
Bind the host's monthly reminder with [REMINDER.md](REMINDER.md): it must carry
the incremental terminal and abandoned counts since the prior reminder. A
human decides whether those numbers warrant a run; there is no machine
threshold and meta-loop is never unattended.

## Report

Name the review window, integrity/coverage state, one symptom, the mechanism
hypothesis, de-identified evidence pointers, the chosen handoff, and what would
falsify the candidate. If integrity is not adequate, report only the gap and
the repair command.
