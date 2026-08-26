# Vercel AI SDK Elements Integration Design

## Overview

This document outlines the integration strategy for Vercel AI SDK Elements into Fabric Portal's Direct Chat and Orchestrator modes. The AI Elements library provides production-ready UI components for building AI-native applications.

## Current State

Fabric Portal already has all AI Elements components installed at `apps/web/components/ai-elements/`:

- `artifact.tsx` - Code/content artifact display
- `chain-of-thought.tsx` - Step-by-step reasoning display
- `checkpoint.tsx` - Conversation state checkpoints
- `code-block.tsx` - Syntax-highlighted code blocks
- `confirmation.tsx` - User confirmation dialogs
- `context.tsx` - Context display component
- `conversation.tsx` - Chat conversation container
- `inline-citation.tsx` - In-text citations
- `message.tsx` - Message bubbles
- `model-selector.tsx` - AI model picker
- `plan.tsx` - Multi-step plan display
- `prompt-input.tsx` - Rich input with attachments
- `queue.tsx` - Request queue management
- `reasoning.tsx` - AI reasoning display
- `response.tsx` - Response container
- `shimmer.tsx` - Loading shimmer effect
- `sources.tsx` - Source attribution
- `suggestion.tsx` - Quick suggestions
- `task.tsx` - Task status tracking
- `tool.tsx` - Tool call visualization

## Elements Evaluation

### 1. Chain of Thought (`chain-of-thought.tsx`)

**Purpose**: Display step-by-step reasoning from AI models with extended thinking capabilities.

**Applicability**:
- **Direct Mode**: ✅ High priority - Shows reasoning when using Claude models with thinking enabled
- **Orchestrator Mode**: ✅ Medium priority - Can show orchestrator's task decomposition reasoning

**Backend Requirements**:
- Enable `thinking` option for Claude models in AI Gateway
- Stream reasoning parts: `reasoning-start`, `reasoning-delta`, `reasoning-end`
- Store reasoning in message parts for history replay

**Integration Pattern**:
```tsx
{message.parts.map((part) => {
  if (part.type === 'reasoning') {
    return <ChainOfThought>{part.text}</ChainOfThought>;
  }
})}
```

---

### 2. Checkpoint (`checkpoint.tsx`)

**Purpose**: Save and restore conversation state at specific points.

**Applicability**:
- **Direct Mode**: ✅ Useful for branching conversations
- **Orchestrator Mode**: ✅ Critical for workflow checkpoints and rollback

**Backend Requirements**:
- Store checkpoint metadata in conversation history
- Support message slicing for restore operations
- Track checkpoint branches in database

**Integration Pattern**:
```tsx
<Checkpoint>
  <CheckpointIcon />
  <CheckpointTrigger onClick={() => restoreToCheckpoint(index)}>
    Restore checkpoint
  </CheckpointTrigger>
</Checkpoint>
```

---

### 3. Context (`context.tsx`)

**Purpose**: Display contextual information passed to AI (RAG documents, memory, etc.)

**Applicability**:
- **Direct Mode**: ✅ High priority - Show RAG document context
- **Orchestrator Mode**: ✅ Show gathered research context

**Backend Requirements**:
- Return context sources in response metadata
- Include document titles and snippets

**Integration Pattern**:
```tsx
<Context title="Document Context">
  {ragContext.map((doc) => (
    <ContextItem key={doc.id} title={doc.filename}>
      {doc.snippet}
    </ContextItem>
  ))}
</Context>
```

---

### 4. Conversation (`conversation.tsx`)

**Purpose**: Container for chat messages with scroll management.

**Applicability**:
- **Direct Mode**: ✅ Already partially used
- **Orchestrator Mode**: ✅ Already partially used

**Status**: Can enhance current implementation with `ConversationScrollButton` and `ConversationEmptyState`.

---

### 5. Inline Citation (`inline-citation.tsx`)

**Purpose**: Display numbered citations within AI response text.

**Applicability**:
- **Direct Mode**: ✅ When RAG context is used
- **Orchestrator Mode**: ✅ When research sources are cited

**Backend Requirements**:
- AI must format citations as numbered references
- Return source URLs with responses
- Parse `source-url` parts from message

**Integration Pattern**:
```tsx
{part.type === 'source-url' && (
  <InlineCitation index={i} href={part.url} />
)}
```

---

### 6. Plan (`plan.tsx`)

**Purpose**: Display multi-step execution plans with status indicators.

**Applicability**:
- **Direct Mode**: ❌ Not applicable (single-step execution)
- **Orchestrator Mode**: ✅ Critical - Show task decomposition

**Backend Requirements**:
- Return plan steps from orchestrator
- Stream step status updates
- Track step completion in workflow

**Integration Pattern**:
```tsx
<Plan>
  {steps.map((step) => (
    <PlanStep
      key={step.id}
      status={step.status}
      title={step.description}
    />
  ))}
</Plan>
```

---

### 7. Queue (`queue.tsx`)

**Purpose**: Display queued requests and their status.

**Applicability**:
- **Direct Mode**: ❌ Low priority (single requests)
- **Orchestrator Mode**: ✅ Show pending agent delegations

**Backend Requirements**:
- Track queued workflow steps
- Return queue position updates

---

### 8. Sources (`sources.tsx`)

**Purpose**: Collapsible source attribution panel.

**Applicability**:
- **Direct Mode**: ✅ High priority - Show RAG document sources
- **Orchestrator Mode**: ✅ Show research sources

**Backend Requirements**:
- Return `source-url` parts in message
- Include source titles and URLs

**Integration Pattern**:
```tsx
<Sources>
  <SourcesTrigger count={sources.length} />
  <SourcesContent>
    {sources.map((source) => (
      <Source key={source.url} href={source.url} title={source.title} />
    ))}
  </SourcesContent>
</Sources>
```

---

### 9. Task (`task.tsx`)

**Purpose**: Display individual task status with progress.

**Applicability**:
- **Direct Mode**: ✅ Show tool execution status
- **Orchestrator Mode**: ✅ Critical - Show workflow step status

**Backend Requirements**:
- Stream task status updates
- Include task metadata (name, description, progress)

**Integration Pattern**:
```tsx
<Task status={task.status}>
  <TaskIcon />
  <TaskContent>
    <TaskTitle>{task.name}</TaskTitle>
    <TaskDescription>{task.description}</TaskDescription>
  </TaskContent>
</Task>
```

---

## Implementation Priority Matrix

| Element | Direct Mode | Orchestrator Mode | Priority | Effort |
|---------|-------------|-------------------|----------|--------|
| Sources | ✅ High | ✅ High | P0 | Low |
| Context | ✅ High | ✅ High | P0 | Low |
| Task | ✅ Medium | ✅ Critical | P1 | Medium |
| Chain of Thought | ✅ High | ✅ Medium | P1 | Medium |
| Plan | ❌ N/A | ✅ Critical | P1 | Medium |
| Inline Citation | ✅ Medium | ✅ Medium | P2 | Low |
| Checkpoint | ✅ Medium | ✅ High | P2 | High |
| Queue | ❌ Low | ✅ Medium | P3 | Low |
| Conversation | Already used | Already used | Done | - |

---

## Phase 1 Implementation (P0 - Immediate)

### 1.1 Sources Component for RAG

Integrate `Sources` component to display document sources when RAG context is used.

**Files to modify**:
- `apps/web/modules/saas/agents/components/FabricChat/FabricDirectChat.tsx`
- `packages/temporal/src/activities/direct-chat-activities.ts` (return sources metadata)

**Backend changes**:
- Return source metadata from `retrieveRagContextForDirectChatActivity`:
  ```typescript
  return {
    context: formattedContext,
    chunkCount: chunks.length,
    sources: chunks.map(c => ({
      documentId: c.metadata.documentId,
      filename: c.metadata.filename,
      pageNumber: c.metadata.pageNumber,
    })),
  };
  ```

### 1.2 Context Component for RAG Preview

Show users what context was injected into the AI request.

**Integration**:
- Add collapsible context panel above AI response
- Show document names and relevant snippets

---

## Phase 2 Implementation (P1 - Next Sprint)

### 2.1 Task Component for Tool Calls

Replace custom tool call rendering with `Task` component.

### 2.2 Chain of Thought for Reasoning Models

Enable reasoning display when using Claude 3.5/4 with thinking enabled.

### 2.3 Plan Component for Orchestrator

Display orchestrator's task decomposition as a visual plan.

---

## Phase 3 Implementation (P2 - Future)

### 3.1 Inline Citations

Add numbered citations to AI responses that reference RAG documents.

### 3.2 Checkpoints

Enable conversation branching and state restoration.

---

## AI Model Requirements

| Element | Model Requirement |
|---------|-------------------|
| Chain of Thought | Claude 3.5+ with `thinking: { type: 'enabled' }` |
| Reasoning | Any model with reasoning output |
| Sources | Models with web search or RAG |
| Inline Citation | Requires prompt engineering for citation format |

---

## Conclusion

The AI SDK Elements are already installed and ready for integration. The highest priority items are:

1. **Sources** - Immediately useful for RAG document attribution
2. **Context** - Shows users what context was provided to AI
3. **Task** - Better tool call visualization
4. **Plan** - Critical for Orchestrator mode visibility

Implementation should proceed in phases, starting with Sources and Context which require minimal backend changes.

