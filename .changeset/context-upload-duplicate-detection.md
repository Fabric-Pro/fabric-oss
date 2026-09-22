---
"fabric-app": patch
---

Project context items now record a content hash for every upload, and the Context tab flags items whose content duplicates another item and can remove the extra copies together.

Every write of a context item's content — pasted text, extracted files and links, integrations, meeting transcripts and the rest — now stores the matching `contentHash`, so duplicates are detected whichever way the content arrived. The contexts list marks each copy with the item it duplicates (a synced file is kept over an upload, otherwise the oldest item), computed when the list is read so it corrects itself when an original is deleted. Existing items are hashed by the `backfill:context-content-hash` script in `@repo/database`.
