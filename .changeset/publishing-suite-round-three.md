---
"fabric-app": patch
---

Publishing Suite: every generated draft version is reachable, blockers are named separately from questions, decisions carry their author, and the analysis starts when a topic is selected.

Fizzy #1851, round three. Two things at once: the findings a full re-audit found
had been recorded as delivered and were not, and the items from the walkthrough.

**Recorded as done, and were not.** defect §2 was fixed on three panels of five
and missed on the two short-form ones, so a v1-generalized / v2-clean pair
dropped the note while copy and download still exported the text · assignees
"on the row" rendered only inside the expanded disclosure · the breadcrumb
named the section for exactly one tab, so Publishing Suite named nothing on the
path everyone takes · the "analysis is behind your answers" banner rendered
only inside a Radix tab that unmounts, while answering happens on the default
one · `CONTENT_TYPE` stayed in the restriction predicate after the checklist
replaced those questions, so legacy rows cautioned tabs with no answerable
question behind them and told the generation prompts to write around an
approval nobody could grant · draft version 1 was unreachable, and the five
adopt endpoints narrowed to `latestReady` besides · the candidate drafts were
restyled when the ask was a redesign.

**From the walkthrough.** Section labels lose their red and the prose beneath
them clears the AA contrast floor · a `+` on the tab strip opening the existing
checklist as a popover · participants in the header · the generalization note
collapses to one line · counts on the tab that holds them, red for blockers and
amber for questions · three columns for the candidate drafts · the analysis
starts on SELECTED, bounded to five concurrent runs per project, with a
page-mount fallback for a topic never selected · the trailing data sections fold
into the document · Unread and Assigned-to-me views on the Inbox.

**New.** Blockers — what a topic is MISSING, as a third class beside questions
and approvals, on the existing decision-entry table rather than one of its own.
And decisions now name who made them; the relation already existed and the name
was simply never selected.
