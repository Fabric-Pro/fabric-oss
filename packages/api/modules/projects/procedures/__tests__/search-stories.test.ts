/**
 * Tests for searchStoriesProcedure
 *
 * Covers:
 * - Fuzzy search by title (case-insensitive)
 * - Fuzzy search by identifier
 * - Empty results when no stories match
 * - Result limit (max 10), enforced before any row body is read
 *
 * Project-access enforcement is handled by `requireProjectPermission`
 * middleware and covered by middleware tests, not here.
 *
 * Ranking itself lives in `rankStoryIdsBySemanticActivity` and is tested in
 * `@repo/database`; here it is mocked so these tests can assert what the
 * procedure ASKS for — the filter, the cap, and that it renders rows in the
 * order ranking returned.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockUserStoryFindMany, mockRankStoryIds } = vi.hoisted(
	() => ({
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		mockUserStoryFindMany: vi.fn(),
		mockRankStoryIds: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findMany: (...args: unknown[]) => mockUserStoryFindMany(...args),
		},
	},
	AI_PROVIDER_METADATA: {},
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
	normalizeStoryIdentifierQuery: (input: string) =>
		input.replace(/^(F-|B-|US-|TASK-)/i, ""),
}));

vi.mock(
	"@repo/database/prisma/queries/projects/story-activity-ranking",
	() => ({
		rankStoryIdsBySemanticActivity: mockRankStoryIds,
	}),
);

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.searchStories = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Register the handler.
import "../search-stories";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function makeStory(id: string, identifier: string, title: string) {
	return { id, identifier, title, status: { name: "Backlog" } };
}

/** Rank returns these ids; the row fetch returns their rows, unordered. */
function stubSearch(stories: ReturnType<typeof makeStory>[]) {
	mockRankStoryIds.mockResolvedValue(stories.map((story) => story.id));
	mockUserStoryFindMany.mockResolvedValue([...stories].reverse());
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("searchStoriesProcedure — fuzzy search", () => {
	it("returns stories matching title (case-insensitive)", async () => {
		stubSearch([
			makeStory("s1", "F-001", "Build login page"),
			makeStory("s2", "F-002", "Build signup page"),
		]);

		const result = (await handlers.searchStories({
			input: {
				projectId: "proj-1",
				query: "login",
				organizationId: null,
			},
			context: ctx,
		})) as { stories: Array<{ id: string; title: string }> };

		expect(result.stories).toHaveLength(2);
		expect(mockRankStoryIds).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				OR: expect.arrayContaining([
					expect.objectContaining({
						title: { contains: "login", mode: "insensitive" },
					}),
				]),
			}),
			10,
		);
	});

	it("returns stories matching identifier", async () => {
		stubSearch([makeStory("s1", "F-042", "Some feature")]);

		const result = (await handlers.searchStories({
			input: {
				projectId: "proj-1",
				query: "F-042",
				organizationId: null,
			},
			context: ctx,
		})) as { stories: Array<{ identifier: string }> };

		expect(result.stories).toHaveLength(1);
		expect(result.stories[0].identifier).toBe("F-042");
	});

	it("renders rows in ranked order, not the order the database returned", async () => {
		stubSearch([
			makeStory("newest", "F-003", "Newest"),
			makeStory("middle", "F-002", "Middle"),
			makeStory("oldest", "F-001", "Oldest"),
		]);

		const result = (await handlers.searchStories({
			input: { projectId: "proj-1", query: "test", organizationId: null },
			context: ctx,
		})) as { stories: Array<{ id: string }> };

		expect(result.stories.map((story) => story.id)).toEqual([
			"newest",
			"middle",
			"oldest",
		]);
	});

	// The search matches on `description`, so reading rows before capping would
	// pull every matching body on an autocomplete keystroke. The cap has to be
	// applied by ranking, and the row read restricted to what ranking returned.
	it("reads only the ranked ids, never an uncapped row query", async () => {
		stubSearch([makeStory("s1", "F-001", "Only match")]);

		await handlers.searchStories({
			input: { projectId: "proj-1", query: "test", organizationId: null },
			context: ctx,
		});

		expect(mockRankStoryIds).toHaveBeenCalledWith(expect.anything(), 10);
		expect(mockUserStoryFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj-1", id: { in: ["s1"] } },
			}),
		);
		const rowQuery = mockUserStoryFindMany.mock.calls[0][0] as {
			select?: Record<string, unknown>;
		};
		expect(rowQuery.select).not.toHaveProperty("description");
	});
});

describe("searchStoriesProcedure — empty results", () => {
	it("returns empty array when no stories match", async () => {
		mockRankStoryIds.mockResolvedValue([]);

		const result = (await handlers.searchStories({
			input: {
				projectId: "proj-1",
				query: "nonexistent",
				organizationId: null,
			},
			context: ctx,
		})) as { stories: unknown[] };

		expect(result.stories).toEqual([]);
		// Nothing ranked means nothing to read.
		expect(mockUserStoryFindMany).not.toHaveBeenCalled();
	});
});

describe("searchStoriesProcedure — extended coverage", () => {
	it("matches externalId and description, scoped to the project", async () => {
		mockRankStoryIds.mockResolvedValue([]);

		await handlers.searchStories({
			input: {
				projectId: "proj-1",
				query: "maturation",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mockRankStoryIds).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				OR: expect.arrayContaining([
					expect.objectContaining({
						externalId: {
							contains: "maturation",
							mode: "insensitive",
						},
					}),
					expect.objectContaining({
						description: {
							contains: "maturation",
							mode: "insensitive",
						},
					}),
				]),
			}),
			10,
		);
	});

	it("strips a legacy identifier prefix into an extra OR clause", async () => {
		mockRankStoryIds.mockResolvedValue([]);

		await handlers.searchStories({
			input: {
				projectId: "proj-1",
				query: "B-011",
				organizationId: null,
			},
			context: ctx,
		});

		const where = mockRankStoryIds.mock.calls[0][0] as {
			OR: Array<Record<string, { contains?: string }>>;
		};
		const identifierNeedles = where.OR.filter(
			(clause) => clause.identifier,
		).map((clause) => clause.identifier?.contains);
		expect(identifierNeedles).toContain("b-011");
		expect(identifierNeedles).toContain("011");
	});
});
