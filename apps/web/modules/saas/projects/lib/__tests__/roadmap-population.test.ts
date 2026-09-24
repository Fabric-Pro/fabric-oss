import { describe, expect, it } from "vitest";
import {
	isRoadmapPopulated,
	ROADMAP_POPULATION_POLICY,
} from "../roadmap-population";
import type {
	FeatureDraftingStage,
	MaturationStatus,
	StoryStatus,
} from "../stories/types";

const statuses: StoryStatus[] = [
	{
		id: "st_backlog",
		name: "Backlog",
		color: "gray",
		order: 0,
		isDefault: true,
		isFinal: false,
	},
	{
		id: "st_progress",
		name: "In Progress",
		color: "blue",
		order: 1,
		isDefault: false,
		isFinal: false,
	},
	{
		id: "st_done",
		name: "Done",
		color: "green",
		order: 2,
		isDefault: false,
		isFinal: true,
	},
];

function story(
	statusId: string,
	draftingStage: FeatureDraftingStage = "PUBLISHED",
	maturationStatus: MaturationStatus | null = null,
) {
	return { statusId, draftingStage, maturationStatus };
}

describe("Roadmap population policy", () => {
	it("has one row per excluded case, each tied to its requirement", () => {
		expect(ROADMAP_POPULATION_POLICY.map((r) => [r.id, r.fr])).toEqual([
			["declined", "FR39"],
			["hidden-archived", "FR40"],
			["backlog", "FR41"],
			["completed", "FR42"],
		]);
	});

	it("zero items is not populated", () => {
		expect(isRoadmapPopulated([], statuses, false)).toBe(false);
	});

	it("FR39: a declined item does not count", () => {
		expect(
			isRoadmapPopulated(
				[story("st_progress", "DECLINED")],
				statuses,
				false,
			),
		).toBe(false);
	});

	it("FR40: a hidden (archived) item does not count", () => {
		expect(
			isRoadmapPopulated(
				[story("st_progress", "CLOSED")],
				statuses,
				false,
			),
		).toBe(false);
	});

	it("FR41: an item in the default (Backlog) status does not count", () => {
		expect(isRoadmapPopulated([story("st_backlog")], statuses, false)).toBe(
			false,
		);
	});

	it("FR42: an item in a final (Done) status does not count", () => {
		expect(isRoadmapPopulated([story("st_done")], statuses, false)).toBe(
			false,
		);
	});

	it("FR43: one active item among parked ones makes it populated", () => {
		expect(
			isRoadmapPopulated(
				[
					story("st_backlog"),
					story("st_done"),
					story("st_progress", "CLOSED"),
					story("st_progress", "DECLINED"),
					story("st_progress", "DRAFT"),
				],
				statuses,
				false,
			),
		).toBe(true);
	});

	it("a draft-stage item in an active status counts", () => {
		expect(
			isRoadmapPopulated(
				[story("st_progress", "PLACEHOLDER")],
				statuses,
				false,
			),
		).toBe(true);
	});

	it("an item with an unknown status counts, so loading never flashes the empty state", () => {
		expect(isRoadmapPopulated([story("st_backlog")], [], false)).toBe(true);
		expect(isRoadmapPopulated([story("st_missing")], statuses, false)).toBe(
			true,
		);
	});

	it("an unknown status does not rescue a hidden or declined item", () => {
		expect(isRoadmapPopulated([story("st_x", "CLOSED")], [], false)).toBe(
			false,
		);
		expect(isRoadmapPopulated([story("st_x", "DECLINED")], [], false)).toBe(
			false,
		);
	});
});

describe("Roadmap population on a Maturation V2 board", () => {
	it("an item in Backlog still in the first stage (To Do) does not count", () => {
		expect(
			isRoadmapPopulated(
				[story("st_backlog", "PLACEHOLDER", "TO_DO")],
				statuses,
				true,
			),
		).toBe(false);
	});

	it("an item in Backlog moved to Discovery counts", () => {
		expect(
			isRoadmapPopulated(
				[story("st_backlog", "PLACEHOLDER", "DISCOVERY")],
				statuses,
				true,
			),
		).toBe(true);
	});

	it("an item in Backlog with requirements complete counts", () => {
		expect(
			isRoadmapPopulated(
				[story("st_backlog", "PLACEHOLDER", "DONE")],
				statuses,
				true,
			),
		).toBe(true);
	});

	it("a legacy row without a stage uses the stage the board shows", () => {
		expect(
			isRoadmapPopulated([story("st_backlog", "DRAFT")], statuses, true),
		).toBe(true);
		expect(
			isRoadmapPopulated(
				[story("st_backlog", "PLACEHOLDER")],
				statuses,
				true,
			),
		).toBe(false);
	});

	it("a hidden, declined or final-status item stays excluded past To Do", () => {
		expect(
			isRoadmapPopulated(
				[
					story("st_backlog", "CLOSED", "DISCOVERY"),
					story("st_backlog", "DECLINED", "DISCOVERY"),
					story("st_done", "PLACEHOLDER", "DISCOVERY"),
				],
				statuses,
				true,
			),
		).toBe(false);
	});

	it("with V2 off, the stage is ignored and Backlog does not count", () => {
		expect(
			isRoadmapPopulated(
				[story("st_backlog", "PUBLISHED", "DISCOVERY")],
				statuses,
				false,
			),
		).toBe(false);
	});
});
