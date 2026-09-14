---
"fabric-app": patch
---

Publishing topics put their context above the tabs, collapse four rows of chrome into one toolbar, group questions by what they are about, and give an approval question answers to pick between.

Round two of the owner's walkthrough (Fizzy #1851).

- **Topic context above the tabs.** `TopicDetails` was the last child of Summary
  & Questions, and Radix unmounts an inactive tab — so the rank-reason line and
  the contributor and assignee controls left the page entirely when you opened
  Decision Log or Planning & Analysis.
- **One toolbar row on Planning & Analysis**, provenance left and actions right,
  with the raw/rich toggle riding the editor's own toolbar line. It was three
  full-width rows, seven or eight once the stale, generating, failed and
  superseded notices stacked behind them.
- **One mark per format tab**, and where there is a count the count is the mark.
  A tab carried its state, its caution and its changed-since-read flag as three
  separate word pills.
- **A tab that says Generating**, so starting a run and moving elsewhere tells
  you when it finished. Reads the attempt status the page already polls, and a
  stranded run does not get a spinner that never stops.
- **Questions grouped by category**, suppressed when grouping would only add
  headings. The column has stored the category since it was added and nothing
  grouped by it.
- **Decision log in two columns** with a chip naming the analysis that raised
  the question.
- **Approval questions offer answers again.** Derived questions hardcoded no
  options, so most questions on a topic could only ever render a bare textarea;
  and a model option was discarded whenever its justification was missing.
- **A reading measure on the review tabs**, full-bleed left on the generation
  tabs where three candidate columns need the room.
- **The readiness line stops contradicting the panel above it** — it could read
  "all decisions answered" with blockers open immediately above.
- Editing pauses while an analysis is being written, matching the maturation
  editor, so a regeneration cannot land on words somebody is still typing.
