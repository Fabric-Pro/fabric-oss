---
"fabric-app": patch
---

Give the Inbox a "Worth a look" section, ranked by the model against its own batch

The card owner asked to "highlight some great fresh cards — like this one is hot", automatically rather than by hand (Fizzy #1851). The hard part was never the highlight; it was finding a signal that stays rare.

**The obvious signal was measured and rejected.** Across 202 staging topics, 68% cite two or more sources, and in a typical week four of five do — so an "is it corroborated" threshold would have marked 80% of the queue. Absolute measures drift upward until everything clears them.

So the model **ranks its own batch instead** and marks at most the strongest two, with a short clause saying what makes that one worth reading before the rest. A relative judgement cannot inflate: something is always the top of five, and nothing is ever "all of them". The cap is enforced server-side where the whole batch is visible, not left to the prompt, and the instruction lives in the locked clauses an org override cannot delete.

**A highlight expires rather than needing to be cleared.** Freshness is computed at read time and lasts fewer days than the aging threshold, so a topic can never be highlighted and going quiet at the same time, and last week's standout stops claiming to be this week's.

On the row, hot **gains exactly what aging loses** — one axis carrying the whole gradient from tinted, to card, to muted, to gone. The reason rides beside it, because a tint with no explanation is the badge people learn to ignore. The section renders only when it has something in it: the other two answer "what should I look at next" and an empty one is itself an answer, while an empty "Worth a look" every quiet week just teaches people to stop believing it.
