/**
 * Tests for Roadmap view utility functions
 *
 * These tests verify the pure helper functions extracted from StoriesRoadmap:
 * - groupStoriesByPriority: groups and sorts stories by priority bucket
 * - isSameBucket: determines if two priority strings are equal
 * - DRAFTING_STAGE_META: label for PUBLISHED stage
 */

import { describe, expect, it } from "vitest";
import { groupStoriesByPriority, isSameBucket } from "../roadmap-utils";
import type { UserStory } from "../stories/types";
import { DRAFTING_STAGE_META } from "../stories/types";

// ---- Test helpers ----
function makeStory(overrides: Partial<UserStory> & { id: string }): UserStory {
	return {
		id: overrides.id,
		identifier: overrides.identifier ?? `F-${overrides.id}`,
		title: overrides.title ?? "Test story",
		description: null,
		acceptanceCriteria: null,
		statusId: "status-1",
		priority: overrides.priority ?? "P2_MEDIUM",
		size: null,
		storyPoints: null,
		order: overrides.order ?? 1,
		roadmapOrder: overrides.roadmapOrder ?? overrides.order ?? 1,
		labels: [],
		tasks: [],
		assigneeId: null,
		createdById: "user-1",
		createdAt: new Date(),
		updatedAt: new Date(),
		externalId: null,
		externalUrl: null,
		source: overrides.source ?? "manual",
		version: 1,
		draftingStage: overrides.draftingStage ?? "DRAFT",
		draftingStageUpdatedAt: null,
	};
}

// ---- groupStoriesByPriority ----
describe("groupStoriesByPriority", () => {
	it("groups stories by priority, sorted by order ascending", () => {
		const stories: UserStory[] = [
			makeStory({ id: "a", priority: "P0_CRITICAL", order: 3 }),
			makeStory({ id: "b", priority: "P0_CRITICAL", order: 1 }),
			makeStory({ id: "c", priority: "P1_HIGH", order: 2 }),
			makeStory({ id: "d", priority: "P3_LOW", order: 5 }),
		];

		const result = groupStoriesByPriority(stories);

		expect(result.P0_CRITICAL.map((s) => s.id)).toEqual(["b", "a"]);
		expect(result.P1_HIGH.map((s) => s.id)).toEqual(["c"]);
		expect(result.P2_MEDIUM).toHaveLength(0);
		expect(result.P3_LOW.map((s) => s.id)).toEqual(["d"]);
	});

	it("excludes DECLINED stories from all priority groups", () => {
		const stories: UserStory[] = [
			makeStory({
				id: "x",
				priority: "P0_CRITICAL",
				draftingStage: "DECLINED",
			}),
			makeStory({
				id: "y",
				priority: "P1_HIGH",
				draftingStage: "PUBLISHED",
			}),
			makeStory({
				id: "z",
				priority: "P2_MEDIUM",
				draftingStage: "DECLINED",
			}),
		];

		const result = groupStoriesByPriority(stories);

		expect(result.P0_CRITICAL).toHaveLength(0);
		expect(result.P1_HIGH.map((s) => s.id)).toEqual(["y"]);
		expect(result.P2_MEDIUM).toHaveLength(0);
	});

	it("includes DRAFT stories in priority groups", () => {
		const stories: UserStory[] = [
			makeStory({
				id: "d1",
				priority: "P2_MEDIUM",
				draftingStage: "DRAFT",
			}),
			makeStory({
				id: "d2",
				priority: "P2_MEDIUM",
				draftingStage: "PLACEHOLDER",
			}),
		];

		const result = groupStoriesByPriority(stories);

		expect(result.P2_MEDIUM).toHaveLength(2);
	});

	it("returns empty arrays for all buckets when no stories provided", () => {
		const result = groupStoriesByPriority([]);
		expect(result.P0_CRITICAL).toHaveLength(0);
		expect(result.P1_HIGH).toHaveLength(0);
		expect(result.P2_MEDIUM).toHaveLength(0);
		expect(result.P3_LOW).toHaveLength(0);
	});

	// ---- CLOSED filter behavior ----
	it("excludes CLOSED stories by default (showClosed omitted)", () => {
		const stories: UserStory[] = [
			makeStory({
				id: "c1",
				priority: "P2_MEDIUM",
				draftingStage: "CLOSED",
			}),
			makeStory({
				id: "d1",
				priority: "P2_MEDIUM",
				draftingStage: "DRAFT",
			}),
		];

		const result = groupStoriesByPriority(stories);

		expect(result.P2_MEDIUM.map((s) => s.id)).toEqual(["d1"]);
	});

	it("excludes CLOSED stories when showClosed = false", () => {
		const stories: UserStory[] = [
			makeStory({
				id: "c1",
				priority: "P1_HIGH",
				draftingStage: "CLOSED",
			}),
			makeStory({
				id: "p1",
				priority: "P1_HIGH",
				draftingStage: "PUBLISHED",
			}),
		];

		const result = groupStoriesByPriority(stories, false);

		expect(result.P1_HIGH.map((s) => s.id)).toEqual(["p1"]);
	});

	it("includes CLOSED stories when showClosed = true", () => {
		const stories: UserStory[] = [
			makeStory({
				id: "c1",
				priority: "P1_HIGH",
				draftingStage: "CLOSED",
				order: 2,
			}),
			makeStory({
				id: "p1",
				priority: "P1_HIGH",
				draftingStage: "PUBLISHED",
				order: 1,
			}),
		];

		const result = groupStoriesByPriority(stories, true);

		expect(result.P1_HIGH.map((s) => s.id).sort()).toEqual(["c1", "p1"]);
	});

	it("excludes DECLINED stories regardless of showClosed", () => {
		const stories: UserStory[] = [
			makeStory({
				id: "x",
				priority: "P0_CRITICAL",
				draftingStage: "DECLINED",
			}),
			makeStory({
				id: "c",
				priority: "P0_CRITICAL",
				draftingStage: "CLOSED",
			}),
		];

		const hidden = groupStoriesByPriority(stories, false);
		expect(hidden.P0_CRITICAL.map((s) => s.id)).toEqual([]);

		const shown = groupStoriesByPriority(stories, true);
		// DECLINED stays hidden even with showClosed on; CLOSED is revealed.
		expect(shown.P0_CRITICAL.map((s) => s.id)).toEqual(["c"]);
	});
});

// ---- isSameBucket ----
describe("isSameBucket", () => {
	it("returns true when sourcePriority === targetPriority", () => {
		expect(isSameBucket("P0_CRITICAL", "P0_CRITICAL")).toBe(true);
		expect(isSameBucket("P2_MEDIUM", "P2_MEDIUM")).toBe(true);
	});

	it("returns false when priorities differ", () => {
		expect(isSameBucket("P0_CRITICAL", "P1_HIGH")).toBe(false);
		expect(isSameBucket("P3_LOW", "P2_MEDIUM")).toBe(false);
	});
});

// ---- DRAFTING_STAGE_META label ----
describe("PUBLISHED draftingStage label", () => {
	it("renders 'Ready for Dev' for the PUBLISHED stage", () => {
		expect(DRAFTING_STAGE_META.PUBLISHED.label).toBe("Ready for Dev");
	});
});

describe("groupStoriesByPriority — equal roadmapOrder tiebreaker", () => {
	it("breaks ties by id.localeCompare ascending", () => {
		const stories = [
			makeStory({ id: "c", priority: "P2_MEDIUM", order: 1 }),
			makeStory({ id: "a", priority: "P2_MEDIUM", order: 1 }),
			makeStory({ id: "b", priority: "P2_MEDIUM", order: 1 }),
		];
		const grouped = groupStoriesByPriority(stories, false);
		expect(grouped.P2_MEDIUM.map((s) => s.id)).toEqual(["a", "b", "c"]);
	});

	it("is stable across repeated calls", () => {
		const stories = [
			makeStory({ id: "c", priority: "P2_MEDIUM", order: 1 }),
			makeStory({ id: "a", priority: "P2_MEDIUM", order: 1 }),
			makeStory({ id: "b", priority: "P2_MEDIUM", order: 1 }),
		];
		const first = groupStoriesByPriority(stories, false).P2_MEDIUM.map(
			(s) => s.id,
		);
		const second = groupStoriesByPriority(stories, false).P2_MEDIUM.map(
			(s) => s.id,
		);
		expect(first).toEqual(second);
	});

	it("does not interleave buckets when roadmapOrder is equal across priorities", () => {
		const stories = [
			makeStory({ id: "a", priority: "P0_CRITICAL", order: 1 }),
			makeStory({ id: "b", priority: "P2_MEDIUM", order: 1 }),
		];
		const grouped = groupStoriesByPriority(stories, false);
		expect(grouped.P0_CRITICAL.map((s) => s.id)).toEqual(["a"]);
		expect(grouped.P2_MEDIUM.map((s) => s.id)).toEqual(["b"]);
	});
});

describe("computeCrossBucketReorder", () => {
	const stories = [
		makeStory({ id: "p0a", priority: "P0_CRITICAL", order: 1 }),
		makeStory({ id: "moved", priority: "P2_MEDIUM", order: 99 }),
		makeStory({ id: "p0b", priority: "P0_CRITICAL", order: 2 }),
	];

	it("inserts moved story at the over index and compacts to 1..N", async () => {
		const { computeCrossBucketReorder } = await import("../roadmap-utils");
		const result = computeCrossBucketReorder(
			stories,
			"moved",
			"P0_CRITICAL",
			"p0b",
		);
		expect(result).toEqual([
			{ id: "p0a", roadmapOrder: 1 },
			{ id: "moved", roadmapOrder: 2 },
			{ id: "p0b", roadmapOrder: 3 },
		]);
	});

	it("returns [] when overStoryId is not in the target bucket", async () => {
		const { computeCrossBucketReorder } = await import("../roadmap-utils");
		const result = computeCrossBucketReorder(
			stories,
			"moved",
			"P0_CRITICAL",
			"nonexistent",
		);
		expect(result).toEqual([]);
	});

	it("returns [] when movedStoryId is not in sortedStories", async () => {
		const { computeCrossBucketReorder } = await import("../roadmap-utils");
		const result = computeCrossBucketReorder(
			stories,
			"missing-id",
			"P0_CRITICAL",
			"p0a",
		);
		expect(result).toEqual([]);
	});
});
