---
"fabric-app": patch
---

Retire the personal route trees under the account group, leaving one redirect where each stood

Sixty-nine pages across fifteen trees are gone; each tree keeps a single catch-all that resolves the caller's organization and rebuilds the same path inside it, so a bookmark, an email link or a hardcoded callback still arrives. The developer harness at `/app/test`, which had no organization counterpart and no inbound link, is removed outright.

The redirect sits under each name rather than once at the group root, and that shape is forced rather than chosen: Next refuses a second catch-all beside the existing `/app/[...rest]`, and `[...rest]` never receives these paths anyway — the dynamic organization slug claims them first. A catch-all behind a static segment does win, which is why there is one per tree.

The admin audit-log guard test moved to the organization page rather than going with its route: the guard is identical on both and nothing else covered the organization copy.
