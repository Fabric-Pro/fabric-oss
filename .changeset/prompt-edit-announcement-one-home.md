---
"fabric-app": patch
---

Editing a default prompt now costs one lookup instead of one per action it wins, and the contrast guard covers the tier it was written for.

Found by a post-ship review panel over the change that shipped the edit-time
notice.

Announcing N winning actions re-fetched the same prompt version and re-derived
the same catalog base path once per action, on the response path of the author's
save, and the loop was a third divergent copy of orchestration the binding path
already owns. It now lives beside that announcement. The shared part resolves
lazily and at most once — lazily because an action usually has nobody left to
tell once the actor is excluded, so neither lookup is worth doing to then send
nothing.

The AA guard needed both of the fixes it existed to prevent. Its regex read only
bare hex, so a token declaring a themeable default through `var()` never entered
the token map — which silently excluded the very tier whose 4.02:1 label
motivated the guard, leaving one tier measured and one merely asserted. It now
reads both declaration shapes and checks both neutral grounds, since a page picks
its own and the prompt grid does not sit on a card. The governance page's retry
link was itself that same failure, shipped in the change that documented it.

The regression test drops its mock of the announcer and mocks the database and
fan-out instead, so the action filter, the recipient lookup and the link a reader
receives are exercised rather than assumed — and it now covers the system tier,
which nothing did. Both new guards were verified to fail against the defect they
describe before being kept.
