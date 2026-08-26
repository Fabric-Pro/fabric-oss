# Plan: Patch-based document editing for project-document-generator

## Context

Today, every edit to a project document forces the LLM to rewrite the entire document as a single string argument to `write_document_local`. A recent fix dynamically scales `maxTokens` up to 48K based on doc size (`agents/langchain/project-document-generator/nodes/chat-node.ts:642-652`), but this is a band-aid:

- Models with lower output caps (GPT-4o: 16K, GPT-4.1: 32K) can't accommodate large docs at all.
- Production logs (2026-04-11) show an 83,739-char document getting silently compressed to ~57,157 chars per edit because the model couldn't reproduce all ~21K output tokens within a 16K cap. Users experienced features being deleted when asking to add them.
- Even after the fix, output tokens are proportional to document size, so latency and cost grow linearly with every edit.

**Goal:** Replace full-document rewrites with targeted patch operations. The LLM emits a small list of edits (replace section X, insert after anchor Y, fix typo in section Z) and the agent server applies them server-side to the stable baseline. Output tokens drop from ~20K to ~2K per edit, eliminating the truncation bug entirely and cutting edit latency 5–20×.

**Scope:** `project-document-generator` only for this plan. `document-generator` and `prompt-enhancer` are follow-ups once the applier proves out — the applier module is designed to be reusable.

## Design summary

This direction is validated by prior art captured in `docs/research/2026-04-10-research-document-editing.md`. Notion's production API, Aider, and Waleed Kadous's "Edit Trick" all converge on the same pattern: generate minimal diffs instead of full rewrites, anchor on text (not line numbers), and apply deterministically on the server. Aider's public measurements: **~86% fewer output tokens, ~79% faster, ~69% cheaper** vs. full rewrites. Our design follows this lineage with heading-path anchors for a section-oriented markdown corpus.

- **Edit primitive:** heading-anchored patches. Anchors are full heading paths with ` > ` separators (e.g., `## Requirements > ### Must Have`), which naturally handles arbitrary nesting and repeated heading text at different parents. Explicitly **not** line numbers — the referenced research notes that "LLMs handle text context far more reliably than numeric line references" (a point OpenAI Codex's patch format also enforces).
- **Ops:** `replace_section`, `insert_after`, `insert_before`, `append_to_section`, `prepend_to_section`, `delete_section`, `replace_text` (the last is critical for inline typo/phrasing fixes so users don't fall back to full rewrites).
- **Single tool call with a patches array.** Anchors are resolved against the **original** baseline (never a mutating buffer), then overlap-checked, then applied in one pass. All-or-nothing: any failure returns the original doc plus a full error list. Aider's finding that **"high-level diffs outperform surgical line-by-line edits"** — section-level ops produce 30–50% fewer errors than character-level precision — reinforces our choice to operate at section granularity, not line ranges.
- **Matching fallback cascade (Aider pattern).** Both anchor resolution and `replace_text` matching use: exact match → whitespace-normalized match → error with closest-match suggestions (Levenshtein for anchors, unique substring neighborhood for text). No fuzzy/regex matching — stays deterministic, keeps errors attributable.
- **Server assembles the patched document and writes it into `state.document` as a plain string.** The AG-UI streaming protocol, the frontend `useCoAgent` subscription, the diff-utils pipeline, the tiptap DiffInsert/DiffDelete marks, and the confirm_changes modal all work unchanged. This is the "sketch → apply" separation Cursor uses for code editing: the LLM decides *what* to change, deterministic code decides *how* to apply it.
- **Input-vs-output token scope.** This plan fixes **output-token** truncation only. Input tokens are unchanged — the full document still travels to the model once per turn in the `<fabric_source_document>` user message (see PR #441 relocation). For the Fabric corpus size range (typical 10–100K chars, worst case ~200K), input size is not the bottleneck. Progressive input-side context loading via an on-demand `read_section` tool is a deferred optimization (see Deferred decisions).
- **Tradeoff:** live "typing" mid-stream goes away (predict_state is disabled in patch mode — it can't merge JSON array deltas). The user sees a short "Applying changes…" spinner, then the full diff appears at once. In exchange, edits complete in 1–3 seconds instead of 20–60 seconds.
- **Fallback:** `write_document_local` is preserved for new documents, regeneration, and small docs (< 4,000 chars). The chat node binds exactly one document tool per request; the model never sees both.

## File-by-file changes

Ordered so each step is independently compilable.

### 1. NEW — `packages/agent-prompts/src/core/document-patches.ts`

Pure applier module. No LangGraph / agent-core dependencies. Reuses `parseHeadings` from `packages/agent-prompts/src/validation/markdown-parser.ts:27`. Exports:

```ts
export type PatchOp =
  | "replace_section"
  | "insert_after"
  | "insert_before"
  | "append_to_section"
  | "prepend_to_section"
  | "delete_section"
  | "replace_text";

export interface DocumentPatch {
  op: PatchOp;
  anchor: string;        // Full heading path: "## Requirements > ### Must Have"
  content?: string;      // Required for ops except delete_section and replace_text
  find?: string;         // replace_text only
  replace?: string;      // replace_text only
  keepHeading?: boolean; // replace_section only — default true
}

export interface PatchError {
  patchIndex: number;
  op: PatchOp;
  anchor: string;
  code:
    | "anchor_not_found"
    | "anchor_ambiguous"
    | "missing_content"
    | "missing_find_replace"
    | "find_not_in_section"
    | "find_ambiguous_in_section"
    | "overlapping_ranges"
    | "malformed_anchor"
    | "unsupported_op";
  message: string;
  suggestions?: string[]; // Closest valid anchor paths
}

export interface ApplyPatchesResult {
  success: boolean;
  result: string;        // Original on any failure; patched doc on success
  errors: PatchError[];
  appliedCount: number;
}

export function resolveAnchor(
  markdown: string,
  anchor: string,
): { startLine: number; endLine: number; level: number; text: string } | PatchError;

export function listAnchorPaths(markdown: string): string[];

export function validatePatches(
  markdown: string,
  patches: DocumentPatch[],
): { valid: boolean; errors: PatchError[] };

export function applyPatches(
  markdown: string,
  patches: DocumentPatch[],
  options?: { sanitizeContent?: (content: string) => string },
): ApplyPatchesResult;
```

**Implementation notes:**

- Build an internal `flattenHeadingsWithRanges(headings, totalLines)` helper that computes each heading's `endLine` as "one line before the next heading of equal or shallower level" (the existing `parseSections` only flattens H2 roots — don't alter it).
- **Anchor matching cascade** (Aider pattern): for each segment in a path, try in order:
  1. Exact match on the trimmed heading text.
  2. Whitespace-normalized match (collapse runs of whitespace, strip trailing punctuation like `:` or `.`).
  3. If still zero matches → `anchor_not_found` with Levenshtein-nearest siblings at the expected level as suggestions.
  4. If the segment yields multiple matches under the current parent → `anchor_ambiguous` with `suggestions` = full paths of every match so the model can retry with a deeper path.
- Path parsing: split on ` > `, then each segment must match `^#{1,6}\s+(.+)$`. Walk the heading tree collecting candidates level-by-level scoped to the already-matched parent. This naturally handles repeated text like two `### Overview`s as long as they have different parents.
- **`replace_text` matching cascade**: resolve the anchor, slice the section body, then try in order:
  1. Literal `indexOf(find)` — zero matches? drop to step 2. One match? splice it in. Two or more? → `find_ambiguous_in_section` with line numbers of each hit.
  2. Whitespace-normalized `indexOf` on a normalized view of the section (same whitespace collapse as anchors, plus normalize CRLF/LF). If the normalized search finds exactly one match, map the position back to the original string and splice.
  3. If still zero → `find_not_in_section` with 2–3 nearest substring candidates (using a simple trigram-overlap score, no dependency needed).
  Never a regex. Never truly fuzzy string matching. The whole point is determinism.
- All anchors resolved against the untouched baseline, producing `(startLine, endLine, op)` tuples. Sort by `startLine`. Check overlaps (`insert_after` / `insert_before` at a boundary are allowed). Walk the baseline line-by-line once, emit unedited lines, splice replacement content at each boundary. One pass, deterministic, order-independent for non-overlapping patches.
- `options.sanitizeContent` runs over every `content` and `replace` string before splicing (lets `chat-node.ts` pass in the `stripToolDefinitions`-per-patch hook without the applier depending on it).
- Applier is self-contained — no external diff libraries (`diff-match-patch`, `jsdiff`) needed. Those are for free-form text diffing; our ops are structured section operations against a markdown AST, and the matching cascade above handles the only fuzzy case (`replace_text`) deterministically. Adding a diff library would trade a ~50-line helper for an ~80KB dependency with its own edge cases.

### 2. NEW — `packages/agent-prompts/src/core/__tests__/document-patches.test.ts`

Table-driven unit tests. One case per behavior:

- Each op type succeeds against a canonical fixture doc.
- `replace_section` preserves the heading by default; `keepHeading: false` replaces it.
- Repeated H3 text under different H2 parents disambiguates via path.
- Ambiguous anchor returns error with all matching full paths in `suggestions`.
- Missing anchor returns error with Levenshtein suggestions.
- **Anchor whitespace fallback**: a path like `## Requirements  > ###  Must Have` (extra whitespace) resolves to the correct section.
- **Anchor trailing-punctuation fallback**: `## Overview:` (heading with stray colon) resolves to `## Overview`.
- `replace_text` errors on zero matches inside the section with nearest-substring suggestions.
- `replace_text` errors on multiple literal matches with line numbers.
- `replace_text` whitespace-normalized fallback: `find` string with different whitespace than the source successfully splices back to the original positions.
- `replace_text` with CRLF-normalized input and LF-only `find` (or vice versa) resolves correctly.
- Two patches with overlapping ranges → `overlapping_ranges` on the second.
- Multi-patch call resolves all anchors against the original baseline (regression test for mutate-as-you-go bug).
- Applied output is identical regardless of input patch order (for non-overlapping cases).
- `sanitizeContent` hook runs on every content field.
- Failure in any patch → original document returned unchanged, full error list.
- Deep nesting (H2 → H3 → H4) works.
- `validatePatches` returns errors without mutating.

### 3. EDIT — `packages/agent-prompts/src/validation/markdown-parser.ts`

Add a single helper at the bottom (do not modify existing functions):

```ts
export function listAnchorPaths(markdown: string): string[]
```

Returns `["## Overview", "## Overview > ### Problem", "## Overview > ### Goals", ...]`. Uses `parseHeadings` internally. About 15 lines.

### 4. EDIT — `packages/agent-prompts/src/core/index.ts` and `packages/agent-prompts/src/index.ts`

Re-export everything from `./document-patches` through the existing barrels so chat-node can `import { applyPatches, type DocumentPatch } from "@repo/agent-prompts"`.

### 5. EDIT — `packages/agent-tools/src/index.ts`

Add `APPLY_DOCUMENT_PATCHES_TOOL` alongside `WRITE_DOCUMENT_TOOL` (around line 68, framework-agnostic `ToolDefinition` shape). Schema mirrors the `DocumentPatch` type: a `patches: array` with per-item `op` enum, `anchor`, `content`, `find`, `replace`, `keepHeading` fields plus a top-level optional `focusAnchor`. Description tells the model:

- Use this **instead of** rewriting the full document.
- Each patch references a section by its **full heading path** with ` > ` separators.
- All anchors resolve against the **current** document (not prior patches).
- `content` should be **only** the new markdown, never surrounding text.
- Do not use italic or `~~strikethrough~~` (reserved for diff highlighting).

Leave `WRITE_DOCUMENT_TOOL` untouched — other agents still use it.

### 6. EDIT — `packages/agent-prompts/src/core/tool-instructions.ts`

Add a `toolMode: "write" | "patch"` parameter (default `"write"`) to `buildToolInstructionsWithoutFormatting`. When `toolMode === "patch"`:

- **Omit** the `## Content Preservation Rules` block and the `## Tool Usage` table that mentions `write_document_local`.
- **Emit** a compact "Patch-Based Editing" block instead, covering: how to form anchor paths, the operation catalog as a "User intent → op" table, rules (content is only new/replacement markdown, anchors resolve against the current doc, no italic or strikethrough, `find` must be unique in its section), and a note that the available anchor paths are listed below.

### 7. EDIT — `packages/agent-prompts/src/builders/unified-prompt-builder.ts`

- Add `toolMode?: "write" | "patch"` to `UnifiedPromptOptions` (around line 54).
- Thread `toolMode` through to `buildToolInstructionsWithoutFormatting`.
- In `buildEditingRules` (around line 766), when `toolMode === "patch"`, render the heading list as **full anchor paths** via `listAnchorPaths(existingDocument)` instead of raw heading texts, so the model picks up the ` > ` format from concrete examples.

### 8. EDIT — `agents/langchain/project-document-generator/prompts/index.ts`

Accept a `toolMode` option in `buildSystemPromptAsync` and `buildSystemPrompt`, and pass it through to `buildUnifiedSystemPrompt`. About 10 lines changed.

### 9. EDIT — `agents/langchain/project-document-generator/nodes/chat-node.ts`

Minimal surgical diff. Do not rewrite the file.

**Near the top (around existing imports, line 30):**
```ts
import { APPLY_DOCUMENT_PATCHES_TOOL, WRITE_DOCUMENT_TOOL } from "@repo/agent-tools";
import {
  applyPatches,
  listAnchorPaths,
  type DocumentPatch,
} from "@repo/agent-prompts";
```

**After `isEditing` is computed (around line 534):**
```ts
const PATCH_MODE_MIN_DOC_CHARS = 4000;
const patchModeAvailable =
  isEditing && !state.isRegeneration && preEditDocument.length >= PATCH_MODE_MIN_DOC_CHARS;
```

Gate is *not* coupled to `state.systemPrompt` — custom prompts work fine with patches because the custom prompt defines *format preferences*, not edit semantics.

**Pass `toolMode` into the prompt builder call (around line 535):**
```ts
let contextualPrompt = await buildSystemPromptAsync(
  state.systemPrompt,
  state.documentType,
  state.projectContext,
  state.ragContexts,
  existingDocForPrompt,
  { excludeDocumentBody: isEditing, toolMode: patchModeAvailable ? "patch" : "write" },
);
```

**Swap maxTokens for patch mode (replace the dynamic formula around line 642–652):**
```ts
const computedMaxTokens = patchModeAvailable
  ? 6000 // ~30 patches worth of content; patches are small
  : Math.min(48000, Math.max(16000, Math.ceil(preEditDocument.length / 3) + 4000));
```

**Disable predict_state in patch mode (around line 677):**
```ts
runnableConfig.metadata.predict_state = patchModeAvailable ? [] : getPredictStateConfig();
```

`state.document` stays at `preEditDocument` throughout the model call; the frontend's `Effect 3` sees no change and the editor holds the baseline until the final STATE_SNAPSHOT arrives with the patched result.

**Swap the bound tool (around line 692):**
```ts
const documentTool = patchModeAvailable ? APPLY_DOCUMENT_PATCHES_TOOL : WRITE_DOCUMENT_TOOL;
const tools: any[] = [...copilotKitTools, documentTool];
const boundToolNames = [
  ...copilotKitActions.map((a: any) => a.name || "unknown"),
  documentTool.function.name,
];
```

**Extract a helper for the existing `confirm_changes` emission (lines ~1354–1407) into a local function `buildConfirmChangesCommand(state, messages, toolCall, document, response)`** so both handlers can share it. Pure refactor, no behavior change.

**Add a parallel branch for the new tool, right after the `write_document_local` handler (around line 1407, before the external-tool fall-through at line 1410):**
```ts
if (toolCall.name === "apply_document_patches") {
  const patches = toolCall.args?.patches as DocumentPatch[] | undefined;

  if (!Array.isArray(patches) || patches.length === 0) {
    // Mirror the empty-args retry from the write_document_local handler (lines 1212–1253)
    // with an error message specific to apply_document_patches.
  }

  const sanitizeContent = (content: string) =>
    stripToolDefinitions(content, preEditDocument);

  const { success, result, errors, appliedCount } = applyPatches(
    preEditDocument,
    patches,
    { sanitizeContent },
  );

  if (!success) {
    if (state.retryCount < MAX_RETRIES) {
      const anchors = listAnchorPaths(preEditDocument);
      const errorSummary = errors
        .map((e) => `- patch[${e.patchIndex}] (${e.op}, anchor="${e.anchor}"): ${e.message}${
          e.suggestions?.length ? `\n  Did you mean: ${e.suggestions.slice(0, 3).join(", ")}` : ""
        }`)
        .join("\n");

      const correctionMessage = new ToolMessage({
        content:
          `Your apply_document_patches call failed:\n${errorSummary}\n\n` +
          `Valid anchors in this document (first 20):\n` +
          `${anchors.slice(0, 20).map((a) => `- ${a}`).join("\n")}\n\n` +
          `Retry with corrected anchors. Use the full heading path including ` +
          `parent headings, e.g. "## Requirements > ### Must Have".`,
        tool_call_id: toolCall.id || uuidv4(),
      });

      return new Command({
        goto: "chat_node" as typeof END,
        update: {
          messages: [...messages, correctionMessage],
          retryCount: state.retryCount + 1,
        },
      });
    }

    // Retries exhausted — surface a user-facing error and leave the doc unchanged.
    const errText = `Failed to apply patches after ${MAX_RETRIES} attempts. The document is unchanged.`;
    return new Command({
      goto: END,
      update: {
        messages: [...state.messages, { role: "assistant" as const, content: errText }],
        error: errText,
        retryCount: 0,
      },
    });
  }

  // Successful application — run the existing validation block (non-blocking)
  // and reuse the confirm_changes helper.
  const document = result;
  logger.info("[Project Document Generator] Patches applied", {
    patchCount: patches.length,
    appliedCount,
    beforeLength: preEditDocument.length,
    afterLength: document.length,
    mode: "patch",
  });

  // Run validateDocument (same pattern as lines 1297–1348), non-blocking.
  return buildConfirmChangesCommand(state, messages, toolCall, document, response);
}
```

The external-tool fall-through (line 1410+, routing to `tool_node` for `search_teams_messages` etc.) stays unchanged.

### 10. EDIT — `agents/langchain/project-document-generator/__tests__/chat-node.test.ts`

Add a `describe("Patch Mode")` block using the existing mock harness (which mocks `getAgentModelAsync`, `buildSystemPrompt`, `convertActionsToDynamicStructuredTools`). Cases:

- Binds `apply_document_patches` when editing a doc ≥ 4K chars.
- Binds `write_document_local` for new documents.
- Binds `write_document_local` when `isRegeneration=true`.
- Binds `write_document_local` for small docs.
- Successful patch call returns a Command with `update.document` matching the applied result and a `confirm_changes` tool call in the messages.
- Failed patch call (anchor not found) returns `goto: "chat_node"`, `retryCount: 1`, and a ToolMessage whose content includes the valid-anchor hint and the failing patch's index.
- After MAX_RETRIES patch failures, returns `goto: END` with a user-facing error message.
- `sanitizeContent` hook receives each patch's content and its output ends up in the applied document.
- Patch mode sets `maxTokens: 6000` and `predict_state: []` on the runnable config.

Return canned AIMessages with `tool_calls: [{ name: "apply_document_patches", args: { patches: [...] } }]` from the mocked model invocation and assert on the returned `Command`. No live LLM.

### 11. EDIT — `apps/web/modules/saas/agents/components/DocumentGeneratorEditor.tsx`

One derived value + one string swap. No structural changes.

```tsx
const isPatchMode =
  isLoading &&
  nodeName === "chat_node" &&
  (agentState?.document ?? "") === baselineRef.current;

// In the loading pill (around line 441):
<span className="...">
  {isPatchMode ? "Applying changes..." : "AI is generating..."}
</span>
```

Rationale: in patch mode, `state.document` does not change mid-stream (predict_state is off), so `document === baseline` is a reliable signal. This differentiates the UX cue without any new agent state plumbing.

Per react-best-practices, `isPatchMode` is a derived value computed during render (not stored in state) and only flips twice per request.

## Key files and line numbers

- `agents/langchain/project-document-generator/nodes/chat-node.ts` — insertion points at 534 (patch-mode flag), 535 (prompt call), 642–652 (maxTokens), 677 (predict_state), 692 (tool array), 1407 (new handler branch before the external-tool fall-through)
- `packages/agent-tools/src/index.ts:68` — add `APPLY_DOCUMENT_PATCHES_TOOL` alongside `WRITE_DOCUMENT_TOOL`
- `packages/agent-prompts/src/core/document-patches.ts` — NEW, the applier module
- `packages/agent-prompts/src/core/__tests__/document-patches.test.ts` — NEW, table-driven unit tests
- `packages/agent-prompts/src/validation/markdown-parser.ts:27` — existing `parseHeadings` reused; add `listAnchorPaths` helper here
- `packages/agent-prompts/src/core/tool-instructions.ts` — `toolMode` parameter + new patch-mode instruction block
- `packages/agent-prompts/src/builders/unified-prompt-builder.ts:54` — thread `toolMode` through `UnifiedPromptOptions`; in patch mode render `listAnchorPaths` in `buildEditingRules` (~line 766)
- `agents/langchain/project-document-generator/prompts/index.ts:430` — accept and forward `toolMode`
- `agents/langchain/project-document-generator/__tests__/chat-node.test.ts` — extend existing mock harness with a Patch Mode describe block
- `apps/web/modules/saas/agents/components/DocumentGeneratorEditor.tsx` — derived `isPatchMode` + pill copy swap

## Existing utilities to reuse

- `parseHeadings(markdown)` at `packages/agent-prompts/src/validation/markdown-parser.ts:27` — do not reinvent heading parsing.
- `stripToolDefinitions(raw, baseline)` at `agents/langchain/project-document-generator/nodes/chat-node.ts:107–214` — pass it in as the `sanitizeContent` hook on `applyPatches`, scoped per-patch instead of per-full-document.
- The existing empty-args retry pattern at `chat-node.ts:1212–1253` — copy its shape for the empty-patches and failed-validation retries.
- The existing `confirm_changes` emission at `chat-node.ts:1354–1407` — extract into a `buildConfirmChangesCommand` helper so both tool handlers share it.
- The existing `validateDocument` validation block at `chat-node.ts:1297–1348` — run it unchanged after patches are applied (it operates on the final document string).
- Frontend diff pipeline (`diffPartialText`, `fromMarkdown`, `DiffInsert`/`DiffDelete` marks, `stripDiffTags`, ConfirmChanges modal) — all untouched. They read `state.document` as a plain string and don't care how it was produced.

## Rollout

**This plan covers Phase 1 only.** Phase 2 is a post-ship ops action (not new code); Phase 3 is explicitly out of scope and will get its own plan.

Hard switch. No env var or feature flag.

- Chat node branches on `patchModeAvailable` per request. Fallback to `write_document_local` is still fully present for regeneration, new docs, and small docs.
- Any patch-validation failure that exhausts retries surfaces a user-facing error and leaves the baseline untouched — rollback is a single revert commit.

### Phase 1 — **in scope for this plan**

Ship everything in the File-by-file changes section: the applier module, unit tests, the new tool definition, prompt-builder `toolMode` threading, chat-node surgical diff, chat-node integration tests, and the frontend pill copy change. Threshold = 4,000 chars. Target: `project-document-generator` agent only.

### Phase 2 — post-ship ops (no new code, tracked separately)

After ~1 week of production metrics, tune the `PATCH_MODE_MIN_DOC_CHARS` constant based on the metrics table below:

- If retry rate stays ≤5% and reject rate is flat → lower the threshold to 2,000 chars to expand coverage.
- If retry rate exceeds 10% or reject rate rises vs. baseline → raise the threshold to 8,000 or roll back.

This is a single-line constant change, not an implementation task. Track as a follow-up operational ticket, not part of this plan.

### Phase 3 — **explicitly out of scope for this plan**

Porting the applier to `document-generator` (identical `getPredictStateConfig`) and `prompt-enhancer` (different tool name and state keys) is a follow-up. Do not ship it as part of this plan. Reasons:

1. Validating the applier on one agent in production before copying it to two more isolates risk.
2. Each additional agent has its own test suite and state shape to verify.
3. The applier is already designed for reuse (lives in `@repo/agent-prompts`, framework-agnostic tool in `@repo/agent-tools`), so Phase 3 becomes cheap once Phase 1 is proven.

Open a separate plan for Phase 3 after Phase 1 has run in production for ≥1 week with stable metrics.

## Metrics to watch (App Insights)

Add structured fields to the existing `logger.info` calls in the new handler so they flow into the production App Insights workspace automatically. Targets below are calibrated to Aider's public "Edit Trick" numbers (86% fewer output tokens, 79% faster, 69% cheaper) — if we don't see roughly these gains, something is mis-wired:

| Metric | Field | Target |
|---|---|---|
| Adoption rate | `mode: "patch" \| "write"` on every tool call | ≥70% of edits in patch mode after 1 day |
| Patch count per call | `patchCount` | median 1–3, p95 < 10 |
| Retry rate | count of "Retrying with corrective tool message" in patch mode | ≤5% of patch-mode calls |
| Output token savings | `outputTokens` from existing usage logging | median patch-mode output **≤14% of write-mode** (≈2,000 vs. ≈14,000 tokens for typical docs) |
| Latency | wall-clock from model invoke to confirm_changes | median patch-mode ≤25% of write-mode baseline |
| Failure rate | count of "Failed to apply patches after MAX_RETRIES" | <1% of patch-mode calls |
| User reject rate | existing `confirm_changes` telemetry, sliced by mode | ≤ baseline write-mode reject rate |

Example KQL:
```kql
customEvents
| where timestamp > ago(1h)
| where name in ("[Project Document Generator] Patches applied", "[Project Document Generator] Document written")
| extend mode = iff(name contains "Patches", "patch", "write")
| summarize calls = count(), avgOut = avg(toint(customMeasurements.outputTokens)) by mode
```

## Verification

### Local

1. `pnpm --filter @repo/agent-prompts test` — applier unit tests pass.
2. `pnpm --filter project-document-generator-agent test` — chat-node integration tests pass.
3. `pnpm --filter @repo/agent-prompts build && pnpm --filter @repo/agent-tools build && pnpm --filter project-document-generator-agent build` — all three packages build clean.
4. Start the agent (`pnpm --filter project-document-generator-agent dev`), start the web app (`pnpm --filter web dev`), open a project document ≥4K chars in `/app/[org]/projects/[projectId]/documents/[docId]`.
5. In the sidebar chat: "Add a new stakeholder named Alice to the Stakeholders section."
6. Expect:
   - Editor holds the baseline until the model returns (no mid-stream flicker).
   - "Applying changes…" pill shown.
   - Diff appears once, highlighting only the Stakeholders section.
   - ConfirmChanges modal appears. Accept → editor shows clean final state. Reject → editor reverts cleanly.
7. Container logs include `mode=patch`, `patchCount≈1`, `appliedCount=1`, `beforeLength≈8000`, `afterLength≈8050`, `maxTokens=6000`, `predict_state=[]`.

### Failure path (mocked)

In `chat-node.test.ts`, mock an AIMessage with a patch whose anchor is `"## Nonexistent Section"`. Assert the returned Command has `goto: "chat_node"`, `retryCount: 1`, and a ToolMessage whose content mentions `anchor_not_found` and lists valid anchors.

### Production verification

After deploy, run in the production App Insights workspace:

```kql
// Adoption
customEvents
| where timestamp > ago(1h)
| where name in ("[Project Document Generator] Patches applied", "[Project Document Generator] Document written")
| summarize patch = countif(name contains "Patches"), write = countif(name contains "Document written")
| extend adoption_pct = 100.0 * patch / (patch + write)

// Output tokens
traces
| where timestamp > ago(1h)
| where cloud_RoleName == "fabric.project_document_generator"
| where message has "Patches applied" or message has "Document written"
| extend mode = iff(message has "Patches", "patch", "write")
| extend outputTokens = toint(customDimensions.outputTokens)
| summarize avg(outputTokens), percentile(outputTokens, 50), percentile(outputTokens, 95) by mode

// Retry rate
traces
| where timestamp > ago(1h)
| where cloud_RoleName == "fabric.project_document_generator"
| where message has "Retrying with corrective tool message"
| summarize count() by bin(timestamp, 5m)
```

"Good" baseline: ≥70% patch-mode adoption within 1 hour of deploy on active projects, `p50(outputTokens)` in patch mode < 2,000, retry rate <5%, zero MAX_RETRIES exhaustions.

## Risks

| Risk | Mitigation |
|---|---|
| Model emits anchors with whitespace/punctuation mismatches | Applier normalizes whitespace before matching; retry loop with valid-anchor hint |
| `replace_text` matches an unintended substring | `find` must be unique within the anchored section; zero/multi occurrences error out |
| Overlapping patches corrupt the document | Explicit range-overlap detection before application; all-or-nothing apply |
| Model emits excessive patches (50+) | Soft `maxTokens: 6000` caps output; log `patchCount` and alert on p95 > 15 |
| Frontend diff pipeline breaks on nested lists / code fences in patch outputs | Existing `diff-utils.ts` already handles fence/table extraction (PR #462); add snapshot test |
| First STATE_SNAPSHOT is stale until the end → user sees no-change editor for 1–3s | "Applying changes…" pill makes intent obvious; regression vs. live typing is acceptable for 20× latency win |
| LLM providers respond differently to the new tool schema | Standard JSON schema, tested against Claude / GPT-4o / Gemini via existing model routing |
| Baseline vs. applied divergence from per-patch `stripToolDefinitions` | Unit test the `sanitizeContent` hook; keep baseline argument passed through for strike-preservation logic |

## Decisions deferred

- **Ports to `document-generator` and `prompt-enhancer`** — explicitly excluded from this plan (see Rollout → Phase 3). Both share the `getPredictStateConfig` pattern; porting is ~90% copy-paste once Phase 1 is proven. Separate plan to be opened after Phase 1 has ≥1 week of stable prod metrics.
- **Progressive per-patch streaming.** Not worth the LangGraph refactor; revisit if user latency feedback demands it. The "Applying changes…" pill is our stand-in.
- **Occurrence-index anchors** like `"## Overview[2]"` for pathological docs with duplicated top-level sections. Future iteration if it actually comes up; for now the error message directs the model to disambiguate by parent path.
- **A/B testing infrastructure** via a per-thread `patchMode=false` query flag. Skip for MVP — the hard switch is safe because `write_document_local` is always available as a fallback.
- **Progressive input-side context loading** (the research doc's "search-then-edit" pattern with a `read_section` tool). Would let us send an outline + targeted sections instead of the full doc as input. Important for documents beyond ~200K chars, but Fabric's typical project docs are 10–100K. Defer until we see projects pushing that bound, or until input-side cost becomes a concern. When we do, the shape: index the doc at ingestion with stable section IDs + embeddings, expose `search_document` and `read_section` tools to the agent, and drop the full-doc user message in favor of on-demand retrieval.
- **Cross-reference consistency checks.** The research doc suggests building a dependency graph of term/section references at index time and flagging affected sections after any edit. Valuable for long-lived PRDs with tight cross-references; out of scope for the MVP fix. Defer until users report stale references.
- **`diff-match-patch` / `jsdiff` integration.** Considered for fuzzy matching in `replace_text`; rejected for MVP because our matching cascade (exact → whitespace-normalized → error with suggestions) is deterministic and much smaller. Revisit only if we observe frequent near-miss retries where a fuzzy match would have succeeded.
- **`editSource: "human" | "ai"` metadata on tiptap nodes.** The research suggests tagging every edit with its origin for UI differentiation and granular undo. We currently treat each AI confirmation as one atomic accept/reject. Defer.
