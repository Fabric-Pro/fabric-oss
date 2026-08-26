import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	userStory: { findMany: vi.fn() },
	featureVersion: { findMany: vi.fn() },
	storyTask: { findMany: vi.fn() },
}));

vi.mock("@repo/database", () => ({ db: dbMock }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { collectStoryActivity } from "../collect-story-activity";

const start = new Date("2026-08-01T00:00:00.000Z");
const end = new Date("2026-08-02T00:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.featureVersion.findMany.mockResolvedValue([]);
	dbMock.storyTask.findMany.mockResolvedValue([]);
});

describe("collectStoryActivity", () => {
	it("emits creation and genuine-edit events without consulting updatedAt", async () => {
		const createdAt = new Date("2026-08-01T08:00:00.000Z");
		const lastEditedAt = new Date("2026-08-01T12:00:00.000Z");
		dbMock.userStory.findMany.mockResolvedValue([
			{
				id: "created",
				identifier: "US-1",
				title: "Created story",
				createdById: "creator",
				createdAt,
				lastEditedAt: null,
				status: { name: "Backlog" },
			},
			{
				id: "edited",
				identifier: "US-2",
				title: "Edited story",
				createdById: "creator",
				createdAt: new Date("2026-07-01T00:00:00.000Z"),
				lastEditedAt,
				status: { name: "In Progress" },
			},
		]);

		const result = await collectStoryActivity({
			projectId: "project-1",
			organizationId: null,
			timeWindowStart: start,
			timeWindowEnd: end,
		});

		expect(result.stories).toEqual([
			expect.objectContaining({ kind: "created", occurredAt: createdAt }),
			expect.objectContaining({
				kind: "content_changed",
				occurredAt: lastEditedAt,
			}),
		]);
		expect(dbMock.userStory.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [
						{ createdAt: { gte: start, lte: end } },
						{ lastEditedAt: { gte: start, lte: end } },
					],
				}),
				select: expect.not.objectContaining({ updatedAt: true }),
			}),
		);
	});
});
