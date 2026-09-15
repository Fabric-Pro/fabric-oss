import { describe, expect, it } from "vitest";
import {
	formatPhasePoints,
	getRoadmapBucketKey,
	groupStoriesByPhaseAndTrack,
	orderPhases,
	phaseFromLabels,
	phaseSortIndex,
	sumPhasePoints,
} from "../roadmap-utils";
import type { UserStory } from "../stories/types";

function story(id: string, overrides: Partial<UserStory> = {}): UserStory {
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

describe("phase helpers", () => {
	it("reads phase:N tags and orders quoted phases first, unassigned last", () => {
		expect(phaseFromLabels(["priority:must", "phase:2"])).toBe("2");
		expect(phaseFromLabels([])).toBeNull();
		expect(orderPhases(["unassigned", "3", "1", "2"], ["2"])).toEqual([
			"2",
			"1",
			"3",
			"unassigned",
		]);
	});

	it("sums points and reports a range only when a LOW-confidence story is present", () => {
		const firm = sumPhasePoints([
			story("a", { storyPoints: 5, estimateConfidence: "HIGH" }),
			story("b", { storyPoints: 3, estimateConfidence: "MEDIUM" }),
			story("c", { storyPoints: null }),
		]);
		expect(firm).toEqual({
			points: 8,
			confidentPoints: 8,
			hasLowConfidence: false,
			storyCount: 3,
		});
		expect(formatPhasePoints(firm)).toBe("8 pt");

		const ranged = sumPhasePoints([
			story("a", { storyPoints: 5, estimateConfidence: "HIGH" }),
			story("s", {
				storyPoints: 3,
				estimateConfidence: "LOW",
				deliveryTrack: "SPIKE",
			}),
		]);
		expect(formatPhasePoints(ranged)).toBe("5–8 pt");
	});
});

describe("groupStoriesByPhaseAndTrack", () => {
	const storyAt = (index: number): UserStory => {
		const found = stories[index];
		if (!found) {
			throw new Error(`no fixture story at ${index}`);
		}
		return found;
	};
	const stories = [
		story("p2-spec", {
			tags: [{ id: "phase:2", value: "phase:2", createdById: null }],
			deliveryTrack: "SPECIFY",
			storyPoints: 8,
			estimateConfidence: "HIGH",
			roadmapOrder: 2,
		}),
		story("p1-spike", {
			tags: [{ id: "phase:1", value: "phase:1", createdById: null }],
			deliveryTrack: "SPIKE",
			storyPoints: 3,
			estimateConfidence: "LOW",
		}),
		story("p1-spec-b", {
			tags: [{ id: "phase:1", value: "phase:1", createdById: null }],
			deliveryTrack: "SPECIFY",
			storyPoints: 5,
			estimateConfidence: "HIGH",
			roadmapOrder: 2,
		}),
		story("p1-spec-a", {
			tags: [{ id: "phase:1", value: "phase:1", createdById: null }],
			deliveryTrack: "SPECIFY",
			storyPoints: 2,
			estimateConfidence: "MEDIUM",
			roadmapOrder: 1,
		}),
		story("none", { deliveryTrack: "DEFER", storyPoints: 1 }),
		story("closed", {
			tags: [{ id: "phase:1", value: "phase:1", createdById: null }],
			draftingStage: "CLOSED",
			storyPoints: 100,
		}),
		story("declined", {
			tags: [{ id: "phase:1", value: "phase:1", createdById: null }],
			draftingStage: "DECLINED",
			storyPoints: 100,
		}),
	];

	it("orders sections phase:1 … then unassigned, each split by track in lane order", () => {
		const sections = groupStoriesByPhaseAndTrack(stories, ["1", "2"]);
		expect(sections.map((s) => s.phase)).toEqual(["1", "2", "unassigned"]);
		expect(sections.map((s) => s.label)).toEqual([
			"Phase 1",
			"Phase 2",
			"Unassigned",
		]);
		expect(sections[0]?.tracks.map((t) => t.track)).toEqual([
			"SPIKE",
			"SPECIFY",
		]);
		expect(sections[0]?.tracks[1]?.stories.map((s) => s.id)).toEqual([
			"p1-spec-a",
			"p1-spec-b",
		]);
		expect(sections[2]?.tracks.map((t) => t.track)).toEqual(["DEFER"]);
	});

	it("reports per-phase totals as a range when the phase holds a LOW-confidence spike", () => {
		const sections = groupStoriesByPhaseAndTrack(stories, ["1", "2"]);
		expect(sections[0]?.totals).toEqual({
			points: 10,
			confidentPoints: 7,
			hasLowConfidence: true,
			storyCount: 3,
		});
		expect(
			formatPhasePoints(sections[0]?.totals ?? sumPhasePoints([])),
		).toBe("7–10 pt");
		expect(
			formatPhasePoints(sections[1]?.totals ?? sumPhasePoints([])),
		).toBe("8 pt");
	});

	it("drops declined stories always and closed stories unless showClosed", () => {
		const hidden = groupStoriesByPhaseAndTrack(stories, ["1"]);
		expect(hidden[0]?.totals.storyCount).toBe(3);
		const shown = groupStoriesByPhaseAndTrack(stories, ["1"], true);
		expect(shown[0]?.totals.storyCount).toBe(4);
		expect(shown[0]?.totals.points).toBe(110);
		expect(
			shown.flatMap((s) =>
				s.tracks.flatMap((t) => t.stories.map((x) => x.id)),
			),
		).not.toContain("declined");
	});

	it("keeps quoted phases with no stories out of the lanes but sorts by them", () => {
		const sections = groupStoriesByPhaseAndTrack(stories, ["3", "1", "2"]);
		// Phase 3 is quoted but empty → no section; order otherwise follows the quote.
		expect(sections.map((s) => s.phase)).toEqual(["1", "2", "unassigned"]);
		const order = orderPhases(["1", "2", "unassigned"], ["3", "1", "2"]);
		expect(phaseSortIndex(storyAt(0), order)).toBe(2); // phase 2
		expect(phaseSortIndex(storyAt(1), order)).toBe(1); // phase 1
		expect(phaseSortIndex(storyAt(4), order)).toBe(3); // unassigned
	});

	it("buckets drag-and-drop by phase and track under groupBy: phase", () => {
		expect(getRoadmapBucketKey(storyAt(1), "phase")).toBe("1:SPIKE");
		expect(getRoadmapBucketKey(storyAt(2), "phase")).toBe("1:SPECIFY");
		expect(getRoadmapBucketKey(storyAt(4), "phase")).toBe(
			"unassigned:DEFER",
		);
		// Other groupings are unchanged.
		expect(getRoadmapBucketKey(storyAt(1), "track")).toBe("SPIKE");
		expect(getRoadmapBucketKey(storyAt(1), "priority")).toBe("P2_MEDIUM");
	});
});
