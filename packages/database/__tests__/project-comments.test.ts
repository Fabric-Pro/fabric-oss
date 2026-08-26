import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storyFindFirst: vi.fn(),
	taskFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		userStoryComment: {
			findFirst: mocks.storyFindFirst,
		},
		storyTaskComment: {
			findFirst: mocks.taskFindFirst,
		},
	},
}));

import {
	findRecentDuplicateStoryComment,
	findRecentDuplicateTaskComment,
} from "../prisma/queries/projects/comments";

describe("comment duplicate lookup", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
		mocks.storyFindFirst.mockReset();
		mocks.taskFindFirst.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("looks for duplicate story comments in the same personal tenant window", async () => {
		mocks.storyFindFirst.mockResolvedValue({ id: "comment-1" });

		const result = await findRecentDuplicateStoryComment({
			storyId: "story-1",
			authorId: "user-1",
			content: "@fabric summarize this",
			organizationId: null,
		});

		expect(result).toEqual({ id: "comment-1" });
		expect(mocks.storyFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					storyId: "story-1",
					authorId: "user-1",
					authorType: "USER",
					content: "@fabric summarize this",
					organizationId: null,
					deletedAt: null,
					createdAt: {
						gte: new Date("2026-04-28T11:59:50.000Z"),
					},
				}),
				orderBy: { createdAt: "desc" },
			}),
		);
	});

	it("looks for duplicate task comments in the same organization tenant window", async () => {
		mocks.taskFindFirst.mockResolvedValue({ id: "comment-2" });

		const result = await findRecentDuplicateTaskComment({
			taskId: "task-1",
			authorId: "user-1",
			content: "same content",
			organizationId: "org-1",
		});

		expect(result).toEqual({ id: "comment-2" });
		expect(mocks.taskFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					taskId: "task-1",
					authorId: "user-1",
					authorType: "USER",
					content: "same content",
					organizationId: "org-1",
					deletedAt: null,
					createdAt: {
						gte: new Date("2026-04-28T11:59:50.000Z"),
					},
				}),
				orderBy: { createdAt: "desc" },
			}),
		);
	});

	it("scopes the story duplicate lookup by parentId when replying", async () => {
		mocks.storyFindFirst.mockResolvedValue(null);
		await findRecentDuplicateStoryComment({
			storyId: "story-1",
			authorId: "user-1",
			content: "thanks",
			organizationId: null,
			parentId: "parent-1",
		});
		expect(mocks.storyFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ parentId: "parent-1" }),
			}),
		);
	});

	it("defaults the story duplicate lookup parentId to null for root comments", async () => {
		mocks.storyFindFirst.mockResolvedValue(null);
		await findRecentDuplicateStoryComment({
			storyId: "story-1",
			authorId: "user-1",
			content: "thanks",
			organizationId: null,
		});
		expect(mocks.storyFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ parentId: null }),
			}),
		);
	});

	it("scopes the task duplicate lookup by parentId when replying", async () => {
		mocks.taskFindFirst.mockResolvedValue(null);
		await findRecentDuplicateTaskComment({
			taskId: "task-1",
			authorId: "user-1",
			content: "thanks",
			organizationId: "org-1",
			parentId: "parent-1",
		});
		expect(mocks.taskFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ parentId: "parent-1" }),
			}),
		);
	});

	it("defaults the task duplicate lookup parentId to null for root comments", async () => {
		mocks.taskFindFirst.mockResolvedValue(null);
		await findRecentDuplicateTaskComment({
			taskId: "task-1",
			authorId: "user-1",
			content: "thanks",
			organizationId: "org-1",
		});
		expect(mocks.taskFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ parentId: null }),
			}),
		);
	});
});
