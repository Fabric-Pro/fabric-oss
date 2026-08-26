# QA documents

The QA artifacts that live as project documents rather than as test cases.

- **Audience**: engineers working on the Documents tab; support engineers explaining where a test plan should live
- **Owner**: Fabric platform team

Four of Fabric's `ProjectDocumentType` values are QA artifacts:

| Type | Label |
|---|---|
| `QA_STRATEGY` | QA Strategy |
| `TEST_PLAN` | Test Plan |
| `TEST_REPORT` | Test Report |
| `TRACEABILITY_MATRIX` | Traceability Matrix |

They are ordinary project documents — versioned, AI-editable, PM-syncable — and
appear in the Documents tab, the Create Document dialog and the document
pipeline like any other type.

---

## Why these are documents and test cases are not

A test case is a first-class entity with an identifier, steps, state, run history,
plan membership and PM sync. A test *plan document* is prose about how a release
will be tested. Modelling the second as a document and the first as a row keeps
each in the representation that fits it.

There is deliberately **no `TEST_CASES` document type**. Cases already have their
own tab, sync and history; a parallel document representation would be a second
source of truth for the same data.

Note the collision in vocabulary: `TEST_PLAN` here is a **document**, and is not
the same thing as `TestPlan`, the ordered grouping of cases described in
[test cases](./test-cases.md#plans). The document describes the approach; the
entity is the runnable list.

## Where a type has to be registered

A document type is not just an enum value. Adding one without registering it
everywhere ships a type that renders as a blank tile, so all of these carry
entries for the four QA types:

| Surface | Path |
|---|---|
| Enum | `packages/database/prisma/schema.prisma` (`ProjectDocumentType`) |
| Create dialog | `apps/web/modules/saas/projects/components/CreateDocumentDialog.tsx` |
| List labels, descriptions, tiles | `.../components/DocumentsList.tsx` |
| Pipeline order and styling | `.../lib/document-pipeline.ts` |
| Public API union | `packages/api/modules/v1/documents.ts` |

Enum values are added with `ADD VALUE IF NOT EXISTS`, so the migration is additive
and re-runnable.

`PIPELINE_ORDER` in `document-pipeline.ts` sets the order documents render in;
the QA types sort after `QA_STRATEGY` and before `GENERAL`. Unknown types sort
last rather than disappearing.

## AI generation

Document generation runs off a **seeded, user-editable prompt binding** per type.
Only `TEST_PLAN` has one (`test_plan_template`), alongside the pre-existing
`qa_strategy_template`.

`TEST_REPORT` and `TRACEABILITY_MATRIX` have **no bound template**. They are
authorable, versioned documents; they have no type-specific generation prompt.

For the traceability matrix specifically, the [feature QA tab](./feature-qa-tab.md#traceability-matrix)
already exports a computed AC↔case matrix from live data. That export is derived
from real rows; a `TRACEABILITY_MATRIX` document is a hand- or AI-authored
narrative. They are not the same artifact and neither generates the other.
