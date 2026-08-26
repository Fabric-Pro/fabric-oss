import { storySemanticActivityAt } from "@repo/database/prisma/queries/projects/story-semantic-activity";
import { STORY_SOURCE_LABELS } from "./roadmap-filters";
import {
	getMaturationStatus,
	type MaturationStatus,
	type StoryPriority,
	type UserStory,
} from "./stories/types";

export type RoadmapSortKey =
	| "roadmapOrder"
	| "priority"
	| "updated"
	| "created"
	| "sync"
	| "stage"
	| "source"
	| "recentlyApproved";

export type RoadmapSortDirection = "asc" | "desc";

export type RoadmapSort = {
	key: RoadmapSortKey;
	direction: RoadmapSortDirection;
};

export const SORT_KEY_LABELS: Record<RoadmapSortKey, string> = {
	roadmapOrder: "Roadmap order",
	priority: "Priority",
	updated: "Last updated",
	created: "Created date",
	sync: "Sync status",
	stage: "Maturity stage",
	source: "Source",
	recentlyApproved: "Recently approved",
};

export const SORT_KEY_DEFAULT_DIRECTIONS: Record<
	RoadmapSortKey,
	RoadmapSortDirection
> = {
	roadmapOrder: "asc",
	priority: "asc",
	updated: "desc",
	created: "desc",
	sync: "asc",
	stage: "asc",
	source: "asc",
	recentlyApproved: "desc",
};

export const DEFAULT_ROADMAP_SORT: RoadmapSort = {
	key: "roadmapOrder",
	direction: "asc",
};

/**
 * Validate a persisted/loaded sort value (from the DB `roadmapView` JSON column
 * or the localStorage cache) into a usable {@link RoadmapSort}. An unknown key
 * (e.g. a deprecated column), an invalid direction, or a missing/malformed value
 * silently degrades to {@link DEFAULT_ROADMAP_SORT} — a stale saved preference
 * must never surface an error (card #1704, AC-4 + AC-6).
 */
export function coerceSort(raw: unknown): RoadmapSort {
	if (raw && typeof raw === "object") {
		const { key, direction } = raw as {
			key?: unknown;
			direction?: unknown;
		};
		const keyOk = typeof key === "string" && key in SORT_KEY_LABELS;
		const dirOk = direction === "asc" || direction === "desc";
		if (keyOk && dirOk) {
			return {
				key: key as RoadmapSortKey,
				direction: direction as RoadmapSortDirection,
			};
		}
	}
	return DEFAULT_ROADMAP_SORT;
}

export const SORT_KEYS_REQUIRING_FLAT_LIST: ReadonlySet<RoadmapSortKey> =
	new Set([
		"updated",
		"created",
		"sync",
		"stage",
		"source",
		"recentlyApproved",
	]);

const PRIORITY_RANK: Record<StoryPriority, number> = {
	P0_CRITICAL: 0,
	P1_HIGH: 1,
	P2_MEDIUM: 2,
	P3_LOW: 3,
};

const MATURATION_STAGE_RANK: Record<MaturationStatus | "CLOSED", number> = {
	TO_DO: 0,
	DISCOVERY: 1,
	DONE: 2,
	CLOSED: 3,
};

/** Per-user manual order: `{ storyId: order }`. When present it overrides the
 * shared `story.roadmapOrder` for that story, so each user's drag-to-reorder
 * sequence is personal while unplaced stories keep the shared default. */
export type RoadmapStoryOrderMap = Record<string, number>;

function compareForKey(
	a: UserStory,
	b: UserStory,
	key: RoadmapSortKey,
	orderMap?: RoadmapStoryOrderMap,
): number {
	switch (key) {
		case "roadmapOrder": {
			const oa = orderMap?.[a.id] ?? a.roadmapOrder;
			const ob = orderMap?.[b.id] ?? b.roadmapOrder;
			return oa - ob;
		}
		case "priority":
			return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
		case "updated":
			// The card's own timestamp reads `lastEditedAt ?? createdAt`, so the
			// sort has to rank on the same value. Ranking on `lastEditedAt`
			// alone and parking never-edited rows at the end put a card showing
			// "2 days ago" below one showing "3 months ago", which reads as a
			// broken control rather than as a deliberate absence.
			return (
				storySemanticActivityAt(a).getTime() -
				storySemanticActivityAt(b).getTime()
			);
		case "created":
			return a.createdAt.getTime() - b.createdAt.getTime();
		case "sync":
			return (a.externalId ? 1 : 0) - (b.externalId ? 1 : 0);
		case "stage":
			return (
				MATURATION_STAGE_RANK[
					a.draftingStage === "CLOSED"
						? "CLOSED"
						: getMaturationStatus(a)
				] -
				MATURATION_STAGE_RANK[
					b.draftingStage === "CLOSED"
						? "CLOSED"
						: getMaturationStatus(b)
				]
			);
		case "source": {
			const labelA = STORY_SOURCE_LABELS[a.source] ?? a.source;
			const labelB = STORY_SOURCE_LABELS[b.source] ?? b.source;
			return labelA.localeCompare(labelB);
		}
		case "recentlyApproved": {
			const tsA = a.draftingStageUpdatedAt?.getTime();
			const tsB = b.draftingStageUpdatedAt?.getTime();
			if (tsA === undefined && tsB === undefined) {
				return 0;
			}
			if (tsA === undefined) {
				return 1;
			}
			if (tsB === undefined) {
				return -1;
			}
			return tsA - tsB;
		}
	}
}

export function compareStoriesBy(
	sort: RoadmapSort,
	orderMap?: RoadmapStoryOrderMap,
) {
	return (a: UserStory, b: UserStory): number => {
		const primary = compareForKey(a, b, sort.key, orderMap);
		const directed = sort.direction === "desc" ? -primary : primary;
		if (directed !== 0) {
			if (sort.key === "recentlyApproved" && sort.direction === "desc") {
				const aNull = (a.draftingStageUpdatedAt ?? null) === null;
				const bNull = (b.draftingStageUpdatedAt ?? null) === null;
				if (aNull && !bNull) {
					return 1;
				}
				if (!aNull && bNull) {
					return -1;
				}
			}
			return directed;
		}
		return a.id.localeCompare(b.id);
	};
}
