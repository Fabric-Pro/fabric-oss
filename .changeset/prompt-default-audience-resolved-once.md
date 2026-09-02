---
"fabric-app": patch
---

Editing a default prompt resolves its audience once instead of once per action, and the universal-tier role lookup is now indexed.

Applies the first two of the three options raised by the post-ship performance
finding on the edit-time notice. The third — moving the fan-out off the request
path — is deliberately not taken here: it needs a queue this package does not
have, and it changes the binding path's behaviour too.

Who is subject to a tier does not depend on which action is being announced, but
it was resolved once per action anyway. For a universal default that predicate is
"who administers anything, anywhere" — no organization to narrow it, no index to
use — so a prompt winning five actions read the whole member table five times
while the author waited for their save.

`listPromptDefaultRecipients` splits along the seam that was already inside it:
`listPromptDefaultAudience` is a property of the tier and resolves once,
`markOwnOverrides` is genuinely per action and still runs per action. The
composed function stays for single-action callers. Ordering the audience first
also lets the common case — nobody left to tell once the actor is excluded — exit
before the prompt name and the link base are fetched at all.

`member(role)` gains an index, created CONCURRENTLY since the table is populated
and the deploy should not take a write lock.

Two product decisions were made and deliberately shipped as no-ops: an
organization's default stays a recommendation a personal override beats (no
mandate mechanism until one is asked for), and prompt tags are kept alongside
catalog categories rather than retired.
