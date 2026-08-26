"use client";

/**
 * TipTap extension that embeds a live Excalidraw diagram inline in a
 * document. The diagram is identified by its MCP App `resourceUri` +
 * `configId` — the same pair the chat sidebar already uses to render the
 * canvas via `<McpAppFrame>` (which routes Excalidraw to
 * `<ExcalidrawPreview>`).
 *
 * Why use the same component the chat does: the diagram is **always**
 * fetched fresh from the MCP server, so edits the user makes in the chat
 * canvas automatically reflect in the embedded view here. No PNG/SVG
 * snapshot pipeline, no re-export, no cache invalidation. The single
 * source of truth is the MCP server (matching PR #862's design).
 *
 * Authoring flow:
 *   1. User asks the AI Feature/Document Assistant for a diagram.
 *   2. Agent calls `create_view` → canvas renders inline in the chat.
 *   3. If the user also asked for the diagram in the document, the agent
 *      writes raw HTML into the document via `write_document_local`:
 *
 *      <excalidraw-embed data-resource-uri="ui://excalidraw/abc"
 *                        data-config-id="cfg_xxx"></excalidraw-embed>
 *
 *   4. The markdown→tiptap conversion sees the tag and instantiates
 *      this node, which renders the embedded canvas.
 *
 * Markdown round-trip: tiptap's serializer (turndown) preserves unknown
 * HTML tags as-is, so the embed survives Save/Load.
 */

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { mergeAttributes, Node } from "@tiptap/core";
import {
	NodeViewWrapper,
	type ReactNodeViewProps,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ExternalLink, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { ExcalidrawPreview } from "../../../../components/ai-elements/ExcalidrawPreview";

// Use TipTap's own `ReactNodeViewProps` so `ReactNodeViewRenderer`'s
// type-check accepts the component during the production build's strict
// pass (next build → tsc --strict in the apps/web tsconfig). A hand-
// rolled prop interface here looks fine in `pnpm type-check` (which
// runs in noEmit, looser context) but `next build` instantiates the
// generic in a stricter mode that wants the exact ReactNodeViewProps
// shape — observed as a Vercel-only failure on PR #897.
function ExcalidrawEmbedNodeView({ node, editor, getPos }: ReactNodeViewProps) {
	const tTooltips = useTranslations("tooltips.common");
	const tEditorTooltips = useTranslations("tooltips.editor");
	// Active org from the page context. The document/feature is always viewed
	// within its org's route (`/app/<slug>/…`), and the editor sits inside the
	// ActiveOrganizationContext provider, so this resolves the current org
	// (null in personal context). TipTap renders React NodeViews within the
	// editor's React tree, so this context hook is available here.
	const contextOrganizationId = useOrganizationId();

	// Three attributes the AI Assistant writes after a `create_view`:
	//   - data-resource-uri  → kept for debugging / future routing, not strictly needed
	//   - data-config-id     → the tenant's Excalidraw MCPConfig id
	//   - data-checkpoint-id → server-side scene id, required for read_checkpoint
	// `<ExcalidrawPreview>` needs `checkpointId` + `configId` to fetch the
	// scene; the resource URI is informational (it shows up on the chat
	// side because McpAppFrame uses it to route to the Excalidraw branch).
	const resourceUri = node.attrs["data-resource-uri"] as string | undefined;
	const configId = node.attrs["data-config-id"] as string | undefined;
	const checkpointId = node.attrs["data-checkpoint-id"] as string | undefined;
	// Resolve the org for the tenant-scoped `read_checkpoint` fetch. Prefer an
	// explicit `data-organization-id` on the embed, but fall back to the active
	// org from the page. The agent's emitted embeds historically omit the attr,
	// which made the fetch run in personal context (`organizationId: null`) and
	// 404 against the org-scoped Excalidraw MCP config — this fallback fixes
	// that for both newly-created and already-persisted embeds.
	const organizationId =
		(node.attrs["data-organization-id"] as string) ||
		contextOrganizationId ||
		null;

	const deleteNode = () => {
		const pos = getPos();
		if (pos === undefined) {
			return;
		}
		const tr = editor.state.tr.delete(pos, pos + node.nodeSize);
		editor.view.dispatch(tr);
	};

	// Graceful empty state — fires when the AI emits the embed tag
	// without populating the required attrs (observed during streaming
	// partials). Without this guard `<ExcalidrawPreview>` would issue
	// a doomed `read_checkpoint(null)` call and surface a generic
	// "Failed to load" inside the document.
	//
	// `checkpointId` is the hard requirement — without it the preview
	// has no scene to fetch. `configId` is required to authenticate the
	// fetch. We treat `resourceUri` as informational and accept its
	// absence.
	if (!configId || !checkpointId) {
		return (
			<NodeViewWrapper className="excalidraw-embed-wrapper">
				<div className="my-4 rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
					<div className="flex items-center justify-between">
						<span>
							Diagram placeholder — waiting for AI to attach the
							diagram reference.
						</span>
						{editor.isEditable && (
							<DestructiveTooltip
								copy={tEditorTooltips.raw(
									"removeDiagramPlaceholder",
								)}
							>
								<button
									type="button"
									onClick={deleteNode}
									className="p-1.5 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
									aria-label="Remove diagram placeholder"
								>
									<Trash2 className="h-4 w-4" />
								</button>
							</DestructiveTooltip>
						)}
					</div>
				</div>
			</NodeViewWrapper>
		);
	}

	return (
		<NodeViewWrapper className="excalidraw-embed-wrapper">
			<div className="excalidraw-embed-container my-4 rounded-lg border bg-card overflow-hidden">
				{/* Header — small editorial chrome that matches the document's
				    paper-like aesthetic (no glassmorphism, no gradients per
				    CLAUDE.md design rules). The "Open in chat" hint nudges
				    the user toward the editing surface — the embedded canvas
				    here is view-first, edit-by-going-to-chat. */}
				<div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
					<div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-muted-foreground">
						<svg
							className="h-3.5 w-3.5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<rect x="3" y="3" width="18" height="18" rx="2" />
							<path d="M9 9l6 6M15 9l-6 6" />
						</svg>
						<span>Excalidraw</span>
					</div>
					<div className="flex items-center gap-1">
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={(e) => {
										// Best-effort: scroll the right-side AI sidebar
										// into view if mounted.
										const sidebar = document.querySelector(
											'[aria-label="Fabric Agent"], [data-fabric-agent-chat="true"]',
										);
										if (sidebar) {
											e.preventDefault();
											sidebar.scrollIntoView({
												behavior: "smooth",
												block: "nearest",
											});
										}
									}}
									className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
								>
									<ExternalLink className="h-3 w-3" />
									Edit in chat
								</button>
							</TooltipTrigger>
							<TooltipContent>
								{tEditorTooltips("editDiagramInChat")}
							</TooltipContent>
						</Tooltip>
						{editor.isEditable && (
							<DestructiveTooltip copy={tTooltips.raw("delete")}>
								<button
									type="button"
									onClick={deleteNode}
									className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
									aria-label="Remove embedded diagram"
								>
									<Trash2 className="h-4 w-4" />
								</button>
							</DestructiveTooltip>
						)}
					</div>
				</div>

				{/* Canvas — fixed-height, view-first. The user pans/zooms
				    inside but doesn't accidentally edit (Excalidraw's view
				    mode is enforced by ExcalidrawPreview's defaultHeight +
				    its internal viewModeEnabled). `contentEditable={false}`
				    keeps tiptap from putting a caret inside the canvas
				    when the user clicks. `<ExcalidrawPreview>` owns its
				    own loading/error UI (matches what Nexus shows). */}
				<div
					className="excalidraw-embed-canvas relative w-full select-none"
					contentEditable={false}
				>
					<ExcalidrawPreview
						checkpointId={checkpointId}
						configId={configId}
						organizationId={organizationId}
						className="h-full"
						defaultHeight={480}
					/>
				</div>
			</div>
		</NodeViewWrapper>
	);
}

/**
 * Excalidraw embed TipTap node.
 *
 * Recognized HTML (markdown round-trip):
 *
 *   <excalidraw-embed
 *       data-resource-uri="ui://excalidraw/<id>"
 *       data-config-id="<mcpConfigId>"
 *       data-organization-id="<orgId>?"
 *   ></excalidraw-embed>
 *
 * Use a custom tag (not `<div>` or `<iframe>`) so the parser can match
 * unambiguously without false positives on regular HTML the AI might
 * legitimately want in the document. The hyphenated tag name is also
 * what most markdown turndown configs preserve verbatim.
 */
export const ExcalidrawEmbed = Node.create({
	name: "excalidrawEmbed",

	group: "block",

	// Atomic: the node has no editable text content. Users edit the
	// underlying diagram in the chat sidebar; this is a read-only embed.
	atom: true,

	// Whitespace-irrelevant block; doesn't participate in marks.
	defining: true,
	isolating: true,

	addAttributes() {
		return {
			"data-resource-uri": {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-resource-uri"),
				renderHTML: (attrs: Record<string, unknown>) => {
					if (!attrs["data-resource-uri"]) {
						return {};
					}
					return { "data-resource-uri": attrs["data-resource-uri"] };
				},
			},
			"data-config-id": {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-config-id"),
				renderHTML: (attrs: Record<string, unknown>) => {
					if (!attrs["data-config-id"]) {
						return {};
					}
					return { "data-config-id": attrs["data-config-id"] };
				},
			},
			"data-checkpoint-id": {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-checkpoint-id"),
				renderHTML: (attrs: Record<string, unknown>) => {
					if (!attrs["data-checkpoint-id"]) {
						return {};
					}
					return {
						"data-checkpoint-id": attrs["data-checkpoint-id"],
					};
				},
			},
			"data-organization-id": {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-organization-id"),
				renderHTML: (attrs: Record<string, unknown>) => {
					if (!attrs["data-organization-id"]) {
						return {};
					}
					return {
						"data-organization-id": attrs["data-organization-id"],
					};
				},
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "excalidraw-embed",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		// Round-trip as the same custom tag — turndown preserves unknown
		// HTML tags verbatim when serializing to markdown, so the embed
		// reference survives Save → Load with no data loss.
		return [
			"excalidraw-embed",
			mergeAttributes(HTMLAttributes, {
				class: "excalidraw-embed-block",
			}),
		];
	},

	addNodeView() {
		return ReactNodeViewRenderer(ExcalidrawEmbedNodeView);
	},
});
