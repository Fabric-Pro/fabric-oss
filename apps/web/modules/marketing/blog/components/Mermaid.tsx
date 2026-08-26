"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Check, Copy, Expand, Loader2, Shrink, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface MermaidProps {
	chart: string;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 5;
const FIT_PADDING = 64;
const DEFAULT_DIAGRAM_HEIGHT = 280;
const RENDER_DEBOUNCE_MS = 180;

const DIAGRAM_PREFIXES = [
	"flowchart",
	"graph",
	"sequencediagram",
	"classdiagram",
	"statediagram-v2",
	"statediagram",
	"erdiagram",
	"journey",
	"gantt",
	"pie",
	"mindmap",
	"timeline",
	"gitgraph",
	"quadrantchart",
	"xychart-beta",
	"block-beta",
	"packet-beta",
	"sankey-beta",
	"kanban",
	"requirementdiagram",
	"c4context",
	"c4container",
	"c4component",
	"c4dynamic",
	"c4deployment",
] as const;

function normalizeMermaidChart(input: string): string {
	const withoutFences = input
		.replace(/^```(?:mermaid)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();

	if (!withoutFences) {
		return "";
	}

	const lines = withoutFences.split(/\r?\n/);
	const startIndex = lines.findIndex((line) => {
		const normalized = line.trimStart().toLowerCase();
		return DIAGRAM_PREFIXES.some(
			(prefix) =>
				normalized === prefix ||
				normalized.startsWith(`${prefix} `) ||
				normalized.startsWith(`${prefix}\t`) ||
				normalized.startsWith(`${prefix}{`) ||
				normalized.startsWith(`${prefix}(`),
		);
	});

	return (
		startIndex >= 0 ? lines.slice(startIndex).join("\n") : withoutFences
	)
		.trim()
		.replace(/\n{3,}/g, "\n\n");
}

function isIncompleteMermaid(input: string): boolean {
	const trimmed = input.trim();
	if (!trimmed) {
		return true;
	}

	if (/^```(?:mermaid)?$/i.test(trimmed)) {
		return true;
	}

	const lowered = trimmed.toLowerCase();
	const firstLine = lowered.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (!firstLine) {
		return true;
	}

	const matchesKnownPrefix = DIAGRAM_PREFIXES.some(
		(prefix) =>
			firstLine === prefix ||
			firstLine.startsWith(`${prefix} `) ||
			firstLine.startsWith(`${prefix}\t`) ||
			firstLine.startsWith(`${prefix}{`) ||
			firstLine.startsWith(`${prefix}(`),
	);
	if (matchesKnownPrefix) {
		return false;
	}

	return DIAGRAM_PREFIXES.some(
		(prefix) =>
			prefix.startsWith(firstLine) || firstLine.startsWith(prefix),
	);
}

function looksLikeMermaidErrorSvg(svg: string): boolean {
	const lowered = svg.toLowerCase();
	return (
		lowered.includes("syntax error in text") ||
		lowered.includes("unknown diagram error") ||
		lowered.includes("mermaid version")
	);
}

export function Mermaid({ chart }: MermaidProps) {
	const t = useTranslations("tooltips.marketing");
	const tCommon = useTranslations("tooltips.common");
	const wrapRef = useRef<HTMLDivElement>(null);
	const diagramRef = useRef<HTMLDivElement>(null);
	const baseSizeRef = useRef<{ width: number; height: number } | null>(null);
	const hasManualViewRef = useRef(false);
	const isPointerInsideRef = useRef(false);
	const zoomRef = useRef(1);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [zoom, setZoom] = useState(1);
	const [svg, setSvg] = useState<string>("");
	const [error, setError] = useState<string>("");
	const [diagramBg, setDiagramBg] = useState<string>("transparent");
	const [isFocusOpen, setIsFocusOpen] = useState(false);
	const [mounted, setMounted] = useState(false);
	const [isRendering, setIsRendering] = useState(false);
	const [copied, setCopied] = useState(false);
	const [reservedHeight, setReservedHeight] = useState(
		DEFAULT_DIAGRAM_HEIGHT,
	);
	const { resolvedTheme } = useTheme();

	const normalizedChart = useMemo(
		() => normalizeMermaidChart(chart),
		[chart],
	);
	const chartIsIncomplete = useMemo(
		() => isIncompleteMermaid(normalizedChart),
		[normalizedChart],
	);

	const getSvgDimensions = useCallback(() => {
		const svgElement = diagramRef.current?.querySelector("svg");
		if (!svgElement) {
			return null;
		}

		const viewBox = svgElement.getAttribute("viewBox");
		if (viewBox) {
			const parts = viewBox.split(/\s+/).map(Number);
			if (
				parts.length === 4 &&
				Number.isFinite(parts[2]) &&
				Number.isFinite(parts[3])
			) {
				return { width: parts[2], height: parts[3] };
			}
		}

		const width = Number.parseFloat(svgElement.getAttribute("width") || "");
		const height = Number.parseFloat(
			svgElement.getAttribute("height") || "",
		);
		if (
			Number.isFinite(width) &&
			Number.isFinite(height) &&
			width > 0 &&
			height > 0
		) {
			return { width, height };
		}

		const box = svgElement.getBoundingClientRect();
		if (box.width > 0 && box.height > 0) {
			return { width: box.width, height: box.height };
		}

		return null;
	}, []);

	const centerViewport = useCallback(
		(nextZoom = zoomRef.current) => {
			const wrap = wrapRef.current;
			const dimensions = getSvgDimensions();
			if (!wrap || !dimensions) {
				return;
			}

			const scaledWidth = dimensions.width * nextZoom;
			const scaledHeight = dimensions.height * nextZoom;
			wrap.scrollLeft = Math.max(0, (scaledWidth - wrap.clientWidth) / 2);
			wrap.scrollTop = Math.max(
				0,
				(scaledHeight - wrap.clientHeight) / 2,
			);
		},
		[getSvgDimensions],
	);

	const applyZoom = useCallback(
		(next: number, manual = true) => {
			const clamped = Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM);
			zoomRef.current = clamped;
			setZoom(clamped);
			if (manual) {
				hasManualViewRef.current = true;
			}
			const svgElement = diagramRef.current?.querySelector("svg");
			const baseSize = baseSizeRef.current ?? getSvgDimensions();
			if (svgElement && baseSize) {
				baseSizeRef.current = baseSize;
				svgElement.style.width = `${baseSize.width * clamped}px`;
				svgElement.style.height = `${baseSize.height * clamped}px`;
				svgElement.style.maxWidth = "none";
			}
			if (diagramRef.current) {
				diagramRef.current.style.transform = "none";
			}
			if (wrapRef.current) {
				wrapRef.current.classList.toggle("is-zoomed", clamped > 1.01);
			}
		},
		[getSvgDimensions],
	);

	const fitToContainer = useCallback(() => {
		const wrap = wrapRef.current;
		const dimensions = getSvgDimensions();
		if (!wrap || !dimensions) {
			return;
		}

		const availableWidth = Math.max(1, wrap.clientWidth - FIT_PADDING);
		const fitZoom = Math.min(1, availableWidth / dimensions.width);
		applyZoom(fitZoom, false);
		requestAnimationFrame(() => centerViewport(fitZoom));
	}, [applyZoom, centerViewport, getSvgDimensions]);

	const reserveCurrentHeight = useCallback(() => {
		const currentHeight = wrapRef.current?.getBoundingClientRect().height;
		if (currentHeight && currentHeight > 0) {
			setReservedHeight((prev) =>
				Math.max(prev, Math.round(currentHeight)),
			);
		}
	}, []);

	const copyDiagram = useCallback(async () => {
		await navigator.clipboard.writeText(normalizedChart || chart);
		setCopied(true);
		if (copyTimeoutRef.current) {
			clearTimeout(copyTimeoutRef.current);
		}
		copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
	}, [chart, normalizedChart]);

	useEffect(() => {
		if (!svg) {
			return;
		}

		const onWheel = (e: WheelEvent) => {
			if (!isPointerInsideRef.current) {
				return;
			}
			const allowZoom = e.ctrlKey || e.metaKey;
			if (!allowZoom) {
				return;
			}
			e.preventDefault();
			applyZoom(zoomRef.current * (e.deltaY < 0 ? 1.1 : 0.9), true);
		};

		window.addEventListener("wheel", onWheel, {
			passive: false,
			capture: true,
		});
		return () =>
			window.removeEventListener("wheel", onWheel, {
				capture: true,
			});
	}, [svg, applyZoom, isFocusOpen]);

	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap || !svg) {
			return;
		}

		let panning = false;
		let startX = 0;
		let startY = 0;
		let scrollL = 0;
		let scrollT = 0;

		const onMouseDown = (e: MouseEvent) => {
			if (
				(e.target as Element).closest(
					".zoom-controls, .mermaid-toolbar",
				)
			) {
				return;
			}
			if (zoomRef.current <= 1) {
				return;
			}
			panning = true;
			startX = e.clientX;
			startY = e.clientY;
			scrollL = wrap.scrollLeft;
			scrollT = wrap.scrollTop;
			wrap.classList.add("is-panning");
		};

		const onMouseMove = (e: MouseEvent) => {
			if (!panning) {
				return;
			}
			wrap.scrollLeft = scrollL - (e.clientX - startX);
			wrap.scrollTop = scrollT - (e.clientY - startY);
		};

		const onMouseUp = () => {
			if (!panning) {
				return;
			}
			panning = false;
			wrap.classList.remove("is-panning");
		};

		wrap.addEventListener("mousedown", onMouseDown);
		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);

		return () => {
			wrap.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [svg]);

	useEffect(() => {
		setMounted(true);
		return () => {
			if (copyTimeoutRef.current) {
				clearTimeout(copyTimeoutRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (!mounted) {
			return;
		}

		if (!normalizedChart || chartIsIncomplete) {
			setIsRendering(true);
			setError("");
			return;
		}

		let cancelled = false;
		setIsRendering(true);
		reserveCurrentHeight();

		const timeout = window.setTimeout(async () => {
			try {
				const isDark = resolvedTheme === "dark";
				let enhancedSvg = "";
				let nextBg = isDark ? "#1a1b26" : "#f5f5f5";
				const mermaid = (await import("mermaid")).default;

				mermaid.initialize({
					startOnLoad: false,
					theme: isDark ? "dark" : "default",
					securityLevel: "loose",
				});

				await mermaid.parse(normalizedChart);

				try {
					const beautifulMermaid = await import("beautiful-mermaid");
					const theme =
						(isDark
							? beautifulMermaid.THEMES?.["tokyo-night"]
							: beautifulMermaid.THEMES?.default) ??
						beautifulMermaid.THEMES?.default ??
						({
							bg: isDark ? "#1a1b26" : "#f5f5f5",
							fg: isDark ? "#a9b1d6" : "#333333",
						} as const);
					nextBg = theme.bg;
					const renderedSvg = await beautifulMermaid.renderMermaid(
						normalizedChart,
						theme,
					);
					if (looksLikeMermaidErrorSvg(renderedSvg)) {
						throw new Error("Mermaid syntax error");
					}
					enhancedSvg = renderedSvg.replace(
						/<svg /,
						`<svg data-renderer="beautiful-mermaid" data-theme="${isDark ? "dark" : "light"}" `,
					);
				} catch {
					const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
					const { svg: renderedSvg } = await mermaid.render(
						id,
						normalizedChart,
					);
					if (looksLikeMermaidErrorSvg(renderedSvg)) {
						throw new Error("Mermaid syntax error");
					}
					enhancedSvg = renderedSvg.replace(
						/<svg /,
						`<svg data-renderer="mermaid" data-theme="${isDark ? "dark" : "light"}" `,
					);
				}

				if (!cancelled) {
					setSvg(enhancedSvg);
					setDiagramBg(nextBg);
					setError("");
					hasManualViewRef.current = false;
					baseSizeRef.current = null;
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							fitToContainer();
							const measuredHeight =
								wrapRef.current?.getBoundingClientRect().height;
							if (measuredHeight && measuredHeight > 0) {
								setReservedHeight(
									Math.max(
										DEFAULT_DIAGRAM_HEIGHT,
										Math.round(measuredHeight),
									),
								);
							}
							setIsRendering(false);
						});
					});
				}
			} catch (err) {
				if (!cancelled) {
					console.error("Mermaid error:", err);
					setSvg("");
					setError(
						err instanceof Error
							? err.message
							: "Failed to render diagram",
					);
					setIsRendering(false);
				}
			}
		}, RENDER_DEBOUNCE_MS);

		return () => {
			cancelled = true;
			window.clearTimeout(timeout);
		};
	}, [
		chartIsIncomplete,
		fitToContainer,
		mounted,
		normalizedChart,
		reserveCurrentHeight,
		resolvedTheme,
	]);

	useEffect(() => {
		if (!svg) {
			return;
		}
		const onResize = () => {
			if (!hasManualViewRef.current) {
				fitToContainer();
			}
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [svg, fitToContainer]);

	useEffect(() => {
		if (!isFocusOpen) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setIsFocusOpen(false);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		hasManualViewRef.current = false;
		requestAnimationFrame(() => fitToContainer());
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
		};
	}, [isFocusOpen, fitToContainer]);

	if (!mounted) {
		return (
			<div className="my-6 flex min-h-[280px] items-center justify-center rounded-xl border bg-muted/30">
				<div className="text-muted-foreground text-sm">
					Loading diagram...
				</div>
			</div>
		);
	}

	if (error && !svg) {
		return (
			<div className="my-6 rounded-xl border border-destructive/50 bg-destructive/10 p-4">
				<p className="mb-2 font-semibold text-destructive text-sm">
					Failed to render diagram
				</p>
				<pre className="overflow-auto text-xs whitespace-pre-wrap">
					{error}
				</pre>
			</div>
		);
	}

	const diagramShell = (
		<div
			ref={wrapRef}
			className={`mermaid-wrap group relative overflow-auto rounded-2xl border shadow-sm ${
				isFocusOpen ? "h-full max-h-none" : "my-6"
			}`}
			onPointerEnter={() => {
				isPointerInsideRef.current = true;
			}}
			onPointerLeave={() => {
				isPointerInsideRef.current = false;
			}}
			style={{
				backgroundColor: isFocusOpen ? diagramBg : "transparent",
				borderColor: isFocusOpen ? undefined : "transparent",
				boxShadow: isFocusOpen ? undefined : "none",
				minHeight: `${reservedHeight}px`,
			}}
		>
			<div className="mermaid-toolbar absolute top-2 left-2 z-20 flex items-center gap-1 rounded-md border bg-background/95 p-1 shadow-sm backdrop-blur-sm">
				<div className="flex items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground">
					<svg
						className="h-3.5 w-3.5"
						viewBox="0 0 24 24"
						fill="currentColor"
						aria-hidden="true"
					>
						<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
					</svg>
					<span>Mermaid</span>
				</div>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => void copyDiagram()}
							className="flex h-7 items-center justify-center rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label="Copy Mermaid source"
						>
							{copied ? (
								<>
									<Check className="mr-1 h-3.5 w-3.5" />
									Copied
								</>
							) : (
								<>
									<Copy className="mr-1 h-3.5 w-3.5" />
									Copy
								</>
							)}
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{copied ? tCommon("copied") : t("copyMermaidSource")}
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => setIsFocusOpen((prev) => !prev)}
							className="flex h-7 items-center justify-center rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label={
								isFocusOpen
									? "Close full-screen diagram"
									: "Open full-screen diagram"
							}
						>
							{isFocusOpen ? (
								<>
									<Shrink className="mr-1 h-3.5 w-3.5" />
									Close
								</>
							) : (
								<>
									<Expand className="mr-1 h-3.5 w-3.5" />
									Full screen
								</>
							)}
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{t(
							isFocusOpen
								? "closeFullScreenDiagram"
								: "openFullScreenDiagram",
						)}
					</TooltipContent>
				</Tooltip>
			</div>

			<div className="zoom-controls absolute top-2 right-2 z-20 flex gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-sm backdrop-blur-sm">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() =>
								applyZoom(zoomRef.current * 0.8, true)
							}
							disabled={zoom <= MIN_ZOOM}
							className="flex h-7 w-7 items-center justify-center rounded font-mono text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
							aria-label={t("zoomOut")}
						>
							−
						</button>
					</TooltipTrigger>
					<TooltipContent>{t("zoomOut")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => {
								hasManualViewRef.current = false;
								fitToContainer();
							}}
							className="flex h-7 min-w-10 items-center justify-center rounded px-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label={t("resetZoom")}
						>
							{Math.round(zoom * 100)}%
						</button>
					</TooltipTrigger>
					<TooltipContent>{t("resetZoom")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() =>
								applyZoom(zoomRef.current * 1.2, true)
							}
							disabled={zoom >= MAX_ZOOM}
							className="flex h-7 w-7 items-center justify-center rounded font-mono text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
							aria-label={t("zoomIn")}
						>
							+
						</button>
					</TooltipTrigger>
					<TooltipContent>{t("zoomIn")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => setIsFocusOpen(false)}
							className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label="Close diagram"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{t("closeDiagram")}</TooltipContent>
				</Tooltip>
			</div>

			{svg ? (
				<div
					className={
						isFocusOpen ? "p-4 pt-14 sm:p-6 sm:pt-14" : "pt-14"
					}
				>
					<div
						ref={diagramRef}
						className="mermaid-diagram inline-block transition-transform duration-200 ease-out"
						style={{
							transformOrigin: "top left",
							minWidth: "fit-content",
						}}
						// biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid generates trusted SVG
						dangerouslySetInnerHTML={{ __html: svg }}
					/>
				</div>
			) : (
				<div className="flex min-h-[280px] items-center justify-center pt-14">
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						{chartIsIncomplete || isRendering
							? "Rendering diagram..."
							: "Preparing diagram..."}
					</div>
				</div>
			)}

			<p className="pb-3 text-center font-mono text-xs text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-60 select-none">
				scroll to move · ctrl+scroll to zoom · drag to pan
			</p>
		</div>
	);

	return (
		<>
			{isFocusOpen && mounted
				? createPortal(
						<div className="fixed inset-0 z-[200]">
							<button
								type="button"
								aria-label="Close focused diagram"
								onClick={() => setIsFocusOpen(false)}
								className="absolute inset-0 bg-background/70 backdrop-blur-sm"
							/>
							<div className="absolute inset-4">
								{diagramShell}
							</div>
						</div>,
						document.body,
					)
				: null}
			{!isFocusOpen ? diagramShell : null}
		</>
	);
}
