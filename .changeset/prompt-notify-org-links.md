---
"fabric-app": patch
---

Prompt notifications now deep-link into the organization's own pages, and the nomination title reads "an organization".

An organization-scoped nomination or default change linked to `/app/prompts/nominations` and `/app/prompts/catalog` — the personal-context pages, which show a different tier's view entirely — so a reviewer clicking their bell landed somewhere that could not answer it. Both announce helpers now resolve the organization's slug and build `/app/{slug}/…`, falling back to the personal path in personal context; callers no longer pass a base path they can get wrong.
