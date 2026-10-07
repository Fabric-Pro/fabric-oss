---
title: "A long job's progress and liveness come from the rows it writes, not from its parent"
date: 2026-10-05
category: design-patterns
module: company context website crawl
problem_type: design_pattern
component: background_job
severity: medium
applies_when:
  - "A page shows the state of a background job that writes child rows (pages, chunks, items) and finalizes its parent row only at the end"
  - "A list stops polling after a cap measured from the parent row's last write"
  - "A progress figure is derived from the statuses of persisted child rows"
  - "Deciding whether a parent has ever finished a run, using fields that a failed run also writes"
tags: [polling, progress, liveness, url-crawl, company-context, first-run, react-query]
audience: engineers showing the progress of a background job that writes child rows, or polling a list while one runs
owner: Fabric platform
---

# A long job's progress and liveness come from the rows it writes, not from its parent

## Context

An organization's Company context page read "8 of 9 ready", and the missing source looked like a failed upload. It was not. It was a 200-page website on its first crawl. The crawl scrapes one page at a time (about 50 seconds a page), so it ran for almost three hours, and a website becomes ready only when the crawl's last step marks the source embedded. Two things hid that from the person watching:

- The row said only "Processing…", with no sense of how far along it was or how long it would take.
- The list polled every 2 seconds, but only for 5 minutes after the source's last write (`updatedAt`). A crawl writes its page rows, not its source row, so after 5 minutes the row froze, and the switch to Ready never appeared without a reload.

Adding an "N of M pages" figure looked simple: count the pages that left PENDING. Two review passes, with three reviewers and a second model agreeing, showed that the figure is honest only for a first crawl that created every row itself. Every other kind of run reads as nearly done for hours.

The diagnosis took two read-only steps against the live data. First, the list RPC from a signed-in browser gave each source's `extractionStatus`, `extractionError`, `ready`, `embeddedAt` and `extractedAt`. Second, a histogram of the website's page `lastFetchedAt` values showed a steady 10 to 18 pages per 10 minutes, with no gap and no failure. That pattern says "slow but healthy", not "stuck".

## Guidance

**Measure liveness from the child rows.** While the job holds its claim, the newest child-row write is its heartbeat. Take the latest of the claim time (the parent's `updatedAt`, which the claim bumps) and the newest child write (`max(lastFetchedAt)`). Stop following once that is older than an idle limit derived from the job's retry budget. Count the steps that write nothing on failure: a scrape that fails three five-minute attempts writes no page, so one hung page costs about 15 silent minutes.

```ts
// company-context-adapter.ts: past the 5-minute cap, follow a crawl that is still working
if (source.crawlInProgress) {
  const lastFetchMs = source.crawlLastFetchedAt
    ? new Date(source.crawlLastFetchedAt).getTime()
    : 0;
  liveCrawl ||=
    nowMs - Math.max(lastWriteMs, lastFetchMs) < MAX_COMPANY_CRAWL_IDLE_MS; // 90 min
}
```

A crawl whose workflow is gone but whose claim was never released writes nothing, so the list lets it go instead of polling forever.

**Derive progress from child statuses only when this run created every row.** Check each way earlier rows survive into a new run:

- A refresh keeps the earlier statuses. An unchanged page stays COMPLETED until the crawl reaches it, so a refresh reads "199 of 200" from its first minute. Show progress only for a first run.
- A run's end turns its leftover PENDING rows into CANCELLED. The next run skips existing URLs instead of re-creating them, so those CANCELLED rows are still to do. Count only terminal statuses as processed (COMPLETED and FAILED). Never compute "total minus in-flight".
- "Has this ever finished?" needs a marker that only success writes and nothing clears. Here `urlLastSyncedAt` looked right, but a failed crawl writes `null` to it, which makes a long-indexed website look new. `extractedAt` is written only with COMPLETED and never cleared.

**Read the total and the counts in one grouped query.** Two separate reads (a relation `_count` for the total, then a status count) can straddle a bulk insert and produce a negative or inflated figure. One `groupBy` over `(parentSourceId, extractionStatus)` with `_count` and `_max(lastFetchedAt)` gives the total, the processed count and the heartbeat from one snapshot. Run it only for parents that hold a claim, scoped by `organizationId`.

**Say what the total means.** Pages found by following links are created as they are scraped, not up front, so the total can grow. "47 of 200 pages found so far" stays true when it does.

## Why This Matters

A progress figure that reads as nearly done for hours is worse than none: people wait, then reload, then conclude the job is broken. The same goes for a list that stops refreshing while the job is visibly still running. Both mistakes come from the same assumption, that the parent row reflects the job's state. For a job that writes child rows and finalizes its parent only at the end, the parent is silent for the whole run.

The bug class spans the stack. The poll cap lived in a React adapter, the readiness rule in a SQL predicate, and the status lifecycle across a Temporal workflow and its finalize activity. Each piece looked correct on its own; only tracing a full run (first crawl, refresh, failed crawl, restarted crawl) showed the gaps.

## When to Apply

- A UI follows a background job that writes many child rows and updates its parent only at claim and at finalize.
- A list's polling stops on a timer measured from a row the job does not touch while it runs.
- A figure such as "N of M done" is computed from persisted child statuses that earlier runs also wrote.
- A "first run" or "never finished" check reads a field that a failure path also writes.

## Examples

Before, progress was counted against the in-flight statuses. A refresh, or a restart after a cancelled run, read as complete:

```ts
processedPages: _count.urlPages - pagesInFlight, // PENDING + EXTRACTING only
// CANCELLED leftovers and still-COMPLETED pages from the last run count as done
```

After, the figure counts only terminal statuses, applies only to a first run, and all three numbers come from one read:

```ts
// summarizeCompanyContextCrawlPages: one groupBy, org-scoped, only for sources holding a crawl
by: ["parentSourceId", "extractionStatus"],
_count: { _all: true },
_max: { lastFetchedAt: true },
// processedPages = COMPLETED + FAILED; CANCELLED stays to do

// list.ts: progress only while the website has never finished a crawl
if (extractedAt !== null || !pages || pages.totalPages === 0) return null;
```

Tests pin each case: a first crawl reads "47 of 200"; a refresh and a re-sync after a failed re-sync read `null`; a CANCELLED row counts as still to do; past the cap, a crawl that fetched a page within the idle limit keeps a 15-second poll, while one that has fetched nothing for 90 minutes is let go.

## Related

- [a-stale-heartbeat-is-the-question-not-the-verdict.md](../architecture-patterns/a-stale-heartbeat-is-the-question-not-the-verdict.md): the same liveness question from the server side; derive the threshold from the retry budget.
- [a-surface-must-not-report-absence-it-did-not-verify.md](a-surface-must-not-report-absence-it-did-not-verify.md): a status belongs to the pipeline that names it, and derived content lives in child rows.
- [cancelling-temporal-backed-jobs.md](../architecture-patterns/cancelling-temporal-backed-jobs.md): how a cancel releases the claim, which ends the polling.
- [Company Context](../../features/company-context.md): Ingestion describes the crawl's readiness, progress and polling.
