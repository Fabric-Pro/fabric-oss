# Document Editor Streaming Pattern with Diff Highlighting

This document describes the canonical streaming pattern for document editors that use CopilotKit with diff highlighting and confirmation dialogs. **This pattern is critical and must be followed exactly** to ensure proper diff highlighting and user confirmation flows.

## Overview

The streaming pattern enables real-time document updates from AI agents with visual diff highlighting (green for additions, red strikethrough for deletions) and user confirmation before changes are applied.

## Components Using This Pattern

1. **Document Generator** - `/app/agents/document-generator`
   - File: `apps/web/app/(saas)/app/agents/document-generator/page.tsx`
   - Agent: `document_generator`

2. **Project Document Editor** - `/app/projects/[projectId]/documents/[documentId]`
   - File: `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
   - Agent: `project_document_generator`

3. **Prompt Content Enhancer** - Prompt editing with AI assistance
   - File: `apps/web/modules/saas/prompts/components/PromptContentEnhancer.tsx`
   - Agent: `prompt_enhancer`

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React)                               │
├─────────────────────────────────────────────────────────────────────────┤
│  TipTap Editor ←→ useCoAgent ←→ useCopilotAction (confirm_changes)      │
│       ↓                ↓                    ↓                            │
│  currentDocument   agentState.document   renderAndWaitForResponse       │
│  (baseline)        (streaming)           (Accept/Reject UI)             │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↕
┌─────────────────────────────────────────────────────────────────────────┐
│                        AGENT (LangGraph)                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  1. User message → chatNode                                              │
│  2. Agent calls write_document_local tool (streams via predict_state)   │
│  3. Agent adds confirm_changes tool call to messages                     │
│  4. Graph ends → Frontend renders confirmation dialog                    │
│  5. User Accept/Reject → respond({ accepted: true/false })              │
│  6. Agent receives response → returns static message (NO tool calls!)   │
└─────────────────────────────────────────────────────────────────────────┘
```

## The Four Effects Pattern

The streaming pattern consists of exactly **four React effects** that must be implemented in this order:

### Effect 1: Capture Baseline

Captures the current editor content as a baseline when `isLoading` becomes true.

```typescript
useEffect(() => {
  if (isLoading) {
    setCurrentDocument(getEditorMarkdownForSave(editor));
  }
  editor?.setEditable(!isLoading);
}, [isLoading, editor]);
```

**Key Points:**
- Use `getEditorMarkdownForSave(editor)` to get markdown (preserves formatting)
- Disable editor editing during loading
- `currentDocument` becomes the baseline for diff comparison

### Effect 2: Final Diff on Completion

Shows the final diff with `isComplete=true` when the agent finishes (`nodeName === "end"`).

```typescript
useEffect(() => {
  if (nodeName === "end") {
    if (currentDocument.trim().length > 0 && currentDocument !== agentState?.document) {
      const newDocument = agentState?.document || "";
      const diff = diffPartialText(currentDocument, newDocument, true);
      const markdown = fromMarkdown(diff);
      editor?.commands.setContent(markdown);
    }
  }
}, [nodeName]);
```

**Key Points:**
- Only runs when `nodeName === "end"`
- Uses `isComplete=true` in `diffPartialText()` to show full deletions
- Compares `currentDocument` (baseline) with `agentState?.document` (new content)

### Effect 3: Streaming Diff Updates

Shows incremental diffs as `agentState.document` streams in.

```typescript
useEffect(() => {
  if (isLoading) {
    const newDocument = agentState?.document || "";

    // Skip if content is empty or unchanged from baseline
    if (newDocument.trim().length === 0 || newDocument === currentDocument) {
      return;
    }

    if (currentDocument.trim().length > 0) {
      const diff = diffPartialText(currentDocument, newDocument);
      const markdown = fromMarkdown(diff);
      editor?.commands.setContent(markdown);
    } else {
      const markdown = fromMarkdown(newDocument);
      editor?.commands.setContent(markdown);
    }
  }
}, [agentState?.document]);
```

**Key Points:**
- Only runs during `isLoading`
- Skips empty content to prevent "red flash" (all content showing as deleted)
- Skips unchanged content to prevent "highlight flash"
- Uses `isComplete=false` (default) for partial streaming

### Effect 4: Sync Editor to State

Syncs editor content back to state when not loading (user editing).

```typescript
const editorDocRef = editor?.state?.doc;
useEffect(() => {
  if (!isLoading && editor) {
    const editorMarkdown = getEditorMarkdownForSave(editor);
    setCurrentDocument(editorMarkdown);
    setAgentState({ document: editorMarkdown });
  }
}, [editorDocRef, isLoading]);
```

**Key Points:**
- Runs when `!isLoading` (user is editing)
- Uses `editorDocRef` to track document changes
- Keeps `currentDocument` and `agentState.document` in sync

## Diff Highlighting

### The `diffPartialText` Function

Located in `apps/web/modules/saas/projects/lib/diff-utils.ts`:

```typescript
export function diffPartialText(
  oldText: string,
  newText: string,
  isComplete = false,
): string {
  // Truncate oldText during streaming to avoid false deletions
  let oldTextToCompare = oldText;
  if (oldText.length > newText.length && !isComplete) {
    oldTextToCompare = oldText.slice(0, newText.length);
  }

  const changes = diffWords(oldTextToCompare, newText);

  let result = "";
  changes.forEach((part) => {
    if (part.added) {
      result += `<em>${part.value}</em>`;      // Green highlight
    } else if (part.removed) {
      result += `<s>${part.value}</s>`;        // Red strikethrough
    } else {
      result += part.value;
    }
  });

  // Append trailing old content during streaming
  if (oldText.length > newText.length && !isComplete) {
    result += oldText.slice(newText.length);
  }

  return result;
}
```

### CSS Styling

The diff tags are styled in `DocumentEditor.css` and `PromptContentEnhancer.css`:

```css
/* Additions - green background */
.tiptap em {
  background-color: #b2f2bb;
  padding: 2px;
  font-weight: bold;
  font-style: normal;
}

/* Deletions - red background with strikethrough */
.tiptap s {
  background-color: #f9818150;
  padding: 2px;
  font-weight: bold;
  color: rgba(0, 0, 0, 0.7);
  text-decoration: line-through;
}

/* Dark mode variants */
.dark .tiptap em {
  background-color: rgba(34, 197, 94, 0.4);
  color: rgba(255, 255, 255, 0.95);
}

.dark .tiptap s {
  background-color: rgba(239, 68, 68, 0.4);
  color: rgba(255, 255, 255, 0.9);
}
```

## Confirmation Dialog Pattern

### Frontend Implementation

```typescript
useCopilotAction(
  {
    name: "confirm_changes",
    renderAndWaitForResponse: ({ args, respond, status }) => (
      <ConfirmChanges
        args={args}
        respond={respond}
        status={status}
        onReject={() => {
          editor?.commands.setContent(fromMarkdown(currentDocument));
          setAgentState({ document: currentDocument });
        }}
        onConfirm={() => {
          const newDoc = agentState?.document || "";
          editor?.commands.setContent(fromMarkdown(newDoc));
          setCurrentDocument(newDoc);
          setAgentState({ document: newDoc });
        }}
      />
    ),
  },
  [agentState?.document],
);
```

### ConfirmChanges Component

```typescript
function ConfirmChanges({ respond, status, onReject, onConfirm }: ConfirmChangesProps) {
  const [accepted, setAccepted] = useState<boolean | null>(null);

  // Hide if status is not "executing" and no choice made (stale component)
  if (status !== "executing" && accepted === null) {
    return null;
  }

  return (
    <div className="...">
      <h2>Confirm Changes</h2>
      <p>Do you want to accept the changes?</p>
      {accepted === null && (
        <div className="flex justify-end space-x-4">
          <button onClick={() => {
            setAccepted(false);
            onReject();
            respond({ accepted: false });
          }}>Reject</button>
          <button onClick={() => {
            setAccepted(true);
            onConfirm();
            respond({ accepted: true });
          }}>Confirm</button>
        </div>
      )}
      {accepted !== null && (
        <div>{accepted ? "✓ Accepted" : "✗ Rejected"}</div>
      )}
    </div>
  );
}
```

### Backend Agent Pattern

The agent must return a **static message** after confirmation (NO LLM call):

```typescript
// In chat-node.ts
function isPostConfirmation(messages: any[]): boolean {
  const lastMsg = messages[messages.length - 1];
  const msgType = getMessageType(lastMsg);
  
  if (msgType === "human") return false;  // New request
  if (msgType === "tool") {
    const content = typeof lastMsg.content === "string" 
      ? lastMsg.content 
      : JSON.stringify(lastMsg.content);
    return content?.includes("accepted");
  }
  return false;
}

// In the main handler
if (isPostConfirmation(state.messages)) {
  const accepted = /* parse from last message */;
  return new Command({
    goto: END,
    update: {
      messages: [...state.messages, {
        role: "assistant",
        content: accepted 
          ? "Requested changes have been completed!"
          : "Changes have been discarded.",
      }],
    },
  });
}
```

## Common Pitfalls - DO NOT DO THESE

### 1. ❌ Do NOT add complex ref guards

The pattern should be simple. Do NOT add refs like `awaitingConfirmationRef` or `postConfirmationRef` that complicate the flow:

```typescript
// ❌ BAD - overly complex
if (!isLoading && !postConfirmationRef.current && !awaitingConfirmationRef.current) {
  // sync...
}

// ✅ GOOD - simple
if (!isLoading && editor) {
  // sync...
}
```

### 2. ❌ Do NOT skip sync effect based on loading ending

```typescript
// ❌ BAD - causes race conditions
useEffect(() => {
  if (!isLoading && prevIsLoading) {  // "loading just ended"
    // This runs BEFORE confirm dialog can be interacted with
  }
}, [isLoading]);
```

### 3. ❌ Do NOT call LLM after confirmation

```typescript
// ❌ BAD - calling LLM for summary
if (afterConfirmation) {
  const response = await model.invoke([...messages]);  // May call tools!
}

// ✅ GOOD - static message
if (afterConfirmation) {
  return { content: "Changes completed!" };  // No LLM call
}
```

### 4. ❌ Do NOT use `editor.getText()` for baseline

```typescript
// ❌ BAD - loses formatting
setCurrentDocument(editor?.getText() || "");

// ✅ GOOD - preserves markdown formatting
setCurrentDocument(getEditorMarkdownForSave(editor));
```

### 5. ❌ Do NOT use `fromMarkdown()` for raw text diff display

```typescript
// ❌ BAD - adds HTML paragraph tags to raw text
<div dangerouslySetInnerHTML={{ __html: fromMarkdown(displayContent) }} />

// ✅ GOOD - for raw text, use diff HTML directly
<div dangerouslySetInnerHTML={{ __html: displayContent }} />
```

## Testing Checklist

When modifying any document editor, verify:

1. ✅ **Streaming works**: Send a message → See green highlights appearing
2. ✅ **Diff is correct**: Additions are green, deletions are red strikethrough
3. ✅ **No "all red" bug**: Content doesn't show entirely as deleted
4. ✅ **Confirm dialog appears**: After streaming completes, dialog shows
5. ✅ **Accept works**: Click Accept → Content saved, diff cleared
6. ✅ **Reject works**: Click Reject → Original content restored
7. ✅ **Follow-up works**: After accept/reject, can send new message
8. ✅ **Static message**: After accept/reject, agent shows static message (not LLM response)

## Reference Implementation

The canonical reference is the standalone document generator:

**File:** `apps/web/app/(saas)/app/agents/document-generator/page.tsx`

This file contains the simplest, most reliable implementation of the pattern. When in doubt, compare against this file.

## Related Files

- `apps/web/modules/saas/projects/lib/diff-utils.ts` - Diff functions
- `apps/web/modules/saas/projects/components/DocumentEditor.css` - Diff styling
- `agents/langchain/document-generator/nodes/chat-node.ts` - Agent implementation
- `agents/langchain/project-document-generator/nodes/chat-node.ts` - Project agent
- `agents/langchain/prompt-enhancer/nodes/enhance-node.ts` - Prompt agent
