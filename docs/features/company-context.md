# Company Context

How an organization keeps one profile of itself as a vendor, how Proposal and Business Case generation draws on it, who can see it, and how to roll it out.

- **Audience**: Developers extending company context or document generation; operators enabling the feature for an organization
- **Owner**: Documents

## What it is

Company context is the organization's own material about itself: sales assets, case studies, security documents, websites. Admins collect it once, on the **Company context** page in organization settings. Proposal and Business Case generation then retrieves it alongside the project's context, so a draft can say who the vendor is and what it has delivered, not only what the client needs. The terms are defined in [CONCEPTS.md](../../CONCEPTS.md): Company context, Project guest.

It is organization-owned and never part of a project. It does not appear in a project's Context tab, readiness, summary or download, and no other document type retrieves it, so engineering documents are never shaped by marketing material.

Sources arrive in layers. Layer 1 (shipped): file upload, pasted text, and website scan (one or many URLs, crawl scope, scheduled refresh). Layers 2 (Notion, Confluence, Google Docs) and 3 (Slack, Teams) are planned separately.

## Where the code lives

| Concern | Location |
|---|---|
| Tables and queries | `CompanyContextSource`, `CompanyContextUrlPage` in `packages/database/prisma/schema.prisma`; `packages/database/prisma/queries/company-context.ts` |
| API | `organizations.companyContext.*` in `packages/api/modules/organizations/procedures/company-context/` |
| Settings page | `apps/web/app/(saas)/app/(organizations)/[organizationSlug]/settings/company-context/`, components in `apps/web/modules/saas/organizations/components/company-context/` |
| Shared add forms | `apps/web/modules/saas/context-sources/` (also used by the project Context dialog) |
| Ingestion | the project context workflows, run with a company owner: `packages/temporal/src/lib/context-owner.ts`, `packages/temporal/src/lib/context-row-store.ts` |
| Vectors | `packages/rag/lib/company-contexts/` (store, search, embedding model identity) |
| Retrieval | `packages/temporal/src/lib/company-context-retrieval.ts`, called from `retrieveProjectContexts` |
| Empty-context notice | `apps/web/modules/saas/projects/components/CompanyContextNotice.tsx` |

## Tenancy and access

Both tables carry a NOT NULL `organizationId` and use plain `org_only` RLS, with no project-guest read branch. A URL page's composite foreign key over `(parentSourceId, organizationId)` keeps a page and its source in one organization. Vectors live in their own collection per organization, `company-contexts-org-{orgId}`, which no project search opens.

- **Read** (list, get, URL pages, single-file download): `requireInputOrgPermission(ORG_READ)` → organization membership → the gate. Every member can read.
- **Write** (add, edit type label and AI instructions, delete, resync, cancel, re-process): `ORG_UPDATE` → admin or owner → the gate. `CONTEXT_*` permissions are never used, because the member role already holds them.
- **Project guests** (project members without membership in the project's organization) never see the page, never retrieve company context and never see the notice. The organization is always read from the project row, never from the session, because a guest's session carries their own organization.

A document an organization member generated from company context is an ordinary project document; guests who can read the project's documents read it.

## Retrieval

Company retrieval runs inside the existing `retrieveProjectContexts` activity, for PROPOSAL and BUSINESS_CASE only, so every generation path (create, regenerate, batch, project setup, import-as-document) gets it without a workflow change. For each run it:

1. reads the organization from the project row, checks the `COMPANY_CONTEXT` gate and the author's membership;
2. builds a query from the document type's intent plus the project's name, description and goals, and embeds it with the organization's embedding model;
3. searches the company collection, filtered to the organization, the current model identity and the sources that are ready;
4. drops the hit of a crawled page whose page row is gone or no longer holds the current model's vectors, checked in one query scoped to the organization and its ready sources;
5. keeps at most 4 sources (3 chunks each) and appends them after the project entries, on every exit that returns, including when the project has no context of its own.

Each vendor entry starts with a fixed marker (`@repo/agent-types`), then the source label and the source's AI instructions (`[Source guidance: …]`), and passes through the same neutralization as project context. Project entries have any copy of the marker defused, so project text cannot pose as vendor material. Every place that decides whether "RAG context exists" counts only project entries, so wizard features stay in the prompt when a project has only vendor material. With vendor entries present, the default Proposal template permits one `Vendor Qualifications & Relevant Experience` section; without them the prompt is unchanged. A failure on the company side is logged and the project results return as before.

Auto-Refresh, "Update using context" and the document editor chat keep project-only retrieval.

## Embedding model identity

Every company vector and source row records the identity of the model that produced it (`provider:model`). Search filters on the current identity, so vectors from an earlier model never mix into results; a source embedded with another model shows as **needs re-processing** until an admin re-processes it. The identity is resolved at the organization level only (`organizationOnly` resolution): the organization's embedding provider, else its default provider, else the deployment gateway, never a member's personal key. An organization with none of these cannot index company context until it configures a provider.

Every Qdrant collection has a fixed vector size (1536), the project ones included. A model with another dimension is refused: the source fails with an "unsupported embedding model" reason and retrieval skips company search.

## Ingestion

Company sources reuse the project context workflows (file processing, embedding, deletion, URL crawl) with a company owner in the workflow input. Activities pick the company row store and skip project-only side effects (Job Hub rows, notifications, import-as-document). Project-owner runs schedule exactly the same activity commands as before; replay against recorded project histories confirms it.

Company workflows and their crawl schedules run on the `company-context` task queue, which only workers carrying this change poll. A scheduled company crawl first checks the gate and exits without calling the crawler when it is off.

A website crawl prunes the pages the site no longer returns: their vectors first, then their rows. Every prune then sweeps the source's page vectors against the page rows left and deletes any whose row is gone. The sweep reads what it owes from the rows rather than from a list, so a sweep that fails is repeated by the next crawl's prune; the crawl itself never fails on it.

Deleting a source refuses a website that is still crawling. Otherwise it first tombstones the source: one conditional write sets `deletingAt` beside a "being deleted" status. A tombstoned source is never ready, so it leaves retrieval and the notice's ready count at once. Nothing new starts on it: re-processing, re-sync, file processing and crawls (scheduled ones included) cannot claim it. Each of them claims the source in one conditional write that refuses a tombstoned source, and starts its workflow only after the claim is won, so a delete that lands between a request's read and its claim wins and the request answers CONFLICT. A request whose workflow then fails to start puts the status back, or marks it failed, only while the source is not tombstoned: the delete's status stays. A run already going finds its late writes refused (marking it embedded or COMPLETED, finalizing its crawl) and removes the vectors it wrote. The deletion then runs as a workflow whose id is deterministic per source (`company-context-deletion-{sourceId}`). It deletes the crawl schedule, removes the vectors, the stored file and the row, then sweeps the vectors once more for any point an in-flight embed wrote late. Of two deletes racing for one source, only one tombstones it, but both start the same deterministic workflow before answering success, so a delete never reports success on the tombstone alone. A start that fails keeps the tombstone and asks for the delete to be repeated: the start may have reached Temporal before timing out, so the deletion may already be under way, and putting the source back in use would lose data mid-flight. A tombstoned source stays listed, marked `deleting`, until the workflow removes it. Deleting it again restarts the workflow, and a run still going answers "already started", which also counts as success.

Organization deletion drops the company collection, sweeps `{orgId}/company-context/` in storage, and deletes company crawl schedules only after the guarded organization delete succeeds.

## Rollout

The feature is behind one org-scopable flag, `COMPANY_CONTEXT` (`FABRIC_FEATURE_COMPANY_CONTEXT`, default off). With it off, the settings page returns 404, every company procedure returns NOT_FOUND, the notice is hidden, retrieval adds nothing, and scheduled company crawls exit early; data is kept.

**Deploy order:**

1. The migration and RLS run before any pod rolls; nothing reads the new tables while the flag is off.
2. Roll out the web deployment and the Temporal worker, and wait until the rollout has **fully completed**: a poller shows on the `company-context` queue, and no pre-change worker still polls `project-documents`.
3. Only then enable `COMPANY_CONTEXT` for an organization through the admin organization override (`admin.featureFlags.setForOrg`), not the global environment variable, so the web tier and the worker read the same value.

A Proposal generated on a pre-change worker during a mixed rollout simply lacks the vendor block; that worker knows nothing of company context, so nothing leaks. Rollback: turn the flag off first, then roll back the worker; queued company jobs wait on their queue and drain once a current worker returns.
