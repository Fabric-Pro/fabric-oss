---
"fabric-app": patch
---

Fix the Publishing Suite's contributor picker losing a selection, and the analysis banner missing an amended answer

Follow-up to the #1851 rework, from the review of the landed branch (Fizzy #1851).

**The "analysis is behind its answered questions" banner could not fire for an amendment.**
Its predicate compared the analysis version a question was RAISED against with the version on
screen. `reconcileTopicQuestions` skips resolved roots, so that number never moves again — amend
an answer after a regeneration and the versions differ, so the banner reads "already folded in"
while the decision changed a minute ago. Answering a soft-closed `POSSIBLY_RESOLVED` root has the
same silence, because that sweep writes status and nothing else. Replaced with a comparison of
the live answer's timestamp against when the analysis was written; `getPlanningAnalysis` now
returns `aiCreatedAt` alongside the version. Four tests, two of them the sequences that were
silent.

**The contributors dialog reported "None selected" over a real selection, and Save then dropped
it.** Rows were built from `contributors` — the ids a user lookup resolved — while the selection
came from the raw `userContributorUserIds` column. Those diverge exactly when someone cannot be
resolved, and `listPublishingTopics`' degrade contract empties the resolved list wholesale while
the raw ids survive. So the selection was invisible, uncounted, and silently discarded by the
next Save, which submitted `rows.filter(selected)`. Every selected id now gets a row, and the
count is of the selection — the rule `AssigneesDialog` was already built on, rather than a third
answer to the same question.

**Breadcrumbs on the topic page.** `Projects / <project> / Publishing Suite / Topic`, owned by
the route as the list route's trail is. The redundant "Back to Publishing Suite" link is gone
with it, which puts the title at the top of the page and dissolves the inline-flex collision
that link needed a workaround for.

**The get-started spotlight had nothing to point at during a search.** The
`publishing-suite-inbox` anchor sat on the sectioned branch of the Inbox, which a search term or
a status chip replaces with a flat list — so the anchor left the DOM in exactly the states a
"Show me" is most likely to be fired from. It now rides an always-rendered wrapper, where
`publishing-suite-list` already sits for the same reason.
