---
"fabric-app": patch
---

Stop asking the same publishing decision twice

A topic on staging asked "Should we produce a LinkedIn Post for this topic?" and, three cards below it, "Should a LinkedIn Post be produced in addition to the already-suggested Tweet and Blog Post, given LinkedIn's different truncation behaviour?" — one decision, two answers required. The screenshot approval appeared three times the same way (Fizzy #1851).

Two independent producers fill the same question list: the code derives one from each classification bucket, and the model writes its own in `recommendedQuestions`. They merge only when the model happens to reuse the classification's exact `subject` string, and those are two independently written free-text fields, so it usually does not.

**The prompt was asking for it.** A locked clause said "raise a question for every recommendation you classify as needing confirmation or approval — one is raised on your behalf for any you miss, but yours will be better written." It now says the opposite, and says why: a classified recommendation already has a question, so writing a second produces two cards for one decision.

**And the code no longer relies on the model obeying.** `CONTENT_TYPE` and `ASSET_APPROVAL` are fully derivable from the buckets by construction, so once a bucket has produced a question of that kind, a differently-worded model question of the same kind is dropped as a restatement. An exact identity match still lets the model's wording win, which is what it always did and is better prose; and a kind no bucket filled is untouched, so a model question raising something the classification missed still survives.
