---
"fabric-app": patch
---

Show the generalization note that belongs to the draft on screen

Every generation panel rendered "how this was generalized" from `latestReady`, while the editor beside it held the working draft. After a regeneration nobody adopted, those are two different documents (Fizzy #1851, defect §2).

An earlier slice added a qualifier — "these notes describe another version" — which covered half of it. The other half it could not reach at all: when v1 was generalized and v2 needs none, `latestReady.safetyNote` is null, so the section **disappears** while the saved text is still the generalized one. There is nothing on screen to qualify, the reader loses the explanation of the document they are holding, and copy and download then export text whose stated generalizations describe a draft nobody adopted.

`listTopicDrafts` now returns the candidate a working draft was adopted from, alongside the id it already carried. It costs a map build and no extra query — the function already reads every row before folding them to two per type. The panels read the safety note off that version when it is available, and the qualifier survives only for the case it can still honestly describe: a source row past retention, where the newest note is all there is.

The export's "another version" caveat is unchanged and still driven by the version relationship, because the metadata above it — approval status, results basis, scaffold state — really is the candidate's. Only the note moved. "Clean" now also requires the note being *exported* to be empty, rather than the newest one.
