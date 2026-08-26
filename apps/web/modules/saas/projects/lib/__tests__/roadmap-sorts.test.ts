import { describe, expect, it } from "vitest";
import {
	coerceSort,
	compareStoriesBy,
	DEFAULT_ROADMAP_SORT,
	type RoadmapSort,
	SORT_KEY_DEFAULT_DIRECTIONS,
	SORT_KEY_LABELS,
	SORT_KEYS_REQUIRING_FLAT_LIST,
} from "../roadmap-sorts";
import type { UserStory } from "../stories/types";

function makeStory(overrides: Partial<UserStory> & { id: string }): UserStory {
	return {
		id: overrides.id,
		identifier: overrides.identifier ?? `F-${overrides.id}`,
		title: overrides.title ?? "Test story",
		description: overrides.description ?? null,
		acceptanceCriteria: overrides.acceptanceCriteria ?? null,
		statusId: "status-1",
		kind: overrides.kind ?? "FEATURE",
		priority: overrides.priority ?? "P2_MEDIUM",
		size: null,
		storyPoints: null,
		order: overrides.order ?? 1,
		roadmapOrder: overrides.roadmapOrder ?? overrides.order ?? 1,
		tasks: [],
		assigneeId: null,
		createdById: "user-1",
		createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
		updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
		lastEditedAt:
			"lastEditedAt" in overrides
				? overrides.lastEditedAt
				: (overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z")),
		externalId: overrides.externalId ?? null,
		externalUrl: overrides.externalUrl ?? null,
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		pipelineExecutionId: overrides.pipelineExecutionId ?? null,
		source: overrides.source ?? "manual",
		version: 1,
		draftingStage: overrides.draftingStage ?? "DRAFT",
		draftingStageUpdatedAt: overrides.draftingStageUpdatedAt ?? null,
		maturationStatus: overrides.maturationStatus ?? null,
	};
}

const sort = (overrides: Partial<RoadmapSort>): RoadmapSort => ({
	key: "roadmapOrder",
	direction: "asc",
	...overrides,
});

function sortIds(stories: UserStory[], s: RoadmapSort): string[] {
	return [...stories].sort(compareStoriesBy(s)).map((x) => x.id);
}

describe("compareStoriesBy — roadmapOrder", () => {
	const stories = [
		makeStory({ id: "c", roadmapOrder: 3 }),
		makeStory({ id: "a", roadmapOrder: 1 }),
		makeStory({ id: "b", roadmapOrder: 2 }),
	];

	it("asc orders by roadmapOrder ascending", () => {
		expect(
			sortIds(stories, sort({ key: "roadmapOrder", direction: "asc" })),
		).toEqual(["a", "b", "c"]);
	});
	it("desc reverses the order", () => {
		expect(
			sortIds(stories, sort({ key: "roadmapOrder", direction: "desc" })),
		).toEqual(["c", "b", "a"]);
	});
});

describe("compareStoriesBy — priority", () => {
	const stories = [
		makeStory({ id: "low", priority: "P3_LOW" }),
		makeStory({ id: "crit", priority: "P0_CRITICAL" }),
		makeStory({ id: "med", priority: "P2_MEDIUM" }),
		makeStory({ id: "high", priority: "P1_HIGH" }),
	];

	it("asc puts P0 first, P3 last", () => {
		expect(
			sortIds(stories, sort({ key: "priority", direction: "asc" })),
		).toEqual(["crit", "high", "med", "low"]);
	});
});

describe("compareStoriesBy — updated / created", () => {
	const stories = [
		makeStory({
			id: "old",
			updatedAt: new Date("2026-01-01"),
			createdAt: new Date("2026-01-01"),
		}),
		makeStory({
			id: "newest",
			updatedAt: new Date("2026-05-13"),
			createdAt: new Date("2026-05-13"),
		}),
		makeStory({
			id: "mid",
			updatedAt: new Date("2026-03-01"),
			createdAt: new Date("2026-03-01"),
		}),
	];

	it("updated desc puts newest first", () => {
		expect(
			sortIds(stories, sort({ key: "updated", direction: "desc" })),
		).toEqual(["newest", "mid", "old"]);
	});
	// A never-edited row has no edit event, but its card still shows a
	// timestamp — the creation date — so the sort ranks it on that same value.
	// Parking such rows at the end regardless of direction made the control
	// look broken: reversing it barely moved an un-backfilled backlog.
	it("updated ranks a never-edited row by its creation date", () => {
		const legacy = makeStory({
			id: "legacy",
			lastEditedAt: null,
			createdAt: new Date("2026-04-01"),
		});
		expect(
			sortIds(
				[...stories, legacy],
				sort({ key: "updated", direction: "desc" }),
			),
		).toEqual(["newest", "legacy", "mid", "old"]);
		expect(
			sortIds(
				[...stories, legacy],
				sort({ key: "updated", direction: "asc" }),
			),
		).toEqual(["old", "mid", "legacy", "newest"]);
	});
	it("created asc puts oldest first", () => {
		expect(
			sortIds(stories, sort({ key: "created", direction: "asc" })),
		).toEqual(["old", "mid", "newest"]);
	});
});

describe("compareStoriesBy — sync", () => {
	const stories = [
		makeStory({ id: "s1", externalId: "JIRA-1" }),
		makeStory({ id: "u1", externalId: null }),
		makeStory({ id: "s2", externalId: "JIRA-2" }),
		makeStory({ id: "u2", externalId: null }),
	];

	it("asc puts unsynced first", () => {
		const ids = sortIds(stories, sort({ key: "sync", direction: "asc" }));
		expect(new Set(ids.slice(0, 2))).toEqual(new Set(["u1", "u2"]));
		expect(new Set(ids.slice(2))).toEqual(new Set(["s1", "s2"]));
	});
});

describe("compareStoriesBy — stage", () => {
	const stories = [
		makeStory({ id: "pub", draftingStage: "PUBLISHED" }),
		makeStory({ id: "pla", draftingStage: "PLACEHOLDER" }),
		makeStory({ id: "drf", draftingStage: "DRAFT" }),
		makeStory({ id: "cls", draftingStage: "CLOSED" }),
	];

	it("asc follows pipeline order (TO_DO -> DISCOVERY -> DONE -> CLOSED)", () => {
		expect(
			sortIds(stories, sort({ key: "stage", direction: "asc" })),
		).toEqual(["pla", "drf", "pub", "cls"]);
	});

	it("ranks explicit maturationStatus over derived draftingStage", () => {
		const overrideStories = [
			makeStory({
				id: "s1",
				draftingStage: "PUBLISHED",
				maturationStatus: "TO_DO",
			}),
			makeStory({
				id: "s2",
				draftingStage: "PLACEHOLDER",
				maturationStatus: "DONE",
			}),
		];
		expect(
			sortIds(overrideStories, sort({ key: "stage", direction: "asc" })),
		).toEqual(["s1", "s2"]);
	});

	it("ranks ACTIVE_ANALYSIS, SANITY_CHECK, and DRAFT equally under DISCOVERY and tie-breaks by ID", () => {
		const discoveryStories = [
			makeStory({ id: "s-sanity", draftingStage: "SANITY_CHECK" }),
			makeStory({ id: "s-active", draftingStage: "ACTIVE_ANALYSIS" }),
			makeStory({ id: "s-draft", draftingStage: "DRAFT" }),
		];
		expect(
			sortIds(discoveryStories, sort({ key: "stage", direction: "asc" })),
		).toEqual(["s-active", "s-draft", "s-sanity"]);
	});
});

describe("compareStoriesBy — source", () => {
	const stories = [
		makeStory({ id: "j", source: "jira" }),
		makeStory({ id: "a", source: "azure_devops" }),
		makeStory({ id: "m", source: "manual" }),
	];

	it("asc orders alphabetically by source label", () => {
		expect(
			sortIds(stories, sort({ key: "source", direction: "asc" })),
		).toEqual(["a", "j", "m"]);
	});
});

describe("compareStoriesBy — recentlyApproved", () => {
	const stories = [
		makeStory({
			id: "old-approval",
			draftingStageUpdatedAt: new Date("2026-01-01"),
		}),
		makeStory({
			id: "new-approval",
			draftingStageUpdatedAt: new Date("2026-05-01"),
		}),
		makeStory({ id: "no-stamp", draftingStageUpdatedAt: null }),
	];

	it("desc puts most recent first, null sinks last", () => {
		expect(
			sortIds(
				stories,
				sort({ key: "recentlyApproved", direction: "desc" }),
			),
		).toEqual(["new-approval", "old-approval", "no-stamp"]);
	});
});

describe("compareStoriesBy — stability and tie-break", () => {
	const stories = [
		makeStory({ id: "b", priority: "P1_HIGH" }),
		makeStory({ id: "a", priority: "P1_HIGH" }),
		makeStory({ id: "c", priority: "P1_HIGH" }),
	];

	it("breaks ties by id ascending", () => {
		expect(
			sortIds(stories, sort({ key: "priority", direction: "asc" })),
		).toEqual(["a", "b", "c"]);
	});
});

describe("metadata exports", () => {
	it("SORT_KEY_DEFAULT_DIRECTIONS covers all 8 sort keys", () => {
		const keys = Object.keys(SORT_KEY_DEFAULT_DIRECTIONS).sort();
		expect(keys).toEqual([
			"created",
			"priority",
			"recentlyApproved",
			"roadmapOrder",
			"source",
			"stage",
			"sync",
			"updated",
		]);
	});
	it("SORT_KEYS_REQUIRING_FLAT_LIST excludes roadmapOrder and priority", () => {
		expect(SORT_KEYS_REQUIRING_FLAT_LIST.has("roadmapOrder")).toBe(false);
		expect(SORT_KEYS_REQUIRING_FLAT_LIST.has("priority")).toBe(false);
		expect(SORT_KEYS_REQUIRING_FLAT_LIST.has("updated")).toBe(true);
	});
});

describe("compareStoriesBy — roadmapOrder tie", () => {
	it("falls back to id ascending for equal roadmapOrder", () => {
		const a = makeStory({ id: "b-id", roadmapOrder: 5 });
		const b = makeStory({ id: "a-id", roadmapOrder: 5 });
		const sorted = [a, b].sort(
			compareStoriesBy({ key: "roadmapOrder", direction: "asc" }),
		);
		expect(sorted.map((s) => s.id)).toEqual(["a-id", "b-id"]);
	});

	it("primary roadmapOrder still wins over id", () => {
		const a = makeStory({ id: "a-id", roadmapOrder: 10 });
		const b = makeStory({ id: "b-id", roadmapOrder: 5 });
		const sorted = [a, b].sort(
			compareStoriesBy({ key: "roadmapOrder", direction: "asc" }),
		);
		expect(sorted.map((s) => s.id)).toEqual(["b-id", "a-id"]);
	});
});

describe("coerceSort — validation + fallback for persisted sort", () => {
	it("keeps a valid stored sort (known key + direction)", () => {
		expect(coerceSort({ key: "created", direction: "desc" })).toEqual({
			key: "created",
			direction: "desc",
		});
	});

	it("accepts every known sort key", () => {
		for (const key of Object.keys(SORT_KEY_LABELS)) {
			expect(coerceSort({ key, direction: "asc" })).toEqual({
				key,
				direction: "asc",
			});
		}
	});

	it("falls back to the default on an unknown / deprecated key", () => {
		// AC-6: a persisted sort field that no longer exists must silently
		// degrade to the default instead of surfacing an error.
		expect(coerceSort({ key: "deletedColumn", direction: "asc" })).toEqual(
			DEFAULT_ROADMAP_SORT,
		);
	});

	it("falls back to the default on an invalid direction", () => {
		expect(coerceSort({ key: "created", direction: "sideways" })).toEqual(
			DEFAULT_ROADMAP_SORT,
		);
	});

	it("falls back to the default on missing / null / non-object input", () => {
		// AC-4: no persisted preference → system default sort.
		expect(coerceSort(undefined)).toEqual(DEFAULT_ROADMAP_SORT);
		expect(coerceSort(null)).toEqual(DEFAULT_ROADMAP_SORT);
		expect(coerceSort("created")).toEqual(DEFAULT_ROADMAP_SORT);
		expect(coerceSort({})).toEqual(DEFAULT_ROADMAP_SORT);
		expect(coerceSort({ key: "created" })).toEqual(DEFAULT_ROADMAP_SORT);
	});
});
