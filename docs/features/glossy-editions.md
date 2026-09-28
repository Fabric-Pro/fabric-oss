# Glossy Editions

How a Proposal or Business Case becomes a stakeholder-ready Glossy edition: the build pipeline, its attempt guard, the segment cache, visual slots, and how to roll the feature out.

- **Audience**: Developers extending Glossy editions; operators enabling the feature for an organization
- **Owner**: Documents

## What it is

A Glossy edition is a second, presentation-ready rendering of one Proposal or Business Case. It is stored **beside** the document (`GlossyEdition`, one per document), never as a second `ProjectDocument`, and building it never changes the source document or retrieval. The terms are defined in [CONCEPTS.md](../../CONCEPTS.md#glossy-editions): Glossy edition, Visual slot, Brand kit, Recipient brand.

A build:

1. cleans the source deterministically — internal scaffolding (citations, source indexes, evidence parentheticals, status qualifiers) is relocated to the edition's appendix or softened, never sent to a model as prose to rewrite;
2. rewrites each main-flow section in `brief` (default, never longer than the source) or `standard` (at most 1.25× the source) length, behind a fact guard that keeps the original wording when a rewrite drops, adds or changes a fact;
3. extracts structured visual specs — for every visual slot the author placed, for existing Mermaid diagrams, and for opportunities detected in the text (Roll the dice) or confirmed on the Align-first form;
4. publishes the edition in one transaction.

Visuals are stored as specs and rendered in the browser (Mermaid with a strict security level and plain-text labels, or SVG cards), themed with the preparer's Brand kit and the project's recipient brand at display and download time, not at build time.

## Where the code lives

| Concern | Location |
|---|---|
| Pure libraries (outline, cleanup, cache keys, fact guard, visual specs and templates, visual slots, edition content schema) | `packages/utils/lib/glossy/` |
| Prompts and `GLOSSY_PIPELINE_VERSION` | `packages/agent-prompts/src/glossy/` |
| Model calls | `packages/temporal/src/lib/glossy/` |
| Build workflow and activities | `packages/temporal/src/workflows/glossy-edition-build.ts`, `packages/temporal/src/activities/glossy-edition/` |
| Tables, attempt-guarded queries, RLS | `packages/database/prisma/schema.prisma`, `packages/database/prisma/queries/projects/glossy-editions.ts`, `packages/database/scripts/rls-policy-sql.ts` |
| Procedures (`projects.glossy.*`, `projects.recipientBrand.*`, `organizations.brandKit.*`) | `packages/api/modules/projects/procedures/glossy/`, `…/recipient-brand/`, `packages/api/modules/organizations/procedures/brand-kit/` |
| Page, entry points, renderer | `apps/web/modules/saas/projects/components/glossy/`, `apps/web/modules/saas/projects/lib/glossy/` |

## The build is a claimed attempt

Every build is an attempt row (`GlossyBuild`) that holds the edition's claim (`GlossyEdition.currentBuildId`) while it runs. `claimGlossyBuild` inserts the attempt with its source snapshot and moves the claim in one transaction, so two concurrent builds serialize on the edition row: one is `claimed`, the other reads it as `alreadyBuilding`.

- **Every write is guarded by the attempt.** Heartbeats, cache writes, finalize and fail apply only while their attempt still holds the claim; a superseded run writes nothing and stops. Finalize and fail lock the attempt row before the edition row — the same order a reclaim uses — so a late cache write either commits first or sees the attempt finished.
- **Finalize** swaps the content and `publishedBuildId`, bumps `contentRevision`, stamps the cache rows the build used, prunes stale cache rows and decisions on sections that no longer exist (decisions on appendix-only diagrams are kept), and deletes older finished attempts.
- **A failed rebuild keeps the published edition.** Fail records only a fixed error code on the attempt; readers keep the previous edition, marked "last rebuild failed".
- **A stuck holder is taken over only when it is provably gone**: its heartbeat is older than 20 minutes **and** Temporal reports the run closed or unknown to it (a running or paused run, or a question Temporal does not answer within 5 seconds, keeps the claim). The workflow's 30-minute execution timeout bounds how long a run can hold a claim.
- **A failed workflow start releases the claim** (`WORKFLOW_START_FAILED`), so a retry can claim again.

The workflow (`glossyEditionBuildWorkflow`, queue `glossy-edition`, four activity slots) only orchestrates; every snapshot read, model call and database write is an activity. Workflow inputs and activity results carry ids and keys, never document text.

## Segment cache

`GlossySegmentCache` stores reusable model work per document under content-addressed keys (`packages/utils/lib/glossy/keys.ts`). Every key includes `GLOSSY_PIPELINE_VERSION`, so a prompt or pipeline change re-keys everything without a migration.

| Kind | Keyed by |
|---|---|
| Section identity | heading anchor path, occurrence index, normalized section text (slot lines excluded) |
| `REWRITE` | section key, length mode, key-section class, document type |
| `DETECTION` | ordered section keys, the slot set, document type |
| `EXTRACTION` | section key, kind, slot hint, style direction, and a slot's own id (so two like slots in a section get a visual each) |

Normalization undoes what an editor round trip changes without changing meaning, so an unchanged section of a rebuild reuses its rewrite and visuals without a model call. The Align-first `detect` procedure, the `build` procedure and the build's activities compute keys through one helper (`planGlossyKeys`), and single-visual regenerate writes under the build's own extraction key, so a later rebuild of an unchanged section keeps the regenerated visual. A Roll-the-dice rebuild pins the published edition's detected visuals and detects only over sections that changed or that the edition's detection never covered: the edition records the sections a completed detection covered (`report.detectedSectionKeys`), so a degraded detection is tried again on the next build.

## Visual slots

A visual slot is an author-placed `<visual-slot data-slot-id … data-kind … data-hint …></visual-slot>` line in the document body asking for a visual at that point. It is an atomic editor node, always registered, and it must survive every write that replaces a body. `preserveVisualSlots(previous, next)` lifts the stored slots with their anchors, strips slot tags from the incoming text, and splices the stored slots back under the same headings (orphaning a slot whose section disappeared to the end of the document). With no slot on either side the incoming text is returned byte for byte.

It runs on every AI or external write path:

- document generation (Temporal);
- Update using context (preview and apply) and the auto-refresh apply;
- the in-editor assistant (`applyProgrammaticContent(…, "assistant")`, which takes a streaming run's slots from the run's baseline);
- MCP `fabric_update_document` and the public v1 document `PATCH`.

Embedding strips slots before chunking and hashing, and every regular export (Markdown, PDF, DOCX) strips them.

**Agents and the public API.** Agents and API keys interact with Glossy only through the slot contract above: MCP `fabric_get_document` / `fabric_update_document` and the v1 document `PATCH` keep stored slots in place and ignore slot tags they are sent. Building, detection, review and the brand kits are UI-only in this release — review is a judgment on rendered visuals no agent can make yet. Any later MCP or v1 surface for them must check both the key's scope and its creator's live permission.

## Tenancy and access

All six tables are tenant tables with out-of-band RLS: the five project tables use `project_member_or_tenant_consistent` (members and the owning organization read and write; a row's `organizationId` must be its project's), and `OrganizationBrandKit` uses `org_only_with_project_guest_read` (written by the organization, readable by guests of its projects). That a row's document belongs to its project is enforced in the query layer (`ensureGlossyEditionWith`), because a policy sub-select into `project_document` would deny invited guests.

Procedures resolve `organizationId` from the project row only. Reads use project access; writes (`build`, `detect`, `regenerateVisual`, `reviewVisual`, recipient-brand writes) require `DOCUMENT_UPDATE` plus `canEditProject`, because the RLS policy admits viewers at the database layer. An invited guest editor can build; the rows land in the host organization, and model calls resolve through the BYOK resolver as that editor (a personal key counts), so a guest's builds spend the host organization's provider key when no personal key is set.

## Rollout

The feature is behind one org-scopable flag, `GLOSSY_EDITION` (`FABRIC_FEATURE_GLOSSY_EDITION`, default off). It is the only switch — there is no kill switch, because a build writes only Glossy-owned rows. With it off, the page returns 404, every Glossy and recipient-brand procedure returns NOT_FOUND (the gate runs before the permission check), an in-flight build is left to finish, and existing editions lie dormant.

**Deploy order:**

1. The migration and RLS run in the deployment's pre-upgrade migration job before any pod rolls; nothing reads the new tables while the flag is off.
2. Roll out the web deployment and the Temporal worker together; the worker registers the `glossy-edition` queue.
3. Confirm the `glossy-edition` task queue shows a poller.
4. Only then enable `GLOSSY_EDITION` for an organization through the admin feature-flag organization override (`admin.featureFlags.setForOrg`), not the global environment variable. An organization gated on with no worker listening would claim builds that never start (they are reclaimed after 20 minutes).

Disabling the organization override is the rollback; the migration is additive and unread by any existing path. Turn the flag off for every organization **before** rolling back the worker: a build queued on `glossy-edition` with no poller hangs until its 30-minute execution timeout, and its claim is reclaimed only after the 20-minute stale-heartbeat threshold.
