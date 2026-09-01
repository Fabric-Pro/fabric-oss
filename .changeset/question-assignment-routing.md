---
"fabric-app": patch
---

Assign project members to open maturation questions, so a question that needs someone else's input can reach them.

Fizzy #1751. Ships behind `FABRIC_FEATURE_QUESTION_ASSIGNMENT` (+ the
`NEXT_PUBLIC_` client mirror), default OFF. With the flag off the questions panel
renders exactly as before.

What it adds: a people-picker on every open question, `@` mentions in the answer
box, in-app/email/webhook notification on assignment and on answer, a deep link
that lands on the question itself, an Answered/Assigned/Unanswered tally, and
assignee avatars with an explicit unassigned marker.

Three decisions are load-bearing and easy to undo by accident:

- `Assigned` is DERIVED (`assignees > 0 && status = OPEN`), never a
  `DecisionStatus` member. An `ASSIGNED` enum value would fall out of the
  `status: "OPEN"` predicates in `getOpenQuestionCounts` and
  `markQuestionsPossiblyResolved`, silently breaking the roadmap's
  open-question badge and the reconciliation sweep.
- On `decision_log_entry_assignee`, `userId` is the TENANT key copied from the
  parent question; the assignee is `assigneeUserId`. The `user_owned` policy
  matches `"userId" = current_user_id()` on its personal branch, so naming the
  assignee `userId` would scope a row to the person being asked. Every case in
  the tenancy test uses a distinct assigner and assignee, because a same-user
  test passes either way.
- A mention offers a CHOICE rather than making one. "As per @Sam, ninety days"
  cites Sam (an answer); "ninety days, right @Sam?" asks him (not an answer).
  Only the author knows which, so a mention reveals a second button. `Ask`
  assigns everyone named, keeps the question OPEN and stores the typed sentence
  as a reply turn — it must never route through `answerQuestion`, which would
  close the very question being asked.

The table is registered in BOTH `apply-rls-direct.ts` and `tenant-db.ts`. The
parent `decision_log_entry` is RLS-only, but that is a grandfathered entry in
`TENANT_DB_BASELINE`, not a pattern to copy.

Teams/Slack per-user delivery (AC-13) is deliberately NOT included — see the PR
body. Everything else on the card ships without it.
