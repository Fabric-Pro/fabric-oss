---
"fabric-app": patch
---

Show an unresolved-approval subject to the drafting model as quoted data rather than as one of its own rules

An approval subject ("Acme Corp", "the latency chart") is not text a project
member types. It is model-authored on two paths: a recommended question's
`recommendedQuestions[].subject`, capped at 160 characters by the schema the
model's own output must satisfy, and a derived `ASSET_APPROVAL` question
whose subject is a classified asset's `type`, required by the same schema but
with no maximum length. Both are persisted as an AGENT-authored decision root
when the analysis is reconciled — never as a USER-authored one. No answer
surface lets a member author or edit it afterward, and the revision procedure
edits the analysis document without re-reconciling questions — but a
regenerated analysis does refresh an existing open question's subject when it
reconciles, so the subject stays model-authored for its entire life, not only
at creation. That is not what three separate write-ups of this fix assumed
along the way: this helper's own doc comment, an earlier code-review comment,
and an earlier draft of the design notes behind this change all treated the
subject as project-member free text before being corrected.

The subject still has to be rendered somewhere a member never touches:
inside a generated draft's locked-clause rules, because its entire job is to
name what a rule is about ("do not assert Acme Corp's identity"). That makes
it the one non-authored value that sits where every writer's prompt tells
the model to obey what it reads, rather than in a fenced block the same
prompt tells the model to treat as untrusted source data. An earlier fix
already folds an embedded line break in a subject onto one line before it
reaches that section, so a return key alone can no longer open a fresh line
at column zero among the rules. What was still open: a subject that is
already one line and carries no special character rendered as a bare bullet
with nothing to distinguish it from the rule sitting next to it — a subject
worded like an instruction was, structurally, indistinguishable from one.

This change renders every writer's locked-clause subjects as quoted,
labelled bullets instead of bare ones: the quotation marks the value as a
described fact rather than an instruction, and each block's own governing
sentence — "the following are NOT approved for use", unchanged — sits
beside it as before. It also gives Blog Post, Short Post and LinkedIn Post
the family's full anti-injection rule against treating source material as
instruction, which those three content types did not previously have.

This does not prove a model refuses a quoted imperative. Quoting types a
value; whether a given provider then still complies with text sitting next
to a "do not assert" rule is a question only provider-level adversarial
evaluation can answer, and nothing shipped here measures it. Treat this as
closing a structural gap — a bullet with no visible marker separating data
from instruction — not as a content-safety guarantee.

Separately, and left unfixed here: the project's generation tab computes its
own "unresolved before drafting" subject label independently of the prompt
builders, and the two do not always agree — a whitespace-only subject shows
blank in the tab but falls back to a humanized decision-kind label in the
prompt, a multiline subject stays multiline in the tab, and an "other" kind
question is labelled differently in each. That divergence is a user-visible
UI change with its own render-test surface, offered as separate follow-up
work rather than folded into this prompt-safety change.
