# Architecture Decision Log

The project "Decisions" tab — a searchable, AI-aware record of the architectural choices a team has made (the context, the rationale, the alternatives, and who decided), including decisions detected from meeting transcripts.

- **Audience**: Engineers extending or maintaining the Decisions feature
- **Owner**: Projects / Platform team

## Overview

Each project has a **Decisions** tab that stores Architecture Decision Records (ADRs). A decision captures *what* was decided, the *context/problem*, the *decision drivers*, the *rationale*, the *alternatives considered*, the *consequences*, a *status* (`PROPOSED`, `ACCEPTED`, `DEPRECATED`, `SUPERSEDED`, `REJECTED`), a *domain*, and *participants*. Records are identified per project as `ADR-001`, `ADR-002`, … and are versioned, commentable, and pinnable.

Two things make the log more than a notes table:

1. **Meeting detection** — decisions mentioned in synced meeting transcripts surface as reviewable candidates (preview first, then create or dismiss), with de-duplication against existing records.
2. **AI awareness ("AC5")** — every decision is mirrored into the project's RAG store so the AI assistant takes past decisions into account when it helps the team.

> Naming note: the user-facing "Feature `F-XXX`" maps to the backend `UserStory` model; that is unrelated to ADRs. A Decision's `ADR-NNN` identifier is its own per-project sequence (see `generateArchitectureDecisionIdentifier`).

## Architecture

```
┌── UI (apps/web/modules/saas/projects/components/decisions) ──────────────┐
│  DecisionsList / DecisionsTable · DecisionFormDialog · DecisionDetailSheet │
│  DecisionVersionHistory · DecisionComments · useDecisionsView             │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ oRPC
┌───────────────▼── API (packages/api/modules/projects) ───────────────────┐
│  procedures/architecture-decisions/*  (CRUD, status, versions, comments,  │
│                                        meeting candidates → create)        │
│  procedures/decisions-view.ts         (per-user view persistence)          │
│  lib/architecture-decision-context.ts (AC5: mirror decision → RAG)         │
└───────────────┬───────────────────────────────────────────────────────────┘
                │
┌───────────────▼── Data + RAG ────────────────────────────────────────────┐
│  ArchitectureDecision (+Version, +Comment)   — packages/database          │
│  ProjectContext(type=ARCHITECTURE_DECISION)  — the AI-readable mirror      │
│  ProjectUserPreference.decisionsView         — per-user cards/table        │
│  contextEmbeddingWorkflow → Qdrant           — packages/temporal + rag     │
└───────────────────────────────────────────────────────────────────────────┘
```

## Data model

Defined in `packages/database/prisma/schema.prisma`.

| Model | Purpose |
|-------|---------|
| `ArchitectureDecision` | The record. Holds all decision fields, `identifier` (`ADR-NNN`), `status`, `domain`, `decisionDate`, `participantUserIds[]` / `participantsText`, `pinnedAt`, `supersededById`, `relatedDecisionIds[]`, `currentVersion`, `vouchedAt`/`vouchedById`, and `contextId` (soft pointer to the RAG mirror). |
| `ArchitectureDecisionVersion` | Immutable snapshot per saved edit (`onDelete: Cascade`). Drives the version-history drawer and the side-by-side "compare with current". |
| `ArchitectureDecisionComment` | Threaded discussion (`onDelete: Cascade`). Comments are **not** part of the AI context. |

Two adjacent rows complete the picture:

- **`ProjectContext` with `type = ARCHITECTURE_DECISION`** — the AI-readable mirror of a decision (see AC5 below). The decision's `contextId` is a *soft* pointer (no FK cascade); deleting a decision must also delete its `ProjectContext` and Qdrant vector.
- **`ProjectUserPreference.decisionsView`** — a JSON column keyed by `[projectId, userId]` that stores each user's view choice and ordering.

`sourceKind` / `sourceMetadata` on a decision record where it came from (`manual`, `meeting_decision` with `{ transcriptId, decisionIndex }`), which powers the "From meeting" badge and meeting de-duplication.

## Key flows

### 1. Create / edit a decision

`DecisionFormDialog` → the create/update procedures under `procedures/architecture-decisions/`. New records get their identifier from `generateArchitectureDecisionIdentifier(projectId)` (reads the latest `ADR-NNN` and increments, zero-padded to 3 digits). Every saved edit appends an `ArchitectureDecisionVersion` and bumps `currentVersion`.

### 2. Meeting → decision detection + de-duplication

**How a meeting becomes a candidate (the fetch path).** The Decisions tab itself does **not** poll meetings or call an LLM — it only reads decisions that were already extracted upstream. The full path:

1. **Link + enable (per project, not org-wide).** A maintainer links Teams meetings and turns on sync under **Project → Settings → Meeting Transcript Sync** (`MeetingTranscriptSyncSettings.tsx` → `enableMeetingTranscriptSyncProcedure`). The settings (`meetingTranscriptSyncEnabled`, `meetingTranscriptSyncIntervalMin`) live on the `Project` row.
2. **Sync = polling.** Enabling starts a long-running `meetingTranscriptSyncWorkflow` (`packages/temporal/src/workflows/meeting-transcript-sync.ts`) that loops: pull new transcripts from Microsoft Graph → store each as a `ProjectMeetingTranscript` row (+ summary + RAG embedding) → `await condition(cancelled, intervalMinutes·60s)` → repeat (`continueAsNew` to bound history). The interval is the user's choice in Settings (hourly → daily; **default 360 min / 6 h**). The **"Sync now"** button runs a one-shot pass (`intervalMinutes: 0`, dedup-guarded) via `triggerSyncNowProcedure`.
3. **Extract = one LLM call.** Decisions are pulled out by `extractMeetingInsightsActivity` (`activities/daily-brief/extract-meeting-insights.ts`) — a single `generateObject` call returning `decisions` / `actionItems` / `openQuestions`, written to `ProjectMeetingTranscript.extractedDecisions`. It is version-gated (`insightsVersion` + `insightsExtractedAt`) so it only runs for transcripts not yet extracted at the current schema version. This runs inside **Daily Brief generation** (`generateDailyBriefWorkflow`), so a freshly synced transcript yields no candidates until a brief pass has processed it.

`listMeetingDecisionCandidates({ projectId, organizationId })` in `packages/database/prisma/queries/projects/architecture-decisions.ts` flattens `extractedDecisions` from the project's `ProjectMeetingTranscript` rows and, per candidate, sets:

- `alreadyConverted` — a decision already exists from this `transcriptId:decisionIndex`.
- `dismissed` — the user dismissed this candidate (`dismissedDecisionIndexes`).
- `alreadyExists` + `matchedDecision` — a similar decision already exists (via `isSimilarDecision`).

`isSimilarDecision(a, b)` is a deliberately cheap, embedding-free heuristic: normalize → substring containment **or** token Jaccard ≥ 0.5. The UI strip (`MeetingCandidatesStrip` in `DecisionsList.tsx`) hides converted/dismissed candidates, and a `matchedDecision` candidate is tagged **"May update ADR-NNN"** — the "smart, no-spam" behaviour. Creating from a candidate stamps `sourceKind = "meeting_decision"` so it drops out of the strip on the next read.

**Review before write.** The strip never acts on a candidate directly. It **paginates** — `CANDIDATE_PAGE_SIZE` (10) per page with a numbered pager (Prev · page numbers with ellipsis · Next), so a meeting that yields dozens of decisions is fully reachable. Because creating/dismissing shrinks the list, the current `page` is clamped to the last valid page (`safePage`) for rendering rather than tracked with an effect. Every **Review** button opens `MeetingCandidatePreviewDialog`. Closing that dialog (Cancel / Escape / backdrop) is a deliberate no-op; the user explicitly **accepts** or **rejects**:

- **New decision** (no `matchedDecision`) — the preview shows the proposed statement; **Create decision** calls `meetingDecisions.createFrom`, **Reject suggestion** calls `meetingDecisions.dismiss`.
- **Update** (has `matchedDecision`) — the preview is badged **"Updates ADR-NNN"** and renders a side-by-side of the **current** decision (its real `decision` statement, loaded live via `architectureDecisions.get`) against the **proposed** meeting text, mirroring the version-history comparison. The primary action is **Open ADR-NNN to apply**: `createFrom` always *creates* a new record, so applying a meeting's wording to an existing decision is a deliberate human edit in the detail sheet, not an automatic merge.

### 3. AC5 — making the AI consider decisions

This is the path that lets the assistant reason over past decisions. It is **type-agnostic retrieval over the shared project-context RAG store**, not a decisions-specific search.

1. On create/update, `syncArchitectureDecisionContext` (`packages/api/modules/projects/lib/architecture-decision-context.ts`) upserts a `ProjectContext` of `type = ARCHITECTURE_DECISION`. Its content is built by `buildArchitectureDecisionContextContent`, which renders a status-aware, AI-oriented summary of the decision.
2. It starts `contextEmbeddingWorkflow` (Temporal, task queue `project-documents`), which runs `embedSingleContextActivity` → `embedProjectContext` (`@repo/rag`) → a vector in the project's Qdrant collection (`project-contexts[-org-<id>]`), keyed by `projectId` + tenant.
3. At answer time, `retrieveProjectContexts` → `searchSimilarProjectContexts` embeds the query and returns the most similar project contexts **with no `contextType` filter** — so decisions surface alongside documents, meeting transcripts, etc.

Because retrieval is type-agnostic, **no decisions-specific retrieval code exists or is needed** — wiring a decision into a `ProjectContext` is sufficient for the AI to use it. The embedding step depends on a healthy embedding provider; failures are surfaced and retried by `embedSingleContextActivity` rather than being silently marked complete.

### 4. Per-user view persistence

`useDecisionsView` (frontend) reads/writes `procedures/decisions-view.ts`, which is keyed by `{ projectId, userId: context.user.id }`. The choice between **cards** and **table** (and the manual order) is therefore per-user and never affects teammates. `localStorage` is only a first-paint cache; the DB row is the source of truth.

### 5. Version history & compare

`DecisionVersionHistory` lists `ArchitectureDecisionVersion` snapshots and offers "Compare with current", which renders the selected version beside the live record and marks each changed field. The set of compared fields is `COMPARE_FIELDS` in that component — keep it in sync when adding a decision field (see "Extending").

## File map

| Concern | Location |
|---------|----------|
| UI components | `apps/web/modules/saas/projects/components/decisions/` |
| View hook | `…/decisions/useDecisionsView.ts` |
| Markdown export | `…/decisions/decisionMarkdown.ts` |
| Shared constants (status/domain/markers, date formatting) | `…/decisions/constants.ts` |
| API procedures (CRUD, status, versions, comments, meeting candidates) | `packages/api/modules/projects/procedures/architecture-decisions/` |
| Per-user view procedures | `packages/api/modules/projects/procedures/decisions-view.ts` |
| AC5 RAG mirror | `packages/api/modules/projects/lib/architecture-decision-context.ts` |
| Queries / meeting candidates / identifier | `packages/database/prisma/queries/projects/architecture-decisions.ts` |
| Schema models | `packages/database/prisma/schema.prisma` (`ArchitectureDecision*`) |
| Embedding workflow/activity | `packages/temporal/src/workflows/context-embedding.ts`, `…/activities/context-embedding.ts` |
| Embed + retrieve | `packages/rag/lib/project-contexts/` |

## Extending / common tweaks

- **Add a decision field** — add it to `schema.prisma` (`ArchitectureDecision` **and** `ArchitectureDecisionVersion`), regenerate (`pnpm --filter @repo/database generate`), thread it through the create/update procedures and `DecisionFormDialog`/`DecisionDetailSheet`, add it to `COMPARE_FIELDS` in `DecisionVersionHistory`, and — if the AI should see it — include it in `buildArchitectureDecisionContextContent` so it lands in the RAG mirror.
- **Change what the AI reads** — edit `buildArchitectureDecisionContextContent`. Content changes re-embed on the next save (the workflow re-runs); there is no separate re-index step.
- **Tune meeting de-duplication** — adjust `isSimilarDecision` (threshold / heuristic) in the queries file. Keep it embedding-free: it runs on every candidate list render.
- **Tune the candidate review UX** — `MeetingCandidatesStrip` owns the numbered pager (page size is `CANDIDATE_PAGE_SIZE`; `getCandidatePageList` builds the first/last + windowed page numbers), and `MeetingCandidatePreviewDialog` owns the preview (both in `DecisionsList.tsx`). The dialog branches on `matchedDecision`: no match → create preview; match → the "Updates ADR-NNN" current-vs-proposed comparison. To change what the comparison shows, edit the fields it reads from `architectureDecisions.get`.
- **Change view options** — extend the `decisionsView` JSON shape via `useDecisionsView` + `decisions-view.ts`; it is per-user by construction.
- **Status/domain/markers or date formatting** — `constants.ts` is the single source for these tokens and for the local/UTC date-time formatting used across views and the Markdown export.

## Operational notes

- **Tenant isolation** — every query follows the project XOR pattern (`organizationId` set for org context, `organizationId: null` for personal). The Qdrant mirror is scoped by `projectId` + tenant; org projects use a dedicated collection.
- **Deletion** — because `contextId` is a soft pointer, deleting a decision must also delete its `ProjectContext` row and its Qdrant point; don't rely on a DB cascade for the RAG mirror.
- **Embedding dependency** — "AI considers decisions" only works while the project's embedding provider is healthy. A decision still creates and stores correctly without embeddings; only retrieval is affected until the vector lands.
