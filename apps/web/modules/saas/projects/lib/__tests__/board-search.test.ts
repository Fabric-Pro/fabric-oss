import { expect, it } from "vitest";
import { applyRoadmapFilters, EMPTY_ROADMAP_FILTERS } from "../roadmap-filters";
import { scoreStoryAgainstQuery } from "../roadmap-search-relevance";
import type { UserStory } from "../stories/types";

it("uses remote description needles only after an answer and preserves title weight", () => {
	const story = {
		id: "example-story",
		title: "Other",
		identifier: "1",
		kind: "FEATURE",
		tags: [],
		hasDescription: true,
		hasAcceptanceCriteria: true,
	} as UserStory;
	const filters = { ...EMPTY_ROADMAP_FILTERS, q: "needle" };
	expect(applyRoadmapFilters([story], filters)).toEqual([]);
	const matches = new Map([[story.id, ["needle"]]]);
	expect(
		applyRoadmapFilters([story], filters, { descriptionMatches: matches }),
	).toEqual([story]);
	expect(scoreStoryAgainstQuery("needle", matches)(story)).toBe(1);
	expect(
		scoreStoryAgainstQuery(
			"needle",
			matches,
		)({ ...story, title: "needle" }),
	).toBe(4);
	expect(
		applyRoadmapFilters([story], {
			...EMPTY_ROADMAP_FILTERS,
			missingDesc: true,
		}),
	).toEqual([]);
	expect(
		applyRoadmapFilters([story], {
			...EMPTY_ROADMAP_FILTERS,
			missingAc: true,
		}),
	).toEqual([]);
});

it("combines title tokens with normalized description hits and trusts false flags", () => {
	const story = {
		id: "example-story",
		title: "login",
		identifier: "2",
		kind: "FEATURE",
		tags: [],
		description: "stale cached text",
		acceptanceCriteria: "stale",
		hasDescription: false,
		hasAcceptanceCriteria: false,
	} as UserStory;
	expect(
		applyRoadmapFilters(
			[story],
			{ ...EMPTY_ROADMAP_FILTERS, q: "login B-011" },
			{ descriptionMatches: new Map([[story.id, ["011"]]]) },
		),
	).toEqual([story]);
	expect(
		applyRoadmapFilters(
			[story],
			{ ...EMPTY_ROADMAP_FILTERS, q: "login different" },
			{ descriptionMatches: new Map([[story.id, ["011"]]]) },
		),
	).toEqual([]);
	expect(
		applyRoadmapFilters([story], {
			...EMPTY_ROADMAP_FILTERS,
			missingDesc: true,
			missingAc: true,
		}),
	).toEqual([story]);
});

it("ignores list text left in an optimistic cache while remote matches are pending", () => {
	const story = {
		id: "example-story",
		title: "Other",
		identifier: "1",
		kind: "FEATURE",
		tags: [],
		description: "needle",
	} as UserStory;
	const matches = new Map<string, string[]>();
	expect(
		applyRoadmapFilters(
			[story],
			{ ...EMPTY_ROADMAP_FILTERS, q: "needle" },
			{ descriptionMatches: matches },
		),
	).toEqual([]);
	expect(scoreStoryAgainstQuery("needle", matches)(story)).toBe(0);
});
