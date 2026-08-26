"use client";

/**
 * RoadmapFilterChips
 *
 * Removable chip row showing every currently-applied roadmap filter (except
 * the free-text search, which lives in its always-visible input). Lets the
 * user unstick a single dimension without reopening the Filters panel. Mirrors
 * the on-brand `AuditLogActivePills` pattern: outline badge with a muted
 * dimension label, the value, and an accessible dismiss button.
 *
 * Returns null when no filters are active, so callers can render it
 * unconditionally.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { XIcon } from "lucide-react";
import {
	type RoadmapFilters,
	STORY_KIND_LABELS,
	STORY_SIZE_LABELS,
	STORY_SOURCE_LABELS,
} from "../../lib/roadmap-filters";
import {
	DRAFTING_STAGE_META,
	getPriorityLabel,
	MATURATION_STATUS_META,
} from "../../lib/stories/types";

const SYNC_LABELS: Record<"synced" | "unsynced", string> = {
	synced: "Synced",
	unsynced: "Unsynced",
};

type Chip = {
	key: string;
	label: string | null;
	value: string;
	ariaRemoveLabel: string;
	onRemove: () => void;
};

export type RoadmapFilterChipsProps = {
	filters: RoadmapFilters;
	onRemoveFilter: (key: keyof RoadmapFilters, value?: string) => void;
	/** Optional: renders a "Clear all" action at the end of the chip row. */
	onClearAll?: () => void;
};

function rangeValue(from: string | null, to: string | null): string {
	return `${from ?? "…"} – ${to ?? "…"}`;
}

export function RoadmapFilterChips({
	filters,
	onRemoveFilter,
	onClearAll,
}: RoadmapFilterChipsProps) {
	const chips: Chip[] = [];

	for (const value of filters.kind) {
		const label = STORY_KIND_LABELS[value];
		chips.push({
			key: `kind-${value}`,
			label: "Type",
			value: label,
			ariaRemoveLabel: `Remove type ${label} filter`,
			onRemove: () => onRemoveFilter("kind", value),
		});
	}
	for (const value of filters.priority) {
		const label = getPriorityLabel(value);
		chips.push({
			key: `priority-${value}`,
			label: "Priority",
			value: label,
			ariaRemoveLabel: `Remove priority ${label} filter`,
			onRemove: () => onRemoveFilter("priority", value),
		});
	}
	for (const value of filters.stage) {
		const label = MATURATION_STATUS_META[value].label;
		chips.push({
			key: `stage-${value}`,
			label: "Stage",
			value: label,
			ariaRemoveLabel: `Remove stage ${label} filter`,
			onRemove: () => onRemoveFilter("stage", value),
		});
	}
	// "Hidden" is the CLOSED stage, surfaced in the Stage facet on its own
	// boolean — show it as a Stage chip too so it reads + removes like the rest.
	if (filters.hiddenOnly) {
		chips.push({
			key: "hiddenOnly",
			label: "Stage",
			value: DRAFTING_STAGE_META.CLOSED.label,
			ariaRemoveLabel: "Remove hidden filter",
			onRemove: () => onRemoveFilter("hiddenOnly"),
		});
	}
	for (const value of filters.sync) {
		const label = SYNC_LABELS[value];
		chips.push({
			key: `sync-${value}`,
			label: "Sync",
			value: label,
			ariaRemoveLabel: `Remove sync ${label} filter`,
			onRemove: () => onRemoveFilter("sync", value),
		});
	}
	for (const value of filters.source) {
		const label = STORY_SOURCE_LABELS[value];
		chips.push({
			key: `source-${value}`,
			label: "Source",
			value: label,
			ariaRemoveLabel: `Remove source ${label} filter`,
			onRemove: () => onRemoveFilter("source", value),
		});
	}
	for (const value of filters.size) {
		const label = STORY_SIZE_LABELS[value];
		chips.push({
			key: `size-${value}`,
			label: "Size",
			value: label,
			ariaRemoveLabel: `Remove size ${label} filter`,
			onRemove: () => onRemoveFilter("size", value),
		});
	}
	for (const value of filters.tags) {
		chips.push({
			key: `tag-${value}`,
			label: "Tag",
			value,
			ariaRemoveLabel: `Remove tag ${value} filter`,
			onRemove: () => onRemoveFilter("tags", value),
		});
	}
	if (filters.tagsLogic === "AND" && filters.tags.length >= 2) {
		chips.push({
			key: "tags-logic",
			label: null,
			value: "All tags",
			ariaRemoveLabel: "Switch tag filter to ANY",
			// Reset ONLY the logic (AND→OR) — must NOT clear the selected tags.
			// Routes through removeFilter's `case "tagsLogic"` (Task 14), not the
			// value-less `case "tags"` clear-all path.
			onRemove: () => onRemoveFilter("tagsLogic"),
		});
	}
	if (filters.createdFrom || filters.createdTo) {
		chips.push({
			key: "created",
			label: "Created",
			value: rangeValue(filters.createdFrom, filters.createdTo),
			ariaRemoveLabel: "Remove created date filter",
			onRemove: () => {
				onRemoveFilter("createdFrom");
				onRemoveFilter("createdTo");
			},
		});
	}
	if (filters.updatedFrom || filters.updatedTo) {
		chips.push({
			key: "updated",
			label: "Updated",
			value: rangeValue(filters.updatedFrom, filters.updatedTo),
			ariaRemoveLabel: "Remove updated date filter",
			onRemove: () => {
				onRemoveFilter("updatedFrom");
				onRemoveFilter("updatedTo");
			},
		});
	}
	if (filters.syncedFrom || filters.syncedTo) {
		chips.push({
			key: "synced",
			label: "Synced",
			value: rangeValue(filters.syncedFrom, filters.syncedTo),
			ariaRemoveLabel: "Remove synced date filter",
			onRemove: () => {
				onRemoveFilter("syncedFrom");
				onRemoveFilter("syncedTo");
			},
		});
	}
	if (filters.missingDesc) {
		chips.push({
			key: "missingDesc",
			label: null,
			value: "Missing description",
			ariaRemoveLabel: "Remove missing-description filter",
			onRemove: () => onRemoveFilter("missingDesc"),
		});
	}
	if (filters.missingAc) {
		chips.push({
			key: "missingAc",
			label: null,
			value: "Missing AC",
			ariaRemoveLabel: "Remove missing-acceptance-criteria filter",
			onRemove: () => onRemoveFilter("missingAc"),
		});
	}
	if (filters.duplicatesOnly) {
		chips.push({
			key: "duplicatesOnly",
			label: null,
			value: "Possible duplicates",
			ariaRemoveLabel: "Remove possible-duplicates filter",
			onRemove: () => onRemoveFilter("duplicatesOnly"),
		});
	}
	if (filters.needsMoreInfo) {
		chips.push({
			key: "needsMoreInfo",
			label: null,
			value: "Needs more info",
			ariaRemoveLabel: "Remove needs-more-info filter",
			onRemove: () => onRemoveFilter("needsMoreInfo"),
		});
	}
	if (filters.blocked) {
		chips.push({
			key: "blocked",
			label: null,
			value: "Blocked",
			ariaRemoveLabel: "Remove blocked filter",
			onRemove: () => onRemoveFilter("blocked"),
		});
	}
	if (filters.recentlyApproved !== null) {
		chips.push({
			key: "recentlyApproved",
			label: "Approved",
			value: `last ${filters.recentlyApproved}d`,
			ariaRemoveLabel: "Remove recently-approved filter",
			onRemove: () => onRemoveFilter("recentlyApproved"),
		});
	}
	if (filters.recentlyAdded !== null) {
		chips.push({
			key: "recentlyAdded",
			label: "Added",
			value: `last ${filters.recentlyAdded}d`,
			ariaRemoveLabel: "Remove recently-added filter",
			onRemove: () => onRemoveFilter("recentlyAdded"),
		});
	}
	if (filters.recentlyChanged !== null) {
		chips.push({
			key: "recentlyChanged",
			label: "Modified",
			value: `last ${filters.recentlyChanged}d`,
			ariaRemoveLabel: "Remove date-modified filter",
			onRemove: () => onRemoveFilter("recentlyChanged"),
		});
	}

	if (chips.length === 0) {
		return null;
	}

	return (
		<section
			aria-label="Active filters"
			className="flex flex-wrap items-center gap-1.5"
		>
			{chips.map((chip) => (
				<Badge
					key={chip.key}
					variant="outline"
					className="gap-1.5 py-1 pr-1 pl-2 font-normal"
				>
					{chip.label && (
						<span className="text-muted-foreground">
							{chip.label}:
						</span>
					)}
					<span className="text-foreground">{chip.value}</span>
					<button
						type="button"
						aria-label={chip.ariaRemoveLabel}
						onClick={chip.onRemove}
						className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					>
						<XIcon aria-hidden className="size-3" />
					</button>
				</Badge>
			))}
			{onClearAll && (
				<Button
					variant="ghost"
					size="sm"
					onClick={onClearAll}
					className="ml-0.5 h-7 px-2 text-muted-foreground text-xs"
				>
					Clear all
				</Button>
			)}
		</section>
	);
}
