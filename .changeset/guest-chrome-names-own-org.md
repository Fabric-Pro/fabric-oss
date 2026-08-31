---
"fabric-app": patch
---

A project-only guest's chrome names their own organization instead of a personal workspace, and no page's breadcrumb names the host

A guest is defined relative to the host organization — no membership there, an accepted project membership there — so guests still exist once every account gets an organization, and each now has one of their own. Their chrome is rooted in it: the switcher label and its checked row, every navigation link, the account destinations and the breadcrumb home. The divergence from the URL already existed to keep the host unnamed; only where it points has changed.

Twenty-three pages opened their trail with the host organization's name linked to its root, and exactly one of them dropped it for a guest. The rule now lives in the breadcrumb component, where the guest is already known, and identifies the crumb by where it points rather than by its label. The page that had its own copy no longer needs the membership probe it made for it.

Verified against a real project-only guest built through the signup path, which is how the missing twenty-two were found; reading the code had not surfaced them. The name still travels in the serialized payload, independently of breadcrumbs, so this governs what a guest is shown rather than what they could dig out.
