---
"fabric-app": patch
"@fabricorg/sdk": minor
---

Wait for a project's context to finish arriving before generating a document, instead of generating against a half-built picture of it

A project accumulates its context asynchronously — a repository indexes over
minutes, an uploaded specification extracts and embeds, a linked site crawls
page by page — and none of that held anything back. Connecting a repository and
immediately asking for a Technical Architecture produced a document written
without the code in it, which reads like a finished architecture document and is
therefore reviewed, circulated and built on before anyone notices.

Generation now probes what the project still has arriving and blocks on a
durable timer until it clears. The wait lives inside the generation workflow
rather than in a queue table, because durability across a page exit, automatic
restart when the wait ends, and the absence of new stuck-job detection are all
things the platform already provides — a table plus a sweeper would rebuild all
three and need its own watchdog. It sits behind one patch marker so a recorded
history replays with the branch collapsed to nothing, the interval widens from
ten seconds to a five-minute ceiling, and a sleeping workflow is evicted from
worker memory, so an hour-long wait costs no worker slot and survives a deploy.

Six of the seven source types named in the ticket are gated. Codebase indexing,
source extraction, linked-site crawls and the security scan carry queryable
in-progress state; transcript and chat ingestion are covered through their
background-job rows, which are best-effort by design, so a dropped row means
generation proceeds rather than waits — a missed wait, never a false block.
Project-management scans record only terminal outcomes and wiki sync is not
associated with a project at all, so neither can gate anything without building
run-state tracking those integrations do not have; that is left as follow-up.

Duplicate detection replaces an equivalence-comparison subsystem with a hash.
The workflow id was salted with the clock, so two identical requests could never
collide and Temporal's own duplicate rejection could never fire; it is now a
sha256 over the inputs that decide the output, with the conflict policy set to
FAIL and the reuse policy stated explicitly as ALLOW_DUPLICATE — the id is
stable forever, so a closed prior run must still permit a new start or a
document could never be regenerated twice with the same settings.

The ticket's delayed-credit-consumption requirement is unsatisfiable as written:
the platform's AI allowance was removed, so there is nothing to delay. Its real
content survives and applies to the short-lived AI token, which is now minted
after the wait rather than carried through it — and the requester's project
access is re-resolved immediately before that mint, because moving the mint past
an unbounded wait opens a window that did not exist when it lived inside an
authorized request.

A distinct QUEUED document status was needed because six mechanisms read
GENERATING as work that should be finishing shortly: the client's three-minute
staleness affordance, the server watchdog, the Documents tab's polling and
progress ladder, the readiness roll-up, the pipeline and overview views, and the
public v1 API and SDK status unions. The last three are string-typed and would
not have been caught by the type checker. The watchdog gains an asymmetry rather
than a second sweep — GENERATING rows keep the age ceiling, QUEUED rows have
none and are recovered only when the liveness check it already performs reports
their workflow is gone.

The word "queued" already meant something else in two places, and both were
fixed rather than worked around: the Documents tab inferred a queued pill from a
generating document with zero progress (the worker queue, not the context wait),
and the Job Hub's step vocabulary labelled "pending" as "Queued", which would
have shown a waiting generation's context step as running and its unstarted
generate step as queued — the inverse of the truth.

Replay safety, checked rather than assumed: the whole addition sits behind a
single `patched("document-generation-dependency-wait-2026-09-07")` marker, and
the job-hub and notification writes reuse it through local flags rather than
adding gates of their own, so every added command stays on one side of one gate
and a pre-queue history replays with all of them absent. Durations derive only
from the deterministic replay clock; `continueAsNew` is deliberately not used
because it mints a new runId and would break the project-workflow-status
correlation and the watchdog's liveness lookup, so a run whose history grows
past the server's suggestion ends through the same blocked path as a failed
dependency. The full temporal suite passes, and the replay-validation gate's
path filter covers the whole package, so the probe activity trips it too.

Fizzy #2199.
