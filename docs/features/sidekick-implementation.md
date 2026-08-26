# Sidekick: Implementation Guide

An in-depth technical reference for Dust's "Sidekick" — the AI assistant that sits inside the Agent
Builder and helps users configure their agent via actionable, accept/reject suggestions.

This document is written for someone who already has an "agent builder" in their own product and
wants to port or replicate the Sidekick pattern. It covers the end-to-end architecture, the files
that matter, the data shapes, the non-obvious design decisions, and the dependencies you'd need to
replace.

---

## 1. What Sidekick actually is

Sidekick is **a chat panel inside the Agent Builder UI** where a background LLM agent (itself a
global agent in Dust, running on Haiku) helps the user configure another agent.

What makes it different from "just a chat":

1. **It reads the live, unsaved form state** through a browser-side MCP server.
2. **It writes suggestions, not edits.** Every change it proposes is a database-backed
   `AgentSuggestion` row with a kind (`instructions`, `tools`, `skills`, `model`, `knowledge`,
   `sub_agent`) and a `pending` / `approved` / `rejected` / `outdated` state.
3. **Suggestions render two places simultaneously:**
   - As **cards inside the chat response** (via a markdown directive), with Accept / Reject
     buttons.
   - As **inline diffs in the TipTap instructions editor** (blue additions, red deletions) that the
     user can hover to get an accept/reject bubble.
4. **Instruction suggestions are targeted per-block** using stable `data-block-id` attributes on
   every block-level node, so two users editing different paragraphs don't conflict.
5. **The LLM decides when to work heavily** (following a `<user_confirmation_before_heavy_work>`
   section of the system prompt) so it doesn't eat tokens on every user turn.

The whole thing is glued together by two React contexts (`SidekickSuggestionsContext` +
`SidekickHighlightContext`), a client-side MCP server, a backend MCP server, a custom TipTap
extension, and a custom remark directive.

---

## 2. High-level architecture

```
┌─────────────────────────── AGENT BUILDER (browser) ─────────────────────────┐
│                                                                             │
│  ┌───────────── Left / center panel ─────────────┐   ┌── Right panel ────┐  │
│  │  AgentBuilder form (react-hook-form)          │   │                   │  │
│  │  ┌───────────────────────────────────────────┐│   │  Tabs:            │  │
│  │  │ TipTap editor for `instructions`          ││   │   [ Sidekick ]    │  │
│  │  │   - BlockIdExtension (data-block-id)      ││   │   [ Preview   ]   │  │
│  │  │   - InstructionsRootExtension             ││   │   [ Insights  ]   │  │
│  │  │   - InstructionSuggestionExtension        ││   │                   │  │
│  │  │     (diff decorations + hover bubble)     ││   │  ┌─────────────┐  │  │
│  │  └───────────────────────────────────────────┘│   │  │ Conversation│  │  │
│  │  Tools / Skills / Model / Knowledge configs   │   │  │  with       │  │  │
│  └───────────────────────────────────────────────┘   │  │  Sidekick   │  │  │
│                                                      │  │  (SSE)      │  │  │
│  ┌─── SidekickSuggestionsContext (SWR) ─────────┐    │  │             │  │  │
│  │  - pending / outdated suggestions            │    │  │  markdown   │  │  │
│  │  - accept / reject (optimistic + PATCH)      │    │  │  + custom   │  │  │
│  │  - applies edits into TipTap editor          │    │  │  directive  │  │  │
│  │  - scroll-to-next, focus, highlight          │    │  │  renders    │  │  │
│  └──────────────────────────────────────────────┘    │  │  cards      │  │  │
│                                                      │  └─────────────┘  │  │
│  ┌─── Client-side MCP server ───────────────────┐    │                   │  │
│  │  useSidekickMCPServer()                      │    └───────────────────┘  │
│  │  - tool: get_agent_config                    │                           │
│  │    returns form state + instructionsHtml     │                           │
│  │    + pendingSuggestions                      │                           │
│  │  - transport: BrowserMCPTransport            │                           │
│  └──────────────────────────────────────────────┘                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                         ▲                              ▲
                         │                              │ SSE messages
              tool calls │                              │
                         ▼                              │
┌──────────────────── BACKEND (Next.js API routes) ────────────────────────┐
│                                                                          │
│  Sidekick global agent (Claude Haiku) — see sidekick.ts                  │
│    instructions = buildSidekickInstructions()                            │
│    actions = [ agent_sidekick_context, company_data ]                    │
│                                                                          │
│  MCP server `agent_sidekick_context` (backend):                          │
│    get_available_{models,skills,tools,agents,knowledge}                  │
│    search_knowledge                                                      │
│    get_agent_feedback, get_agent_insights                                │
│    suggest_prompt_edits / suggest_tools / suggest_skills /               │
│    suggest_knowledge / suggest_model / suggest_sub_agent                 │
│    list_suggestions, update_suggestions_state                            │
│    search_agent_templates, get_agent_template                            │
│    inspect_conversation, inspect_message                                 │
│                                                                          │
│  MCP server `agent_sidekick_agent_state` (read-only agent info)          │
│  MCP server `company_data` (knowledge semantic_search / list / find /cat)│
│                                                                          │
│  REST endpoints:                                                         │
│    POST /api/w/[wId]/assistant/conversations ...                         │
│    GET  /api/w/[wId]/assistant/builder/suggestions?...                   │
│    PATCH /api/w/[wId]/assistant/builder/suggestions/[sId]                │
│    GET  /api/w/[wId]/assistant/builder/sidekick/prompt/existing          │
│    GET  /api/w/[wId]/assistant/builder/sidekick/prompt/template          │
│                                                                          │
│  Database:                                                               │
│    agent_suggestions (id, sId, agentConfigurationId, kind, suggestion,   │
│                       analysis, state, source, conversationId, ...)      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. The Sidekick agent (backend)

### 3.1 Agent configuration — `front/lib/api/assistant/global_agents/configurations/dust/sidekick.ts`

Sidekick is a **global agent**, meaning it's created in code, not from the DB, and has `sId =
GLOBAL_AGENTS_SID.SIDEKICK`. The top-level factory is `_getSidekickGlobalAgent(auth, { ... })`.

Key things it sets up:

- **Model selection** (lines 328–337):
  - First user turn on a brand-new agent → `NOOP_MODEL_CONFIG`. No LLM call, returns a static
    "Need a hand?" response. Cheap.
  - Other first turns → Haiku (or the small whitelisted model for workspaces without Anthropic).
  - Follow-up turns → the large whitelisted model (Sonnet or equivalent).
- **Actions** (lines 320–323): Injects the `agent_sidekick_context` MCP server plus
  `company_data` if available. The browser-side MCP server (`agent-builder-sidekick-client`) is
  attached per-conversation via `clientSideMCPServerIds`, not here.
- **Instructions**: built by `buildSidekickInstructions()` from `SIDEKICK_INSTRUCTION_SECTIONS`.

### 3.2 The system prompt

The prompt is built from named sections (lines 26–260). The order in `buildSidekickInstructions()`
is important — `agentWorkflow` comes right after `primary` because the rest are "supporting
detail" for the workflow. The key sections:

1. **`primary`** — Defines Sidekick as an "AI assistant embedded in the Agent Builder" and lists
   what it has access to: live form state (`get_agent_config`), workspace models/skills/tools,
   agent feedback/insights, and company data.

2. **`agentWorkflow`** — A 7-step process that **every interaction** has to follow:
   ```
   Step 1: ALWAYS call get_agent_config (except on the first message).
   Step 2: Understand the agent's workflow (from get_agent_config output).
   Step 3: Understand user intent (ask for clarification if unclear).
   Step 4: Build a plan.
   Step 5: Execute the research plan (no suggestions yet).
   Step 6: Make suggestions.
   Step 7: Respond (follow <response_style>).
   ```

3. **`userConfirmationForHeavyWork`** — Defines "heavy" as: calling `search_knowledge` or company
   data, making multiple `suggest_*` calls, or doing a full instructions rewrite. Heavy work
   requires asking for confirmation first. This keeps per-turn token cost under control.

4. **`suggestionContext`** — The most important section for the whole rendering pipeline. It tells
   the LLM to include the tool output verbatim:
   ```
   :agent_suggestion[]{sId=[id1] kind=[kind1]}
   :agent_suggestion[]{sId=[id2] kind=[kind2]}
   ```
   Two hard rules: **never** hallucinate a directive, and **never** suggest a tool/skill ID that
   isn't in `workspace_context`.

5. **`instructionsGuidance`**, **`instructionSuggestionFormatting`**, **`skillsToolsGuidance`**,
   **`knowledgeGuidance`**, **`companyDataGuidance`** — Domain guidance pulled from a shared
   `SHARED_PROMPT_SECTIONS` object. These define when to suggest what, and how (e.g. max 3 pending
   knowledge suggestions, "search" vs "query_tables" method, etc.).

6. **`responseStyle`** — Terse, scannable answers; no echoing the current config back; use
   `:quickReply[…]{message="…"}` for finite-choice questions.

7. **`templates`**, **`workflowVisualization`**, **`triggersAndSchedules`**,
   **`contextGuidance`** — Feature-specific sub-prompts.

8. **`contextGuidance`** — Tells the agent that `<user_context>` and `<workspace_context>` are
   injected at runtime (see `sidekick_context.ts`). This is what removes the need to call
   `list_models` / `list_skills` / `list_tools` at all.

The important takeaway: **Sidekick's guardrails are prompt-based**. Heavy-work gating,
suggestion-limit enforcement (below), and the "don't hallucinate a suggestion directive" rules all
live in the prompt. The backend enforces limits independently, but the prompt is what keeps the
agent from wasting user turns.

### 3.3 Runtime context injection — `front/lib/api/assistant/global_agents/sidekick_context.ts`

For each Sidekick conversation, the backend builds a `<workspace_context>` block with the actual
list of available models, skills, tools, and knowledge in the user's workspace, plus a
`<user_context>` block with the user's job type and preferred platforms. These are concatenated
into the system prompt at runtime so the agent doesn't need to make 4 round-trip list calls before
it can do anything.

---

## 4. MCP servers Sidekick uses

Sidekick's capabilities are delivered as MCP tools. There are **three** MCP servers involved:

| Server | Where it runs | Purpose |
|--------|---------------|---------|
| `agent_sidekick_context` | Backend | Workspace discovery + suggestion CRUD + feedback/insights + templates |
| `agent_sidekick_agent_state` | Backend | Read-only "give me the saved agent config" |
| `agent-builder-sidekick-client` | **Browser** | Exposes the live, unsaved form state via `get_agent_config` |
| `company_data` | Backend (shared, not Sidekick-specific) | `semantic_search`, `list`, `find`, `cat` on workspace knowledge |

### 4.1 `agent_sidekick_context` — the heavy lifter

File: `front/lib/api/actions/servers/agent_sidekick_context/metadata.ts` (tool schemas) and
`.../tools/index.ts` (handlers).

The tool set is deliberately tuned for the "build an agent" task. Categorized:

**Workspace discovery (the LLM calls these rarely because the data is already in
`<workspace_context>`):**
- `get_available_knowledge` — data source views grouped by space + category (managed / folder /
  website).
- `get_available_models` — models, optionally filtered by provider.
- `get_available_skills` — skills.
- `get_available_tools` — MCP servers in the workspace.
- `get_available_agents` — other agents (for sub-agent suggestions).
- `inspect_available_agent` — name, description, prompt, tool IDs, skill IDs for one agent.

**Analytics on the agent being edited:**
- `get_agent_feedback` — user thumbs up/down, optionally filtered to latest version.
- `get_agent_insights` — active users, conversations, messages, feedback stats over N days.

**Knowledge discovery:**
- `search_knowledge` — semantic search across the workspace's search-type data source views,
  returning hit counts and document titles. This is the first step before calling
  `suggest_knowledge`.

**Suggestion creation** — these are the tools that actually **create database rows**. Each one
returns a string that contains the `:agent_suggestion[]{sId=… kind=…}` directive(s), which the
agent **must** echo verbatim into its chat response. The server also enforces `MAX_PENDING_*`
limits:
- `suggest_prompt_edits` — array of `{ targetBlockId, type: "replace", content, analysis? }`. Max
  10 pending. Each block ID must appear at most once.
- `suggest_tools` — array of `{ action: "add"|"remove", toolId, analysis? }`. Max 3 pending.
  Duplicate suggestions for the same tool are auto-marked outdated.
- `suggest_sub_agent` — `{ action, subAgentId, analysis? }`. Max 2 pending. (Separate tool
  because sub-agents are tools of the `run_*` kind and need a different UI treatment.)
- `suggest_skills` — array of `{ action, skillId, analysis? }`. Max 3 pending.
- `suggest_knowledge` — `{ action, method, dataSourceViewId, description?, analysis? }`. Max 3
  pending. `method` is `"search"` (default, recommended) or `"query_tables"` (only for confirmed
  top-level structured tables).
- `suggest_model` — `{ modelId, reasoningEffort?, analysis? }`.

**Suggestion management:**
- `list_suggestions` — filterable by state / kind / limit.
- `update_suggestions_state` — mark suggestions `rejected` or `outdated` (used when the agent
  needs to clean up after itself; the UI uses its own PATCH endpoint for human-driven accept/
  reject).

**Templates (for new agents):**
- `search_agent_templates` — tag-based (`jobType`) or semantic (`query`) search. Returns full
  template details including `sidekickInstructions`.
- `get_agent_template` — fetch `sidekickInstructions` for a specific template.

**Conversation inspection (for "shrink-wrap" flow — bootstrapping an agent from a past
conversation):**
- `inspect_conversation` — title + timeline of user and agent messages.
- `inspect_message` — full detail of one message, including tool calls, chain-of-thought,
  handoffs.

Every tool sets `stake: "never_ask"` — because these are read-only or scoped to the current agent
being edited, they're safe to run without permission prompts.

The server metadata is exported as `AGENT_SIDEKICK_CONTEXT_SERVER` and plugged into the global
agent's `actions` array via `buildServerSideMCPServerConfiguration`.

### 4.2 `agent-builder-sidekick-client` — the browser-side MCP server

This is the key "trick" that lets Sidekick see form state that **isn't saved to the database
yet**. It's a full MCP server running in the browser tab, connected to the agent via
`BrowserMCPTransport`, exposing a single tool: `get_agent_config`.

**File:** `front/components/agent_builder/sidekick/useMCPServer.ts`

**Lifecycle** (simplified):
```ts
const mcpServer = new McpServer({ name: "agent-builder-sidekick-client", version: "1.0.0" });

registerGetAgentConfigTool(mcpServer, {
  getFormValues: () => getValues(),                            // react-hook-form
  getPendingSuggestions: () => suggestionsContext.pendingSuggestions,
  getCommittedInstructionsHtml: () =>
    suggestionsContext.getCommittedInstructionsHtml(),
});

const transport = new BrowserMCPTransport(owner.sId, SERVER_NAME, (newServerId) => {
  setServerId(newServerId);
});

await mcpServer.connect(transport);
```

The resulting `serverId` is plumbed into `SidekickPanelProvider` and passed as part of
`clientSideMCPServerIds` when sending messages to Sidekick. On unmount, the server and transport
are both `close()`d.

**File:** `front/components/agent_builder/sidekick/tools/getAgentConfig.ts`

The `get_agent_config` tool takes **no parameters** and returns a JSON blob:

```json
{
  "name": "...",
  "description": "...",
  "instructionsHtml": "<div data-block-id=\"instructions-root\">...</div>",
  "scope": "...",
  "model": { "modelId": "...", "providerId": "...", "reasoningEffort": "..." },
  "tools":  [ { "sId", "name", "description", "childAgentId?" } ],
  "skills": [ { "sId", "name", "description" } ],
  "pendingSuggestions": [
    { "sId", "kind": "instructions", "content", "targetBlockId", "type" },
    { "sId", "kind": "tools" },
    ...
  ]
}
```

Three important details:

1. **`instructionsHtml`** is the HTML form of the TipTap doc, with `data-block-id` attributes
   preserved. This is what lets the LLM pick a `targetBlockId` for `suggest_prompt_edits`. The
   committed-HTML getter also strips style attributes so the LLM isn't distracted by CSS noise.
2. **`pendingSuggestions`** includes only suggestions still in `pending` state. For instructions
   suggestions, the full payload (`content`, `targetBlockId`, `type`) is inlined. For other kinds,
   only `sId` and `kind` — the LLM can call `list_suggestions` if it needs more.
3. There's a **Datadog error log** when markdown instructions exist but the HTML is empty/stub —
   this is a known race condition between form hydration and TipTap initialization, and it's
   silent-but-logged in production.

---

## 5. Suggestion data model

**File:** `front/types/suggestions/agent_suggestion.ts`

All suggestion types share this base:

```ts
{
  id: number;                      // DB auto-increment
  sId: string;                     // Public string ID (used in URLs/directives)
  createdAt: number;
  updatedAt: number;
  agentConfigurationId: number;    // Which agent this targets
  analysis: string | null;         // LLM's reasoning (optional)
  state: "pending" | "approved" | "rejected" | "outdated";
  source: "sidekick" | "reinforcement" | "synthetic";
  conversationId: string | null;   // The Sidekick conversation that created it
}
```

And is discriminated by `kind`:

| kind | payload | UI card |
|------|---------|---------|
| `instructions` | `{ content, targetBlockId, type: "replace" }` | Inline diff in TipTap + read-only preview card in chat |
| `tools` | `{ action: "add"\|"remove", toolId }` | "Add tool" / "Remove tool" action card |
| `sub_agent` | `{ action, toolId, childAgentId }` | Special case of tools — `run_<name>` |
| `skills` | `{ action, skillId }` | Skill card |
| `model` | `{ modelId, reasoningEffort? }` | Model switch card (special formatting when only reasoning effort changes) |
| `knowledge` | `{ action, method: "search"\|"query_tables", dataSourceViewId, description? }` | Knowledge card with add/remove action |

Each kind has a corresponding `WithRelations` shape that adds resolved data:
- `tools` → `{ tool: MCPServerViewType }`
- `sub_agent` → `{ tool: MCPServerViewType }` (relates to a `run_*` tool)
- `skills` → `{ skill: SkillType }`
- `model` → `{ model: ModelConfigurationType }`
- `knowledge` → `{ dataSourceView, serverView }`
- `instructions` → `null` (no external relation needed)

There's a sentinel constant `INSTRUCTIONS_ROOT_TARGET_BLOCK_ID = "instructions-root"` — when the
LLM wants to rewrite the entire instructions document, it targets this block ID, which matches the
`InstructionsRootExtension` wrapper node (section 7.2).

---

## 6. Frontend state management

There are two React contexts deliberately kept separate:

### 6.1 `SidekickSuggestionsContext` — all the data

**File:** `front/components/agent_builder/sidekick/SidekickSuggestionsContext.tsx`

Exposes:

```ts
{
  getSuggestionWithRelations(sId): AgentSuggestionWithRelationsType | null;
  pendingSuggestions: AgentSuggestionType[];
  triggerRefetch(sId): void;
  isSuggestionsLoading, isSuggestionsValidating;
  hasAttemptedRefetch(sId): boolean;

  // Editor wiring
  registerEditor(editor): void;
  getCommittedInstructionsHtml(): string;

  // Actions
  acceptSuggestion(s): Promise<boolean>;
  rejectSuggestion(s): Promise<boolean>;
  acceptAllInstructionSuggestions(): Promise<boolean>;
  rejectAllInstructionSuggestions(): Promise<boolean>;

  // Navigation
  focusOnSuggestion(s): void;
  scrollToNextSuggestion(justAccepted?): void;
}
```

Internally:

- **Two SWR hooks** — `useAgentSuggestions({ state: ["pending"] })` and
  `useAgentSuggestions({ state: ["outdated"] })` (the latter capped at 50). Both poll-on-demand
  with debounced refetch (100ms) when the chat surfaces a new `sId`.
- **Three refs** carrying non-render state:
  - `appliedSuggestionsRef: Set<sId>` — which suggestions have been injected into the TipTap doc.
  - `processedSuggestionsRef: Map<sId, AgentSuggestionType>` — optimistic local overrides for
    pending requests.
  - `refetchAttemptedRef: Set<sId>` — so we don't loop retrying missing suggestions.
- **Auto-apply effect** — when a new pending instruction suggestion arrives, it's automatically
  applied to the editor (decorations added). If the target block no longer exists, the suggestion
  is marked `outdated` server-side and removed from the SWR pending cache.
- **An internal `EditorHighlightSync` component** reads from `SidekickHighlightContext` and calls
  `editor.commands.setHighlightedSuggestion(id)` so diff decorations switch between "dimmed" and
  "highlighted" styling.

Accept flow, in detail:

```ts
async function acceptSuggestion(s) {
  // 1. Optimistic: stash the new state in processedSuggestionsRef.
  processedSuggestionsRef.current.set(s.sId, { ...s, state: "approved" });

  // 2. Optimistic: drop from SWR pending cache without revalidating.
  mutate(pendingCacheKey, (cache) => cache.filter(x => x.sId !== s.sId), { revalidate: false });

  // 3. Call PATCH /api/w/[wId]/assistant/builder/suggestions/[sId].
  const ok = await patchSuggestions([s.sId], "approved");

  if (ok) {
    // 4. Tell the editor to finalize the inline diff.
    if (s.kind === "instructions") editor.commands.acceptSuggestion(s.sId);
    // For other kinds the card component itself writes into the form via setValue().

    // 5. UX: scroll to the next pending suggestion.
    scrollToNextSuggestion(s);
  } else {
    // Rollback.
    processedSuggestionsRef.current.delete(s.sId);
    mutate(pendingCacheKey);
  }
}
```

Reject is symmetric (editor command is `rejectSuggestion` which reverts the inline decorations).

Bulk accept/reject iterates through all pending instruction suggestions and fires a single PATCH
per suggestion, then dispatches a blur event (with a 300ms delay) to kick off the agent builder's
avatar/description auto-generation.

### 6.2 `SidekickHighlightContext` — hover state only

**File:** `front/components/agent_builder/sidekick/SidekickHighlightContext.tsx`

```ts
{
  highlightedSuggestionId: string | null;
  isHighlightedSuggestionPinned: boolean;
  highlightSuggestion(id, pinned?): void;
}
```

This is intentionally split out so that hovering a suggestion doesn't cause the heavy suggestions
context to re-render.

---

## 7. TipTap editor extensions

The instructions editor has three custom extensions that together make block-targeted suggestions
work.

### 7.1 `BlockIdExtension` — stable IDs per block

**File:** `front/components/editor/extensions/instructions/BlockIdExtension.tsx`

```ts
export const BlockIdExtension = UniqueID.configure({
  types: ["heading", "instructionBlock", "orderedList", "paragraph", "bulletList"],
  attributeName: "block-id",
  generateID: generateShortBlockId,  // 8-char alphanumeric
});
```

Built on `@tiptap/extension-unique-id`. The `block-id` attribute is serialized as `data-block-id`
in the HTML output. IDs are generated on node creation and persist as long as the node isn't
deleted.

### 7.2 `InstructionsRootExtension` — whole-doc targeting

**File:** `front/components/editor/extensions/instructions/InstructionsRootExtension.tsx`

This wraps every instructions document in a single `instructionsRoot` node with a fixed
`data-block-id="instructions-root"`. The `doc` schema is narrowed to `instructionsRoot+` so all
content lives inside it. This lets the LLM rewrite the whole document in one suggestion by
targeting the sentinel ID — without this wrapper, there'd be no "whole document" block to aim at.

### 7.3 `InstructionSuggestionExtension` — diffs, decorations, accept/reject

**File:** `front/components/editor/extensions/agent_builder/InstructionSuggestionExtension.ts`

The workhorse. It:

1. Stores a plugin state with `Map<sId, StoredSuggestion>` and a current `highlightedId`.
2. Exposes commands:
   - `applySuggestion(id, content, targetBlockId)` — parses the HTML content to a ProseMirror
     node, finds the block by `data-block-id`, computes a word-level diff using
     `prosemirror-changeset`, and adds inline decorations:
     - `.suggestion-addition` (blue bg, blue text)
     - `.suggestion-deletion` (red bg, strikethrough)
     - Dimmed variants when the suggestion isn't currently highlighted.
   - `acceptSuggestion(id)` — strips decorations and finalizes the new content into the doc.
   - `rejectSuggestion(id)` — strips decorations and reverts the original content.
   - `setHighlightedSuggestion(id)` — toggles decoration styling between dimmed and highlighted.

Key design choice: when Sidekick delivers an instruction suggestion, the new text is **already
rendered into the editor as a diff** — the user sees it immediately, they're just choosing whether
to keep it. Accept is an O(1) "strip decorations", not a "re-apply change".

### 7.4 Floating bubble menu — `SuggestionBubbleMenu.tsx`

**File:** `front/components/agent_builder/sidekick/SuggestionBubbleMenu.tsx`

- Mousemove listener inside the editor container looks for elements with `[data-suggestion-id]`
  (set by the decoration). On match it calls `highlightSuggestion(id)` and positions a small
  floating menu (80px above cursor, clamped to the right edge of the container).
- The menu has two buttons: Accept and Reject — both wired to the context actions.
- "Pinning" happens when the user clicks the suggestion directly — then the menu stays open until
  another suggestion is clicked or the user acts on it.

---

## 8. Rendering suggestions as chat cards

Sidekick's chat responses are markdown, rendered via `react-markdown` + `remark-directive`. The
extra piece is a custom directive for suggestion cards.

### 8.1 The remark directive — `SidekickSuggestionDirective.tsx`

**File:** `front/components/markdown/suggestion/SidekickSuggestionDirective.tsx`

Two exports:

1. **`sidekickSuggestionDirective()`** — a remark plugin that walks the AST, finds text
   directives named `agent_suggestion` (and tolerates malformed `::agent_suggestion[]{...}` with a
   stray prefix), reads their `sId` and `kind` attributes, and converts them to custom HTML
   elements.
2. **`getSidekickSuggestionPlugin()`** — a React component factory that renders the custom
   element. On render it:
   - Reads the suggestion from `SidekickSuggestionsContext` via `getSuggestionWithRelations(sId)`.
   - If missing from cache but not yet re-fetched, calls `triggerRefetch(sId)`.
   - While loading/validating, shows a skeleton:
     - Instructions → `<LoadingBlock className="h-24" />`
     - Other kinds → `<ActionCardBlock title="Loading suggestion" />`
   - If the suggestion no longer exists (deleted/outdated), returns `null`.
   - Otherwise dispatches to the correct card component.

### 8.2 The card components — `SidekickSuggestionCard.tsx`

**File:** `front/components/markdown/suggestion/SidekickSuggestionCard.tsx`

One component per `kind`:

| Component | Behavior on Accept |
|-----------|--------------------|
| `InstructionsSuggestionCard` | Renders a read-only TipTap preview with the inline diff, plus an "eye" button that calls `focusOnSuggestion(s)` to jump the main editor to the block. Accept fires `context.acceptSuggestion(s)`, which triggers the editor command. |
| `ToolsSuggestionCard` | `setValue("actions", [...current, newAction], { shouldDirty: true })` |
| `SubAgentSuggestionCard` | Same as tools, but action name is `run_${childAgentName}` |
| `SkillsSuggestionCard` | `setValue("skills", [...current, newSkill], { shouldDirty: true })` |
| `ModelSuggestionCard` | `setValue("generationSettings.modelSettings", ...)` and optionally reasoningEffort |
| `KnowledgeSuggestionCard` | Builds a new action configuration: `dataSourceConfigurations` for `search`, `tablesConfigurations` for `query_tables`, appends to `actions` |

Card state maps to visual state:
- `pending` → active (blue)
- `approved` → accepted (green)
- `rejected` → rejected (red, strikethrough)
- `outdated` → disabled (gray)

Cards are memoized so they don't re-render when unrelated suggestions arrive.

---

## 9. Conversation lifecycle

### 9.1 `SidekickPanelContext` — the conversation manager

**File:** `front/components/agent_builder/SidekickPanelContext.tsx`

Owns the Sidekick conversation state:

```ts
{
  conversation: ConversationType | null;
  isCreatingConversation: boolean;
  creationFailed: boolean;
  startConversation(): Promise<void>;
  resetConversation(): void;
  clientSideMCPServerIds: string[];
  conversationId?: string;
  suppressAutoStart: boolean;
}
```

`startConversation()`:

1. Calls `useSidekickFirstMessage()` to decide the opening user message.
2. Creates a conversation via the normal `createConversationWithMessage` API, passing:
   - `mentions: [{ configurationId: GLOBAL_AGENTS_SID.SIDEKICK }]`
   - `origin: "agent_sidekick"`
   - `visibility: "test"` (hidden from the user's conversation list)
   - `metadata: { sidekickTargetAgentConfigurationId,
     sidekickTargetAgentConfigurationVersion, sidekickIsNewAgentFromScratch }`
   - `clientSideMCPServerIds: []` — **empty on the first message** because the browser MCP
     server's SSE setup races with message creation. From message 2 onwards, the full list is
     passed.

The metadata fields are read by `_getSidekickGlobalAgent` on the backend to decide whether to use
the NOOP model (brand new agent, cheapest first turn) or the small/large one.

### 9.2 `useSidekickFirstMessage` — opening message

**File:** `front/hooks/useSidekickFirstMessage.ts`

Different flows, different opening messages:

| Flow | Opening message source |
|------|------------------------|
| New agent from scratch | Static local string ("What would you like to build?") — paired with `NOOP_MODEL_CONFIG` so zero LLM cost. |
| Duplicate of an existing agent | Client-side template that nudges the LLM to call `get_agent_config` and diff against what the user had. |
| Edit an existing agent | `GET /api/w/[wId]/assistant/builder/sidekick/prompt/existing` — fetched server-side with feedback and insights pre-computed so the agent has context. |
| Template | `GET /api/w/[wId]/assistant/builder/sidekick/prompt/template` — returns template-specific `sidekickInstructions` to prime the agent. |
| Shrink-wrap (build an agent from a past conversation) | `GET /api/w/[wId]/assistant/builder/sidekick/prompt/shrink-wrap` |

### 9.3 `AgentBuilderSidekick` — the panel itself

**File:** `front/components/agent_builder/AgentBuilderSidekick.tsx`

The actual chat view. Mounts the standard `ConversationViewer` from the Dust conversation stack,
but passes two things on top:

1. A custom markdown `components` map that includes the `agent_suggestion` handler from
   `SidekickSuggestionDirective`.
2. The `sidekickSuggestionDirective` remark plugin so the directive parses.

Wraps its children in `BlockedActionsProvider` + `GenerationContextProvider` (the normal Dust
chat providers). Auto-starts the conversation on mount via a `useEffect`, unless
`suppressAutoStart` is true.

### 9.4 `AgentBuilderRightPanel` — tab shell

**File:** `front/components/agent_builder/AgentBuilderRightPanel.tsx`

Thin tab container with three tabs: **Sidekick**, **Preview**, **Insights**. Uses
`usePreviewPanelContext` to track which tab is open. In collapsed mode it shows icon-only
buttons; in expanded mode the full tab bar. Sidekick is the default open tab.

---

## 10. End-to-end data flows

### 10.1 Opening the panel for a new agent

```
User clicks "New agent"
  → AgentBuilder page mounts
  → AgentBuilderRightPanel renders with "Sidekick" tab active
  → AgentBuilderSidekick effect calls startConversation()
    → useSidekickFirstMessage() → "What would you like to build?"
    → POST /api/w/[wId]/assistant/conversations with mentions=[SIDEKICK],
       visibility="test", metadata.sidekickIsNewAgentFromScratch=true
  → Sidekick agent picks NOOP_MODEL_CONFIG (first turn, new agent)
    → Returns canned "Need a hand?" response without an LLM call
  → User sees the opening prompt
  → In parallel: useSidekickMCPServer() spins up the browser MCP server
     (get_agent_config tool available from message 2 onwards)
```

### 10.2 User asks "can you help me improve this agent?"

```
User types message, submits
  → POST /api/w/[wId]/assistant/conversations/[cId]/messages
     with clientSideMCPServerIds = [browser-mcp-id]
  → Sidekick agent wakes up (Haiku)
  → Step 1 of <agent_workflow>: calls get_agent_config on the browser MCP
     → Tool handler (in the user's tab) reads the react-hook-form values,
        gets the committed instructions HTML (with data-block-id attrs),
        returns the JSON blob
  → Step 2: LLM reasons about the agent
  → Step 3: LLM checks user intent — clear, so continues
  → Step 4: LLM builds a plan — "I want to search knowledge, suggest 2 tools
     and rewrite one paragraph" → that's heavy
  → Step 4a: LLM lists the plan in bullets and asks for confirmation
  → Returns the plan + quickReply buttons
User clicks :quickReply[Go ahead]
  → Sends "Go ahead" to Sidekick
  → LLM calls search_knowledge, get_agent_feedback, etc. (Step 5)
  → Then suggest_prompt_edits, suggest_tools (Step 6)
     → Each suggest_* creates AgentSuggestion rows, returns
        :agent_suggestion[]{sId=... kind=...} directives in tool output
  → LLM responds with short prose + the directives verbatim (Step 7)
  → SSE delivers the message to the browser
  → ConversationViewer renders markdown → remark parses directives →
     SidekickSuggestionPlugin renders cards
  → SidekickSuggestionsContext SWR refetches pending → new suggestions arrive
  → Instructions suggestions auto-apply to the TipTap editor:
     InstructionSuggestionExtension.applySuggestion() with target block ID
     → word-level diff decorations appear inline
  → Non-instruction cards show "Add tool: X", "Add skill: Y" etc.
```

### 10.3 User accepts a suggestion

```
User clicks "Accept" on an instructions card (or the bubble menu
  after hovering the diff in the editor)
  → SidekickSuggestionsContext.acceptSuggestion(s)
    1. processedSuggestionsRef.set(sId, { ...s, state: "approved" })
    2. Optimistic SWR mutate: drop from pending cache
    3. PATCH /api/w/[wId]/assistant/builder/suggestions/[sId]
       body: { state: "approved" }
    4. On success:
       - For instructions: editor.commands.acceptSuggestion(sId)
         → strips decorations, keeps the new content
       - For other kinds: the card component's onAccept already called
         setValue(...) on the form
       - scrollToNextSuggestion() — find next pending instruction, scroll
         both the card list AND the editor to it
       - Dispatch delayed blur event (250ms + 50ms) to trigger
         avatar/description auto-generation
    5. On failure: rollback optimistic updates
```

### 10.4 The "block no longer exists" case

A user edits their instructions after Sidekick has made suggestions but before they accept.

```
New suggestion arrives from SWR → auto-apply runs
  → InstructionSuggestionExtension.applySuggestion() looks for the target
     data-block-id in the document
  → Not found (user deleted the paragraph, or accepted a prior suggestion
     that replaced it)
  → Returns false
  → SidekickSuggestionsContext catches this, calls PATCH to set state="outdated"
  → Removes from pending cache, adds to outdated cache
  → The card in chat switches to "outdated" visual state (gray)
```

---

## 11. Endpoints summary

Private API (private because they live under `pages/api/w/[wId]/...`, not `pages/api/v1/`):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/assistant/builder/suggestions?agentConfigurationId=...&state=...` | List suggestions, filtered by state/kind |
| `PATCH` | `/assistant/builder/suggestions/[sId]` | Update state (approved / rejected / outdated) |
| `GET` | `/assistant/builder/sidekick/prompt/existing` | Compute the opening message for an existing-agent Sidekick session (includes feedback + insights) |
| `GET` | `/assistant/builder/sidekick/prompt/template` | Compute the opening message for a template-based session |
| `GET` | `/assistant/builder/sidekick/prompt/shrink-wrap` | Compute the opening message for shrink-wrap flow |
| `POST` | `/assistant/conversations` | Create a conversation (used with visibility="test" + SIDEKICK mention) |
| `POST` | `/assistant/conversations/[cId]/messages` | Send a message to Sidekick (with clientSideMCPServerIds) |

All of these are standard Dust conversation/assistant endpoints — Sidekick reuses the normal chat
pipeline and is distinguished by `origin="agent_sidekick"`, `visibility="test"`, and the
`sidekick*` metadata keys.

---

## 12. Key file inventory

### Backend
- `front/lib/api/assistant/global_agents/configurations/dust/sidekick.ts` — agent config + system prompt
- `front/lib/api/assistant/global_agents/sidekick_context.ts` — runtime context injection
- `front/lib/api/actions/servers/agent_sidekick_context/metadata.ts` — backend MCP tool schemas
- `front/lib/api/actions/servers/agent_sidekick_context/tools/index.ts` — backend MCP tool handlers
- `front/lib/api/actions/servers/agent_sidekick_context/constants.ts` — MAX_PENDING_* limits
- `front/lib/api/actions/servers/agent_sidekick_agent_state/` — read-only agent state MCP server
- `front/lib/api/assistant/sidekick_templates.ts` — template data structures
- `front/pages/api/w/[wId]/assistant/builder/sidekick/prompt/existing.ts`
- `front/pages/api/w/[wId]/assistant/builder/sidekick/prompt/template.ts`

### Frontend — Sidekick panel
- `front/components/agent_builder/AgentBuilderSidekick.tsx`
- `front/components/agent_builder/AgentBuilderRightPanel.tsx`
- `front/components/agent_builder/SidekickPanelContext.tsx`
- `front/hooks/useSidekickFirstMessage.ts`

### Frontend — Suggestion state
- `front/components/agent_builder/sidekick/SidekickSuggestionsContext.tsx`
- `front/components/agent_builder/sidekick/SidekickHighlightContext.tsx`
- `front/components/agent_builder/sidekick/SuggestionBubbleMenu.tsx`

### Frontend — Browser MCP server
- `front/components/agent_builder/sidekick/useMCPServer.ts`
- `front/components/agent_builder/sidekick/tools/getAgentConfig.ts`
- `front/lib/client/BrowserMCPTransport.ts`

### Frontend — Markdown cards
- `front/components/markdown/suggestion/SidekickSuggestionCard.tsx`
- `front/components/markdown/suggestion/SidekickSuggestionDirective.tsx`

### Frontend — TipTap extensions
- `front/components/editor/extensions/instructions/BlockIdExtension.tsx`
- `front/components/editor/extensions/instructions/InstructionsRootExtension.tsx`
- `front/components/editor/extensions/agent_builder/InstructionSuggestionExtension.ts`

### Types
- `front/types/suggestions/agent_suggestion.ts` — the discriminated union + zod schemas

---

## 13. Dependencies you'd need in your own project

### Core
- **MCP SDK**: `@modelcontextprotocol/sdk` — both server and client-side `McpServer`.
- **A browser MCP transport.** Dust has a custom `BrowserMCPTransport` in `front/lib/client/`
  that bridges browser → backend → agent over SSE. You'll need an equivalent, or you can
  substitute a direct WebSocket transport.
- **Your own agent runtime.** Dust uses its own agent loop (see `front/temporal/agent_loop/`) with
  SSE-streamed output. The minimum requirement: an agent that can (a) call MCP tools, (b) stream
  markdown responses back to the browser, (c) receive a "client-side MCP server" handle per
  conversation.

### Frontend
- **React 18** + **Next.js Pages Router** (but any React setup works).
- **react-hook-form** for agent builder form state. The `get_agent_config` tool is a thin wrapper
  around `getValues()`. Replace with whatever form library you use.
- **SWR** for suggestion fetching and optimistic mutations. Replaceable with React Query.
- **TipTap** (`@tiptap/react`, `@tiptap/core`, `@tiptap/pm`) — **this is the biggest dependency**.
  The entire block-ID + diff model is built on TipTap/ProseMirror primitives. Specifically:
  - `@tiptap/extension-unique-id` for block IDs.
  - `prosemirror-changeset` for word-level diffs.
  - Custom Node + Plugin extensions for `InstructionsRoot` and `InstructionSuggestion`.
  
  If your editor isn't TipTap, you'll need to replicate:
  1. Stable per-block IDs in the serialized output.
  2. A "find block by ID" + "compute word diff" + "show inline decorations" pipeline.
  3. A "finalize or revert" command for the decorations.

- **react-markdown** + **remark-directive** for parsing the `:agent_suggestion[]{...}` syntax in
  chat responses. This is the cheapest substitution target — any markdown renderer that supports
  custom components works.

### Backend
- **PostgreSQL + Sequelize** (Dust's choice, via a Resource abstraction). Storage for one new
  table: `agent_suggestions` keyed by `sId`, with columns for `kind`, `suggestion` (JSON),
  `state`, `source`, `agentConfigurationId`, `conversationId`, timestamps.
- A **global agent** or equivalent concept in your own agent system, so you can inject a
  well-defined agent into a conversation without DB overhead.
- **Your own knowledge + tool discovery endpoints** — Dust's `get_available_*` tools are thin
  wrappers over internal Resources. Substitute with whatever your system exposes.

---

## 14. Design decisions worth stealing

1. **Block-ID-targeted suggestions over line-numbered patches.** Diffs that target IDs survive
   reformatting and concurrent edits. Line numbers don't.

2. **The `instructions-root` sentinel block.** Needing a single ID to rewrite the whole document
   sounds trivial but simplifies the LLM's API surface significantly — otherwise you'd need a
   separate "replace all" command.

3. **Separate contexts for data and highlight state.** Cheap optimization that matters when you
   have dozens of suggestions and hover-move events firing constantly.

4. **Optimistic drop from SWR + rollback on failure.** Feels instant. The alternative
   (wait-for-server) makes the accept/reject loop feel laggy.

5. **Client-side MCP server for live form state.** The LLM gets real-time visibility into the
   user's unsaved work without the agent having to "know" about react-hook-form. Any agent that
   speaks MCP can read the form.

6. **Prompt-based heavy-work gating.** The `<user_confirmation_before_heavy_work>` section
   successfully stops Haiku from eating tokens on cheap questions. Cheaper than a code-based
   gate, and easier to tune.

7. **NOOP model for the very first turn of a brand-new-from-scratch agent.** Sidekick opens
   with a static "Need a hand?" message that doesn't cost anything. Only when the user actually
   responds does the real model kick in.

8. **Directive echo enforces source-of-truth.** The rule "include the tool output verbatim" means
   the LLM literally cannot hallucinate a suggestion card — every card is backed by a tool call
   that wrote a real DB row. The same rule lets you delete a card by just deleting the row.

9. **Visibility=test conversations.** Sidekick conversations are hidden from the user's normal
   conversation list. They persist (so you can resume), but they don't clutter the UI.

10. **Per-kind MAX_PENDING limits enforced server-side.** 10 for instructions, 3 for
    tools/skills/knowledge, 2 for sub-agents. These stop the agent from doing a 30-item dump.
    The limits live in `agent_sidekick_context/constants.ts` and are hard-wired into the tool
    descriptions so the LLM is told about them.

---

## 15. Things to watch out for when porting

- **The HTML/form race on `instructionsHtml`.** The browser MCP tool sometimes gets called when
  the form has markdown but the TipTap editor hasn't fully serialized its HTML yet. Dust logs
  this to Datadog and returns the best-available data. If you're porting, add the same logging
  and decide whether you want to wait-for-ready or accept the stale state.
- **Duplicate suggestions auto-outdated.** `suggest_tools` / `suggest_skills` /
  `suggest_knowledge` automatically mark any prior pending suggestion for the same target as
  outdated. This is done in the backend tool handler, not the prompt. Without it, the LLM will
  stack three "Add tool X" cards in a row.
- **First-turn MCP server connection race.** The browser MCP server needs a full round-trip to
  register its `serverId` before `get_agent_config` is callable. Dust solves this by sending the
  first message with `clientSideMCPServerIds: []` and relying on the "Step 1" prompt rule (which
  explicitly says "NEVER call it on the first message"). The second message and onwards include
  the server ID. Don't skip this.
- **`assertNeverAndIgnore` in client code** (a Dust-specific coding rule, but a good one): when
  switching on suggestion `kind` or event types in the browser, use an ignore-variant of
  `assertNever` so the server can add a new suggestion kind without crashing older clients.
- **Scope.** Dust's Sidekick also handles templates, feedback, insights, workflow visualization,
  trigger explanations. If you're just starting, cut the scope to `suggest_prompt_edits` +
  `suggest_tools` and grow from there — the core loop is the same.

---

## 16. Minimal build order if you're porting this

If you're implementing this from scratch in your own project, here's the order I'd build in so
you have something working at every step:

1. **DB schema + CRUD** for `agent_suggestions` (kind, payload JSON, state, agentConfigurationId,
   source). List + patch endpoints.
2. **Backend MCP tool `suggest_tools`** (the simplest kind). Creates a row, returns the
   `:agent_suggestion[]{sId=… kind=tools}` directive string.
3. **Frontend: `SidekickSuggestionsContext`** with just `tools` kind. SWR fetch + PATCH.
4. **Frontend: `ToolSuggestionCard`** that wires Accept into a form `setValue` call.
5. **Remark directive + card renderer** to turn the directive into cards in the chat.
6. **Client-side MCP server with `get_agent_config`**. Return the form state as JSON.
7. **Sidekick agent config** — model, system prompt, backend MCP server. The prompt can be a
   trimmed version of the one in this doc.
8. **Panel mount + auto-start first message.** Hardcode the opening line.
9. **Now add `suggest_prompt_edits`.** This is where TipTap matters: add the `BlockIdExtension`
   to your instructions editor. Serialize with `data-block-id`. Let the LLM pick a `targetBlockId`
   from `instructionsHtml`.
10. **Add `InstructionSuggestionExtension`** for inline diff decorations + accept/reject commands.
11. **Add `SidekickHighlightContext` + `SuggestionBubbleMenu`** for hover UX.
12. **Add the other kinds** (`skills`, `model`, `knowledge`, `sub_agent`) one at a time, each
    mirroring `tools`.
13. **Add `get_agent_feedback` / `get_agent_insights` / `search_knowledge`** once the core loop
    works and you want the agent to be smarter about its suggestions.
14. **Add templates + shrink-wrap** if those flows matter to you. They're the optional layer on
    top.

At step 5 you already have a usable Sidekick for tools. At step 11 you have the full experience.
