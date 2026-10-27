/** Query shape for the MCP feature-list summary path. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { storyFindMany, storyFindFirst, storyCount, taskGroupBy } = vi.hoisted(
	() => ({
		storyFindMany: vi.fn(),
		storyFindFirst: vi.fn(),
		storyCount: vi.fn(),
		taskGroupBy: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		userStory: {
			findMany: storyFindMany,
			findFirst: storyFindFirst,
			count: storyCount,
		},
		storyTask: { groupBy: taskGroupBy },
	},
	Prisma: {},
}));

import {
	getStorySummaryById,
	listStorySummaries,
} from "../prisma/queries/projects/stories";

beforeEach(() => {
	vi.clearAllMocks();
	storyFindMany.mockResolvedValue([
		{
			id: "story-1",
			identifier: "F-1",
			title: "Export roadmap",
			kind: "FEATURE",
			priority: "P2_MEDIUM",
			size: null,
			storyPoints: null,
			draftingStage: "DRAFT",
			assigneeId: null,
			externalUrl: null,
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
			status: { id: "status-1", name: "Backlog", color: "#fff" },
		},
	]);
	storyCount.mockResolvedValue(1);
	taskGroupBy.mockResolvedValue([
		{ storyId: "story-1", isCompleted: false, _count: { _all: 1 } },
		{ storyId: "story-1", isCompleted: true, _count: { _all: 2 } },
	]);
});

describe("listStorySummaries", () => {
	it("requests updated order and a unique tie-breaker before database paging", async () => {
		const rows = [
			{ id: "c", identifier: "F-001", updatedAt: new Date("2026-01-01") },
			{ id: "b", identifier: "F-002", updatedAt: new Date("2026-01-03") },
			{ id: "a", identifier: "F-003", updatedAt: new Date("2026-01-03") },
		];
		// Model the database's requested ORDER BY, then OFFSET/LIMIT. A missing
		// database order or an activity-side sort cannot produce these pages.
		storyFindMany.mockImplementation(
			async ({ orderBy, take, skip, select }) => {
				expect(orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }]);
				expect(select.updatedAt).toBe(true);
				return [...rows]
					.sort(
						(a, b) =>
							b.updatedAt.getTime() - a.updatedAt.getTime() ||
							a.id.localeCompare(b.id),
					)
					.slice(skip, skip + take);
			},
		);
		storyCount.mockResolvedValue(3);
		const first = await listStorySummaries({
			projectId: "proj-1",
			orderBy: "updated",
			limit: 1,
		});
		const second = await listStorySummaries({
			projectId: "proj-1",
			orderBy: "updated",
			limit: 1,
			offset: 1,
		});
		const third = await listStorySummaries({
			projectId: "proj-1",
			orderBy: "updated",
			limit: 1,
			offset: 2,
		});
		expect(
			[first, second, third].flatMap((page) =>
				page.stories.map((row) => row.id),
			),
		).toEqual(["a", "b", "c"]);
		expect(first.total).toBe(3);
		expect(storyFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj-1" },
				take: 1,
				skip: 1,
			}),
		);
	});

	it("preserves numeric identifier ordering across pages", async () => {
		const rows = [
			{ id: "a", identifier: "F-100" },
			{ id: "b", identifier: "F-9" },
			{ id: "c", identifier: "F-094" },
		];
		storyFindMany.mockImplementation(async ({ where }) =>
			where.id
				? rows.filter((row) => where.id.in.includes(row.id))
				: rows,
		);
		const first = await listStorySummaries({
			projectId: "proj-1",
			orderBy: "identifier",
			limit: 2,
		});
		const second = await listStorySummaries({
			projectId: "proj-1",
			orderBy: "identifier",
			limit: 2,
			offset: 2,
		});
		expect(
			[...first.stories, ...second.stories].map((row) => row.identifier),
		).toEqual(["F-9", "F-094", "F-100"]);
	});

	it("loads only metadata and exact aggregate task counts", async () => {
		const result = await listStorySummaries({ projectId: "proj-1" });

		expect(result.stories[0]).toMatchObject({
			id: "story-1",
			taskCount: 3,
			completedTaskCount: 2,
		});
		const select = storyFindMany.mock.calls[0][0].select;
		expect(select.tasks).toBeUndefined();
		expect(select.description).toBeUndefined();
		expect(select._count).toBeUndefined();
		expect(taskGroupBy).toHaveBeenCalledWith({
			by: ["storyId", "isCompleted"],
			where: { storyId: { in: ["story-1"] } },
			_count: { _all: true },
		});
	});
});

describe("getStorySummaryById", () => {
	it("does not expand the full story contract", async () => {
		storyFindFirst.mockResolvedValue({
			id: "story-1",
			identifier: "F-1",
			maturationStatus: "DRAFT",
		});

		await getStorySummaryById("story-1", "proj-1");

		expect(storyFindFirst).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			select: { id: true, identifier: true, maturationStatus: true },
		});
	});
});
