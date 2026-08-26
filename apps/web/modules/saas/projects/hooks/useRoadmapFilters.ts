"use client";

import {
	parseAsArrayOf,
	parseAsBoolean,
	parseAsString,
	parseAsStringEnum,
	useQueryStates,
} from "nuqs";
import { useCallback, useMemo } from "react";
import {
	FILTERABLE_KINDS,
	FILTERABLE_PRIORITIES,
	FILTERABLE_SIZES,
	FILTERABLE_SOURCES,
	FILTERABLE_STAGES,
	FILTERABLE_SYNC_STATUSES,
	hasActiveRoadmapFilters,
	RECENCY_WINDOW_OPTIONS,
	type RecencyWindowDays,
	type RoadmapFilters,
	type StorySize,
	type StorySource,
	type SyncFilter,
} from "../lib/roadmap-filters";
import type {
	MaturationStatus,
	StoryKind,
	StoryPriority,
} from "../lib/stories/types";
import { computeTagsRemovalPatch } from "./tags-filter-patch";

const filterParsers = {
	q: parseAsString.withDefault(""),
	// AI search mode toggle (Fizzy #1937) — a MODE, not a filter facet: it
	// changes how `q` is matched (semantic vs keyword), so it deliberately
	// stays OUT of `RoadmapFilters` and the pure filter/sort functions. Exposed
	// separately below; `clearAll` resets it like every other control.
	aiSearch: parseAsBoolean.withDefault(false),
	kind: parseAsArrayOf(
		parseAsStringEnum<StoryKind>([...FILTERABLE_KINDS]),
	).withDefault([]),
	priority: parseAsArrayOf(
		parseAsStringEnum<StoryPriority>([...FILTERABLE_PRIORITIES]),
	).withDefault([]),
	stage: parseAsArrayOf(
		parseAsStringEnum<MaturationStatus>([...FILTERABLE_STAGES]),
	).withDefault([]),
	sync: parseAsArrayOf(
		parseAsStringEnum<SyncFilter>([...FILTERABLE_SYNC_STATUSES]),
	).withDefault([]),
	source: parseAsArrayOf(
		parseAsStringEnum<StorySource>([...FILTERABLE_SOURCES]),
	).withDefault([]),
	size: parseAsArrayOf(
		parseAsStringEnum<StorySize>([...FILTERABLE_SIZES]),
	).withDefault([]),
	tags: parseAsArrayOf(parseAsString).withDefault([]),
	tagsLogic: parseAsStringEnum(["AND", "OR"]).withDefault("OR"),
	createdFrom: parseAsString,
	createdTo: parseAsString,
	updatedFrom: parseAsString,
	updatedTo: parseAsString,
	syncedFrom: parseAsString,
	syncedTo: parseAsString,
	missingAc: parseAsBoolean.withDefault(false),
	missingDesc: parseAsBoolean.withDefault(false),
	duplicatesOnly: parseAsBoolean.withDefault(false),
	needsMoreInfo: parseAsBoolean.withDefault(false),
	blocked: parseAsBoolean.withDefault(false),
	hiddenOnly: parseAsBoolean.withDefault(false),
	recentlyApproved: parseAsStringEnum<`${RecencyWindowDays}`>(
		RECENCY_WINDOW_OPTIONS.map((n) => String(n) as `${RecencyWindowDays}`),
	),
	recentlyChanged: parseAsStringEnum<`${RecencyWindowDays}`>(
		RECENCY_WINDOW_OPTIONS.map((n) => String(n) as `${RecencyWindowDays}`),
	),
	recentlyAdded: parseAsStringEnum<`${RecencyWindowDays}`>(
		RECENCY_WINDOW_OPTIONS.map((n) => String(n) as `${RecencyWindowDays}`),
	),
};

export type RoadmapFilterKey = keyof RoadmapFilters;

export function useRoadmapFilters() {
	const [state, setState] = useQueryStates(filterParsers, {
		history: "replace",
		clearOnDefault: true,
	});

	const filters: RoadmapFilters = useMemo(
		() => ({
			q: state.q,
			kind: state.kind,
			priority: state.priority,
			stage: state.stage,
			sync: state.sync,
			source: state.source,
			size: state.size,
			tags: state.tags,
			tagsLogic: state.tagsLogic,
			createdFrom: state.createdFrom,
			createdTo: state.createdTo,
			updatedFrom: state.updatedFrom,
			updatedTo: state.updatedTo,
			syncedFrom: state.syncedFrom,
			syncedTo: state.syncedTo,
			missingAc: state.missingAc,
			missingDesc: state.missingDesc,
			duplicatesOnly: state.duplicatesOnly,
			needsMoreInfo: state.needsMoreInfo,
			blocked: state.blocked,
			hiddenOnly: state.hiddenOnly,
			recentlyApproved: state.recentlyApproved
				? (Number(state.recentlyApproved) as RecencyWindowDays)
				: null,
			recentlyChanged: state.recentlyChanged
				? (Number(state.recentlyChanged) as RecencyWindowDays)
				: null,
			recentlyAdded: state.recentlyAdded
				? (Number(state.recentlyAdded) as RecencyWindowDays)
				: null,
		}),
		[state],
	);

	const setFilters = useCallback(
		(next: Partial<RoadmapFilters>) => {
			const patch: Record<string, unknown> = { ...next };
			if ("recentlyApproved" in next) {
				patch.recentlyApproved =
					next.recentlyApproved === null
						? null
						: String(next.recentlyApproved);
			}
			if ("recentlyChanged" in next) {
				patch.recentlyChanged =
					next.recentlyChanged === null
						? null
						: String(next.recentlyChanged);
			}
			if ("recentlyAdded" in next) {
				patch.recentlyAdded =
					next.recentlyAdded === null
						? null
						: String(next.recentlyAdded);
			}
			setState(patch);
		},
		[setState],
	);

	const clearAll = useCallback(() => {
		setState({
			q: "",
			aiSearch: false,
			kind: [],
			priority: [],
			stage: [],
			sync: [],
			source: [],
			size: [],
			tags: [],
			tagsLogic: "OR",
			createdFrom: null,
			createdTo: null,
			updatedFrom: null,
			updatedTo: null,
			syncedFrom: null,
			syncedTo: null,
			missingAc: false,
			missingDesc: false,
			duplicatesOnly: false,
			needsMoreInfo: false,
			blocked: false,
			hiddenOnly: false,
			recentlyApproved: null,
			recentlyChanged: null,
			recentlyAdded: null,
		});
	}, [setState]);

	const removeFilter = useCallback(
		(key: RoadmapFilterKey, value?: string) => {
			switch (key) {
				case "q":
					setState({ q: "" });
					return;
				case "kind":
					setState({
						kind: value
							? filters.kind.filter((k) => k !== value)
							: [],
					});
					return;
				case "priority":
					setState({
						priority: value
							? filters.priority.filter((p) => p !== value)
							: [],
					});
					return;
				case "stage":
					setState({
						stage: value
							? filters.stage.filter((s) => s !== value)
							: [],
					});
					return;
				case "sync":
					setState({
						sync: value
							? filters.sync.filter((s) => s !== value)
							: [],
					});
					return;
				case "source":
					setState({
						source: value
							? filters.source.filter((s) => s !== value)
							: [],
					});
					return;
				case "size":
					setState({
						size: value
							? filters.size.filter((s) => s !== value)
							: [],
					});
					return;
				case "tags": {
					const { tags, tagsLogic } = computeTagsRemovalPatch(
						filters.tags,
						value,
						filters.tagsLogic,
					);
					setState(
						tagsLogic === undefined
							? { tags }
							: { tags, tagsLogic },
					);
					return;
				}
				case "tagsLogic":
					setState({ tagsLogic: "OR" });
					return;
				case "createdFrom":
				case "createdTo":
				case "updatedFrom":
				case "updatedTo":
				case "syncedFrom":
				case "syncedTo":
					setState({ [key]: null });
					return;
				case "missingAc":
					setState({ missingAc: false });
					return;
				case "missingDesc":
					setState({ missingDesc: false });
					return;
				case "duplicatesOnly":
					setState({ duplicatesOnly: false });
					return;
				case "needsMoreInfo":
					setState({ needsMoreInfo: false });
					return;
				case "blocked":
					setState({ blocked: false });
					return;
				case "hiddenOnly":
					setState({ hiddenOnly: false });
					return;
				case "recentlyApproved":
					setState({ recentlyApproved: null });
					return;
				case "recentlyChanged":
					setState({ recentlyChanged: null });
					return;
				case "recentlyAdded":
					setState({ recentlyAdded: null });
					return;
			}
		},
		[
			setState,
			filters.kind,
			filters.priority,
			filters.stage,
			filters.sync,
			filters.source,
			filters.size,
			filters.tags,
		],
	);

	const isActive = useMemo(() => hasActiveRoadmapFilters(filters), [filters]);

	const setAiSearch = useCallback(
		(on: boolean) => {
			setState({ aiSearch: on });
		},
		[setState],
	);

	return {
		filters,
		setFilters,
		clearAll,
		removeFilter,
		isActive,
		aiSearch: state.aiSearch,
		setAiSearch,
	};
}
