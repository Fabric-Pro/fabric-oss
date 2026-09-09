---
"fabric-app": patch
---

Assign people to a publishing topic — pick several, drop yourself, and everyone added gets an in-app heads-up.

Fizzy #1851 slice A8. `PublishingTopic.assigneeUserIds` is a new column, deliberately NOT an overload of
`contributorUserIds` / `userContributorUserIds`: those record whose work a topic derives from (attribution),
this records who should pick it up (routing). Two migrations, because a value added by `ALTER TYPE` cannot be
referenced in the transaction that adds it — `20260909120000_add_publishing_topic_assignees` (the column) and
`20260909120100_add_publishing_topic_assigned_notification` (the `PUBLISHING_TOPIC_ASSIGNED` notification type).

Informational, never access control: assigning someone changes nothing about who can see or edit the topic, and
the dialog copy says so. The new `updateTopicAssignees` procedure requires every submitted id to be a CURRENT
project member with no grandfathering — unlike contributors, whose AI resolver deliberately names non-members,
every assignee id got into the column by passing that same check, so a non-member id can only mean the person
left. The check is the same name-disclosure-oracle protection `update-topic-contributors.ts` documents.

Notification is in-app only by inheritance rather than by a special case: `fanOut.publishingTopicAssigned` goes
through the ordinary `createNotification` path, and external channels are account-global opt-in defaulting off.
It fires on ADD only (the query helper diffs against the prior set inside the write), never on removal, and
never to the person doing the assigning. Category ASSIGNMENT, not PUBLISHING — a person handing work to a person
is not the AI suggestion digest.

Assignee handles ride the list's existing contributor `db.user.findMany` (ids unioned into one lookup), so the
Inbox pays no extra query and `assignees` shares that lookup's documented degrade contract.

`AssigneesDialog` is NOT a copy of `ContributorsDialog`: its "N selected" counts the selection itself with no
"of M" denominator, where the contributor dialog counts visible rows and therefore reports "None selected"
while a selection exists that it cannot currently render. The PO hit that and reported the dialog as broken.
