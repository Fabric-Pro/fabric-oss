"use client";

/**
 * UrlSourcePageView — dedicated full-page reading view for a URL Context Source.
 *
 * Companion to `UrlPagePreviewDrawer`. The drawer is a quick-look surface;
 * this view is for serious reading of 30k+ character markdown scrapes.
 *
 * Layout (per commit 2 spec):
 *  - Sticky breadcrumb header with status pill + back-arrow.
 *  - Hero block: serif page h1, URL link, editorial "URL SOURCE" label,
 *    right-aligned action cluster (Re-sync, Edit settings, More, Open raw URL).
 *  - Two-column body (grid-cols-[1fr,320px] gap-8):
 *      LEFT  — wide prose column for SINGLE_PAGE markdown, OR paginated
 *              child-page list with inline expansion for PATH_PREFIX.
 *      RIGHT — Details + Activity sidebar cards.
 *  - FAILED state replaces the main column with an error card.
 *
 * Editorial aesthetic (CLAUDE.md):
 *  - Serif page h1 (`font-serif`).
 *  - Editorial section labels (uppercase, `tracking-[0.2em]`, `text-muted-foreground`).
 *  - Warm-neutral cards (`bg-card border border-border`).
 *  - No glassmorphism, no gradient pills, no hardcoded hex.
 *  - All transitions wrapped in `motion-safe:`.
 *
 * Server vs client:
 *  - This component is `"use client"` because of the interactive bits
 *    (Re-sync mutation, paginated list, expandable rows, popover settings).
 *  - It receives the parent ProjectContext row pre-fetched by the server
 *    `page.tsx` via `getUrlSourceContext` so the first paint is the data
 *    paint (no client query waterfall for the parent shell).
 */

import { useAnalytics } from "@analytics";
import type { KnowledgeBaseSourceCategoryValue } from "@repo/api/modules/projects/procedures/contexts/knowledge-base-category.types";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { KNOWLEDGE_BASE_CATEGORY_OPTIONS } from "@saas/projects/lib/knowledge-base-categories";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	ArrowLeftIcon,
	BanIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	CopyIcon,
	DownloadIcon,
	ExternalLinkIcon,
	InfoIcon,
	LoaderIcon,
	MinusIcon,
	MoreVerticalIcon,
	PlusIcon,
	RefreshCwIcon,
	TimerIcon,
	Trash2Icon,
	XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import type {
	LinkContextRefreshMode,
	LinkContextScope,
} from "./LinkContextManagePanel";

const FIRECRAWL_TROUBLESHOOTING_URL =
	"https://docs.firecrawl.dev/troubleshooting";

type Scope = LinkContextScope;
type RefreshMode = LinkContextRefreshMode;

/**
 * Mirrors the shape returned by `getUrlSourceContext` plus the project's
 * name and (for PATH_PREFIX) `_count.urlPages`. Defined here so the
 * server page can pass plain JSON props without dragging Prisma types
 * across the server/client boundary.
 */
export type UrlSourceViewData = {
	id: string;
	projectId: string;
	projectName: string;
	sourceUrl: string;
	sourceTitle: string | null;
	urlScope: Scope | null;
	urlMaxPages: number | null;
	urlRefreshMode: RefreshMode | null;
	/**
	 * How this link is classified for the readiness checklist (Fizzy #2165).
	 * Null on every source created before the classification existed — which is
	 * exactly why Settings can now set it without a re-crawl.
	 */
	knowledgeBaseSourceCategory: KnowledgeBaseSourceCategoryValue | null;
	knowledgeBaseSourceCategoryOther: string | null;
	urlLastSyncedAt: string | null;
	urlNextRefreshAt: string | null;
	extractionStatus: string | null;
	extractionError: string | null;
	content: string;
	createdAt: string;
	/**
	 * Last modified timestamp from the parent row. While a crawl is in flight
	 * this is when the row flipped into PENDING/EXTRACTING (resync-url-source
	 * + process-context-link both write the status transition + workflow id
	 * in one update), so the UI uses it as the "Crawling since" reference for
	 * the elapsed-time indicator.
	 */
	updatedAt: string;
	scraperProvider: string | null;
	/** Total discovered URLs (PENDING placeholders + finished rows). */
	totalCount?: number;
	/** Completed scrapes — the count the user thinks of as "pages indexed". */
	indexedCount: number;
	/** Per-page rows whose scrape or embed terminated in FAILED. */
	failedCount?: number;
	/** PENDING + EXTRACTING (in-flight) per-page rows. */
	pendingCount?: number;
};

type Props = {
	context: UrlSourceViewData;
	/** Full path back to the project's context tab, e.g. `/app/proj/projects/abc?tab=context`. */
	backHref: string;
};

const REFRESH_MODES: ReadonlyArray<{ value: RefreshMode; label: string }> = [
	{ value: "ONCE", label: "Once" },
	{ value: "DAILY", label: "Daily" },
	{ value: "WEEKLY", label: "Weekly" },
	{ value: "MONTHLY", label: "Monthly" },
	{ value: "LIVE", label: "Live" },
];

function scopeLabel(scope: Scope | null): string {
	if (scope === "PATH_PREFIX") {
		return "Path-prefix";
	}
	if (scope === "SINGLE_PAGE") {
		return "Single page";
	}
	return "—";
}

function cadenceLabel(mode: RefreshMode | null): string {
	switch (mode) {
		case "DAILY":
			return "Daily";
		case "WEEKLY":
			return "Weekly";
		case "MONTHLY":
			return "Monthly";
		case "LIVE":
			return "Live";
		case "ONCE":
			return "Once";
		default:
			return "—";
	}
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function truncateMiddle(value: string, max = 80): string {
	if (value.length <= max) {
		return value;
	}
	const head = Math.ceil((max - 1) / 2);
	const tail = Math.floor((max - 1) / 2);
	return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM UTC` — matches the cadence-aware
 * "next refresh" presentation. Uses UTC parts explicitly so the rendered
 * string doesn't drift with the viewer's local timezone (the cron fires
 * in UTC). Returns the ISO string sliced to minute precision plus a
 * trailing " UTC" suffix.
 */
function formatUtcAbsolute(date: Date): string {
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const mi = String(date.getUTCMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

function StatusPill({
	status,
	indexedCount,
}: {
	status: string | null;
	/**
	 * Optional. Lets the pill upgrade a legacy CANCELLED row to "Indexed"
	 * when at least one page successfully indexed before the cancel
	 * reached the worker. New crawls write COMPLETED in that scenario
	 * (see the cancel-path in `url-source-crawl.ts`), but pre-existing
	 * rows in the DB still carry CANCELLED — this prop lets the UI
	 * render them honestly without a one-time DB backfill.
	 */
	indexedCount?: number;
}) {
	// Legacy fallback: CANCELLED + at least one indexed child page →
	// render as Indexed. The data IS usable; the user just stopped
	// early. Pure UI override — DB row stays as-is for audit purposes.
	if (status === "CANCELLED" && (indexedCount ?? 0) > 0) {
		return (
			<Badge variant="secondary" className="gap-1">
				<CheckCircleIcon className="size-3" aria-hidden="true" />
				Indexed
			</Badge>
		);
	}
	if (status === "COMPLETED" || status === "INDEXED") {
		return (
			<Badge variant="secondary" className="gap-1">
				<CheckCircleIcon className="size-3" aria-hidden="true" />
				Indexed
			</Badge>
		);
	}
	if (status === "FAILED") {
		return (
			<Badge variant="destructive" className="gap-1">
				<XCircleIcon className="size-3" aria-hidden="true" />
				Failed
			</Badge>
		);
	}
	if (status === "CANCELLED") {
		// Terminal-but-distinct from COMPLETED. Neutral outline + ban icon so
		// it reads as "user stopped this on purpose", not an error and not a
		// success. Pages already indexed before the cancel are preserved on
		// the row — the user sees their partial progress alongside this badge.
		return (
			<Badge
				variant="outline"
				className="gap-1 text-muted-foreground"
				data-testid="status-pill-cancelled"
			>
				<BanIcon className="size-3" aria-hidden="true" />
				Cancelled
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="gap-1">
			<LoaderIcon
				className="size-3 motion-safe:animate-spin"
				aria-hidden="true"
			/>
			Processing
		</Badge>
	);
}

/**
 * Re-renders every second so the displayed elapsed duration ticks live. We
 * resolve `since` lazily on every tick rather than memoising it — passing a
 * `Date` from a parent that just re-rendered would otherwise freeze the
 * display. The interval is cleared on unmount so a stale crawl tab doesn't
 * keep timers running.
 */
function ElapsedSince({ since }: { since: Date | string }) {
	const sinceMs =
		typeof since === "string" ? new Date(since).getTime() : since.getTime();
	const [nowMs, setNowMs] = useState<number>(() => Date.now());
	useEffect(() => {
		const handle = window.setInterval(() => {
			setNowMs(Date.now());
		}, 1000);
		return () => window.clearInterval(handle);
	}, []);
	const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	const label = m > 0 ? `${m}m ${s}s` : `${s}s`;
	return (
		<span aria-live="polite" data-testid="url-source-crawl-elapsed">
			{label}
		</span>
	);
}

function EditorialLabel({
	children,
	id,
}: {
	children: React.ReactNode;
	id?: string;
}) {
	return (
		<p
			id={id}
			className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
		>
			{children}
		</p>
	);
}

/** Renders one detail row (label + value) inside the sidebar's Details card. */
function DetailRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-1">
			<EditorialLabel>{label}</EditorialLabel>
			<div className="text-foreground/85 text-sm">{children}</div>
		</div>
	);
}

/* ── PATH_PREFIX child-page row + expansion ─────────────────────────────── */

type ChildPageRow = {
	id: string;
	pageUrl: string;
	pageTitle: string | null;
	lastFetchedAt: Date | string | null;
	chunkCount: number;
	extractionStatus: string | null;
	extractionError: string | null;
};

function ChildPageExpansion({
	pageId,
	projectId,
	organizationId,
}: {
	pageId: string;
	projectId: string;
	organizationId: string | null;
}) {
	const { data, isLoading, isError, error } = useQuery({
		queryKey: [
			"projects",
			"contexts",
			"getUrlPageContent",
			projectId,
			organizationId,
			pageId,
		] as const,
		queryFn: () =>
			orpcClient.projects.contexts.getUrlPageContent({
				pageId,
				projectId,
				organizationId,
			}),
	});

	if (isLoading) {
		return (
			<div className="space-y-2 px-5 py-4" aria-busy="true">
				<Skeleton className="h-4 w-3/4" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-5/6" />
			</div>
		);
	}

	if (isError || !data) {
		return (
			<div
				className="flex items-start gap-2 border-t border-border bg-destructive/5 px-5 py-3 text-destructive text-xs"
				role="alert"
			>
				<AlertTriangleIcon
					className="mt-0.5 size-3.5 shrink-0"
					aria-hidden="true"
				/>
				<span>
					Failed to load page content
					{error instanceof Error ? `: ${error.message}` : ""}.
				</span>
			</div>
		);
	}

	const content = data.content ?? "";

	return (
		<div className="space-y-3 border-t border-border bg-muted/30 px-5 py-4 text-foreground/80 text-sm">
			<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
				<span className="text-[10px] uppercase tracking-[0.2em]">
					Markdown extract
				</span>
				<span aria-hidden="true">·</span>
				<span>
					{data.chunkCount} chunk{data.chunkCount === 1 ? "" : "s"}
				</span>
			</div>
			<article className="prose prose-sm dark:prose-invert max-w-none prose-pre:overflow-auto prose-pre:bg-card prose-pre:border prose-pre:border-border">
				<ReactMarkdown remarkPlugins={[remarkGfm]}>
					{content}
				</ReactMarkdown>
			</article>
		</div>
	);
}

/**
 * Terminal statuses for a URL source / page — used to decide when to stop
 * polling and stop the "Crawling" override on child rows.
 */
const TERMINAL_EXTRACTION_STATUSES = new Set([
	"COMPLETED",
	"INDEXED",
	"FAILED",
	"CANCELLED",
]);

function isExtractionInFlight(status: string | null | undefined): boolean {
	if (status == null) {
		return false;
	}
	return !TERMINAL_EXTRACTION_STATUSES.has(status);
}

function ChildPagesList({
	parentContextId,
	projectId,
	organizationId,
	parentExtractionStatus,
}: {
	parentContextId: string;
	projectId: string;
	organizationId: string | null;
	parentExtractionStatus: string | null;
}) {
	const isParentCrawling = isExtractionInFlight(parentExtractionStatus);
	const [expandedPageId, setExpandedPageId] = useState<string | null>(null);
	const { trackEvent } = useAnalytics();
	const t = useTranslations("tooltips.contextSources.urlSource");
	const queryClient = useQueryClient();
	/**
	 * Per-row optimistic status flip. The mutation invalidates the list, but
	 * react-query's first refetch can take a moment to land — we eagerly mark
	 * the row "Retrying…" so the user sees immediate feedback. Keyed by
	 * pageId; cleared once the row's real status no longer matches FAILED.
	 */
	const [retryingPageIds, setRetryingPageIds] = useState<Set<string>>(
		() => new Set(),
	);

	// Toolbar state for filtering + searching the (potentially 500-row)
	// child page list. Both go straight into the query key so react-query
	// caches results per-combination and bounces between filters feel
	// instant once warmed.
	type StatusFilter = "all" | "indexed" | "processing" | "failed";
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [searchInput, setSearchInput] = useState<string>("");
	// Debounce the server-side search so typing doesn't fire one
	// `listUrlPages` round-trip per keystroke. 250 ms feels live but
	// collapses the bursts you'd expect from typing a URL fragment.
	const [debouncedSearch, setDebouncedSearch] = useState<string>("");
	useEffect(() => {
		const handle = window.setTimeout(() => {
			setDebouncedSearch(searchInput.trim());
		}, 250);
		return () => window.clearTimeout(handle);
	}, [searchInput]);

	const listQuery = useInfiniteQuery({
		queryKey: [
			"projects",
			"contexts",
			"listUrlPages",
			projectId,
			organizationId,
			parentContextId,
			statusFilter,
			debouncedSearch,
		] as const,
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			orpcClient.projects.contexts.listUrlPages({
				parentContextId,
				projectId,
				organizationId,
				cursor: pageParam,
				limit: 10,
				statusFilter,
				...(debouncedSearch ? { search: debouncedSearch } : {}),
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		// Poll while the parent crawl is in flight so completed rows surface
		// without a manual refresh. Stops the moment the parent reaches a
		// terminal state (COMPLETED / INDEXED / FAILED).
		refetchInterval: isParentCrawling ? 3000 : false,
	});

	const pages: ChildPageRow[] = (listQuery.data?.pages ?? []).flatMap(
		(p) => p.items as ChildPageRow[],
	);

	const retryPageMutation = useMutation({
		mutationFn: (pageId: string) =>
			orpcClient.projects.contexts.resyncUrlPage({
				pageId,
				parentContextId,
				projectId,
				organizationId,
			}),
		onMutate: (pageId: string) => {
			setRetryingPageIds((prev) => {
				const next = new Set(prev);
				next.add(pageId);
				return next;
			});
		},
		onSuccess: (_data, pageId) => {
			trackEvent("project_context_url_page_retried", {
				pageId,
				parentContextId,
				projectId,
				organizationId,
			});
			toast.success("Page retry started");
			queryClient.invalidateQueries({
				queryKey: [
					"projects",
					"contexts",
					"listUrlPages",
					projectId,
					organizationId,
					parentContextId,
				],
			});
		},
		onError: (error: unknown, pageId) => {
			setRetryingPageIds((prev) => {
				const next = new Set(prev);
				next.delete(pageId);
				return next;
			});
			toast.error(
				error instanceof Error ? error.message : "Retry failed",
			);
		},
	});

	function toggleRow(pageId: string) {
		const next = expandedPageId === pageId ? null : pageId;
		setExpandedPageId(next);
		if (next) {
			trackEvent("project_context_url_content_previewed", {
				pageId: next,
				projectId,
				organizationId,
			});
		}
	}

	// Toolbar: status-filter chips + search input. Shown ALWAYS once the
	// initial load completes (even when filters return zero rows) so the
	// user can clear the filter and recover the full list. For PATH_PREFIX
	// only — single-page sources have no child rows and never render this
	// component in the first place.
	const isFiltered = statusFilter !== "all" || debouncedSearch.length > 0;

	const STATUS_FILTERS: ReadonlyArray<{
		value: StatusFilter;
		label: string;
	}> = [
		{ value: "all", label: "All" },
		{ value: "indexed", label: "Indexed" },
		{ value: "processing", label: "Processing" },
		{ value: "failed", label: "Failed" },
	];

	const toolbar = (
		<div
			className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
			data-testid="child-pages-toolbar"
		>
			<div className="flex flex-wrap items-center gap-1" role="tablist">
				{STATUS_FILTERS.map((f) => {
					const active = statusFilter === f.value;
					return (
						<button
							key={f.value}
							type="button"
							role="tab"
							aria-selected={active}
							onClick={() => setStatusFilter(f.value)}
							className={cn(
								"h-7 rounded-md border px-2.5 text-xs font-medium motion-safe:transition-colors",
								active
									? "border-primary bg-primary/10 text-primary"
									: "border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground",
							)}
							data-testid={`child-pages-filter-${f.value}`}
						>
							{f.label}
						</button>
					);
				})}
			</div>
			<Input
				type="search"
				value={searchInput}
				onChange={(e) => setSearchInput(e.target.value)}
				placeholder="Search by title or URL…"
				className="h-8 max-w-xs text-sm"
				data-testid="child-pages-search"
			/>
		</div>
	);

	if (listQuery.isLoading) {
		return (
			<div className="space-y-3" data-testid="child-pages-loading">
				{toolbar}
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-16 w-full" />
				))}
			</div>
		);
	}

	if (listQuery.isError) {
		return (
			<div className="space-y-3">
				{toolbar}
				<div
					className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-destructive text-sm"
					role="alert"
				>
					Failed to load pages: {listQuery.error.message}
				</div>
			</div>
		);
	}

	if (pages.length === 0) {
		return (
			<div className="space-y-3">
				{toolbar}
				<div className="rounded-md border border-border bg-muted/30 p-6 text-center text-muted-foreground text-sm">
					{isFiltered ? (
						<>
							<p className="font-medium text-foreground/70">
								No pages match the current filter
							</p>
							<p className="mt-1 text-xs">
								Clear the filter or change your search to see
								more rows.
							</p>
							<button
								type="button"
								onClick={() => {
									setStatusFilter("all");
									setSearchInput("");
								}}
								className="mt-3 inline-flex h-7 items-center rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground motion-safe:transition-colors hover:bg-muted/40"
							>
								Clear filters
							</button>
						</>
					) : (
						<>
							<p className="font-medium text-foreground/70">
								No pages indexed yet
							</p>
							<p className="mt-1 text-xs">
								Processing may still be in progress. Try Re-sync
								now if it has been a while.
							</p>
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-3" data-testid="child-pages-list">
			{toolbar}
			<ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
				{pages.map((page) => {
					const isExpanded = expandedPageId === page.id;
					const fetched = page.lastFetchedAt
						? typeof page.lastFetchedAt === "string"
							? new Date(page.lastFetchedAt)
							: page.lastFetchedAt
						: null;
					// Show Retry only for FAILED rows. Once the mutation
					// fires we eagerly flip the visible status to Processing
					// so the user sees immediate feedback even before
					// listUrlPages refetches.
					const isRetrying = retryingPageIds.has(page.id);
					const isFailedRow =
						page.extractionStatus === "FAILED" &&
						!isRetrying &&
						!isParentCrawling;
					// Show each child's REAL persisted status. The original
					// implementation also overrode every child to EXTRACTING
					// while the parent was crawling — but that defeated the
					// bulk-init UX (you couldn't tell which rows were already
					// indexed). The parent's own status pill + elapsed-time
					// chip in the header already convey "work in progress";
					// individual rows should report what they actually are
					// (Indexed / Processing / Failed). Only the retry
					// optimistic flip still overrides — that's per-row.
					const effectiveStatus = isRetrying
						? "EXTRACTING"
						: page.extractionStatus;
					return (
						<li
							key={page.id}
							data-testid={`url-page-row-${page.id}`}
						>
							<div className="flex items-stretch">
								<button
									type="button"
									onClick={() => toggleRow(page.id)}
									aria-expanded={isExpanded}
									aria-controls={`url-page-expansion-${page.id}`}
									className="flex min-w-0 flex-1 items-start gap-3 px-5 py-4 text-left motion-safe:transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-foreground text-sm">
											{page.pageTitle || page.pageUrl}
										</p>
										<p className="mt-0.5 truncate text-muted-foreground text-xs">
											{truncateMiddle(page.pageUrl, 90)}
										</p>
										<div className="mt-1.5 flex flex-wrap items-center gap-2 text-muted-foreground text-[11px]">
											<StatusPill
												status={effectiveStatus}
											/>
											<span>
												{page.chunkCount} chunk
												{page.chunkCount === 1
													? ""
													: "s"}
											</span>
											{fetched && (
												<span>
													·{" "}
													{formatDistanceToNow(
														fetched,
														{ addSuffix: true },
													)}
												</span>
											)}
										</div>
									</div>
									<ChevronDownIcon
										className={cn(
											"size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
											isExpanded && "rotate-180",
										)}
										aria-hidden="true"
									/>
								</button>
								{isFailedRow && (
									<div className="flex items-center pr-4">
										<Tooltip delayDuration={150}>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													className="h-7 gap-1 px-2 text-xs"
													data-testid={`url-page-retry-${page.id}`}
													onClick={() =>
														retryPageMutation.mutate(
															page.id,
														)
													}
													disabled={
														retryPageMutation.isPending
													}
													aria-busy={
														retryPageMutation.isPending
													}
													aria-label="Retry this page"
												>
													<RefreshCwIcon
														className="size-3"
														aria-hidden="true"
													/>
													Retry
												</Button>
											</TooltipTrigger>
											<TooltipContent
												side="left"
												className="max-w-xs"
											>
												{t("retryPage")}
											</TooltipContent>
										</Tooltip>
									</div>
								)}
							</div>
							{isExpanded && (
								<div id={`url-page-expansion-${page.id}`}>
									<ChildPageExpansion
										pageId={page.id}
										projectId={projectId}
										organizationId={organizationId}
									/>
								</div>
							)}
						</li>
					);
				})}
			</ul>

			{listQuery.hasNextPage && (
				<div className="flex justify-center pt-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => listQuery.fetchNextPage()}
						disabled={listQuery.isFetchingNextPage}
						aria-busy={listQuery.isFetchingNextPage}
					>
						{listQuery.isFetchingNextPage
							? "Loading…"
							: "Load more"}
					</Button>
				</div>
			)}
		</div>
	);
}

/* ── Sidebar Settings card (replaces the legacy popover) ─────────────────── */

// Defaults must match `DEFAULT_MAX_PAGES` / `MAX_MAX_PAGES` in
// `packages/api/modules/projects/procedures/contexts/process-context-link.ts`.
// Capped at 500 because at concurrency 1 with per-scrape settle + selector
// wait + extraction, 500 pages already takes ~85 min wall-clock. Default
// 200 keeps the Firecrawl spend low on the common case.
const MIN_MAX_PAGES = 1;
const MAX_MAX_PAGES = 500;
const DEFAULT_MAX_PAGES = 200;
const MAX_LABEL_LEN = 120;

/**
 * Inline settings card rendered in the right sidebar. Replaces the old
 * popover-style "Edit settings" trigger so the editing surface is always
 * visible and edits become an explicit Save action (deliberate, undo-able
 * via the form's own reset).
 *
 * Mirrors the shape of the Link tab inside `ContextUploaderDialog`:
 *  - Label text input.
 *  - Scope radio (Single page / Path-prefix).
 *  - Max pages stepper (only when scope=Path-prefix).
 *  - Refresh cadence select.
 *
 * On Save, calls `updateUrlSource` with the diff payload — sending only the
 * fields that actually changed keeps the audit-log entry tight on the server.
 */
function UrlSourceSettingsCard({
	contextId,
	projectId,
	label: initialLabel,
	scope: initialScope,
	maxPages: initialMaxPages,
	refreshMode: initialRefreshMode,
	category: initialCategory,
	categoryOther: initialCategoryOther,
	disabled = false,
}: {
	contextId: string;
	projectId: string;
	label: string | null;
	scope: Scope | null;
	maxPages: number | null;
	refreshMode: RefreshMode | null;
	category: KnowledgeBaseSourceCategoryValue | null;
	categoryOther: string | null;
	/**
	 * When true, every input + Save are locked and the card shows an inline
	 * "Crawling — settings locked" notice. The matching server guard in
	 * `update-url-source.ts` rejects writes when the row is in
	 * PENDING/EXTRACTING, so a stale client (or another tab that hasn't
	 * refreshed) can't sneak an edit through.
	 */
	disabled?: boolean;
}) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.contextSources.urlSource");

	const normalizedLabel = initialLabel ?? "";
	const normalizedScope: Scope = initialScope ?? "SINGLE_PAGE";
	const normalizedMaxPages = initialMaxPages ?? DEFAULT_MAX_PAGES;
	const normalizedRefresh: RefreshMode = initialRefreshMode ?? "ONCE";

	const [label, setLabel] = useState<string>(normalizedLabel);
	const [scope, setScope] = useState<Scope>(normalizedScope);
	const [maxPages, setMaxPages] = useState<number>(normalizedMaxPages);
	const [refreshMode, setRefreshMode] =
		useState<RefreshMode>(normalizedRefresh);
	// Classifying an existing source is the whole point here: sources created
	// before the category existed have none, and re-crawling a site purely to
	// record a label the user already knows is a waste of a scrape.
	const showCategory = useFeatureFlag("PROJECT_READINESS");
	const [category, setCategory] = useState<
		KnowledgeBaseSourceCategoryValue | ""
	>(initialCategory ?? "");
	const [categoryOther, setCategoryOther] = useState<string>(
		initialCategoryOther ?? "",
	);

	const updateMutation = useMutation({
		mutationFn: (input: {
			label?: string;
			scope?: Scope;
			maxPages?: number;
			refreshMode?: RefreshMode;
			knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategoryValue;
			knowledgeBaseSourceCategoryOther?: string;
		}) =>
			orpcClient.projects.contexts.updateUrlSource({
				contextId,
				projectId,
				organizationId,
				...input,
			}),
		onSuccess: () => {
			toast.success("URL source updated");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId, organizationId },
				}),
			});
		},
		onError: (error: unknown) => {
			toast.error(
				error instanceof Error ? error.message : "Update failed",
			);
		},
	});

	// Build the diff payload — only fields the user actually changed get
	// sent. Empty inputs (label cleared) flip to undefined so the server
	// keeps the existing value rather than persisting "".
	const labelChanged = label.trim() !== normalizedLabel.trim();
	const scopeChanged = scope !== normalizedScope;
	const maxPagesChanged =
		scope === "PATH_PREFIX" && maxPages !== normalizedMaxPages;
	const refreshChanged = refreshMode !== normalizedRefresh;
	const categoryChanged =
		showCategory &&
		category !== "" &&
		(category !== initialCategory ||
			(category === "OTHER" &&
				categoryOther.trim() !== (initialCategoryOther ?? "").trim()));
	// "Other" with no description is not a classification, it is a shrug — the
	// server refuses it, so the button refuses it first.
	const categoryIncomplete =
		categoryChanged && category === "OTHER" && !categoryOther.trim();

	const hasPendingChanges =
		labelChanged ||
		scopeChanged ||
		maxPagesChanged ||
		refreshChanged ||
		categoryChanged;

	const labelId = `settings-label-${contextId}`;
	const scopeLabelId = `settings-scope-label-${contextId}`;
	const maxPagesId = `settings-maxpages-${contextId}`;
	const refreshId = `settings-refresh-${contextId}`;
	const categoryId = `settings-category-${contextId}`;

	function handleSave() {
		if (!hasPendingChanges) {
			return;
		}
		const diff: {
			label?: string;
			scope?: Scope;
			maxPages?: number;
			refreshMode?: RefreshMode;
			knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategoryValue;
			knowledgeBaseSourceCategoryOther?: string;
		} = {};
		if (labelChanged) {
			diff.label = label.trim();
		}
		if (scopeChanged) {
			diff.scope = scope;
		}
		if (maxPagesChanged) {
			diff.maxPages = maxPages;
		}
		if (refreshChanged) {
			diff.refreshMode = refreshMode;
		}
		if (categoryChanged) {
			diff.knowledgeBaseSourceCategory = category;
			if (category === "OTHER") {
				diff.knowledgeBaseSourceCategoryOther = categoryOther.trim();
			}
		}
		updateMutation.mutate(diff);
	}

	function handleMaxPagesStep(delta: number) {
		setMaxPages((current) => {
			const next = Math.min(
				MAX_MAX_PAGES,
				Math.max(MIN_MAX_PAGES, current + delta),
			);
			return next;
		});
	}

	function handleMaxPagesInput(e: React.ChangeEvent<HTMLInputElement>) {
		const raw = e.target.value;
		if (raw === "") {
			setMaxPages(MIN_MAX_PAGES);
			return;
		}
		const n = Number.parseInt(raw, 10);
		if (Number.isNaN(n)) {
			return;
		}
		setMaxPages(Math.min(MAX_MAX_PAGES, Math.max(MIN_MAX_PAGES, n)));
	}

	return (
		<div
			className={cn(
				"space-y-4 rounded-xl border border-border bg-card p-5",
				disabled && "opacity-60",
			)}
			data-testid="url-source-settings-card"
			aria-disabled={disabled || undefined}
		>
			<div className="flex items-center justify-between gap-2">
				<EditorialLabel>Settings</EditorialLabel>
				{disabled && (
					<span
						className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
						data-testid="url-source-settings-locked-notice"
					>
						<LoaderIcon
							className="size-3 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						Locked while processing
					</span>
				)}
			</div>
			<fieldset
				disabled={disabled}
				className="space-y-4 disabled:cursor-not-allowed"
			>
				<div className="space-y-1">
					<div className="flex items-center gap-1">
						<Label htmlFor={labelId} className="text-xs">
							Label
						</Label>
						<Tooltip delayDuration={150}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label="About the Label field"
									className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground motion-safe:transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									<InfoIcon
										className="size-3"
										aria-hidden="true"
									/>
								</button>
							</TooltipTrigger>
							<TooltipContent side="right">
								{t("label")}
							</TooltipContent>
						</Tooltip>
					</div>
					<Input
						id={labelId}
						value={label}
						maxLength={MAX_LABEL_LEN}
						placeholder="e.g. Zendesk Help Center"
						onChange={(e) => setLabel(e.target.value)}
						className="h-8 text-sm"
						data-testid="url-source-settings-label"
					/>
				</div>

				<div className="space-y-2">
					<p
						id={scopeLabelId}
						className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
					>
						Scope
					</p>
					<RadioGroup
						value={scope}
						onValueChange={(v) => setScope(v as Scope)}
						aria-labelledby={scopeLabelId}
						className="grid grid-cols-1 gap-2"
						data-testid="url-source-settings-scope"
					>
						<Tooltip delayDuration={150}>
							<TooltipTrigger asChild>
								<label
									htmlFor={`${contextId}-scope-single`}
									className={cn(
										"flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-2.5 text-xs motion-safe:transition-colors",
										scope === "SINGLE_PAGE" &&
											"border-primary",
									)}
								>
									<RadioGroupItem
										value="SINGLE_PAGE"
										id={`${contextId}-scope-single`}
										className="mt-0.5"
									/>
									<span className="block">
										<span className="block font-medium text-foreground">
											Single page
										</span>
										<span className="block text-muted-foreground">
											Index only this URL.
										</span>
									</span>
								</label>
							</TooltipTrigger>
							<TooltipContent side="right">
								{t("scopeSinglePage")}
							</TooltipContent>
						</Tooltip>
						<Tooltip delayDuration={150}>
							<TooltipTrigger asChild>
								<label
									htmlFor={`${contextId}-scope-prefix`}
									className={cn(
										"flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-2.5 text-xs motion-safe:transition-colors",
										scope === "PATH_PREFIX" &&
											"border-primary",
									)}
								>
									<RadioGroupItem
										value="PATH_PREFIX"
										id={`${contextId}-scope-prefix`}
										className="mt-0.5"
									/>
									<span className="block">
										<span className="block font-medium text-foreground">
											Path-prefix
										</span>
										<span className="block text-muted-foreground">
											Crawl pages under the URL's path.
										</span>
									</span>
								</label>
							</TooltipTrigger>
							<TooltipContent side="right">
								{t("scopePathPrefix")}
							</TooltipContent>
						</Tooltip>
					</RadioGroup>
				</div>

				{scope === "PATH_PREFIX" && (
					<div
						className="space-y-1"
						data-testid="url-source-settings-maxpages-row"
					>
						<div className="flex items-center gap-1">
							<Label htmlFor={maxPagesId} className="text-xs">
								Max pages
							</Label>
							<Tooltip delayDuration={150}>
								<TooltipTrigger asChild>
									<button
										type="button"
										aria-label="About the Max pages field"
										className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground motion-safe:transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									>
										<InfoIcon
											className="size-3"
											aria-hidden="true"
										/>
									</button>
								</TooltipTrigger>
								<TooltipContent side="right">
									{t("maxPages")}
								</TooltipContent>
							</Tooltip>
						</div>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="icon"
								className="size-8"
								aria-label="Decrease max pages"
								onClick={() => handleMaxPagesStep(-10)}
								disabled={maxPages <= MIN_MAX_PAGES}
							>
								<MinusIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							</Button>
							<Input
								id={maxPagesId}
								type="number"
								inputMode="numeric"
								min={MIN_MAX_PAGES}
								max={MAX_MAX_PAGES}
								value={maxPages}
								onChange={handleMaxPagesInput}
								className="h-8 w-20 text-center text-sm"
							/>
							<Button
								type="button"
								variant="outline"
								size="icon"
								className="size-8"
								aria-label="Increase max pages"
								onClick={() => handleMaxPagesStep(10)}
								disabled={maxPages >= MAX_MAX_PAGES}
							>
								<PlusIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							Range {MIN_MAX_PAGES}–{MAX_MAX_PAGES}. Raise for
							large help centers.
						</p>
					</div>
				)}

				<div className="space-y-1">
					<div className="flex items-center gap-1">
						<Label htmlFor={refreshId} className="text-xs">
							Refresh cadence
						</Label>
						<Tooltip delayDuration={150}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label="About refresh cadence"
									className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground motion-safe:transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									<InfoIcon
										className="size-3"
										aria-hidden="true"
									/>
								</button>
							</TooltipTrigger>
							<TooltipContent side="right" className="max-w-xs">
								{refreshMode === "ONCE"
									? t("refreshOnce")
									: refreshMode === "LIVE"
										? t("refreshLive")
										: t("refreshScheduled")}
							</TooltipContent>
						</Tooltip>
					</div>
					<Select
						value={refreshMode}
						onValueChange={(v) => setRefreshMode(v as RefreshMode)}
					>
						<SelectTrigger
							id={refreshId}
							className="h-8 text-sm"
							data-testid="url-source-settings-refresh"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{REFRESH_MODES.map((m) => (
								<SelectItem key={m.value} value={m.value}>
									{m.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{refreshMode === "LIVE" && (
						<output className="flex items-start gap-1.5 text-highlight text-xs">
							<AlertTriangleIcon
								className="mt-0.5 size-3 shrink-0"
								aria-hidden="true"
							/>
							<span className="text-foreground/70">
								Live re-fetches on every AI run. Use Daily or
								Weekly for less-volatile sources.
							</span>
						</output>
					)}
				</div>

				{showCategory && (
					<div className="space-y-1">
						<Label htmlFor={categoryId} className="text-xs">
							Source category
						</Label>
						<Select
							value={category}
							onValueChange={(v) =>
								setCategory(
									v as KnowledgeBaseSourceCategoryValue,
								)
							}
						>
							<SelectTrigger
								id={categoryId}
								className="h-8 text-sm"
								data-testid="url-source-settings-category"
							>
								<SelectValue placeholder="Choose a category" />
							</SelectTrigger>
							<SelectContent>
								{KNOWLEDGE_BASE_CATEGORY_OPTIONS.map(
									(option) => (
										<SelectItem
											key={option.value}
											value={option.value}
										>
											{option.label}
										</SelectItem>
									),
								)}
							</SelectContent>
						</Select>
						{category === "OTHER" && (
							<Input
								value={categoryOther}
								onChange={(e) =>
									setCategoryOther(e.target.value)
								}
								maxLength={200}
								className="h-8 text-sm"
								placeholder="Describe the source"
								aria-label="Describe the source category"
								data-testid="url-source-settings-category-other"
							/>
						)}
						{initialCategory === null && (
							<p className="text-muted-foreground text-xs">
								This source predates categories. Setting one
								classifies it for the readiness checklist — it
								does not re-crawl the site.
							</p>
						)}
					</div>
				)}
			</fieldset>

			<div className="flex items-center justify-end">
				<Button
					type="button"
					size="sm"
					variant="default"
					onClick={handleSave}
					disabled={
						disabled ||
						!hasPendingChanges ||
						categoryIncomplete ||
						updateMutation.isPending
					}
					aria-busy={updateMutation.isPending}
					data-testid="url-source-settings-save"
				>
					{updateMutation.isPending ? "Saving…" : "Save"}
				</Button>
			</div>
		</div>
	);
}

/* ── Main view ──────────────────────────────────────────────────────────── */

/**
 * Trigger a browser download for a presigned URL. Mirrors the helper used
 * by `ProjectContextsList.handleDownloadRow` — kept local here so this
 * component stays self-contained for the full-view page.
 */
function triggerBrowserDownload(url: string, filename: string): void {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
}

export function UrlSourcePageView({ context, backHref }: Props) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const router = useRouter();
	const { trackEvent } = useAnalytics();
	const t = useTranslations("tooltips.contextSources.urlSource");
	const tTooltips = useTranslations("tooltips.contextSources");

	const isFailed = context.extractionStatus === "FAILED";
	const isPathPrefix = context.urlScope === "PATH_PREFIX";
	const isCrawling = isExtractionInFlight(context.extractionStatus);
	const displayTitle = context.sourceTitle || hostnameOf(context.sourceUrl);

	// While the parent crawl is in flight, poll the route every 3s so the
	// status pill, "Last synced" line, and pages-indexed count refresh as the
	// worker advances. The interval auto-stops on terminal status, on unmount,
	// and skips when the tab is hidden so a forgotten tab doesn't hammer the
	// server.
	useEffect(() => {
		if (!isCrawling) {
			return;
		}
		const tick = () => {
			if (typeof document !== "undefined" && document.hidden) {
				return;
			}
			router.refresh();
		};
		const handle = window.setInterval(tick, 3000);
		return () => window.clearInterval(handle);
	}, [isCrawling, router]);

	const resyncMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.contexts.resyncUrlSource({
				contextId: context.id,
				projectId: context.projectId,
				organizationId,
			}),
		onSuccess: () => {
			toast.success("Re-sync started");
			trackEvent("project_context_url_resynced", {
				trigger: "manual",
				projectId: context.projectId,
				organizationId,
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: {
						projectId: context.projectId,
						organizationId,
					},
				}),
			});
			router.refresh();
		},
		onError: (error: unknown) => {
			toast.error(
				error instanceof Error ? error.message : "Re-sync failed",
			);
		},
	});

	const cancelMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.contexts.cancelUrlSourceCrawl({
				contextId: context.id,
				projectId: context.projectId,
				organizationId,
			}),
		onSuccess: (data) => {
			if (data?.status === "ALREADY_FINISHED") {
				toast.info("Processing already finished — nothing to cancel.");
			} else {
				toast.success(
					"Cancelling. Pages indexed so far will be preserved.",
				);
			}
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: {
						projectId: context.projectId,
						organizationId,
					},
				}),
			});
			router.refresh();
		},
		onError: (error: unknown) => {
			toast.error(
				error instanceof Error ? error.message : "Cancel failed",
			);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.contexts.delete({
				id: context.id,
				projectId: context.projectId,
				organizationId,
			}),
		onSuccess: () => {
			toast.success("URL source deleted");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: {
						projectId: context.projectId,
						organizationId,
					},
				}),
			});
			router.push(backHref);
		},
		onError: (error: unknown) => {
			toast.error(
				error instanceof Error ? error.message : "Delete failed",
			);
		},
	});

	/**
	 * Export this URL source as a single Markdown file. Reuses the same
	 * `createDownloadUrl` plumbing the other context cards use; the
	 * procedure handles SINGLE_PAGE (parent.content) and PATH_PREFIX
	 * (server-side concatenation of child pages) transparently.
	 */
	const downloadMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.contexts.createDownloadUrl({
				contextId: context.id,
				projectId: context.projectId,
				organizationId,
			}),
		onSuccess: (res: { url: string; filename: string }) => {
			triggerBrowserDownload(res.url, res.filename);
			trackEvent("project_context_downloaded", {
				contextId: context.id,
				projectId: context.projectId,
				type: "LINK",
				organizationId,
				format: "md",
			});
		},
		onError: (error: unknown) => {
			toast.error(
				error instanceof Error ? error.message : "Download failed",
			);
		},
	});

	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(context.sourceUrl);
			toast.success("URL copied");
		} catch {
			toast.error("Could not copy URL");
		}
	}

	const lastSynced = context.urlLastSyncedAt
		? new Date(context.urlLastSyncedAt)
		: null;
	const nextRefresh = context.urlNextRefreshAt
		? new Date(context.urlNextRefreshAt)
		: null;
	const createdAt = new Date(context.createdAt);

	return (
		<div className="flex w-full flex-col">
			{/* Skip-to-main-content link for keyboard users. */}
			<a
				href="#url-source-main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-md focus:ring-2 focus:ring-ring"
			>
				Skip to main content
			</a>

			{/* Sticky header strip — full-width app-shell bar (matches the
			    Aspire-style chrome above the content). The hero/main below
			    stays at max-w-7xl for the editorial reading width; this bar
			    deliberately spans edge-to-edge so the breadcrumb + status
			    pill anchor at the screen corners instead of feeling
			    cramped inside the centered column. */}
			<div className="sticky top-0 z-10 border-b border-border bg-background">
				<div className="flex w-full items-center gap-3 px-6 py-3">
					<Link
						href={backHref}
						aria-label="Back to project contexts"
						className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground motion-safe:transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<ArrowLeftIcon className="size-4" aria-hidden="true" />
					</Link>

					{/* Breadcrumb — built inline so the trailing status pill */}
					{/* sits on the same baseline. */}
					<nav
						aria-label="Breadcrumb"
						className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-sm"
					>
						<Link
							href={backHref}
							className="hover:text-foreground hover:underline"
						>
							Projects
						</Link>
						<span aria-hidden="true">›</span>
						<Link
							href={backHref}
							className="hover:text-foreground hover:underline"
						>
							{context.projectName}
						</Link>
						<span aria-hidden="true">›</span>
						<Link
							href={backHref}
							className="hover:text-foreground hover:underline"
						>
							Context
						</Link>
						<span aria-hidden="true">›</span>
						<span className="truncate text-foreground">
							{displayTitle}
						</span>
					</nav>

					{isCrawling && (
						<Tooltip>
							<TooltipTrigger asChild>
								<span
									className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground"
									data-testid="url-source-crawl-elapsed-chip"
								>
									<TimerIcon
										className="size-3"
										aria-hidden="true"
									/>
									<ElapsedSince since={context.updatedAt} />
									{/* Not focusable, so the portalled tooltip is
										pointer-only. `aria-label` would replace the
										visible elapsed time in the accessible name;
										an `sr-only` child adds the meaning. */}
									<span className="sr-only">
										{tTooltips("crawlElapsed")}
									</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>
								{tTooltips("crawlElapsed")}
							</TooltipContent>
						</Tooltip>
					)}
					<Tooltip delayDuration={150}>
						<TooltipTrigger asChild>
							<button
								type="button"
								className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								data-testid="status-pill-trigger"
							>
								<StatusPill
									status={context.extractionStatus}
									indexedCount={context.indexedCount}
								/>
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" className="max-w-xs">
							{context.extractionStatus === "FAILED"
								? t("statusFailed")
								: context.extractionStatus === "CANCELLED" &&
										context.indexedCount > 0
									? `Processing stopped early — ${context.indexedCount} pages were already indexed and are usable. Click Re-sync now to finish the rest.`
									: context.extractionStatus === "CANCELLED"
										? "Processing was cancelled before any pages indexed. Click Re-sync now to start over."
										: context.extractionStatus ===
													"COMPLETED" ||
												context.extractionStatus ===
													"INDEXED"
											? t("statusIndexed")
											: t("statusCrawling")}
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{/* Hero block */}
			<header className="border-b border-border">
				<div className="mx-auto w-full max-w-7xl px-6 py-8">
					<div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
						<div className="min-w-0 space-y-3">
							<EditorialLabel id="url-source-eyebrow">
								URL Source
							</EditorialLabel>
							<h1
								className="font-serif text-3xl font-normal leading-tight tracking-tight text-foreground sm:text-4xl"
								aria-describedby="url-source-eyebrow"
							>
								{displayTitle}
							</h1>
							<div className="flex items-center gap-2 text-muted-foreground text-sm">
								<ExternalLinkIcon
									className="size-3.5 shrink-0"
									aria-hidden="true"
								/>
								<a
									href={context.sourceUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="truncate hover:text-foreground hover:underline"
								>
									{truncateMiddle(context.sourceUrl, 90)}
								</a>
								<button
									type="button"
									onClick={copyUrl}
									aria-label="Copy URL"
									className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground motion-safe:transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									<CopyIcon
										className="size-3.5"
										aria-hidden="true"
									/>
								</button>
							</div>
						</div>

						{/* Action cluster — sits at top-right per layout spec. */}
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							{isCrawling ? (
								// While crawling we swap Re-sync for Cancel so the user has a way to
								// stop a long crawl without losing already-indexed pages. Cancel
								// signals Temporal; the workflow catches CancelledFailure and
								// finalizes the parent via the normal updateParentStatusActivity
								// path — preserving rows already written to ProjectContextUrlPage.
								<Tooltip delayDuration={150}>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="sm"
											variant="outline"
											className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive/40"
											onClick={() =>
												cancelMutation.mutate()
											}
											disabled={cancelMutation.isPending}
											aria-busy={cancelMutation.isPending}
											data-testid="url-source-cancel-crawl"
										>
											<XCircleIcon
												className="size-3.5"
												aria-hidden="true"
											/>
											{cancelMutation.isPending
												? "Cancelling…"
												: "Cancel processing"}
										</Button>
									</TooltipTrigger>
									<TooltipContent
										side="bottom"
										className="max-w-xs"
									>
										Stop processing. Pages already indexed
										will be preserved.
									</TooltipContent>
								</Tooltip>
							) : (
								<Tooltip delayDuration={150}>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="sm"
											variant="default"
											className="gap-1.5"
											onClick={() =>
												resyncMutation.mutate()
											}
											disabled={resyncMutation.isPending}
											aria-busy={resyncMutation.isPending}
										>
											<RefreshCwIcon
												className={cn(
													"size-3.5",
													resyncMutation.isPending &&
														"motion-safe:animate-spin",
												)}
												aria-hidden="true"
											/>
											{resyncMutation.isPending
												? "Starting…"
												: "Re-sync now"}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{t("resyncNow")}
									</TooltipContent>
								</Tooltip>
							)}

							<Tooltip delayDuration={150}>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-8"
										onClick={() =>
											downloadMutation.mutate()
										}
										disabled={
											downloadMutation.isPending ||
											isFailed ||
											isCrawling
										}
										aria-busy={downloadMutation.isPending}
										aria-label="Download URL source"
										data-testid="url-source-download"
									>
										<DownloadIcon
											className="size-4"
											aria-hidden="true"
										/>
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{isCrawling
										? "Download is disabled while processing is running. Cancel or wait for it to finish."
										: t("downloadPage")}
								</TooltipContent>
							</Tooltip>

							<Tooltip delayDuration={150}>
								<TooltipTrigger asChild>
									<a
										href={context.sourceUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground motion-safe:transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									>
										<ExternalLinkIcon
											className="size-3.5"
											aria-hidden="true"
										/>
										View raw URL
									</a>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("viewRawUrl")}
								</TooltipContent>
							</Tooltip>

							<DropdownMenu>
								<Tooltip delayDuration={150}>
									<TooltipTrigger asChild>
										<DropdownMenuTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="size-8"
												aria-label="More options"
											>
												<MoreVerticalIcon
													className="size-4"
													aria-hidden="true"
												/>
											</Button>
										</DropdownMenuTrigger>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{t("moreOptions")}
									</TooltipContent>
								</Tooltip>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										className="text-destructive focus:text-destructive"
										onClick={() => {
											if (isCrawling) {
												return;
											}
											if (
												typeof window === "undefined" ||
												window.confirm(
													"Delete this URL source? This will remove all indexed pages.",
												)
											) {
												deleteMutation.mutate();
											}
										}}
										disabled={
											deleteMutation.isPending ||
											isCrawling
										}
										data-testid="url-source-delete"
									>
										<Trash2Icon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{deleteMutation.isPending
											? "Deleting…"
											: isCrawling
												? "Cancel processing to delete"
												: "Delete URL source"}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
				</div>
			</header>

			{/* Two-column body */}
			<main
				id="url-source-main"
				className="mx-auto w-full max-w-7xl px-6 py-8"
			>
				<div className="grid gap-8 lg:grid-cols-[1fr_320px]">
					<section
						className="min-w-0"
						aria-labelledby="url-source-content-heading"
						data-testid="url-source-main-column"
					>
						<h2 id="url-source-content-heading" className="sr-only">
							Content
						</h2>
						{isFailed ? (
							<FailedStateCard
								extractionError={context.extractionError}
								onRetry={() => resyncMutation.mutate()}
								retryPending={resyncMutation.isPending}
							/>
						) : isPathPrefix ? (
							<ChildPagesList
								parentContextId={context.id}
								projectId={context.projectId}
								organizationId={organizationId}
								parentExtractionStatus={
									context.extractionStatus
								}
							/>
						) : context.content && context.content.length > 0 ? (
							<article
								className="prose prose-stone dark:prose-invert max-w-none rounded-xl border border-border bg-card p-8 prose-pre:overflow-auto prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-headings:font-serif prose-headings:font-normal"
								data-testid="url-source-markdown"
							>
								<ReactMarkdown remarkPlugins={[remarkGfm]}>
									{context.content}
								</ReactMarkdown>
							</article>
						) : (
							<div
								className="rounded-xl border border-border bg-muted/30 p-8 text-center text-muted-foreground text-sm"
								data-testid="url-source-empty"
							>
								<p className="font-medium text-foreground/80">
									No content extracted yet
								</p>
								<p className="mt-1 text-xs">
									The crawl may still be in progress.
								</p>
							</div>
						)}
					</section>

					{/* Sidebar */}
					<aside
						className="space-y-4"
						aria-label="URL source details"
					>
						<div className="space-y-4 rounded-xl border border-border bg-card p-5">
							{/* Card title — kept larger than the inline "Settings"
							    / "Activity" section labels below it so the
							    visual hierarchy is clear: this is the card
							    title, those are sub-section markers within it. */}
							<h2 className="font-semibold text-base text-foreground tracking-tight">
								Details
							</h2>
							<div className="space-y-3">
								<DetailRow label="Scraper provider">
									{context.scraperProvider ?? "Firecrawl"}
								</DetailRow>
								<DetailRow label="Scope">
									<Tooltip delayDuration={150}>
										<TooltipTrigger asChild>
											<span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
												{scopeLabel(context.urlScope)}
											</span>
										</TooltipTrigger>
										<TooltipContent side="left">
											{context.urlScope === "PATH_PREFIX"
												? t("scopePathPrefix")
												: t("scopeSinglePage")}
										</TooltipContent>
									</Tooltip>
								</DetailRow>
								<DetailRow label="Refresh">
									{cadenceLabel(context.urlRefreshMode)}
								</DetailRow>
								{isPathPrefix && (
									<>
										<DetailRow label="Max pages">
											{context.urlMaxPages ?? "—"}
										</DetailRow>
										{/* Per-status breakdown so the user can see, at
										   a glance, how much was discovered vs. how many
										   pages are indexed / failed / still processing.
										   Counts come from `getUrlSourceContext` (one
										   groupBy on extractionStatus, see
										   `packages/database/prisma/queries/projects/contexts.ts`).
										   Discovered is the parent's `_count.urlPages` total —
										   PENDING placeholders count too once bulk-init has
										   pre-populated the row set. */}
										<DetailRow label="Pages">
											<dl
												className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs"
												data-testid="url-source-pages-breakdown"
											>
												<dt className="text-muted-foreground">
													Discovered
												</dt>
												<dd className="text-right tabular-nums">
													{context.totalCount ?? 0}
												</dd>
												<dt className="text-muted-foreground">
													Indexed
												</dt>
												<dd className="text-right tabular-nums text-secondary">
													{context.indexedCount}
												</dd>
												{(context.pendingCount ?? 0) >
													0 && (
													<>
														<dt className="text-muted-foreground">
															Processing
														</dt>
														<dd className="text-right tabular-nums text-highlight">
															{
																context.pendingCount
															}
														</dd>
													</>
												)}
												{(context.failedCount ?? 0) >
													0 && (
													<>
														<dt className="text-muted-foreground">
															Failed
														</dt>
														<dd className="text-right tabular-nums text-destructive">
															{
																context.failedCount
															}
														</dd>
													</>
												)}
											</dl>
										</DetailRow>
									</>
								)}
								<DetailRow label="Last synced">
									{lastSynced ? (
										<time
											dateTime={lastSynced.toISOString()}
											title={lastSynced.toISOString()}
										>
											{formatDistanceToNow(lastSynced, {
												addSuffix: true,
											})}
										</time>
									) : (
										<span className="text-muted-foreground">
											Never
										</span>
									)}
								</DetailRow>
								<DetailRow label="Next refresh">
									<Tooltip delayDuration={150}>
										<TooltipTrigger asChild>
											{nextRefresh ? (
												<span
													className="cursor-help"
													data-testid="url-source-next-refresh"
												>
													{formatDistanceToNow(
														nextRefresh,
														{ addSuffix: true },
													)}
													<span className="text-muted-foreground">
														{" · "}
														{formatUtcAbsolute(
															nextRefresh,
														)}
													</span>
												</span>
											) : (
												<span
													className="cursor-help text-muted-foreground"
													data-testid="url-source-next-refresh"
												>
													—
												</span>
											)}
										</TooltipTrigger>
										<TooltipContent
											side="left"
											className="max-w-xs"
										>
											{t("nextRefresh")}
										</TooltipContent>
									</Tooltip>
								</DetailRow>
							</div>
						</div>

						<UrlSourceSettingsCard
							contextId={context.id}
							projectId={context.projectId}
							label={context.sourceTitle}
							scope={context.urlScope}
							maxPages={context.urlMaxPages}
							refreshMode={context.urlRefreshMode}
							category={context.knowledgeBaseSourceCategory}
							categoryOther={
								context.knowledgeBaseSourceCategoryOther
							}
							disabled={isCrawling}
						/>

						<div className="space-y-3 rounded-xl border border-border bg-card p-5">
							<EditorialLabel>Activity</EditorialLabel>
							<ul className="space-y-2 text-foreground/80 text-sm">
								<li className="flex items-start gap-2">
									<span
										className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
										aria-hidden="true"
									/>
									<span>
										Source added{" "}
										<span className="text-muted-foreground">
											{formatDistanceToNow(createdAt, {
												addSuffix: true,
											})}
										</span>
									</span>
								</li>
								{lastSynced && (
									<li className="flex items-start gap-2">
										<span
											className="mt-1.5 size-1.5 shrink-0 rounded-full bg-secondary"
											aria-hidden="true"
										/>
										<span>
											Last sync completed{" "}
											<span className="text-muted-foreground">
												{formatDistanceToNow(
													lastSynced,
													{
														addSuffix: true,
													},
												)}
											</span>
										</span>
									</li>
								)}
								{isFailed && (
									<li className="flex items-start gap-2">
										<span
											className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive"
											aria-hidden="true"
										/>
										<span className="text-destructive">
											Sync failed
										</span>
									</li>
								)}
							</ul>
						</div>
					</aside>
				</div>
			</main>
		</div>
	);
}

/* ── Failure state ──────────────────────────────────────────────────────── */

function FailedStateCard({
	extractionError,
	onRetry,
	retryPending,
}: {
	extractionError: string | null;
	onRetry: () => void;
	retryPending: boolean;
}) {
	const message = extractionError ?? "Crawl failed";
	const isRobotsBlocked = /robots|disallow/i.test(message);
	const display = isRobotsBlocked
		? "This site disallows crawlers in its robots.txt"
		: message;

	return (
		<div
			className="space-y-4 rounded-xl border border-destructive/40 bg-destructive/5 p-6"
			role="alert"
			data-testid="url-source-failed"
		>
			<div className="flex items-start gap-3">
				<XCircleIcon
					className="mt-0.5 size-5 shrink-0 text-destructive"
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1 space-y-2">
					<h2 className="font-semibold text-base text-foreground">
						Crawl failed
					</h2>
					<p className="text-foreground/80 text-sm">{display}</p>
					{display !== message && (
						<details>
							<summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
								Raw error
							</summary>
							<p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
								{message}
							</p>
						</details>
					)}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="default"
					size="sm"
					className="gap-1.5"
					onClick={onRetry}
					disabled={retryPending}
					aria-busy={retryPending}
				>
					<RefreshCwIcon
						className={cn(
							"size-3.5",
							retryPending && "motion-safe:animate-spin",
						)}
						aria-hidden="true"
					/>
					{retryPending ? "Starting…" : "Retry"}
				</Button>
				<a
					href={FIRECRAWL_TROUBLESHOOTING_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
				>
					<ExternalLinkIcon className="size-3" aria-hidden="true" />
					View troubleshooting
				</a>
			</div>
		</div>
	);
}
