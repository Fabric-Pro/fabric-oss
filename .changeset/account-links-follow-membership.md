---
"fabric-app": patch
---

Account-level links follow the organization you belong to, not the one in the URL

A project-only guest is rendered under the host organization's slug, so a path derived from the URL sends them to the host's account settings — and the organization settings layout bounces a guest straight back out. The two-factor setup banner did exactly that after account security moved into the organization tree.

`useAccountPath` resolves to an organization the caller actually belongs to: the URL's when it is one of theirs, which is the ordinary case and keeps the chrome consistent with what they are looking at, and otherwise their own.

Found by running it against a real project-only guest rather than by reading the code — the link rendered, and following it returned the guest to the project they came from.
