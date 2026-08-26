# Frames Parity End-State Summary

## Goal
Bring Frames in Fabric as close as practical to `fabric-pro` parity, make Frames a first-class product surface, remove transitional blob-style behavior, and leave the system in a clean end-state.

---

## Final Outcome

### Product state
- [x] Frames are now a **first-class artifact type** in Fabric
- [x] Slideshows are supported as a first-class variant of Frames
- [x] Public share flows exist for Frames
- [x] Authenticated frame pages exist for Frames
- [x] Dedicated embed routes exist for Frames
- [x] Chat surfaces render Frames as native interactive artifacts rather than generic JSON/blob output
- [x] Agents can access the full Frame tool family through the `create-frames` capability
- [x] Workspace/file surfaces recognize Frames as first-class items
- [x] Legacy `fabric_create_file` references introduced during prior passes were removed from runtime/UI/test surfaces involved in the Frames work

---

## Architecture and Persistence

### Data model
- [x] Extended `AgentWorkspaceFile` to support first-class frame semantics
- [x] Added `FRAME` and `SLIDESHOW` to `AgentFileType`
- [x] Added sharing/provenance fields:
  - [x] `shareToken`
  - [x] `isPublic`
  - [x] `sourceRunType`
  - [x] `sourceRunId`
  - [x] `authoritySessionId`
  - [x] `providerKeys`

### Migration and generation
- [x] Added and applied migration:
  - [packages/database/prisma/migrations/20260320000000_add_first_class_frames/migration.sql](../../packages/database/prisma/migrations/20260320000000_add_first_class_frames/migration.sql)
- [x] Regenerated Prisma and downstream types

### Frame query layer
- [x] Added dedicated frame query module:
  - [packages/database/prisma/queries/frames.ts](../../packages/database/prisma/queries/frames.ts)
- [x] Added support for:
  - [x] create
  - [x] get by id
  - [x] list
  - [x] update
  - [x] publish
  - [x] revoke share
  - [x] resolve public share token

---

## API Layer

### Frame API
- [x] Added dedicated frame router:
  - [packages/api/modules/frames/router.ts](../../packages/api/modules/frames/router.ts)
- [x] Added frame procedures:
  - [x] `create`
  - [x] `get`
  - [x] `list`
  - [x] `update`
  - [x] `publish`
  - [x] `revoke-share`

### Public share metadata
- [x] Added public share metadata endpoint:
  - [apps/web/app/api/share/frame/[token]/route.ts](../../apps/web/app/api/share/frame/[token]/route.ts)
- [x] Share metadata supports:
  - [x] `shareUrl`
  - [x] `embedUrl`
  - [x] `vizUrl`
  - [x] title/workspace context
  - [x] kind/content type

### Workspace/file API cleanup
- [x] Workspace file tree now respects `conversationId`
- [x] Workspace get-file retrieval now passes tenant context correctly
- [x] Workspace create-file API recognizes `FRAME` and `SLIDESHOW` file types where relevant to workspace surfaces

---

## Runtime and Tooling

### Shared frame service
- [x] Added shared frame runtime service:
  - [packages/temporal/src/activities/shared/frame-service.ts](../../packages/temporal/src/activities/shared/frame-service.ts)
- [x] Centralized frame behavior across orchestrator, direct chat, agent execution, and gateway integrations

### First-class Frame tool family
- [x] Added/expanded tools:
  - [x] `fabric_create_frame`
  - [x] `fabric_update_frame`
  - [x] `fabric_get_frame`
  - [x] `fabric_list_frames`
  - [x] `fabric_share_frame`
  - [x] `fabric_create_slideshow`

### Agent/tool capability mapping
- [x] `create-frames` now grants the full Frame tool family
- [x] This is wired through:
  - [packages/database/prisma/queries/agent-templates.ts](../../packages/database/prisma/queries/agent-templates.ts)
  - [packages/temporal/src/activities/agent-execution-core/context-builder.ts](../../packages/temporal/src/activities/agent-execution-core/context-builder.ts)
  - [apps/web/modules/saas/agents/lib/builtin-capabilities.tsx](../../apps/web/modules/saas/agents/lib/builtin-capabilities.tsx)
  - [apps/web/app/(saas)/app/agents/fabric-ai/page.tsx](../../apps/web/app/(saas)/app/agents/fabric-ai/page.tsx)
  - [apps/web/modules/saas/ai/components/CopilotPage.tsx](../../apps/web/modules/saas/ai/components/CopilotPage.tsx)

### Cleanup of old file-creation path in touched surfaces
- [x] Removed remaining `fabric_create_file` references from:
  - [packages/temporal/src/activities/direct-chat/built-in-tools.ts](../../packages/temporal/src/activities/direct-chat/built-in-tools.ts)
  - [packages/temporal/src/activities/agent-execution-core/agent-executor.ts](../../packages/temporal/src/activities/agent-execution-core/agent-executor.ts)
  - [packages/temporal/src/activities/orchestrator/execution/handlers/fabric-ai-handler.ts](../../packages/temporal/src/activities/orchestrator/execution/handlers/fabric-ai-handler.ts)
  - [packages/temporal/src/activities/orchestrator/tools/fabric-ai-tools.ts](../../packages/temporal/src/activities/orchestrator/tools/fabric-ai-tools.ts)
  - [packages/database/prisma/queries/agent-templates.ts](../../packages/database/prisma/queries/agent-templates.ts)
  - [apps/web/modules/saas/ai/components/CopilotPage.tsx](../../apps/web/modules/saas/ai/components/CopilotPage.tsx)
  - [apps/web/app/(saas)/app/agents/fabric-ai/page.tsx](../../apps/web/app/(saas)/app/agents/fabric-ai/page.tsx)
  - [packages/temporal/src/tests/new-tools.test.ts](../../packages/temporal/src/tests/new-tools.test.ts)

---

## Web Product Surfaces

### Dedicated frame pages
- [x] Added authenticated frame pages:
  - [apps/web/app/(saas)/app/frames/[frameId]/page.tsx](../../apps/web/app/(saas)/app/frames/[frameId]/page.tsx)
  - [apps/web/app/(saas)/app/(organizations)/[organizationSlug]/frames/[frameId]/page.tsx](../../apps/web/app/(saas)/app/(organizations)/[organizationSlug]/frames/[frameId]/page.tsx)
- [x] Added public share page:
  - [apps/web/app/share/frame/[token]/page.tsx](../../apps/web/app/share/frame/[token]/page.tsx)

### Dedicated embed routes
- [x] Added authenticated embed routes
- [x] Added organization-scoped embed route
- [x] Added public embed route
- [x] Embed routes support slide targeting for slideshows

### Unified viewer shell
- [x] Added a dedicated visual shell:
  - [apps/web/modules/saas/frames/components/FrameVizShell.tsx](../../apps/web/modules/saas/frames/components/FrameVizShell.tsx)
- [x] Supports:
  - [x] render/code toggle
  - [x] fullscreen
  - [x] open/share actions
  - [x] copy share link
  - [x] JSON export
  - [x] PNG export
  - [x] PDF export
  - [x] slideshow navigation
  - [x] public vs authenticated header behavior

### Frame renderer
- [x] Reworked frame rendering in:
  - [apps/web/modules/saas/frames/components/FrameRenderer.tsx](../../apps/web/modules/saas/frames/components/FrameRenderer.tsx)
- [x] Supports:
  - [x] markdown/content block rendering
  - [x] embedded mode
  - [x] slide selection for slideshows
  - [x] height reporting to host

---

## Host ↔ Embed Contract

### Typed RPC protocol
- [x] Added shared protocol module:
  - [apps/web/modules/saas/frames/lib/frame-embed-protocol.ts](../../apps/web/modules/saas/frames/lib/frame-embed-protocol.ts)
- [x] Supports typed messages for:
  - [x] ready
  - [x] set-height
  - [x] error
  - [x] request-export-png
  - [x] export-png-result
  - [x] request-display-code
  - [x] display-code acknowledgement

### Lifecycle polish
- [x] Added request timeout handling
- [x] Added pending request cleanup
- [x] Added fallback export behavior when embed RPC does not respond
- [x] Added friendlier loading/error/export status handling in host shell

---

## Chat and Conversation Surfaces

### Shared tool-call rendering
- [x] Added frame-result extraction helpers:
  - [apps/web/modules/saas/frames/lib/frame-result.ts](../../apps/web/modules/saas/frames/lib/frame-result.ts)
- [x] Shared tool rendering now detects frame tool results and renders them natively via:
  - [apps/web/modules/saas/agents/components/FabricChat/shared/ToolCallList.tsx](../../apps/web/modules/saas/agents/components/FabricChat/shared/ToolCallList.tsx)

### Nexus / Copilot
- [x] Nexus/Copilot renders frame tool outputs as first-class cards through:
  - [apps/web/modules/saas/ai/components/CopilotPage.tsx](../../apps/web/modules/saas/ai/components/CopilotPage.tsx)

### Orchestrator chat
- [x] Orchestrator chat gets first-class Frame rendering through shared tool-call rendering

### Direct chat
- [x] Direct chat gets first-class Frame rendering through shared tool-call rendering

### Drawer / panel behavior
- [x] Added reusable preview drawer:
  - [apps/web/modules/saas/frames/components/FramePreviewSheet.tsx](../../apps/web/modules/saas/frames/components/FramePreviewSheet.tsx)
- [x] Added inline result card:
  - [apps/web/modules/saas/frames/components/FrameToolResultCard.tsx](../../apps/web/modules/saas/frames/components/FrameToolResultCard.tsx)
- [x] Supports:
  - [x] inline preview
  - [x] open in panel
  - [x] open frame
  - [x] shared view
  - [x] copy link
  - [x] persisted panel-open state during session rerenders

---

## Workspace / Files Surfaces

### Workspace panel parity
- [x] Workspace panel recognizes frame/slideshow files as first-class artifacts
- [x] Distinct icons/colors/badges for Frame and Slides
- [x] Workspace frame actions now route to the dedicated Frame experience
- [x] Updated file actions in:
  - [apps/web/modules/saas/agents/components/WorkspacePanel/WorkspacePanel.tsx](../../apps/web/modules/saas/agents/components/WorkspacePanel/WorkspacePanel.tsx)

### Workspace hook/action support
- [x] Workspace hooks and actions now recognize frame/slideshow file types where applicable:
  - [apps/web/modules/saas/agents/hooks/useWorkspaceFiles.ts](../../apps/web/modules/saas/agents/hooks/useWorkspaceFiles.ts)
  - [apps/web/modules/saas/agents/hooks/useWorkspaceActions.ts](../../apps/web/modules/saas/agents/hooks/useWorkspaceActions.ts)

---

## Route and UX Cleanup

### Route conflict resolution
- [x] Removed the duplicate conflicting account frame page route to avoid Next.js pathname collisions

### Public/share presentation polish
- [x] Public frame headers were enriched with workspace attribution
- [x] Shared/public wording and badges were polished for consistency

### Cosmetic parity polish
- [x] Final cosmetic pass completed across:
  - [apps/web/modules/saas/frames/components/FrameVizShell.tsx](../../apps/web/modules/saas/frames/components/FrameVizShell.tsx)
  - [apps/web/modules/saas/frames/components/FrameToolResultCard.tsx](../../apps/web/modules/saas/frames/components/FrameToolResultCard.tsx)
  - [apps/web/modules/saas/frames/components/FramePreviewSheet.tsx](../../apps/web/modules/saas/frames/components/FramePreviewSheet.tsx)
  - [apps/web/modules/saas/agents/components/WorkspacePanel/WorkspacePanel.tsx](../../apps/web/modules/saas/agents/components/WorkspacePanel/WorkspacePanel.tsx)

---

## Validation Summary

### Type-checks
- [x] `pnpm --filter web type-check`
- [x] `pnpm --filter @repo/api type-check`
- [x] `pnpm --filter @repo/database type-check`
- [x] `pnpm --filter @repo/temporal type-check`

### Targeted tests
- [x] `packages/database/__tests__/frames.test.ts`
- [x] `packages/temporal/__tests__/frame-service.test.ts`
- [x] `pnpm --filter @repo/temporal test -- new-tools`
- [x] `pnpm --filter @repo/temporal test -- built-in-capability-mapping`

### Formatting / linting
- [x] Biome clean on the focused changed files involved in the Frames parity work
- [ ] Full-file Biome cleanliness for `apps/web/modules/saas/ai/components/CopilotPage.tsx` remains blocked by **pre-existing unrelated diagnostics** outside the Frame work

---

## Known Non-Blocking Follow-Ups
- [ ] Restart Temporal worker if/when the appropriate restart tooling is available in session contexts where Temporal runtime changes need to be reloaded manually
- [ ] Optional future polish: tiny visual/copy deltas can still be iterated, but the core first-class Frame parity work is complete

---

## End-State Verdict

### Frames in Fabric are now:
- [x] first-class
- [x] shareable
- [x] embeddable
- [x] slideshow-capable
- [x] chat-native
- [x] workspace-visible
- [x] agent-accessible
- [x] much closer to `fabric-pro` parity than the original blob/file-based implementation

### Practical conclusion
The pre-existing blob-style frame behavior has been replaced by a first-class Frame system with dedicated data modeling, APIs, runtime tools, viewer surfaces, embed protocol, sharing, chat rendering, workspace integration, and final cosmetic polish.
