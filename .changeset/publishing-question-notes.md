---
"fabric-app": patch
---

A note sent to a colleague from a publishing question now appears under that question, whether it is open, set aside or answered, instead of being shown or counted as its answer; opening a question from a notification expands the group it is in; and an answer that was saved empty can now be amended.

The Decision Log no longer offers to amend a blocker's answer, which could never be saved. Restoring a set-aside question that someone answers at the same moment no longer reopens it: the restore is refused and the list refreshes. The amend endpoint accepts only the id of the question's current answer — the newest answer a person recorded — as the answer being replaced, and now refuses the id of a note written after that answer, which it used to accept.
