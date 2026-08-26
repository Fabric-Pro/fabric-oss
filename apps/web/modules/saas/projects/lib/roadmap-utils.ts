import type { UserStory } from "./stories/types";

export const PRIORITY_SECTIONS = [
	{ priority: "P0_CRITICAL" as const, label: "Critical", color: "#EF4444" },
	{ priority: "P1_HIGH" as const, label: "High", color: "#F97316" },
	{ priority: "P2_MEDIUM" as const, label: "Medium", color: "#EAB308" },
	{ priority: "P3_LOW" as const, label: "Low", color: "#22C55E" },
] as const;

export type PriorityKey = (typeof PRIORITY_SECTIONS)[number]["priority"];

// Deterministic comparator: roadmapOrder, then id. CUIDs are time-ordered,
// so the id fallback also approximates "oldest first" when two stories
// collide via the Read Committed max+1 race in updateStory.
function compareRoadmap(a: UserStory, b: UserStory): number {
	const d = a.roadmapOrder - b.roadmapOrder;
	if (d !== 0) {
		return d;
	}
	// Locale-free string comparison: deterministic across environments and runtimes.
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function groupStoriesByPriority(
	stories: UserStory[],
	showClosed = false,
): Record<PriorityKey, UserStory[]> {
	const filtered = stories.filter(
		(s) =>
			s.draftingStage !== "DECLINED" &&
			(showClosed || s.draftingStage !== "CLOSED"),
	);
	return {
		P0_CRITICAL: filtered
			.filter((s) => s.priority === "P0_CRITICAL")
			.sort(compareRoadmap),
		P1_HIGH: filtered
			.filter((s) => s.priority === "P1_HIGH")
			.sort(compareRoadmap),
		P2_MEDIUM: filtered
			.filter((s) => s.priority === "P2_MEDIUM")
			.sort(compareRoadmap),
		P3_LOW: filtered
			.filter((s) => s.priority === "P3_LOW")
			.sort(compareRoadmap),
	};
}

export function isSameBucket(
	sourcePriority: string,
	targetPriority: string,
): boolean {
	return sourcePriority === targetPriority;
}

export function computeCrossBucketReorder(
	sortedStories: UserStory[],
	movedStoryId: string,
	targetPriority: PriorityKey,
	overStoryId: string,
): { id: string; roadmapOrder: number }[] {
	const targetBucket = sortedStories.filter(
		(s) => s.priority === targetPriority,
	);
	const insertIndex = targetBucket.findIndex((s) => s.id === overStoryId);
	const moved = sortedStories.find((s) => s.id === movedStoryId);
	if (!moved || insertIndex === -1) {
		return [];
	}
	const withoutMoved = targetBucket.filter((s) => s.id !== movedStoryId);
	const inserted = [
		...withoutMoved.slice(0, insertIndex),
		moved,
		...withoutMoved.slice(insertIndex),
	];
	return inserted.map((s, i) => ({ id: s.id, roadmapOrder: i + 1 }));
}
