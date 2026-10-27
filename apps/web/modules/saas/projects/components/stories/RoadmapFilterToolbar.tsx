"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
	activeMoreFilterCount,
	type RoadmapFilters,
} from "../../lib/roadmap-filters";
import { RoadmapFilterToolbarView } from "./RoadmapFilterToolbarView";

// The "More filters" disclosure open/closed state persists per browser; the
// primary facets are always inline and filter selections live in the URL.
const MORE_FILTERS_STORAGE_KEY = "fabric:roadmap-more-filters-open";

export type RoadmapFilterToolbarProps = {
	filters: RoadmapFilters;
	onFiltersChange: (next: Partial<RoadmapFilters>) => void;
	onClearAll: () => void;
	onRemoveFilter: (key: keyof RoadmapFilters, value?: string) => void;
	totalCount: number;
	filteredCount: number;
	hasActiveFilters: boolean;
	/** HIDDEN (closed) items matching the current view — shown beside the count. */
	hiddenMatchCount?: number;
	bodyMatchCount?: number;
	bodyMatchesShown?: boolean;
	onToggleBodyMatches?: () => void;
	/** Reveal the hidden matches (activates the Show-hidden eye toggle). */
	onShowHidden?: () => void;
	/** AI (semantic) search mode toggle — rendered beside the search input.
	 * Omitted when the feature flag is off. */
	aiMode?: boolean;
	onToggleAiMode?: () => void;
	aiSearching?: boolean;
	aiSearchError?: boolean;
	/** Partial-warm coverage note for AI search (null when fully warmed). */
	aiCoverageNote?: string | null;
	/** AI mode matched nothing semantic — keyword results are shown instead. */
	aiFallbackNote?: string | null;
	aiQueryTooShort?: boolean;
	aiMinQueryLength?: number;
	projectId: string;
	organizationId: string | null;
	lanesCount?: number;
	/** View and sort controls beside the results summary. */
	trailing?: React.ReactNode;
};

export function RoadmapFilterToolbar({
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
	aiMode,
	onToggleAiMode,
	aiSearching,
	aiSearchError,
	aiCoverageNote,
	aiFallbackNote,
	aiQueryTooShort,
	aiMinQueryLength,
	projectId,
	organizationId,
	lanesCount,
	trailing,
}: RoadmapFilterToolbarProps) {
	// "More filters" disclosure — defaults collapsed; remembered per browser.
	const [moreExpanded, setMoreExpanded] = useState(false);
	useEffect(() => {
		try {
			const stored = localStorage.getItem(MORE_FILTERS_STORAGE_KEY);
			if (stored !== null) {
				setMoreExpanded(stored === "1");
			}
		} catch {
			// localStorage unavailable (SSR / private mode) — keep default.
		}
	}, []);
	const onToggleMore = useCallback(() => {
		setMoreExpanded((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(
					MORE_FILTERS_STORAGE_KEY,
					next ? "1" : "0",
				);
			} catch {}
			return next;
		});
	}, []);

	// Local state mirrors filters.q so typing feels immediate while we debounce
	// the URL/state write.
	const [searchDraft, setSearchDraft] = useState(filters.q);
	useEffect(() => {
		setSearchDraft(filters.q);
	}, [filters.q]);
	useEffect(() => {
		if (searchDraft === filters.q) {
			return;
		}
		const handle = setTimeout(() => {
			onFiltersChange({ q: searchDraft });
		}, 200);
		return () => clearTimeout(handle);
	}, [searchDraft, filters.q, onFiltersChange]);

	const tagOptionsQuery = useQuery(
		orpc.projects.stories.tags.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const tagOptions = tagOptionsQuery.data?.tags ?? [];

	return (
		<RoadmapFilterToolbarView
			filters={filters}
			onFiltersChange={onFiltersChange}
			onClearAll={onClearAll}
			onRemoveFilter={onRemoveFilter}
			totalCount={totalCount}
			filteredCount={filteredCount}
			hasActiveFilters={hasActiveFilters}
			hiddenMatchCount={hiddenMatchCount}
			bodyMatchCount={bodyMatchCount}
			bodyMatchesShown={bodyMatchesShown}
			onToggleBodyMatches={onToggleBodyMatches}
			onShowHidden={onShowHidden}
			aiMode={aiMode}
			onToggleAiMode={onToggleAiMode}
			aiSearching={aiSearching}
			aiSearchError={aiSearchError}
			aiCoverageNote={aiCoverageNote}
			aiFallbackNote={aiFallbackNote}
			aiQueryTooShort={aiQueryTooShort}
			aiMinQueryLength={aiMinQueryLength}
			searchValue={searchDraft}
			onSearchValueChange={setSearchDraft}
			moreExpanded={moreExpanded}
			onToggleMore={onToggleMore}
			moreCount={activeMoreFilterCount(filters)}
			trailing={trailing}
			lanesCount={lanesCount}
			tagOptions={tagOptions}
		/>
	);
}
