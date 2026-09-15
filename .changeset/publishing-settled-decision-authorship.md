---
"fabric-app": patch
---

Treat a publishing decision as settled only when a project member answered it, so a question the planning analysis stopped raising keeps restricting drafts generated from then on, including the assets and safety fields Fabric checks, instead of being reported as confirmed.

A regenerated planning analysis soft-closes a question it no longer raises. Drafting used to read that as settled: the question stopped restricting the draft, its own text was handed to the model as the member's answer, and the topic's readiness counted it as answered. It now stays unresolved — the drafting prompts, the generation tab, the Summary & Questions count, the topic assistant, Topic Readiness, and the checks that lower an over-confident customer, metrics or asset claim — and the notes explaining those checks say "unresolved approval thread". Drafting uses only a member's recorded answer as a decision, never an assignment note added after it. An answer or amendment made only of whitespace is now refused. Topic Readiness also stops counting the legacy content-type rows the checklist replaced, which nobody could answer. A draft generated before this change keeps what it stored until it is generated again.
