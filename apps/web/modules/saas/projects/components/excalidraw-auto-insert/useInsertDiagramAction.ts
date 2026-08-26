"use client";

/**
 * `useInsertDiagramAction` -- the button hook that owns the auto-insert
 * state machine for a single chat message's Excalidraw `create_view`
 * tool result.
 *
 * Spec sections:
 *   - § 8.2  Button state machine (idle -> inserting -> inserted / error)
 *   - § 8.5  Toast contract
 *   - § 11   Error matrix rows 2-4 (forbidden, db, editor)
 *   - § 12   Telemetry events
 *   - § FR-1 Persist the Diagram row via `projects.diagrams.createFromChat`
 *   - § FR-2 `editor.commands.insertContentAt(endPos, ...)` + focus + scroll
 *   - § FR-9 Idempotent re-click -- scroll to existing embed by configId
 *   - § FR-10 Copy embed code fallback
 *
 * State machine -- the hook tracks one of four statuses:
 *
 *   "idle"       Default. Click triggers FR-1 + FR-2. If the server
 *                rejects (FORBIDDEN / DB error), we toast and return
 *                here.
 *   "inserting"  In-flight `createFromChat` call OR in-flight editor
 *                insertion. The button is single-flight: a second
 *                click during this state is a no-op.
 *   "inserted"   Happy path. Both FR-1 and FR-2 succeeded; the embed
 *                is in the doc. A re-click here runs FR-9 -- look up
 *                the embed by configId; scroll if present, fall back
 *                to re-insert if the user deleted it manually.
 *   "error"      FR-1 succeeded but FR-2 failed (editor.insertContentAt
 *                threw or returned false). The Diagram row is preserved
 *                under the chat-scoped project; the banner from D6
 *                surfaces a Retry path that re-tries FR-2 only.
 *
 * The "error" state is intentionally separate from "idle" because a
 * "Retry" in that state must NOT re-create the row -- it re-runs only
 * the editor-insertion leg (`reinsertSavedDiagram`).
 *
 * Telemetry contract:
 *   - On full success: `diagram_auto_inserted` with the full payload.
 *   - On `db` failure: `diagram_auto_insert_failed { failureClass: "db" }`.
 *   - On `forbidden` failure: `diagram_auto_insert_failed { failureClass: "forbidden" }`.
 *   - On `editor` failure: `diagram_auto_insert_failed { failureClass: "editor" }`.
 *   - On Copy success: `diagram_embed_code_copied`.
 *   - On Copy failure: `diagram_embed_code_copy_failed`.
 *
 * Security note: the embed HTML inserted into the doc uses
 * the four whitelisted `data-*` attrs from
 * `tiptap-excalidraw-embed-extension.tsx:225-265`. Only server-validated
 * cuids (configId, checkpointId) and the resource URI come from the
 * tool result. We never interpolate user-controlled strings (titles,
 * prompts) into the HTML template.
 */

import { useAnalytics } from "@analytics";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findEmbedNodeByConfigId } from "./findEmbedNodeByConfigId";
import {
	toastCopyFailed,
	toastErrorDb,
	toastErrorForbidden,
	toastSuccess,
} from "./toasts";
import type { BlockedReason, ChatSurface, ResolverTarget } from "./types";

/**
 * The minimum fields the hook needs from the chat-message's MCP
 * `create_view` tool result. Validated server-side (spec § 17 -- we
 * trust the MCP-supplied cuids verbatim).
 */
export interface InsertDiagramToolResult {
	/** Scene JSON from `toolArgs.elements`. */
	elements: unknown;
	/** Optional Excalidraw view state. */
	appState?: unknown;
	/** Stable MCP scene handle -- becomes `data-checkpoint-id`. */
	checkpointId: string;
	/** Tenant's Excalidraw MCPConfig id -- becomes `data-config-id`. */
	mcpConfigId: string;
	/** The `ui://excalidraw/<id>` resource URI from the tool result. */
	resourceUri: string;
}

/**
 * Inputs to the hook. The button (D2) gathers these from the chat
 * scope, the resolver target, and the tool result envelope.
 */
export interface UseInsertDiagramActionOptions {
	/** Chat surface that owns the message. Used for telemetry. */
	surface: ChatSurface;
	/** Stable message id -- the idempotency key per spec § 10.1. */
	chatMessageId: string;
	/** The chat-scoped project (FR-6 keeps the Diagram row on the source). */
	projectId: string | null;
	/** Org id of the chat scope (`null` in personal scope -- FR-13). */
	organizationId: string | null;
	/** Derived per FR-3 (first 60 chars of prompt, or fallback). */
	title: string;
	/** Resolved editor target (or `null` -- caller decides the picker path). */
	resolverTarget: ResolverTarget | null;
	/** Raw tool result extracted from the chat-message envelope. */
	toolResult: InsertDiagramToolResult;
	/** The blocking reason if the caller already knows the button is disabled. */
	blockedReason?: BlockedReason;
}

/**
 * The state machine status -- see file header for transitions.
 */
type InsertDiagramActionStatus = "idle" | "inserting" | "inserted" | "error";

/**
 * Local snapshot of the persisted diagram row -- preserved across
 * status transitions so a re-click in `inserted` can scroll to it and a
 * Retry from `error` can reinsert without re-creating the row.
 */
interface SavedDiagramSnapshot {
	id: string;
	configId: string;
	checkpointId: string;
	resourceUri: string;
	organizationId: string;
}

/**
 * Hook return shape -- see file header for status semantics.
 */
export interface UseInsertDiagramActionResult {
	/** Whether the button should accept clicks at all. */
	enabled: boolean;
	/** Current state-machine status (drives button label + spinner). */
	status: InsertDiagramActionStatus;
	/** Surfaced when the resolver / scope blocks the button. */
	blockedReason?: BlockedReason;
	/** Primary action -- click handler that runs FR-1 + FR-2 or FR-9. */
	click(): Promise<void>;
	/** Sibling action -- copy the embed HTML to the clipboard. */
	copyEmbedCode(): Promise<void>;
	/**
	 * Retry handler for the "error" state -- re-runs FR-2 only against
	 * the saved Diagram row (does NOT call `createFromChat` again).
	 */
	retry(): Promise<void>;
	/** Snapshot of the persisted Diagram row (set in `inserted` and `error`). */
	savedDiagram?: SavedDiagramSnapshot;
}

/**
 * Build the spec-locked `<excalidraw-embed>` HTML. The four data-attrs
 * mirror the schema test-locked at
 * `tiptap-excalidraw-embed-extension.tsx:225-265` -- adding or removing
 * an attr here breaks parseHTML.
 *
 * Security: only the four server-validated string values
 * land in the template. They are double-quote-escaped via
 * `attrEscape` because the values flow through `editor.commands.insertContentAt`
 * (which parses the HTML through the schema).
 */
function buildEmbedHtml(input: {
	resourceUri: string;
	configId: string;
	checkpointId: string;
	organizationId: string;
}): string {
	const { resourceUri, configId, checkpointId, organizationId } = input;
	return (
		"<excalidraw-embed" +
		` data-resource-uri="${attrEscape(resourceUri)}"` +
		` data-config-id="${attrEscape(configId)}"` +
		` data-checkpoint-id="${attrEscape(checkpointId)}"` +
		` data-organization-id="${attrEscape(organizationId)}"` +
		"></excalidraw-embed>"
	);
}

/**
 * Build the static Copy-embed-code clipboard template -- spec § 17
 * forbids interpolating user-controlled strings, so only the two
 * server-validated cuids land here. The resourceUri and orgId are
 * intentionally OMITTED from the clipboard payload because the user
 * is copying the markup to paste into a doc where the embed extension
 * resolves the resource URI from the configId itself.
 */
function buildCopyEmbedTemplate(input: {
	configId: string;
	checkpointId: string;
}): string {
	const { configId, checkpointId } = input;
	return (
		"<excalidraw-embed" +
		` data-config-id="${attrEscape(configId)}"` +
		` data-checkpoint-id="${attrEscape(checkpointId)}"` +
		"></excalidraw-embed>"
	);
}

/** Minimal HTML attribute-value escape -- protects `"` and `&`. */
function attrEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Insert the embed at end-of-doc + focus + scroll. Returns `true` on
 * success, `false` if the editor rejected the insertion. Caught
 * exceptions are treated as failures by the caller (banner state).
 */
function insertEmbedAtEnd(editor: Editor, html: string): boolean {
	const endPos = editor.state.doc.content.size;
	// `insertContentAt` returns a boolean indicating whether the chain
	// could run the command. The schema (atom: true) makes the
	// insertion atomic -- either it lands or it doesn't.
	const inserted = editor.commands.insertContentAt(endPos, html);
	if (!inserted) {
		return false;
	}
	// Focus + scroll AFTER the insertion -- if focus runs first, the
	// caret position is stale and the scroll can land at the wrong spot.
	editor.commands.focus("end");
	editor.commands.scrollIntoView();
	return true;
}

/**
 * Scroll an existing embed (matched by `data-config-id`) into view.
 * Returns `true` when the embed was found and scrolled, `false` when
 * the embed was deleted from the doc since insertion (caller falls
 * back to re-insert per FR-9).
 */
function scrollExistingEmbed(editor: Editor, configId: string): boolean {
	const found = findEmbedNodeByConfigId(editor, configId);
	if (!found) {
		return false;
	}
	// `setNodeSelection` selects the atom node; `scrollIntoView` is a
	// no-op on selection but the editor's view will scroll the selection
	// into the viewport.
	editor.chain().setNodeSelection(found.pos).scrollIntoView().run();
	return true;
}

export function useInsertDiagramAction(
	options: UseInsertDiagramActionOptions,
): UseInsertDiagramActionResult {
	const {
		surface,
		projectId,
		organizationId,
		title,
		resolverTarget,
		toolResult,
		blockedReason,
	} = options;

	const { trackEvent } = useAnalytics();
	const queryClient = useQueryClient();
	const t = useTranslations("diagrams.autoInsert");

	const [status, setStatus] = useState<InsertDiagramActionStatus>("idle");
	const [savedDiagram, setSavedDiagram] = useState<
		SavedDiagramSnapshot | undefined
	>(undefined);

	// Single-flight guard. We track the in-flight state in a ref so the
	// click handler captured by an event listener sees the latest value
	// without re-creating the callback on every status change.
	const inFlightRef = useRef<boolean>(false);

	// Hybrid agent-emit detection. The agent may have already
	// emitted `<excalidraw-embed>` for this tool call inline via
	// `write_document_local`, beating the user to the click. Detect that
	// pre-existing embed on mount (and whenever editor / configId changes)
	// so the button starts in the `"inserted"` state — clicking it then
	// just scrolls to the embed instead of re-creating a Diagram row.
	//
	// Guards:
	// - Only mutates state when current status is `"idle"`. If the user
	//   has already clicked (status === "inserting" / "inserted" / "error"),
	//   the detection is a no-op so we never override user-driven state.
	// - The telemetry event `diagram_auto_insert_detected_existing` fires
	//   at most once per hook instance via `detectedExistingReportedRef`
	//   so a flurry of editor re-renders does not amplify the metric.
	const detectedExistingReportedRef = useRef<boolean>(false);
	const editorRef = resolverTarget?.editor ?? null;
	const configIdForDetection = toolResult.mcpConfigId;
	useEffect(() => {
		if (!editorRef || !configIdForDetection) {
			return;
		}
		// Never override user-driven state.
		if (status !== "idle") {
			return;
		}
		const existing = findEmbedNodeByConfigId(
			editorRef,
			configIdForDetection,
		);
		if (!existing) {
			return;
		}
		// Mark inserted. We do not have a server `Diagram.id` here — the
		// agent-emit path bypasses `createFromChat` entirely. The button
		// re-click path (FR-9) only needs `configId` to scroll to the
		// existing embed, and re-insertion on manual delete would call
		// `createFromChat` at that point. Synthesize a saved snapshot
		// from what we know so re-click `scrollExistingEmbed` works.
		setSavedDiagram((current) => {
			if (current) {
				return current;
			}
			return {
				id: "",
				configId: configIdForDetection,
				checkpointId: toolResult.checkpointId,
				resourceUri: toolResult.resourceUri,
				organizationId: organizationId ?? "",
			};
		});
		setStatus("inserted");
		if (!detectedExistingReportedRef.current) {
			detectedExistingReportedRef.current = true;
			trackEvent("diagram_auto_insert_detected_existing", {
				surface,
				projectId: projectId ?? "",
			});
		}
	}, [
		editorRef,
		configIdForDetection,
		status,
		organizationId,
		projectId,
		surface,
		toolResult.checkpointId,
		toolResult.resourceUri,
		trackEvent,
	]);

	// `enabled` is the union of "have a real chat scope" + "no blocking
	// reason was supplied by the caller". The caller (D2) computes
	// `blockedReason` from its own render-decision branches; we trust it.
	const enabled = useMemo<boolean>(() => {
		if (blockedReason) {
			return false;
		}
		if (!projectId || !organizationId) {
			return false;
		}
		if (!toolResult.checkpointId || !toolResult.mcpConfigId) {
			return false;
		}
		return true;
	}, [
		blockedReason,
		projectId,
		organizationId,
		toolResult.checkpointId,
		toolResult.mcpConfigId,
	]);

	const invalidateDiagramsList = useCallback(
		(projectIdValue: string, organizationIdValue: string) => {
			// `DiagramsList.tsx:131` uses the literal key
			// `["diagrams", projectId, organizationId]`; mirror it
			// exactly so the list re-fetches after the new row lands.
			void queryClient.invalidateQueries({
				queryKey: ["diagrams", projectIdValue, organizationIdValue],
			});
			// Belt-and-braces: also invalidate the orpc-generated key for
			// any consumer that switched to the typed key helper.
			void queryClient.invalidateQueries({
				queryKey: orpc.projects.diagrams.list.queryKey({
					input: {
						projectId: projectIdValue,
						organizationId: organizationIdValue,
					},
				}),
			});
		},
		[queryClient],
	);

	const performInsertion = useCallback(
		async (target: ResolverTarget, saved: SavedDiagramSnapshot) => {
			// FR-2 -- end-of-doc insertion (always). Try/catch wraps the
			// boolean-returning command path so any thrown error (rare but
			// possible inside ProseMirror's command runner) is funnelled
			// into the "editor" failure class.
			let inserted = false;
			let threw = false;
			try {
				inserted = insertEmbedAtEnd(
					target.editor,
					buildEmbedHtml({
						resourceUri: saved.resourceUri,
						configId: saved.configId,
						checkpointId: saved.checkpointId,
						organizationId: saved.organizationId,
					}),
				);
			} catch (error) {
				threw = true;
				console.error(
					"[excalidraw-auto-insert] editor insertion threw",
					error,
				);
			}

			if (!inserted || threw) {
				trackEvent("diagram_auto_insert_failed", {
					surface,
					failureClass: "editor",
					projectId: projectId ?? undefined,
				});
				setStatus("error");
				return;
			}

			// Full success -- fire the success telemetry + invalidate the
			// Diagrams tab so the new row shows immediately (FR-12).
			trackEvent("diagram_auto_inserted", {
				surface,
				targetKind: target.kind === "document" ? "document" : "feature",
				projectId: projectId ?? "",
				diagramId: saved.id,
				organizationId: saved.organizationId,
			});

			if (projectId && organizationId) {
				invalidateDiagramsList(projectId, organizationId);
			}

			// Success toast.
			toastSuccess({
				t,
				docName: target.documentLabel,
				onGoToEmbed: () => {
					// "Go to embed" -- scroll the freshly-inserted node.
					scrollExistingEmbed(target.editor, saved.configId);
					trackEvent("diagram_chat_to_editor_navigated", {
						surface,
						diagramId: saved.id,
					});
				},
			});

			setStatus("inserted");
		},
		[
			invalidateDiagramsList,
			organizationId,
			projectId,
			surface,
			t,
			trackEvent,
		],
	);

	const click = useCallback(async () => {
		// Single-flight + render-decision guards.
		if (inFlightRef.current) {
			return;
		}
		if (!enabled || !resolverTarget || !projectId || !organizationId) {
			return;
		}

		// FR-9 re-click path -- if we already have a saved diagram,
		// either scroll to the existing embed or re-insert if the user
		// manually deleted it. Do NOT call `createFromChat` again.
		if (status === "inserted" && savedDiagram) {
			const scrolled = scrollExistingEmbed(
				resolverTarget.editor,
				savedDiagram.configId,
			);
			if (scrolled) {
				return;
			}
			// Embed was deleted -- re-insert using the SAME saved row
			// (FR-9 "re-insert path"). No new createFromChat, no
			// new diagram row.
			inFlightRef.current = true;
			setStatus("inserting");
			try {
				await performInsertion(resolverTarget, savedDiagram);
			} finally {
				inFlightRef.current = false;
			}
			return;
		}

		inFlightRef.current = true;
		setStatus("inserting");
		try {
			// FR-1 -- persist the Diagram row.
			let createResponse: Awaited<
				ReturnType<typeof orpcClient.projects.diagrams.createFromChat>
			> | null = null;
			try {
				createResponse =
					await orpcClient.projects.diagrams.createFromChat({
						projectId,
						organizationId,
						elements: toolResult.elements,
						appState: toolResult.appState,
						checkpointId: toolResult.checkpointId,
						mcpConfigId: toolResult.mcpConfigId,
						title,
						surface,
						sourceMessageId: options.chatMessageId,
					});
			} catch (error) {
				// Map ORPC error code -> failure class per spec § 11.
				const code = (error as { code?: unknown } | null)?.code;
				if (code === "FORBIDDEN") {
					trackEvent("diagram_auto_insert_failed", {
						surface,
						failureClass: "forbidden",
						errorCode: "FORBIDDEN",
						projectId: projectId ?? undefined,
					});
					toastErrorForbidden(t);
				} else {
					trackEvent("diagram_auto_insert_failed", {
						surface,
						failureClass: "db",
						errorCode: typeof code === "string" ? code : undefined,
						projectId: projectId ?? undefined,
					});
					toastErrorDb(t);
				}
				setStatus("idle");
				return;
			}

			const created = createResponse.diagram as {
				id: string;
				mcpConfigId?: string | null;
				checkpointId?: string | null;
				organizationId?: string | null;
			};

			const saved: SavedDiagramSnapshot = {
				id: created.id,
				// Prefer the server-confirmed values when present; fall
				// back to the tool-result values otherwise (server should
				// always echo them back -- but be defensive).
				configId: created.mcpConfigId ?? toolResult.mcpConfigId,
				checkpointId: created.checkpointId ?? toolResult.checkpointId,
				resourceUri: toolResult.resourceUri,
				organizationId: created.organizationId ?? organizationId,
			};
			setSavedDiagram(saved);

			await performInsertion(resolverTarget, saved);
		} finally {
			inFlightRef.current = false;
		}
	}, [
		enabled,
		organizationId,
		options.chatMessageId,
		performInsertion,
		projectId,
		resolverTarget,
		savedDiagram,
		status,
		surface,
		t,
		title,
		toolResult.appState,
		toolResult.checkpointId,
		toolResult.elements,
		toolResult.mcpConfigId,
		toolResult.resourceUri,
		trackEvent,
	]);

	const retry = useCallback(async () => {
		// Retry is the "error" state's reinsert handler -- the Diagram
		// row is already saved; only the editor leg is re-run. NO new
		// createFromChat call.
		if (inFlightRef.current) {
			return;
		}
		if (!resolverTarget || !savedDiagram) {
			return;
		}
		inFlightRef.current = true;
		setStatus("inserting");
		try {
			await performInsertion(resolverTarget, savedDiagram);
		} finally {
			inFlightRef.current = false;
		}
	}, [performInsertion, resolverTarget, savedDiagram]);

	const copyEmbedCode = useCallback(async () => {
		// Spec § 17: ONLY server-validated cuids (configId, checkpointId)
		// land in the template. We never include user-controlled strings.
		const configId = toolResult.mcpConfigId;
		const checkpointId = toolResult.checkpointId;
		if (!configId || !checkpointId) {
			// Defensive -- the button is greyed out in this case (D2), but
			// guard the helper directly so callers can't accidentally copy
			// an incomplete template.
			return;
		}
		const template = buildCopyEmbedTemplate({ configId, checkpointId });

		// Modern clipboard API first; legacy execCommand fallback.
		// Both paths emit the same telemetry events on success/failure.
		let copied = false;
		if (
			typeof navigator !== "undefined" &&
			navigator.clipboard &&
			typeof navigator.clipboard.writeText === "function"
		) {
			try {
				await navigator.clipboard.writeText(template);
				copied = true;
			} catch (error) {
				console.error(
					"[excalidraw-auto-insert] navigator.clipboard.writeText failed",
					error,
				);
			}
		}

		if (!copied) {
			copied = legacyClipboardCopy(template);
		}

		if (copied) {
			trackEvent("diagram_embed_code_copied", {
				surface,
				projectId: projectId ?? "",
			});
		} else {
			trackEvent("diagram_embed_code_copy_failed", {
				surface,
				projectId: projectId ?? "",
			});
			toastCopyFailed(t);
		}
	}, [
		projectId,
		surface,
		t,
		toolResult.checkpointId,
		toolResult.mcpConfigId,
		trackEvent,
	]);

	return useMemo<UseInsertDiagramActionResult>(
		() => ({
			enabled,
			status,
			blockedReason,
			click,
			copyEmbedCode,
			retry,
			savedDiagram,
		}),
		[
			blockedReason,
			click,
			copyEmbedCode,
			enabled,
			retry,
			savedDiagram,
			status,
		],
	);
}

/**
 * `document.execCommand("copy")` fallback for environments without
 * `navigator.clipboard` (older browsers / restricted iframes). Returns
 * `true` on success, `false` otherwise. Exported for unit tests.
 */
function legacyClipboardCopy(text: string): boolean {
	if (typeof document === "undefined") {
		return false;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	// Offscreen positioning so the helper element never affects layout.
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch (error) {
		console.error(
			"[excalidraw-auto-insert] execCommand copy failed",
			error,
		);
	}
	document.body.removeChild(textarea);
	return ok;
}
