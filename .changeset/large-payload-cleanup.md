---
"fabric-app": patch
---

Tidy the Temporal payload-bounding helpers after three-lens review

Fizzy #1997 follow-through: removes a veto pre-check fully subsumed by the in-loop JSON veto, drops null provider elements once at entry instead of casting internally, stops the strip pass from stamping body-less cards with a fake truncated body, and warns when a tool result exceeds the 512 KiB truncation policy but crosses whole. Behavior-preserving except the body-less-card case, which no longer fires spurious re-fetches.
