---
name: meta-loop
description: Diagnose whether supervised loops converge, where they fail, and how adoption behaves from taskloop's machine ledger. Use for the periodic ledger review, when the monthly reminder reports new terminal or abandoned counts, or when asked why loops stall, suspend, or bypass supervision.
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
