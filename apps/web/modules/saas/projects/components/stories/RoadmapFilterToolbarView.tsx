"use client";

/**
 * Presentational layout for the roadmap filter toolbar. Search debounce and the
 * More filters disclosure live in RoadmapFilterToolbar; this view receives their
 * values and handlers. It can therefore render without oRPC or tenant context.
 *
 * Search, AI search, fixed-width primary facets and More/Fewer filters share one
 * wrapping row. Secondary facets and Dates expand below it, followed by active
 * chips and Clear all, which stay available when the extra controls collapse.
 *
 * Results, lane counts, hidden matches, sort and View share a wrapping row.
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
	ChevronUpIcon,
	EyeIcon,
	Loader2Icon,
	SearchIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import type { RoadmapFilters } from "../../lib/roadmap-filters";
import { RoadmapFilterChips } from "./RoadmapFilterChips";
import { RoadmapFiltersPanel } from "./RoadmapFiltersPanel";

function ResultCount({
	lanesCount,
	totalCount,
	filteredCount,
	hasActiveFilters,
	hiddenMatchCount,
	onShowHidden,
	bodyMatchCount,
	bodyMatchesShown,
	onToggleBodyMatches,
}: {
	lanesCount?: number;
	totalCount: number;
	filteredCount: number;
	hasActiveFilters: boolean;
	hiddenMatchCount: number;
	/** Matches the search reaches only through description text, held back so
	 * the list stays as short as the names the query actually hit. */
	bodyMatchCount: number;
	bodyMatchesShown: boolean;
	onToggleBodyMatches?: () => void;
	/** When set, the hidden-match count becomes a button that reveals the
	 * hidden items (activates the Show-hidden eye toggle). */
	onShowHidden?: () => void;
}) {
	const t = useTranslations("projects.stories.roadmapUi");
	return (
		<span className="text-muted-foreground text-sm tabular-nums">
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
			{lanesCount !== undefined
				? ` · ${t("lanes", { count: lanesCount })}`
				: null}
			{/* Companion HIDDEN-match count, right beside the main count. When a
			    reveal handler is wired it becomes a button that activates the
			    Show-hidden eye toggle. */}
			{hiddenMatchCount > 0 && (
				<>
					{" "}
					·{" "}
					{onShowHidden ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="link"
									size="sm"
									onClick={onShowHidden}
									className="h-auto gap-1 p-0 font-normal text-muted-foreground"
								>
									{t("showHiddenCount", {
										count: hiddenMatchCount,
									})}
									<EyeIcon aria-hidden className="size-3" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("showHiddenHelp", {
									count: hiddenMatchCount,
								})}
							</TooltipContent>
						</Tooltip>
					) : (
						<span>
							{t("hiddenCount", { count: hiddenMatchCount })}
						</span>
					)}
				</>
			)}

			{/* Companion DESCRIPTION-match count. Relevance ranking sorts name
			    matches to the top but still listed every description hit, so a
			    common word returned a long unrelated tail. Those rows are held
			    back here and stay one click away. */}
			{bodyMatchCount > 0 && onToggleBodyMatches && (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={onToggleBodyMatches}
							aria-expanded={bodyMatchesShown}
							data-testid="roadmap-body-match-toggle"
							className="inline-flex items-center gap-1 rounded font-normal normal-case tracking-normal text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{bodyMatchesShown ? (
								<>
									· hide {bodyMatchCount} description{" "}
									{bodyMatchCount === 1 ? "match" : "matches"}
									<ChevronUpIcon
										aria-hidden
										className="size-3"
									/>
								</>
							) : (
								<>
									· {bodyMatchCount} more{" "}
									{bodyMatchCount === 1 ? "matches" : "match"}{" "}
									in description
									<ChevronDownIcon
										aria-hidden
										className="size-3"
									/>
								</>
							)}
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{bodyMatchesShown
							? "Show only work items whose name matches your search"
							: `Also show ${bodyMatchCount} work ${bodyMatchCount === 1 ? "item" : "items"} that match only in their description`}
					</TooltipContent>
				</Tooltip>
			)}
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
	bodyMatchCount?: number;
	bodyMatchesShown?: boolean;
	onToggleBodyMatches?: () => void;
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
	/** View and sort controls beside the results summary. */
	trailing?: React.ReactNode;
	/** Lane count, present only for grouped layouts. */
	lanesCount?: number;
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
	bodyMatchCount = 0,
	bodyMatchesShown = false,
	onToggleBodyMatches,
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
	trailing,
	lanesCount,
	tagOptions,
}: RoadmapFilterToolbarViewProps) {
	const t = useTranslations("projects.stories.roadmapUi");
	const searchInputId = useId();
	const moreId = useId();

	return (
		<div className="space-y-2">
			{/* Bar */}
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex min-w-0 flex-1 basis-80 items-center gap-1.5 sm:min-w-80">
					<div className="relative min-w-0 flex-1">
						<label htmlFor={searchInputId} className="sr-only">
							{t("searchLabel")}
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
							placeholder={t("searchPlaceholder")}
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
					{t(moreExpanded ? "fewerFilters" : "moreFilters")}
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
					className="border-border/50 border-t pt-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
				>
					<RoadmapFiltersPanel
						tier="more"
						filters={filters}
						onChange={onFiltersChange}
						tagOptions={tagOptions}
					/>
				</div>
			)}

			{/* Active chips */}
			<RoadmapFilterChips
				filters={filters}
				onRemoveFilter={onRemoveFilter}
				onClearAll={onClearAll}
			/>

			<div
				data-testid="roadmap-results-row"
				className="flex flex-wrap items-center justify-between gap-2"
			>
				<div className="flex flex-wrap items-center gap-x-3">
					{/* Announces search progress to screen readers. Persistent on
					    purpose: a live region that mounts only when loading starts
					    is missed by most screen readers — the text CHANGE is what
					    gets announced. */}
					<span aria-live="polite" className="sr-only">
						{aiSearching ? "Searching results…" : ""}
					</span>
					<ResultCount
						lanesCount={lanesCount}
						totalCount={totalCount}
						filteredCount={filteredCount}
						hasActiveFilters={hasActiveFilters}
						hiddenMatchCount={hiddenMatchCount}
						bodyMatchCount={bodyMatchCount}
						bodyMatchesShown={bodyMatchesShown}
						onToggleBodyMatches={onToggleBodyMatches}
						onShowHidden={onShowHidden}
					/>
					{/* Announced to screen readers (4.1.3 Status Messages); amber
					    token needs its -foreground pair for AA contrast in light
					    theme (mirrors AiUsageLimitBanner). */}
					{aiSearchError && (
						<output className="text-highlight-ink text-xs normal-case tracking-normal">
							AI search failed — showing keyword results.
						</output>
					)}
					{aiCoverageNote && !aiSearchError && (
						<span className="text-muted-foreground text-xs normal-case tracking-normal">
							{aiCoverageNote}
						</span>
					)}
					{aiFallbackNote && !aiSearchError && !aiCoverageNote && (
						<output className="text-muted-foreground text-xs normal-case tracking-normal">
							{aiFallbackNote}
						</output>
					)}
				</div>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					{trailing}
				</div>
			</div>
		</div>
	);
}
