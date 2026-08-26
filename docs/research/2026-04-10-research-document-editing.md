# Editing large documents with LLMs in Next.js

**The most effective architecture for LLM-powered large document editing follows a "search-then-edit" pipeline: split documents into section-indexed chunks, use hybrid search to locate edit targets, provide the LLM with a compressed document outline plus the full target section, and generate minimal diffs rather than full rewrites.** This approach reduces token costs by up to 86%, avoids context window limits entirely, and enables surgical edits that preserve document consistency. For a Next.js stack with CopilotKit and LangChain, the recommended implementation pairs CopilotKit's `useCopilotAction` for frontend orchestration with a LangGraph agent backend that coordinates chunking, retrieval, editing, and verification through a stateful workflow graph.

---

## The core architecture: search, edit, verify

Large document editing fundamentally differs from RAG retrieval. In RAG, you extract information; in editing, you must modify content in place while preserving surrounding structure, cross-references, and stylistic consistency. The architecture that handles this best decomposes into five stages:

**Stage 1 — Document ingestion and indexing.** Parse the document into a section tree using heading-based boundaries. Assign each section a stable ID, generate embeddings, and store them in a vector database alongside rich metadata (heading level, parent chain, position, word count). Cache a lightweight document outline/TOC for structural context.

**Stage 2 — Edit target location.** When a user requests an edit (e.g., "update the Phase 2 timeline"), use **hybrid search** combining dense vector similarity with sparse keyword matching (BM25) to find the relevant section(s). Pure semantic search can miss exact terms; hybrid search with Reciprocal Rank Fusion scoring fixes this. Metadata filtering narrows candidates by heading level or parent section before vector comparison.

**Stage 3 — Context assembly.** Build the LLM prompt using a **hierarchical context strategy**: document outline at the top (structural awareness), one-paragraph summaries of adjacent sections (continuity), and the full target section at the bottom (best attention position due to the "lost-in-the-middle" phenomenon). This keeps context usage minimal while giving the LLM enough information for coherent edits.

**Stage 4 — Edit generation.** The LLM generates edits in a **search/replace format** (`old_str`/`new_str` pairs) rather than rewriting the entire section. This approach, validated by Notion's production API and Aider's edit system, makes edits deterministic to apply, trivially verifiable, and easy to undo. For larger section rewrites, full section replacement with the section ID works reliably.

**Stage 5 — Verification and application.** Parse the edited content for structural validity. Check cross-references against a dependency graph. Optionally run an LLM verification pass comparing the edit against the document outline for semantic consistency. Update embeddings only for modified sections.

---

## Chunking strategies that preserve editability

Chunking for editing demands different trade-offs than chunking for RAG. Each chunk must map cleanly back to a specific document location, maintain structural boundaries, and enable reassembly after modification.

**The two-stage splitter is the recommended approach.** First, use LangChain's `MarkdownHeaderTextSplitter` to split at heading boundaries (`#`, `##`, `###`), preserving the document's hierarchical structure in metadata. Then, for any sections that exceed the target chunk size, apply `RecursiveCharacterTextSplitter` with a generous overlap (200 tokens) to subdivide while maintaining context at boundaries. This combination produces chunks that respect semantic boundaries and stay within token limits:

```typescript
import { MarkdownHeaderTextSplitter } from "@langchain/textsplitters";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const headerSplitter = new MarkdownHeaderTextSplitter({
  headersToSplitOn: [["#", "H1"], ["##", "H2"], ["###", "H3"]],
  stripHeaders: false, // Keep headers for editing context
});
const headerSplits = await headerSplitter.splitText(markdownDocument);

const charSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 2000,
  chunkOverlap: 200,
});
const finalSplits = await charSplitter.splitDocuments(headerSplits);
```

Each chunk inherits header metadata (`{ "H1": "Requirements", "H2": "Timeline" }`) and tracks its position for reassembly. **Store original character offsets in metadata** to enable precise replacement after editing.

For documents with complex cross-references (common in PRDs), build a **dependency graph** at index time mapping terms and section references to all locations where they appear. After any edit, traverse this graph to flag potentially affected sections for consistency review.

The **chopdiff library** (github.com/jlevy/chopdiff) offers a sophisticated sliding-window approach specifically designed for LLM editing: it uses word-level diffs, overlapping windows with configurable shift and minimum overlap, and diff filtering that accepts only specific types of changes to prevent unwanted modifications.

---

## CopilotKit patterns for document editing workflows

CopilotKit's architecture maps cleanly onto document editing through three complementary mechanisms: state exposure, action definition, and agent integration.

**Exposing document state with `useCopilotReadable`.** This hook makes document structure visible to the AI. For large documents, expose a compressed representation — the outline with section IDs and headings — rather than full content, to stay within the context provided to the copilot:

```typescript
useCopilotReadable({
  description: "Document structure with section IDs and headings",
  value: JSON.stringify({
    title: document.title,
    sections: document.sections.map(s => ({
      id: s.id, heading: s.heading, level: s.level,
      wordCount: s.content.split(' ').length
    }))
  })
});
```

**Defining editing actions with `useCopilotAction`.** This is where the surgical editing pattern lives. Define granular actions — `editSection`, `insertSection`, `deleteSection`, `reorderSections` — each with typed parameters via CopilotKit's schema system. The LLM invokes these actions with specific section IDs and content:

```typescript
useCopilotAction({
  name: "editSection",
  description: "Edit a specific section of the document by ID",
  parameters: [
    { name: "sectionId", type: "string", required: true },
    { name: "newContent", type: "string", required: true },
    { name: "editReason", type: "string", required: true },
  ],
  handler: async ({ sectionId, newContent, editReason }) => {
    setDocument(prev => ({
      ...prev,
      sections: prev.sections.map(s =>
        s.id === sectionId ? { ...s, content: newContent } : s
      ),
      editHistory: [...prev.editHistory, { sectionId, editReason, timestamp: Date.now() }]
    }));
  },
});
```

**Human-in-the-loop with `renderAndWait`.** For consequential edits, CopilotKit can pause execution and show a preview before applying changes. The `renderAndWait` property on actions renders a React component that the user must approve or reject, preventing unwanted modifications to critical document sections.

**CopilotKit's `CopilotTextarea`** provides AI-assisted autocompletion (similar to GitHub Copilot for prose), but it is **plain text only** — it does not support markdown or rich text formatting. For rich document editing, pair CopilotKit's hooks with a dedicated editor like BlockNote, Tiptap, or ProseMirror.

---

## LangGraph agent workflows replace legacy LangChain chains

**The legacy `MapReduceDocumentsChain` and `RefineDocumentsChain` classes are deprecated** as of LangChain 0.3.1. The modern replacement is LangGraph, which provides cyclic workflows, state persistence, conditional routing, and streaming — all essential for document editing.

A **LangGraph document editing workflow** structures as a state graph with nodes for splitting, identifying edit targets, applying edits, verifying results, and reassembling:

```typescript
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";

const EditState = Annotation.Root({
  sections: Annotation<Section[]>,
  editInstruction: Annotation<string>,
  currentIndex: Annotation<number>,
  editedSections: Annotation<Section[]>,
});

const graph = new StateGraph(EditState)
  .addNode("identify_targets", identifySectionsToEdit)
  .addNode("edit_section", editSectionWithLLM)
  .addNode("verify_edit", verifyEditConsistency)
  .addNode("reassemble", reassembleDocument)
  .addEdge(START, "identify_targets")
  .addEdge("identify_targets", "edit_section")
  .addEdge("edit_section", "verify_edit")
  .addConditionalEdges("verify_edit", (state) => {
    if (!state.verified && state.retries < 3) return "edit_section";
    if (state.currentIndex < state.targets.length - 1) return "edit_section";
    return "reassemble";
  })
  .addEdge("reassemble", END);
```

The key advantage of LangGraph over legacy chains is **conditional looping**: if verification fails, the graph routes back to the edit node for correction. This evaluate-then-retry pattern is critical for maintaining document quality.

**Custom tools defined with Zod schemas** give the LangGraph agent precise capabilities for navigating and editing documents:

```typescript
const readSection = tool(
  async ({ sectionId }) => {
    const section = await documentStore.getSection(sectionId);
    return JSON.stringify({ id: section.id, heading: section.heading, content: section.content });
  },
  { name: "read_section", description: "Read a specific document section",
    schema: z.object({ sectionId: z.string() }) }
);

const searchDocument = tool(
  async ({ query }) => {
    const results = await vectorStore.similaritySearch(query, 5);
    return JSON.stringify(results.map(r => ({ sectionId: r.metadata.sectionId, preview: r.pageContent.slice(0, 200) })));
  },
  { name: "search_document", description: "Semantic search across document sections",
    schema: z.object({ query: z.string() }) }
);
```

**CopilotKit integrates with LangGraph via `LangGraphHttpAgent`** in the `@copilotkit/runtime` package. The CoAgent pattern provides **bidirectional state synchronization** between the React frontend and the LangGraph backend — the agent can emit intermediate state via `copilotkit_emit_state()` in Python, and the frontend picks up these updates in real-time through `useCoAgent` or `useCoAgentStateRender`.

---

## The diff-based editing approach that cuts costs by 86%

The single most impactful optimization for large document editing is **generating minimal diffs instead of full content rewrites**. Waleed Kadous's "Edit Trick" (2025) demonstrated that requesting edits in sed-like format reduces output tokens by **86%**, speeds processing by **79%**, and cuts costs by **69%** with comparable quality.

Three proven diff formats work reliably with modern LLMs:

- **Search/Replace blocks** (used by Aider, Notion API): The LLM outputs `old_str`/`new_str` pairs that the application matches and replaces. Notion's production API implements exactly this pattern. The application layer handles matching with a fallback cascade: exact match → whitespace-insensitive → fuzzy matching via difflib.

- **Structured patches** (used by OpenAI Codex): Uses `@@` context markers with text-based anchoring (never line numbers — a critical design decision, since LLMs handle text context far more reliably than numeric line references). Context lines (space-prefixed) provide precise anchoring for changes.

- **Section replacement**: For larger rewrites, the LLM returns the complete new content for a specific section ID. Simpler to implement, though more token-intensive than search/replace for small edits.

**Aider's research found that high-level diffs outperform surgical line-by-line edits** — replacing entire semantic blocks (like paragraphs or subsections) produces 30–50% fewer errors than attempting character-level precision. This finding suggests that for PRD editing, operating at the section or paragraph level is the sweet spot.

For applying diffs programmatically in JavaScript, two battle-tested libraries serve well: **`diff-match-patch`** (Google's library, originally built for Google Docs) provides `diff_main()`, `patch_make()`, and `patch_apply()`, while **`jsdiff`** (~8.7M weekly npm downloads) offers `diffWords`, `diffLines`, `applyPatch`, and async mode for large documents.

---

## Context window management: the budget allocation framework

Treat the context window like a fixed budget where every token must justify its cost. For a document editing request against a 50-section PRD, a practical allocation looks like this:

| Component | Token budget | Purpose |
|-----------|-------------|---------|
| System prompt + edit instructions | 500–2,000 | Define editing behavior and output format |
| Document outline (all headings) | 500–2,000 | Structural awareness |
| Adjacent section summaries | 100–200 each | Continuity context |
| Target section (full text) | Variable | The content being edited |
| Cross-referenced sections | Variable | Dependency context |
| Response budget | 2,000–4,000 | Space for generated edits |

**Position the target section at the end of the prompt.** Research on the "lost-in-the-middle" phenomenon shows models attend most to the beginning and end of their context. The outline provides structural framing at the top; the target section gets maximum attention at the bottom.

**Progressive context loading** using the agent/tool pattern allows the LLM to request additional context on demand. Rather than front-loading all potentially relevant sections, give the agent a `read_section` tool and let it pull in cross-referenced content as needed. This keeps initial context lean while enabling the agent to gather whatever information it needs for coherent edits.

For very large documents, **summary compression** of non-target sections works well: summarize each section into one paragraph, combine into a document overview, and include full text only for sections being actively edited. A 50-section PRD might compress from 100K tokens to under 10K tokens of summaries plus one full section.

---

## State management and real-time editing UX in Next.js

**Zustand** is the best fit for document editing state in Next.js — its single-store design handles the edit history stack, AI processing status, and document metadata cleanly with ~1KB bundle size. For cases requiring granular per-section reactivity, **Jotai**'s atom-based model with `jotai-history` provides built-in undo/redo via `withHistory`.

The critical state management pattern for AI editing treats each AI edit as **a single undoable operation**. Snapshot the full document state before the AI begins, apply edits progressively as they stream in, and if the user undoes, revert the entire batch. Track `editSource: 'human' | 'ai'` metadata on each edit for UI differentiation.

**For collaborative editing, Yjs (CRDT) is the production standard.** BlockNote, Tiptap, and ProseMirror all have Yjs bindings. The key insight: **treat the AI as another collaborative peer**. Apply AI edits through Yjs transactions, which ensures proper conflict resolution, undo/redo integration, and real-time sync across connected clients. Yjs's `Y.UndoManager` handles the undo stack automatically.

For streaming and progressive editing UX, several proven patterns exist:

- **Stream edits into the editor with review markers** (Tiptap's `reviewOptions: { mode: 'review' }`), showing AI changes as "suggestions" that users accept or reject individually — exactly like Google Docs' track changes
- **Section-by-section progress indicators** via CopilotKit's `useCoAgentStateRender`, showing which section is currently being processed ("Editing section 3 of 7...")
- **Real-time diff visualization** during streaming, showing additions in green and deletions in red as the LLM generates content (Aider's approach)
- **LangGraph streaming with `streamMode: "custom"`** and `dispatchCustomEvent` to send structured progress events from the backend to the Next.js frontend

---

## Production-proven editor frameworks worth building on

Rather than building a rich text editor from scratch, three open-source options provide strong foundations for AI-integrated document editing:

**BlockNote** (`@blocknote/xl-ai`, ~4,800 GitHub stars) offers the most complete out-of-box AI editing experience. Its block-based architecture mirrors Notion's model, with each block having a unique ID for targeted AI operations. The `@blocknote/xl-ai` package provides interactive AI suggestions with accept/reject, streaming support, and transparent operation display. It runs on ProseMirror + Tiptap + Yjs, supporting real-time collaboration. It's used in production by French, German, and Netherlands government collaborative writing tools.

**Tiptap AI Toolkit** (commercial, but architecturally instructive) demonstrates the most mature production pattern: the AI acts as a **tool-using agent** that selects from `read`, `insert`, `edit`, and `patch` operations, while the Tiptap extension handles precise document manipulation. This separation of "what to edit" (LLM decides) from "how to apply" (toolkit handles) is the key architectural principle. Its streaming methods (`streamText()`, `streamHtml()`, `streamJson()`) with position targeting and review options represent the state of the art.

**Novel.sh** provides the simplest starting point — a Notion-style WYSIWYG editor built on Tiptap + Vercel AI SDK with AI autocompletion. Best for MVPs, though it lacks the surgical editing capabilities needed for large document workflows.

Cursor's approach to code editing offers transferable principles: its **two-stage "sketch → apply" architecture** uses a powerful LLM to generate the intended change, then a separate specialized model to integrate it into the codebase. For document editing, this translates to: use a capable model (GPT-4o, Claude) to determine what should change, then use deterministic application logic (search/replace, block replacement) to apply the changes precisely.

---

## Conclusion

The optimal architecture for LLM-powered large document editing combines five key design decisions that emerge from production implementations:

**Section-indexed chunking over arbitrary splitting.** Markdown-aware heading-based chunking creates natural edit units with stable IDs, enabling O(1) lookup and precise replacement. The two-stage splitter (headers first, then size-based subdivision) handles both structured and unstructured content.

**Diff-based output over full rewrites.** Having the LLM generate search/replace pairs or structured patches rather than complete content eliminates the "most expensive copy-paste" problem, cutting costs and latency dramatically while making edits deterministic to apply and trivial to undo.

**Agent-with-tools over monolithic chains.** A LangGraph agent with `read_section`, `search_document`, and `edit_section` tools can navigate large documents dynamically, loading context on demand rather than requiring everything up front. The deprecated MapReduce and Refine chains lack the conditional looping and state persistence that editing workflows require.

**Block-based editors with AI as a collaborative peer.** Frameworks like BlockNote and Tiptap provide the rich editing surface, while Yjs CRDTs enable treating AI edits as transactions from another collaborator — getting conflict resolution, undo/redo, and real-time sync essentially for free.

**CopilotKit as the orchestration layer.** Its `useCopilotAction` defines the editing interface the LLM can use, `useCopilotReadable` exposes compressed document state, and CoAgents with LangGraph provide bidirectional state sync with progressive updates — the complete stack for connecting a Next.js frontend to an intelligent document editing backend.