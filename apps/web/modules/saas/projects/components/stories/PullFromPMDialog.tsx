"use client";

import { useAnalytics } from "@analytics";
import type {
	ParseTicketIdsError,
	ParseTicketIdsErrorKind,
	PMTicketListError,
	PMTicketListNote,
} from "@repo/api/modules/projects/procedures/stories/sync/list-pm-tickets-filters.types";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { SearchInput } from "@ui/components/search-input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	AlertTriangleIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CloudDownloadIcon,
	Loader2Icon,
	SearchIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FiltersSection } from "./pull-from-pm/FiltersSection";
import { IssuesRegion } from "./pull-from-pm/IssuesRegion";
import { NotesRegion } from "./pull-from-pm/NotesRegion";
import { parseTicketIds } from "./pull-from-pm/parse-ticket-ids";

/**
 * Analytics reason values emitted on Apply-time validation failure.
 * Maps 1:1 from `ParseTicketIdsErrorKind` so the telemetry surface stays
 * bounded by the parser's closed set of kinds.
 */
type FilterValidationReason = "syntax" | "range" | "over_cap";

const PARSE_ERROR_REASON: Record<
	ParseTicketIdsErrorKind,
	FilterValidationReason
> = {
	not_numeric: "syntax",
	range_inversion: "range",
	over_cap: "over_cap",
	empty_token: "syntax",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PMTicket {
	id: string;
	displayId: string;
	title: string;
	alreadySynced?: boolean;
}

interface AppliedFilters {
	ids?: number[];
}

interface PullFromPMDialogProps {
	open: boolean;
	onClose: () => void;
	/** Called with the selected PM external IDs when user confirms */
	onConfirm: (pmExternalIds: string[]) => void;
	projectId: string;
	organizationId: string | null;
	pmToolName: string;
	/** True while the bulk-pull workflow is being started */
	isPulling?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a window of page numbers to show around the current page. */
function pageWindow(current: number, total: number): (number | "…")[] {
	if (total <= 7) {
		return Array.from({ length: total }, (_, i) => i + 1);
	}
	const pages: (number | "…")[] = [1];
	if (current > 3) {
		pages.push("…");
	}
	for (
		let p = Math.max(2, current - 1);
		p <= Math.min(total - 1, current + 1);
		p++
	) {
		pages.push(p);
	}
	if (current < total - 2) {
		pages.push("…");
	}
	pages.push(total);
	return pages;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PullFromPMDialog({
	open,
	onClose,
	onConfirm,
	projectId,
	organizationId,
	pmToolName,
	isPulling = false,
}: PullFromPMDialogProps) {
	const { trackEvent } = useAnalytics();
	const tStories = useTranslations("tooltips.stories");

	// Existing state
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [page, setPage] = useState(1);

	// Include already-synced toggle (default off, resets on dialog open)
	const [includeAlreadySynced, setIncludeAlreadySynced] = useState(false);

	// Filter draft state (updated on keystroke).
	const [idsText, setIdsText] = useState("");

	// Applied filter state — only this goes into the query key, so typing
	// fires no network (§5.3).
	const [appliedFilters, setAppliedFilters] = useState<AppliedFilters | null>(
		null,
	);

	// Debounce search input (300 ms)
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 300);
		return () => clearTimeout(timer);
	}, [search]);

	// Reset everything when dialog opens
	useEffect(() => {
		if (open) {
			setSearch("");
			setDebouncedSearch("");
			setSelected(new Set());
			setPage(1);
			setIdsText("");
			setAppliedFilters(null);
			setIncludeAlreadySynced(false);
		}
	}, [open]);

	// Reset to page 1 and clear selection when search changes
	useEffect(() => {
		setPage(1);
		setSelected(new Set());
	}, [debouncedSearch]);

	// Reset page and selection when includeAlreadySynced toggle changes
	useEffect(() => {
		setPage(1);
		setSelected(new Set());
	}, [includeAlreadySynced]);

	// Clear selection when page changes (selection is per-page only)
	useEffect(() => {
		setSelected(new Set());
	}, [page]);

	// -------------------------------------------------------------------------
	// Parsing
	// -------------------------------------------------------------------------

	const parsed = useMemo(() => parseTicketIds(idsText), [idsText]);
	const parseErrors: ParseTicketIdsError[] =
		idsText.trim().length === 0 || parsed.ok ? [] : parsed.errors;

	// -------------------------------------------------------------------------
	// Data fetching
	// -------------------------------------------------------------------------

	const { data, isFetching, isError, error } = useQuery({
		queryKey: [
			"pm-tickets",
			projectId,
			organizationId,
			debouncedSearch,
			page,
			appliedFilters,
			includeAlreadySynced,
		],
		queryFn: () =>
			orpcClient.projects.stories.listPMTickets({
				projectId,
				page,
				pageSize: PAGE_SIZE,
				search: debouncedSearch || undefined,
				filters: appliedFilters ?? undefined,
				includeAlreadySynced,
			}),
		enabled:
			open &&
			(debouncedSearch.length > 0 ||
				(appliedFilters?.ids != null && appliedFilters.ids.length > 0)),
		placeholderData: (prev) => prev,
	});

	const tickets: PMTicket[] = useMemo(() => data?.tickets ?? [], [data]);

	const notes: PMTicketListNote[] = useMemo(() => data?.notes ?? [], [data]);
	const issues: PMTicketListError[] = useMemo(
		() => data?.errors ?? [],
		[data],
	);

	const totalPages = data
		? Math.max(1, Math.ceil(data.total / PAGE_SIZE))
		: 1;

	// -------------------------------------------------------------------------
	// Filter actions
	// -------------------------------------------------------------------------

	const handleApply = useCallback(() => {
		if (!parsed.ok) {
			// Client-blocking validation failure. Pick the first
			// parse error's kind as the dominant reason — one event per Apply.
			const first = parsed.errors[0];
			if (first) {
				trackEvent("pm_import_filter_validation_failed", {
					reason: PARSE_ERROR_REASON[first.kind],
				});
			}
			return;
		}
		const hasIds = parsed.ids.length > 0;
		if (!hasIds) {
			return;
		}
		const next: AppliedFilters = { ids: parsed.ids };
		setAppliedFilters(next);
		setPage(1);
		setSelected(new Set());
		trackEvent("pm_import_filter_applied", {
			hasIds,
			idExpandedCount: parsed.ids.length,
		});
	}, [parsed, trackEvent]);

	const handleClear = useCallback(() => {
		setIdsText("");
		setAppliedFilters(null);
		setPage(1);
		setSelected(new Set());
	}, []);

	// -------------------------------------------------------------------------
	// Selection helpers (current page only)
	// -------------------------------------------------------------------------

	const toggleTicket = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const selectAll = useCallback(() => {
		setSelected(new Set(tickets.map((t) => t.id)));
	}, [tickets]);

	const deselectAll = useCallback(() => {
		setSelected(new Set());
	}, []);

	const allVisible =
		tickets.length > 0 && tickets.every((t) => selected.has(t.id));
	const someVisible = tickets.some((t) => selected.has(t.id));

	const handleConfirm = useCallback(() => {
		if (selected.size === 0) {
			return;
		}
		onConfirm(Array.from(selected));
	}, [selected, onConfirm]);

	const goToPage = useCallback(
		(p: number) => {
			if (p >= 1 && p <= totalPages) {
				setPage(p);
			}
		},
		[totalPages],
	);

	// -------------------------------------------------------------------------
	// Render
	// -------------------------------------------------------------------------

	const showPagination = totalPages > 1;

	return (
		<Dialog open={open} onOpenChange={(v) => !v && onClose()}>
			<DialogContent className="flex flex-col gap-0 p-0 max-w-lg max-h-[85vh]">
				{/* ── Header ── */}
				<DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60">
					<DialogTitle className="flex items-center gap-2 text-base font-semibold">
						<CloudDownloadIcon className="size-4 text-primary" />
						Pull from {pmToolName}
					</DialogTitle>
					<p className="text-xs text-muted-foreground mt-0.5">
						Search or filter tickets to import. Use the toggle below
						to include tickets already imported into this project.
					</p>
				</DialogHeader>

				{/* ── Filters ── */}
				<FiltersSection
					idsText={idsText}
					onIdsTextChange={setIdsText}
					parseErrors={parseErrors}
					onApply={handleApply}
					onClear={handleClear}
				/>

				{/* ── Notes / Issues regions ── */}
				<NotesRegion notes={notes} />
				<IssuesRegion errors={issues} />

				{/* ── Search ── */}
				<div className="px-4 py-3 border-b border-border/60">
					<div className="relative">
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
						<SearchInput
							placeholder="Search by title or ID…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							className="pl-8 h-8 text-sm bg-muted/40"
						/>
					</div>
				</div>

				{/* ── Board stats (always visible when data loaded) ── */}
				{data && !isFetching && (
					<div className="px-4 py-2 border-b border-border/40 bg-muted/20 flex items-center gap-3 flex-wrap">
						<span className="text-xs text-muted-foreground">
							<span className="font-medium text-foreground">
								{data.totalOnBoard}
							</span>{" "}
							on board
						</span>
						{data.alreadySynced > 0 && (
							<>
								<span className="text-xs text-muted-foreground/40">
									·
								</span>
								<span className="text-xs text-muted-foreground">
									<span className="font-medium text-foreground">
										{data.alreadySynced}
									</span>{" "}
									already imported
								</span>
							</>
						)}
						<span className="text-xs text-muted-foreground/40">
							·
						</span>
						<span className="text-xs font-medium text-primary">
							{data.total} ready to import
						</span>
					</div>
				)}

				{/* ── Include already-imported toggle ── */}
				{data && data.alreadySynced > 0 && (
					<div className="px-4 py-2 border-b border-border/40">
						{/* biome-ignore lint/a11y/noLabelWithoutControl: wraps Radix Checkbox which renders a <button>, not a native <input> */}
						<label className="flex items-start gap-2 cursor-pointer select-none">
							<Checkbox
								checked={includeAlreadySynced}
								onCheckedChange={(v) =>
									setIncludeAlreadySynced(!!v)
								}
								className="mt-0.5 shrink-0"
								aria-label="Include already-imported tickets"
							/>
							<span className="text-xs text-muted-foreground leading-relaxed">
								{tStories("pullFromPmIncludeAlreadySynced")}
							</span>
						</label>
					</div>
				)}

				{/* ── Select-all row ── */}
				{tickets.length > 0 && (
					<div className="px-4 py-2 border-b border-border/40 flex items-center justify-between bg-muted/20">
						{/* biome-ignore lint/a11y/noLabelWithoutControl: wraps Radix Checkbox which renders a <button>, not a native <input> */}
						<label className="flex items-center gap-2 cursor-pointer select-none">
							<Checkbox
								checked={
									allVisible
										? true
										: someVisible
											? "indeterminate"
											: false
								}
								onCheckedChange={(v) =>
									v ? selectAll() : deselectAll()
								}
								aria-label="Select all visible tickets"
							/>
							<span className="text-xs text-muted-foreground">
								Select all on this page
							</span>
						</label>
						{selected.size > 0 && (
							<span className="text-xs font-medium text-primary">
								{selected.size} selected
							</span>
						)}
					</div>
				)}

				{/* ── Ticket list ── */}
				<div className="flex-1 overflow-y-auto px-2 py-1 min-h-0 relative">
					{/* Overlay spinner during page transitions — blocks interaction to prevent
					    selecting stale tickets from the previous page via placeholderData */}
					{isFetching && tickets.length > 0 && (
						<div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10">
							<Loader2Icon className="size-5 animate-spin text-muted-foreground" />
						</div>
					)}

					{isFetching && tickets.length === 0 ? (
						// Initial load or search spinner
						<div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground py-6">
							<Loader2Icon className="size-5 animate-spin" />
							<span className="text-sm">
								{debouncedSearch
									? `Searching all tickets in ${pmToolName}…`
									: `Loading tickets from ${pmToolName}…`}
							</span>
						</div>
					) : isError ? (
						// Error state
						<div className="flex flex-col items-center justify-center h-full gap-2 text-destructive px-4 py-6">
							<AlertCircleIcon className="size-5" />
							<span className="text-sm text-center">
								{error instanceof Error
									? error.message
									: "Failed to load tickets"}
							</span>
						</div>
					) : tickets.length === 0 ? (
						// Empty state
						<div className="flex flex-col items-center justify-center h-full text-muted-foreground px-4 py-6">
							<span className="text-sm text-center">
								{debouncedSearch
									? "No tickets match your search"
									: appliedFilters?.ids
										? "No matching tickets found for the specified IDs"
										: "Enter ticket IDs or search by name to find tickets"}
							</span>
						</div>
					) : (
						// Ticket rows
						<ul className="space-y-0.5 py-1">
							{tickets.map((ticket) => {
								const isSelected = selected.has(ticket.id);
								const isSynced = ticket.alreadySynced === true;
								return (
									<li key={ticket.id}>
										{/* biome-ignore lint/a11y/useSemanticElements: Use a div (not button) — Radix Checkbox renders a <button> internally; nesting interactive elements is invalid HTML and breaks keyboard/focus behaviour. */}
										<div
											role="button"
											tabIndex={0}
											onClick={() =>
												toggleTicket(ticket.id)
											}
											onKeyDown={(e) => {
												if (
													e.key === "Enter" ||
													e.key === " "
												) {
													e.preventDefault();
													toggleTicket(ticket.id);
												}
											}}
											className={cn(
												"w-full flex items-start gap-3 rounded-md px-3 py-2.5 text-left cursor-pointer",
												"transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
												isSelected && "bg-primary/8",
												isSynced && "opacity-75",
											)}
										>
											<Checkbox
												checked={isSelected}
												onCheckedChange={() =>
													toggleTicket(ticket.id)
												}
												className="mt-0.5 shrink-0"
												aria-label={`Select ticket ${ticket.displayId}`}
												onClick={(e) =>
													e.stopPropagation()
												}
											/>
											<span className="min-w-0 flex-1">
												<span className="flex items-center gap-1.5">
													<span className="text-sm font-medium leading-snug truncate">
														{ticket.title}
													</span>
													{isSynced && (
														<span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
															Already imported
														</span>
													)}
												</span>
												<span className="block text-xs text-muted-foreground mt-0.5">
													#{ticket.displayId}
												</span>
											</span>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>

				{/* ── Pagination ── */}
				{showPagination && (
					<div className="px-4 py-2 border-t border-border/40 flex flex-col items-center gap-1.5">
						<div className="flex items-center gap-1">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-7"
										onClick={() => goToPage(page - 1)}
										disabled={page <= 1 || isFetching}
										aria-label="Previous page"
									>
										<ChevronLeftIcon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{tStories("pullFromPmPreviousPage")}
								</TooltipContent>
							</Tooltip>

							{pageWindow(page, totalPages).map((p, i) =>
								p === "…" ? (
									<span
										key={`ellipsis-${i}`}
										className="px-1 text-xs text-muted-foreground select-none"
									>
										…
									</span>
								) : (
									<Button
										key={p}
										variant={
											p === page ? "default" : "ghost"
										}
										size="icon"
										className="size-7 text-xs"
										onClick={() => goToPage(p)}
										disabled={isFetching}
										aria-label={`Page ${p}`}
										aria-current={
											p === page ? "page" : undefined
										}
									>
										{p}
									</Button>
								),
							)}

							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-7"
										onClick={() => goToPage(page + 1)}
										disabled={
											page >= totalPages || isFetching
										}
										aria-label="Next page"
									>
										<ChevronRightIcon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{tStories("pullFromPmNextPage")}
								</TooltipContent>
							</Tooltip>
						</div>
						<span className="text-xs text-muted-foreground">
							Page {page} of {totalPages}
							{data && (
								<>
									{" · "}
									{Math.min(
										(page - 1) * PAGE_SIZE + 1,
										data.total,
									)}
									–{Math.min(page * PAGE_SIZE, data.total)} of{" "}
									{data.total} tickets
								</>
							)}
						</span>
					</div>
				)}

				{/* ── Overwrite warning when synced tickets selected ── */}
				{includeAlreadySynced &&
					tickets.some(
						(t) => selected.has(t.id) && t.alreadySynced,
					) && (
						<div className="px-4 py-2 border-t border-border/40">
							<div className="flex items-start gap-2 rounded-lg border border-highlight/30 bg-highlight/5 p-3 text-xs text-foreground">
								<AlertTriangleIcon className="size-3.5 mt-0.5 shrink-0 text-highlight" />
								<span>
									{tStories("pullFromPmOverwriteWarning")}
								</span>
							</div>
						</div>
					)}

				{/* ── Footer ── */}
				<DialogFooter className="px-4 py-3 border-t border-border/60 flex-row gap-2 justify-end">
					<Button
						variant="outline"
						size="sm"
						onClick={onClose}
						disabled={isPulling}
					>
						Cancel
					</Button>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="sm"
								onClick={handleConfirm}
								disabled={selected.size === 0 || isPulling}
								className="min-w-[130px]"
							>
								{isPulling ? (
									<>
										<Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
										Starting…
									</>
								) : (
									<>
										<CloudDownloadIcon className="size-3.5 mr-1.5" />
										{(() => {
											if (selected.size === 0) {
												return "Pull selected";
											}
											const selectedSynced =
												tickets.filter(
													(t) =>
														selected.has(t.id) &&
														t.alreadySynced,
												).length;
											const selectedNew =
												selected.size - selectedSynced;
											if (
												selectedSynced > 0 &&
												selectedNew > 0
											) {
												return `Pull ${selectedNew} new + update ${selectedSynced}`;
											}
											if (selectedSynced > 0) {
												return `Update ${selectedSynced} ticket${selectedSynced === 1 ? "" : "s"}`;
											}
											return `Pull ${selected.size} ticket${selected.size === 1 ? "" : "s"}`;
										})()}
									</>
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{tStories("pullFromPmConfirm")}
						</TooltipContent>
					</Tooltip>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
