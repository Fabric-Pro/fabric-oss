---
"fabric-app": patch
---

Make the publishing topic's post-type editor read as the multi-select it already is, instead of as a radio group

Review reported the "Edit post types" dialog as single-select and asked for a multi-select. It was already multi-select: `PostTypesDialog` keeps a `Set`, Save submits every checked value, and a test has covered saving two types since the control shipped. Nothing about the behaviour was wrong — only its appearance. Four bare 16px checkboxes stacked in a column with exactly one ticked, no group label, no cue and no count is the canonical shape of a radio group, so it was read as one. Taking the request literally (swap radio for checkbox) would have changed nothing and reported the defect as fixed.

The dialog now says what it does. The description reads "select all that apply"; the options sit in a `fieldset` with a `legend` rather than a bare `div`, so the four share real grouping semantics; each option is a full-width label with a visible selected surface, so two chosen at once are obvious at a glance and the whole row is a click target; and a live `aria-live` count ("2 of 4 selected") states the plural outright — a thing a radio group can never report, and one that reaches screen readers as well as sighted reviewers. The control stays a `Checkbox`, which is what assistive tech had been announcing correctly all along; the shared checkbox primitive is untouched, since nothing about it is app-wide broken.

Three tests in `publishing-suite-list.test.tsx` pin this. Two are genuine red-green: they fail against the previous dialog. The third asserts that picking a second type leaves the first checked — it passed before this change as well, and is here to keep a future restyle from turning the appearance into the reality.
