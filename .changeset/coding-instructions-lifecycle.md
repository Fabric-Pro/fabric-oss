---
"fabric-app": patch
---

Coding Instructions uploads that never finish are now closed out automatically after six hours, failed uploads no longer accumulate staged files, and an uploaded .fabricignore must match the rules it was previewed with.

Closing the upload dialog part-way through left the snapshot waiting for files forever: the tab kept re-reading it for every viewer, and its partially uploaded files were never cleaned up. An hourly background sweep now marks such an upload as rejected, with "abandoned" as the reason, and removes the files it had received. The same sweep applies the retention limits to projects whose uploads keep failing, which previously only happened after an upload succeeded.

An upload's exclusion rules are read from the .fabricignore in the folder before anything is sent. Nothing checked that the file that then arrived still said the same thing, so an upload could store one set of rules and be described by another. The check now runs during validation and rejects the whole upload when the two disagree.
