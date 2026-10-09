/**
 * `moveStory` only moves a story into a column of its own project (security
 * audit of the MCP gateway, finding 5).
 *
 * The status id came straight from the caller. An id belonging to another
 * project's board was written onto the story and its status row returned, so
 * the board's name and colour were readable by whoever knew the id, and the
 * story ended up in a column that does not exist in its project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storyFindUnique: vi.fn(),
	storyFindFirst: vi.fn(),
	storyUpdateMany: vi.fn(),
	statusFindFirst: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: { $transaction: mocks.transaction },
}));

import { moveStory, StoryMoveTargetNotFoundError } from "../stories";

const EDIT = {
	lastEditedByName: "Example Agent",
	lastEditedSource: "MANUAL",
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.storyFindUnique.mockResolvedValue({
		statusId: "status-a",
		lastEditedAt: new Date("2026-08-01T09:00:00.000Z"),
	});
	mocks.storyFindFirst.mockResolvedValue({ order: 1 });
	mocks.storyUpdateMany.mockResolvedValue({ count: 1 });
	mocks.statusFindFirst.mockImplementation(
		async ({ where }: { where: { id: string; projectId: string } }) =>
			where.projectId === "project-1" && where.id === "status-b"
				? { id: "status-b" }
				: null,
	);
	mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			userStory: {
				findUnique: mocks.storyFindUnique,
				findFirst: mocks.storyFindFirst,
				updateMany: mocks.storyUpdateMany,
			},
			projectStoryStatus: { findFirst: mocks.statusFindFirst },
		}),
	);
});

describe("moveStory", () => {
	it("refuses a status that belongs to another project, writing nothing", async () => {
		await expect(
			moveStory(
				"story-1",
				"project-1",
				"status-of-another-project",
				undefined,
				EDIT,
			),
		).rejects.toBeInstanceOf(StoryMoveTargetNotFoundError);

		expect(mocks.statusFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "status-of-another-project",
					projectId: "project-1",
				},
			}),
		);
		expect(mocks.storyUpdateMany).not.toHaveBeenCalled();
	});

	it("moves a story into a column of its own project", async () => {
		mocks.storyFindUnique.mockResolvedValueOnce({
			statusId: "status-a",
			lastEditedAt: new Date("2026-08-01T09:00:00.000Z"),
		});
		mocks.storyFindUnique.mockResolvedValueOnce({
			id: "story-1",
			status: { id: "status-b" },
			tasks: [],
		});

		const moved = await moveStory(
			"story-1",
			"project-1",
			"status-b",
			undefined,
			EDIT,
		);

		expect(moved.status.id).toBe("status-b");
		expect(mocks.storyUpdateMany).toHaveBeenCalledTimes(1);
	});
});
