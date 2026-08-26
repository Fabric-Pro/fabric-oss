"use client";

/**
 * Incident-history timeline for the admin monitoring dashboard.
 * Renders a unified list of `ErrorRateIncident`, `IntegrationIncident`,
 * AND `ComponentIncident` rows (active + hidden, every severity, every
 * status) so SREs can scan the history over a selectable window.
 *
 * Each entry is collapsible: clicking the chevron expands the card to
 * reveal the full event timeline for that incident — ack / close /
 * comment events with actor, timestamp, and message. This is the
 * "history with comments" surface — hidden alerts no longer disappear
 * into a JSON blob, they live here with their post-mortem notes
 * permanently visible. Incidents are no longer surfaced on the
 * notification bell; this timeline is the canonical history.
 *
 * Filters (ALL server-side — they drive the paginated query, so the DB is
 * never over-fetched the way the old "fetch 200 × 3 streams then filter in
 * the browser" path was):
 *  - Window: 30 / 90 / 365 days (the sliding `sinceDays` window).
 *  - Source: `detectionMethod` for the integration stream (statuspage /
 *    synthetic / breaker / alertmanager) plus "error rate" for the
 *    application stream and "component" for internal subsystem outages.
 *  - Status: show only hidden (history) or only still-active entries.
 *  - Per page: 25 / 50 / 100 rows.
 *
 * Changing any of Window / Status / Source / Per-page resets to page 1.
 *
 * Data sources:
 *  - `incidents.listHistory({ sinceDays, status, source, page, pageSize })`
 *    — a SINGLE admin-only call returning ONE newest-first page of merged,
 *    `kind`-tagged rows across all three streams plus the summed `total`.
 *  - `incidents.errorRate.listEvents({ id })` /
 *    `integrationHealth.listEvents({ id })` /
 *    `incidents.component.listEvents({ id })` — lazily fetched only when
 *    the user expands a row.
 */

import { Pagination } from "@saas/shared/components/Pagination";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Card, CardContent } from "@ui/components/card";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClockIcon,
	HistoryIcon,
	MessageSquareIcon,
	PlugIcon,
	ServerIcon,
	XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelative } from "./ActiveIncidentsTable";
import { GLOSSARY } from "./glossary";
import { HelpTooltip } from "./HelpTooltip";

type SourceFilter =
	| "all"
	| "error-rate"
	| "statuspage"
	| "synthetic"
	| "breaker"
	| "alertmanager"
	| "component";

type StatusFilter = "all" | "active" | "hidden";

/** Selectable history window (days). The hard ceiling is 365 — the retention
 * window after which incidents are pruned, so anything longer would silently
 * show nothing older. */
type WindowDays = 30 | 90 | 365;

const WINDOW_OPTIONS: readonly WindowDays[] = [30, 90, 365] as const;

/** Selectable page sizes for the server-side pager. */
type PageSize = 25 | 50 | 100;

const PAGE_SIZE_OPTIONS: readonly PageSize[] = [25, 50, 100] as const;

/** One row as returned by `incidents.listHistory` — already merged across the
 * three streams, tagged by `kind`, and newest-first. Mirrors the
 * `IncidentHistoryItem` shape from the DB helper. */
type HistoryItem = {
	id: string;
	kind: "errorRate" | "integration" | "component";
	severity: "SEV1" | "SEV2" | "SEV3";
	status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	startedAt: string;
	resolvedAt: string | null;
	alertName?: string;
	service?: string;
	feature?: string;
	errorClass?: string | null;
	providerName?: string;
	summary?: string | null;
	detectionMethod?: string | null;
	componentName?: string;
};

type TimelineEntry = {
	id: string;
	kind: "errorRate" | "integration" | "component";
	severity: "SEV1" | "SEV2" | "SEV3";
	status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	label: string;
	summary: string;
	source: SourceFilter;
	startedAt: Date;
	resolvedAt: Date | null;
};

const SEVERITY_TONE: Record<
	TimelineEntry["severity"],
	"error" | "warning" | "secondary"
> = {
	SEV1: "error",
	SEV2: "warning",
	SEV3: "secondary",
};

const STATUS_TONE: Record<
	TimelineEntry["status"],
	"error" | "warning" | "success"
> = {
	FIRING: "error",
	ACKNOWLEDGED: "warning",
	RESOLVED: "success",
};

/** Display label for the timeline's status badges. "Hidden" matches the
 * button on the open-incidents card ("Hide" instead of "Resolve") so the
 * lifecycle vocabulary stays consistent end-to-end. The DB enum value
 * remains RESOLVED for backwards-compatibility. */
const STATUS_LABEL: Record<TimelineEntry["status"], string> = {
	FIRING: "FIRING",
	ACKNOWLEDGED: "ACK'D",
	RESOLVED: "HIDDEN",
};

const SOURCE_LABEL: Record<Exclude<SourceFilter, "all">, string> = {
	"error-rate": "Error rate",
	statuspage: "Statuspage",
	synthetic: "Synthetic probe",
	breaker: "Breaker",
	alertmanager: "Alertmanager",
	component: "Component",
};

const FILTER_TOOLTIPS: Record<SourceFilter, string> = {
	all: GLOSSARY.timelineAll,
	"error-rate": GLOSSARY.timelineErrorRate,
	statuspage: GLOSSARY.timelineStatuspage,
	synthetic: GLOSSARY.timelineSynthetic,
	breaker: GLOSSARY.timelineBreaker,
	alertmanager: GLOSSARY.timelineAlertmanager,
	component: GLOSSARY.timelineComponent,
};

const STATUS_FILTER_TOOLTIPS: Record<StatusFilter, string> = {
	all: "Both active and hidden incidents in the selected window.",
	active: "Only incidents still FIRING or ACKNOWLEDGED — these duplicate the Open incidents section above but stay listed here so the historical sweep doesn't skip the present moment.",
	hidden: "Only incidents that have been hidden (manually or via auto-resolve). Expand any row to see the hide note, comments, and the full ack/hide timeline.",
};

function mapDetectionMethod(method: string | null | undefined): SourceFilter {
	switch (method) {
		case "STATUSPAGE_POLL":
			return "statuspage";
		case "SYNTHETIC_PROBE":
			return "synthetic";
		case "BREAKER_OPEN":
			return "breaker";
		case "ALERT_MANAGER":
			return "alertmanager";
		default:
			return "statuspage";
	}
}

/** Normalize one `kind`-tagged history item from the API into a `TimelineEntry`
 * the card renderer understands. The server has already filtered + sorted; this
 * only derives the display label/summary/source per stream. */
function toTimelineEntry(item: HistoryItem): TimelineEntry {
	const startedAt = new Date(item.startedAt);
	const resolvedAt = item.resolvedAt ? new Date(item.resolvedAt) : null;
	if (item.kind === "errorRate") {
		return {
			id: item.id,
			kind: "errorRate",
			severity: item.severity,
			status: item.status,
			label: item.alertName ?? "Error-rate incident",
			summary: `${item.service ?? "unknown"} / ${item.feature ?? "unknown"}${
				item.errorClass ? ` · ${item.errorClass}` : ""
			}`,
			source: "error-rate",
			startedAt,
			resolvedAt,
		};
	}
	if (item.kind === "component") {
		return {
			id: item.id,
			kind: "component",
			severity: item.severity,
			status: item.status,
			label: item.componentName ?? "Subsystem incident",
			summary: item.summary ?? "Subsystem incident",
			source: "component",
			startedAt,
			resolvedAt,
		};
	}
	return {
		id: item.id,
		kind: "integration",
		severity: item.severity,
		status: item.status,
		label: item.providerName ?? "Provider incident",
		summary: item.summary ?? "Provider incident",
		source: mapDetectionMethod(item.detectionMethod),
		startedAt,
		resolvedAt,
	};
}

export function IncidentTimelineList() {
	const [filter, setFilter] = useState<SourceFilter>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [windowDays, setWindowDays] = useState<WindowDays>(30);
	const [pageSize, setPageSize] = useState<PageSize>(25);
	const [page, setPage] = useState(1);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	// Window / Status / Source / Per-page all change the SERVER query, so any
	// of them must snap the pager back to page 1 — otherwise a narrower result
	// set could leave us stranded on a now-empty page. `setPage` is a stable
	// dispatcher, so the deps array is exactly the four facets.
	useEffect(() => {
		setPage(1);
	}, [windowDays, statusFilter, filter, pageSize]);

	// Single source: the paginated full-history endpoint returns ONE
	// newest-first page of merged rows (every status + severity) plus the
	// summed total. The query key includes every server-driven input so the
	// query refetches whenever any of them changes.
	const historyQuery = useQuery({
		queryKey: [
			"monitoring",
			"timeline",
			"history",
			{
				windowDays,
				status: statusFilter,
				source: filter,
				page,
				pageSize,
			},
		],
		queryFn: () =>
			orpcClient.incidents.listHistory({
				sinceDays: windowDays,
				status: statusFilter,
				source: filter,
				page,
				pageSize,
			}),
		placeholderData: (prev) => prev,
	});

	const entries = useMemo<TimelineEntry[]>(() => {
		const items = (historyQuery.data?.items ?? []) as HistoryItem[];
		// Server returns newest-first already; keep order as-is.
		return items.map(toTimelineEntry);
	}, [historyQuery.data]);

	const total = historyQuery.data?.total ?? 0;

	const isLoading = historyQuery.isLoading;
	const hasError = historyQuery.isError;

	return (
		<section
			aria-labelledby="incident-timeline-heading"
			className="space-y-4"
		>
			<header className="space-y-1">
				<p className="app-editorial-label">Timeline & history</p>
				<div className="flex flex-wrap items-center gap-2">
					<h2
						id="incident-timeline-heading"
						className="font-serif text-2xl font-normal tracking-tight text-foreground/95"
					>
						Incident history
					</h2>
					<HelpTooltip label="the incident timeline">
						Every incident (active and hidden, every severity) in
						the selected window across the error-rate, integration,
						and component streams. Expand any row to see the full
						ack/hide lifecycle and any comments admins left behind.
					</HelpTooltip>
				</div>
				<p className="text-sm text-muted-foreground">
					Last {windowDays} days — active and hidden alerts across
					every detection stream. Filter by window, source, or status;
					expand any entry to read comments and the lifecycle trail.
					{total > 0 ? (
						<>
							{" "}
							<span className="text-foreground/70">
								{total} matching in this window.
							</span>
						</>
					) : null}
				</p>
			</header>

			<TooltipProvider delayDuration={150}>
				<div className="flex flex-col gap-3">
					{/* Window filter — own row, first: it changes the data
					 * fetched (refetches the paginated history query) and snaps
					 * the pager back to page 1. */}
					<div
						className="flex flex-wrap items-center gap-2"
						role="group"
						aria-label="Select incident history window"
					>
						<span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
							<span
								aria-hidden="true"
								className="inline-block h-3 w-0.5 rounded-sm bg-primary/60"
							/>
							Window
						</span>
						{WINDOW_OPTIONS.map((days) => (
							<FilterChip
								key={days}
								active={windowDays === days}
								onClick={() => setWindowDays(days)}
								label={`${days} days`}
								tooltip={`Show incidents fired in the last ${days} days. Incidents older than 365 days are pruned, so 365 is the maximum history.`}
							/>
						))}
					</div>
					{/* Status filter — own row so admins can isolate the
					 * "history" subset (hidden only) in one click. Server-side. */}
					<div
						className="flex flex-wrap items-center gap-2"
						role="group"
						aria-label="Filter incident timeline by status"
					>
						<span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
							<span
								aria-hidden="true"
								className="inline-block h-3 w-0.5 rounded-sm bg-primary/60"
							/>
							Status
						</span>
						<FilterChip
							active={statusFilter === "all"}
							onClick={() => setStatusFilter("all")}
							label="All"
							tooltip={STATUS_FILTER_TOOLTIPS.all}
						/>
						<FilterChip
							active={statusFilter === "active"}
							onClick={() => setStatusFilter("active")}
							label="Still active"
							tooltip={STATUS_FILTER_TOOLTIPS.active}
						/>
						<FilterChip
							active={statusFilter === "hidden"}
							onClick={() => setStatusFilter("hidden")}
							label="History (hidden)"
							tooltip={STATUS_FILTER_TOOLTIPS.hidden}
							icon={<HistoryIcon className="size-3" />}
						/>
					</div>
					{/* Source filter — kept separate from Status so the two
					 * dimensions stack visually rather than interleave.
					 * Server-side. */}
					<div
						className="flex flex-wrap items-center gap-2"
						role="group"
						aria-label="Filter incident timeline by source"
					>
						<span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
							<span
								aria-hidden="true"
								className="inline-block h-3 w-0.5 rounded-sm bg-primary/60"
							/>
							Source
						</span>
						<FilterChip
							active={filter === "all"}
							onClick={() => setFilter("all")}
							label="All"
							tooltip={FILTER_TOOLTIPS.all}
						/>
						<FilterChip
							active={filter === "error-rate"}
							onClick={() => setFilter("error-rate")}
							label={SOURCE_LABEL["error-rate"]}
							tooltip={FILTER_TOOLTIPS["error-rate"]}
						/>
						<FilterChip
							active={filter === "statuspage"}
							onClick={() => setFilter("statuspage")}
							label={SOURCE_LABEL.statuspage}
							tooltip={FILTER_TOOLTIPS.statuspage}
						/>
						<FilterChip
							active={filter === "synthetic"}
							onClick={() => setFilter("synthetic")}
							label={SOURCE_LABEL.synthetic}
							tooltip={FILTER_TOOLTIPS.synthetic}
						/>
						<FilterChip
							active={filter === "breaker"}
							onClick={() => setFilter("breaker")}
							label={SOURCE_LABEL.breaker}
							tooltip={FILTER_TOOLTIPS.breaker}
						/>
						<FilterChip
							active={filter === "alertmanager"}
							onClick={() => setFilter("alertmanager")}
							label={SOURCE_LABEL.alertmanager}
							tooltip={FILTER_TOOLTIPS.alertmanager}
						/>
						<FilterChip
							active={filter === "component"}
							onClick={() => setFilter("component")}
							label={SOURCE_LABEL.component}
							tooltip={FILTER_TOOLTIPS.component}
							icon={<ServerIcon className="size-3" />}
						/>
					</div>
					{/* Per-page selector — controls the server pageSize. Own row,
					 * matching the chip-group treatment of the facets above. */}
					<div
						className="flex flex-wrap items-center gap-2"
						role="group"
						aria-label="Incidents per page"
					>
						<span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
							<span
								aria-hidden="true"
								className="inline-block h-3 w-0.5 rounded-sm bg-primary/60"
							/>
							Per page
						</span>
						{PAGE_SIZE_OPTIONS.map((size) => (
							<FilterChip
								key={size}
								active={pageSize === size}
								onClick={() => setPageSize(size)}
								label={`${size}`}
								tooltip={`Show ${size} incidents per page. Larger pages fetch more rows per request.`}
							/>
						))}
					</div>
				</div>
			</TooltipProvider>

			{isLoading ? (
				<Card className="app-surface border-border/60">
					<CardContent className="p-6 text-sm text-muted-foreground">
						Loading timeline...
					</CardContent>
				</Card>
			) : hasError ? (
				<Card className="border-destructive/40 bg-destructive/5">
					<CardContent className="p-6 text-sm text-destructive">
						Failed to load timeline.
					</CardContent>
				</Card>
			) : entries.length === 0 ? (
				<Card className="app-surface border-border/60">
					<CardContent className="p-6 text-sm text-muted-foreground">
						{statusFilter === "hidden"
							? `No hidden incidents in the last ${windowDays} days for this filter.`
							: `No incidents matching this filter in the last ${windowDays} days.`}
					</CardContent>
				</Card>
			) : (
				<>
					<ol
						className="space-y-2"
						data-testid="incident-timeline-list"
					>
						{entries.map((entry) => (
							<li key={`${entry.kind}:${entry.id}`}>
								<TimelineEntryCard
									entry={entry}
									expanded={
										expandedId ===
										`${entry.kind}:${entry.id}`
									}
									onToggle={() =>
										setExpandedId((prev) =>
											prev === `${entry.kind}:${entry.id}`
												? null
												: `${entry.kind}:${entry.id}`,
										)
									}
								/>
							</li>
						))}
					</ol>
					<Pagination
						className="pt-2"
						totalItems={total}
						itemsPerPage={pageSize}
						currentPage={page}
						onChangeCurrentPage={setPage}
					/>
				</>
			)}
		</section>
	);
}

function TimelineEntryCard({
	entry,
	expanded,
	onToggle,
}: {
	entry: TimelineEntry;
	expanded: boolean;
	onToggle: () => void;
}) {
	const dotClass =
		entry.severity === "SEV1"
			? "bg-destructive"
			: entry.severity === "SEV2"
				? "bg-highlight"
				: "bg-muted-foreground/60";
	const cardId = `${entry.kind}:${entry.id}`;
	const panelId = `incident-timeline-panel-${cardId.replace(/:/g, "-")}`;
	return (
		<Card className="app-surface border-border/60">
			<CardContent className="p-0">
				{/* Header row: the entire row is the expand toggle so admins
				 * can click anywhere on the card to drill in. The chevron is
				 * purely visual — the parent button handles keyboard. */}
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={expanded}
					aria-controls={panelId}
					className="flex w-full items-start gap-3 rounded-md p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
				>
					<span
						aria-hidden="true"
						className={`mt-2 size-2 shrink-0 rounded-full ${dotClass}`}
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0 space-y-1">
							<div className="flex flex-wrap items-center gap-2">
								<Badge status={SEVERITY_TONE[entry.severity]}>
									{entry.severity}
								</Badge>
								<Badge status={STATUS_TONE[entry.status]}>
									{STATUS_LABEL[entry.status]}
								</Badge>
								<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
									{entry.kind === "errorRate" ? (
										<AlertTriangleIcon className="size-3.5" />
									) : entry.kind === "component" ? (
										<ServerIcon className="size-3.5" />
									) : (
										<PlugIcon className="size-3.5" />
									)}
									{entry.source !== "all"
										? SOURCE_LABEL[entry.source]
										: ""}
								</span>
							</div>
							<p className="break-words text-sm font-medium text-foreground/90">
								{entry.label}
							</p>
							<p className="break-words text-xs text-muted-foreground">
								{entry.summary}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex-col sm:items-end">
							<span className="inline-flex items-center gap-1">
								<ClockIcon className="size-3" />
								<time dateTime={entry.startedAt.toISOString()}>
									{formatRelative(entry.startedAt)}
								</time>
							</span>
							{entry.resolvedAt ? (
								<span className="text-secondary">
									hidden {formatRelative(entry.resolvedAt)}
								</span>
							) : (
								<span className="text-destructive">
									still active
								</span>
							)}
						</div>
					</div>
					<span
						aria-hidden="true"
						className="mt-1.5 shrink-0 text-muted-foreground"
					>
						{expanded ? (
							<ChevronDownIcon className="size-4" />
						) : (
							<ChevronRightIcon className="size-4" />
						)}
					</span>
				</button>
				{expanded ? (
					<div
						id={panelId}
						className="border-t border-border/40 px-4 pb-4 pt-3"
					>
						<EntryEventTimeline entry={entry} />
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

type IncidentEventRow = {
	id: string;
	type: string;
	message: string | null;
	createdAt: Date;
	actor: { id: string; name: string | null; image: string | null } | null;
};

function EntryEventTimeline({ entry }: { entry: TimelineEntry }) {
	const eventsQuery = useQuery({
		queryKey: ["monitoring", "timeline", entry.kind, "events", entry.id],
		queryFn: async () => {
			if (entry.kind === "errorRate") {
				const result = await orpcClient.incidents.errorRate.listEvents({
					id: entry.id,
				});
				return result.events as unknown as IncidentEventRow[];
			}
			if (entry.kind === "component") {
				const result = await orpcClient.incidents.component.listEvents({
					id: entry.id,
				});
				return result.events as unknown as IncidentEventRow[];
			}
			const result = await orpcClient.integrationHealth.listEvents({
				id: entry.id,
			});
			return result.events as unknown as IncidentEventRow[];
		},
	});

	if (eventsQuery.isLoading) {
		return (
			<p className="text-xs text-muted-foreground" role="status">
				Loading event history...
			</p>
		);
	}
	if (eventsQuery.isError) {
		return (
			<p className="text-xs text-destructive" role="status">
				Couldn't load event history for this incident.
			</p>
		);
	}
	const events = eventsQuery.data ?? [];
	const commentCount = events.filter((e) => e.type === "COMMENT").length;
	return (
		<div className="space-y-3">
			{/* Summary line — gives admins a one-glance "is there anything
			 * worth reading here?" before scanning the full list. */}
			<p className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
				<span>Event history</span>
				<span aria-hidden="true">·</span>
				<span>{events.length} total</span>
				<span aria-hidden="true">·</span>
				<span className="inline-flex items-center gap-1">
					<MessageSquareIcon className="size-3" />
					{commentCount} comment{commentCount === 1 ? "" : "s"}
				</span>
			</p>
			{events.length === 0 ? (
				<p className="text-xs italic text-muted-foreground">
					No ack/hide events or comments recorded. Auto-detected and
					(if hidden) auto-resolved by the recovery hysteresis rule.
				</p>
			) : (
				<ol
					className="space-y-2 border-l border-border/60 pl-4"
					data-testid="incident-event-list"
				>
					{events.map((event) => (
						<li key={event.id}>
							<EventRow event={event} />
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

function EventRow({ event }: { event: IncidentEventRow }) {
	const meta = describeEventType(event.type);
	return (
		<div className="relative">
			{/* Marker dot anchored to the leading edge so the type colour
			 * tracks the vertical rail. */}
			<span
				aria-hidden="true"
				className={cn(
					"absolute -left-[1.0625rem] top-1.5 size-2.5 rounded-full ring-2 ring-card",
					meta.dotClass,
				)}
			/>
			<div className="flex flex-col gap-1 text-xs">
				<div className="flex flex-wrap items-center gap-2">
					<span className={cn("font-semibold", meta.labelClass)}>
						{meta.label}
					</span>
					<span className="text-muted-foreground">·</span>
					<span className="text-foreground/80">
						{event.actor?.name ?? "System"}
					</span>
					<span className="text-muted-foreground">·</span>
					<time
						className="text-muted-foreground"
						dateTime={new Date(event.createdAt).toISOString()}
						title={new Date(event.createdAt).toLocaleString()}
					>
						{formatRelative(new Date(event.createdAt))}
					</time>
				</div>
				{event.message ? (
					<p className="whitespace-pre-wrap rounded-md border border-border/40 bg-muted/60 px-3 py-2 text-foreground/85">
						{event.message}
					</p>
				) : null}
			</div>
		</div>
	);
}

function describeEventType(type: string): {
	label: string;
	icon: React.ReactNode;
	dotClass: string;
	labelClass: string;
} {
	switch (type) {
		case "FIRED":
			return {
				label: "Fired",
				icon: <AlertTriangleIcon className="size-3.5" />,
				dotClass: "bg-destructive",
				labelClass: "text-destructive",
			};
		case "ACKNOWLEDGED":
			return {
				label: "Acknowledged",
				icon: <CheckCircle2Icon className="size-3.5" />,
				dotClass: "bg-highlight",
				labelClass: "text-highlight-foreground sm:text-foreground",
			};
		case "RESOLVED":
			return {
				label: "Hidden",
				icon: <XCircleIcon className="size-3.5" />,
				dotClass: "bg-secondary",
				labelClass: "text-secondary",
			};
		case "COMMENT":
			return {
				label: "Comment",
				icon: <MessageSquareIcon className="size-3.5" />,
				dotClass: "bg-foreground/60",
				labelClass: "text-foreground/80",
			};
		default:
			return {
				label: type,
				icon: <ClockIcon className="size-3.5" />,
				dotClass: "bg-muted-foreground/60",
				labelClass: "text-foreground/80",
			};
	}
}

function FilterChip({
	active,
	label,
	onClick,
	tooltip,
	icon,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
	tooltip: string;
	icon?: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={onClick}
					aria-pressed={active}
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-md border px-3 text-xs uppercase tracking-[0.15em] transition-colors",
						active
							? "border-primary/60 bg-primary/10 text-foreground"
							: "border-border/60 bg-card text-muted-foreground hover:border-border",
					)}
				>
					{icon}
					{label}
				</button>
			</TooltipTrigger>
			<TooltipContent
				side="top"
				className="max-w-xs text-pretty text-xs leading-relaxed"
			>
				{tooltip}
			</TooltipContent>
		</Tooltip>
	);
}
