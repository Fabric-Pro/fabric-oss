---
"fabric-app": patch
---

Publishing an earlier coding-instructions version from History now works: the button reads "Roll back to this version" and moves the project back to it, instead of refusing with "A newer version is already published".

The refusal came from a race guard that exists to stop an automatic publish-on-ready from silently regressing the pointer; it was never meant to refuse a person who opened History and chose an earlier version deliberately. The automatic path keeps the guard unchanged, and now also applies its publication at most once per version, so a rollback survives a retried publish instead of being quietly undone by one. The audit row for a publish records the version published, the version it replaced, and whether the move was a rollback. A version that published and was then rolled back from is no longer described in the tab as one that "was not published", and the message shown to someone editing while the published version changes no longer claims the replacement was newer.
