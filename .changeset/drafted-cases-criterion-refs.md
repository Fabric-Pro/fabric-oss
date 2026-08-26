---
"fabric-app": patch
---

AI-drafted test cases now link to the acceptance criteria they validate

The drafting activity was still writing criterion references onto the retired singular `acceptanceCriterionRef` column, which nothing reads since the multi-criteria migration — every drafted case landed with an empty `acceptanceCriterionRefs` array, so the traceability matrix showed all criteria as Not covered, coverage rings sat at 0%, and the Done coverage gate could never be satisfied by drafting. The write and the re-draft dedupe read now both use the plural column, a compile-time check pins the link input shape so a stray legacy key cannot pass again, and links stranded between the two fixes are backfilled in a data migration.
