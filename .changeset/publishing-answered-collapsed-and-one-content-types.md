---
"fabric-app": patch
---

A publishing topic's Summary & Questions tab now collapses its answered questions behind a count, and offers one content-types control instead of two.

**Answered questions collapse.** The tab listed every settled question in full,
in a second list below the open ones, so the worklist grew as questions were
answered instead of shrinking — on a topic with five answers the open questions
were pushed off the first screen. The group is now a disclosure showing
"Answered · N", collapsed by default, matching the "Possibly resolved" group
directly below it. Nothing is lost: expanding it gives the same cards with the
same Amend control, and the full record of a decision — reply history and
attribution — is on the Decision Log either way.

**One content-types control.** `ContentTypesChecklist` mounted twice on the same
page: once inside the `+ Add type` popover in the tab strip, and again as an
always-present collapsible section above the questions. Opening the popover put
the identical list on screen twice. The inline copy is gone; the tab strip keeps
it, which is where it belongs — the content types ARE the tabs, so the control
that changes them sits beside them.

"Possibly resolved" is untouched: those roots were soft-closed by a regeneration
rather than settled by anyone, they stay answerable and restorable, and
`SummaryQuestionsPanel` keeps its own for the same reason.

Tests: the fifteen amend cases open the disclosure before reaching for a card,
three new cases pin the collapsed default, the open/close cycle, and that the
page carries exactly one content-types control.
