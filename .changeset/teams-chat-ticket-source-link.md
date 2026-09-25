---
"fabric-app": patch
---

Features and bugs approved from a monitored Teams chat now link back to the chat message they came from, and Teams features show that link in their details.

Fizzy #2503, follow-up to the proposal-inbox fix. The inbox linked chat
proposals to their source, but the work item created on approve still had
none: `buildTeamsReporterInfo` filled `reporterSourceUrl` only from
`threadRootWebLink` or `channelWebUrl`, and both are always null for a chat
(Graph gives chat messages no `webUrl`). Separately, `ProvenanceSection` showed
the "Proposed" row only when `reporterName` was set, and the Teams path never
sets it, so even a Teams channel feature with a stored link never displayed it
(bugs showed it only in the BUG-only strip on the work item page).

- `resolveTeamsChatSourceLink` (packages/api/modules/projects/lib) builds the
  documented chat-message deep link from the linked chat's Graph id and the root
  message id. Both the proposal `get` (now `teamsChatSourceLink`, replacing
  `teamsChatId`) and approve use it, so the inbox and the work item carry the
  same link and the URL is built in one place.
- Approve resolves it once per proposal and uses it after the stored thread
  link, before `chatWebUrl` / `channelWebUrl`.
- `ProvenanceSection` shows "Originally proposed via Teams" with a "View source
  conversation" link when there is a source link but no reporter name.

Work items created from chat proposals before this change keep no link;
re-deriving it would need a data backfill.
