---
"fabric-app": patch
---

Publishing Suite treats a rough summary as raw material rather than a gap, makes it editable, and stops losing unsaved analysis edits

Round six of the Publishing Suite feedback, from staging testing of a
manually-created topic.

**The root cause behind three separate reports.** Every human-authored string
reached the model labelled as finished copy, so a topic pitched as one rough
line produced a `MISSING_DATA` blocker demanding "the real, finalized
announcement text" — the very output the drafting step exists to produce, and
one the reader could not supply anyway because nothing edited a topic's pitch.
Three locked clauses fix it at the source: a blocker may not ask for content
this product writes, a question may not ask for TEXT, and a settled answer is
honoured as the decision it expresses rather than as wording to reuse.

Deliberately says nothing about who wrote the summary. A topic's pitch is model
output whenever `origin` is AI, distilled from documents, transcripts and PR
bodies — framing that as trusted author intent would have widened
indirect-injection exposure on exactly the path carrying untrusted material.

**Unsaved analysis edits were one navigation from gone.** Accepting the
assistant's rewrite re-seeds the editor and saves nothing, which is deliberate
(#1929: an autosave raced an in-flight agent and overwrote the server). But the
guard that makes staging work safe was never built here — no dirty marker, no
`beforeunload`. Both now exist.

**Also:** the summary is editable and marks the analysis stale when changed;
topics get the private notebook Feature Maturation has (and `notes` is verified
never to reach a prompt); Summary & Questions says when an analysis is being
written and when every question is answered; a blocker reply reads as the answer
it is and now counts toward the "regenerate to fold it in" notice — the case
that most needed it, since a blocker answer reaches the draft writers only
through a regenerated analysis.

**Assistant parity with Feature Maturation.** Both surfaces already mount the
same agent, so the missing pieces were props, not capability: the reasoning and
tool trace now render, the agent can ask clarifying questions in the chat, and
`DocumentRefKind` gains a third value so a topic's conversation persists through
the same polymorphic history stack Feature Maturation runs on.
