import { describe, expect, it } from "vitest";
import {
	getRoadmapBucketKey,
	groupStoriesByTrack,
	isSameBucket,
	TRACK_SECTIONS,
} from "../roadmap-utils";
import type { DeliveryTrack, UserStory } from "../stories/types";

function story(
	id: string,
	overrides: Partial<UserStory> & { deliveryTrack?: DeliveryTrack } = {},
): UserStory {
	return {
		id,
		identifier: `F-${id}`,
		title: `Story ${id}`,
		statusId: "status-1",
		kind: "FEATURE",
		priority: "P2_MEDIUM",
		order: 0,
		roadmapOrder: 0,
		tags: [],
		tasks: [],
		createdById: "u1",
		createdAt: new Date("2026-01-01"),
		updatedAt: new Date("2026-01-01"),
		source: "MANUAL",
		version: 1,
		draftingStage: "DRAFT",
		deliveryTrack: "UNCLASSIFIED",
		dependsOnRefs: [],
		dependsOnPhases: [],
		...overrides,
	} as UserStory;
}

describe("groupStoriesByTrack", () => {
	it("produces lanes in SPIKE, DISCOVERY, SPECIFY, UNCLASSIFIED, DEFER order", () => {
		expect(TRACK_SECTIONS.map((s) => s.track)).toEqual([
			"SPIKE",
			"DISCOVERY",
			"SPECIFY",
			"UNCLASSIFIED",
			"DEFER",
		]);
		const grouped = groupStoriesByTrack([]);
		expect(Object.keys(grouped)).toEqual([
			"SPIKE",
			"DISCOVERY",
			"SPECIFY",
			"UNCLASSIFIED",
			"DEFER",
		]);
	});

	it("buckets stories by deliveryTrack and sorts each lane by roadmapOrder", () => {
		const grouped = groupStoriesByTrack([
			story("a", { deliveryTrack: "SPECIFY", roadmapOrder: 3 }),
			story("b", { deliveryTrack: "SPIKE", roadmapOrder: 2 }),
			story("c", { deliveryTrack: "SPECIFY", roadmapOrder: 1 }),
			story("d", { deliveryTrack: "DEFER", roadmapOrder: 1 }),
			story("e", { deliveryTrack: "DISCOVERY", roadmapOrder: 9 }),
			story("f", { deliveryTrack: "UNCLASSIFIED", roadmapOrder: 5 }),
		]);

		expect(grouped.SPIKE.map((s) => s.id)).toEqual(["b"]);
		expect(grouped.DISCOVERY.map((s) => s.id)).toEqual(["e"]);
		expect(grouped.SPECIFY.map((s) => s.id)).toEqual(["c", "a"]);
		expect(grouped.UNCLASSIFIED.map((s) => s.id)).toEqual(["f"]);
		expect(grouped.DEFER.map((s) => s.id)).toEqual(["d"]);
	});

	it("treats a missing deliveryTrack as UNCLASSIFIED", () => {
		const legacy = story("legacy");
		// Simulate an older payload that predates the column.
		(legacy as { deliveryTrack?: DeliveryTrack }).deliveryTrack = undefined;
		const grouped = groupStoriesByTrack([legacy]);
		expect(grouped.UNCLASSIFIED.map((s) => s.id)).toEqual(["legacy"]);
	});

	it("always drops DECLINED and hides CLOSED unless showClosed is set", () => {
		const input = [
			story("open", { deliveryTrack: "SPIKE" }),
			story("closed", {
				deliveryTrack: "SPIKE",
				draftingStage: "CLOSED",
			}),
			story("declined", {
				deliveryTrack: "SPIKE",
				draftingStage: "DECLINED",
			}),
		];

		expect(groupStoriesByTrack(input).SPIKE.map((s) => s.id)).toEqual([
			"open",
		]);
		expect(groupStoriesByTrack(input, true).SPIKE.map((s) => s.id)).toEqual(
			["open", "closed"],
		);
	});
});

describe("getRoadmapBucketKey / isSameBucket", () => {
	it("uses priority when grouping by priority and track when grouping by track", () => {
		const s = story("a", {
			priority: "P1_HIGH",
			deliveryTrack: "DISCOVERY",
		});
		expect(getRoadmapBucketKey(s, "priority")).toBe("P1_HIGH");
		expect(getRoadmapBucketKey(s, "track")).toBe("DISCOVERY");
	});

	it("constrains drag-and-drop to the current grouping", () => {
		const a = story("a", { priority: "P1_HIGH", deliveryTrack: "SPIKE" });
		const b = story("b", { priority: "P1_HIGH", deliveryTrack: "SPECIFY" });

		// Same priority lane → allowed when grouped by priority …
		expect(
			isSameBucket(
				getRoadmapBucketKey(a, "priority"),
				getRoadmapBucketKey(b, "priority"),
			),
		).toBe(true);
		// … but different track lanes → blocked when grouped by track.
		expect(
			isSameBucket(
				getRoadmapBucketKey(a, "track"),
				getRoadmapBucketKey(b, "track"),
			),
		).toBe(false);
	});
});
