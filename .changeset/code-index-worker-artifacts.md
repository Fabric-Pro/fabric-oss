---
"fabric-app": patch
---

Repository code indexing now reconstructs and scans the pinned repository inside each processing activity, so changing workers no longer loses the checkout or file manifest during indexing.
