---
"fabric-app": patch
---

Readiness checklist: keep an item's actions reachable while it is snoozed, reject a development start date in the past, point the chat and transcript items at something, and return the checklist to 26 rows.

Closes the remaining items from the 20 August call, checked against the ticket's own numbered list.

- **A snoozed item keeps its actions.** A snooze quiets a reminder; it should not take the item away. Not applicable and the call-to-action stay reachable alongside Change and Un-snooze.
- **Expected development start cannot be in the past.** The picker carries a `min`, and the step gate re-checks it — typing a date bypasses `min`, and a start date already gone would immediately un-quiet the codebase items the field exists to quiet.
- **"Connect Chat" and "Meeting transcripts" now highlight what to set up.** Both point into Project Settings, which had no anchors, so you arrived on a long page with nothing indicated. The chat copy also says what actually satisfies the rule: a monitor being enabled, not merely a connected workspace.
- **Every item now explains itself.** The spreadsheet carries a short description and a tooltip for all 26 rows, both were translated, and neither had ever been rendered — so a row could name a requirement while giving no clue what would satisfy it. The name is now a tooltip trigger, focusable by keyboard, carrying both.
- **The checklist is 26 rows again.** Project description was added back during the spreadsheet audit because creation did not enforce it. Creation does now, so grading it here asks twice for the same answer. The document rows' dependency goes with it; the residual — `projects.create` keeps `description` optional for the public API, the CLI and the agent tool — is recorded in the registry rather than left to be rediscovered.
