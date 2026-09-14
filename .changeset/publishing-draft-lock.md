---
"fabric-app": patch
---

A publishing draft now says when somebody else is editing it, and short-form drafts can be edited, copied and downloaded like every other format.

- **Advisory edit lock on the shared working draft.** The draft is one per
  content type for the whole topic rather than one per author, so two people
  editing was a real collision whose only signal was a conflict on save, after
  the words were typed. The lock reports who is in it and never refuses a
  write; take-over is always available and non-destructive, because every
  earlier body is in the version list.
- **Short-form drafts are editable.** Tweet and LinkedIn had no save-body
  endpoint at all — deferred when the long-form panels got theirs and never
  picked up — so the two drafts most likely to need a word changed before
  posting were the two you could not change.
- **Copy and Download on every panel**, including Blog Post, which had an
  editor and no way to get the text out of it.
- **An earlier version's candidate can be taken.** A short-form run produces
  three options, so restoring a version means picking one of its options; the
  version list was readable but not actionable.
- **Versions live behind one button** instead of a full-width block between the
  draft and its candidates.
- **Tag a colleague on a question and say why.** Routing a question used to
  notify somebody with nothing but "you have been assigned".
