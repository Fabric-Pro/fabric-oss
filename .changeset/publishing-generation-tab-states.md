---
"fabric-app": patch
---

Publishing Suite: the topic page's content-generation tabs now show what is recommended, what has been drafted, and what still needs approval

Phase 2B-1 of the Publishing Suite (Fizzy #1853). The generation tab strip on
the Topic Item Page was a disabled "Coming soon" placeholder; it now reads the
topic's Planning & Analysis and its own draft state and says something useful
about each content type. Short Post / Tweet and Blog Post become selectable
tabs with their recommendation rationale, the unresolved approvals that will
constrain a draft, and whether a draft already exists. Case Study and
Stakeholder Email stay disabled until Phase 2C.

Generation itself is NOT in this slice. The button, the guidance box and the
prompts land in 2B-2 (short post) and 2B-3 (blog post). This change exists to
get the persistence and the state model reviewed before an LLM call is attached
to them.

Schema. Two new tables, both XOR-tenanted from the parent topic like
`publishing_topic_planning_analysis`:

- `publishing_topic_draft` — one generation ATTEMPT, versioned per
  (topic, content type), with the same GENERATING/READY/FAILED lifecycle,
  liveness deadline and prompt provenance the planning worksheet uses.
- `publishing_topic_working_draft` — at most one per (topic, content type):
  the Markdown body the user owns, once they select a short-post option or edit
  a blog draft.

Two tables rather than one because FR33/FR35 require regeneration never to
overwrite saved work. Generation only ever writes the candidate table, so that
requirement is a property of where the writes go rather than a rule a later
change has to remember.

Three constraints the schema cannot express, all hand-written in the migration:
a partial unique index making the in-flight guard per CONTENT TYPE (generating a
short post while a blog post generates is legitimate), the tenant XOR CHECK, and
the GENERATING-implies-deadline CHECK without which a dead worker turns that
index into a permanent lock.

A fourth is the composite foreign key proving a working draft cites a candidate
of its OWN topic and content type — with `ON DELETE SET NULL ("sourceDraftId")`.
The column list is load-bearing: a bare `SET NULL` nulls every referencing
column, including the NOT NULL topic and content-type columns, which makes
deleting a candidate FAIL rather than preserving the body. Requires PostgreSQL
15+; dev runs 15, CI 16. Prisma models the column as a plain field because it
cannot express a subset SET NULL, so the constraint is documented on the model —
a shadow-database diff can otherwise read it as drift and try to drop it.

Tab states. A pure resolver maps the analysis's free-string content types onto
the enum through a synonym table (exact match, never substring — "post" appears
in "Blog Post" too) and ranks Generated > Needs confirmation > Recommended >
Available. The caution marker is INDEPENDENT of that ranking: Generated
outranks Needs confirmation, and Phase 2A deliberately mints no question for a
`deferred` content type, so a marker keyed on open questions alone would leave a
generated-but-deferred tab silent about a real approval gap. Every state is
carried in the tab's accessible name as well as a text badge and an icon, so it
never depends on colour (FR5).

Tests. Five real-Postgres constraint cases, four RLS isolation cases in both
directions on both tables (bumping that suite's exact CI count pin from 41 to
45), four `tenant-db` registration cases, plus resolver, query, procedure and
component suites. The 2A case asserting all four generation tabs are disabled is
replaced rather than deleted — the half that still holds for Phase 2C's two
types is kept and asserted.
