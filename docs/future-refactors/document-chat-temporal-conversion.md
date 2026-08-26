# Future Refactor: Convert Document Editor Chat from CopilotKit to Temporal

## Status: Planned (not started)

## Problem

The document editor's AI Assistant chat uses CopilotKit with AG-UI SSE protocol. The request flows through Vercel as a proxy to the Azure Container App agent. While `maxDuration = 800` (13 min) was added as a quick fix, this has limitations:

- **Hard ceiling**: If agents grow more complex (more tool calls, larger documents), the 800s limit can be exceeded
- **No reconnection**: CopilotKit doesn't support async/background execution or reconnecting to in-progress streams ([CopilotKit #2059](https://github.com/CopilotKit/CopilotKit/issues/2059))
- **No durability**: If the browser disconnects, all progress is lost
- **Scalability**: Each active chat holds a Vercel function open for the full duration, consuming compute

## Solution: Temporal Workflow

Convert to the same pattern used by the Fabric AI Orchestrator: Temporal workflow + Redis pub/sub + SSE polling.

### Architecture

**Current:**
```
Browser (CopilotKit hooks)
  → POST /api/copilotkit (Vercel SSE proxy, up to 800s)
    → Azure Container App (LangGraph agent)
```

**Proposed:**
```
Browser (custom hook)
  → POST /api/agents/document-chat/stream (Vercel, starts workflow + returns SSE)
    → Temporal Workflow (durable, no timeout)
      → Activity calls LangGraph agent container
      → Activity publishes text/document deltas to Redis
    → Redis pub/sub → SSE route → Browser (real-time streaming)
    → Temporal Signal ← Browser (confirm/reject changes)
```

The Vercel SSE route only needs to stay alive for polling + forwarding Redis events. If it disconnects, the frontend reconnects by passing `executionId` — the Temporal workflow is unaffected.

## Implementation Details

### New Files

#### 1. Temporal Workflow: `packages/temporal/src/workflows/document-chat.ts`

Simple single-activity workflow for one conversational turn:

- **Signals**: `confirmChanges({ accepted: boolean })`, `cancel`
- **Queries**: `progress` (phase), `status`, `documentContent`
- **Flow**: Call activity → if document changed → wait for confirm signal → return result

Input includes: `executionId`, `message`, `history[]`, `userId`, `organizationId`, `projectId`, `documentId`, `documentType`, `currentDocument`, `ragContexts[]`, `projectContext`, integration flags, `aiToken`, `systemPrompt`

#### 2. Activity: `packages/temporal/src/activities/document-chat/generate.ts`

Calls the existing LangGraph agent container and streams results via Redis:

1. Build agent input state (messages, document, contexts)
2. Call agent container via `@langchain/langgraph-sdk` Client `/runs/stream`
3. Publish events to Redis channel `execution:{executionId}`:
   - `execution.text_delta` — chat response text
   - `execution.document_delta` — document content (from `write_document_local`)
   - `execution.tool_start/complete` — tool execution indicators
4. Return `{ document, chatResponse, hasChanges }`

Reuse: `packages/temporal/src/lib/redis-publisher.ts` (`publishExecutionEvent`)

#### 3. SSE Stream Route: `apps/web/app/api/agents/document-chat/stream/route.ts`

Pattern from orchestrator (`apps/web/app/api/agents/fabric-ai/orchestrator-temporal/stream/route.ts`), simplified:

- Auth, project access, AI token issuance
- Subscribe Redis before starting workflow
- Poll Temporal queries every 200ms
- Forward Redis events as SSE
- Support `executionId` for reconnection

SSE event types: `started`, `phase`, `text_delta`, `document_delta`, `tool_activity`, `confirm_required`, `completed`, `error`

#### 4. Signal Route: `apps/web/app/api/agents/document-chat/signal/route.ts`

POST handler: authenticate → get workflow handle → validate ownership → send signal

#### 5. Frontend Hook: `apps/web/modules/saas/projects/hooks/useDocumentChatStream.ts`

Simplified `useOrchestratorStream` for document chat:

- State: `messages`, `isStreaming`, `streamingDocument`, `streamingText`, `phase`, `executionId`, `confirmState`
- Methods: `sendMessage()`, `confirmChanges()`, `cancel()`, `reset()`

#### 6. Chat Sidebar: `apps/web/modules/saas/projects/components/DocumentChatSidebar.tsx`

Simple chat panel using AI element components from `apps/web/components/ai-elements/`.

### Files to Modify

- `packages/temporal/src/types.ts` — add `DocumentChatWorkflowInput`/`Output`
- `apps/web/modules/saas/projects/components/DocumentEditor.tsx` — replace CopilotKit hooks with `useDocumentChatStream`
- `apps/web/modules/saas/projects/components/DocumentEditorPage.tsx` — remove `<CopilotKit>` provider

### Frontend Action Migration

| CopilotKit Action | Temporal Approach |
|---|---|
| `confirm_changes` | Temporal `confirmChanges` signal via hook |
| `regenerate_document` | Already uses Temporal (`projectDocumentGenerationWorkflow`) |
| `select_meetings` / `fetchMeetingNotes` | Pre-loaded as RAG context; agent's server-side `search_teams_messages` tool |
| `github_get_file_contents` | Convert to server-side tool in agent's `tool-node.ts` |
| `github_list_pull_requests` | Convert to server-side tool in agent's `tool-node.ts` |
| `github_list_issues` | Convert to server-side tool in agent's `tool-node.ts` |
| `suggest_diagram` | Client-side: parse agent response for Mermaid blocks |

### Agent Container

**No changes needed.** The LangGraph agent container (`agents/langchain/project-document-generator/`) already supports both AG-UI (CopilotKit) and LangGraph Platform API protocols via `unified-server.ts`. The Temporal activity uses the Platform API path (`/runs/stream`).

### Key Patterns to Reuse

| Pattern | Source File |
|---------|------------|
| SSE + Temporal polling + Redis | `apps/web/app/api/agents/fabric-ai/orchestrator-temporal/stream/route.ts` |
| Redis event publishing | `packages/temporal/src/lib/redis-publisher.ts` |
| Frontend SSE consumption | `apps/web/modules/saas/agents/hooks/useOrchestratorStream.ts` |
| Temporal-based chat UI | `apps/web/modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx` |
| AI element components | `apps/web/components/ai-elements/` (Message, Conversation, etc.) |
| AI token issuance | `packages/ai-token/` (`issueAIToken`) |

## Risks

1. **Agent CopilotKit state undefined**: The agent's state uses `CopilotKitStateAnnotation`. When called from Temporal (without CopilotKit), `copilotkit.actions` will be undefined. The agent already handles this with optional chaining — needs testing.

2. **Streaming granularity**: CopilotKit's predictive state updates stream character-by-character. The Temporal activity reads the agent's SSE via LangGraph SDK — granularity is token-by-token, which is comparable.

3. **GitHub actions unavailable in v1**: Users who use "fetch GitHub file" in chat will lose this until server-side tools are added.

## Estimated Scope

- ~6 new files, ~3 modified files
- Backend (Temporal + routes): ~2 days
- Frontend (hook + sidebar + DocumentEditor changes): ~2 days
- Testing + polish: ~1 day
