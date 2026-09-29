---
"fabric-app": patch
---

Deleting an organization now also removes its conversation memory from the vector store, and a partial vector cleanup is reported as a failure instead of being treated as complete.
