---
"fabric-app": patch
---

Settings now warn when no chat channel is linked for Work Capture, and a document's auto-refresh settings warn when a refresh has nothing to read.

Fizzy #1930, round 3. Two WARNING-only rules on the capability-gating engine; nothing is disabled and no door calls the assert.

- `settings.work-capture` (surface `settings`): warns with `settings.no-linked-channel` when the project has zero linked Slack channels, Teams channels and Teams chats (summed from `_count` on the existing project read — no new round trip). Remedy null: the link controls are the cards directly below the banner, which mounts once at the top of the chat-monitors group in Settings → Knowledge.
- `documents.auto-refresh` (surface `documents`): built from exactly what the scheduled refresh reads — context rows its retrieval can return (any kind but INTEGRATION and the indexer's CODE_FILE kinds, embedded or COMPLETED) and the Slack/Teams INTEGRATION conversations it fetches live. An indexed repository is deliberately not an input: code-index vectors carry synthetic `code:` ids that retrieval cannot hydrate, so they never reach a refresh. Features/stories and decision threads are not inputs either (no story is embedded; the refresh passes no storyId). Warns `documents.refresh-sources-processing` (remedy WAIT) while context ingestion runs and has not stalled, otherwise `documents.refresh-nothing-to-read` (remedy ADD_CONTEXT). Processing wins, since a source on its way is not a missing one. One existence probe (`take: 1`) nested on the project read. The banner sits at the top of the auto-refresh settings popover, which exists only once refresh is on; the popover's trigger gains a highlight dot while it warns.
- Fingerprints cover only the facts each rule reads.
- The gates provider now also asks for the `settings` surface.
- `TeamsChatSelectorDialog` adds conversations through bare client calls, so it now invalidates `["capability-gates"]` itself (the Slack dialog already did). The Settings monitor cards' link and unlink paths all run through `useMutation`, so the central MutationCache refresh already covers them; a test on the real query client pins that.
- The registry header's "pending a product decision" block is gone: Work Capture and living-document refresh are built; the PM Sync toggle and terminal-status rows move to the Project Suite 3A card (#2204), decided as "disabled until a PM tool is connected".
