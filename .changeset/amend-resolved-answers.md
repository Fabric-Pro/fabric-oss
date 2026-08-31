---
"fabric-app": patch
---

Amend the answer to an already-resolved question from a feature's Decisions tab.

Amending APPENDS a new answer turn that supersedes the previous one rather than editing it, so
the Decision Log stays the append-only changelog its model describes. The superseded answer is
never deleted — it renders collapsed beneath the live one, so you can see what a decision used
to say and when it changed.

The Clean Spec keeps exactly one current answer: the question's entry in the pending-decisions
appendix is upserted rather than appended, because the spec is the only thing the AI reads and a
second entry would hand the next maturation run two contradictory decisions.

Retracted answers are also hidden from every AI surface. `listDecisionLogThreads` gained an
`excludeSuperseded` option, passed at the four call sites that feed a model — the feature-decisions
agent tool, the agent context builder, the maturation enhance run and update-with-context. The
Decisions tab deliberately does not pass it, since showing the history is the point.

An amended AI-sourced answer records AI_EDITED: once a person has rewritten it by hand it is no
longer a straight AI acceptance.
