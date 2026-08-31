---
"fabric-app": patch
---

Refuse a user whose vector delete was not confirmed, instead of clearing them and orphaning their embeddings

The first phase deletes a user's subscriptions, files and vector points, and refuses the user if any of it fails — so the second phase never takes the rows of someone whose data could not be reached. The vector call was awaited and its result discarded, and neither vector helper throws: both catch their own error and report it in the return value. A vector store that was simply down therefore read as a clean run.

That was observed, not inferred: the store was unreachable, the log said so, and both users cleared anyway. Their rows would have been deleted while their episodes survived.

The episode delete returns a real success flag and is now checked. The execution delete returns a count, which cannot be told apart from "there were none", so it is documented rather than relied on — the two share a store, so the failure that matters shows up in the first.
