# Proof Editor + Project Documents Integration Plan

> If implementing this plan task-by-task, use subagent-driven development.

Goal: Add Proof-backed human+agent collaboration for ProjectDocument workflows without replacing TipTap, while preserving Fabric multi-tenancy, authorization, durability, and rollback safety.

Architecture: Keep `ProjectDocument` in Fabric’s database as the system of record. Keep TipTap as the in-app editor and AI iteration surface. Add a narrow, server-side Proof integration layer plus a tenant-scoped link table so Fabric can push document updates to Proof, allow humans/agents to collaborate there, and explicitly import finalized content back into the database.

Tech Stack: Next.js 16, React 19, TypeScript 5.9, oRPC, Prisma 6, PostgreSQL, Temporal, TipTap, existing project collaboration/realtime stack, hosted Proof agent bridge APIs.

---

## 1. Scope and non-goals

### In scope
- Link a `ProjectDocument` to a hosted Proof document.
- Automatically push Fabric document updates to Proof when a link is active.
- Let agents and humans collaborate inside Proof.
- Import finalized Proof content back into `ProjectDocument`.
- Preserve tenant isolation for personal and organization contexts.
- Preserve existing TipTap editor generation, streaming, and diff-highlighting flows.
- Keep all Proof credentials and bridge operations server-side.

### Explicit non-goals for v1
- No replacement of TipTap with Proof inside the app.
- No client-side direct Proof bridge access.
- No live bidirectional sync on every remote keystroke.
- No attempt to mirror Proof comments/suggestions into TipTap UI yet.
- No Proof-first system of record.
- No schema-wide rework of existing collaboration/editor models.

---

## 2. Existing repo anchors this plan builds on

This plan intentionally extends existing patterns instead of inventing a parallel architecture.

### Existing database anchors
- `packages/database/prisma/schema.prisma`
  - `Project`
  - `ProjectDocument`
  - `DocumentVersion`
  - `DocumentLock`

### Existing query anchors
- `packages/database/prisma/queries/projects/documents.ts`
  - `createDocument`
  - `getDocumentById`
  - `listDocuments`
  - `updateDocument`
  - `restoreDocumentVersion`
- `packages/database/prisma/queries/projects/document-locks.ts`

### Existing API anchors
- `packages/api/modules/projects/procedures/create-document.ts`
- `packages/api/modules/projects/procedures/get-document.ts`
- `packages/api/modules/projects/procedures/list-documents.ts`
- `packages/api/modules/projects/procedures/update-document.ts`
- `packages/api/modules/projects/router.ts`

### Existing frontend anchors
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
- `apps/web/modules/saas/agents/components/DocumentGeneratorEditor.tsx`
- `docs/DOCUMENT_EDITOR_STREAMING_PATTERN.md`

### Existing multi-tenant/security anchors
- `packages/api/orpc/procedures.ts`
- `packages/database/src/tenant-db.ts`
- `packages/database/prisma/queries/projects/projects.ts`
- `docs/adr/003-xor-tenant-isolation.md`

### Existing workflow/realtime anchors
- `packages/api/lib/realtime.ts`
- `packages/temporal/...` existing durable workflow patterns

---

## 3. Core design decisions

### Decision 1: Fabric DB remains canonical
`ProjectDocument.content` remains the source of truth for:
- TipTap rendering
- version history
- RAG embedding
- downstream project workflows
- export/download
- in-app reads after refresh

Proof is a collaboration workspace, not canonical storage.

### Decision 2: Introduce a separate Proof link record
Do not overload `ProjectDocument` with Proof integration fields beyond maybe a future cached status field.

Reasoning:
- safer rollback
- tightly scoped blast radius
- easy feature flagging
- easier tenant auditing
- easier deletion/disconnect semantics

### Decision 3: Sync is asymmetric in v1
- Fabric -> Proof: automatic, async, durable
- Proof -> Fabric: explicit import/finalize only

Reasoning:
- avoids silent overwrites
- avoids sync loops
- keeps DB authoritative
- lets humans control when remote collaboration becomes official

### Decision 4: Server-only Proof integration
All Proof operations happen through Fabric server code. The client never receives bridge credentials.

### Decision 5: Use existing tenant + project authorization model
All new procedures must use:
- `tenantProtectedProcedure`
- `resolveOrganizationId(...)`
- `hasProjectAccess(...)` for read/status
- `canEditProject(...)` for mutating operations

---

## 4. Target user workflow

### Normal authoring flow
1. User/agent creates or updates a `ProjectDocument` in Fabric.
2. Fabric saves content in DB as usual.
3. If the document has an active Proof link, Fabric queues an async push to Proof.
4. Human reviewers and agents collaborate in Proof.
5. When collaboration is complete, a Fabric user explicitly imports/finalizes the latest Proof draft.
6. Fabric updates `ProjectDocument`, creates a new `DocumentVersion`, emits realtime events, and TipTap shows latest content on refresh.

### Collaboration rule of thumb
- TipTap = in-app authoring and AI iteration surface
- Proof = shared collaboration surface for humans + agents
- DB = source of truth

---

## 5. Proposed schema additions

## 5.1 New enum: `ProofSyncStatus`

Add to `packages/database/prisma/schema.prisma`:

```prisma
enum ProofSyncStatus {
  NOT_LINKED
  ACTIVE
  PUSH_PENDING
  OUT_OF_SYNC
  IMPORT_PENDING
  CONFLICT
  FAILED
  CLOSED
}
```

Optional future enum if you want explicit mode separation:

```prisma
enum ProofImportPolicy {
  MANUAL
  // Reserved for future modes only
}
```

## 5.2 New model: `ProjectDocumentProofLink`

Add to `packages/database/prisma/schema.prisma`:

```prisma
model ProjectDocumentProofLink {
  id                    String          @id @default(cuid())
  projectDocumentId     String          @unique
  projectId             String

  // Proof identifiers
  proofDocumentId       String?
  proofDocumentSlug     String?
  proofDocumentUrl      String

  // Sensitive: server-side only, encrypted before persistence
  encryptedBridgeToken  String

  // Sync tracking
  syncStatus            ProofSyncStatus @default(ACTIVE)
  lastPushedFabricVersion Int?
  lastPushedContentHash String?
  lastImportedAt        DateTime?
  lastImportedProofRevision String?
  lastProofActivityAt   DateTime?
  lastSyncError         String?

  // Audit
  createdByUserId       String
  createdAt             DateTime        @default(now())
  updatedAt             DateTime        @updatedAt

  // Tenant isolation
  userId                String?
  organizationId        String?

  // Relations
  document              ProjectDocument @relation(fields: [projectDocumentId], references: [id], onDelete: Cascade)
  project               Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user                  User?           @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization          Organization?   @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([projectId])
  @@index([userId])
  @@index([organizationId])
  @@index([syncStatus])
  @@map("project_document_proof_link")
}
```

## 5.3 Add relation on `ProjectDocument`

In `ProjectDocument`:

```prisma
proofLink ProjectDocumentProofLink?
```

## 5.4 Add to tenant-db categories

Modify `packages/database/src/tenant-db.ts` and include:
- `ProjectDocumentProofLink`

Category recommendation:
- user-owned / project-owned tenant table, same class as `ProjectDocument`

## 5.5 RLS update

Update `packages/database/scripts/apply-rls-direct.ts` so `project_document_proof_link` follows the same tenant/XOR isolation rules as `project_document`.

### Required invariants
- Personal context row must be stored with `organizationId = null`
- Org context row must be stored with `organizationId = <orgId>`
- Never query via OR between `userId` and `organizationId`

---

## 6. Suggested database query additions

Create `packages/database/prisma/queries/projects/document-proof-links.ts`

Add the following exported functions:

### Read/query helpers
- `getDocumentProofLinkByDocumentId(documentId: string)`
- `getDocumentProofLinkById(id: string)`
- `listProjectDocumentProofLinks(projectId: string)`

### Mutation helpers
- `createDocumentProofLink(data: {...})`
- `updateDocumentProofLink(linkId: string, data: {...})`
- `updateDocumentProofLinkStatus(linkId: string, status: ProofSyncStatus, error?: string)`
- `recordProofPushResult(linkId: string, data: { fabricVersion: number; contentHash: string; proofRevision?: string })`
- `recordProofImportResult(linkId: string, data: { importedAt: Date; proofRevision?: string })`
- `deleteDocumentProofLink(linkId: string)`

### Conflict helpers
- `markDocumentProofLinkConflict(linkId: string, reason: string)`
- `markDocumentProofLinkOutOfSync(linkId: string, reason?: string)`

### Notes
- All create/update functions must accept `userId` and `organizationId` where needed.
- These helpers should mirror the style and tenant comments used in `projects/documents.ts`.

---

## 7. Proof adapter design

Create a narrow integration module:

Preferred location:
- `packages/api/modules/projects/lib/proof-adapter.ts`

Or if the integration becomes shared later:
- `packages/integrations/proof/...`

## 7.1 Adapter API surface

Implement functions like:
- `createProofDocument({ title, markdown })`
- `getProofDocumentState({ proofDocumentId|slug, token })`
- `pushProofDocumentMarkdown({ proofDocumentId|slug, token, markdown, title? })`
- `getProofDocumentSnapshot(...)` (optional if needed)
- `reportProofBug({ summary, context, evidence })`

## 7.2 Adapter responsibilities
- Encapsulate all HTTP calls to hosted Proof APIs
- Normalize request/response errors
- Extract request IDs from headers when available
- Redact credentials from logs
- Return stable typed results to app code

## 7.3 Adapter constraints
- No direct client/browser usage
- No persistence inside adapter
- No tenant logic in adapter itself; caller handles tenant/auth

## 7.4 Secret handling
Add a utility in the same module or shared server lib:
- `encryptProofToken(raw: string): string`
- `decryptProofToken(ciphertext: string): string`

If you already have an app-secret encryption helper, reuse that instead of inventing a new one.

---

## 8. API procedures to add

All procedures below belong under the existing router namespace:
- `projects.documents.proof.*`

Create a new directory:
- `packages/api/modules/projects/procedures/documents/proof/`

## 8.1 `link-document.ts`

Route intent:
- Create a Proof document for an existing `ProjectDocument`
- Create a tenant-scoped link record

Recommended route:
- `POST /projects/:projectId/documents/:id/proof/link`

Input:
```ts
z.object({
  projectId: z.string(),
  id: z.string(),
  organizationId: z.string().nullable().optional(),
})
```

Authorization:
- `canEditProject(projectId, context.user.id)`

Handler steps:
1. Resolve org with `resolveOrganizationId`
2. Verify editor access
3. Load `ProjectDocument`
4. Reject if link already exists and is active
5. Call Proof create doc with current title/content
6. Encrypt returned token
7. Create `ProjectDocumentProofLink`
8. Return sanitized link metadata only

Response shape:
- link id
- proof document url
- sync status
- timestamps
- no secret fields

## 8.2 `get-status.ts`

Route intent:
- Return link status and sync metadata for UI

Recommended route:
- `GET /projects/:projectId/documents/:id/proof/status`

Authorization:
- `hasProjectAccess`

Response shape:
```ts
{
  linked: boolean,
  syncStatus?: "ACTIVE" | ...,
  proofDocumentUrl?: string,
  lastPushedFabricVersion?: number,
  lastImportedAt?: string,
  lastSyncError?: string | null,
  hasImportAvailable?: boolean,
  hasConflict?: boolean,
}
```

## 8.3 `push.ts`

Route intent:
- Manual retry push of current Fabric content to Proof

Recommended route:
- `POST /projects/:projectId/documents/:id/proof/push`

Authorization:
- `canEditProject`

Handler steps:
1. Resolve tenant
2. Verify edit permission
3. Load document and link
4. Start durable push workflow
5. Return queued/started state

## 8.4 `import-latest.ts`

Route intent:
- Import latest Proof content into `ProjectDocument`

Recommended route:
- `POST /projects/:projectId/documents/:id/proof/import`

Authorization:
- `canEditProject`

Handler steps:
1. Resolve tenant
2. Verify edit permission
3. Load document + link
4. Fetch latest Proof state
5. Detect conflict state
6. If safe, call `updateDocument(...)` with:
   - `content`
   - `changeDescription: "Imported final collaborative draft from Proof"`
   - `lastEditedBy: context.user.id`
   - `userId`
   - `organizationId`
7. Record import metadata on link
8. Emit `document_change` + `activity`
9. Return updated document

## 8.5 `finalize.ts`

Route intent:
- Convenience procedure: import latest Proof content and mark the collaboration session closed

Recommended route:
- `POST /projects/:projectId/documents/:id/proof/finalize`

Authorization:
- `canEditProject`

Semantics:
- imports latest content
- sets `syncStatus = CLOSED`
- optional future behavior: disconnect auto-push

## 8.6 `disconnect.ts`

Route intent:
- Close/unlink Proof collaboration without deleting Fabric doc

Recommended route:
- `POST /projects/:projectId/documents/:id/proof/disconnect`

Authorization:
- `canEditProject`

Recommended semantics for v1:
- do not delete remote Proof doc automatically
- set `syncStatus = CLOSED`
- preserve audit history and metadata

Optional future route:
- hard delete link record only for admin/cleanup flows

## 8.7 `refresh-status.ts` (optional but helpful)

Route intent:
- Reconcile Fabric link status with remote Proof state and set `IMPORT_PENDING` if remote changed

Recommended route:
- `POST /projects/:projectId/documents/:id/proof/refresh-status`

Useful for:
- UI “Check for changes” button
- support/debug workflows

---

## 9. Router changes

Modify `packages/api/modules/projects/router.ts`

Add imports for the new proof procedures and wire them under:

```ts
documents: {
  ...,
  proof: {
    link: linkDocumentToProofProcedure,
    status: getDocumentProofStatusProcedure,
    push: pushDocumentToProofProcedure,
    importLatest: importLatestProofDocumentProcedure,
    finalize: finalizeProofDocumentProcedure,
    disconnect: disconnectProofDocumentProcedure,
    refreshStatus: refreshDocumentProofStatusProcedure,
  },
}
```

---

## 10. Update existing document procedures

## 10.1 Update `update-document.ts`

File:
- `packages/api/modules/projects/procedures/update-document.ts`

Required change:
- After `updateDocument(...)` succeeds, if an active Proof link exists, enqueue a durable push workflow.
- Do not block the HTTP response on Proof success.
- On enqueue failure, log and mark status as `OUT_OF_SYNC` or `FAILED`, but do not fail the normal save.

Pseudo-flow:
1. update DB document
2. emit existing realtime events
3. if proof link exists and `syncStatus` not `CLOSED`
   - start `proofDocumentSyncWorkflow`
4. return `{ document }`

## 10.2 Update generation flows

Files to inspect/update:
- `packages/api/modules/projects/procedures/documents/generate-document.ts`
- any related Temporal completion path that writes generated content to `ProjectDocument`
- any project document generator path that directly updates project docs

Required change:
- When generation finishes and content is stored, enqueue the same push workflow if an active Proof link exists.

Important requirement from user:
- “Any changes made to the document in project document generator should automatically be pushed to proof.”

That means the trigger must be attached to the shared DB update/save path or to every generation completion path touching `ProjectDocument`.

## 10.3 Consider adding a reusable helper

Create:
- `packages/api/modules/projects/lib/proof-sync-trigger.ts`

Responsibilities:
- given `documentId`, `projectId`, `userId`, `organizationId`
- load proof link
- decide whether to enqueue sync
- start workflow
- centralize logging and status transitions

This avoids duplicating enqueue logic in create/update/generate/import paths.

---

## 11. Temporal workflow design

Preferred because this integration must be durable and non-blocking.

## 11.1 Add `proofDocumentSyncWorkflow`

Suggested file path:
- `packages/temporal/src/workflows/projects/proof-document-sync.ts`

Input:
```ts
{
  documentId: string;
  projectId: string;
  userId: string;
  organizationId?: string;
  reason: "document_update" | "generation_complete" | "manual_push";
}
```

Workflow steps:
1. Load `ProjectDocument`
2. Load `ProjectDocumentProofLink`
3. Exit if link missing or `syncStatus = CLOSED`
4. Compute current content hash
5. If hash/version already pushed, no-op
6. Decrypt token
7. Push markdown/title to Proof
8. Record push result
9. Set status to `ACTIVE`
10. On retryable error, retry
11. On terminal failure, set status `FAILED`

## 11.2 Add `proofDocumentImportWorkflow` (optional)

You can implement import synchronously first if small, but a workflow is cleaner if you want retries and auditing.

Suggested path:
- `packages/temporal/src/workflows/projects/proof-document-import.ts`

Input:
```ts
{
  documentId: string;
  projectId: string;
  userId: string;
  organizationId?: string;
  mode: "import_latest" | "finalize";
}
```

Workflow steps:
1. Load document + proof link
2. Fetch Proof state
3. Detect conflict
4. If conflict, mark `CONFLICT` and stop
5. Update `ProjectDocument`
6. Record import metadata
7. Emit activity/realtime events
8. If finalize mode, set `CLOSED`

## 11.3 Activities needed

Suggested activity files:
- `packages/temporal/src/activities/projects/proof.ts`

Activities:
- `loadDocumentForProofSync`
- `loadProofLink`
- `pushDocumentToProof`
- `fetchProofDocumentState`
- `recordProofPushSuccess`
- `recordProofImportSuccess`
- `markProofLinkStatus`
- `importProofContentIntoFabricDocument`

## 11.4 Critical tenant rule for workflows

Every workflow args object must include `organizationId` when applicable.

Never start the workflow with only `userId` + `documentId`.

Correct:
```ts
args: [{
  documentId,
  projectId,
  userId: context.user.id,
  organizationId: organizationId ?? undefined,
  reason: "document_update",
}]
```

---

## 12. Recommended sync state machine

## 12.1 State enum meanings

- `NOT_LINKED`
  - no Proof collaboration exists
- `ACTIVE`
  - link exists, last known sync healthy
- `PUSH_PENDING`
  - local Fabric change queued for Proof push
- `OUT_OF_SYNC`
  - local/remote may differ, retry needed
- `IMPORT_PENDING`
  - remote Proof content changed and can be imported
- `CONFLICT`
  - both Fabric and Proof changed since last shared sync point
- `FAILED`
  - last sync/import attempt failed terminally
- `CLOSED`
  - collaboration session closed/disconnected

## 12.2 State transitions

### Link created
`NOT_LINKED -> ACTIVE`

Condition:
- Proof doc created successfully
- link persisted successfully

### Fabric document changed
`ACTIVE -> PUSH_PENDING`

Condition:
- `ProjectDocument` content/title updated
- active link exists

### Push succeeds
`PUSH_PENDING -> ACTIVE`

Condition:
- Proof push completed
- `lastPushedFabricVersion` and `lastPushedContentHash` recorded

### Push enqueue or push execution fails
`PUSH_PENDING -> OUT_OF_SYNC` or `FAILED`

Rule:
- transient/operational issue => `OUT_OF_SYNC`
- repeated terminal issue => `FAILED`

### Proof changed remotely and Fabric unchanged
`ACTIVE -> IMPORT_PENDING`

Condition:
- remote Proof revision newer than last imported/pushed checkpoint
- Fabric version/hash unchanged since last shared point

### Import succeeds
`IMPORT_PENDING -> ACTIVE`

Condition:
- imported into DB
- version history updated
- link metadata updated

### Both sides changed
`ACTIVE|IMPORT_PENDING|OUT_OF_SYNC -> CONFLICT`

Condition:
- Fabric changed since last push/import checkpoint
- Proof changed since last shared checkpoint

### Conflict resolved manually by user choosing import or overwrite
`CONFLICT -> ACTIVE`

### User disconnects/finalizes
`ACTIVE|IMPORT_PENDING|OUT_OF_SYNC|FAILED|CONFLICT -> CLOSED`

## 12.3 Conflict policy for v1

If both changed since the last sync point:
- do not auto-import
- do not auto-overwrite Proof
- set `CONFLICT`
- require explicit user action

That is the safest policy.

---

## 13. Conflict detection algorithm

Use a small checkpoint model; do not overengineer.

Track in link record:
- `lastPushedFabricVersion`
- `lastPushedContentHash`
- `lastImportedAt`
- `lastImportedProofRevision`

At refresh/import time compute:
- current Fabric `document.version`
- current Fabric `contentHash` (or on-demand hash)
- current Proof revision/hash from state

### Safe cases

#### Case A: Fabric changed, Proof unchanged
Action:
- auto-push Fabric -> Proof

#### Case B: Proof changed, Fabric unchanged
Action:
- set `IMPORT_PENDING`
- allow import

#### Case C: Neither changed
Action:
- remain `ACTIVE`

### Conflict case
#### Case D: Fabric changed and Proof changed
Action:
- set `CONFLICT`
- require explicit resolution

---

## 14. Frontend implementation plan

## 14.1 Add Proof status query hooks

Likely touchpoints:
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
- project pipeline/document list/detail surfaces

Add a query for:
- `orpc.projects.documents.proof.status`

Display status near document title/editor toolbar.

## 14.2 Add actions in document UI

Recommended UI actions:
- Link to Proof
- Open in Proof
- Retry push to Proof
- Check Proof status
- Import latest from Proof
- Finalize collaboration
- Disconnect Proof

### Suggested placement
Primary:
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`

Optional secondary placement:
- project pipeline or document list row menu

## 14.3 Add a lightweight status banner

Banner text examples:
- “This document is linked to Proof. Fabric edits sync to Proof automatically.”
- “Proof has newer content available to import.”
- “Fabric and Proof both changed. Resolve conflict before importing.”

## 14.4 Do not replace current editor flow

Keep:
- current TipTap rendering
- current diff streaming pattern
- current save/update behavior
- current collaboration mode fallback behavior

Just layer Proof status and actions around it.

## 14.5 Cache invalidation after import/finalize

After successful import/finalize:
- invalidate `projects.documents.get`
- invalidate `projects.documents.list`
- invalidate `projects.documents.proof.status`

TipTap then naturally reflects DB state on refresh/reload.

---

## 15. Realtime/events plan

Use existing realtime infrastructure in:
- `packages/api/lib/realtime.ts`

On import from Proof back into Fabric, emit existing events:
- `document_change` with `action: "updated"`
- `activity` with `activityType: "document_updated"` or `"document_imported_from_proof"`

Optional extension:
- Add a new activity subtype string only; no new transport schema needed initially.

Do not create a new channel design for v1. Reuse `project:{projectId}`.

---

## 16. Security and multi-tenancy rules

## 16.1 Mandatory access control rules

### Read-only/status operations
Use:
- `hasProjectAccess(projectId, userId, organizationId)`

Applies to:
- proof status
- open link metadata
- refresh status

### Mutations
Use:
- `canEditProject(projectId, userId)`

Applies to:
- link
- push
- import
- finalize
- disconnect

## 16.2 Tenant invariants

Every proof link record must satisfy:
- same `projectId` as parent `ProjectDocument`
- same tenant scope as parent `ProjectDocument`
- personal context stored as `organizationId: null`
- org context stored as exact org id

### Forbidden query pattern
Never do:
```ts
where: {
  OR: [{ userId }, { organizationId }]
}
```

### Required query pattern
```ts
const tenantFilter = organizationId
  ? { organizationId, userId }
  : { organizationId: null, userId };
```

Or use `tenantProtectedProcedure` + tenant-aware DB access consistently.

## 16.3 Token handling

Tokens must be:
- encrypted before DB persistence
- never returned from oRPC procedures
- never included in client props
- never logged raw
- never stored in analytics events

## 16.4 Logging rules

Allowed:
- document id
- project id
- proof link id
- sync status
- request id
- response status codes
- timestamps
- hashes/revision ids

Forbidden:
- raw bridge token
- full Proof document state payloads in logs
- full markdown content in logs

## 16.5 External-doc policy hooks

Add feature flags before rollout:
- org-level: `proofCollaborationEnabled`
- optional project-level override later

v1 rollout should be opt-in only.

## 16.6 Safe failure behavior

If Proof fails:
- Fabric document save must still succeed
- link status becomes `OUT_OF_SYNC` or `FAILED`
- user can retry manually
- no data loss in `ProjectDocument`

---

## 17. Concrete implementation tasks

## Task 1: Add schema and tenant plumbing

Objective: Create the minimal DB model for Proof links and wire it into tenant protections.

Files:
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/database/src/tenant-db.ts`
- Modify: `packages/database/scripts/apply-rls-direct.ts`
- Create migration under: `packages/database/prisma/migrations/...`

Steps:
1. Add `ProofSyncStatus` enum.
2. Add `ProjectDocumentProofLink` model.
3. Add relation on `ProjectDocument`.
4. Add new table to tenant-db category.
5. Add RLS policy.
6. Run Prisma migration with `migrate dev`.
7. Run `pnpm --filter @repo/database generate`.
8. Run `pnpm --filter @repo/database apply:rls`.

Verification:
- Prisma client compiles
- migration is generated
- tenant RLS applies cleanly

## Task 2: Add DB query layer

Objective: Add a focused query module for proof link CRUD and status updates.

Files:
- Create: `packages/database/prisma/queries/projects/document-proof-links.ts`
- Modify export barrel(s) if needed in `packages/database`

Steps:
1. Implement getters
2. Implement create/update/delete helpers
3. Implement push/import status helpers
4. Add tenant-isolation comments mirroring existing query files

Verification:
- typecheck passes
- queries are importable from `@repo/database`

## Task 3: Add Proof adapter and encryption utility

Objective: Encapsulate hosted Proof HTTP interactions.

Files:
- Create: `packages/api/modules/projects/lib/proof-adapter.ts`
- Create or reuse shared secret helper in appropriate server lib

Steps:
1. Implement create/get-state/push/report-bug methods
2. Add request-id extraction and redacted error handling
3. Add token encryption/decryption helpers

Verification:
- adapter unit tests pass
- no secret field leaks in typed return values

## Task 4: Add proof procedures

Objective: Add tenant-aware API operations for Proof link lifecycle.

Files:
- Create: `packages/api/modules/projects/procedures/documents/proof/link-document.ts`
- Create: `packages/api/modules/projects/procedures/documents/proof/get-status.ts`
- Create: `packages/api/modules/projects/procedures/documents/proof/push.ts`
- Create: `packages/api/modules/projects/procedures/documents/proof/import-latest.ts`
- Create: `packages/api/modules/projects/procedures/documents/proof/finalize.ts`
- Create: `packages/api/modules/projects/procedures/documents/proof/disconnect.ts`
- Optional: `packages/api/modules/projects/procedures/documents/proof/refresh-status.ts`
- Modify: `packages/api/modules/projects/router.ts`

Steps:
1. Use `tenantProtectedProcedure` everywhere
2. Resolve `organizationId`
3. Enforce `hasProjectAccess` vs `canEditProject`
4. Return sanitized metadata only

Verification:
- router types compile
- unauthorized access returns FORBIDDEN
- cross-tenant lookups fail safely

## Task 5: Add sync trigger helper

Objective: Centralize Proof sync enqueue logic.

Files:
- Create: `packages/api/modules/projects/lib/proof-sync-trigger.ts`
- Modify: `packages/api/modules/projects/procedures/update-document.ts`
- Modify: generation/save paths touching `ProjectDocument`

Steps:
1. Implement helper that loads link and decides whether to enqueue
2. Call it after document update success
3. Call it from generation-complete path(s)

Verification:
- document updates still succeed when Proof is disabled or unavailable
- linked docs enqueue sync attempts

## Task 6: Add Temporal workflows/activities

Objective: Make outbound Proof sync durable and retriable.

Files:
- Create: `packages/temporal/src/workflows/projects/proof-document-sync.ts`
- Optional create: `packages/temporal/src/workflows/projects/proof-document-import.ts`
- Create: `packages/temporal/src/activities/projects/proof.ts`
- Modify workflow registrations/index files as needed

Steps:
1. Implement sync workflow first
2. Add import workflow if desired, otherwise keep import synchronous initially
3. Ensure workflow args always include `organizationId`

Verification:
- workflow registration succeeds
- unit tests pass
- failed pushes mark status appropriately

## Task 7: Add frontend status/actions

Objective: Expose Proof collaboration controls in project document UI.

Files:
- Modify: `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
- Optional create: `apps/web/modules/saas/projects/components/ProofCollaborationPanel.tsx`
- Optional create: `apps/web/modules/saas/projects/components/ProofSyncBadge.tsx`

Steps:
1. Query proof status
2. Render banner/badge
3. Add Link/Open/Import/Retry/Finalize/Disconnect actions
4. Invalidate queries after mutations

Verification:
- existing editor still works for unlinked docs
- linked docs show status and actions cleanly

## Task 8: Add tests and documentation

Objective: Prove tenant safety, auth safety, and sync behavior.

Files:
- Add tests listed in section 18
- Optionally update docs index or related architecture docs

Verification:
- test matrix passes
- lint/typecheck/build remain green

---

## 18. Test matrix by file/path

Below is the recommended initial test matrix, grounded in the current repo structure.

## 18.1 Database / tenant tests

### File
- `packages/database/src/__tests__/tenant/project-document-proof-link.test.ts` or nearest existing tenant test location

### Cases
1. Personal link record is only visible with `organizationId: null`
2. Org link record is only visible with matching org id
3. Cross-org access fails
4. Link row tenant scope matches parent `ProjectDocument`
5. Deleting `ProjectDocument` cascades link deletion

If there is already a preferred tenant test directory, place these there instead of inventing a new one.

## 18.2 API procedure tests

### Files
- `packages/api/modules/projects/procedures/documents/proof/__tests__/link-document.test.ts`
- `packages/api/modules/projects/procedures/documents/proof/__tests__/get-status.test.ts`
- `packages/api/modules/projects/procedures/documents/proof/__tests__/push.test.ts`
- `packages/api/modules/projects/procedures/documents/proof/__tests__/import-latest.test.ts`
- `packages/api/modules/projects/procedures/documents/proof/__tests__/finalize.test.ts`
- `packages/api/modules/projects/procedures/documents/proof/__tests__/disconnect.test.ts`

### Cases
#### link-document
- editor can link personal doc
- editor can link org doc
- viewer/non-editor forbidden
- cross-project document id rejected
- duplicate active link rejected
- token omitted from response

#### get-status
- viewer can read status when project access exists
- no access => FORBIDDEN
- unlinked doc returns `linked: false`

#### push
- linked doc queues workflow
- unlinked doc returns validation/business error
- no edit access => FORBIDDEN

#### import-latest
- imports Proof markdown into `ProjectDocument`
- creates new `DocumentVersion`
- emits activity/document change
- respects org/personal tenant context
- conflict state blocks unsafe import

#### finalize
- imports then marks `CLOSED`

#### disconnect
- marks link `CLOSED`
- does not delete `ProjectDocument`

## 18.3 Proof adapter tests

### File
- `packages/api/modules/projects/lib/__tests__/proof-adapter.test.ts`

### Cases
- create doc request formats payload correctly
- get state parses expected response
- push handles success response
- request id extraction works
- error redaction removes token
- bug report helper sends summary/context/evidence

## 18.4 Sync trigger tests

### File
- `packages/api/modules/projects/lib/__tests__/proof-sync-trigger.test.ts`

### Cases
- no active link => no workflow started
- active link + changed content => workflow started
- closed link => no workflow started
- enqueue failure marks out-of-sync but does not throw into caller path

## 18.5 Temporal workflow tests

### Files
- `packages/temporal/src/workflows/projects/__tests__/proof-document-sync.test.ts`
- optional `packages/temporal/src/workflows/projects/__tests__/proof-document-import.test.ts`

### Cases
- already-pushed hash => no-op
- push success => `ACTIVE`
- transient push failure retries
- terminal failure => `FAILED`
- import conflict => `CONFLICT`
- workflow args include organizationId for org docs

## 18.6 Existing document procedure regression tests

### Files to extend
- tests near existing project document procedure coverage
- if present, extend tests for:
  - `packages/api/modules/projects/procedures/update-document.ts`
  - `packages/api/modules/projects/procedures/documents/generate-document.ts`

### Cases
- normal document update still succeeds with no proof link
- linked update triggers sync helper
- failed proof enqueue does not fail document update
- generation completion triggers sync helper

## 18.7 Frontend component tests

### Files
- `apps/web/modules/saas/projects/components/__tests__/DocumentEditor.proof.test.tsx`
- optional tests for any new proof badge/panel component

### Cases
- unlinked doc renders normal editor without Proof banner
- linked doc shows status badge/banner
- import available state shows import action
- conflict state shows warning banner
- actions call the right ORPC procedures

## 18.8 Playwright / end-to-end tests

### File
- `apps/web/tests/project-document-proof-collaboration.spec.ts`

### Suggested scenarios
1. Personal project doc can be linked to Proof
2. Org project doc can be linked to Proof
3. Editor updates doc in Fabric, status moves through push lifecycle
4. Import latest from Proof updates rendered doc after refresh
5. Viewer cannot trigger import/finalize/disconnect
6. Cross-tenant URL/context cannot access proof-linked doc

For CI, mock Proof API calls unless a dedicated integration environment exists.

---

## 19. Observability and debugging

Add logs and metrics around:
- link creation success/failure
- push enqueue success/failure
- push execution success/failure
- import success/failure
- conflict detection
- status transitions

Suggested fields:
- `projectId`
- `documentId`
- `proofLinkId`
- `organizationId` presence only, not sensitive content
- `syncStatusFrom`
- `syncStatusTo`
- `proofRequestId`

If Proof returns confusing stale-read/failed-write behavior, use their bug endpoint:
- `POST https://www.proofeditor.ai/api/bridge/report_bug`

Include:
- short summary
- context
- raw evidence like request/response pairs or request IDs

---

## 20. Rollout plan

## Phase 1: internal/feature-flag pilot
- Add schema, API, adapter, sync workflow, basic UI
- Enable only for selected internal users or orgs
- Allow only a small subset of document types if desired
- Manual import/finalize only

## Phase 2: production opt-in
- Add clearer status UX
- Improve conflict resolution copy
- Add admin/org setting toggle
- Expand test coverage and monitoring

## Phase 3: optional enhancements
- richer remote activity awareness
- selective import previews
- optional agent-presence indicators
- possible comment/suggestion summaries in Fabric UI

---

## 21. Commands to run during implementation

### Database
```bash
cd packages/database
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --name add_project_document_proof_links --schema=./prisma/schema.prisma
pnpm --filter @repo/database generate
pnpm --filter @repo/database apply:rls
npx dotenv -c -e ../../.env.local -- npx prisma migrate status --schema=./prisma/schema.prisma
```

### Validate app
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @repo/database test:tenant
```

### Targeted tests during implementation
```bash
pnpm vitest packages/api/modules/projects/procedures/documents/proof
pnpm vitest packages/api/modules/projects/lib/__tests__/proof-adapter.test.ts
pnpm vitest packages/temporal/src/workflows/projects/__tests__/proof-document-sync.test.ts
pnpm playwright test apps/web/tests/project-document-proof-collaboration.spec.ts
```

Adjust exact commands to your monorepo test runner conventions if these paths differ.

---

## 22. Acceptance criteria

This plan is complete when all of the following are true:

1. A `ProjectDocument` can be linked to a Proof document from Fabric.
2. Updating a linked document in Fabric automatically queues a push to Proof.
3. Document generator updates also trigger the same push behavior.
4. Proof credentials never reach the client.
5. Personal and org contexts are strictly isolated for proof link metadata and operations.
6. Importing latest from Proof creates a new Fabric `DocumentVersion` and updates `ProjectDocument.content`.
7. TipTap/editor reload shows imported content from the DB.
8. Conflict detection blocks unsafe auto-import.
9. Failures in Proof sync do not break normal Fabric document save/update flows.
10. Tests cover tenant isolation, authorization, sync behavior, regression safety, and UI behavior.

---

## 23. Final recommendation

Implement this as a narrow integration around `ProjectDocument`, not a new editor platform migration.

The safest sequence is:
1. schema + tenant plumbing
2. proof adapter + proof link procedures
3. async Fabric -> Proof sync trigger
4. explicit Proof -> Fabric import/finalize
5. status UI + tests

That sequence gives you collaboration value quickly while preserving your existing editor UX and Fabric’s tenant/security model.