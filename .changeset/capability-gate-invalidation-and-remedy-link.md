---
"fabric-app": patch
---

Capability gates now refresh after any change that can affect them, and the "Add context" link on a gate reaches a page that exists.

Two defects found while verifying the previous round of capability-gating fixes on staging.

**The gate refresh was fixed too narrowly.** The first fix wired one mutation — the scan configuration save — and the next thing tried, deleting a project's documents, reproduced the same staleness because it is a different mutation. A gate is derived from live project state: documents, contexts, the project brief, the codebase connection, scan configuration and job status. Enumerating the mutations that matter is a list that rots the moment someone adds another, so the refresh now happens centrally, once, for any successful mutation. The cost is bounded — invalidation only refetches active queries, and the gate query is active only while a project page is open.

**Both remedy links on the document generation gate were dead.** "Add context" pointed at `/projects/<id>/contexts` and its sibling at `/projects/<id>/documents`; neither path has an index page — they resolve only as `[contextId]` and `[documentId]` routes — so both returned 404. Context and Documents are tabs on the project page, reached with the `?tab=<id>` deep link every other cross-page call to action already uses. A gate that explains what is missing and then sends the person to a 404 is worse than one that says nothing, so this shipped broken in the same change that introduced the banner.
