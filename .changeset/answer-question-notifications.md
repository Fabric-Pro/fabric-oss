---
"fabric-app": patch
---

Tell the person who asked a question when it gets answered, and tell anyone an answer cites

Question routing shipped three notification kinds and only ever emitted one. `fanOut.questionAnswered` and `fanOut.questionMentioned` were written, registered in the payload validator and covered by their own doc-comments — and had no production caller anywhere in the repo, so `answerQuestion` raised nothing at all.

The visible effect was a broken round trip: you route a question to somebody, they answer it, and you are never told. Whoever asked now hears back — recipients are the `assignedByUserId` values on the assignment rows, so after a re-assignment it is the person who handed the question on, not whoever asked first.

The other half is the informational one. Citing somebody in an answer ("as per @Sam, ninety days") named them in the text and notified them of nothing; they now get a `QUESTION_MENTIONED` notice that asks for nothing, which is what separates it from the assignment. The client resolves the ids from the display names it rendered — matching on the rendered name is what keeps the stored answer plain text, so the server cannot re-derive them without duplicating the panel's matcher — and they are narrowed through `filterAuthorizedMentionRecipients` before anything is written, so a stale or crafted id cannot mint a notice for a stranger.

Both fire only on a real answer, never on the deduped/idempotent path where re-submitting would re-ping the asker, and only after the Clean Spec write, so an answer that lost a concurrency race announces nothing. The dispatch is best-effort, like every other one: the decision is durably recorded before it runs, so a lookup failure is logged rather than failing a request whose write succeeded.

Links are context-relative (`projects/<id>/stories/<id>#q-<root>`), so `resolveNotificationLink` resolves them against the notification's own workspace rather than whichever organization the recipient is viewing.
