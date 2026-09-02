---
"fabric-app": patch
---

Publishing Suite: the Short Post / Tweet tab now drafts three labeled options for a topic, and one can be saved as its working draft

Phase 2B-2 of the Publishing Suite (Fizzy #1853). 2B-1 made the tab say what it
was for; this makes it work. The tab gains an optional guidance box, a Generate
action, the three options the prompt produces, and the control that adopts one
as the topic's working short post. Regenerating replaces the candidates and
leaves a saved draft alone. Blog Post keeps its read-only panel until 2B-3.

Shape. A faithful clone of the Phase 2A Planning & Analysis pipeline, which is
the point: an editable Prompt Library entry in `@repo/utils`, a pure prompt
builder, one activity that commits its own success, a failure marker the
workflow owns because an activity that just failed cannot be trusted to record
it, and a workflow that is a pure degradation boundary. The source-context half
of the prompt is `buildPlanningAnalysisVariables` REUSED rather than
reimplemented, so a truncation cap or a blank-section rule cannot drift between
two prompts reading the same project.

Structured output, not parsed Markdown. The PO's prompt emits a Markdown
skeleton, and FR16 requires EXACTLY three labeled options. Recovering that from
prose is a regex over model output that fails silently and leaves the panel
rendering two options as though that were the contract. As a schema field it is
`z.array(...).length(3)`, checked before anything is persisted, so a short run
fails visibly instead. Labels stay model-produced, which is what FR17 asks.

The `P2002` had to be discriminated, and the discriminator had to be measured.
This table carries TWO unique constraints where the planning table carries one,
so 2A's catch-all "any P2002 means a run is in flight" would report a version
collision as a generation that does not exist and will never report. The first
version of the discriminator was written against a plausible error shape and
matched NOTHING — it returned null for every conflict, so a routine double-click
would have 500'd — and its unit test passed, because the fixture encoded the
same guess. What a real server actually raises: `meta.target` is undefined, and
the constraint name appears only inside
`meta.driverAdapterError.cause.originalMessage`, while `cause.constraint` is an
object holding the column list. Three real-Postgres cases now pin both
constraints by name, and the unit fixture is a copy of a measured error.

Selection takes the option's LABEL, never its text. The server reads the text
out of that draft's own stored content. Accepting a body would make "select a
generated option" a way to write arbitrary text into a project's publishing
pipeline, and the stored draft would stop being evidence of what the model
produced. Editing is a separate operation and belongs in 2B-3, where an editor
makes the edit visible and attributable.

Unresolved approvals generalize rather than block (FR29/FR31). The subjects the
tab lists under "unresolved before drafting" are the same list the prompt
receives as things to write around — one definition in `@repo/utils`, imported
by both, because a tab promising one thing while the generator does another is
invisible to a reader who cannot see the prompt. The approval rules themselves
are locked code-side, where an org editing tone cannot drop them.

Also here: the tenant fence (`FOR UPDATE` project lock, XOR normalisation, the
cross-tenant reclaim rule) is extracted from `publishing-planning.ts` into a
module both writers import. It was going to be copied, and of everything in this
subsystem it is the worst thing to have two of — a fix applied to one copy and
not the other is a tenancy hole that still looks defended wherever anyone reads.

An option's identity is (source draft, label), not the label. Adversarial review
found this one, and it was a real defect: the prompt is asked for DESCRIPTIVE
labels, so "Direct" recurring in the next regeneration with entirely different
text is the common case rather than the exotic one. Comparing on the label alone
marked that new option as already saved AND disabled its button, so it could not
be adopted at all — and the overwrite confirmation, keyed the same way, would
have skipped a replacement that genuinely replaced saved work.
`sourceDraftId` is now returned by the read and both comparisons use it.

Selection is optimistically concurrent. Two people choosing different options
seconds apart both used to succeed, with the second silently erasing the first —
the project lock serialises the writes but says nothing about whether the second
writer knew what it was overwriting. The caller now passes the working draft's
`updatedAt` as it last saw it, the helper re-reads it INSIDE the locked
transaction, and a mismatch is a CONFLICT rather than a lost write.

`updatedAt` rather than the source draft id, which was the first version of that
check. Two states share a null source id — nothing saved, and saved from a
candidate since deleted, because the composite FK is `ON DELETE SET NULL
("sourceDraftId")` — so a source-based check cannot tell them apart. That is
unreachable today, since nothing deletes a candidate. It stops being unreachable
the moment 2B-3 adds a body editor: an edit moves `body` and leaves the source id
alone, so the check would pass while the row HAD changed and a selection would
silently discard the edit. No new column either way — `updatedAt` is
`@updatedAt`, which is exactly the property a revision counter would have added.

Contract change, flagged deliberately: `listTopicDrafts` now returns draft
`content` and the working draft's `body`. Two 2B-1 tests asserted the opposite,
and both said in writing that 2B-2 would add them "when a reader exists". They
are rewritten in the positive direction rather than deleted, so something still
pins each answer.

Not changed, and reviewed rather than assumed: the read is scoped by
`{ topicId, projectId }` with no tenant predicate, which review flagged as
letting a transferred project's new owner see the old owner's drafts. The two
sibling reads are scoped identically and `getLatestPlanningAnalysis` already
returns generated model output through that scope, so this is the semantics of a
project transfer — everything in the project moves with it — rather than
something this slice introduces. What IS owed, family-wide, is the transfer
RE-HOME: child rows keep their old `organizationId`, so under `policy`-mode RLS
they go invisible to the new owner. That is its own change across four tables.
