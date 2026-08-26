import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMany } = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { pendingPmStateChange: { deleteMany } },
}));

import { clearPendingContentDrift } from "../prisma/queries/pending-pm-state-changes";

beforeEach(() => deleteMany.mockReset());

describe("clearPendingContentDrift", () => {
	it("deletes only PENDING CONTENT_DRIFT rows for the entity and returns the count", async () => {
		deleteMany.mockResolvedValue({ count: 1 });
		const n = await clearPendingContentDrift({
			projectId: "proj_1",
			entityType: "STORY",
			entityId: "story_1",
		});
		expect(n).toBe(1);
		expect(deleteMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj_1",
				entityType: "STORY",
				entityId: "story_1",
				proposedAction: "CONTENT_DRIFT",
				status: "PENDING",
			},
		});
	});

	it("returns 0 when there is nothing to clear", async () => {
		deleteMany.mockResolvedValue({ count: 0 });
		expect(
			await clearPendingContentDrift({
				projectId: "p",
				entityType: "STORY",
				entityId: "s",
			}),
		).toBe(0);
	});
});
