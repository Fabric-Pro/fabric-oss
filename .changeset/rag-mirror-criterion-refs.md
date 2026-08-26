---
"fabric-app": patch
---

Test cases mirrored for AI retrieval name the acceptance criteria they cover again

The shared context builder accepted only a single criterion reference while every caller on the request path passed the link's plural column, so the criterion was dropped as an excess property and no mirrored case body has named its criteria since the multi-criteria migration — retrieval could no longer answer which cases cover a given criterion. The builder now takes the list, renders every criterion in one "Covers AC 1, AC 3" phrase, and de-duplicates a reference arriving through both shapes.
