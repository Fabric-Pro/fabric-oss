---
"fabric-app": patch
---

Fabric AI no longer answers a feature lookup with a bug of the same number, its feature lists match the roadmap, and opened chats keep their history on screen.

Fixes from the staging retest of the unified chat. Feature identifiers resolve by kind (F-/US- to features, B- to bugs, bare numbers prefer features) with the exact identifier winning; list totals exclude declined items and count closed ones separately as hidden, and rows are ordered by identifier number. In the Direct engine, sending a message in a conversation opened from History no longer hides the earlier messages until a reload.
