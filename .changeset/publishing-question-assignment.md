---
"fabric-app": patch
---

Let a publishing topic's open questions be assigned to the people who can answer them

Fizzy #1851. The suite could route a whole topic to someone but not a single
question on it, so "who is chasing the customer-name approval?" had no answer
anywhere in the product.

Mirrors Feature Maturation's routing rather than designing a second one — the
same set semantics, the same notify-on-add-only rule, the same `#q-<rootId>`
deep link, and its actual picker component. Assignment is NOT access control:
anyone who may edit the topic may change who a question waits on, and being
assigned never restricts who can answer.

- `PublishingTopicQuestionAssignee` — new table, registered in all three places
  a tenant table must be (RLS policy, `USER_OWNED_TABLES`,
  `PROJECT_SCOPED_TABLES`) with a test that goes red if any one is dropped.
  `userId` is the TENANT key and mirrors the parent question's, NOT the
  assignee; the assignee is `assigneeUserId` and is never a tenant predicate.
  Nullable, and carrying the parent's own XOR check, because the parent's is.
- `PUBLISHING_QUESTION_ASSIGNED` — a distinct notification type from
  `PUBLISHING_TOPIC_ASSIGNED`, because being added to a topic is an FYI and
  being asked a question is a request, and a recipient who cannot tell them
  apart from the bell has to open both.
- Verified by replaying every migration plus `apply:rls` against a throwaway
  Postgres: the table, its policy, its XOR constraint and the enum value all
  land, and `migrate diff` reports zero drift for the new table.
