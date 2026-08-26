import { describe, expect, it } from "vitest";
import {
	activeFilterGroupCount,
	activeMoreFilterCount,
	applyRoadmapFilters,
	EMPTY_ROADMAP_FILTERS,
	hasActiveRoadmapFilters,
	normalizeStorySource,
	type RoadmapFilters,
	selectHiddenMatches,
} from "../roadmap-filters";
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
		tags: overrides.tags ?? [],
		tasks: [],
		assigneeId: null,
		createdById: "user-1",
		createdAt: overrides.createdAt ?? new Date(),
		updatedAt:
			overrides.updatedAt ??
			overrides.draftingStageUpdatedAt ??
			new Date(),
		lastEditedAt:
			"lastEditedAt" in overrides
				? overrides.lastEditedAt
				: (overrides.updatedAt ??
					overrides.draftingStageUpdatedAt ??
					new Date()),
		externalId: overrides.externalId ?? null,
		externalUrl: overrides.externalUrl ?? null,
		pipelineExecutionId: overrides.pipelineExecutionId ?? null,
		source: overrides.source ?? "manual",
		version: 1,
		draftingStage: overrides.draftingStage ?? "DRAFT",
		draftingStageUpdatedAt: overrides.draftingStageUpdatedAt ?? null,
		lastSyncedAt: overrides.lastSyncedAt ?? null,
		lastPmSyncStatus: overrides.lastPmSyncStatus ?? null,
		needsMoreInfo: overrides.needsMoreInfo ?? false,
		blocked: overrides.blocked ?? false,
		blockedReason: overrides.blockedReason ?? null,
	};
}

const filters = (overrides: Partial<RoadmapFilters> = {}): RoadmapFilters => ({
	...EMPTY_ROADMAP_FILTERS,
	...overrides,
});

describe("normalizeStorySource", () => {
	it("passes lowercase enum values through unchanged", () => {
		expect(normalizeStorySource("jira")).toBe("jira");
		expect(normalizeStorySource("custom_agent")).toBe("custom_agent");
	});

	it("lowercases uppercase Prisma enum values", () => {
		expect(normalizeStorySource("JIRA")).toBe("jira");
		expect(normalizeStorySource("AZURE_DEVOPS")).toBe("azure_devops");
		expect(normalizeStorySource("APPROVED_PROPOSAL")).toBe(
			"approved_proposal",
		);
		expect(normalizeStorySource("SLACK")).toBe("slack");
	});

	it("falls back to 'manual' for null, undefined, empty, or unknown values", () => {
		expect(normalizeStorySource(null)).toBe("manual");
		expect(normalizeStorySource(undefined)).toBe("manual");
		expect(normalizeStorySource("")).toBe("manual");
		expect(normalizeStorySource("WEFT")).toBe("manual");
	});
});

describe("hasActiveRoadmapFilters", () => {
	it("returns false for the empty filter object", () => {
		expect(hasActiveRoadmapFilters(EMPTY_ROADMAP_FILTERS)).toBe(false);
	});

	it("returns true for any non-empty filter", () => {
		expect(hasActiveRoadmapFilters(filters({ q: "auth" }))).toBe(true);
		expect(
			hasActiveRoadmapFilters(filters({ priority: ["P0_CRITICAL"] })),
		).toBe(true);
		expect(hasActiveRoadmapFilters(filters({ stage: ["DISCOVERY"] }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ sync: ["synced"] }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ sync: ["unsynced"] }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ source: ["jira"] }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ kind: ["BUG"] }))).toBe(true);
	});

	it("treats whitespace-only search as inactive", () => {
		expect(hasActiveRoadmapFilters(filters({ q: "   " }))).toBe(false);
	});

	it("returns true for any active advanced filter", () => {
		expect(
			hasActiveRoadmapFilters(filters({ createdFrom: "2026-05-01" })),
		).toBe(true);
		expect(
			hasActiveRoadmapFilters(filters({ createdTo: "2026-05-01" })),
		).toBe(true);
		expect(
			hasActiveRoadmapFilters(filters({ updatedFrom: "2026-05-01" })),
		).toBe(true);
		expect(
			hasActiveRoadmapFilters(filters({ updatedTo: "2026-05-01" })),
		).toBe(true);
		expect(
			hasActiveRoadmapFilters(filters({ syncedFrom: "2026-05-01" })),
		).toBe(true);
		expect(
			hasActiveRoadmapFilters(filters({ syncedTo: "2026-05-01" })),
		).toBe(true);
		expect(hasActiveRoadmapFilters(filters({ missingAc: true }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ missingDesc: true }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ recentlyApproved: 30 }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ recentlyChanged: 7 }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ recentlyAdded: 7 }))).toBe(
			true,
		);
		expect(hasActiveRoadmapFilters(filters({ duplicatesOnly: true }))).toBe(
			true,
		);
	});
});

describe("duplicatesOnly facet", () => {
	it("counts toward both the group total and the More-filters badge", () => {
		expect(activeFilterGroupCount(filters({ duplicatesOnly: true }))).toBe(
			1,
		);
		expect(activeMoreFilterCount(filters({ duplicatesOnly: true }))).toBe(
			1,
		);
	});

	it("is NOT applied by the pure applyRoadmapFilters (done in the component, where the duplicate-scan data is in scope)", () => {
		// The pure predicate has no access to duplicate-link data, so toggling
		// duplicatesOnly must leave the row set unchanged here — the actual
		// narrowing happens in StoriesRoadmap's sortedStories memo.
		const stories = [
			makeStory({ id: "1", title: "A" }),
			makeStory({ id: "2", title: "B" }),
		];
		expect(
			applyRoadmapFilters(stories, filters({ duplicatesOnly: true })),
		).toHaveLength(2);
	});
});

describe("needsMoreInfo facet", () => {
	it("is active + counts toward the group total and the More-filters badge", () => {
		expect(hasActiveRoadmapFilters(filters({ needsMoreInfo: true }))).toBe(
			true,
		);
		expect(activeFilterGroupCount(filters({ needsMoreInfo: true }))).toBe(
			1,
		);
		expect(activeMoreFilterCount(filters({ needsMoreInfo: true }))).toBe(1);
	});

	it("narrows to stories flagged needsMoreInfo when on, and is a no-op when off", () => {
		const stories = [
			makeStory({ id: "1", title: "Needs triage", needsMoreInfo: true }),
			makeStory({ id: "2", title: "Clear bug", needsMoreInfo: false }),
			makeStory({ id: "3", title: "A feature" }),
		];
		expect(
			applyRoadmapFilters(stories, filters({ needsMoreInfo: true })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
		expect(
			applyRoadmapFilters(stories, filters({ needsMoreInfo: false })),
		).toHaveLength(3);
	});
});

describe("blocked facet", () => {
	it("is active + counts toward the group total and the More-filters badge", () => {
		expect(hasActiveRoadmapFilters(filters({ blocked: true }))).toBe(true);
		expect(activeFilterGroupCount(filters({ blocked: true }))).toBe(1);
		expect(activeMoreFilterCount(filters({ blocked: true }))).toBe(1);
	});

	it("narrows to stories flagged blocked when on, and is a no-op when off", () => {
		const stories = [
			makeStory({ id: "1", title: "Blocked work", blocked: true }),
			makeStory({ id: "2", title: "Unblocked work", blocked: false }),
			makeStory({ id: "3", title: "A feature" }),
		];
		expect(
			applyRoadmapFilters(stories, filters({ blocked: true })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
		expect(
			applyRoadmapFilters(stories, filters({ blocked: false })),
		).toHaveLength(3);
	});
});

describe("applyRoadmapFilters — search", () => {
	const stories = [
		makeStory({ id: "1", title: "Add OAuth login", identifier: "F-001" }),
		makeStory({
			id: "2",
			title: "Roadmap filtering",
			identifier: "F-067",
			description: "Search and filter roadmap items",
		}),
		makeStory({
			id: "3",
			title: "Migrate to Postgres 16",
			externalId: "JIRA-1234",
		}),
	];

	it("matches title case-insensitively", () => {
		const result = applyRoadmapFilters(stories, filters({ q: "OAUTH" }));
		expect(result.map((s) => s.id)).toEqual(["1"]);
	});

	it("matches Fabric identifier (e.g. F-067)", () => {
		const result = applyRoadmapFilters(stories, filters({ q: "F-067" }));
		expect(result.map((s) => s.id)).toEqual(["2"]);
	});

	it("matches external PM tool ticket id", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ q: "JIRA-1234" }),
		);
		expect(result.map((s) => s.id)).toEqual(["3"]);
	});

	it("matches keyword in description", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ q: "filter roadmap" }),
		);
		expect(result.map((s) => s.id)).toEqual(["2"]);
	});

	it("returns all stories when q is whitespace", () => {
		const result = applyRoadmapFilters(stories, filters({ q: "   " }));
		expect(result).toHaveLength(stories.length);
	});

	it("returns empty array when nothing matches", () => {
		expect(
			applyRoadmapFilters(stories, filters({ q: "nonexistent" })),
		).toEqual([]);
	});

	// --- Token-based, order-independent matching ---

	it("matches a single word that is not the first word of the title", () => {
		// AC1: any single word in the title surfaces the row, not just a prefix.
		expect(
			applyRoadmapFilters(stories, filters({ q: "login" })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
		expect(
			applyRoadmapFilters(stories, filters({ q: "filtering" })).map(
				(s) => s.id,
			),
		).toEqual(["2"]);
	});

	it("matches a short (2–3 char) substring of a word", () => {
		// AC2: short substrings surface rows — there is no minimum-length guard.
		expect(
			applyRoadmapFilters(stories, filters({ q: "oau" })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
		expect(
			applyRoadmapFilters(stories, filters({ q: "road" })).map(
				(s) => s.id,
			),
		).toEqual(["2"]);
	});

	it("matches a multi-word query regardless of word order", () => {
		// The core fix: both words are in "Add OAuth login" but never adjacent
		// in this order, so the old exact-contiguous-phrase match returned
		// nothing. Order-independent token matching surfaces the row.
		expect(
			applyRoadmapFilters(stories, filters({ q: "login oauth" })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
		expect(
			applyRoadmapFilters(stories, filters({ q: "login add" })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
	});

	it("matches tokens spread across title and description", () => {
		// "search" lives in the description, "filtering" in the title.
		expect(
			applyRoadmapFilters(
				stories,
				filters({ q: "search filtering" }),
			).map((s) => s.id),
		).toEqual(["2"]);
	});

	it("requires ALL tokens to match (AND, not OR)", () => {
		// "oauth" matches story 1, "postgres" matches story 3 — no row has both,
		// so a non-OR semantics must return nothing.
		expect(
			applyRoadmapFilters(stories, filters({ q: "oauth postgres" })),
		).toEqual([]);
	});

	it("collapses repeated internal whitespace between tokens", () => {
		expect(
			applyRoadmapFilters(stories, filters({ q: "oauth   login" })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
	});

	it("still matches an exact contiguous phrase (no regression)", () => {
		// AC3: every row the old exact-phrase match produced still matches.
		expect(
			applyRoadmapFilters(stories, filters({ q: "add oauth login" })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
	});

	it("combines an identifier token with a title word", () => {
		expect(
			applyRoadmapFilters(stories, filters({ q: "f-001 login" })).map(
				(s) => s.id,
			),
		).toEqual(["1"]);
	});
});

describe("applyRoadmapFilters — priority", () => {
	const stories = [
		makeStory({ id: "a", priority: "P0_CRITICAL" }),
		makeStory({ id: "b", priority: "P1_HIGH" }),
		makeStory({ id: "c", priority: "P2_MEDIUM" }),
		makeStory({ id: "d", priority: "P3_LOW" }),
	];

	it("filters to a single priority", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ priority: ["P0_CRITICAL"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["a"]);
	});

	it("OR-composes within multi-select", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ priority: ["P0_CRITICAL", "P1_HIGH"] }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["a", "b"]);
	});

	it("treats empty array as no priority constraint", () => {
		const result = applyRoadmapFilters(stories, filters({ priority: [] }));
		expect(result).toHaveLength(stories.length);
	});
});

describe("applyRoadmapFilters — stage", () => {
	const stories = [
		makeStory({ id: "a", draftingStage: "PLACEHOLDER" }),
		makeStory({ id: "b", draftingStage: "SANITY_CHECK" }),
		makeStory({ id: "c", draftingStage: "PUBLISHED" }),
	];

	it("filters to selected stages", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ stage: ["SANITY_CHECK"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["b"]);
	});

	it("OR-composes within multi-select", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ stage: ["PLACEHOLDER", "PUBLISHED"] }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["a", "c"]);
	});
});

describe("applyRoadmapFilters — sync", () => {
	const stories = [
		makeStory({ id: "synced-1", externalId: "JIRA-1" }),
		makeStory({ id: "synced-2", externalId: "ADO-2" }),
		makeStory({ id: "unsynced-1", externalId: null }),
		makeStory({ id: "unsynced-2", externalId: null }),
	];

	it("empty array returns every story", () => {
		const result = applyRoadmapFilters(stories, filters({ sync: [] }));
		expect(result).toHaveLength(stories.length);
	});

	it("'synced' returns only stories with an externalId", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ sync: ["synced"] }),
		);
		expect(result.map((s) => s.id).sort()).toEqual([
			"synced-1",
			"synced-2",
		]);
	});

	it("'unsynced' returns only stories without an externalId", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ sync: ["unsynced"] }),
		);
		expect(result.map((s) => s.id).sort()).toEqual([
			"unsynced-1",
			"unsynced-2",
		]);
	});

	it("['synced','unsynced'] returns every story (no-op)", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ sync: ["synced", "unsynced"] }),
		);
		expect(result).toHaveLength(stories.length);
	});
});

describe("applyRoadmapFilters — composition", () => {
	const stories = [
		makeStory({
			id: "match",
			title: "Implement OAuth",
			priority: "P0_CRITICAL",
			draftingStage: "SANITY_CHECK",
			externalId: "JIRA-9",
		}),
		makeStory({
			id: "wrong-priority",
			title: "Implement OAuth",
			priority: "P2_MEDIUM",
			draftingStage: "SANITY_CHECK",
			externalId: "JIRA-10",
		}),
		makeStory({
			id: "wrong-stage",
			title: "Implement OAuth",
			priority: "P0_CRITICAL",
			draftingStage: "PUBLISHED",
			externalId: "JIRA-11",
		}),
		makeStory({
			id: "wrong-sync",
			title: "Implement OAuth",
			priority: "P0_CRITICAL",
			draftingStage: "SANITY_CHECK",
			externalId: null,
		}),
		makeStory({
			id: "wrong-search",
			title: "Pure refactor",
			priority: "P0_CRITICAL",
			draftingStage: "SANITY_CHECK",
			externalId: "JIRA-12",
		}),
	];

	it("ANDs across filter dimensions", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({
				q: "oauth",
				priority: ["P0_CRITICAL"],
				stage: ["SANITY_CHECK"],
				sync: ["synced"],
			}),
		);
		expect(result.map((s) => s.id)).toEqual(["match"]);
	});

	it("returns empty array when no story satisfies all dimensions", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({
				q: "oauth",
				priority: ["P3_LOW"],
			}),
		);
		expect(result).toEqual([]);
	});
});

describe("applyRoadmapFilters — date ranges", () => {
	const may1 = new Date("2026-05-01T12:00:00Z");
	const may10 = new Date("2026-05-10T12:00:00Z");
	const may20 = new Date("2026-05-20T12:00:00Z");

	const stories = [
		makeStory({ id: "early", createdAt: may1, updatedAt: may1 }),
		makeStory({ id: "mid", createdAt: may10, updatedAt: may10 }),
		makeStory({ id: "late", createdAt: may20, updatedAt: may20 }),
	];

	it("createdFrom is inclusive of the start day", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ createdFrom: "2026-05-10" }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["late", "mid"]);
	});

	it("createdTo is inclusive of the end day (full 23:59:59)", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ createdTo: "2026-05-10" }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["early", "mid"]);
	});

	it("createdFrom + createdTo bound a closed range", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ createdFrom: "2026-05-05", createdTo: "2026-05-15" }),
		);
		expect(result.map((s) => s.id)).toEqual(["mid"]);
	});

	it("updatedFrom/To narrows by the genuine last edit", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ updatedFrom: "2026-05-20" }),
		);
		expect(result.map((s) => s.id)).toEqual(["late"]);
	});

	it("syncedFrom/To excludes stories without lastSyncedAt", () => {
		const syncedStories = [
			makeStory({ id: "never-synced", lastSyncedAt: null }),
			makeStory({
				id: "synced-may-5",
				lastSyncedAt: new Date("2026-05-05T00:00:00Z"),
			}),
		];
		const result = applyRoadmapFilters(
			syncedStories,
			filters({ syncedFrom: "2026-05-01", syncedTo: "2026-05-10" }),
		);
		expect(result.map((s) => s.id)).toEqual(["synced-may-5"]);
	});

	it("malformed date strings are ignored (treated as unset)", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ createdFrom: "not-a-date" }),
		);
		expect(result).toHaveLength(stories.length);
	});
});

describe("applyRoadmapFilters — kind", () => {
	// Fabric supports exactly two work-item kinds — FEATURE and BUG. User Story
	// was retired (migrated to FEATURE), so there is no third kind to filter on.
	const stories = [
		makeStory({ id: "feat", kind: "FEATURE" }),
		makeStory({ id: "bug", kind: "BUG" }),
	];

	it("filters to a single kind", () => {
		const result = applyRoadmapFilters(stories, filters({ kind: ["BUG"] }));
		expect(result.map((s) => s.id)).toEqual(["bug"]);
	});

	it("OR-composes within multi-select", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ kind: ["FEATURE", "BUG"] }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["bug", "feat"]);
	});

	it("treats empty array as no kind constraint", () => {
		const result = applyRoadmapFilters(stories, filters({ kind: [] }));
		expect(result).toHaveLength(stories.length);
	});
});

describe("applyRoadmapFilters — source", () => {
	// Source is now an explicit column populated at create time. The filter
	// just compares story.source to the selected set — no derivation, no host
	// matching, no field-precedence rules. These tests assert the column is
	// honored across each enum value, including the previously-untested
	// "manual" case.
	const stories = [
		makeStory({ id: "manual", source: "manual" }),
		makeStory({
			id: "jira",
			source: "jira",
			externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
			externalId: "PROJ-1",
		}),
		makeStory({
			id: "ado",
			source: "azure_devops",
			externalUrl: "https://dev.azure.com/org/proj/_workitems/edit/9",
			externalId: "9",
		}),
		makeStory({
			id: "ai",
			source: "ai_update",
			pipelineExecutionId: "exec_42",
		}),
		makeStory({
			id: "approved",
			source: "approved_proposal",
		}),
	];

	it("filters to a single source", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ source: ["jira"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["jira"]);
	});

	it("filters to source: manual (regression — bucket was previously untested)", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ source: ["manual"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["manual"]);
	});

	it("filters to source: slack", () => {
		const slackStories = [
			makeStory({ id: "slack-1", source: "slack" }),
			makeStory({ id: "manual-1", source: "manual" }),
			makeStory({ id: "jira-1", source: "jira" }),
		];
		const result = applyRoadmapFilters(
			slackStories,
			filters({ source: ["slack"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["slack-1"]);
	});

	it("OR-composes within multi-select", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ source: ["jira", "ai_update"] }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["ai", "jira"]);
	});

	it("treats empty array as no source constraint", () => {
		const result = applyRoadmapFilters(stories, filters({ source: [] }));
		expect(result).toHaveLength(stories.length);
	});

	it("search by source label finds matching stories", () => {
		const result = applyRoadmapFilters(stories, filters({ q: "Jira" }));
		expect(result.map((s) => s.id)).toContain("jira");
	});

	it("normalizes uppercase Prisma enum values before filtering", () => {
		// If a code path constructs a UserStory without going through
		// transformStory, story.source may leak through as the raw DB enum
		// ("JIRA" instead of "jira"). The filter must still match.
		const leakedUppercase = [
			makeStory({ id: "leaked", source: "JIRA" as never }),
		];
		expect(
			applyRoadmapFilters(
				leakedUppercase,
				filters({ source: ["jira"] }),
			).map((s) => s.id),
		).toEqual(["leaked"]);
	});

	it("treats null/undefined/unknown source as 'manual'", () => {
		const stories = [
			makeStory({ id: "null-source", source: null as never }),
			makeStory({ id: "unknown-source", source: "WEFT" as never }),
		];
		const result = applyRoadmapFilters(
			stories,
			filters({ source: ["manual"] }),
		);
		expect(result.map((s) => s.id).sort()).toEqual([
			"null-source",
			"unknown-source",
		]);
	});

	it("source is independent of externalUrl host (column is the source of truth)", () => {
		// A row whose externalUrl points at Jira but whose source column says
		// "manual" must NOT appear in a Jira filter — proves the filter no
		// longer infers from the URL.
		const mixed = [
			makeStory({
				id: "url-says-jira-but-source-is-manual",
				source: "manual",
				externalUrl: "https://acme.atlassian.net/browse/PROJ-99",
				externalId: "PROJ-99",
			}),
		];
		expect(
			applyRoadmapFilters(mixed, filters({ source: ["jira"] })),
		).toEqual([]);
		expect(
			applyRoadmapFilters(mixed, filters({ source: ["manual"] })).map(
				(s) => s.id,
			),
		).toEqual(["url-says-jira-but-source-is-manual"]);
	});
});

describe("applyRoadmapFilters — missing data flags", () => {
	const stories = [
		makeStory({
			id: "complete",
			description: "x",
			acceptanceCriteria: "y",
		}),
		makeStory({
			id: "no-desc",
			description: null,
			acceptanceCriteria: "y",
		}),
		makeStory({ id: "no-ac", description: "x", acceptanceCriteria: null }),
		makeStory({ id: "neither", description: "", acceptanceCriteria: "  " }),
	];

	it("missingDesc keeps only stories with empty/null description", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ missingDesc: true }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["neither", "no-desc"]);
	});

	it("missingAc keeps only stories with empty/null AC", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ missingAc: true }),
		);
		expect(result.map((s) => s.id).sort()).toEqual(["neither", "no-ac"]);
	});

	it("missingDesc + missingAc composes with AND", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ missingDesc: true, missingAc: true }),
		);
		expect(result.map((s) => s.id)).toEqual(["neither"]);
	});
});

describe("applyRoadmapFilters — recency", () => {
	const now = Date.now();
	const daysAgo = (n: number) => new Date(now - n * 86_400_000);

	const stories = [
		makeStory({
			id: "approved-3d",
			draftingStage: "PUBLISHED",
			draftingStageUpdatedAt: daysAgo(3),
		}),
		makeStory({
			id: "approved-45d",
			draftingStage: "PUBLISHED",
			draftingStageUpdatedAt: daysAgo(45),
		}),
		makeStory({
			id: "not-approved",
			draftingStage: "DRAFT",
			draftingStageUpdatedAt: daysAgo(1),
		}),
		makeStory({ id: "updated-2d", updatedAt: daysAgo(2) }),
		makeStory({ id: "updated-100d", updatedAt: daysAgo(100) }),
	];

	it("recentlyApproved=7 keeps only PUBLISHED stories whose stage updated within 7 days", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ recentlyApproved: 7 }),
		);
		expect(result.map((s) => s.id)).toEqual(["approved-3d"]);
	});

	it("recentlyApproved=90 keeps both PUBLISHED stories in range", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ recentlyApproved: 90 }),
		);
		expect(result.map((s) => s.id).sort()).toEqual([
			"approved-3d",
			"approved-45d",
		]);
	});

	it("recentlyChanged=7 keeps only stories updated within 7 days", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ recentlyChanged: 7 }),
		);
		const ids = result.map((s) => s.id);
		expect(ids).toContain("updated-2d");
		expect(ids).toContain("approved-3d");
		expect(ids).toContain("not-approved");
		expect(ids).not.toContain("updated-100d");
		expect(ids).not.toContain("approved-45d");
	});

	it("recentlyAdded=7 drops stories with createdAt older than 7 days", () => {
		const addedStories = [
			makeStory({ id: "added-2d", createdAt: daysAgo(2) }),
			makeStory({ id: "added-5d", createdAt: daysAgo(5) }),
			makeStory({ id: "added-30d", createdAt: daysAgo(30) }),
			makeStory({ id: "added-100d", createdAt: daysAgo(100) }),
		];
		const result = applyRoadmapFilters(
			addedStories,
			filters({ recentlyAdded: 7 }),
		);
		const ids = result.map((s) => s.id).sort();
		expect(ids).toEqual(["added-2d", "added-5d"]);
	});
});

describe("sync filter — derivation from externalId and lastPmSyncStatus", () => {
	it("treats a story with externalId and SUCCESS as synced", () => {
		const story = makeStory({
			id: "s1",
			externalId: "JIRA-1",
			lastPmSyncStatus: "SUCCESS",
		});
		expect(
			applyRoadmapFilters([story], filters({ sync: ["synced"] })),
		).toHaveLength(1);
		expect(
			applyRoadmapFilters([story], filters({ sync: ["unsynced"] })),
		).toHaveLength(0);
	});

	it("treats a story with externalId but FAILED as unsynced", () => {
		const story = makeStory({
			id: "s2",
			externalId: "JIRA-2",
			lastPmSyncStatus: "FAILED",
		});
		expect(
			applyRoadmapFilters([story], filters({ sync: ["unsynced"] })),
		).toHaveLength(1);
		expect(
			applyRoadmapFilters([story], filters({ sync: ["synced"] })),
		).toHaveLength(0);
	});

	it("treats a story with externalId and PENDING as synced (push in flight)", () => {
		const story = makeStory({
			id: "s3",
			externalId: "JIRA-3",
			lastPmSyncStatus: "PENDING",
		});
		expect(
			applyRoadmapFilters([story], filters({ sync: ["synced"] })),
		).toHaveLength(1);
	});

	it("treats a story with externalId and CONFLICT as synced", () => {
		const story = makeStory({
			id: "s4",
			externalId: "JIRA-4",
			lastPmSyncStatus: "CONFLICT",
		});
		expect(
			applyRoadmapFilters([story], filters({ sync: ["synced"] })),
		).toHaveLength(1);
	});

	it("treats a story with externalId and null lastPmSyncStatus as synced (legacy link)", () => {
		const story = makeStory({
			id: "s5",
			externalId: "JIRA-5",
			lastPmSyncStatus: null,
		});
		expect(
			applyRoadmapFilters([story], filters({ sync: ["synced"] })),
		).toHaveLength(1);
	});

	it("treats a story without externalId as unsynced regardless of lastPmSyncStatus", () => {
		const story = makeStory({
			id: "s6",
			externalId: null,
			lastPmSyncStatus: "SUCCESS",
		});
		expect(
			applyRoadmapFilters([story], filters({ sync: ["unsynced"] })),
		).toHaveLength(1);
		expect(
			applyRoadmapFilters([story], filters({ sync: ["synced"] })),
		).toHaveLength(0);
	});
});

describe("sync filter — date range × Unsynced bucket", () => {
	const lastWeekStart = "2026-05-18";
	const lastWeekEnd = "2026-05-24";

	const unsyncedStory = makeStory({
		id: "u1",
		externalId: null,
		lastSyncedAt: null,
	});
	const syncedInRange = makeStory({
		id: "u2",
		externalId: "JIRA-99",
		lastPmSyncStatus: "SUCCESS",
		lastSyncedAt: new Date("2026-05-20T10:00:00Z"),
	});
	const syncedBefore = makeStory({
		id: "u3",
		externalId: "JIRA-100",
		lastPmSyncStatus: "SUCCESS",
		lastSyncedAt: new Date("2026-04-01T10:00:00Z"),
	});

	it("ignores the sync-date range when sync filter is only Unsynced", () => {
		const result = applyRoadmapFilters(
			[unsyncedStory, syncedInRange, syncedBefore],
			filters({
				sync: ["unsynced"],
				syncedFrom: lastWeekStart,
				syncedTo: lastWeekEnd,
			}),
		);
		expect(result.map((s) => s.id)).toEqual(["u1"]);
	});

	it("applies the sync-date range when sync filter is only Synced", () => {
		const result = applyRoadmapFilters(
			[unsyncedStory, syncedInRange, syncedBefore],
			filters({
				sync: ["synced"],
				syncedFrom: lastWeekStart,
				syncedTo: lastWeekEnd,
			}),
		);
		expect(result.map((s) => s.id)).toEqual(["u2"]);
	});

	it("applies the sync-date range when sync filter is empty", () => {
		const result = applyRoadmapFilters(
			[unsyncedStory, syncedInRange, syncedBefore],
			filters({
				syncedFrom: lastWeekStart,
				syncedTo: lastWeekEnd,
			}),
		);
		expect(result.map((s) => s.id)).toEqual(["u2"]);
	});

	it("applies the sync-date range when both buckets are selected", () => {
		const result = applyRoadmapFilters(
			[unsyncedStory, syncedInRange, syncedBefore],
			filters({
				sync: ["synced", "unsynced"],
				syncedFrom: lastWeekStart,
				syncedTo: lastWeekEnd,
			}),
		);
		// Both buckets explicitly chosen: range still applies (only synced
		// rows can satisfy it, so unsynced is excluded by the range, not
		// by the bucket filter).
		expect(result.map((s) => s.id)).toEqual(["u2"]);
	});

	it("ignores the sync-date range for the duplicate URL shape sync=[unsynced,unsynced]", () => {
		// nuqs' parseAsArrayOf doesn't dedupe, so a hand-edited
		// `?sync=unsynced,unsynced` URL produces a length-2 array. The
		// `.every()` guard must still recognize this as "only Unsynced".
		const result = applyRoadmapFilters(
			[unsyncedStory, syncedInRange, syncedBefore],
			filters({
				sync: ["unsynced", "unsynced"],
				syncedFrom: lastWeekStart,
				syncedTo: lastWeekEnd,
			}),
		);
		expect(result.map((s) => s.id)).toEqual(["u1"]);
	});
});

describe("source filter — NULL collapses to 'manual'", () => {
	it("matches sources=[manual] for an explicit MANUAL source", () => {
		const story = makeStory({ id: "n1", source: "manual" });
		expect(
			applyRoadmapFilters([story], filters({ source: ["manual"] })),
		).toHaveLength(1);
	});

	it("matches sources=[manual] for a null source (legacy row)", () => {
		const story = makeStory({
			id: "n2",
			source: null as unknown as never,
		});
		expect(
			applyRoadmapFilters([story], filters({ source: ["manual"] })),
		).toHaveLength(1);
	});

	it("does not match sources=[jira] for a null source", () => {
		const story = makeStory({
			id: "n3",
			source: null as unknown as never,
		});
		expect(
			applyRoadmapFilters([story], filters({ source: ["jira"] })),
		).toHaveLength(0);
	});
});

describe("recentlyApproved", () => {
	const recent = new Date(Date.now() - 3 * 86_400_000); // 3 days ago
	const old = new Date(Date.now() - 120 * 86_400_000); // 120 days ago

	it("returns PUBLISHED stories with a recent draftingStageUpdatedAt", () => {
		const story = makeStory({
			id: "r1",
			draftingStage: "PUBLISHED",
			draftingStageUpdatedAt: recent,
			updatedAt: old,
		});
		expect(
			applyRoadmapFilters([story], filters({ recentlyApproved: 7 })),
		).toHaveLength(1);
	});

	it("excludes legacy rows without a draftingStageUpdatedAt", () => {
		const story = makeStory({
			id: "r2",
			draftingStage: "PUBLISHED",
			draftingStageUpdatedAt: null,
			updatedAt: recent,
		});
		expect(
			applyRoadmapFilters([story], filters({ recentlyApproved: 7 })),
		).toHaveLength(0);
	});

	it("excludes PUBLISHED rows without a stage timestamp even when updatedAt is old", () => {
		const story = makeStory({
			id: "r3",
			draftingStage: "PUBLISHED",
			draftingStageUpdatedAt: null,
			updatedAt: old,
		});
		expect(
			applyRoadmapFilters([story], filters({ recentlyApproved: 7 })),
		).toHaveLength(0);
	});

	it("excludes non-PUBLISHED rows regardless of timestamp", () => {
		const story = makeStory({
			id: "r4",
			draftingStage: "DRAFT",
			draftingStageUpdatedAt: recent,
			updatedAt: recent,
		});
		expect(
			applyRoadmapFilters([story], filters({ recentlyApproved: 7 })),
		).toHaveLength(0);
	});
});

describe("recentlyChanged / recentlyAdded — timestamp comparisons", () => {
	const recent = new Date(Date.now() - 3 * 86_400_000);
	const old = new Date(Date.now() - 120 * 86_400_000);

	it("recentlyChanged matches rows with a recent genuine edit", () => {
		const story = makeStory({ id: "c1", lastEditedAt: recent });
		expect(
			applyRoadmapFilters([story], filters({ recentlyChanged: 7 })),
		).toHaveLength(1);
	});

	it("recentlyChanged excludes rows with an old genuine edit", () => {
		const story = makeStory({ id: "c2", lastEditedAt: old });
		expect(
			applyRoadmapFilters([story], filters({ recentlyChanged: 7 })),
		).toHaveLength(0);
	});

	it("recentlyChanged excludes legacy rows with no recorded edit", () => {
		const story = makeStory({
			id: "c3",
			lastEditedAt: null,
			updatedAt: recent,
		});
		expect(
			applyRoadmapFilters([story], filters({ recentlyChanged: 7 })),
		).toHaveLength(0);
	});

	it("recentlyAdded matches rows with a recent createdAt", () => {
		const story = makeStory({ id: "a1", createdAt: recent });
		expect(
			applyRoadmapFilters([story], filters({ recentlyAdded: 7 })),
		).toHaveLength(1);
	});

	it("recentlyAdded excludes rows with an old createdAt", () => {
		const story = makeStory({ id: "a2", createdAt: old });
		expect(
			applyRoadmapFilters([story], filters({ recentlyAdded: 7 })),
		).toHaveLength(0);
	});
});

describe("multi-filter AND composition (smoke)", () => {
	const stories = [
		makeStory({
			id: "m1",
			kind: "BUG",
			priority: "P0_CRITICAL",
			externalId: null,
			source: "manual",
			draftingStage: "DRAFT",
			createdAt: new Date(Date.now() - 10 * 86_400_000),
		}),
		makeStory({
			id: "m2",
			kind: "FEATURE",
			priority: "P0_CRITICAL",
			externalId: "JIRA-9001",
			lastPmSyncStatus: "SUCCESS",
			source: "jira",
			draftingStage: "PUBLISHED",
			draftingStageUpdatedAt: new Date(Date.now() - 2 * 86_400_000),
		}),
		makeStory({
			id: "m3",
			kind: "FEATURE",
			priority: "P3_LOW",
			externalId: "GL-1",
			lastPmSyncStatus: "SUCCESS",
			source: "gitlab",
			draftingStage: "DRAFT",
			description: null,
		}),
		makeStory({
			id: "m4",
			kind: "FEATURE",
			priority: "P3_LOW",
			externalId: null,
			source: "manual",
			draftingStage: "DRAFT",
			description: "has a description",
		}),
	];

	it("kind=BUG AND sync=unsynced", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ kind: ["BUG"], sync: ["unsynced"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["m1"]);
	});

	it("priority=P0_CRITICAL AND source=jira", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ priority: ["P0_CRITICAL"], source: ["jira"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["m2"]);
	});

	it("stage=PUBLISHED AND recentlyApproved=7", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ stage: ["PUBLISHED"], recentlyApproved: 7 }),
		);
		expect(result.map((s) => s.id)).toEqual(["m2"]);
	});

	it("kind=FEATURE AND source=gitlab", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ kind: ["FEATURE"], source: ["gitlab"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["m3"]);
	});

	it("priority=P3_LOW AND missingDesc=true", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ priority: ["P3_LOW"], missingDesc: true }),
		);
		expect(result.map((s) => s.id)).toEqual(["m3"]);
	});

	it("stage=DRAFT AND recentlyAdded=30", () => {
		const result = applyRoadmapFilters(
			stories,
			filters({ stage: ["DRAFT"], recentlyAdded: 30 }),
		);
		// m1 (10 days old DRAFT), m3 (now, DRAFT), m4 (now, DRAFT)
		expect(result.map((s) => s.id).sort()).toEqual(["m1", "m3", "m4"]);
	});
});

describe("selectHiddenMatches", () => {
	// A mix of visible (non-closed) and HIDDEN (CLOSED) stories. A DECLINED row
	// is included to prove it is never surfaced as a hidden match.
	const stories: UserStory[] = [
		makeStory({
			id: "v1",
			title: "OAuth login flow",
			draftingStage: "DRAFT",
			priority: "P0_CRITICAL",
		}),
		makeStory({
			id: "v2",
			title: "Dashboard charts",
			draftingStage: "PUBLISHED",
			priority: "P2_MEDIUM",
		}),
		makeStory({
			id: "h1",
			title: "OAuth token refresh",
			draftingStage: "CLOSED",
			priority: "P0_CRITICAL",
		}),
		makeStory({
			id: "h2",
			title: "Legacy login parking",
			draftingStage: "CLOSED",
			priority: "P1_HIGH",
		}),
		makeStory({
			id: "d1",
			title: "OAuth duplicate",
			draftingStage: "DECLINED",
			priority: "P0_CRITICAL",
		}),
	];

	it("returns no hidden matches when only visible items match the search", () => {
		// "charts" only appears in a visible (PUBLISHED) story.
		expect(selectHiddenMatches(stories, filters({ q: "charts" }))).toEqual(
			[],
		);
	});

	it("returns the HIDDEN items that match the search", () => {
		// "oauth" matches v1 (visible), h1 (closed), d1 (declined). Only the
		// closed row is a hidden match; declined is never surfaced.
		const result = selectHiddenMatches(stories, filters({ q: "oauth" }));
		expect(result.map((s) => s.id)).toEqual(["h1"]);
	});

	it("returns hidden matches even when NO visible item matches", () => {
		// "parking" only appears in a closed story.
		const result = selectHiddenMatches(stories, filters({ q: "parking" }));
		expect(result.map((s) => s.id)).toEqual(["h2"]);
	});

	it("never includes DECLINED items", () => {
		// The declined story's own title still yields nothing.
		expect(
			selectHiddenMatches(stories, filters({ q: "duplicate" })),
		).toEqual([]);
	});

	it("honours non-search facets on the closed subset (priority)", () => {
		// No query, but a P0_CRITICAL facet → only the critical closed item.
		const result = selectHiddenMatches(
			stories,
			filters({ priority: ["P0_CRITICAL"] }),
		);
		expect(result.map((s) => s.id)).toEqual(["h1"]);
	});

	it("excludes closed items when a non-DONE Stage facet is active", () => {
		// Closed rows derive to DONE (getMaturationStatus), so a DISCOVERY facet
		// matches none of them. A DONE facet WOULD match — board-level isolation
		// is enforced by the `stage.length > 0` bail in StoriesRoadmap, not here.
		expect(
			selectHiddenMatches(stories, filters({ stage: ["DISCOVERY"] })),
		).toEqual([]);
	});

	it("returns every closed item when the filter set is empty", () => {
		const result = selectHiddenMatches(stories, EMPTY_ROADMAP_FILTERS);
		expect(result.map((s) => s.id).sort()).toEqual(["h1", "h2"]);
	});

	it("applies order-agnostic token search to the closed subset too", () => {
		// "refresh token" (reversed word order) still matches "OAuth token refresh".
		const result = selectHiddenMatches(
			stories,
			filters({ q: "refresh token" }),
		);
		expect(result.map((s) => s.id)).toEqual(["h1"]);
	});
});

describe("applyRoadmapFilters — tags", () => {
	const stories = [
		makeStory({
			id: "a",
			tags: [{ id: "1", value: "api", createdById: null }],
		}),
		makeStory({
			id: "b",
			tags: [
				{ id: "2", value: "api", createdById: null },
				{ id: "3", value: "billing", createdById: null },
			],
		}),
		makeStory({
			id: "c",
			tags: [{ id: "4", value: "ui", createdById: null }],
		}),
	];

	it("OR: matches stories with ANY selected tag", () => {
		const r = applyRoadmapFilters(
			stories,
			filters({ tags: ["api", "ui"], tagsLogic: "OR" }),
		);
		expect(r.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
	});

	it("AND: matches only stories with ALL selected tags", () => {
		const r = applyRoadmapFilters(
			stories,
			filters({ tags: ["api", "billing"], tagsLogic: "AND" }),
		);
		expect(r.map((s) => s.id)).toEqual(["b"]);
	});

	it("empty tags is a no-op", () => {
		expect(
			applyRoadmapFilters(stories, filters({ tags: [] })),
		).toHaveLength(3);
	});

	it("counts as one active group", () => {
		expect(activeFilterGroupCount(filters({ tags: ["api"] }))).toBe(1);
		expect(activeMoreFilterCount(filters({ tags: ["api"] }))).toBe(1);
		expect(hasActiveRoadmapFilters(filters({ tags: ["api"] }))).toBe(true);
		// tagsLogic alone is a modifier — not active
		expect(hasActiveRoadmapFilters(filters({ tagsLogic: "AND" }))).toBe(
			false,
		);
	});
});

describe("applyRoadmapFilters — maturation V2 stage edge cases", () => {
	const activeStories: UserStory[] = [
		makeStory({
			id: "v2-todo",
			maturationStatus: "TO_DO",
			draftingStage: "PLACEHOLDER",
		}),
		makeStory({
			id: "v2-discovery",
			maturationStatus: "DISCOVERY",
			draftingStage: "DRAFT",
		}),
		makeStory({
			id: "v2-done",
			maturationStatus: "DONE",
			draftingStage: "PUBLISHED",
		}),
		makeStory({
			id: "legacy-discovery",
			maturationStatus: null,
			draftingStage: "ACTIVE_ANALYSIS",
		}),
		makeStory({
			id: "legacy-todo",
			maturationStatus: null,
			draftingStage: "PLACEHOLDER",
		}),
		makeStory({
			id: "legacy-done",
			maturationStatus: null,
			draftingStage: "PUBLISHED",
		}),
	];
	const closedStory = makeStory({
		id: "closed-hidden",
		maturationStatus: "DONE",
		draftingStage: "CLOSED",
	});
	const allStories = [...activeStories, closedStory];

	it("filters stories by Maturation V2 TO_DO status (explicit & derived)", () => {
		const res = applyRoadmapFilters(
			activeStories,
			filters({ stage: ["TO_DO"] }),
		);
		expect(res.map((s) => s.id).sort()).toEqual(["legacy-todo", "v2-todo"]);
	});

	it("filters stories by Maturation V2 DISCOVERY status (explicit & derived legacy stage)", () => {
		const res = applyRoadmapFilters(
			activeStories,
			filters({ stage: ["DISCOVERY"] }),
		);
		expect(res.map((s) => s.id).sort()).toEqual([
			"legacy-discovery",
			"v2-discovery",
		]);
	});

	it("excludes CLOSED items when stage filter DONE is applied over a pool containing closed stories", () => {
		const res = applyRoadmapFilters(
			allStories,
			filters({ stage: ["DONE"] }),
		);
		expect(res.map((s) => s.id).sort()).toEqual(["legacy-done", "v2-done"]);
	});

	it("selects hidden matches for CLOSED items matching stage filter", () => {
		const hidden = selectHiddenMatches(
			allStories,
			filters({ stage: ["DONE"] }),
		);
		expect(hidden.map((s) => s.id)).toEqual(["closed-hidden"]);
	});

	it("supports multi-stage V2 filter selection", () => {
		const res = applyRoadmapFilters(
			activeStories,
			filters({ stage: ["TO_DO", "DONE"] }),
		);
		expect(res.map((s) => s.id).sort()).toEqual([
			"legacy-done",
			"legacy-todo",
			"v2-done",
			"v2-todo",
		]);
	});
});
