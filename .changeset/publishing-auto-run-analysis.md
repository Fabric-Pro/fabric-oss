---
"fabric-app": patch
---

Start the planning analysis when the tab is opened on a topic that never had one

The Planning & Analysis tab opened on an empty dashed box with a button. Every other tab on the topic page depends on that document — the format panels all read "No planning analysis yet — run one on the Planning & Analysis tab" — so the first thing anyone did on arriving was press Generate (Fizzy #1851). It now runs on open, which is what Feature Maturation does by drafting its spec at creation.

The conditions are deliberately narrow, because this spends an LLM call. It fires only when the topic has **never** been attempted — not merely when there is no ready analysis, since a failed or stranded run has already cost money and whether to retry is a decision for the person looking at the failure. It waits for the query to settle, because before then "no attempt" only means "nothing read yet". And it never fires for a reader, whose request could only produce a 403.

A ref guard makes it fire once rather than once per render: starting a run invalidates the analysis query, and for the moment before the new row lands the component re-renders still believing nothing was attempted. Radix unmounts inactive tab content, so a mount is an open — this cannot fire for someone who never visits the tab.

This is a deviation from the card's DV14/FR15, which require an empty state. That state still exists for a failed run and for a reader; what it no longer does is greet the person who came to use the feature.
