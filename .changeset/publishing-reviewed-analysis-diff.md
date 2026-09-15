---
"fabric-app": patch
---

A proposed planning analysis is now reviewed as a diff before it replaces the document.

Fizzy #1851, design-QA findings #5 and #6 and proposal 5.

Three things could replace a topic's planning analysis and none of them showed
what they changed: the assistant's rewrite loaded straight into the editor, the
stale-analysis banner's Replace wrote a revision outright, and the View dialog
offered that same Replace after showing the newer text read-only. All three now
open one review, built on the `DiffReviewBar` / `DiffViewModeToggle` /
`DiffPreviewPanes` trio the Full Specification and document editors already use.

No new server surface. Feature Maturation's pending draft is derived rather than
stored, and this follows it — but deliberately NOT its write ordering: that
editor persists the AI result and compensates on reject, while this suite leaves
an accepted review unsaved in the editor, because #1929's worst defect was an
autosave racing an agent run and overwriting the server with pre-answer text.
The author's own Save stays the only writer.

The subtle part is the stamp. `isStale` is `sourceAnalysisVersion < aiVersion`,
so a document reviewed against analysis version N has to be SAVED as N's or the
banner never clears — which is exactly why Replace was once its own write. A
review therefore carries the version it must stamp, held until the save lands. A
rewrite from the assistant carries none: it is based on the document as it
stands, so the stamp must not move.

Also in this change:

- The "N answers were recorded after the analysis was written" banner moves
  above the tabs and carries its own Regenerate. It used to be a full banner
  inside the Planning & Analysis tab plus a muted sentence on Summary &
  Questions, and Radix unmounts an inactive `TabsContent` — so the one person
  who had just made the analysis stale, by answering a question, was the one
  person who could not see it. The tab's header Regenerate now stands down while
  that banner is up, so only one control starts a run (design-QA #5).
- Feature Maturation and the Publishing Suite render one `SuggestedAnswerOptions`
  for a question's AI answers, instead of two dialects of the same control under
  headings in two different colours (design-QA #6). Answer classification is
  untouched: each surface still records AI_SUGGESTED / AI_EDITED / MANUAL exactly
  as before, because that column is a measured acceptance metric.
- The analysis editor drops its `max-w-3xl` reading measure, for parity with the
  Full Specification editor.
- `useDiffPreview` optional-chains `editor?.state?.doc`; the chain on `editor`
  alone throws for an editor handed in before ProseMirror has attached its state.
