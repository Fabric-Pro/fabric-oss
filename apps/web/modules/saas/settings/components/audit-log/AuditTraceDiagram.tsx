"use client";

/**
 * AuditTraceDiagram
 *
 * Renders every audit event sharing a correlation ID, plus any low-level
 * spans persisted on failure (item 4), as either a horizontal flow or a
 * vertical timeline. The component supports two presentations:
 *
 *  - `presentation: "sheet-left"` (default, item 1 of v2): opens as a
 *    Sheet from the LEFT side of the screen so the user can see both the
 *    row metadata drawer (which is the right-side Sheet) and the trace
 *    simultaneously. Closing the trace returns the user to the row
 *    detail drawer; closing the drawer dismisses both.
 *
 *  - `presentation: "dialog"`: full-screen modal (the previous v1
 *    behavior). Retained for places that still want the standalone
 *    fullscreen experience.
 *
 * Layout:
 *  - `layout: "vertical"` (default): each event stacks vertically,
 *    connected by a vertical line. Scrolls along the page axis only —
 *    no horizontal scroll. Compact node cards (full-width minus padding)
 *    keep all metadata in view.
 *  - `layout: "horizontal"`: legacy flexbox row of nodes connected by
 *    horizontal lines. Used in the dialog presentation.
 *
 * Nodes are typed by `kind`:
 *  - `audit` — primary timeline event (an `AuditLog` row). Full-bleed
 *    card, outcome icon, latency.
 *  - `db | temporal_workflow | temporal_activity | http_outbound | other`
 *    — a `RequestSpan` row persisted on failure (tail-sampled).
 *    Visually subtler than an audit node so the user-action timeline
 *    stays primary.
 *
 * Export: serialize the surface as a standalone SVG via `buildTraceSvg`
 * and download via `URL.createObjectURL`. The SVG is text-only — no
 * `html2canvas` dependency.
 *
 * Spec: punch list item 28 + v2 punch list items 1 and 4.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightLeft,
	CheckCircle2Icon,
	Database,
	DownloadIcon,
	ExternalLinkIcon,
	GitBranch,
	Globe,
	XCircleIcon,
	Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";

type TraceLayout = "horizontal" | "vertical";
type TracePresentation = "dialog" | "sheet-left";

type TraceSpanKind =
	| "db"
	| "temporal_workflow"
	| "temporal_activity"
	| "http_outbound"
	| "other";

interface AuditTraceDiagramProps {
	organizationId: string | null;
	correlationId: string | null;
	open: boolean;
	onClose: () => void;
	onShowInTable: (correlationId: string) => void;
	/**
	 * Visual orientation of the timeline. Defaults to "vertical" to fit
	 * the new sheet-left presentation, where horizontal real estate is
	 * limited and a top-to-bottom flow scrolls cleanly.
	 */
	layout?: TraceLayout;
	/**
	 * How the panel is rendered. Defaults to "sheet-left" — see file
	 * doc-block. Switch to "dialog" for full-screen presentations.
	 */
	presentation?: TracePresentation;
}

export interface TraceAuditRow {
	id: string;
	action: string;
	createdAt: string | Date;
	outcome: string;
	severity: string;
	actorEmailSnapshot: string | null;
	actorNameSnapshot: string | null;
	actorType: string;
	resourceName: string | null;
	durationMs: number | null;
	metadata: unknown;
}

interface TraceSpan {
	id: string;
	correlationId: string;
	kind: TraceSpanKind;
	name: string;
	startedAt: string | Date;
	durationMs: number | null;
	status: string;
	errorMessage: string | null;
	attributes: unknown;
}

interface TraceTimelineItem {
	type: "audit" | "span";
	timestamp: number;
	audit?: TraceAuditRow;
	span?: TraceSpan;
}

function formatLatency(ms: number | null): string | null {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
		return null;
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

function makeActorLabel(row: TraceAuditRow): string {
	if (row.actorType === "api_key") {
		return row.actorNameSnapshot ?? "API key";
	}
	return row.actorEmailSnapshot ?? row.actorNameSnapshot ?? row.actorType;
}

function spanIcon(kind: TraceSpanKind) {
	switch (kind) {
		case "db":
			return Database;
		case "temporal_workflow":
			return GitBranch;
		case "temporal_activity":
			return Zap;
		case "http_outbound":
			return Globe;
		default:
			return ArrowRightLeft;
	}
}

function spanLabel(kind: TraceSpanKind): string {
	switch (kind) {
		case "db":
			return "DB";
		case "temporal_workflow":
			return "Workflow";
		case "temporal_activity":
			return "Activity";
		case "http_outbound":
			return "HTTP";
		default:
			return "Span";
	}
}

/**
 * Encode a snapshot of the diagram surface as an SVG Blob and trigger
 * download. We synthesize a standalone SVG that mirrors the DOM
 * layout — no `html2canvas` dependency. The SVG contains the title,
 * each node's text + outcome glyph, and connecting lines.
 *
 * Returns the synthesized SVG string for tests (the production path
 * always triggers a Blob download). Defaults to horizontal layout —
 * the export image is meant for an embedded preview that reads left
 * to right regardless of the on-screen orientation.
 */
export function buildTraceSvg(rows: TraceAuditRow[]): string {
	const NODE_WIDTH = 220;
	const NODE_HEIGHT = 110;
	const SPACING = 60;
	const PADDING = 40;
	const totalWidth =
		rows.length === 0
			? 600
			: rows.length * NODE_WIDTH +
				(rows.length - 1) * SPACING +
				PADDING * 2;
	const totalHeight = NODE_HEIGHT + PADDING * 2 + 60;
	const baseY = PADDING + 30;

	const nodes = rows
		.map((row, i) => {
			const x = PADDING + i * (NODE_WIDTH + SPACING);
			const isFailure = row.outcome === "failure";
			const strokeColor = isFailure ? "#dc2626" : "#059669";
			const actor = makeActorLabel(row).replace(/[<>&]/g, "");
			const action = row.action.replace(/[<>&]/g, "");
			const latency = formatLatency(row.durationMs);
			const dt = new Date(row.createdAt);
			const time = Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
			return `
			<g>
				<rect
					x="${x}" y="${baseY}"
					width="${NODE_WIDTH}" height="${NODE_HEIGHT}"
					rx="8" ry="8"
					fill="#fafaf9"
					stroke="${strokeColor}"
					stroke-width="1.5"
				/>
				<circle
					cx="${x + 18}" cy="${baseY + 22}"
					r="7"
					fill="${strokeColor}"
				/>
				<text x="${x + 36}" y="${baseY + 27}" font-family="ui-sans-serif, system-ui" font-size="12" font-weight="600" fill="#27272a">${action}</text>
				<text x="${x + 14}" y="${baseY + 56}" font-family="ui-sans-serif, system-ui" font-size="11" fill="#52525b">${actor}</text>
				<text x="${x + 14}" y="${baseY + 76}" font-family="ui-monospace, monospace" font-size="10" fill="#71717a">${time}</text>
				${latency ? `<text x="${x + 14}" y="${baseY + 96}" font-family="ui-monospace, monospace" font-size="10" fill="#71717a">${latency}</text>` : ""}
			</g>
			${i > 0 ? `<line x1="${x - SPACING}" y1="${baseY + NODE_HEIGHT / 2}" x2="${x}" y2="${baseY + NODE_HEIGHT / 2}" stroke="#a1a1aa" stroke-width="1.5" />` : ""}
			`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">
	<rect width="${totalWidth}" height="${totalHeight}" fill="#ffffff" />
	<text x="${PADDING}" y="28" font-family="ui-sans-serif, system-ui" font-size="14" font-weight="700" fill="#27272a">Audit trace (${rows.length} event${rows.length === 1 ? "" : "s"})</text>
	${nodes}
</svg>`;
}

function HeaderInner({
	titleId: _titleId,
	correlationId,
	rowsAvailable,
	onShowInTable,
	onExport,
	t,
}: {
	titleId: string;
	correlationId: string | null;
	rowsAvailable: boolean;
	onShowInTable: (id: string) => void;
	onExport: () => void;
	t: ReturnType<typeof useTranslations>;
}) {
	return (
		<div className="flex flex-col gap-1">
			<span className="app-editorial-label">
				{t("settings.auditLog.traceDiagram.title")}
			</span>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="font-serif text-2xl">
					{t("settings.auditLog.traceDiagram.title")}
				</div>
				<div className="flex items-center gap-2">
					{correlationId ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => onShowInTable(correlationId)}
							className="gap-2"
						>
							<ExternalLinkIcon className="size-3.5" />
							{t(
								"settings.auditLog.traceDiagram.openFullCorrelation",
							)}
						</Button>
					) : null}
					<Button
						variant="outline"
						size="sm"
						onClick={onExport}
						disabled={!rowsAvailable}
						className="gap-2"
						data-testid="audit-trace-export"
					>
						<DownloadIcon className="size-3.5" />
						{t("settings.auditLog.traceDiagram.exportPng")}
					</Button>
				</div>
			</div>
			<p className="text-sm text-muted-foreground">
				{t("settings.auditLog.traceDiagram.description")}
			</p>
			{correlationId ? (
				<code className="font-mono text-xs text-muted-foreground">
					{correlationId}
				</code>
			) : null}
		</div>
	);
}

function AuditNode({
	row,
	layout,
	index,
	t,
}: {
	row: TraceAuditRow;
	layout: TraceLayout;
	index: number;
	t: ReturnType<typeof useTranslations>;
}) {
	const isFailure = row.outcome === "failure";
	const actor = makeActorLabel(row);
	const created = new Date(row.createdAt);
	let relative = "";
	try {
		relative = formatDistanceToNow(created, { addSuffix: true });
	} catch {
		relative = created.toISOString();
	}
	const latency = formatLatency(row.durationMs);

	if (layout === "vertical") {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<div
						className={cn(
							"flex w-full flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm",
							isFailure
								? "border-destructive/50"
								: "border-secondary/40",
						)}
						data-testid={`audit-trace-node-${index}`}
					>
						<div className="flex items-center justify-between gap-2">
							<div className="flex min-w-0 items-center gap-2">
								{isFailure ? (
									<XCircleIcon className="size-4 shrink-0 text-destructive" />
								) : (
									<CheckCircle2Icon className="size-4 shrink-0 text-secondary" />
								)}
								<code className="truncate font-mono text-xs font-semibold text-foreground">
									{row.action}
								</code>
							</div>
							{latency ? (
								<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
									{latency}
								</span>
							) : null}
						</div>
						<div className="flex items-center justify-between gap-2">
							<span className="truncate text-xs text-foreground">
								{actor}
							</span>
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
								{relative}
							</span>
						</div>
					</div>
				</TooltipTrigger>
				<TooltipContent
					side="right"
					className="max-w-sm space-y-1 text-xs"
				>
					<div className="font-semibold">{row.action}</div>
					<div>
						{t("settings.auditLog.traceDiagram.node.actor", {
							actor,
						} as never)}
					</div>
					<div>
						{t("settings.auditLog.traceDiagram.node.timestamp", {
							timestamp: created.toISOString(),
						} as never)}
					</div>
					{row.resourceName ? <div>{row.resourceName}</div> : null}
				</TooltipContent>
			</Tooltip>
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					className={cn(
						"flex w-56 flex-col gap-2 rounded-lg border bg-card p-4 shadow-sm",
						isFailure
							? "border-destructive/50"
							: "border-secondary/40",
					)}
					data-testid={`audit-trace-node-${index}`}
				>
					<div className="flex items-center gap-2">
						{isFailure ? (
							<XCircleIcon className="size-4 shrink-0 text-destructive" />
						) : (
							<CheckCircle2Icon className="size-4 shrink-0 text-secondary" />
						)}
						<code className="truncate font-mono text-xs font-semibold text-foreground">
							{row.action}
						</code>
					</div>
					<div className="text-xs text-foreground">{actor}</div>
					<div className="font-mono text-[10px] text-muted-foreground">
						{relative}
					</div>
					{latency ? (
						<div className="font-mono text-[10px] text-muted-foreground">
							{latency}
						</div>
					) : null}
				</div>
			</TooltipTrigger>
			<TooltipContent
				side="bottom"
				className="max-w-sm space-y-1 text-xs"
			>
				<div className="font-semibold">{row.action}</div>
				<div>
					{t("settings.auditLog.traceDiagram.node.actor", {
						actor,
					} as never)}
				</div>
				<div>
					{t("settings.auditLog.traceDiagram.node.timestamp", {
						timestamp: created.toISOString(),
					} as never)}
				</div>
				{row.resourceName ? <div>{row.resourceName}</div> : null}
			</TooltipContent>
		</Tooltip>
	);
}

function SpanNode({ span, index }: { span: TraceSpan; index: number }) {
	const Icon = spanIcon(span.kind);
	const isFailure = span.status === "error";
	const latency = formatLatency(span.durationMs);
	const started = new Date(span.startedAt);
	let relative = "";
	try {
		relative = formatDistanceToNow(started, { addSuffix: true });
	} catch {
		relative = started.toISOString();
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					className={cn(
						"flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-1.5",
						"bg-muted/30 text-muted-foreground",
						isFailure
							? "border-destructive/40"
							: "border-border/60",
					)}
					data-testid={`audit-trace-span-${index}`}
					data-span-kind={span.kind}
				>
					<Icon
						aria-hidden
						className={cn(
							"size-3 shrink-0",
							isFailure ? "text-destructive" : "",
						)}
					/>
					<span className="text-[10px] uppercase tracking-wider text-muted-foreground">
						{spanLabel(span.kind)}
					</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">
						{span.name}
					</span>
					{latency ? (
						<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
							{latency}
						</span>
					) : null}
				</div>
			</TooltipTrigger>
			<TooltipContent side="right" className="max-w-sm space-y-1 text-xs">
				<div className="font-semibold">
					[{spanLabel(span.kind)}] {span.name}
				</div>
				<div>started: {started.toISOString()}</div>
				<div>relative: {relative}</div>
				{latency ? <div>duration: {latency}</div> : null}
				{span.status === "error" && span.errorMessage ? (
					<div className="text-destructive">
						error: {span.errorMessage}
					</div>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}

interface DiagramSurfaceProps {
	rows: TraceAuditRow[];
	spans: TraceSpan[];
	layout: TraceLayout;
	isLoading: boolean;
	isError: boolean;
	t: ReturnType<typeof useTranslations>;
	surfaceRef: React.RefObject<HTMLDivElement | null>;
}

function DiagramSurface({
	rows,
	spans,
	layout,
	isLoading,
	isError,
	t,
	surfaceRef,
}: DiagramSurfaceProps) {
	const items: TraceTimelineItem[] = useMemo(() => {
		const merged: TraceTimelineItem[] = [];
		for (const row of rows) {
			const created = new Date(row.createdAt).getTime();
			merged.push({
				type: "audit",
				audit: row,
				timestamp: Number.isFinite(created) ? created : 0,
			});
		}
		for (const span of spans) {
			const started = new Date(span.startedAt).getTime();
			merged.push({
				type: "span",
				span,
				timestamp: Number.isFinite(started) ? started : 0,
			});
		}
		merged.sort((a, b) => a.timestamp - b.timestamp);
		return merged;
	}, [rows, spans]);

	if (isLoading) {
		return (
			<div
				ref={surfaceRef}
				className="flex min-h-[280px] flex-col gap-2 overflow-y-auto p-6"
			>
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}

	if (isError) {
		return (
			<div ref={surfaceRef} className="min-h-[280px] overflow-auto p-6">
				<div
					role="alert"
					className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
				>
					{t("settings.auditLog.error.defaultMessage")}
				</div>
			</div>
		);
	}

	if (items.length === 0) {
		return (
			<div ref={surfaceRef} className="min-h-[280px] overflow-auto p-6">
				<aside
					aria-live="polite"
					className="flex flex-col items-start gap-2 rounded-lg border border-border/60 bg-muted/40 p-8 text-sm"
					data-testid="audit-trace-empty"
				>
					<span className="app-editorial-label">
						{t("settings.auditLog.traceDiagram.title")}
					</span>
					<div className="font-serif text-xl text-foreground">
						{t("settings.auditLog.traceDiagram.empty")}
					</div>
					<p className="text-muted-foreground">
						{t("settings.auditLog.traceDiagram.emptyDescription")}
					</p>
				</aside>
			</div>
		);
	}

	if (layout === "horizontal") {
		// Audit-only rendering for the legacy horizontal flow. Spans are
		// not visualized here — the horizontal preset is meant for the
		// SVG export image.
		return (
			<div ref={surfaceRef} className="min-h-[280px] overflow-auto p-6">
				<ol
					className="flex items-start gap-6 overflow-x-auto pb-4"
					data-testid="audit-trace-nodes"
				>
					{rows.map((row, index) => (
						<li key={row.id} className="flex items-start gap-3">
							<AuditNode
								row={row}
								layout="horizontal"
								index={index}
								t={t}
							/>
							{index < rows.length - 1 ? (
								<div
									aria-hidden="true"
									className="mt-12 h-px w-12 shrink-0 bg-border"
								/>
							) : null}
						</li>
					))}
				</ol>
			</div>
		);
	}

	// Vertical layout (default for sheet-left) — one row per item,
	// connected by a thin vertical line. Spans are visually subtler
	// than audit nodes so the user-action backbone stays primary.
	return (
		<div ref={surfaceRef} className="min-h-[280px] overflow-y-auto p-6">
			<ol
				className="relative flex flex-col gap-3"
				data-testid="audit-trace-nodes"
			>
				{/* Connecting vertical line behind every item except the
						terminal one. */}
				<div
					aria-hidden="true"
					className="absolute left-[7px] top-3 bottom-3 w-px bg-border"
				/>
				{items.map((item, index) => {
					if (item.type === "audit" && item.audit) {
						return (
							<li
								key={`a-${item.audit.id}`}
								className="relative flex items-start gap-3 pl-5"
							>
								<span
									aria-hidden="true"
									className={cn(
										"absolute left-[3px] top-3 size-2 rounded-full",
										item.audit.outcome === "failure"
											? "bg-destructive"
											: "bg-secondary",
									)}
								/>
								<div className="min-w-0 flex-1">
									<AuditNode
										row={item.audit}
										layout="vertical"
										index={index}
										t={t}
									/>
								</div>
							</li>
						);
					}
					if (item.type === "span" && item.span) {
						return (
							<li
								key={`s-${item.span.id}`}
								className="relative flex items-start gap-3 pl-5"
							>
								<span
									aria-hidden="true"
									className={cn(
										"absolute left-[4px] top-3 size-1.5 rounded-full",
										item.span.status === "error"
											? "bg-destructive/70"
											: "bg-muted-foreground/40",
									)}
								/>
								<div className="min-w-0 flex-1">
									<SpanNode span={item.span} index={index} />
								</div>
							</li>
						);
					}
					return null;
				})}
			</ol>
		</div>
	);
}

export function AuditTraceDiagram({
	organizationId,
	correlationId,
	open,
	onClose,
	onShowInTable,
	layout = "vertical",
	presentation = "sheet-left",
}: AuditTraceDiagramProps) {
	const t = useTranslations();
	const surfaceRef = useRef<HTMLDivElement>(null);

	// `audit.tracedRequest` returns audit rows + low-level spans
	// interleaved by timestamp. Falls back to plain `audit.list`
	// (correlation filter) when tracedRequest is unavailable.
	const { data, isLoading, isError } = useQuery({
		queryKey: [
			"audit-log",
			"trace",
			organizationId,
			correlationId,
		] as const,
		queryFn: async () => {
			const traced = (
				orpcClient.audit as unknown as {
					tracedRequest?: (input: {
						organizationId: string | null;
						correlationId: string;
					}) => Promise<{
						items: TraceAuditRow[];
						spans: TraceSpan[];
					}>;
				}
			).tracedRequest;
			if (traced && correlationId) {
				try {
					return await traced({
						organizationId: organizationId ?? null,
						correlationId,
					});
				} catch {
					// Fall through to the legacy path on any unexpected
					// shape mismatch (older API server, transport hiccup).
				}
			}
			const fallback = await orpcClient.audit.list({
				organizationId: organizationId ?? null,
				cursor: undefined,
				limit: 200,
				filter: { correlationId: correlationId ?? undefined },
				sort: "oldest",
			});
			return {
				items: fallback.items as unknown as TraceAuditRow[],
				spans: [] as TraceSpan[],
			};
		},
		enabled: open && Boolean(correlationId),
	});

	const rows = useMemo(
		() => (data?.items ?? []) as TraceAuditRow[],
		[data?.items],
	);
	const spans = useMemo(
		() => (data?.spans ?? []) as TraceSpan[],
		[data?.spans],
	);

	const handleExport = useCallback(() => {
		const svg = buildTraceSvg(rows);
		try {
			const blob = new Blob([svg], { type: "image/svg+xml" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `audit-trace-${correlationId ?? "unknown"}.svg`;
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 100);
			toast.success("Trace exported");
		} catch {
			toast.error("Export failed");
		}
	}, [rows, correlationId]);

	const titleId = "audit-trace-diagram-title";

	if (presentation === "dialog") {
		return (
			<TooltipProvider>
				<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
					<DialogContent
						className="max-w-6xl gap-0 p-0"
						data-testid="audit-trace-diagram"
					>
						<DialogHeader className="flex flex-col gap-1 border-b p-6 pb-4">
							<DialogTitle id={titleId} className="sr-only">
								{t("settings.auditLog.traceDiagram.title")}
							</DialogTitle>
							<HeaderInner
								titleId={titleId}
								correlationId={correlationId}
								rowsAvailable={rows.length > 0}
								onShowInTable={onShowInTable}
								onExport={handleExport}
								t={t}
							/>
						</DialogHeader>
						<DiagramSurface
							rows={rows}
							spans={spans}
							layout={layout}
							isLoading={isLoading}
							isError={isError}
							t={t}
							surfaceRef={surfaceRef}
						/>
					</DialogContent>
				</Dialog>
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider>
			<Sheet
				open={open}
				onOpenChange={(o) => !o && onClose()}
				modal={false}
			>
				<SheetContent
					side="left"
					// `showOverlay={false}`: the trace panel is *always*
					// opened while the row-detail drawer is already open
					// on the right. Without this, two stacked Sheet
					// overlays dim/blur the right drawer until it's
					// unreadable. Dropping the overlay keeps both panels
					// visible side-by-side; the right drawer's own
					// overlay still handles outside-click dismiss for
					// the pair.
					showOverlay={false}
					// `onInteractOutside`: prevent the trace panel from
					// closing when the user clicks on the right drawer.
					// Without this, Radix's pointer-down-outside handler
					// fires for anything outside this Sheet's content,
					// including the right drawer.
					onInteractOutside={(e) => e.preventDefault()}
					className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0 shadow-2xl sm:max-w-xl"
					data-testid="audit-trace-diagram"
					data-presentation="sheet-left"
				>
					<SheetHeader className="flex flex-col gap-1 border-b p-6 pb-4">
						<SheetTitle id={titleId} className="sr-only">
							{t("settings.auditLog.traceDiagram.title")}
						</SheetTitle>
						<SheetDescription className="sr-only">
							{t("settings.auditLog.traceDiagram.description")}
						</SheetDescription>
						<HeaderInner
							titleId={titleId}
							correlationId={correlationId}
							rowsAvailable={rows.length > 0}
							onShowInTable={onShowInTable}
							onExport={handleExport}
							t={t}
						/>
					</SheetHeader>
					<DiagramSurface
						rows={rows}
						spans={spans}
						layout={layout}
						isLoading={isLoading}
						isError={isError}
						t={t}
						surfaceRef={surfaceRef}
					/>
				</SheetContent>
			</Sheet>
		</TooltipProvider>
	);
}
