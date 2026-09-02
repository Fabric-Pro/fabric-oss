---
"fabric-app": patch
---

Publishing Suite: the Blog Post tab now drafts one editable post for a topic, and a regeneration cannot overwrite the saved one

Phase 2B-3 of the Publishing Suite (Fizzy #1853), and the slice that finishes
2B. The tab gains an optional guidance box, a Generate action, an editor for the
draft it produces, and a control that adopts a later version over saved work.

The design problem is in the card. DV5 asks a blog generation to produce a
working draft by default; FR35 and DV10 forbid a regeneration from silently
overwriting saved work. Those pull against each other, and the resolution is
seed-if-absent: the FIRST run creates the working draft, every run after it
writes a candidate the reader adopts explicitly.

What makes that a guarantee rather than a promise is where the writes go. 2B-2
could say "`saveWorkingDraft` is the only writer of `body`, and generation never
touches this table", which made FR33 true by construction. This slice needs
generation to write once and an editor to write at all, so that sentence can no
longer carry it. There are now three writers, and the property is restated in
each: adoption and the editor are compare-and-set on `updatedAt`, and the one
generation calls — `seedWorkingDraftIfAbsent` — has NO update path at all. Not a
branch it declines to take: no `upsert`, no `update`, nowhere in its body. A
regeneration that reaches an existing row can only be told it already exists.

That also cashes a cheque 2B-2 wrote. Its concurrency check compares `updatedAt`
rather than `sourceDraftId` specifically because an edit moves the body and
leaves the source id alone — unreachable then, because nothing edited a body.
This is the slice that makes it reachable.

Shape. A faithful clone of 2B-2, which is the point: an editable Prompt Library
entry in `@repo/utils`, a pure prompt builder, one activity that commits its own
success, a failure marker the workflow owns, and a workflow that is a pure
degradation boundary. The source-context half of the prompt and the short post's
own variable builder are REUSED rather than reimplemented, so a truncation cap
cannot drift between two prompts reading the same project. Its own panel rather
than a mode of `ShortPostPanel`, because a component serving both would be a
flag deciding which product it is.

Structured output, not the Markdown blob the PO's v1 prompt describes. The
suggested categories, keywords and inputs-needed sections are advice to the
person publishing, not part of the post; inside one blob they land in the editor
as text the author deletes by hand after every regeneration. As fields the panel
renders them beside the editor and the editable draft contains only the post.

No migration: `PublishingTopicWorkingDraft` already had every column, including
the nullable `sourceOptionLabel` the schema documented as null for a blog. Only
the helper's TypeScript signature had not caught up.

Tests: 23 prompt-builder, 23 API handler, 19 database writer, 7 workflow, 23
panel, plus three real-Postgres cases in the already-allowlisted constraints
suite — the first generation seeding and a second leaving an edit alone, the
working draft's unique index being nameable from the error it raises, and an
edit moving `updatedAt` while leaving `sourceDraftId` still. That last pair is
the 2B-2 lesson applied: a mock is a claim about the world, and the constraint
name this code matches on is measured from the migration and pinned against a
real server rather than guessed from Prisma's naming convention. Both new guards
carry negative controls — inverted individually, each fails exactly its own case
and nothing else.
