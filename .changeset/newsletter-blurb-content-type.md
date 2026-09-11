---
"fabric-app": patch
---

Publishing now supports Newsletter Blurb as a seventh content type, from topic suggestion through draft generation and download

Fizzy #1988, Publishing Suite Phase 2D slice 2D-2. Adds NEWSLETTER_BLURB end to
end: topic suggestion and planning-analysis prompts now name it as a distinct
type (with its own sync migrations for already-deployed prompts), a dedicated
generation activity and prompt compose a one-paragraph blurb whose call-to-action
state is reconciled across all six combinations rather than refined — a
`.refine()` here would fail inside `generateObject` as a retryable error and
reach the operator as a neutral fallback string — the web review panel is wired
into generation, and the confirmed download carries the reader's own edited
draft rather than a fresh recomposition of the structured document.

The new synonym changes what analyses written before the enum existed now
show. The planning prompt has named Newsletter Blurb in its supported-types
list since the Planning & Analysis worksheet first shipped, so stored analyses
already carry entries for it — entries both the tab strip and the content-types
checklist dropped, because neither could map that free-string type onto an enum
value, and both read the same fold. They map now. The checklist lists
Newsletter Blurb under its verdict unconditionally, because its rows come from
the analysis's own buckets rather than from what is selected. The tab and its
rationale panel are gated on the selection instead: a topic with no persisted
selection already shows every type, so both appear immediately, while a topic
whose selection predates this type does not, until someone opens Edit post
types — where Newsletter Blurb already shows badged with its stored bucket and
rationale, read from the same analysis — and checks it. Neither population
needs the analysis regenerated: the recommendation was always in the document,
only unreadable.
