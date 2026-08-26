"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ExpandIcon,
	MaximizeIcon,
	MinimizeIcon,
	MinusIcon,
	PencilIcon,
	PenLineIcon,
	PlusIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	ExcalidrawCanvas,
	type ExcalidrawImperativeAPI,
} from "./ExcalidrawCanvas";
import { ExcalidrawEditor } from "./ExcalidrawEditor";
import {
	parseExcalidrawAppState,
	parseExcalidrawElements,
} from "./mcp-scene-utils";

type LooseRecord = Record<string, unknown>;
type SceneElement = LooseRecord & { type?: string; id?: string };

/**
 * Walk up the DOM looking for an ancestor that actually scrolls
 * vertically (its computed `overflow-y` is `auto`/`scroll` AND its
 * `scrollHeight > clientHeight`). This is what we forward wheel deltas
 * to in `wheelScrollsParent` mode — `window` is a poor fallback inside
 * CopilotSidebar where the conversation has its own scroll container.
 */
function findScrollableAncestor(start: HTMLElement): HTMLElement | null {
	let node: HTMLElement | null = start.parentElement;
	while (node && node !== document.body) {
		const cs = window.getComputedStyle(node);
		const oy = cs.overflowY;
		const isScrollable =
			(oy === "auto" || oy === "scroll" || oy === "overlay") &&
			node.scrollHeight > node.clientHeight;
		if (isScrollable) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

export interface ExcalidrawPreviewProps {
	/**
	 * Args from the MCP `create_view` tool call — should contain the
	 * `elements` (and optionally `appState`) the agent generated. When
	 * absent or empty, the component falls back to `read_checkpoint`.
	 */
	toolArgs?: LooseRecord | null;
	/**
	 * Checkpoint identifier extracted from the `create_view` tool result.
	 * Required to (a) fall back when `toolArgs` is missing and (b) edit
	 * the scene in the fullscreen editor.
	 */
	checkpointId?: string | null;
	/** MCP config ID — used by the read_checkpoint / save_checkpoint API. */
	configId: string;
	/** Organization ID for tenant isolation on MCP API calls. */
	organizationId?: string | null;
	/** Outer container className. */
	className?: string;
	/**
	 * Height of the inline preview in CSS pixels. The fullscreen state
	 * ignores this and uses `inset: 16px`. Defaults to 640.
	 */
	defaultHeight?: number;
	/**
	 * When `true`, intercepts mouse-wheel events on the canvas at capture
	 * phase and forwards their vertical delta to the nearest scrollable
	 * ancestor (the chat panel) instead of letting Excalidraw consume them
	 * for zoom/pan. Drag-pan with the mouse and Ctrl/Cmd+wheel (trackpad
	 * pinch-zoom) are unaffected.
	 *
	 * Used by the chat surfaces (AI Feature Assistant, AI Document
	 * Assistant, Nexus): the canvas is small and lives inside a long
	 * scrollable conversation, so the user's natural "scroll the chat"
	 * gesture must not get hijacked by Excalidraw's wheel-zoom.
	 *
	 * Pan within the canvas is still available via mouse-drag (and the
	 * Fit / +/- buttons in the header).
	 */
	wheelScrollsParent?: boolean;
}

interface SceneState {
	elements: SceneElement[];
	appState?: LooseRecord;
}

interface FetchState {
	scene: SceneState | null;
	isLoading: boolean;
	error: string | null;
}

function extractSceneFromToolArgs(
	toolArgs: LooseRecord | null | undefined,
): SceneState | null {
	if (!toolArgs) {
		return null;
	}
	// `elements` arrives as a real array on some adapter paths and as a
	// JSON-encoded string on others — the `create_view` tool schema itself
	// declares the string form, so a schema-conformant call must render
	// from here without waiting on the `read_checkpoint` round-trip.
	const elements = parseExcalidrawElements(toolArgs.elements);
	if (elements) {
		return {
			elements: elements as SceneElement[],
			appState: parseExcalidrawAppState(toolArgs.appState),
		};
	}
	return null;
}

function parseSceneFromCheckpointResponse(data: unknown): SceneState | null {
	if (!data || typeof data !== "object") {
		return null;
	}
	const res = data as LooseRecord;
	if (Array.isArray(res.elements) && res.elements.length > 0) {
		return {
			elements: res.elements as SceneElement[],
			appState:
				typeof res.appState === "object" && res.appState
					? (res.appState as LooseRecord)
					: undefined,
		};
	}
	// Some MCP servers wrap the diagram in a text-content block (the JSON
	// string lives at `content[0].text`). Try to parse that as a last
	// resort so we render diagrams that haven't been hoisted onto the
	// top-level response.
	const firstText = Array.isArray(res.content)
		? ((res.content[0] as { text?: string } | undefined)?.text ?? null)
		: null;
	if (firstText) {
		try {
			const parsed = JSON.parse(firstText) as {
				elements?: unknown;
				appState?: unknown;
			};
			if (Array.isArray(parsed.elements) && parsed.elements.length > 0) {
				return {
					elements: parsed.elements as SceneElement[],
					appState:
						typeof parsed.appState === "object" && parsed.appState
							? (parsed.appState as LooseRecord)
							: undefined,
				};
			}
		} catch {
			// fall through — return null
		}
	}
	return null;
}

/**
 * Inline Excalidraw preview that appears inside an assistant response.
 *
 * Replaces the old MCP-iframe path for Excalidraw resources: instead of
 * loading the MCP server's HTML in a sandboxed iframe, we render the scene
 * directly via `@excalidraw/excalidraw` (same path the fullscreen editor
 * already uses). That gives us:
 *
 *  - A real `ExcalidrawAPI` we can call `scrollToContent` on, fixing the
 *    "diagram clipped, no scroll" bug — the canvas auto-fits the scene to
 *    the viewport on mount and on demand via the Fit button.
 *  - A toolbar that lives in a proper header above the canvas (not floated
 *    over the top-right corner), so it never overlaps diagram content and
 *    button labels never get truncated by the container edge.
 *  - One render path shared with the fullscreen editor: the conversion +
 *    font-settling code lives in `ExcalidrawCanvas` and both consumers
 *    pick up improvements automatically.
 */
export function ExcalidrawPreview({
	toolArgs,
	checkpointId,
	configId,
	organizationId,
	className,
	defaultHeight = 640,
	wheelScrollsParent = false,
}: ExcalidrawPreviewProps) {
	// Lazy initializer — the parse only runs once on first mount. Without it
	// the cast/parse happens on every render, creating fresh scene objects
	// that nothing reads but that still cost work on each parent update.
	const [state, setState] = useState<FetchState>(() => {
		const scene = extractSceneFromToolArgs(toolArgs);
		return {
			scene,
			isLoading: !scene && !!checkpointId,
			error: null,
		};
	});
	const [isExpanded, setIsExpanded] = useState(false);
	const [showEditor, setShowEditor] = useState(false);
	const [refreshNonce, setRefreshNonce] = useState(0);
	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

	// Source-of-scene resolution — stale-while-revalidate:
	//   1. If `toolArgs.elements` is present, show it immediately as a
	//      zero-network placeholder. This is the agent's original output and
	//      matches the checkpoint for any unedited diagram, so the placeholder
	//      is correct in the common case.
	//   2. In parallel, fetch `read_checkpoint` to get the canonical scene.
	//      The checkpoint is the source of truth — if the user edited the
	//      diagram in the fullscreen editor, the checkpoint has those edits
	//      while `toolArgs` (frozen on the chat message) still shows the
	//      original. Once the fetch completes, replace the placeholder.
	//   3. A user-initiated refresh (refreshNonce > 0) skips the placeholder
	//      step: the current scene stays on screen and updates silently when
	//      the fetch resolves. Otherwise the Reload / editor-close flow would
	//      flash a spinner over an already-good preview.
	useEffect(() => {
		const forceCheckpointFetch = refreshNonce > 0;
		const fromArgs = forceCheckpointFetch
			? null
			: extractSceneFromToolArgs(toolArgs);

		if (fromArgs) {
			// Show the placeholder right away. The background fetch below
			// will overwrite it with the canonical checkpoint scene once it
			// resolves; if they're equal (the common case) React's setState
			// short-circuits via Object.is on the wrapping object and no
			// extra render fires.
			setState({ scene: fromArgs, isLoading: false, error: null });
		}

		if (!checkpointId) {
			if (!fromArgs) {
				setState({ scene: null, isLoading: false, error: null });
			}
			return;
		}

		let cancelled = false;
		// Only flip `isLoading` on when we have nothing to show. With a
		// placeholder or current scene already rendered, the fetch is a
		// silent revalidate.
		setState((prev) => ({
			...prev,
			isLoading: !prev.scene,
			error: null,
		}));

		(async () => {
			try {
				const res = await fetch("/api/mcp-app/call-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						configId,
						toolName: "read_checkpoint",
						args: { id: checkpointId },
						organizationId,
					}),
				});
				if (!res.ok) {
					if (!cancelled) {
						setState((prev) => ({
							// Keep the placeholder / current scene if the
							// fetch fails — the user can keep using what
							// they had instead of seeing an empty error
							// frame.
							scene: prev.scene,
							isLoading: false,
							error: prev.scene
								? null
								: `Failed to load diagram (${res.status}).`,
						}));
					}
					return;
				}
				const data = (await res.json()) as unknown;
				const scene = parseSceneFromCheckpointResponse(data);
				if (!cancelled) {
					setState((prev) => ({
						scene: scene ?? prev.scene,
						isLoading: false,
						error:
							scene || prev.scene
								? null
								: "Diagram has no elements.",
					}));
				}
			} catch (err) {
				if (!cancelled) {
					setState((prev) => ({
						scene: prev.scene,
						isLoading: false,
						error: prev.scene
							? null
							: err instanceof Error
								? err.message
								: "Failed to load diagram.",
					}));
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [toolArgs, checkpointId, configId, organizationId, refreshNonce]);

	// Esc closes fullscreen mode — matches the previous iframe behaviour so
	// muscle memory carries over.
	useEffect(() => {
		if (!isExpanded) {
			return;
		}
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setIsExpanded(false);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [isExpanded]);

	const handleFit = useCallback(() => {
		const api = apiRef.current;
		if (!api) {
			return;
		}
		// `viewportZoomFactor: 0.8` leaves ~20 % padding so Excalidraw's own
		// UI overlays (main menu top-left, zoom controls / scroll-back
		// indicator bottom-centre, help icon bottom-right) don't cover the
		// diagram. Mirrors the auto-fit behaviour in `ExcalidrawCanvas` —
		// without this, tall diagrams hide their bottom rows behind the
		// zoom toolbar.
		api.scrollToContent(api.getSceneElements(), {
			fitToViewport: true,
			viewportZoomFactor: 0.8,
		});
	}, []);

	// Drives the +/- buttons in our header. Excalidraw collapses its
	// own bottom-bar zoom controls in mobile layout (chat sidebar
	// canvas < 640 px), so without our header buttons the user has no
	// click-to-zoom surface in the AI Feature Assistant. On wider
	// surfaces (Nexus, fullscreen) the native bottom bar ALSO shows —
	// both UIs drive the same `updateScene({ appState: { zoom } })`
	// path, so toggling either stays consistent.
	//
	// Step factor 1.2 matches Excalidraw's own zoom-button increment.
	// Clamp 0.1–30 mirrors Excalidraw's MIN_ZOOM/MAX_ZOOM so we never
	// hand the canvas an out-of-range value.
	const handleZoom = useCallback(
		(direction: "in" | "out") => {
			const api = apiRef.current;
			if (!api) {
				return;
			}
			try {
				const current = api.getAppState?.()?.zoom?.value ?? 1;
				const factor = direction === "in" ? 1.2 : 1 / 1.2;
				const next = Math.min(30, Math.max(0.1, current * factor));
				api.updateScene({ appState: { zoom: { value: next } } });
			} catch (err) {
				console.warn(
					"[ExcalidrawPreview] zoom failed, falling back to fit:",
					err,
				);
				handleFit();
			}
		},
		[handleFit],
	);

	// Wheel handler: when `wheelScrollsParent` is on (chat surfaces),
	// catch wheel events at capture phase BEFORE Excalidraw consumes
	// them, suppress Excalidraw's wheel-zoom, and forward the deltaY to
	// the nearest scrollable ancestor (the chat conversation panel) so
	// the user's "scroll the chat" gesture works naturally even when
	// the cursor happens to be over the embedded canvas.
	//
	// Trackpad pinch-zoom and Ctrl/Cmd+wheel still pass through so power
	// users can zoom — Ctrl+wheel uses Excalidraw's own zoom path when
	// the cursor's over the canvas.
	const wheelHandlerRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!wheelScrollsParent) {
			return;
		}
		const el = wheelHandlerRef.current;
		if (!el) {
			return;
		}
		const onWheel = (e: WheelEvent) => {
			// Trackpad pinch fires wheel with ctrlKey=true; preserve that
			// for Excalidraw's native zoom.
			if (e.ctrlKey || e.metaKey) {
				return;
			}
			// Find the nearest vertically-scrollable ancestor and drive
			// it directly. We don't rely on bubbling because Excalidraw
			// calls preventDefault() on the canvas's wheel handler.
			const scroller = findScrollableAncestor(el);
			if (scroller) {
				scroller.scrollTop += e.deltaY;
			}
			e.preventDefault();
			e.stopPropagation();
		};
		// Capture phase + `passive: false` so we can call preventDefault
		// to suppress Excalidraw's own wheel-zoom logic.
		el.addEventListener("wheel", onWheel, {
			capture: true,
			passive: false,
		});
		return () => {
			el.removeEventListener("wheel", onWheel, { capture: true });
		};
	}, [wheelScrollsParent]);

	const handleEdit = useCallback(() => {
		// The editor needs concrete elements; if we're still loading or hit
		// an error there's nothing to edit yet.
		if (!state.scene) {
			return;
		}
		setShowEditor(true);
	}, [state.scene]);

	const handleEditorClose = useCallback(() => {
		setShowEditor(false);
		// Pull the latest checkpoint after editing so the preview reflects
		// any changes the user made in the editor.
		setRefreshNonce((n) => n + 1);
	}, []);

	const handleEditorElementsChange = useCallback(
		(nextElements: SceneElement[]) => {
			// Optimistic local sync — the editor save loop persists to the
			// checkpoint, but the preview shouldn't have to wait for the
			// refetch to reflect what the user just drew.
			setState((prev) =>
				prev.scene
					? {
							...prev,
							scene: { ...prev.scene, elements: nextElements },
						}
					: prev,
			);
		},
		[],
	);

	// When expanded, the entire preview container is moved to a React
	// portal anchored to `document.body`. This is the ONLY reliable way
	// to escape `position: fixed`'s containment when an ancestor in the
	// tree has `transform`, `filter`, `perspective`, or `will-change`
	// applied — which CopilotSidebar's slide-in animation does. Without
	// portalling, `inset-4` is resolved relative to the sidebar's box
	// instead of the viewport, the canvas gets clipped to the right
	// rail, and the Minimize button hides behind the sidebar's overflow
	// (the exact "can't return from fullscreen" UX bug).
	//
	// Trade-off accepted: portalling re-parents the DOM tree, which
	// remounts `<ExcalidrawCanvas>`. Excalidraw's instance is recreated
	// and re-imports the scene from `state.scene` — the refetch is
	// fast and the user's pan/zoom state is implicit in the scene
	// data, so the visual result is equivalent.
	const containerClass = cn(
		"relative flex w-full flex-col overflow-hidden rounded-lg border bg-background shadow-sm",
		isExpanded && "!fixed !inset-4 !z-[9999] !h-auto !w-auto !shadow-2xl",
		className,
	);
	const containerStyle = isExpanded
		? undefined
		: { height: `${defaultHeight}px` };

	const containerNode = (
		<div
			data-excalidraw-expanded={isExpanded ? "true" : undefined}
			className={containerClass}
			style={containerStyle}
		>
			{/* Header — Excalidraw brand left, actions right. Lives ABOVE
				    the canvas (not overlaying it) so it never clips diagram
				    content and button labels can't be truncated by the
				    container edge. */}
			<div className="flex shrink-0 items-center justify-between gap-3 border-b bg-card/40 px-3 py-1.5">
				<div className="flex min-w-0 items-center gap-1.5 text-xs">
					{/* A Lucide pen-line icon — consistent stroke weight
					    with the HeaderButton icons. The previous inline
					    <svg> contained only the pen-nib fragment of
					    Excalidraw's brand-mark path (the rest of the
					    "E + scribble" never made it into the source), so
					    it rendered as a stray diamond next to the label. */}
					<PenLineIcon
						className="size-3.5 shrink-0 text-[#6965DB]"
						aria-hidden="true"
					/>
					<span className="truncate font-medium text-[#6965DB]">
						Excalidraw
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{/* Header buttons (left → right): Zoom out, Zoom in,
						    Fit, Reload, Edit, Fullscreen. Identical in
						    both surfaces (Nexus + AI Feature Assistant)
						    via the shared <McpAppFrame> → <ExcalidrawPreview>
						    path; consistent regardless of whether
						    Excalidraw's own canvas chrome happens to be in
						    desktop or mobile layout. Excalidraw's native
						    bottom-bar zoom only appears in desktop
						    layout, so these header +/- buttons are the
						    reliable cross-surface zoom affordance. */}
					<HeaderButton
						onClick={() => handleZoom("out")}
						label="Zoom out"
						disabled={!state.scene || state.isLoading}
					>
						<MinusIcon className="size-3.5" />
					</HeaderButton>
					<HeaderButton
						onClick={() => handleZoom("in")}
						label="Zoom in"
						disabled={!state.scene || state.isLoading}
					>
						<PlusIcon className="size-3.5" />
					</HeaderButton>
					<HeaderButton
						onClick={handleFit}
						label="Fit to content"
						disabled={!state.scene || state.isLoading}
					>
						<ExpandIcon className="size-3.5" />
					</HeaderButton>
					<HeaderButton
						onClick={() => setRefreshNonce((n) => n + 1)}
						label="Reload diagram"
						disabled={state.isLoading}
					>
						<RefreshCwIcon className="size-3.5" />
					</HeaderButton>
					{checkpointId && (
						<HeaderButton
							onClick={handleEdit}
							label="Edit in Excalidraw"
							disabled={!state.scene || state.isLoading}
						>
							<PencilIcon className="size-3.5" />
						</HeaderButton>
					)}
					<HeaderButton
						onClick={() => setIsExpanded((v) => !v)}
						label={
							isExpanded ? "Exit fullscreen (Esc)" : "Fullscreen"
						}
					>
						{isExpanded ? (
							<MinimizeIcon className="size-3.5" />
						) : (
							<MaximizeIcon className="size-3.5" />
						)}
					</HeaderButton>
				</div>
			</div>

			{/* Canvas area — always fills the remaining vertical space.
				    `minHeight: 0` so flexbox actually shrinks the canvas
				    rather than overflowing the parent container. The
				    ref drives the `wheelScrollsParent` capture-phase
				    handler installed in the effect above. */}
			<div
				ref={wheelHandlerRef}
				className="relative min-h-0 flex-1 overflow-hidden bg-background"
			>
				{state.isLoading && (
					<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80">
						<div className="flex flex-col items-center gap-3">
							<div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
							<span className="text-xs text-muted-foreground">
								Loading diagram…
							</span>
						</div>
					</div>
				)}
				{state.error && !state.isLoading && (
					<div className="absolute inset-0 flex items-center justify-center p-6 text-center">
						<div className="flex max-w-sm flex-col items-center gap-2">
							<p className="text-sm font-medium text-destructive">
								Couldn't display this diagram
							</p>
							<p className="text-xs text-muted-foreground">
								{state.error}
							</p>
							<button
								type="button"
								onClick={() => setRefreshNonce((n) => n + 1)}
								className="mt-1 flex items-center gap-1 text-xs underline underline-offset-2 hover:opacity-80"
							>
								<RefreshCwIcon className="size-3" /> Retry
							</button>
						</div>
					</div>
				)}
				{state.scene && (
					// Render Excalidraw at the surface's native size.
					// We previously tried a CSS transform-scale hack
					// to force desktop layout in the narrow chat
					// sidebar — it produced large empty space below
					// the diagram and blurred Excalidraw's icons, so
					// we reverted. In wide surfaces (Nexus, doc
					// embed) Excalidraw shows its full native chrome
					// natively; in the narrow chat it stays in
					// mobile mode (hamburger only) and the
					// HeaderButton row above provides Fit / Refresh
					// / Edit / Fullscreen.
					<ExcalidrawCanvas
						key={refreshNonce}
						elements={state.scene.elements}
						appState={state.scene.appState}
						viewModeEnabled
						onApi={(api) => {
							apiRef.current = api;
						}}
					/>
				)}
				{!state.scene && !state.isLoading && !state.error && (
					// No scene, no fetch in flight, no error — usually
					// means the tool call hasn't produced output yet.
					// Show a quiet placeholder so the surface doesn't
					// read as broken.
					<div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
						No diagram to display.
					</div>
				)}
			</div>
		</div>
	);

	return (
		<>
			{showEditor && state.scene && (
				<ExcalidrawEditor
					elements={state.scene.elements}
					appState={state.scene.appState}
					checkpointId={checkpointId}
					configId={configId}
					organizationId={organizationId}
					onClose={handleEditorClose}
					onElementsChange={handleEditorElementsChange}
				/>
			)}

			{isExpanded && typeof document !== "undefined"
				? // Fullscreen path: portal the backdrop AND the container
					// itself to `document.body` so they escape any ancestor
					// `transform` / `filter` context that would otherwise
					// re-anchor `position: fixed` to the chat sidebar.
					// We deliberately do NOT add a floating-X close here —
					// the in-header Minimize button (top-right of the
					// container chrome) is sufficient and Esc still works.
					createPortal(
						<>
							<button
								type="button"
								aria-label="Close expanded view"
								onClick={() => setIsExpanded(false)}
								className="fixed inset-0 z-[9998] bg-black/60"
								tabIndex={-1}
							/>
							{containerNode}
						</>,
						document.body,
					)
				: containerNode}
		</>
	);
}

interface HeaderButtonProps {
	onClick: () => void;
	label: string;
	disabled?: boolean;
	children: React.ReactNode;
}

function HeaderButton({
	onClick,
	label,
	disabled,
	children,
}: HeaderButtonProps) {
	return (
		// Icon-only control: `aria-label` supplies the accessible name and the
		// tooltip supplies the hover affordance the native `title` used to give.
		// The copy is the caller-supplied `label` — this is a shared primitive,
		// so each call site owns its own wording.
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={onClick}
					disabled={disabled}
					aria-label={label}
					className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
