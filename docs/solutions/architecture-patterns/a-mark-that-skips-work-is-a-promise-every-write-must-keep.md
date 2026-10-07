---
title: "A mark that lets a later step skip work is a promise every write must keep"
date: 2026-10-05
category: docs/solutions/architecture-patterns
module: website context source crawl
problem_type: architecture_pattern
component: background_job
severity: medium
applies_when:
  - "A status or reason on a row lets a later run skip work it would otherwise do (re-embed, re-render, re-charge)"
  - "A failure path keeps a row instead of deleting it, and a later success must tell that row apart from rows that failed for other reasons"
  - "A Temporal workflow's best-effort activity is the only writer that can move a row off an in-flight status"
  - "A cleanup step (a prune, a sweep) does nothing when its input is empty, and other code relies on it to remove rows"
tags: [temporal, patched, replay, restore, retry, url-crawl, company-context, prune, idempotency]
audience: engineers adding a status or reason that lets a later run skip work, or a failure path that keeps a row
owner: Fabric platform
---

# A mark that lets a later step skip work is a promise every write must keep

## Context

A website context source is crawled page by page (Fizzy #2719). The crawl used to prune every page it had not scraped in that run, so a single timeout deleted an indexed page, with its vectors, that was still on the site. The fix keeps a page whose scrape failed: it is marked FAILED with a reason that starts with a fixed prefix (`Could not fetch this page: `). The next crawl that fetches the page unchanged makes it COMPLETED again **without re-embedding**: the prefix is the key that says "the stored content and the vectors still match".

That key is a shortcut, and every bug the reviews found was a write that broke the promise behind it:

- An empty page was marked, but empty pages never get `embeddedAt`. The restore requires vectors, so the page stayed FAILED forever.
- Project content writes did not clear the reason, so a page could carry the prefix in front of content it had never embedded.
- The Retry button set the page PENDING and **cleared** the reason. When the retry failed, nothing could tell a page with matching vectors from one with stale vectors, and the page stayed PENDING for good.
- A retry that succeeded through a redirect wrote the canonical URL's row, so the requested row stayed PENDING.
- A crawl in which every page was refused for good left empty placeholder rows behind, because the prune deliberately deletes nothing when nothing was fetched.

## Guidance

**1. Write the mark only where its precondition holds.** The fetch-failure prefix is written over a row whose vectors are known to match its content: a COMPLETED page, a page with no vectors, or (for a retry) a page that already carried the prefix. A page FAILED for another reason (an embed failure after a content change) may hold the previous version's vectors, so it keeps its own reason. An index failure on a retry gets a different prefix, never the fetch-failure one.

```ts
// The rows a later unchanged fetch may complete without an embed.
export function urlPageFetchFailureRestorableWhere() {
  return {
    extractionStatus: "FAILED",
    embeddedAt: { not: null },
    extractionError: { startsWith: URL_PAGE_FETCH_FAILURE_PREFIX },
  };
}
```

Put the precondition in the write's `WHERE`, not in a read before it, so it holds against a row that changed in between.

**2. Every write that breaks the precondition clears the mark.** A content write resets the page to PENDING and clears the reason in the same update. The vectors still belong to the earlier content until the embed runs, so a prefix must not survive the write.

**3. A mark with nothing to skip routes to the work.** A marked page with no vectors has nothing to restore. Its unchanged content goes to the embed path instead of the skip path:

```ts
const markedWithNothingIndexed =
  existing.extractionStatus === "FAILED" &&
  existing.embeddedAt === null &&
  (existing.extractionError?.startsWith(URL_PAGE_FETCH_FAILURE_PREFIX) ?? false);
const skipEmbedding = hashUnchanged && !forceWrite && !markedWithNothingIndexed;
```

**4. A step that parks a row in an in-flight status keeps what it needs to put the row back.** The retry procedure now sets PENDING and *keeps* the reason. If the retry fails, the record reads it back: a fetch-failure reason (or no vectors) gets the new fetch-failure reason, and anything else keeps its earlier reason. Clearing the reason "for a clean slate" is what made the failed retry unrecoverable.

**5. The writer that settles a failure is not optional plumbing.** In the Temporal workflow, the failure record is the only write that moves the page off PENDING, and the workflow only logs one that fails. Therefore:

- give it its own proxy with a longer retry window (here about four minutes) instead of the shared group's three seconds;
- gate the new command with `patched()` once, at the start of the branch, and cover every path the branch changes with that one decision (the fetch failure, the index failure, the requested-row upsert);
- validate replay against a history recorded **with the previous workflow code**, and run the same check against a copy with the gate replaced by `true`. That mutant must fail; otherwise the check proves nothing.

**6. Keep on a failure you could not record, and let the recorder remove what it decides not to keep.** If the record itself fails, the crawl keeps the URL: pruning on an unrecorded failure is exactly the data loss being fixed. A row the record decides not to keep (an empty placeholder the site refuses for good) is deleted by the record itself, with a guarded `WHERE` (`contentHash: ""`, `embeddedAt: null`), because the prune is a no-op when the crawl fetched nothing.

## Why This Matters

A skip-work mark is a cache: it trades a re-check for a promise about the row. A row that keeps the mark after the promise broke is served stale. Here that meant vectors from old content answering searches. A row that cannot get the mark back after it should have one is never cleaned up: it stays FAILED or PENDING forever, with no UI action that clears it. Both failure shapes come from writes far from the code that reads the mark: a retry procedure in the API, a content write in an activity, a prune that is a no-op.

## When to Apply

- A status, reason or flag lets a later run skip expensive work.
- A failure path keeps a row and a later success has to tell it apart from rows that failed for other reasons.
- A background job's best-effort activity is the only thing that can settle a row it left in flight.

## Examples

Tracing each write against the promise, before and after:

| Write | Before | After |
|---|---|---|
| Project content write | PENDING, reason kept | PENDING, reason cleared |
| Retry procedure | PENDING, reason cleared | PENDING, reason kept |
| Retry scrape fails | row left PENDING | FAILED; fetch-failure reason only if vectors match |
| Retry embed or upsert throws | row left PENDING | FAILED; "Could not index this page: ..." or the earlier reason |
| Retry through a redirect | canonical row written, requested row PENDING | requested row written |
| Every page refused for good | empty placeholders left | the record deletes them |

## Related

- [a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md](a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md): the guard a retry starts from; here the retry record guards on the PENDING it set.
- [a-long-jobs-progress-comes-from-the-rows-it-writes.md](../design-patterns/a-long-jobs-progress-comes-from-the-rows-it-writes.md): the same crawl's progress, counted from page rows.
- [cancelling-temporal-backed-jobs.md](cancelling-temporal-backed-jobs.md): why a cancelled run skips the failure record.
- [Company Context](../../features/company-context.md): Ingestion describes how the crawl keeps and marks pages.
