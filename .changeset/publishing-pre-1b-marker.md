---
"fabric-app": patch
---

Say when a topic is older than the format recommendations, instead of showing an empty picker

Sixteen topics sat near the top of the queue with nothing selected and nothing recommended, and were reported as broken (Fizzy #1851, defect §4). They were not broken — they were created before the suite recommended formats at all: `suggestedPostTypes` began populating on 18 July and `postTypeRecommendations` on the 23rd.

"The analysis considered the formats and recommended none" and "this topic is older than the feature that recommends them" produce an identical empty list and mean opposite things. The creation date is the only signal that separates them, so the content-types list now says which one it is looking at — and only when there is genuinely nothing classified, since a topic carrying buckets is already explaining itself.
