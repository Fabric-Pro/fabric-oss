---
"fabric-app": patch
---

Glossy editions now move a Proposal's header fields out of the main text, put the document's own title on the cover, drop labelled reference citations, leave out visuals made of placeholder values, embed the cover logo reliably, and give DOCX downloads a sans-serif font with brand-colored headings.

Fizzy #2589 follow-up, still behind the org-scopable `GLOSSY_EDITION` flag. Bumps `GLOSSY_PIPELINE_VERSION`: the next rebuild of an existing edition regenerates its sections and visuals and drops that edition's accept and discard decisions.
