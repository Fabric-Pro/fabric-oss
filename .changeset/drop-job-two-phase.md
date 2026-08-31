---
"fabric-app": patch
---

The personal-context drop job runs in two phases, and the inventory agrees with it

The first shape of the job walked users and asked all 192 personal-bearing models about each one. That is 183,000 count queries for a thousand users and nine million for fifty thousand, before a single delete — hours of held connection with no way to resume from the middle.

The per-user shape was only ever needed for the three things that are inherently per-user: cancelling a subscription, deleting objects under one owner's storage prefix, and filtering vector points by user. The relational rows are not among them, and now run as one pass per model rather than per model per person. Deletes go in batches of ids so a large table does not hold locks for the length of its own deletion, and an interrupted run resumes by being run again.

A user refused in the first phase is excluded from the second by id, so a bulk delete cannot take the rows of someone whose subscription could not be cancelled or whose files could not be reached.

The inventory and the job now share one definition of which models can hold personal rows and how each encodes it. They were written apart and immediately disagreed: the job knew two tables encode personal as an empty string and the inventory did not, so the inventory reported those two as uncountable while their rows sat there. The shared definition also stops reporting organization-only models as gaps — eighteen permanent entries on a list whose purpose is to be read as "look here".

Verified against a live database rather than by inspection: the inventory finds an empty-string-encoded row the old one could not, the job refuses when storage is unreachable and deletes nothing, clears and deletes when it is, and a second run finds nothing left.
