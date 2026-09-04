---
"fabric-app": patch
---

Keep the meeting recycle bin reachable after the last meeting is deleted, count a disconnect the Graph tool reports rather than throws, and stop the sync menu's hint running into its label.

Three defects in the meeting-sync controls, all found by using the shipped feature rather than by review.

The recycle bin sat inside the branch that renders the linked-meetings list, so deleting the LAST meeting in a project flipped `hasLinkedMeetings` false, swapped in the empty state, and took the only route back with it — the archive still present, still inside its 7-day window, and unreachable. The case where recovery matters most was the case it was missing. It now renders beside that branch instead of within it, and the restore surface has component tests for the first time.

The Microsoft tool signals a dead connection two ways: it throws, or it answers with an `error` field. Only the throw incremented `consecutiveFailures`, so a sync that died the other way stayed on zero, never crossed the threshold, never raised the "not running" banner, and never offered the Reconnect button that exists for exactly that. The existing test missed it because its input carried no projectId, leaving both recording branches unreachable.

`DropdownMenuItem` is a flex row, so the "Keeps all N transcripts" hint — a `block` span beside a bare text node — rendered on the label's line with no gap, reading "Stop syncingKeeps all 12 transcripts". Stacked with the same `flex-col items-start gap-0.5` the other menus in this codebase use.
