---
"fabric-app": patch
---

The public API now lets only organization admins and owners create or rename organization prompts, matching the app.

Found while verifying Fizzy #2250. `POST /api/v1/prompts` always resolves an organization context and created an organization-scoped prompt for any member whose API key carried `prompts:write`; `PATCH /api/v1/prompts/:id` renamed or re-described any organization prompt the same way. In the app, `prompts.create` and `prompts.update` allow that only to an organization admin or owner — so a key granted more than its owner's role, against the rule that API keys never grant more than the UI (the same class as the v1 write-permission fix, #2380). Both routes now re-read the key owner's live membership role on every write (wildcard `*` keys included) through `verifyOrganizationMembership`, and refuse with 403 and the app's own wording in the nested `{ error: { message } }` shape, distinct from the scope middleware's flat refusal. Reads are unchanged. Verified with unit tests (member / wildcard / non-member refused with nothing written; admin and owner allowed; scope refusal distinct; PATCH 404 before any role check) that fail against the previous route (member got 201 and 200), and on a real stack — the real `createPublicV1Routes` app, API-key middleware and Postgres with an owner and a plain member each holding a real key.
