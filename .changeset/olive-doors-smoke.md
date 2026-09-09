---
"fabric-app": patch
---

Publishing Suite: amend a settled answer, date repeated meeting citations, expand the participants list, and give the list page its breadcrumb trail

Four UI-review follow-ups on the Publishing Suite.

**Amend an answered question.** A RESOLVED question rendered as read-only text
with no way back, while Feature Maturation's Decision Log has offered the same
correction for a while. New `amendTopicQuestion` procedure over a new
`amendTopicQuestionAnswer` query. It APPENDS a superseding reply rather than
editing the original, so the Decision Log keeps the replaced turn as history —
and it is a SECOND write path rather than a relaxed `answerTopicQuestion`,
because that one's refusal to answer a settled root is what stops a
double-submit minting two replies for one act. No schema change: replies under a
root are already a chronological chain, so the live answer is the newest one
carrying content, which is why `AnsweredCard` and `DecisionCard` had to stop
reading `replies.find(...)` — the first reply is now the OLDEST answer.
Concurrency is guarded by a `supersedesId` the client sends plus a
compare-and-set on the root's `updatedAt`; a loser gets `stale` and a warning
toast rather than silently overwriting a colleague's correction. `answerSource`
is MANUAL, always: the editor is seeded with the answer on record, never with
`recommendedResponse`, so nothing typed there is an act of accepting the AI's
wording — the same honesty
`20260828120000_repoint_ai_edited_answer_source` was written to restore.

**Dates on repeated meeting citations.** A recurring series produces one
transcript per occurrence sharing one `meetingSubject`, so "Based on …" could
correctly name the same meeting twice with nothing to tell them apart.
Provenance still dedupes by transcript id; the LABEL now carries a short date —
`"Weekly sync" meeting (Sept 9)` — with the year appearing only when it is not
the current one. Formatted server-side and pinned to UTC (a client-side format
would move the day for readers far from UTC), from the existing transcript
select so the block's all-or-nothing degrade still covers it. The month table is
hand-written: `Intl`'s en-US short month renders "Sep", and reaching for en-GB
to get "Sept" would make the label depend on the runtime's ICU version.

**Expandable meeting participants.** `Meeting participants — A, B, C +2 more`
was a dead end: the names past the third were capped out SERVER-side, so
nothing on the page could reveal them. The single-topic read now carries up to
`MEETING_PARTICIPANTS_DETAIL_CAP` (25) of them and the topic page unfolds the
rest behind an `aria-expanded` disclosure. The Inbox read keeps the tight cap —
133 rows do not need it — and because the payload is what decides whether a
disclosure appears, an Inbox row renders the identical markup it always has.
The server's own `overflowCount` stays a plain count in both states: those names
never left the server and no click can reveal them.

**Breadcrumbs on the Publishing Suite list page.** Every other project page
carries the trail and this one did not, which is why it read as detached. Added
to the route wrapper rather than to `PublishingSuiteList`, which has a second
mount inside `ProjectDetails` that renders its own trail — a component-owned
trail would render twice there.
