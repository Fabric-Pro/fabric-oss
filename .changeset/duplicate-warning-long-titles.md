---
"fabric-app": patch
---

Long work item titles in the duplicate warning now truncate inside the create dialog instead of running past its edge.

The candidate list sits in a fieldset, whose default min-width is its content width, and in grid rows that also sized to their content, so a long title widened the whole list past the dialog. Both now take `min-w-0`, so the existing `truncate` applies.
