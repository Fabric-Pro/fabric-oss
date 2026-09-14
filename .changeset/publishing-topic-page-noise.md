---
"fabric-app": patch
---

Publishing topic pages stop repeating themselves: one way to pick content types, source signals collapsed to a line, and "type your own" recorded as a manual answer again.

Owner walkthrough on staging, items D1/D3/D7/D9 plus S7.

- **Content-type recommendation, once instead of twice.** The Planning & Analysis
  footer rendered the same per-type rationale already shown by `+ Add type`, the
  post-types dialog and the inline checklist — a fourth copy, with no control on
  it, at the foot of the section whose complaint was that nobody reads it. The
  `contentTypes` FIELD is untouched: it still gates which media tabs are offered
  and still feeds the picker.
- **Source signals collapsed.** On a topic whose only inputs are its own title
  and summary they restate the page header. Count visible, list one click away.
- **One post-types affordance on the topic page.** `Edit post types` and the
  modal behind it are gone from the Topic Item Page; `+ Add type` in the tab
  strip already opened the same checklist through the same handler. The dialog
  still ships for the Inbox row, which has no tab strip to host a `+`. Parity was
  the open question when this was attempted and reverted before — it is settled:
  `publishing-content-types-checklist.test.tsx` covers every behaviour the
  removed dialog tests pinned (reasoning per choice, grouping by verdict,
  choosing a deferred format, resetting to the AI suggestion, the reader case).
- **Amend matches Feature Maturation.** Pencil plus tooltip instead of the bare
  word, and RESOLVED-only — an answered-but-still-open thread can still be
  superseded by a regeneration, so offering to amend it invited an edit the next
  run may discard. Reachable before on the All and Open filters.
- **`MANUAL` answer source is reachable again.** "Type your own" routed through
  the same helper as "Edit", which seeded the AI's sentence and set the
  from-suggestion flag, so every hand-typed answer on a question that carried a
  recommendation recorded `AI_SUGGESTED` or `AI_EDITED`. That is the
  misclassification `20260828120000_repoint_ai_edited_answer_source` swept out of
  `decision_log_entry`, reappearing in a second table, and it inflated apparent
  recommendation acceptance in the adoption metrics. The file's own comment
  described the correct behaviour throughout.
- A stale doc-comment claiming the decision table records no author name is
  corrected; it outlived its fix and was later cited in review as evidence of a
  defect that did not exist.
