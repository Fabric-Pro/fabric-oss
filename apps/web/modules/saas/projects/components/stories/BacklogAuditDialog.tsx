"use client";

/**
 * "Change history" — a dedicated, read-only window for the project's roadmap
 * history, opened from an icon-only button on the roadmap toolbar. Two tabs:
 *
 * - **Change History** — EVERY change to the roadmap's tickets (create / update
 *   / status-change / delete), by people AND automated sources (AI Update /
 *   channel proposals), newest first. Each row shows the ticket id (open in a
 *   new tab), the change source, and the person who made it. Supports search +
 *   filters by person, action, and date range.
 * - **Sync History** — the PM tool push/pull log for the same project, so sync
 *   events can be correlated against the changes they produced without leaving
 *   the roadmap.
 *
 * The two tabs read from separate paginated endpoints and keep their own
 * filters; they are deliberately not merged into one timeline (different row
 * shapes, two cursors).
 *
 * Strictly read-only: no edit / delete / revert controls.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	ExternalLinkIcon,
	FilePlus2Icon,
	PencilIcon,
	RefreshCwIcon,
	SearchIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type ComponentType,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { buildStoryDetailsRoute } from "../../lib/stories/routes";
import {
	HistoryActor,
	HistoryEmptyState,
	HistoryError,
	HistoryLoading,
	HistoryPager,
	HistoryTimestamp,
} from "./BacklogHistoryShared";
import { SyncHistoryView } from "./pm-sync/sync-history/SyncHistoryView";

type ActionFilter =
	| "all"
	| "created"
	| "updated"
	| "status_changed"
	| "deleted";
type DateRange = "all" | "7d" | "30d" | "90d";

/** Which log the modal is showing. Also the deep-link target (`?history=sync`). */
export type HistoryView = "changes" | "sync";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	organizationId: string | null;
	/**
	 * Which log is showing. Controlled by the roadmap, which already owns the
	 * open/closed state and the deep-link request — keeping the selection there
	 * too means there is one source of truth and no post-mount correction, so
	 * the first committed render is already the right tab.
	 */
	view: HistoryView;
	onViewChange: (view: HistoryView) => void;
};

function actionIcon(action: string): ComponentType<{ className?: string }> {
	switch (action) {
		case "story.created":
			return FilePlus2Icon;
		case "story.deleted":
			return Trash2Icon;
		case "story.status_changed":
			return RefreshCwIcon;
		default:
			return PencilIcon;
	}
}

function describeAction(
	action: string,
	resourceName: string | null,
	statusName: string | null,
): string {
	const name = resourceName ? `«${resourceName}»` : "an item";
	switch (action) {
		case "story.created":
			return `Created ${name}`;
		case "story.deleted":
			return `Deleted ${name}`;
		case "story.status_changed":
			return statusName
				? `Moved ${name} to "${statusName}"`
				: `Changed status of ${name}`;
		case "story.updated":
			return `Updated ${name}`;
		default:
			return `${action} ${name}`;
	}
}

/** Lower-bound date for a preset range; undefined = no lower bound (all time). */
function dateFromForRange(range: DateRange): Date | undefined {
	if (range === "all") {
		return undefined;
	}
	const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
	const from = new Date();
	from.setHours(0, 0, 0, 0);
	from.setDate(from.getDate() - days);
	return from;
}

/** Debounce a fast-changing value (the search box) to limit refetches. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const id = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(id);
	}, [value, delayMs]);
	return debounced;
}

/** The audit-history row shape the list renders (subset of the API item). */
type AuditItem = {
	id: string;
	action: string;
	resourceId: string | null;
	identifier: string | null;
	resourceName: string | null;
	statusName: string | null;
	changedFields: string[] | null;
	actorName: string | null;
	actorEmail: string | null;
	actorImage: string | null;
	source: string | null;
	deleted: boolean;
	groupKey: string | null;
	createdAt: Date;
};

/** ~6s window for clustering id-less changes from one request together. */
const BULK_CLUSTER_MS = 6000;

/** Whether two adjacent rows belong to the same request/bulk. */
function sameBatch(prev: AuditItem, item: AuditItem): boolean {
	// A recorded request id (correlationId / proposalId) is authoritative.
	if (prev.groupKey || item.groupKey) {
		return prev.groupKey != null && prev.groupKey === item.groupKey;
	}
	// Neither carries one — cluster a run of changes by the same person + same
	// source that happened together.
	const sameActor =
		(item.actorEmail ?? item.actorName) ===
		(prev.actorEmail ?? prev.actorName);
	const sameSource = (item.source ?? "") === (prev.source ?? "");
	const gapMs = Math.abs(prev.createdAt.getTime() - item.createdAt.getTime());
	return sameActor && sameSource && gapMs <= BULK_CLUSTER_MS;
}

/** Group the (newest-first) rows into contiguous bulk batches. */
function groupIntoBatches(items: AuditItem[]): AuditItem[][] {
	const out: AuditItem[][] = [];
	for (const item of items) {
		const last = out[out.length - 1];
		if (last && sameBatch(last[last.length - 1] as AuditItem, item)) {
			last.push(item);
		} else {
			out.push([item]);
		}
	}
	return out;
}

/** One change row: the ticket link/id (or a "deleted" tag), action, actor, time. */
function AuditRowCard({
	item,
	onOpenTicket,
}: {
	item: AuditItem;
	onOpenTicket: (storyId: string) => void;
}) {
	const tTooltips = useTranslations("tooltips.common");
	const Icon = actionIcon(item.action);
	const canOpen = !!item.resourceId && item.action !== "story.deleted";
	// The full change description — shown truncated, with the complete text on
	// hover (native title tooltip) so a cropped ticket name is still readable.
	const description = describeAction(
		item.action,
		item.resourceName,
		item.statusName,
	);
	return (
		<div className="rounded-lg border border-foreground/10 bg-card p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-2">
					<Icon
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<div className="min-w-0">
						<div className="flex items-baseline gap-1.5">
							{item.identifier && canOpen ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() =>
												onOpenTicket(
													item.resourceId as string,
												)
											}
											className="inline-flex shrink-0 items-center gap-0.5 rounded font-medium font-mono text-primary text-xs hover:underline"
										>
											{item.identifier}
											<ExternalLinkIcon
												className="size-3"
												aria-hidden="true"
											/>
										</button>
									</TooltipTrigger>
									<TooltipContent>
										{tTooltips("openTicketNewTab")}
									</TooltipContent>
								</Tooltip>
							) : item.identifier ? (
								<span className="shrink-0 font-mono text-muted-foreground text-xs">
									{item.identifier}
								</span>
							) : item.deleted &&
								item.action !== "story.deleted" ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="shrink-0 rounded bg-muted px-1.5 py-0 font-medium text-[10px] text-muted-foreground">
											deleted
											{/* The chip is not focusable, so the tooltip is
												pointer-only. A native `title` on a non-interactive
												element maps to the accessible *description*, which
												screen readers could reach; a portalled tooltip cannot.
												Repeating the copy here keeps that parity. `aria-label`
												would not work — it replaces the accessible name, so
												the visible "deleted" would disappear from it. */}
											<span className="sr-only">
												{tTooltips("ticketDeleted")}
											</span>
										</span>
									</TooltipTrigger>
									<TooltipContent>
										{tTooltips("ticketDeleted")}
									</TooltipContent>
								</Tooltip>
							) : null}
							<p
								title={description}
								className="truncate text-foreground text-sm"
							>
								{description}
							</p>
						</div>
						{item.changedFields && item.changedFields.length > 0 ? (
							<p className="mt-0.5 text-muted-foreground text-xs">
								Changed: {item.changedFields.join(", ")}
							</p>
						) : null}
						<div className="mt-1">
							<HistoryActor
								name={item.actorName}
								email={item.actorEmail}
								image={item.actorImage}
								source={item.source}
							/>
						</div>
					</div>
				</div>
				<HistoryTimestamp value={item.createdAt} />
			</div>
		</div>
	);
}

/** The Change History tab: search + filters over the roadmap audit trail. */
function AuditHistoryPanel({
	projectId,
	organizationId,
	active,
}: {
	projectId: string;
	organizationId: string | null;
	/** Both panels stay mounted so filters survive a tab switch; only the
	 *  visible one queries. */
	active: boolean;
}) {
	const { basePath } = useOrganizationContext();
	const tStories = useTranslations("tooltips.stories");
	const [search, setSearch] = useState("");
	const [person, setPerson] = useState<string>("all");
	const [action, setAction] = useState<ActionFilter>("all");
	const [dateRange, setDateRange] = useState<DateRange>("all");
	const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([
		undefined,
	]);
	const cursor = cursorStack[cursorStack.length - 1];

	const debouncedSearch = useDebouncedValue(search.trim(), 300);

	// Reset paging whenever the query shape changes (filters / search / scope).
	useEffect(() => {
		setCursorStack([undefined]);
	}, [debouncedSearch, person, action, dateRange, projectId, organizationId]);

	const hasFilters =
		debouncedSearch.length > 0 ||
		person !== "all" ||
		action !== "all" ||
		dateRange !== "all";

	// Project members for the "filter by person" dropdown.
	const membersQuery = useQuery({
		queryKey: ["project-members", projectId, organizationId ?? null],
		queryFn: () =>
			orpcClient.projects.members.list({ projectId, organizationId }),
		enabled: active,
	});
	const members = membersQuery.data?.members ?? [];

	const query = useQuery({
		queryKey: [
			"backlog-audit-history",
			projectId,
			organizationId ?? null,
			debouncedSearch,
			person,
			action,
			dateRange,
			cursor ?? null,
		],
		queryFn: () =>
			orpcClient.projects.backlog.history.audit.list({
				projectId,
				organizationId,
				cursor,
				limit: 50,
				action,
				...(debouncedSearch ? { search: debouncedSearch } : {}),
				...(person !== "all" ? { actorUserId: person } : {}),
				...(dateRange !== "all"
					? { dateFrom: dateFromForRange(dateRange) }
					: {}),
			}),
		enabled: active,
		placeholderData: (prev) => prev,
	});

	const items = useMemo(() => query.data?.items ?? [], [query.data]);

	// Open a ticket in a new tab. Uses a programmatic anchor (not window.open)
	// so the installed PWA window doesn't swallow the in-scope URL.
	const openTicket = useCallback(
		(storyId: string) => {
			if (!storyId) {
				return;
			}
			const url = buildStoryDetailsRoute(basePath, projectId, storyId);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.target = "_blank";
			anchor.rel = "noopener noreferrer";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
		},
		[basePath, projectId],
	);

	return (
		<>
			{/* Toolbar: search on top, filters below (wrap on narrow widths). */}
			<div className="space-y-2 border-border/60 border-b px-6 py-3">
				<div className="relative">
					<SearchIcon
						className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground"
						aria-hidden="true"
					/>
					<SearchInput
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search by ticket or person…"
						aria-label="Search change history"
						className="pl-8"
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Select value={person} onValueChange={setPerson}>
						<SelectTrigger
							className="w-[150px]"
							aria-label="Filter by person"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">Anyone</SelectItem>
							{members.map((m) => (
								<SelectItem key={m.userId} value={m.userId}>
									{m.user.name ?? m.user.email}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={action}
						onValueChange={(v) => setAction(v as ActionFilter)}
					>
						<SelectTrigger
							className="w-[140px]"
							aria-label="Filter by change type"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All actions</SelectItem>
							<SelectItem value="created">Created</SelectItem>
							<SelectItem value="updated">Updated</SelectItem>
							<SelectItem value="status_changed">
								Status changed
							</SelectItem>
							<SelectItem value="deleted">Deleted</SelectItem>
						</SelectContent>
					</Select>
					<Select
						value={dateRange}
						onValueChange={(v) => setDateRange(v as DateRange)}
					>
						<SelectTrigger
							className="w-[140px]"
							aria-label="Filter by date range"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All time</SelectItem>
							<SelectItem value="7d">Last 7 days</SelectItem>
							<SelectItem value="30d">Last 30 days</SelectItem>
							<SelectItem value="90d">Last 90 days</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>

			{/* Body */}
			{/* Focusable for the same reason as the sync tab's scroller: this
			    div, not the Radix tabpanel, is what scrolls, and a change row's
			    only focusable element is an optional ticket link. */}
			<div
				// biome-ignore lint/a11y/noNoninteractiveTabindex: axe's scrollable-region-focusable requires the opposite — a scroll container with no focusable child is unreachable by keyboard (WCAG 2.1.1) unless it takes focus itself.
				tabIndex={0}
				role="group"
				aria-label="Change history entries"
				className="min-h-0 flex-1 overflow-y-auto px-6 py-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
			>
				{query.isLoading ? (
					<HistoryLoading rows={5} />
				) : query.isError ? (
					<HistoryError onRetry={() => query.refetch()} />
				) : items.length === 0 ? (
					<HistoryEmptyState
						title={
							hasFilters
								? "No matching changes"
								: "No changes recorded yet"
						}
						description={
							hasFilters
								? "Try a different search term or clear the filters."
								: "Backlog item changes — created, updated, moved, or deleted, by AI or a teammate — will appear here as they happen."
						}
					/>
				) : (
					<ul className="space-y-2">
						{groupIntoBatches(items).map((batch) => {
							const isBulk = batch.length > 1;
							return (
								<li key={batch[0]?.id} className="flex gap-2">
									{/* Continuous accent bar marks a bulk (one
										request). The bar is decorative, so it stays
										`aria-hidden` and only gets a tooltip when
										there is copy to show; the `sr-only` note
										below gives the grouping a real accessible
										identity, which the native `title` on an
										`aria-hidden` element never did. */}
									{isBulk ? (
										<>
											<Tooltip>
												<TooltipTrigger asChild>
													<div
														aria-hidden="true"
														className="w-[3px] shrink-0 rounded-full bg-primary/50"
													/>
												</TooltipTrigger>
												<TooltipContent>
													{tStories(
														"bulkChangeCount",
														{
															count: batch.length,
														},
													)}
												</TooltipContent>
											</Tooltip>
											<span className="sr-only">
												{tStories("bulkChangeCount", {
													count: batch.length,
												})}
											</span>
										</>
									) : (
										<div
											aria-hidden="true"
											className="w-[3px] shrink-0 rounded-full bg-transparent"
										/>
									)}
									<div className="min-w-0 flex-1 space-y-2">
										{batch.map((item) => (
											<AuditRowCard
												key={item.id}
												item={item}
												onOpenTicket={openTicket}
											/>
										))}
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</div>

			{/* Footer: pager (only when there's more than one page) */}
			{cursorStack.length > 1 || query.data?.nextCursor ? (
				<div className="border-border/60 border-t px-6 py-3">
					<HistoryPager
						canPrev={cursorStack.length > 1}
						canNext={!!query.data?.nextCursor}
						isFetching={query.isFetching}
						showingCount={items.length}
						page={cursorStack.length}
						onPrev={() => setCursorStack((s) => s.slice(0, -1))}
						onNext={() =>
							setCursorStack((s) => [
								...s,
								query.data?.nextCursor ?? undefined,
							])
						}
					/>
				</div>
			) : null}
		</>
	);
}

/** Title + blurb per view. The title is the dialog's accessible name, so it has
 *  to follow the tab — announcing "Change history" while showing the sync log
 *  mislabels the window for screen-reader users. */
const VIEW_COPY: Record<HistoryView, { title: string; description: string }> = {
	changes: {
		title: "Change history",
		description:
			"Every change to this roadmap's tickets — by people and AI — newest first.",
	},
	sync: {
		title: "Sync history",
		description:
			"Every push to and pull from this project's PM tool — newest first.",
	},
};

export function BacklogAuditDialog({
	open,
	onOpenChange,
	projectId,
	organizationId,
	view,
	onViewChange,
}: Props) {
	const copy = VIEW_COPY[view];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
				<DialogHeader className="px-6 pt-6 pb-4">
					<DialogTitle className="font-serif font-normal text-2xl">
						{copy.title}
					</DialogTitle>
					<DialogDescription>{copy.description}</DialogDescription>
				</DialogHeader>

				<Tabs
					value={view}
					onValueChange={(next) =>
						onViewChange(next === "sync" ? "sync" : "changes")
					}
					className="flex min-h-0 flex-1 flex-col gap-0"
				>
					<TabsList className="px-6">
						<TabsTrigger value="changes">
							Change History
						</TabsTrigger>
						<TabsTrigger value="sync">Sync History</TabsTrigger>
					</TabsList>

					{/* Both panels stay mounted (`forceMount`) so switching tabs to
						    correlate an event and switching back doesn't wipe the
						    filters, search and page you set up. Each panel's queries
						    are gated on `active`, so the one you can't see stays
						    idle. `hidden` is set explicitly: under `forceMount`
						    Radix leaves the inactive panel VISIBLE and only marks
						    `data-state`, and the attribute — unlike a CSS class —
						    also takes it out of the accessibility tree. */}
					<TabsContent
						forceMount
						hidden={view !== "changes"}
						value="changes"
						className="mt-0 flex min-h-0 flex-1 flex-col"
					>
						<AuditHistoryPanel
							active={view === "changes"}
							projectId={projectId}
							organizationId={organizationId}
						/>
					</TabsContent>

					<TabsContent
						forceMount
						hidden={view !== "sync"}
						value="sync"
						className="mt-0 flex min-h-0 flex-1 flex-col"
					>
						<SyncHistoryView
							projectId={projectId}
							active={view === "sync"}
						/>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
