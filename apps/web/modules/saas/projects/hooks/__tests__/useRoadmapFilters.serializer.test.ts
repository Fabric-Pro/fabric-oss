import { describe, expect, it } from "vitest";
import { serializeRoadmapQuery } from "../useRoadmapFilters";

// `serializeRoadmapQuery` is what `useRoadmapFilters` calls on every state
// change to build the string it hands to `rememberRoadmapQuery` (see
// `../../lib/stories/roadmap-return.ts`). The stored query must never
// re-apply defaults on read-back, so this locks the "defaults are omitted"
// behavior nuqs's `createSerializer` gives us — a regression here would
// silently start persisting the entire default filter set on every roadmap
// visit.

type RoadmapQueryState = Parameters<typeof serializeRoadmapQuery>[0];

const defaultState: RoadmapQueryState = {
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
};

describe("serializeRoadmapQuery", () => {
	it("serializes an all-default state to ''", () => {
		expect(serializeRoadmapQuery(defaultState)).toBe("");
	});

	it("serializes only the touched keys, omitting untouched defaults", () => {
		const result = serializeRoadmapQuery({
			...defaultState,
			q: "login",
			kind: ["BUG"],
		});

		expect(result).toContain("q=login");
		expect(result).toContain("kind=BUG");
		// Untouched keys never appear.
		expect(result).not.toMatch(/priority=/);
		expect(result).not.toMatch(/stage=/);
		expect(result).not.toMatch(/aiSearch=/);
		expect(result).toBe("?q=login&kind=BUG");
	});
});
