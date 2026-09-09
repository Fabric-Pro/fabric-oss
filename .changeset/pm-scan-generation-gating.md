---
"fabric-app": patch
---

Wait for a running project-management scan before generating a document

Closes the last requirement left open by the dependency-aware generation queue
(Fizzy #2199, FR29). Six of the seven named sources were already gated; the
project-management scan was not, because there was no way to ask whether one
was running.

The PM sync log records only outcomes — SUCCESS, FAILURE, CONFLICT — and is
written after an attempt finishes, so while a scan is in flight the database
holds nothing to read. Generation could therefore start against a backlog it
was about to receive, which costs most on exactly the projects the scan matters
for: the ones where a long backlog is the best documentation that exists.

The per-project poll now opens a background job when it starts and closes it on
both exits. That reuses the column the queue's outstanding arms already read
and the background-job watchdog already sweeps, so a generation stops waiting
on a dead poll at the same moment the watchdog gives up on it, rather than on a
second timer of its own. The row is closed on the failure path too — the
workflow returns rather than throws there, so nothing else would terminalize
it and every generation in the project would wait out the watchdog window for a
scan that had already stopped.

Bookkeeping never fails the scan: the reporting activity retries twice, and a
poll that cannot announce itself still polls.

Wiki and knowledge-base sync stay ungated, and not for want of effort. Content
that reaches a project from Notion or Confluence arrives as project context and
is already covered by the extraction gate; the connection rows that do carry a
SYNCING state belong to an organization rather than a project, so gating on
them would block generation in every project in the org whenever one person
syncs — a false block, which this feature has consistently traded away in
favour of a missed wait.

Replay-safe: every added command sits behind
`patched("pm-scan-generation-gating-2026-09-09")`, read once and reused on both
closing paths so open and close can never land on opposite sides of the gate. A
poll recorded before this shipped replays with all of them absent. The enum
value ships in its own migration, since a value added by ALTER TYPE cannot be
referenced in the transaction that adds it.
