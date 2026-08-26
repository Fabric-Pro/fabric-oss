# Document Processing

Real-time document generation and streaming architecture using AG-UI protocol.

- **Audience**: Frontend/AI developers
- **Owner**: Document team

---

## Architecture

```
User (Chat Sidebar)
  -> CopilotKit (useCopilotChat)
    -> LangGraph Agent (TypeScript)
      -> Predictive State Updates (AG-UI protocol)
        -> Channel 1: agentState.document -> TipTap Editor (diff highlighting)
        -> Channel 2: response.content -> Sidebar Messages (conversation)
      -> Confirmation Dialog (accept/reject changes)
```

## Key Technologies

| Component | Technology | Purpose |
|-----------|------------|---------|
| Frontend UI | React + TipTap | Rich text editor with markdown |
| Chat Integration | CopilotKit | `useCoAgent`, `useCopilotChat`, `useCopilotAction` |
| Backend Agent | LangGraph (TypeScript) | State graph with predictive state |
| Protocol | AG-UI | Real-time state streaming via `predict_state` |
| Diff Library | `diff` (npm) | Word-level diff comparison |

## Two-Channel Streaming

### Channel 1: Predictive State -> Editor

Agent configures `predict_state` to map tool arguments to state keys:

```typescript
config.metadata.predict_state = [{
    state_key: "document",
    tool: "write_document_local",
    tool_argument: "document",
}];
```

Frontend consumes via `useCoAgent`:

```typescript
const { state: agentState } = useCoAgent<AgentState>({
    name: "document_generator",
    initialState: { document: "" },
});
```

### Channel 2: response.content -> Sidebar

Model generates conversational text (summaries, follow-ups) in `response.content`, which appears as assistant messages in the CopilotKit sidebar.

## Diff Highlighting

- Additions shown as `<em>` (green background)
- Deletions shown as `<s>` (red background)
- CSS class `streaming-diff-active` applied to editor container during streaming
- Baseline captured via ref (not state) to avoid race conditions

## Editor Implementations

| Editor | Location | Context |
|--------|----------|---------|
| `DocumentGeneratorEditor` | `modules/saas/agents/components/` | Standalone document generator |
| `DocumentEditor` | `modules/saas/projects/components/` | Project documents (includes TipTap table handling) |

Both use the same 4-effect streaming pattern documented in `docs/DOCUMENT_EDITOR_STREAMING_PATTERN.md`.

## Supported Document Types

General, PRD, Proposal, Architecture, Technical Spec, User Story, API Spec

## Features

- Database-stored templates with version history
- RAG integration for context from uploaded documents
- Real-time streaming with diff highlighting
- Export to PDF, DOCX, Markdown
- MCP integration for external data (Linear, GitHub)
