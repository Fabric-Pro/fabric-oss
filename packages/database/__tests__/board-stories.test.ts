import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	stories: vi.fn(),
	statuses: vi.fn(),
	raw: vi.fn(),
}));
vi.mock("../prisma/client", async (original) => ({
	...(await original<typeof import("../prisma/client")>()),
	db: {
		userStory: { findMany: mocks.stories },
		projectStoryStatus: { findMany: mocks.statuses },
		$queryRaw: mocks.raw,
	},
}));

import { Prisma } from "../prisma/client";
import {
	getStoriesForBoard,
	getStoriesForKanban,
	searchStoryDescriptions,
	storyTextPresent,
} from "../prisma/queries/projects/stories";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.statuses.mockResolvedValue([]);
	mocks.stories.mockResolvedValue([{ id: "example-story" }]);
	mocks.raw.mockResolvedValue([
		{
			id: "example-story",
			hasDescription: true,
			hasAcceptanceCriteria: false,
		},
	]);
});
it("selects all scalar columns except classified heavy/internal fields and omits subtasks", async () => {
	const result = await getStoriesForBoard("example-project");
	const query = mocks.stories.mock.calls[0][0];
	for (const field of Object.values(Prisma.UserStoryScalarFieldEnum)) {
		expect(query.select[field], field).toBe(
			[
				"description",
				"acceptanceCriteria",
				"releaseNotes",
				"labels",
			].includes(field)
				? undefined
				: true,
		);
	}
	expect(query.select.tasks.include.subtasks).toBeUndefined();
	expect(query.select.status).toBe(true);
	expect(query.select.tags.select).toEqual({
		id: true,
		value: true,
		createdById: true,
	});
	expect(query.select.codingRuns.take).toBe(1);
	expect(query.select.tasks.include.codingRuns.take).toBe(1);
	expect(query.where).toEqual({ projectId: "example-project" });
	expect(query.orderBy).toEqual({ order: "asc" });
	expect(result.stories[0]).toMatchObject({
		hasDescription: true,
		hasAcceptanceCriteria: false,
	});
});
it("binds literal search needles and project scope without LIKE", async () => {
	const needles = ["%", "_", "\\", "'quote"];
	await searchStoryDescriptions("example-project", needles);
	const sql = mocks.raw.mock.calls[0][0];
	expect(sql.text).toContain('s."projectId" =');
	expect(sql.text).toContain("lower(s.description) AS d");
	expect(sql.text.match(/lower\(/g)).toHaveLength(1);
	expect(sql.text.match(/OFFSET 0/g)).toHaveLength(2);
	expect(sql.text).toContain("strpos(d, n.needle) > 0");
	expect(sql.text).toContain("cardinality(needles) > 0");
	expect(sql.values).toEqual([...needles, "example-project"]);
});

it("preserves legacy ordering and coding-run relations on the lean board", async () => {
	await getStoriesForKanban("example-project");
	const legacy = mocks.stories.mock.calls[0][0];
	await getStoriesForBoard("example-project");
	const board = mocks.stories.mock.calls[1][0];
	expect(board.orderBy).toEqual(legacy.orderBy);
	expect(board.select.codingRuns).toEqual(legacy.include.codingRuns);
	expect(board.select.tasks.include.codingRuns).toEqual(
		legacy.include.tasks.include.codingRuns,
	);
	expect(board.select.tasks.orderBy).toEqual(legacy.include.tasks.orderBy);
	expect(board.select.status).toEqual(legacy.include.status);
	expect(board.select.tags).toEqual(legacy.include.tags);
});

it("checks a prefix before falling back to the full whitespace scan", () => {
	const sql = storyTextPresent("description");
	expect(sql.text).toContain(
		'CASE WHEN "description" IS NULL OR octet_length("description") = 0 THEN false WHEN translate(left("description", 64),',
	);
	expect(sql.text).toContain("THEN true ELSE translate(");
});
