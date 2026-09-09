---
"fabric-app": patch
---

The daily publishing scan can recommend LinkedIn, and a topic suited to every format no longer fails the whole cycle

Two holes left by adding a fifth content type, both found by review rather than by a test.

`suggestedPostTypes` still carried a literal `.max(4)` against a five-label vocabulary. Its parse failure throws `PUBLISHING_SCHEMA_VALIDATION_FAILED`, which the suggestion workflow lists as non-retryable — so one topic the model recommended all five formats for would have failed the entire day's cycle, for every topic in the batch, with no retry and no partial save. The cap now comes from the tuple, matching the fix already applied to the post-types procedure.

The Topic Suggestion prompt also still listed four types and capped itself at four, so the daily scan could never propose LinkedIn while the Planning & Analysis prompt already recommended it — the two surfaces disagreeing about the same topic. It now carries the five-label set and the platform distinction: a LinkedIn feed hides everything past the first line or two behind "see more" and caps nothing, where X caps hard and hides nothing.

Fixed before release deliberately. This prompt key is new, so its body is INSERTed by the seed on deploy and the seed never rewrites an existing row — correcting the wording after the release would have cost its own sync migration.
