---
"fabric-app": patch
---

Page the Planning & Analysis version history instead of loading every revision at once

Follow-ups to Fizzy #1851 slice 1, recorded as known residuals when that
landed.

**Paging.** `listAnalysisRevisions` returned the whole append-only history in
one response, and every row carries a `body` the writer bounds at 40,000
characters — so the response grew without limit for exactly the topics worked
on hardest. It now takes a keyset cursor on `version` (25 per page, ceiling
100) and returns `{ revisions, nextCursor }`; the drawer became a
`useInfiniteQuery` with a "Load older versions" control. `version` is
monotonic and unique per topic, so no opaque encoded cursor is needed — unlike
the `listAuditLog` sibling, whose order has no single key. `take: limit + 1`
answers "is there more" from the same snapshot as the rows, so a last page
that happens to be exactly full does not advertise a next one.

Not done here, deliberately: `body` still travels with every listed row. The
list pane does not render bodies — only the two compared versions and a
restore need one — so dropping it from the select is the larger win, but it
moves the restore path onto a fetched body, and that path carries the
compare-and-set. Not a change to make inside a debt-paydown PR.

**A silent bug the migration would have introduced.** Restore invalidated the
list with `queryKey({ input })`, which stamps `type: "query"` into the key.
An infinite query caches under `type: "infinite"`, so that key would have
matched nothing: restore would keep succeeding and toasting while the drawer
showed history missing the version just written. Now uses `key({ input })`,
the partial form built for invalidation. The suite's oRPC mock exposes only
`key`, so a regression to `queryKey` fails loudly rather than silently —
verified by reverting the call and watching 5 tests turn red.

**Resolver invariant.** The four generate-* activities no longer run their own
`publishingTopicPlanningAnalysis.findFirst`, and nothing pinned that. The
existing negative control asserts the prompt carries the author prose, which
an activity that still ran the inline read and discarded the row would also
satisfy. Added `expect(analysisFindFirst).not.toHaveBeenCalled()` to all four;
proved it can fail by re-injecting the inline query, which reddened exactly
that assertion while the other 11 cases in the file stayed green.

**Stale pointer in `db-integration.yml`.** The breakdown read "1D-1b measured
379 passing across these 19 files"; the list beside it now holds 20. Both
numbers are correct history, so bumping 19 to 20 would have credited a past
measurement with a file that did not exist when it ran. Reworded to date the
measurement instead.

Tests: 4 API cases (cursor/limit forwarding, `nextCursor` pass-through, two
schema rejections), 4 DB-integration cases against real Postgres (page order,
strict-less-than cursor, exactly-full final page, project scoping), 4 drawer
cases (control visibility, multi-page flattening, fetch trigger). 116 temporal
+ 24 API + 75 web green locally; the DB cases run only under
`RUN_DB_INTEGRATION=1`.
