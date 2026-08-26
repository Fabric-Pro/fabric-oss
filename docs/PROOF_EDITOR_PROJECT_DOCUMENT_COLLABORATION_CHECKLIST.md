# Proof Editor + Project Documents Execution Checklist

Goal: Implement Proof-backed collaboration for `ProjectDocument` with small, rollback-safe steps that preserve TipTap, tenant isolation, and DB-as-source-of-truth.

Related plan:
- `docs/PROOF_EDITOR_PROJECT_DOCUMENT_COLLABORATION_PLAN.md`

## Minimal architecture sketch

```text
Fabric UI (DocumentEditor.tsx)
  -> oRPC project document procedures
    -> Fabric DB (ProjectDocument, DocumentVersion, ProjectDocumentProofLink)
    -> Realtime/activity emits stay in Fabric
    -> Proof sync trigger helper
      -> Temporal proof sync workflow
        -> server-only Proof adapter
          -> Proof hosted document

Canonical state: Fabric DB
Collaboration surface: Proof
In-app editor/generation surface: existing TipTap + current document workflows
Import direction in v1: explicit Proof -> Fabric import/finalize
Push direction in v1: async Fabric -> Proof after supported writes
```

## Exact content mutation touchpoints to cover

These are the places where canonical `ProjectDocument` content is created or changed today and therefore must either trigger Proof sync or be explicitly excluded in v1.

### API/database-backed touchpoints
- `packages/api/modules/projects/procedures/create-document.ts`
- `packages/api/modules/projects/procedures/update-document.ts`
- `packages/api/modules/projects/procedures/versions/restore-version.ts`
- `packages/database/prisma/queries/projects/documents.ts`
  - `updateDocument(...)`
  - `restoreDocumentVersion(...)`
- `packages/api/modules/projects/router.ts`
  - add `projects.documents.proof.*`

### Generation and workflow touchpoints
- `packages/api/modules/projects/procedures/documents/generate-document.ts`
  - starts `projectDocumentGenerationWorkflow`
- `packages/temporal/src/activities/project-document-generation.ts`
  - `saveProjectDocument(...)` — canonical generated/regenerated content save
  - `createDocumentVersion(...)` — version advancement paired with generation saves
  - `saveExternalPrd(...)` — external PRD sync create/update path
  - direct `projectDocument.update(...)` calls around the user-story/general document upsert paths
  - direct `projectDocument.create(...)` calls around placeholder/initial document creation paths

### Existing collaboration/editor touchpoints that must remain intact
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
- `apps/web/modules/saas/projects/hooks/useDocumentLock.ts`
- `packages/database/prisma/queries/projects/document-locks.ts`
- `packages/api/lib/realtime.ts`

### Reuse instead of reinventing
- `packages/rag/lib/project-documents/embed.ts`
  - `generateContentHash(...)` can be reused for Proof sync dedupe/hash tracking
- `packages/utils/lib/ai-gateway-encryption.ts`
  - likely starting point for encrypt/decrypt helper style for persisted Proof secrets

---

## Phase 0: Pre-flight

### Task 0.1: Re-read the existing document flow
Files:
- `packages/database/prisma/queries/projects/documents.ts`
- `packages/api/modules/projects/procedures/create-document.ts`
- `packages/api/modules/projects/procedures/update-document.ts`
- `packages/api/modules/projects/procedures/versions/restore-version.ts`
- `packages/api/modules/projects/procedures/documents/generate-document.ts`
- `packages/temporal/src/activities/project-document-generation.ts`
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
- `apps/web/modules/saas/projects/hooks/useDocumentLock.ts`
- `packages/database/prisma/queries/projects/document-locks.ts`
- `docs/DOCUMENT_EDITOR_STREAMING_PATTERN.md`

Steps:
1. Confirm the API edit path: `update-document.ts` -> `updateDocument(...)`.
2. Confirm the restore path: `restore-version.ts` -> `restoreDocumentVersion(...)` -> `updateDocument(...)`.
3. Confirm the manual create path: `create-document.ts`.
4. Confirm the generation entry point: `generate-document.ts` starts `projectDocumentGenerationWorkflow`.
5. Confirm the actual generation save point is `saveProjectDocument(...)` in `packages/temporal/src/activities/project-document-generation.ts`.
6. Confirm the non-primary generation write paths that would otherwise be missed:
   - `saveExternalPrd(...)`
   - direct `projectDocument.update(...)` upsert paths
   - direct `projectDocument.create(...)` placeholder/initial paths
7. Note that Fabric document locks are local in-app editing semantics and should not be assumed to govern Proof sessions.

Done when:
- You can point to the exact post-save hook points for manual edits, restores, generation saves, and external PRD/user-story style writes.

### Task 0.2: Confirm migration readiness
Files:
- `packages/database/prisma/schema.prisma`

Steps:
1. Check current migration status.
2. Check for local DB drift before editing schema.

Commands:
```bash
cd packages/database
npx dotenv -c -e ../../.env.local -- npx prisma migrate status --schema=./prisma/schema.prisma
npx dotenv -c -e ../../.env.local -- npx prisma migrate diff --from-schema-datasource ./prisma/schema.prisma --to-schema-datamodel ./prisma/schema.prisma --exit-code
```

Done when:
- DB is in sync or any drift is understood before new schema work starts.

---

## Phase 1: Schema and tenant plumbing

### Task 1.1: Add `ProofSyncStatus` enum
File:
- `packages/database/prisma/schema.prisma`

Steps:
1. Add `ProofSyncStatus` enum.
2. Keep values exactly aligned with the architecture plan.

Done when:
- Prisma schema parses successfully.

### Task 1.2: Add `ProjectDocumentProofLink` model
File:
- `packages/database/prisma/schema.prisma`

Steps:
1. Add the new model.
2. Include tenant fields: `userId`, `organizationId`.
3. Include sync status and audit fields.
4. Add indexes.

Done when:
- Prisma schema parses successfully.

### Task 1.3: Add relation on `ProjectDocument`
File:
- `packages/database/prisma/schema.prisma`

Steps:
1. Add optional `proofLink` relation.
2. Verify relation names are unambiguous.

Done when:
- Prisma schema parses successfully.

### Task 1.4: Add tenant-db coverage
File:
- `packages/database/src/tenant-db.ts`

Steps:
1. Add `ProjectDocumentProofLink` to the right tenant-protected category.
2. Mirror the existing approach used for `ProjectDocument` and `DocumentVersion`.

Done when:
- The model is covered by tenant extension rules.

### Task 1.5: Add RLS policy
File:
- `packages/database/scripts/apply-rls-direct.ts`

Steps:
1. Add RLS handling for `project_document_proof_link`.
2. Match existing XOR tenant rules.

Done when:
- Personal rows require `organization_id IS NULL`.
- Org rows require exact `organization_id` match.

### Task 1.6: Create migration and regenerate client
Commands:
```bash
cd packages/database
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --name add_project_document_proof_links --schema=./prisma/schema.prisma
pnpm --filter @repo/database generate
pnpm --filter @repo/database apply:rls
```

Done when:
- Migration exists.
- Prisma client regenerates.
- RLS applies without errors.

---

## Phase 2: Query layer

### Task 2.1: Create proof-link query module
File:
- `packages/database/prisma/queries/projects/document-proof-links.ts`

Steps:
1. Add getter functions.
2. Add create/update/delete helpers.
3. Add status transition helpers.
4. Add comments describing tenant expectations.

Done when:
- Module compiles.
- Functions are typed and importable.

### Task 2.2: Export query helpers
Files:
- any `packages/database` barrel exports needed

Steps:
1. Export the new proof-link functions.
2. Keep exports consistent with existing query modules.

Done when:
- `@repo/database` can import the new helpers cleanly.

---

## Phase 3: Proof adapter and secret handling

### Task 3.1: Create server-side Proof adapter
File:
- `packages/api/modules/projects/lib/proof-adapter.ts`

Steps:
1. Add `createProofDocument`.
2. Add `getProofDocumentState`.
3. Add `pushProofDocumentMarkdown`.
4. Add `reportProofBug`.

Done when:
- The adapter has no client/browser dependencies.

### Task 3.2: Add token encryption helpers
Files:
- reuse existing server secret utility if one exists, otherwise create one in the appropriate server-only lib

Steps:
1. Add encrypt helper.
2. Add decrypt helper.
3. Ensure ciphertext only is persisted.

Done when:
- Raw Proof token never needs to be stored plaintext in DB.

### Task 3.3: Add adapter-level redaction
File:
- `packages/api/modules/projects/lib/proof-adapter.ts`

Steps:
1. Redact tokens from thrown/logged errors.
2. Capture request IDs when available.

Done when:
- Debug logs never expose credentials.

---

## Phase 4: API procedures

### Task 4.1: Add link procedure
File:
- `packages/api/modules/projects/procedures/documents/proof/link-document.ts`

Steps:
1. Use `tenantProtectedProcedure`.
2. Resolve `organizationId`.
3. Verify `canEditProject`.
4. Load document.
5. Create Proof doc.
6. Encrypt token.
7. Save link row.
8. Return sanitized metadata.

Done when:
- A document can be linked without exposing secret fields.

### Task 4.2: Add status procedure
File:
- `packages/api/modules/projects/procedures/documents/proof/get-status.ts`

Steps:
1. Use `tenantProtectedProcedure`.
2. Verify `hasProjectAccess`.
3. Load link row.
4. Return UI-safe status payload.

Done when:
- Viewer/readable status works without leaking secrets.

### Task 4.3: Add manual push procedure
File:
- `packages/api/modules/projects/procedures/documents/proof/push.ts`

Steps:
1. Verify `canEditProject`.
2. Load document + link.
3. Start sync workflow.
4. Return queued state.

Done when:
- User can retry push manually.

### Task 4.4: Add import-latest procedure
File:
- `packages/api/modules/projects/procedures/documents/proof/import-latest.ts`

Steps:
1. Verify `canEditProject`.
2. Load document + link.
3. Fetch Proof state.
4. Detect conflict.
5. If safe, write back to `ProjectDocument` via `updateDocument(...)`.
6. Record import metadata.
7. Emit activity/realtime events.

Done when:
- Latest Proof content can be imported into Fabric and versioned.

### Task 4.5: Add finalize procedure
File:
- `packages/api/modules/projects/procedures/documents/proof/finalize.ts`

Steps:
1. Reuse import behavior.
2. Mark link `CLOSED`.

Done when:
- Finalize imports content and closes collaboration session.

### Task 4.6: Add disconnect procedure
File:
- `packages/api/modules/projects/procedures/documents/proof/disconnect.ts`

Steps:
1. Verify `canEditProject`.
2. Mark link `CLOSED`.
3. Do not delete Fabric doc.

Done when:
- Collaboration can be closed safely.

### Task 4.7: Wire router
File:
- `packages/api/modules/projects/router.ts`

Steps:
1. Import all new proof procedures.
2. Add `projects.documents.proof.*` namespace.

Done when:
- ORPC client types expose the new routes.

---

## Phase 5: Sync trigger helper

### Task 5.1: Create sync trigger helper
File:
- `packages/api/modules/projects/lib/proof-sync-trigger.ts`

Steps:
1. Load proof link by document id.
2. Exit if no active link.
3. Mark `PUSH_PENDING`.
4. Start Temporal workflow.
5. On enqueue failure, mark `OUT_OF_SYNC` or `FAILED`.

Done when:
- Sync trigger logic exists in one place only.

### Task 5.2: Hook normal document updates into sync trigger
Files:
- `packages/api/modules/projects/procedures/update-document.ts`
- `packages/api/modules/projects/procedures/create-document.ts`
- `packages/api/modules/projects/procedures/versions/restore-version.ts`
- `packages/database/prisma/queries/projects/documents.ts`

Steps:
1. Keep current DB update behavior intact.
2. After successful manual update, call sync trigger helper from `update-document.ts`.
3. Ensure restores also flow through the same trigger path after `restoreDocumentVersion(...)` completes.
4. Decide whether manual creates should auto-link/push only when a Proof link already exists, or stay link-first and no-op otherwise.
5. Never fail the main request because Proof enqueue failed.

Done when:
- Editing or restoring a linked document in Fabric queues Proof push automatically without changing canonical save semantics.

### Task 5.3: Hook generation completion into sync trigger
Files:
- `packages/api/modules/projects/procedures/documents/generate-document.ts`
- `packages/temporal/src/activities/project-document-generation.ts`

Steps:
1. Do not hook only `generate-document.ts`; that file starts the workflow but does not persist final content.
2. Call the same sync trigger helper from the actual write sites in `project-document-generation.ts`.
3. Cover at minimum:
   - `saveProjectDocument(...)`
   - `saveExternalPrd(...)`
4. Explicitly choose v1 behavior for the additional direct create/update paths in that file:
   - placeholder creates to `GENERATING`
   - user-story/general upsert helpers
5. If those extra paths are in scope for v1, route them through the same trigger helper or a centralized `onProjectDocumentContentChanged(...)` helper instead of bespoke Proof calls.

Done when:
- Project document generation, regeneration, and supported external/document-pipeline saves also push to Proof automatically.

---

## Phase 6: Temporal workflows and activities

### Task 6.1: Add Proof sync activities
File:
- `packages/temporal/src/activities/projects/proof.ts`

Steps:
1. Add activity to load the latest canonical `ProjectDocument` content.
2. Add activity to load the tenant-scoped Proof link row.
3. Add activity to push markdown/content to Proof through the server-only adapter.
4. Add activity to record success/failure status and last pushed hash/version.
5. Keep activity inputs tenant-aware: `userId` plus `organizationId` where applicable.

Done when:
- Activities can support end-to-end sync workflow logic without bypassing tenant checks.

### Task 6.2: Add `proofDocumentSyncWorkflow`
File:
- `packages/temporal/src/workflows/projects/proof-document-sync.ts`

Steps:
1. Accept `documentId`, `projectId`, `userId`, `organizationId`, `reason`.
2. Load latest document and link.
3. Skip closed or unlinked documents.
4. Compare current hash/version with last pushed values.
5. Reuse the same content hash convention as `packages/rag/lib/project-documents/embed.ts` where practical.
6. Push to Proof only when changed.
7. Record success or failure state.

Done when:
- Durable async push works without blocking app saves and without spamming no-op Proof writes.

### Task 6.3: Register workflow/activity
Files:
- `packages/temporal/src/workflows/**` export/index files already used by `projectDocumentGenerationWorkflow`
- `packages/temporal/src/activities/**` registration files already used by project document activities

Steps:
1. Register the new activity file.
2. Register the new workflow.
3. Ensure task queue naming is consistent with `project-documents` unless there is a strong reason to isolate Proof sync.
4. Verify the API-side sync trigger starts the registered workflow by name successfully.

Done when:
- Workflow can be started successfully.

### Task 6.4: Confirm org args are always passed
Files:
- all workflow-start call sites for Proof sync/import

Steps:
1. Verify org docs pass `organizationId`.
2. Verify personal docs pass `undefined` and not a wrong fallback.

Done when:
- There is no path where org sync runs without org tenant context.

---

## Phase 7: Frontend status and actions

### Task 7.1: Add Proof status query to document editor
File:
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`

Steps:
1. Query `projects.documents.proof.status`.
2. Keep behavior no-op for unlinked docs.

Done when:
- Editor can display current Proof link state.

### Task 7.2: Add compact status UI
Files:
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
- optional new component: `apps/web/modules/saas/projects/components/ProofSyncBadge.tsx`

Steps:
1. Render linked/in-sync state.
2. Render import-pending state.
3. Render conflict state.
4. Render failed/out-of-sync state.

Done when:
- User can understand collaboration state at a glance.

### Task 7.3: Add mutation actions
Files:
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
- optional new component: `apps/web/modules/saas/projects/components/ProofCollaborationPanel.tsx`

Steps:
1. Add Link to Proof action.
2. Add Open in Proof action.
3. Add Retry push action.
4. Add Import latest action.
5. Add Finalize action.
6. Add Disconnect action.

Done when:
- UI supports the full v1 lifecycle.

### Task 7.4: Invalidate queries after mutations
File:
- same frontend component(s)

Steps:
1. Invalidate document query after import/finalize.
2. Invalidate proof status query after every proof mutation.
3. Invalidate list query if needed.

Done when:
- Refresh/reload reflects the DB-backed latest state.

---

## Phase 8: Tests

### Task 8.1: Add DB/tenant tests
Suggested file:
- `packages/database/src/__tests__/tenant/project-document-proof-link.test.ts`

Steps:
1. Test personal isolation.
2. Test org isolation.
3. Test cross-org denial.
4. Test parent-doc tenant alignment.

Done when:
- Proof link rows follow the same tenant rules as project documents.

### Task 8.2: Add API procedure tests
Suggested files:
- `packages/api/modules/projects/procedures/documents/proof/__tests__/link-document.test.ts`
- `.../get-status.test.ts`
- `.../push.test.ts`
- `.../import-latest.test.ts`
- `.../finalize.test.ts`
- `.../disconnect.test.ts`

Done when:
- auth, tenant, and secret-handling coverage exists.

### Task 8.3: Add adapter tests
Suggested file:
- `packages/api/modules/projects/lib/__tests__/proof-adapter.test.ts`

Done when:
- Proof API payloads and redaction behavior are covered.

### Task 8.4: Add sync trigger tests
Suggested file:
- `packages/api/modules/projects/lib/__tests__/proof-sync-trigger.test.ts`

Done when:
- enqueue behavior is covered and safe on failure.

### Task 8.5: Add workflow tests
Suggested files:
- `packages/temporal/src/workflows/projects/__tests__/proof-document-sync.test.ts`
- optional `.../proof-document-import.test.ts`

Done when:
- durable push/import logic is covered.

### Task 8.6: Add frontend tests
Suggested file:
- `apps/web/modules/saas/projects/components/__tests__/DocumentEditor.proof.test.tsx`

Done when:
- linked/unlinked/import/conflict UI states are covered.

### Task 8.7: Add Playwright scenario
Suggested file:
- `apps/web/tests/project-document-proof-collaboration.spec.ts`

Done when:
- end-to-end flow is covered with mocked Proof API.

---

## Phase 9: Validation

### Task 9.1: Run focused tests
Commands:
```bash
pnpm vitest packages/api/modules/projects/procedures/documents/proof
pnpm vitest packages/api/modules/projects/lib/__tests__/proof-adapter.test.ts
pnpm vitest packages/temporal/src/workflows/projects/__tests__/proof-document-sync.test.ts
```

### Task 9.2: Run repo-level validation
Commands:
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @repo/database test:tenant
```

### Task 9.3: Run browser flow validation
Command:
```bash
pnpm playwright test apps/web/tests/project-document-proof-collaboration.spec.ts
```

Done when:
- all relevant checks pass and no existing document workflows regress.

---

## Phase 10: Rollout

### Task 10.1: Add feature flag gating
Steps:
1. Ensure Proof collaboration is opt-in.
2. Limit rollout to internal or selected orgs first.

Done when:
- blast radius is controlled.

### Task 10.2: Pilot on a narrow document subset
Suggested first use cases:
- PRD
- technical spec
- proposal/report-like docs

Done when:
- workflow is validated on real docs before broadening scope.

### Task 10.3: Observe and harden
Steps:
1. Watch sync failures.
2. Watch conflict rates.
3. Watch tenant/auth edge cases.
4. Improve status copy and retry UX before wider rollout.

Done when:
- pilot usage is stable enough for wider exposure.

---

## Minimal safe delivery order

If implementation needs to be split into the smallest safe slices, do it in this order:

1. Schema + migration + tenant/RLS
2. Query layer
3. Proof adapter + secret handling
4. Link + status procedures
5. Sync trigger + sync workflow
6. Hook update/generation paths into push
7. Import/finalize procedures
8. Frontend status/actions
9. Tests + rollout gating

---

## Definition of done

The feature is done when:
- linked project docs auto-push Fabric changes to Proof
- generated doc changes also auto-push to Proof
- latest Proof draft can be imported/finalized back into Fabric
- TipTap shows imported DB content on refresh
- secrets never reach the client
- org/personal tenancy is preserved end-to-end
- conflict detection blocks unsafe automatic overwrites
- tests, lint, typecheck, and regression validation all pass