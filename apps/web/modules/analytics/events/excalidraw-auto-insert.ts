/**
 * Typed telemetry-event registry for the Excalidraw chat -> editor
 * auto-insert feature.
 *
 * Today the analytics provider at
 * `apps/web/modules/analytics/provider/custom/index.tsx:10-25` is a
 * `console.info` shim that accepts `Record<string, unknown>` for the
 * event payload. When a real provider lands later (Follow-up #5 in
 * spec § 20), this file becomes the source of truth for the event
 * names and the typed property shape — so casing and naming are
 * locked NOW even though the shim does not enforce them yet.
 *
 * Spec § 12 lists every name + property registry verbatim. Do not
 * rename a name here without updating the spec, the staged-rollout
 * dashboards (`diagram_auto_inserted_total` Prometheus counter), and
 * every fire-point in the UI components.
 *
 * Pure module — no React imports, no side effects. Consumed by:
 *   - `useInsertDiagramAction.ts`             (success / fail / blocked / nav)
 *   - `InsertDiagramPickerDialog.tsx`         (picker open / pick / timeout)
 *   - `ChatMessageInsertDiagramButton.tsx`    (copy / copy-fail / flag-enabled)
 *   - `usePickerIntentConsumer.ts`            (picker timeout)
 */
import type {
	BlockedReason,
	ChatSurface,
} from "@saas/projects/components/excalidraw-auto-insert/types";

/**
 * The full list of telemetry-event names emitted by the auto-insert
 * feature. Locked by spec § 12. Order matches the spec's table for
 * easy diff-review.
 *
 * Frozen via `as const` so it is a `readonly` tuple of literal strings —
 * lets `ExcalidrawAutoInsertEvent` be a precise union, and lets tests
 * assert exact membership.
 */
export const EXCALIDRAW_AUTO_INSERT_EVENTS = [
	"diagram_auto_inserted",
	"diagram_auto_insert_failed",
	"diagram_chat_to_editor_navigated",
	"diagram_auto_insert_blocked",
	"diagram_auto_insert_picker_opened",
	"diagram_auto_insert_picker_picked",
	"diagram_auto_insert_picker_timeout",
	"diagram_embed_code_copied",
	"diagram_embed_code_copy_failed",
	"diagram_auto_insert_detected_existing",
] as const;

/** Union of every auto-insert telemetry event name. */
export type ExcalidrawAutoInsertEvent =
	(typeof EXCALIDRAW_AUTO_INSERT_EVENTS)[number];

/**
 * Failure-class label used on `diagram_auto_insert_failed`. The four
 * values map to the rows of spec § 11 Error Matrix:
 *   - `mcp`        Tool call to MCP failed before the chat message rendered.
 *   - `db`         `createFromChatProcedure` returned 5xx (Prisma error).
 *   - `forbidden`  Procedure returned FORBIDDEN (flag off / personal scope /
 *                  permission denied).
 *   - `editor`     `editor.commands.insertContentAt` threw despite the row
 *                  being saved (caught + surfaced as the inline banner).
 */
type DiagramAutoInsertFailureClass = "mcp" | "db" | "forbidden" | "editor";

/**
 * Target kind on a picker-pick event or a successful insertion. Matches
 * the `ResolverTargetKind` in `./types.ts` plus the explicit "feature"
 * label used by the picker UI (which labels features rather than
 * stories per spec's frontend naming -- see CLAUDE.md naming note).
 */
type DiagramTargetKind = "document" | "feature";

/**
 * Typed payload shapes for each event. Mirrors spec § 12 table
 * verbatim. Optional fields are explicitly marked.
 *
 * NOTE: kept as an interface map so the runtime shim can stay
 * `Record<string, unknown>` (no breaking change) while typed callers
 * get autocompletion + compile-time validation via
 * `assertExcalidrawAutoInsertEventPayload`.
 */
export type ExcalidrawAutoInsertEventPayloads = {
	diagram_auto_inserted: {
		surface: ChatSurface;
		targetKind: DiagramTargetKind;
		projectId: string;
		diagramId: string;
		organizationId: string;
	};
	diagram_auto_insert_failed: {
		surface: ChatSurface;
		failureClass: DiagramAutoInsertFailureClass;
		errorCode?: string;
		projectId?: string;
	};
	diagram_chat_to_editor_navigated: {
		surface: ChatSurface;
		diagramId: string;
	};
	diagram_auto_insert_blocked: {
		surface: ChatSurface;
		reason: BlockedReason;
	};
	diagram_auto_insert_picker_opened: {
		surface: ChatSurface;
		projectId: string;
		hasDocuments: boolean;
		hasFeatures: boolean;
	};
	diagram_auto_insert_picker_picked: {
		surface: ChatSurface;
		targetKind: DiagramTargetKind;
		targetId: string;
		projectId: string;
	};
	diagram_auto_insert_picker_timeout: {
		surface: ChatSurface;
		projectId: string;
	};
	diagram_embed_code_copied: {
		surface: ChatSurface;
		projectId: string;
	};
	diagram_embed_code_copy_failed: {
		surface: ChatSurface;
		projectId: string;
	};
	/**
	 * Fired the first time `useInsertDiagramAction`'s mount-time detection
	 * effect notices that an `<excalidraw-embed>` matching the current
	 * tool-call's `configId` is ALREADY present in the resolved editor.
	 *
	 * This happens when the agent emits the embed inline via
	 * `write_document_local` (the hybrid agent-emit path adopted in
	 * spec § 8.1) BEFORE the user clicks the UI fallback button. It tells
	 * us how often the agent-emit path beats the click path so we can
	 * measure adoption of the hybrid flow.
	 */
	diagram_auto_insert_detected_existing: {
		surface: ChatSurface;
		projectId: string;
	};
};

/**
 * Compile-time identity helper. Wrap a payload literal in this when
 * calling `trackEvent` to opt in to typed validation. The shim still
 * accepts a plain `Record<string, unknown>`; this helper is for the
 * caller-side opt-in until the analytics provider is plumbed.
 *
 * @example
 *   trackEvent(
 *     "diagram_auto_inserted",
 *     assertExcalidrawAutoInsertEventPayload(
 *       "diagram_auto_inserted",
 *       { surface, targetKind, projectId, diagramId, organizationId },
 *     ),
 *   );
 */
export function assertExcalidrawAutoInsertEventPayload<
	TName extends ExcalidrawAutoInsertEvent,
>(
	_name: TName,
	payload: ExcalidrawAutoInsertEventPayloads[TName],
): ExcalidrawAutoInsertEventPayloads[TName] {
	return payload;
}
