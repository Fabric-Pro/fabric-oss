/**
 * Shared types for the Excalidraw chat -> editor auto-insert feature.
 *
 * This module is intentionally zero-runtime: every export is either a
 * pure type, or a `readonly` array of string literals (`as const`). No
 * React imports, no side effects, no class definitions. The downstream
 * components, hooks, and tests all import their enum literals from this
 * file so the string-literal union stays the single source of truth.
 *
 * Spec sections covered:
 *   - § 7.1   `Diagram` shape + procedure pseudocode (surface enum)
 *   - § 8     UI component table (chat surface + render contract)
 *   - § 9     Active-editor resolution algorithm (resolver target shape)
 *   - § 12    Telemetry events (blocked-reason union)
 */
import type { Editor } from "@tiptap/react";

/**
 * The four chat surfaces that can produce an Excalidraw `create_view`
 * tool result. Matches spec § 7.1 / § 8 / § 12 verbatim; do NOT rename
 * or reorder without updating the matching `surface` label on the
 * Prometheus counter and on the `useChatScopedProject*` adapters.
 *
 * - `nexus`        Multi-agent stream surface at `/app/{slug}/copilot`.
 * - `loom`         Loom orchestrator chat (`FabricTemporalOrchestratorChat`).
 * - `in-feature`   The in-feature AI Assistant (`FabricDirectChat`) opened
 *                  from a story workspace.
 * - `in-document`  The in-document Copilot sidebar
 *                  (`CopilotAssistantMessage`) opened on a document page.
 */
export type ChatSurface = "nexus" | "loom" | "in-feature" | "in-document";

/**
 * The two kinds of targets the resolver can return. A document is a
 * project document (`DocumentEditor.tsx`); a story is a feature
 * workspace (`StoryWorkspace.tsx`). Both mount a TipTap `Editor` and
 * both register themselves with the `TiptapEditorRegistry`.
 */
export type ResolverTargetKind = "document" | "story";

/**
 * The target the resolver hands back to the button click handler. The
 * caller already holds a project scope; the resolver narrows that to a
 * specific on-page editor (in the happy path) or returns `null` to
 * signal that the picker dialog should open instead.
 *
 * The `editor` field is the TipTap `Editor` instance to insert the
 * `<excalidraw-embed>` node into. The optional `documentId` / `storyId`
 * are mutually exclusive — one is set per `kind`. `documentLabel` is the
 * already-formatted title used in the success toast and the button copy.
 */
export type ResolverTarget = {
	kind: ResolverTargetKind;
	editor: Editor;
	projectId: string;
	documentLabel: string;
	documentId?: string;
	storyId?: string;
};

/**
 * Reasons the button can be rendered in a blocked (disabled / hidden)
 * state. Used by the `diagram_auto_insert_blocked` telemetry event
 * and by the disabled-state tooltip copy.
 *
 * - `cross_project`      Chat is scoped to project A; the page editor
 *                        belongs to project B. Disabled with tooltip.
 * - `no_edit_permission` Target editor's project denies the current
 *                        user `DOCUMENT_UPDATE` / `FEATURE_UPDATE`. Falls
 *                        back to the "Save to Diagrams" secondary action.
 * - `personal_scope`     Chat is in personal context (no organization).
 *                        Button is hidden entirely (spec § FR-13).
 *
 * Historical note: a `flag_off` reason existed while the feature was
 * gated by `FABRIC_EXCALIDRAW_AUTO_INSERT*` env vars; the flag was
 * removed before merge and the feature ships globally on.
 */
export type BlockedReason =
	| "cross_project"
	| "no_edit_permission"
	| "personal_scope";
