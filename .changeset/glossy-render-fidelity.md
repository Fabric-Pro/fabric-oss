---
"fabric-app": patch
---

Glossy edition PDFs no longer garble or cut off lines that contain symbols such as `≥` or `→`, and they embed images compressed. DOCX downloads now break pages without a stray box character, use a sans-serif font in every viewer, and space their paragraphs and headings. Glossy cleanup now keeps quoted evidence anchors out of the text, drops the Business Case self-check section and `(per Reference N)` citations, and visuals no longer draw flows from plain lists or org charts with reporting lines the document does not state.

Fizzy #2589 follow-up, still behind the org-scopable `GLOSSY_EDITION` flag. Bumps `GLOSSY_PIPELINE_VERSION`: the next rebuild of an existing edition regenerates its sections and visuals and drops that edition's accept and discard decisions.
