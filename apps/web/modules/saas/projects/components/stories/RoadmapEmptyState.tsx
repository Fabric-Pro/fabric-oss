import { Button } from "@ui/components/button";
import { FilterXIcon } from "lucide-react";
import {
	activeFilterGroupCount,
	type RoadmapFilters,
} from "../../lib/roadmap-filters";

type Props = {
	filters: RoadmapFilters;
	onClearFilters: () => void;
	/** AI (semantic) search is active — the no-results copy explains what
	 * semantic matching did and offers the keyword fallback (Fizzy #1937). */
	aiMode?: boolean;
	/** Turns AI mode OFF while KEEPING the typed query, so the advice in the
	 * empty-state copy ("switch off AI search to match exact keywords") has a
	 * control that does exactly that. Absent when AI mode is off. */
	onDisableAiMode?: () => void;
};

function pickHint(filters: RoadmapFilters): string {
	const hasSyncDateRange =
		filters.syncedFrom !== null || filters.syncedTo !== null;
	if (hasSyncDateRange) {
		// Mirror the `syncOnlyUnsynced` shape in applyRoadmapFilters — uses
		// `.every()` so `?sync=unsynced,unsynced` URLs behave identically.
		const syncOnlyUnsynced =
			filters.sync.length > 0 &&
			filters.sync.every((s) => s === "unsynced");
		if (syncOnlyUnsynced) {
			return "The Synced date range only applies when Synced is in the Sync Status filter. Clear the date range or include Synced to see results.";
		}
		// Both buckets selected (Unsynced alongside Synced): the range
		// still applies, so unsynced rows are silently dropped. Surface
		// that so the user understands why.
		if (filters.sync.includes("unsynced")) {
			return "Unsynced items don't have a sync date, so the Synced date range excludes them. Remove Unsynced from the Sync Status filter, or clear the date range, to see all matches.";
		}
	}
	return "No work items match these filters.";
}

export function RoadmapEmptyState({
	filters,
	onClearFilters,
	aiMode,
	onDisableAiMode,
}: Props) {
	// Facet filters still apply on top of semantic results, so an empty AI-mode
	// list can mean "nothing similar" OR "matches existed but a facet excluded
	// them" — attribute the emptiness truthfully.
	const facetsActive = activeFilterGroupCount(filters) > 0;
	const hint = !aiMode
		? pickHint(filters)
		: facetsActive
			? "No work items match this search together with your current filters. Try rephrasing the query, or remove a filter."
			: "No work items are semantically similar to this search. Try rephrasing it in different words, or switch off AI search to match exact keywords.";
	return (
		<div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
			<div
				aria-hidden
				className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
			>
				<FilterXIcon className="size-5" />
			</div>
			<p className="max-w-sm text-pretty text-muted-foreground text-sm">
				{hint}
			</p>
			<div className="flex items-center gap-2">
				{aiMode && onDisableAiMode && (
					<Button
						variant="outline"
						size="sm"
						onClick={onDisableAiMode}
					>
						Turn off AI search
					</Button>
				)}
				<Button variant="outline" size="sm" onClick={onClearFilters}>
					Clear filters
				</Button>
			</div>
		</div>
	);
}
