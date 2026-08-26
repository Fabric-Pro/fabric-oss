"use client";

import "@excalidraw/excalidraw/index.css";
import { cn } from "@ui/lib";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const Excalidraw = dynamic(
	async () => (await import("@excalidraw/excalidraw")).Excalidraw,
	{ ssr: false },
);

// Excalidraw's element shape varies by version; we accept loose input from
// MCP tool args / read_checkpoint and normalise here, so callers don't need to
// know the on-the-wire vs. in-memory format distinction.
type LooseElement = Record<string, unknown> & { type?: string; id?: string };

export interface ExcalidrawCanvasProps {
	/**
	 * Raw scene elements. May be in either the on-the-wire shape (label
	 * shorthand, missing `boundElements` / `groupIds`) or the
	 * already-converted Excalidraw format. The canvas detects which and
	 * normalises before passing to the widget.
	 */
	elements: LooseElement[];
	/** Optional appState merged into the initial Excalidraw scene. */
	appState?: Record<string, unknown>;
	/** Read-only mode (pan/zoom only, no editing tools). Default `false`. */
	viewModeEnabled?: boolean;
	/**
	 * Fires on scene changes — only meaningful when `viewModeEnabled` is
	 * false. Receives the full scene (deleted elements filtered out).
	 */
	onChange?: (elements: LooseElement[]) => void;
	/** UI theme. Excalidraw applies this to its own chrome and canvas. */
	theme?: "light" | "dark";
	/** Container className. */
	className?: string;
	/**
	 * Called once Excalidraw has mounted, with the imperative API instance.
	 * Use to drive `scrollToContent`, `updateScene`, etc. from a parent
	 * toolbar.
	 */
	onApi?: (api: ExcalidrawImperativeAPI) => void;
}

// The Excalidraw npm package's API surface is large; we only depend on the
// methods we actually call. Anything else stays `unknown` so a version bump
// doesn't silently break us.
export interface ExcalidrawImperativeAPI {
	getSceneElements: () => readonly LooseElement[];
	getAppState: () => { zoom?: { value: number } } & Record<string, unknown>;
	updateScene: (opts: {
		elements?: readonly LooseElement[];
		// Excalidraw 0.18+ accepts a partial `appState` object on
		// `updateScene` — we use this to drive the +/- zoom buttons
		// from our header without having to wire `setAppState` (which
		// the package also exposes but is typed as deprecated in some
		// versions).
		appState?: { zoom?: { value: number } } & Record<string, unknown>;
		captureUpdate?: unknown;
	}) => void;
	scrollToContent: (
		elements?: readonly LooseElement[],
		opts?: {
			fitToViewport?: boolean;
			fitToContent?: boolean;
			viewportZoomFactor?: number;
			animate?: boolean;
		},
	) => void;
}

// `viewportZoomFactor` of 1.0 means content fills the entire canvas area,
// but Excalidraw overlays its own UI on top of the canvas: a main-menu
// trigger top-left (~50 px), a zoom-controls cluster + scroll-back
// indicator at the bottom-centre (~40 px), and a help icon bottom-right.
// With factor 1.0, content directly under those overlays is visually
// clipped — verified in staging where Tier 3 of a 3-tier diagram hid
// behind the zoom toolbar even though the math said 60 % zoom fits the
// scene "fully".
//
// 0.8 reserves 20 % of canvas height as padding (≈ 60 px top + 60 px
// bottom on the 598 px preview canvas), which clears both the top
// hamburger and the bottom zoom controls. Stops short of overpadding
// short diagrams into postage-stamp territory.
const FIT_VIEWPORT_PADDING_FACTOR = 0.8;

/**
 * Call `scrollToContent` with `fitToContent: true` so the entire scene fits
 * inside the current viewport. We use `fitToContent` (not `fitToViewport`)
 * deliberately: `fitToContent` only zooms OUT to make things fit and leaves
 * the user's manual pan/zoom in place if they've already scrolled, whereas
 * `fitToViewport` also zooms IN and overrides user state. For an inline
 * preview that needs to show the whole diagram on first render, the
 * zoom-out-only behaviour is what we want.
 *
 * The `viewportZoomFactor` adds padding so Excalidraw's own UI overlays
 * (main menu, zoom controls, scroll-back indicator) don't cover content.
 *
 * Returns `true` if the fit actually fired; `false` if the scene was empty
 * or the API threw. The caller can use this to decide whether to retry.
 */
function fitSceneToContent(api: ExcalidrawImperativeAPI): boolean {
	try {
		const els = api.getSceneElements();
		if (!els?.length) {
			return false;
		}
		api.scrollToContent(els, {
			fitToContent: true,
			viewportZoomFactor: FIT_VIEWPORT_PADDING_FACTOR,
		});
		return true;
	} catch (err) {
		console.warn("[ExcalidrawCanvas] fit-to-content failed:", err);
		return false;
	}
}

/**
 * Single source of truth for rendering Excalidraw scenes inside Fabric.
 *
 * Responsibilities:
 *  1. Lazy-load `@excalidraw/excalidraw` (keeps it out of the chat bundle
 *     until a diagram is actually shown).
 *  2. Convert MCP-shaped elements (label shorthand, missing arrays) into
 *     the Excalidraw runtime format via `convertToExcalidrawElements`,
 *     pinning `Excalifont` as the default font so converted scenes match
 *     the editor's rendering.
 *  3. After mount, wait for fonts to load and re-measure bound text so
 *     labels are centred (Excalidraw's first-render measurement uses
 *     fallback metrics when fonts arrive late, which mis-centres labels).
 *  4. Auto-fit the scene to the viewport once on initial layout. Two paths
 *     try to fit: a ResizeObserver that fires as soon as the wrapper gets
 *     a non-zero size (covers staging cases where the settle delay was
 *     too short or the API wasn't ready yet), and the settle pass itself
 *     once text positions are fixed. Both go through `fitSceneToContent`
 *     which zooms OUT to fit — never IN — so small scenes stay at their
 *     natural size and don't get blown up pixelated.
 *
 * Callers compose this with their own chrome — see `ExcalidrawPreview`
 * (inline read-only) and `ExcalidrawEditor` (fullscreen modal).
 */
export function ExcalidrawCanvas({
	elements,
	appState,
	viewModeEnabled = false,
	onChange,
	theme = "light",
	className,
	onApi,
}: ExcalidrawCanvasProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [readyElements, setReadyElements] = useState<LooseElement[] | null>(
		null,
	);
	const [excalidrawApi, setExcalidrawApi] =
		useState<ExcalidrawImperativeAPI | null>(null);
	const [settled, setSettled] = useState(false);
	const onApiRef = useRef(onApi);
	useEffect(() => {
		onApiRef.current = onApi;
	}, [onApi]);

	// Track whether we've already auto-fit the scene at least once. The
	// ResizeObserver below fires repeatedly during initial layout (the widget
	// goes 0×0 → real size and may bounce as fonts load); we only want to
	// auto-fit once so we don't fight the user if they pan/zoom afterwards.
	// Reset whenever the elements change (a new scene deserves a fresh fit).
	const hasAutoFitRef = useRef(false);
	useEffect(() => {
		hasAutoFitRef.current = false;
	}, [elements]);

	// Step 1 — Normalise raw elements to Excalidraw runtime format.
	// `convertToExcalidrawElements` expands label shorthand and fills in
	// `boundElements`/`groupIds`. When fonts aren't loaded yet the converter's
	// text-measurement uses fallback metrics, but we fix that in step 2.
	useEffect(() => {
		let cancelled = false;
		setSettled(false);

		(async () => {
			try {
				// MCP can emit pseudo-elements (camera moves, deletions, restore
				// markers) that aren't real scene nodes. Strip them before
				// handing anything to Excalidraw — otherwise the widget logs
				// "unknown element type" and skips the rest of the scene.
				const pseudoTypes = new Set([
					"cameraUpdate",
					"delete",
					"restoreCheckpoint",
				]);

				const hasConvertedText = elements.some(
					(el) =>
						(el as { type?: string }).type === "text" &&
						"containerId" in (el as Record<string, unknown>),
				);

				if (hasConvertedText) {
					// Already in Excalidraw format — just defensive normalisation.
					const normalized = elements
						.filter(
							(el) =>
								el?.type && !pseudoTypes.has(el.type as string),
						)
						.map((el) => ({
							...el,
							boundElements:
								(el as { boundElements?: unknown[] })
									.boundElements ?? [],
							groupIds:
								(el as { groupIds?: unknown[] }).groupIds ?? [],
						}));
					if (!cancelled) {
						setReadyElements(normalized);
					}
					return;
				}

				const { convertToExcalidrawElements, FONT_FAMILY } =
					await import("@excalidraw/excalidraw");
				const excalifont =
					(FONT_FAMILY as Record<string, number>).Excalifont ?? 1;

				const real = elements
					.filter(
						(el) => el?.type && !pseudoTypes.has(el.type as string),
					)
					.map((el) => {
						const base = el as Record<string, unknown>;
						const label = base.label as
							| Record<string, unknown>
							| undefined;
						return {
							...base,
							boundElements:
								(base.boundElements as unknown[]) ?? [],
							groupIds: (base.groupIds as unknown[]) ?? [],
							...(label
								? {
										label: {
											textAlign: "center",
											verticalAlign: "middle",
											fontFamily: excalifont,
											...label,
										},
									}
								: {}),
							...(base.type === "text"
								? {
										fontFamily:
											(base.fontFamily as number) ??
											excalifont,
									}
								: {}),
						};
					});

				// Excalidraw's converter uses generics we can't easily satisfy
				// from `unknown` — cast at the boundary, then re-narrow back.
				const converted = (
					convertToExcalidrawElements as unknown as (
						els: unknown[],
						opts?: { regenerateIds?: boolean },
					) => LooseElement[]
				)(real, { regenerateIds: false }).map((el) =>
					el.type === "text"
						? {
								...el,
								fontFamily:
									(el as { fontFamily?: number })
										.fontFamily ?? excalifont,
							}
						: el,
				);

				if (!cancelled) {
					setReadyElements(converted);
				}
			} catch (err) {
				console.error(
					"[ExcalidrawCanvas] Element conversion failed:",
					err,
				);
				if (!cancelled) {
					// Fall back to raw input so the canvas still attempts to
					// render rather than going blank — Excalidraw will skip
					// anything it can't parse.
					setReadyElements(
						elements
							.filter((el) => el?.id && el.type)
							.map((el) => ({
								...el,
								boundElements:
									(el as { boundElements?: unknown[] })
										.boundElements ?? [],
								groupIds:
									(el as { groupIds?: unknown[] }).groupIds ??
									[],
							})),
					);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [elements]);

	// Step 2 — After mount, settle bound-text positions and fit the viewport.
	// `convertToExcalidrawElements` measures text with whatever font is
	// currently loaded, so converted scenes can render with text drifted from
	// its container until fonts finish loading. Re-measure here.
	useEffect(() => {
		if (!excalidrawApi || settled) {
			return;
		}

		let cancelled = false;

		const settle = async () => {
			try {
				await document.fonts.load("20px Excalifont");
				await document.fonts.ready;
			} catch {
				// Font Loading API isn't critical — proceed with whatever
				// metrics the browser has. Worst case is mis-centred labels;
				// not a render-blocker.
			}

			// Allow Excalidraw's own mount-time effects to flush before we
			// touch the scene. Without this delay our `updateScene` can race
			// the widget's initial layout pass.
			await new Promise((r) => setTimeout(r, 200));
			if (cancelled) {
				return;
			}

			const sceneElements = excalidrawApi.getSceneElements();
			if (!sceneElements?.length) {
				setSettled(true);
				return;
			}

			const { CaptureUpdateAction } = await import(
				"@excalidraw/excalidraw"
			);

			const elemMap = new Map(
				sceneElements.map((el) => [
					(el as { id: string }).id,
					el as Record<string, unknown>,
				]),
			);

			const fixed = sceneElements.map((rawEl) => {
				const el = rawEl as Record<string, unknown>;
				if (
					el.type !== "text" ||
					!el.containerId ||
					(el.textAlign === "left" && el.verticalAlign === "top")
				) {
					return el;
				}

				const container = elemMap.get(el.containerId as string);
				if (!container) {
					return el;
				}

				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					return el;
				}

				const fontSize = (el.fontSize as number) ?? 20;
				const fontFamily =
					el.fontFamily === 5 || el.fontFamily === 1
						? "Excalifont"
						: "sans-serif";
				ctx.font = `${fontSize}px ${fontFamily}`;

				const text =
					(el.text as string) ?? (el.originalText as string) ?? "";
				const lines = text.split("\n");
				const lineHeight =
					fontSize * ((el.lineHeight as number) ?? 1.25);
				const textHeight = lines.length * lineHeight;
				const textWidth = Math.max(
					...lines.map((l) => ctx.measureText(l).width),
				);

				// Excalidraw containers reserve ~10px of inner padding; the
				// runtime widget uses the same constant when rendering, so
				// matching it here keeps text inside the container border.
				const padding = 10;
				const containerInnerW =
					(container.width as number) - padding * 2;
				const containerInnerH =
					(container.height as number) - padding * 2;

				let x = (container.x as number) + padding;
				let y = (container.y as number) + padding;

				if (el.textAlign === "center") {
					x =
						(container.x as number) +
						padding +
						(containerInnerW - textWidth) / 2;
				} else if (el.textAlign === "right") {
					x =
						(container.x as number) +
						padding +
						containerInnerW -
						textWidth;
				}

				if (el.verticalAlign === "middle") {
					y =
						(container.y as number) +
						padding +
						(containerInnerH - textHeight) / 2;
				}

				return {
					...el,
					x,
					y,
					width: textWidth,
					height: textHeight,
				};
			});

			if (cancelled) {
				return;
			}

			excalidrawApi.updateScene({
				elements: fixed,
				captureUpdate: CaptureUpdateAction.NEVER,
			});

			// Auto-fit the diagram now that text positions are correct. Without
			// this the user sees the top-left corner of an unbounded canvas —
			// which was the headline bug. We use `fitToContent` (zoom-out-only)
			// rather than `fitToViewport` (in-or-out) because the latter would
			// zoom IN small scenes past their natural size, which looks pixelated
			// and isn't what users expect from a "preview".
			if (fitSceneToContent(excalidrawApi)) {
				hasAutoFitRef.current = true;
			}

			requestAnimationFrame(() => {
				if (!cancelled) {
					setSettled(true);
				}
			});
		};

		// Slight delay lets dynamic-imported `Excalidraw` finish hydrating
		// before we ask for the scene.
		const timer = setTimeout(settle, 300);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [excalidrawApi, settled]);

	// Defensive auto-fit on initial layout.
	//
	// The settle effect above ALSO calls `fitSceneToContent`, but it does so
	// after a 300ms+font-load+200ms wait. In staging we saw cases where the
	// fit either fired too early (before Excalidraw had measured the canvas)
	// or didn't visibly zoom out even after the wait — tall diagrams stayed
	// clipped at their natural size.
	//
	// This effect watches the canvas wrapper with a ResizeObserver and fires
	// `fitSceneToContent` as soon as the wrapper transitions to a non-zero
	// size (which is the moment Excalidraw can actually act on a fit). It's a
	// one-shot — we only auto-fit ONCE per scene so the user's manual pan/zoom
	// isn't reset on every window resize. `hasAutoFitRef` resets when the
	// `elements` prop changes, so a new diagram gets a fresh fit.
	useEffect(() => {
		if (!excalidrawApi) {
			return;
		}
		const node = containerRef.current;
		if (!node || typeof ResizeObserver === "undefined") {
			return;
		}

		const tryFit = () => {
			if (hasAutoFitRef.current) {
				return;
			}
			if (fitSceneToContent(excalidrawApi)) {
				hasAutoFitRef.current = true;
			}
		};

		// Try once immediately in case the wrapper already has a size by the
		// time this effect runs (common for already-mounted parents).
		const rect = node.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			tryFit();
		}

		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (
					entry.contentRect.width > 0 &&
					entry.contentRect.height > 0
				) {
					tryFit();
				}
			}
		});
		ro.observe(node);
		return () => ro.disconnect();
	}, [excalidrawApi]);

	// Expose the imperative API to the parent once we have it. Done as an
	// effect so callers that mount us conditionally don't get the API before
	// React has committed.
	useEffect(() => {
		if (excalidrawApi) {
			onApiRef.current?.(excalidrawApi);
		}
	}, [excalidrawApi]);

	return (
		<div
			ref={containerRef}
			className={cn("relative h-full w-full", className)}
		>
			{!readyElements ? (
				<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
					Loading diagram…
				</div>
			) : (
				<Excalidraw
					excalidrawAPI={
						setExcalidrawApi as unknown as (api: unknown) => void
					}
					initialData={{
						elements: readyElements as unknown as never,
						// `viewModeEnabled` is controlled via the prop below,
						// not the appState, so caller-provided appState fields
						// (theme overrides, gridSize, etc.) don't accidentally
						// flip edit access on or off.
						appState: {
							viewBackgroundColor: "#ffffff",
							...(appState || {}),
						},
						scrollToContent: readyElements.length > 0,
					}}
					onChange={
						onChange
							? (((els: readonly LooseElement[]) => {
									const live = [...els].filter(
										(el) =>
											!(el as { isDeleted?: boolean })
												.isDeleted,
									) as LooseElement[];
									onChange(live);
								}) as unknown as never)
							: undefined
					}
					theme={theme}
					viewModeEnabled={viewModeEnabled}
				/>
			)}
		</div>
	);
}
