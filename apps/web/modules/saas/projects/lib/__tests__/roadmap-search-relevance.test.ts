import { describe, expect, it } from "vitest";
import {
	compareStoriesByRelevance,
	computeMatchPercentById,
	narrowToNameMatches,
	scoreStoryAgainstQuery,
} from "../roadmap-search-relevance";
import { compareStoriesBy } from "../roadmap-sorts";
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
	};
}

describe("scoreStoryAgainstQuery", () => {
	it("scores a title match above a description-only match (FR2)", () => {
		const titleMatch = makeStory({
			id: "t",
			title: "Add OAuth login to the settings page",
		});
		const bodyMatch = makeStory({
			id: "d",
			title: "Settings redesign",
			description: "Rework the settings surface, including OAuth login.",
		});
		const score = scoreStoryAgainstQuery("oauth login");
		expect(score(titleMatch)).toBeGreaterThan(score(bodyMatch));
	});

	it("scores an identifier match between title and description", () => {
		const titleHit = makeStory({ id: "t", title: "Rework ticket 011" });
		const idHit = makeStory({
			id: "i",
			title: "Unrelated title",
			identifier: "B-011",
		});
		const bodyHit = makeStory({
			id: "b",
			title: "Unrelated title",
			description: "Follow-up for ticket 011 elsewhere.",
		});
		const score = scoreStoryAgainstQuery("011");
		// Identifier carries its own weight band; description the lowest.
		expect(score(idHit)).toBeGreaterThan(score(bodyHit));
		expect(score(titleHit)).toBeGreaterThan(score(idHit));
	});

	it("rewards a contiguous phrase in the title over scattered tokens", () => {
		const phrase = makeStory({ id: "p", title: "OAuth login flow" });
		const scattered = makeStory({
			id: "s",
			title: "Login page rework",
			description: "Move the OAuth handshake into the new page.",
		});
		const score = scoreStoryAgainstQuery("oauth login");
		expect(score(phrase)).toBeGreaterThan(score(scattered));
	});

	it("is case-insensitive", () => {
		const story = makeStory({ id: "c", title: "Add OAuth Login" });
		expect(scoreStoryAgainstQuery("OAUTH LOGIN")(story)).toBe(
			scoreStoryAgainstQuery("oauth login")(story),
		);
	});

	it("scores zero when no token matches any field", () => {
		const story = makeStory({ id: "z", title: "Billing export" });
		expect(scoreStoryAgainstQuery("quantum")(story)).toBe(0);
	});
});

describe("compareStoriesByRelevance", () => {
	it("puts an exact-title match first regardless of input order (AC1)", () => {
		const target = makeStory({ id: "target", title: "Export audit log" });
		const others = [
			makeStory({ id: "a1", title: "Dashboard widgets" }),
			makeStory({ id: "a2", title: "Team management" }),
			makeStory({
				id: "a3",
				title: "Reporting suite",
				description: "Scheduled exports of activity data.",
			}),
		];
		const ranked = [others[0], target, others[1], others[2]].sort(
			compareStoriesByRelevance("export audit log"),
		);
		expect(ranked[0]?.id).toBe("target");
	});

	it("falls back to the provided comparator on equal scores (UC1 tie rule)", () => {
		// Neither story matches the query at all — order must come from the
		// fallback (here: roadmapOrder asc), not from array order alone.
		const fallback = compareStoriesBy({
			key: "roadmapOrder",
			direction: "asc",
		});
		const ranked = [
			makeStory({ id: "b", roadmapOrder: 2 }),
			makeStory({ id: "a", roadmapOrder: 1 }),
		].sort(compareStoriesByRelevance("nomatch", fallback));
		expect(ranked.map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("ranks multi-token queries order-independently", () => {
		const both = makeStory({ id: "both", title: "Add OAuth login" });
		const partial = makeStory({
			id: "partial",
			title: "Login page",
			description: "Mentions oauth somewhere.",
		});
		const byA = [both, partial].sort(
			compareStoriesByRelevance("login oauth"),
		);
		const byB = [both, partial].sort(
			compareStoriesByRelevance("oauth login"),
		);
		expect(byA.map((s) => s.id)).toEqual(byB.map((s) => s.id));
		expect(byA[0]?.id).toBe("both");
	});
});

describe("computeMatchPercentById", () => {
	const stories = [{ id: "a" }, { id: "b" }, { id: "c" }];

	it("scales scores relative to the best result (best = 100)", () => {
		const out = computeMatchPercentById(
			stories,
			new Map([
				["a", 8],
				["b", 4],
			]),
		);
		expect(out.get("a")).toBe(100);
		expect(out.get("b")).toBe(50);
		expect(out.has("c")).toBe(false);
	});

	it("returns an empty map when nothing scored", () => {
		expect(computeMatchPercentById(stories, new Map()).size).toBe(0);
	});

	it("never emits zero or negative percentages", () => {
		const out = computeMatchPercentById(
			stories,
			new Map([
				["a", 1000],
				["b", 1],
			]),
		);
		expect(out.get("b")).toBe(1);
	});
});

describe("narrowToNameMatches", () => {
	const nameHit = makeStory({
		id: "n",
		identifier: "F-212",
		title: "Improve roadmap search relevance",
	});
	const bodyHit = makeStory({
		id: "b",
		identifier: "F-118",
		title: "Publishing suite topic refresh",
		description:
			"Once the roadmap settles we will search the archive for relevance signals.",
	});
	const otherBodyHit = makeStory({
		id: "b2",
		identifier: "F-119",
		title: "Atlas multi-repo run",
		description: "Roadmap owners search these graphs for relevance.",
	});

	it("drops body-only matches from the list when the query matches a name", () => {
		const { stories } = narrowToNameMatches(
			[nameHit, bodyHit, otherBodyHit],
			"roadmap search",
		);
		expect(stories.map((s) => s.id)).toEqual(["n"]);
	});

	it("counts the body-only matches it collapsed", () => {
		const { collapsedCount } = narrowToNameMatches(
			[nameHit, bodyHit, otherBodyHit],
			"roadmap search",
		);
		expect(collapsedCount).toBe(2);
	});

	it("returns the whole list when nothing matches by name", () => {
		const { stories, collapsedCount } = narrowToNameMatches(
			[bodyHit, otherBodyHit],
			"roadmap search",
		);
		expect(stories.map((s) => s.id)).toEqual(["b", "b2"]);
		expect(collapsedCount).toBe(0);
	});

	it("leaves an empty query alone", () => {
		const { stories, collapsedCount } = narrowToNameMatches(
			[nameHit, bodyHit],
			"   ",
		);
		expect(stories.map((s) => s.id)).toEqual(["n", "b"]);
		expect(collapsedCount).toBe(0);
	});

	it("keeps an identifier match as a name match", () => {
		const { stories } = narrowToNameMatches([nameHit, bodyHit], "f-212");
		expect(stories.map((s) => s.id)).toEqual(["n"]);
	});

	it("keeps a PM-tool externalId match as a name match", () => {
		const synced = makeStory({
			id: "x",
			title: "Unrelated wording entirely",
			externalId: "PROJ-4471",
		});
		const { stories } = narrowToNameMatches([synced, bodyHit], "proj-4471");
		expect(stories.map((s) => s.id)).toEqual(["x"]);
	});

	it("requires EVERY token in the name, matching the filter's AND semantics", () => {
		const partial = makeStory({
			id: "p",
			title: "Roadmap toolbar count",
			description: "The search box lives here.",
		});
		const { stories, collapsedCount } = narrowToNameMatches(
			[nameHit, partial],
			"roadmap search",
		);
		expect(stories.map((s) => s.id)).toEqual(["n"]);
		expect(collapsedCount).toBe(1);
	});

	it("preserves the relevance order it was given", () => {
		const second = makeStory({
			id: "n2",
			title: "Roadmap search autofill",
		});
		const { stories } = narrowToNameMatches(
			[nameHit, second, bodyHit],
			"roadmap search",
		);
		expect(stories.map((s) => s.id)).toEqual(["n", "n2"]);
	});
});

describe("narrowToNameMatches — the `narrowed` signal companion lists read", () => {
	const nameHit = makeStory({ id: "n", title: "Roadmap search relevance" });
	const bodyHit = makeStory({
		id: "b",
		title: "Unrelated",
		description: "roadmap search mentioned here",
	});

	it("reports narrowed when a name match exists, even with nothing to collapse", () => {
		const { narrowed, collapsedCount } = narrowToNameMatches(
			[nameHit],
			"roadmap search",
		);
		expect(narrowed).toBe(true);
		expect(collapsedCount).toBe(0);
	});

	it("reports not narrowed when only body matches exist", () => {
		expect(narrowToNameMatches([bodyHit], "roadmap search").narrowed).toBe(
			false,
		);
	});

	it("reports not narrowed for an empty query", () => {
		expect(narrowToNameMatches([nameHit, bodyHit], "  ").narrowed).toBe(
			false,
		);
	});
});
