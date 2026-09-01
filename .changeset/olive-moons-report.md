---
"fabric-app": patch
---

Backlog analysis now records which context sources its token budget evicted, so context pressure can be measured instead of guessed at (Fizzy #2316)

The analyzer allocates an 80k-token budget greedily in a fixed priority order, so one oversized
section silently evicts every source behind it — a long meeting transcript can push out a
project's Notion content and RAG context without anything visible happening. Until now the only
trace was a warn line per dropped section, which said nothing about how large the ask was or how
often it happens.

Each analysis now emits one structured `backlog.context_budget` line: the budget, the fixed cost,
what each source asked for, what it was granted, and whether it was kept, truncated or dropped.
It logs on both exit paths, not only under pressure — a measurement that fires only when
something goes wrong records the numerator and leaves the denominator unknown, which is how a
rare event gets mistaken for a common one.

This is groundwork, not a behaviour change: allocation is untouched. It exists so the open
question of whether accumulated transcript volume actually degrades analyses can be answered with
evidence before any retention or "compression timer" mechanism is designed.
