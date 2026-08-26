"use client";

/**
 * AuditLogTable
 *
 * Paginated table of audit-log rows. Uses page-based pagination (25/50/
 * 100 rows per page, persisted in localStorage) with a Showing N of M
 * counter so operators understand the data volume.
 *
 * Visual upgrades (UI/UX pass 3 — punch list items 5, 6, 7, 8, 17, 20):
 *   - "Timestamp (UTC)" header (was "your time zone"); timestamps render
 *     in UTC for consistency with logs/metrics.
 *   - Column headers carry tooltips explaining what each column shows.
 *   - Outcome column uses icons only with hover tooltips.
 *   - Latency column shows `12ms`/`1.2s` when populated; hidden entirely
 *     when no row in the page has a duration.
 *   - `table-fixed` layout with explicit per-column widths so 1280px
 *     viewports never overflow.
 *   - Pagination footer: Showing N of M total + size selector + prev/next.
 *
 * Keyboard: row receives focus, `Enter`/`Space` opens drawer, `j`/`k`
 * move focus to the next/previous row when the table itself has focus.
 *
 * Spec: docs/audit-log/README.md §8.2,
 * §8.5 (accessibility), §8.6 (timezone).
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertOctagon,
	AlertTriangle,
	BookmarkPlus,
	Building2,
	CheckCircle2,
	ChevronRightIcon,
	ClipboardIcon,
	FolderIcon,
	FolderPlus,
	Info,
	Key,
	LogIn,
	Network,
	UserPlus,
	XCircle,
	Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	describeAction,
	resolveActionLabel,
	resourceIcon,
} from "./action-catalog";
import { describeActionKey } from "./audit-actions-catalog";
import { SeverityBadge } from "./SeverityBadge";
import {
	type AuditLogFiltersState,
	type AuditSortOrder,
	type AuditViewerMode,
	type AuditViewerUser,
	filtersStateToApi,
	isFiltersEmpty,
} from "./types";

/**
 * Optional data-source override. When omitted the table fetches via the
 * standard `orpc.audit.list` procedure (the in-product viewer's path).
 * The admin "Audit Log Explorer" passes a custom implementation that
 * routes through the staff proxy procedure so the same render path
 * works for cross-tenant reads via API key.
 */
export interface AuditLogTableDataSource {
	/** Stable React-Query key suffix that uniquely identifies the source. */
	cacheKey: readonly unknown[];
	list: (args: {
		filter: ReturnType<typeof filtersStateToApi>;
		cursor: string | null;
		limit: number;
		sort: AuditSortOrder;
	}) => Promise<{
		items: Awaited<ReturnType<typeof orpcClient.audit.list>>["items"];
		nextCursor: string | null;
		totalCount?: number | null;
	}>;
}

interface AuditLogTableProps {
	mode: AuditViewerMode;
	organizationId: string | null;
	filters: AuditLogFiltersState;
	viewerTimezone: string;
	onRowSelect: (rowId: string) => void;
	onCorrelationClick?: (correlationId: string) => void;
	refetchInterval?: number | false;
	sort?: AuditSortOrder;
	currentUser?: AuditViewerUser;
	/** Optional — see {@link AuditLogTableDataSource}. */
	dataSource?: AuditLogTableDataSource;
}

/**
 * Format a timestamp in UTC. The header reads "Timestamp (UTC)" and the
 * column shows the wall-clock UTC time so it always matches the
 * downstream log / metric timestamps. The relative line below it uses
 * the local clock — readers understand "5m ago" without a timezone.
 */
function formatTimestampUtc(date: Date): string {
	try {
		return new Intl.DateTimeFormat(undefined, {
			timeZone: "UTC",
			year: "numeric",
			month: "short",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		}).format(date);
	} catch {
		return date.toISOString();
	}
}

/**
 * Truncate the correlation ID to an obviously-truncated prefix. We keep
 * the first 8 chars so the most-information-dense suffix of `req_xxxx`
 * remains readable, and append a single-char ellipsis (U+2026) so the
 * row visually telegraphs that more characters exist.
 */
function shortenCorrelation(full: string): string {
	if (full.length <= 9) {
		return full;
	}
	return `${full.slice(0, 8)}…`;
}

/**
 * Format the procedure-latency value. Sub-1s → `12ms`; otherwise
 * `1.2s`. Negative or non-finite values render as the unknown sentinel.
 */
export function formatLatency(ms: number | null | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
		return "—";
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * A single legend row for an icon-led tooltip. Icons are the primary
 * affordance (per item 2 of the v2 punch list); the label sits to the
 * right as supporting text. Kept dim and 11px so multi-row tooltips stay
 * compact at the top of the table.
 */
function TooltipLegendRow({
	icon: Icon,
	label,
	tone,
}: {
	icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
	label: string;
	tone?: "default" | "success" | "failure" | "warning" | "destructive";
}) {
	const toneClass =
		tone === "success"
			? "text-secondary"
			: tone === "failure" || tone === "destructive"
				? "text-destructive"
				: tone === "warning"
					? "text-highlight"
					: "text-muted-foreground";
	return (
		<div className="flex items-center gap-2">
			<Icon aria-hidden className={cn("size-3.5 shrink-0", toneClass)} />
			<span className="text-[11px] text-foreground">{label}</span>
		</div>
	);
}

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const PAGE_SIZE_STORAGE_KEY = "audit-log:page-size";

function readPersistedPageSize(): number {
	if (typeof window === "undefined") {
		return 50;
	}
	try {
		const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
		if (!raw) {
			return 50;
		}
		const parsed = Number.parseInt(raw, 10);
		return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)
			? parsed
			: 50;
	} catch {
		return 50;
	}
}

function persistPageSize(size: number): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
	} catch {
		// Ignore storage failures (private mode, quota, etc.).
	}
}

export function AuditLogTable({
	mode,
	organizationId,
	filters,
	viewerTimezone,
	onRowSelect,
	onCorrelationClick,
	refetchInterval,
	sort = "newest",
	currentUser,
	dataSource,
}: AuditLogTableProps) {
	const t = useTranslations();
	const queryFilter = filtersStateToApi(filters);
	// The shared <TableBody> wrapper doesn't forward refs, so the j/k focus
	// helper queries the closest <tbody> off this container <div>.
	const containerRef = useRef<HTMLDivElement>(null);
	const [copyAnnouncement, setCopyAnnouncement] = useState<string>("");
	const [pageSize, setPageSize] = useState<number>(() =>
		readPersistedPageSize(),
	);
	// Page-based pagination — each "page" maps to a cursor stack so we can
	// walk forward AND back deterministically without keeping the full
	// result set in memory.
	const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([
		undefined,
	]);
	const pageIndex = cursorStack.length - 1;

	// Reset to page 1 when the filter, sort, or page size changes.
	useEffect(() => {
		setCursorStack([undefined]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [JSON.stringify(queryFilter), sort, pageSize]);

	// Choose the cache-key prefix: in-product viewer uses `["audit-log"]`
	// (so the metadata drawer's React-Query walk + the export-history
	// invalidations keep working); the explorer override passes its own
	// stable prefix so cross-tenant reads don't collide with whatever org
	// the staff member is currently viewing.
	const cacheKeyPrefix = dataSource
		? dataSource.cacheKey
		: (["audit-log", organizationId] as const);

	const { data, isLoading, isError, refetch, isFetching } = useQuery({
		queryKey: [
			...cacheKeyPrefix,
			mode,
			queryFilter,
			sort,
			pageSize,
			pageIndex,
			cursorStack[pageIndex],
		] as const,
		queryFn: () =>
			dataSource
				? dataSource.list({
						filter: queryFilter,
						cursor: cursorStack[pageIndex] ?? null,
						limit: pageSize,
						sort,
					})
				: orpcClient.audit.list({
						organizationId: organizationId ?? null,
						cursor: cursorStack[pageIndex],
						limit: pageSize,
						filter: queryFilter,
						sort,
					}),
		refetchInterval: refetchInterval ?? false,
	});

	const items = data?.items ?? [];
	const totalCount = data?.totalCount;
	const nextCursor = data?.nextCursor ?? null;
	const hasPrev = pageIndex > 0;
	const hasNext = nextCursor !== null;

	// Whether ANY row in the current page has a duration — drives the
	// latency column's visibility (item 20: "hidden if no row has duration").
	const hasLatencyColumn = useMemo(
		() => items.some((row) => typeof row.durationMs === "number"),
		[items],
	);

	const moveFocus = useCallback((delta: 1 | -1) => {
		const container = containerRef.current;
		const body = container?.querySelector("tbody");
		if (!body) {
			return;
		}
		const rows = Array.from(
			body.querySelectorAll<HTMLTableRowElement>("tr[tabindex='0']"),
		);
		if (rows.length === 0) {
			return;
		}
		const active = document.activeElement;
		const currentIdx = rows.findIndex((r) => r === active);
		const nextIdx =
			currentIdx === -1
				? delta > 0
					? 0
					: rows.length - 1
				: Math.max(0, Math.min(rows.length - 1, currentIdx + delta));
		rows[nextIdx]?.focus();
	}, []);

	useEffect(() => {
		function handle(event: KeyboardEvent) {
			// Only react when focus is inside the table body. j/k outside
			// (e.g. an input) must remain typeable characters.
			const container = containerRef.current;
			const body = container?.querySelector("tbody");
			if (!body || !body.contains(document.activeElement)) {
				return;
			}
			if (event.key === "j") {
				event.preventDefault();
				moveFocus(1);
			} else if (event.key === "k") {
				event.preventDefault();
				moveFocus(-1);
			}
		}
		window.addEventListener("keydown", handle);
		return () => window.removeEventListener("keydown", handle);
	}, [moveFocus]);

	const copyText = useCallback(async (full: string, label: string) => {
		const announce = `Copied ${label}`;
		try {
			const clipboard = (
				typeof navigator !== "undefined" ? navigator.clipboard : null
			) as { writeText?: (s: string) => Promise<void> } | null;
			if (clipboard && typeof clipboard.writeText === "function") {
				await clipboard.writeText(full);
			}
			setCopyAnnouncement(announce);
			toast.success(announce);
			window.setTimeout(() => setCopyAnnouncement(""), 1500);
		} catch {
			setCopyAnnouncement(announce);
			window.setTimeout(() => setCopyAnnouncement(""), 1500);
		}
	}, []);

	const copyCorrelation = useCallback(
		async (full: string) => {
			await copyText(
				full,
				t("settings.auditLog.aria.copiedCorrelation", {
					id: shortenCorrelation(full),
				} as never),
			);
		},
		[copyText, t],
	);

	const changePageSize = useCallback((size: number) => {
		setPageSize(size);
		persistPageSize(size);
		setCursorStack([undefined]);
	}, []);

	const goNext = useCallback(() => {
		if (!nextCursor) {
			return;
		}
		setCursorStack((prev) => [...prev, nextCursor]);
	}, [nextCursor]);

	const goPrev = useCallback(() => {
		setCursorStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
	}, []);

	if (isLoading) {
		return (
			<div
				aria-busy="true"
				aria-live="polite"
				aria-label={t("settings.auditLog.loading")}
				className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-4"
			>
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
			</div>
		);
	}

	if (isError) {
		return (
			<div
				role="alert"
				className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
			>
				<div className="font-semibold text-destructive">
					{t("settings.auditLog.error.title")}
				</div>
				<div className="text-muted-foreground">
					{t("settings.auditLog.error.defaultMessage")}
				</div>
				<Button variant="outline" size="sm" onClick={() => refetch()}>
					{t("settings.auditLog.error.retry")}
				</Button>
			</div>
		);
	}

	if (items.length === 0) {
		const noFilters = isFiltersEmpty(filters, mode, currentUser?.id);
		const titleKey = noFilters
			? "settings.auditLog.empty.virginTitle"
			: "settings.auditLog.empty.title";
		const descriptionKey = noFilters
			? "settings.auditLog.empty.virginDescription"
			: "settings.auditLog.empty.description";
		return (
			<aside
				aria-live="polite"
				aria-label={t(titleKey)}
				className="flex flex-col items-start gap-3 rounded-lg border border-border/60 bg-muted/40 p-8 text-sm"
			>
				<span className="app-editorial-label">
					{t("settings.auditLog.label")}
				</span>
				<div className="font-serif text-2xl text-foreground">
					{t(titleKey)}
				</div>
				<div className="max-w-xl text-muted-foreground">
					{t(descriptionKey)}
				</div>
			</aside>
		);
	}

	const isOrganization = mode === "organization";

	return (
		<TooltipProvider>
			<div
				ref={containerRef}
				className="overflow-hidden rounded-lg border border-border/60 bg-card"
				data-testid="audit-log-table"
			>
				<div className="overflow-x-auto">
					<Table
						aria-label={t("settings.auditLog.title")}
						aria-rowcount={items.length}
						className="table-fixed"
					>
						<colgroup>
							{/* Explicit widths. The table scrolls horizontally inside
								its container when needed, so prioritize legibility
								(full UTC timestamp, full IPv4 / IPv6 in one line)
								over fitting every column on a 1280px viewport.
								Hidden columns (project on personal, latency when
								empty) are omitted entirely. */}
							<col className="w-[210px]" />
							<col className="w-[190px]" />
							<col className="w-[110px]" />
							<col className="w-[200px]" />
							<col className="w-[110px]" />
							<col className="w-[160px]" />
							{isOrganization ? (
								<col className="w-[140px]" />
							) : null}
							<col className="w-[110px]" />
							<col className="w-[160px]" />
							{hasLatencyColumn ? (
								<col className="w-[80px]" />
							) : null}
							<col className="w-[44px]" />
						</colgroup>
						<TableHeader className="sticky top-0 z-10 bg-card">
							<TableRow>
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.timestampWithZone",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent>
											{t(
												"settings.auditLog.tooltips.columnTimestamp",
											)}
										</TooltipContent>
									</Tooltip>
								</TableHead>
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.actor",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent>
											{t(
												"settings.auditLog.tooltips.columnActor",
											)}
										</TooltipContent>
									</Tooltip>
								</TableHead>
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.correlation",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent>
											{t(
												"settings.auditLog.tooltips.columnCorrelation",
											)}
										</TooltipContent>
									</Tooltip>
								</TableHead>
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.action",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent
											surface="popover"
											className="flex flex-col gap-1.5 max-w-xs"
											data-testid="audit-tooltip-column-action"
										>
											<p className="text-[11px] text-muted-foreground">
												{t(
													"settings.auditLog.tooltips.columnAction",
												)}
											</p>
											<div className="flex flex-col gap-1 border-t border-border/40 pt-1.5">
												<TooltipLegendRow
													icon={LogIn}
													label={t(
														"settings.auditLog.actions.auth.login.success",
													)}
												/>
												<TooltipLegendRow
													icon={UserPlus}
													label={t(
														"settings.auditLog.actions.org.member.invited",
													)}
												/>
												<TooltipLegendRow
													icon={BookmarkPlus}
													label={t(
														"settings.auditLog.actions.story.created",
													)}
												/>
												<TooltipLegendRow
													icon={Zap}
													label={t(
														"settings.auditLog.actions.audit.api_request",
													)}
												/>
											</div>
										</TooltipContent>
									</Tooltip>
								</TableHead>
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.severity",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent
											surface="popover"
											className="flex flex-col gap-1.5 max-w-xs"
											data-testid="audit-tooltip-column-severity"
										>
											<p className="text-[11px] text-muted-foreground">
												{t(
													"settings.auditLog.tooltips.columnSeverity",
												)}
											</p>
											<div className="flex flex-col gap-1 border-t border-border/40 pt-1.5">
												<TooltipLegendRow
													icon={Info}
													label={t(
														"settings.auditLog.severities.info",
													)}
												/>
												<TooltipLegendRow
													icon={AlertTriangle}
													label={t(
														"settings.auditLog.severities.warning",
													)}
													tone="warning"
												/>
												<TooltipLegendRow
													icon={AlertOctagon}
													label={t(
														"settings.auditLog.severities.error",
													)}
													tone="destructive"
												/>
												<TooltipLegendRow
													icon={AlertOctagon}
													label={t(
														"settings.auditLog.severities.critical",
													)}
													tone="destructive"
												/>
											</div>
										</TooltipContent>
									</Tooltip>
								</TableHead>
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.resource",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent
											surface="popover"
											className="flex flex-col gap-1.5 max-w-xs"
											data-testid="audit-tooltip-column-resource"
										>
											<p className="text-[11px] text-muted-foreground">
												{t(
													"settings.auditLog.tooltips.columnResource",
												)}
											</p>
											<div className="flex flex-col gap-1 border-t border-border/40 pt-1.5">
												<TooltipLegendRow
													icon={UserPlus}
													label={t(
														"settings.auditLog.tooltips.resourceTypeUser",
													)}
												/>
												<TooltipLegendRow
													icon={FolderPlus}
													label={t(
														"settings.auditLog.tooltips.resourceTypeProject",
													)}
												/>
												<TooltipLegendRow
													icon={BookmarkPlus}
													label={t(
														"settings.auditLog.tooltips.resourceTypeStory",
													)}
												/>
												<TooltipLegendRow
													icon={Building2}
													label={t(
														"settings.auditLog.tooltips.resourceTypeOrganization",
													)}
												/>
												<TooltipLegendRow
													icon={Key}
													label={t(
														"settings.auditLog.tooltips.resourceTypeApiKey",
													)}
												/>
											</div>
										</TooltipContent>
									</Tooltip>
								</TableHead>
								{isOrganization ? (
									<TableHead>
										<Tooltip>
											<TooltipTrigger asChild>
												<span>
													{t(
														"settings.auditLog.columns.project",
													)}
												</span>
											</TooltipTrigger>
											<TooltipContent>
												{t(
													"settings.auditLog.tooltips.columnProject",
												)}
											</TooltipContent>
										</Tooltip>
									</TableHead>
								) : null}
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.outcome",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent
											surface="popover"
											className="flex flex-col gap-1.5 max-w-xs"
											data-testid="audit-tooltip-column-outcome"
										>
											<p className="text-[11px] text-muted-foreground">
												{t(
													"settings.auditLog.tooltips.columnOutcome",
												)}
											</p>
											<div className="flex flex-col gap-1 border-t border-border/40 pt-1.5">
												<TooltipLegendRow
													icon={CheckCircle2}
													label={t(
														"settings.auditLog.outcomes.success",
													)}
													tone="success"
												/>
												<TooltipLegendRow
													icon={XCircle}
													label={t(
														"settings.auditLog.outcomes.failure",
													)}
													tone="failure"
												/>
											</div>
										</TooltipContent>
									</Tooltip>
								</TableHead>
								<TableHead>
									<Tooltip>
										<TooltipTrigger asChild>
											<span>
												{t(
													"settings.auditLog.columns.ip",
												)}
											</span>
										</TooltipTrigger>
										<TooltipContent
											surface="popover"
											className="flex flex-col gap-1.5 max-w-xs"
											data-testid="audit-tooltip-column-ip"
										>
											<p className="text-[11px] text-muted-foreground">
												{t(
													"settings.auditLog.tooltips.columnIp",
												)}
											</p>
											<div className="flex flex-col gap-1 border-t border-border/40 pt-1.5">
												<TooltipLegendRow
													icon={Network}
													label={t(
														"settings.auditLog.tooltips.columnIpLegend",
													)}
												/>
											</div>
										</TooltipContent>
									</Tooltip>
								</TableHead>
								{hasLatencyColumn ? (
									<TableHead>
										<Tooltip>
											<TooltipTrigger asChild>
												<span>
													{t(
														"settings.auditLog.columns.latency",
													)}
												</span>
											</TooltipTrigger>
											<TooltipContent>
												{t(
													"settings.auditLog.tooltips.columnLatency",
												)}
											</TooltipContent>
										</Tooltip>
									</TableHead>
								) : null}
								<TableHead className="text-right">
									<span className="sr-only">
										{t("settings.auditLog.columns.expand")}
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{items.map((row, index) => {
								const created = new Date(row.createdAt);
								const iso = created.toISOString();
								const absolute = formatTimestampUtc(created);
								let relative: string;
								try {
									relative = formatDistanceToNow(created, {
										addSuffix: true,
									});
								} catch {
									relative = absolute;
								}
								const metadataObj =
									row.metadata &&
									typeof row.metadata === "object"
										? (row.metadata as Record<
												string,
												unknown
											>)
										: null;
								const correlationId =
									metadataObj &&
									typeof metadataObj.correlationId ===
										"string"
										? (metadataObj.correlationId as string)
										: null;
								const shortCorrelation = correlationId
									? shortenCorrelation(correlationId)
									: null;
								const descriptor = describeAction(row.action);
								const ActionIcon = descriptor.icon;
								const ResourceIcon = resourceIcon(
									row.resourceType,
								);
								const isFailure = row.outcome === "failure";
								const actionLabel = resolveActionLabel(
									t as (key: string) => string,
									descriptor,
								);

								// Actor display (item 16): for API key rows prefer
								// the human-readable `actorNameSnapshot` (e.g.,
								// "SRE laptop"). Fall back to the opaque prefix
								// only when the snapshot is null — this happens for
								// older rows written before the name was captured.
								const apiKeyPrefix =
									row.actorType === "api_key"
										? (
												row.metadata as
													| { keyPrefix?: string }
													| null
													| undefined
											)?.keyPrefix
										: undefined;
								const actorLabel =
									row.actorType === "api_key"
										? (row.actorNameSnapshot ??
											apiKeyPrefix ??
											t(
												"settings.auditLog.badges.apiKey",
											))
										: (row.actorEmailSnapshot ??
											t(
												"settings.auditLog.badges.system",
											));

								return (
									<TableRow
										key={row.id}
										aria-rowindex={index + 1}
										className="cursor-pointer transition-colors focus-within:bg-accent/60 hover:bg-accent/60"
										tabIndex={0}
										onClick={() => onRowSelect(row.id)}
										onKeyDown={(event) => {
											if (
												event.key === "Enter" ||
												event.key === " "
											) {
												event.preventDefault();
												onRowSelect(row.id);
											}
										}}
									>
										<TableCell className="whitespace-nowrap">
											<div className="flex flex-col gap-0.5">
												<Tooltip>
													<TooltipTrigger asChild>
														<time
															dateTime={iso}
															className="text-sm text-foreground"
														>
															{relative}
														</time>
													</TooltipTrigger>
													<TooltipContent>
														{t(
															"settings.auditLog.metadataDrawer.utcTooltip",
															{ iso },
														)}
													</TooltipContent>
												</Tooltip>
												<span className="font-mono text-[11px] text-muted-foreground">
													{absolute}
													<span
														aria-hidden="true"
														className="ml-1 text-muted-foreground/80"
													>
														UTC
													</span>
												</span>
											</div>
										</TableCell>
										<TableCell>
											<div className="flex min-w-0 flex-col">
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={(
																event,
															) => {
																event.stopPropagation();
																void copyText(
																	actorLabel,
																	"actor",
																);
															}}
															className="truncate rounded text-left text-sm text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
															aria-label={`Copy actor: ${actorLabel}`}
															data-testid="audit-actor-copy"
														>
															{actorLabel}
														</button>
													</TooltipTrigger>
													<TooltipContent surface="popover">
														Click to copy
													</TooltipContent>
												</Tooltip>
												<div className="mt-1 flex gap-1">
													{row.actorType ===
													"api_key" ? (
														<Badge
															variant="outline"
															className="text-[10px] uppercase tracking-wider text-muted-foreground"
														>
															{t(
																"settings.auditLog.badges.apiKey",
															)}
														</Badge>
													) : null}
													{!row.userId &&
													row.actorType === "user" ? (
														<Badge
															variant="outline"
															className="text-[10px] uppercase tracking-wider text-muted-foreground"
														>
															{t(
																"settings.auditLog.badges.deletedUser",
															)}
														</Badge>
													) : null}
													{row.impersonatedById ? (
														<Badge
															variant="outline"
															className="text-[10px] uppercase tracking-wider text-highlight"
														>
															{t(
																"settings.auditLog.badges.impersonation",
															)}
														</Badge>
													) : null}
												</div>
											</div>
										</TableCell>
										<TableCell>
											{shortCorrelation &&
											correlationId ? (
												<div className="group flex items-center gap-1">
													<Tooltip>
														<TooltipTrigger asChild>
															<button
																type="button"
																aria-label={t(
																	"settings.auditLog.aria.correlationCell",
																)}
																onClick={(
																	event,
																) => {
																	event.stopPropagation();
																	onCorrelationClick?.(
																		correlationId,
																	);
																}}
																className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
															>
																{
																	shortCorrelation
																}
															</button>
														</TooltipTrigger>
														<TooltipContent className="max-w-xs font-mono text-xs">
															{t(
																"settings.auditLog.tooltips.correlationPrefix",
																{
																	id: correlationId,
																} as never,
															)}
														</TooltipContent>
													</Tooltip>
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="ghost"
																size="icon"
																data-testid="audit-correlation-copy"
																aria-label={t(
																	"settings.auditLog.aria.copyCorrelationCell",
																	{
																		id: correlationId,
																	} as never,
																)}
																onClick={(
																	event,
																) => {
																	event.stopPropagation();
																	void copyCorrelation(
																		correlationId,
																	);
																}}
																className="h-6 w-6 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
															>
																<ClipboardIcon className="size-3" />
															</Button>
														</TooltipTrigger>
														<TooltipContent>
															{t(
																"settings.auditLog.tooltips.correlationCopy",
															)}
														</TooltipContent>
													</Tooltip>
												</div>
											) : (
												<span className="text-xs text-muted-foreground">
													—
												</span>
											)}
										</TableCell>
										<TableCell>
											<Tooltip>
												<TooltipTrigger asChild>
													<div className="flex min-w-0 items-center gap-2">
														<ActionIcon
															aria-hidden="true"
															className="size-4 shrink-0 text-muted-foreground"
														/>
														<div className="flex min-w-0 flex-col">
															<span className="truncate text-sm text-foreground">
																{actionLabel}
															</span>
															<code className="truncate font-mono text-[10px] text-muted-foreground">
																{row.action}
															</code>
														</div>
													</div>
												</TooltipTrigger>
												<TooltipContent
													surface="popover"
													className="max-w-sm space-y-1"
												>
													<p className="text-xs leading-relaxed text-foreground">
														{describeActionKey(
															row.action,
														)}
													</p>
													<code className="block font-mono text-[10px] text-muted-foreground">
														{row.action}
													</code>
												</TooltipContent>
											</Tooltip>
										</TableCell>
										<TableCell className="whitespace-nowrap">
											<Tooltip>
												<TooltipTrigger asChild>
													<span
														data-testid={`audit-severity-${row.severity}`}
														className="inline-flex"
													>
														<SeverityBadge
															severity={
																row.severity
															}
														/>
													</span>
												</TooltipTrigger>
												<TooltipContent>
													{t(
														`settings.auditLog.tooltips.severity${(row.severity as string).charAt(0).toUpperCase() + (row.severity as string).slice(1)}` as Parameters<
															typeof t
														>[0],
													)}
												</TooltipContent>
											</Tooltip>
										</TableCell>
										<TableCell>
											<Tooltip>
												<TooltipTrigger asChild>
													<div className="flex min-w-0 items-center gap-2">
														<ResourceIcon
															aria-hidden="true"
															className="size-4 shrink-0 text-muted-foreground"
														/>
														<div className="flex min-w-0 flex-col">
															<span className="truncate text-sm text-foreground">
																{row.resourceName ??
																	row.resourceType ??
																	"—"}
															</span>
															{row.resourceName &&
															!row.resourceId ? (
																<Badge
																	variant="outline"
																	className="mt-1 w-fit text-[10px] uppercase tracking-wider text-muted-foreground"
																>
																	{t(
																		"settings.auditLog.badges.deletedResource",
																	)}
																</Badge>
															) : null}
														</div>
													</div>
												</TooltipTrigger>
												<TooltipContent>
													{row.resourceType
														? t(
																"settings.auditLog.tooltips.resourceType",
																{
																	type: row.resourceType,
																} as never,
															)
														: t(
																"settings.auditLog.tooltips.resourceType",
																{
																	type: "—",
																} as never,
															)}
												</TooltipContent>
											</Tooltip>
										</TableCell>
										{isOrganization ? (
											<TableCell>
												{row.projectId ? (
													<div className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
														<FolderIcon
															aria-hidden="true"
															className="size-3.5 shrink-0 text-muted-foreground"
														/>
														<code className="truncate font-mono text-[11px] text-muted-foreground">
															{row.projectId}
														</code>
													</div>
												) : (
													<span className="text-xs text-muted-foreground">
														—
													</span>
												)}
											</TableCell>
										) : null}
										<TableCell className="whitespace-nowrap">
											{/* Icon + label so the column reads cleanly without
											 * relying on hover for the meaning. Tooltip still
											 * carries the longer "why this fired" copy. */}
											<Tooltip>
												<TooltipTrigger asChild>
													<span
														className={cn(
															"inline-flex items-center gap-1.5 text-[11px] font-medium",
															isFailure
																? "text-destructive"
																: "text-secondary",
														)}
														data-testid={`audit-outcome-${row.outcome}`}
													>
														{isFailure ? (
															<XCircle
																aria-hidden="true"
																className="size-3.5 shrink-0"
															/>
														) : (
															<CheckCircle2
																aria-hidden="true"
																className="size-3.5 shrink-0"
															/>
														)}
														<span>
															{isFailure
																? t(
																		"settings.auditLog.outcomes.failure",
																	)
																: t(
																		"settings.auditLog.outcomes.success",
																	)}
														</span>
													</span>
												</TooltipTrigger>
												<TooltipContent>
													{isFailure
														? t(
																"settings.auditLog.tooltips.outcomeFailure",
															)
														: t(
																"settings.auditLog.tooltips.outcomeSuccess",
															)}
												</TooltipContent>
											</Tooltip>
										</TableCell>
										<TableCell className="whitespace-nowrap">
											{row.ipAddress ? (
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={(
																event,
															) => {
																event.stopPropagation();
																void copyText(
																	row.ipAddress!,
																	"IP",
																);
															}}
															className="rounded font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
															aria-label={`Copy IP ${row.ipAddress}`}
															data-testid="audit-ip-copy"
														>
															{row.ipAddress}
														</button>
													</TooltipTrigger>
													<TooltipContent surface="popover">
														Click to copy IP
													</TooltipContent>
												</Tooltip>
											) : (
												<span className="text-xs text-muted-foreground">
													—
												</span>
											)}
										</TableCell>
										{hasLatencyColumn ? (
											<TableCell>
												<span
													className="font-mono text-xs text-muted-foreground"
													data-testid="audit-latency"
												>
													{formatLatency(
														row.durationMs,
													)}
												</span>
											</TableCell>
										) : null}
										<TableCell className="text-right">
											<Button
												variant="ghost"
												size="icon"
												aria-label={t(
													"settings.auditLog.columns.expand",
												)}
												className="h-8 w-8"
												onClick={(event) => {
													event.stopPropagation();
													onRowSelect(row.id);
												}}
											>
												<ChevronRightIcon className="size-4" />
											</Button>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
				<div
					className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 p-3 text-xs text-muted-foreground"
					data-testid="audit-pagination"
				>
					<div className="flex items-center gap-3">
						<span aria-live="polite">
							{typeof totalCount === "number"
								? t(
										"settings.auditLog.pagination.showingOfTotal",
										{
											shown: items.length,
											total: totalCount,
										} as never,
									)
								: t("settings.auditLog.resultCount.showing", {
										shown: items.length,
									} as never)}
						</span>
						<div className="flex items-center gap-1">
							<span>
								{t("settings.auditLog.pagination.label")}:
							</span>
							<Select
								value={String(pageSize)}
								onValueChange={(value) =>
									changePageSize(Number(value))
								}
							>
								<SelectTrigger
									className="h-7 w-[72px]"
									aria-label={t(
										"settings.auditLog.pagination.ariaLabel",
									)}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PAGE_SIZE_OPTIONS.map((size) => (
										<SelectItem
											key={size}
											value={String(size)}
										>
											{size}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={goPrev}
							disabled={!hasPrev || isFetching}
							aria-label={t("settings.auditLog.pagination.prev")}
						>
							{t("settings.auditLog.pagination.prev")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={goNext}
							disabled={!hasNext || isFetching}
							aria-label={t("settings.auditLog.pagination.next")}
						>
							{t("settings.auditLog.pagination.next")}
						</Button>
					</div>
				</div>
				<div
					role="status"
					aria-live="polite"
					aria-atomic="true"
					className="sr-only"
				>
					{copyAnnouncement}
				</div>
			</div>
		</TooltipProvider>
	);
}
