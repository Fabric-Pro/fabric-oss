import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRawMock = vi.hoisted(() => vi.fn());

vi.mock("../../client", () => ({
	db: { $queryRaw: queryRawMock },
}));

import { listRoadmapItemsForSummary } from "../project-context-summaries";

describe("listRoadmapItemsForSummary semantic activity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("selects lastEditedAt with a creation fallback instead of updatedAt", async () => {
		const activityAt = new Date("2026-08-10T10:00:00.000Z");
		queryRawMock.mockResolvedValue([
			{
				id: "story-1",
				identifier: "F-001",
				title: "Semantic activity",
				kind: "FEATURE",
				priority: "P2_MEDIUM",
				activityAt,
				status: "Backlog",
			},
		]);

		await expect(
			listRoadmapItemsForSummary({
				projectId: "project-1",
				tenancy: { userId: "user-1", organizationId: null },
			}),
		).resolves.toEqual([expect.objectContaining({ activityAt })]);

		const sql = (queryRawMock.mock.calls[0]?.[0] as readonly string[]).join(
			"",
		);
		expect(sql).toContain(
			'COALESCE(us."lastEditedAt", us."createdAt") AS "activityAt"',
		);
		expect(sql).not.toContain('us."updatedAt"');
	});
});
