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
