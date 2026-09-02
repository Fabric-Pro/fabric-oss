---
"fabric-app": patch
---

Fizzy backlog pulls now walk every page of each board column, so columns holding more than one page of cards no longer lose cards or delete their stories.

`fizzy_get_cards` answers with one page per call — since fizzy-mcp 1.1.0 a `{cards, page, total_count, has_more, next_page}` envelope whose page size is server-controlled and variable (first page ~15 cards, later pages larger). `listAllFizzyCards` fans out one call per column but never passed `page`, and the response parser unwrapped `cards` while discarding `has_more` / `next_page`. Every column with more cards than its first page therefore came back short.

That is a data-loss path, not a display bug: the pull-only sync's `deleteStoriesNotInPMList` removes every Fabric story whose card is absent from the listing, so a truncated column deleted the stories of cards that still exist on the board.

- `parseFizzyCardsResponse` now returns the page envelope (cards plus `hasMore` / `nextPage` / `totalCount` and the raw entry count) instead of a bare card array; the parsed card shape is unchanged.
- The per-column loop walks `next_page` until `has_more` is false or a page comes back empty, deduping across pages as well as columns. The first request omits `page`, so it stays byte-identical to before and a server predating the envelope still reads as a single page.
- A 50-page-per-column cap guards a broken cursor. Hitting it with `has_more` still true throws rather than returning a partial list — the outer handler turns that into the generic fallback, matching the existing rule that a short board is worse than a failed listing.
- A failed `fizzy_get_cards` call now fails the listing the same way instead of silently skipping the column (or, mid-walk, keeping only the pages already collected) — both were short boards.
- `has_more` is read fail-closed: booleans and their exact string forms are accepted, and an envelope that declares a cursor or page number but no readable `has_more` fails the listing instead of reading as "no more pages". Only a fully undeclared envelope (pre-envelope server) is a single page.
- After a clean walk, a mismatch against the envelope's `total_count` logs a warning (counts drift while paging, so it must not throw). Per-column page counts are added to the "Per-column fetch complete" log.
- The report agent's data-gathering prompt no longer tells the model that a batch of ~15 items very likely has more behind it. Tools whose description declares the result complete (every upstream page fetched server-side) are now trusted as-is, which stops the model burning iterations re-querying them with filters.

Files: `packages/temporal/src/activities/pm-integration/story-sync.ts`, `packages/temporal/src/activities/pm-integration/fetch-pm-hierarchy.ts` (stale comment), `packages/temporal/src/activities/template-instance/report-agent-loop.ts`.

Tests: new `packages/temporal/src/activities/pm-integration/__tests__/fizzy-column-pagination.test.ts` (11 cases: multi-page walk and the `page: 2` argument, derived cursor when `next_page` is absent, cross-page dedupe, empty page with `has_more` still true, unusable-but-present entries, the page cap failing the listing, a failed page request failing the listing, string-boolean and camelCase envelope fields, an unreadable `has_more` on a paginated envelope failing the listing, bare-array single page, independent per-column cursors). Full `pm-integration` suite plus the report-agent-loop suites: 714 passing.
