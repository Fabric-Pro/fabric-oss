"use client";

/**
 * RoadmapFilterToolbarView — pure presentational layout for the roadmap filter
 * toolbar. All state (search debounce, the "More filters" disclosure) lives in
 * the RoadmapFilterToolbar container; this component just renders. Keeping it
 * presentational lets it be previewed in isolation (no orpc / tenant context).
 *
 * Layout:
 *   • Bar:     search (left) · inbox + trailing controls (right)
 *   • Filters: a light, hairline-bounded region (not a heavy filled card) with
 *              the primary facets (tight horizontal flow) + a "More filters"
 *              disclosure for the secondary facets.
 *   • Chips:   active filters + "Clear all".
 *   • Count:   on its own line so changing it never shifts the bar.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	EyeIcon,
	Loader2Icon,
	SearchIcon,
	SparklesIcon,
} from "lucide-react";
import { useId } from "react";
import type { RoadmapFilters } from "../../lib/roadmap-filters";
import { RoadmapFilterChips } from "./RoadmapFilterChips";
import { RoadmapFiltersPanel } from "./RoadmapFiltersPanel";

function ResultCount({
	totalCount,
	filteredCount,
	hasActiveFilters,
	hiddenMatchCount,
	onShowHidden,
}: {
	totalCount: number;
	filteredCount: number;
	hasActiveFilters: boolean;
	hiddenMatchCount: number;
	/** When set, the hidden-match count becomes a button that reveals the
	 * hidden items (activates the Show-hidden eye toggle). */
	onShowHidden?: () => void;
}) {
	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs uppercase tracking-[0.14em] tabular-nums">
			{/* innerText stays "N of M shown" / "M work items" for unit + E2E parsers. */}
			<span data-testid="roadmap-filter-count">
				{hasActiveFilters ? (
					<>
						<span className="font-semibold text-foreground">
							{filteredCount}
						</span>{" "}
						of {totalCount} shown
					</>
				) : (
					<>
						<span className="font-semibold text-foreground">
							{totalCount}
						</span>{" "}
						{totalCount === 1 ? "work item" : "work items"}
					</>
				)}
			</span>
			{/* Companion HIDDEN-match count, right beside the main count. When a
			    reveal handler is wired it becomes a button that activates the
			    Show-hidden eye toggle. */}
			{hiddenMatchCount > 0 &&
				(onShowHidden ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={onShowHidden}
								className="inline-flex items-center gap-1 rounded font-normal normal-case tracking-normal text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								· {hiddenMatchCount} hidden also{" "}
								{hiddenMatchCount === 1 ? "matches" : "match"}
								<EyeIcon aria-hidden className="size-3" />
							</button>
						</TooltipTrigger>
						<TooltipContent>
							Show the {hiddenMatchCount} hidden{" "}
							{hiddenMatchCount === 1 ? "item" : "items"} that
							also match your filters
						</TooltipContent>
					</Tooltip>
				) : (
					<span className="font-normal normal-case tracking-normal text-muted-foreground/70">
						· {hiddenMatchCount} hidden also{" "}
						{hiddenMatchCount === 1 ? "matches" : "match"}
					</span>
				))}
		</span>
	);
}

export type RoadmapFilterToolbarViewProps = {
	filters: RoadmapFilters;
	onFiltersChange: (next: Partial<RoadmapFilters>) => void;
	onClearAll: () => void;
	onRemoveFilter: (key: keyof RoadmapFilters, value?: string) => void;
	totalCount: number;
	filteredCount: number;
	hasActiveFilters: boolean;
	hiddenMatchCount?: number;
	/** Reveal the hidden matches (activates the Show-hidden eye toggle). */
	onShowHidden?: () => void;
	/** Controlled search text + setter (the container debounces writes). */
	searchValue: string;
	onSearchValueChange: (value: string) => void;
	/** AI (semantic) search mode — rendered as a Sparkles toggle beside the
	 * input. Absent when the feature flag is off. */
	aiMode?: boolean;
	onToggleAiMode?: () => void;
	/** A semantic search request is in flight (spinner on the toggle). */
	aiSearching?: boolean;
	/** The last semantic search failed — surfaced next to the result count
	 * instead of silently falling back to keyword results. */
	aiSearchError?: boolean;
	/** Partial-warm coverage note (AI search covered only part of the
	 * backlog this request) — shown next to the result count. */
	aiCoverageNote?: string | null;
	/** AI mode matched nothing semantic — keyword results are shown and the
	 * notice says so, instead of silently mixing modes. */
	aiFallbackNote?: string | null;
	/** AI mode is toggled on but the query is still below the minimum length,
	 * so nothing semantic happens yet — the tooltip says so instead of
	 * leaving an inert-looking control. */
	aiQueryTooShort?: boolean;
	aiMinQueryLength?: number;
	/** "More filters" disclosure state (owned by the container). */
	moreExpanded: boolean;
	onToggleMore: () => void;
	moreCount: number;
	/** Optional slot, e.g. the Review Center inbox. */
	inbox?: React.ReactNode;
	/** Optional slot rendered at the right of the top bar (sort, history, …). */
	trailing?: React.ReactNode;
	/** Optional view switcher, sharing the result-count lane. */
	viewSwitcher?: React.ReactNode;
	/** Distinct project tags for the tag facet (empty until loaded / flag off). */
	tagOptions?: string[];
};

export function RoadmapFilterToolbarView({
	filters,
	onFiltersChange,
	onClearAll,
	onRemoveFilter,
	totalCount,
	filteredCount,
	hasActiveFilters,
	hiddenMatchCount = 0,
	onShowHidden,
	searchValue,
	onSearchValueChange,
	aiMode,
	onToggleAiMode,
	aiSearching = false,
	aiSearchError = false,
	aiCoverageNote = null,
	aiFallbackNote = null,
	aiQueryTooShort = false,
	aiMinQueryLength = 3,
	moreExpanded,
	onToggleMore,
	moreCount,
	inbox,
	trailing,
	viewSwitcher,
	tagOptions,
}: RoadmapFilterToolbarViewProps) {
	const searchInputId = useId();
	const moreId = useId();

	return (
		<div className="space-y-3">
			{/* Bar */}
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex w-full items-center gap-1.5 sm:max-w-xs">
					<div className="relative w-full">
						<label htmlFor={searchInputId} className="sr-only">
							Search work items
						</label>
						<SearchIcon
							aria-hidden
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<SearchInput
							id={searchInputId}
							value={searchValue}
							onChange={(e) =>
								onSearchValueChange(e.target.value)
							}
							placeholder="Search by title, ID, or keyword…"
							aria-label="Search roadmap items"
							className="h-8 pl-8"
						/>
					</div>
					{onToggleAiMode && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className={cn(
										"size-8 shrink-0",
										aiMode &&
											"border border-secondary/40 bg-secondary/10 text-secondary hover:bg-secondary/20",
									)}
									aria-pressed={aiMode}
									aria-label="AI semantic search"
									onClick={onToggleAiMode}
								>
									{aiSearching ? (
										<Loader2Icon
											aria-hidden
											className="size-4 motion-safe:animate-spin"
										/>
									) : (
										<SparklesIcon
											aria-hidden
											className="size-4"
										/>
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{aiQueryTooShort
									? `Type at least ${aiMinQueryLength} characters for AI search to kick in`
									: "AI search — find work items by meaning, not exact words"}
							</TooltipContent>
						</Tooltip>
					)}
				</div>
				<div className="flex items-center gap-2">
					{inbox}
					{trailing}
				</div>
			</div>

			{/* Filter region — light hairline frame, not a heavy filled card */}
			<div className="space-y-3 border-border/60 border-y py-3">
				<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
					<RoadmapFiltersPanel
						tier="primary"
						filters={filters}
						onChange={onFiltersChange}
					/>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-expanded={moreExpanded}
						aria-controls={moreId}
						onClick={onToggleMore}
						className="h-7 shrink-0 px-2 text-muted-foreground text-xs hover:text-foreground"
					>
						More filters
						{moreCount > 0 && (
							<Badge
								variant="secondary"
								className="ml-1.5 rounded-sm px-1 font-normal tabular-nums"
							>
								{moreCount}
							</Badge>
						)}
						<ChevronDownIcon
							aria-hidden
							className={cn(
								"ml-1 size-3.5 transition-transform",
								moreExpanded && "rotate-180",
							)}
						/>
					</Button>
				</div>

				{moreExpanded && (
					<div
						id={moreId}
						className="border-border/50 border-t pt-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
					>
						<RoadmapFiltersPanel
							tier="more"
							filters={filters}
							onChange={onFiltersChange}
							tagOptions={tagOptions}
						/>
					</div>
				)}
			</div>

			{/* Active chips */}
			<RoadmapFilterChips
				filters={filters}
				onRemoveFilter={onRemoveFilter}
				onClearAll={onClearAll}
			/>

			{/* Result count, and — when the roadmap offers one — the view switcher
			    sharing its lane. They belong together: the switcher chooses which
			    view of the counted set you get, so putting it here keeps "what am
			    I looking at" and "how much of it is there" on one line instead of
			    spending a whole band of vertical space on each.
			    `flex-wrap` + `justify-between`: on a narrow viewport the count
			    drops below the switcher rather than squeezing it. */}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				{viewSwitcher ?? <span />}
				<div className="flex flex-wrap items-center gap-x-3">
					{/* Announces search progress to screen readers. Persistent on
					    purpose: a live region that mounts only when loading starts
					    is missed by most screen readers — the text CHANGE is what
					    gets announced. */}
					<span aria-live="polite" className="sr-only">
						{aiSearching ? "Searching results…" : ""}
					</span>
					<ResultCount
						totalCount={totalCount}
						filteredCount={filteredCount}
						hasActiveFilters={hasActiveFilters}
						hiddenMatchCount={hiddenMatchCount}
						onShowHidden={onShowHidden}
					/>
					{/* Announced to screen readers (4.1.3 Status Messages); amber
					    token needs its -foreground pair for AA contrast in light
					    theme (mirrors AiUsageLimitBanner). */}
					{aiSearchError && (
						<span
							role="status"
							className="text-highlight-foreground text-xs normal-case tracking-normal dark:text-highlight"
						>
							AI search failed — showing keyword results.
						</span>
					)}
					{aiCoverageNote && !aiSearchError && (
						<span className="text-muted-foreground text-xs normal-case tracking-normal">
							{aiCoverageNote}
						</span>
					)}
					{aiFallbackNote && !aiSearchError && !aiCoverageNote && (
						<span
							role="status"
							className="text-muted-foreground text-xs normal-case tracking-normal"
						>
							{aiFallbackNote}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
