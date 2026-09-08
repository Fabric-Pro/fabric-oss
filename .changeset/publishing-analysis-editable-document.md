---
"fabric-app": patch
---

Publishing topics: the Planning & Analysis worksheet is now an editable, versioned document whose edits reach every generator.

Prose sections become Markdown the author owns, stored as append-only revisions with
compare and restore. The structured half (content-type and asset recommendations,
recommended questions, source signals) stays data, because it decides which media tabs a
topic offers and which decision threads exist. One resolver now answers "what is this
topic's analysis" for all seven readers — previously the four generation activities each
ran their own copy of the query. Refs Fizzy #1851.
