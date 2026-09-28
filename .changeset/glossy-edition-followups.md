---
"fabric-app": patch
---

Glossy editions now remove inline evidence and source clauses, numeric and footnote citations, reference lists and document-control tables from the main text, keep every negated statement negated, keep cached visuals and review decisions when a document's title changes, style visuals neutrally or in the recipient's colors when the preparer has no brand color, and draw swimlanes for flows that name who performs each step.

Fizzy #2589 follow-up, still behind the org-scopable `GLOSSY_EDITION` flag. Bumps `GLOSSY_PIPELINE_VERSION`: the next rebuild of an existing edition regenerates its sections and visuals and drops that edition's accept and discard decisions.
