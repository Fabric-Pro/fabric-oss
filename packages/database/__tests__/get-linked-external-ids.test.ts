import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { userStory: { findMany } },
}));

import { getLinkedExternalIds } from "../prisma/queries/pending-pm-state-changes";

beforeEach(() => findMany.mockReset());

describe("getLinkedExternalIds", () => {
	it("selects and returns draftingStage + pmAutoHidden for the poll classifier", async () => {
		findMany.mockResolvedValue([
			{
				id: "story_1",
				externalId: "123",
				draftingStage: "CLOSED",
				pmAutoHidden: true,
				lastSyncedPmHash: "h",
				lastPmSyncStatus: null,
			},
		]);
		const rows = await getLinkedExternalIds("proj_1");
		expect(findMany).toHaveBeenCalledWith({
			where: { projectId: "proj_1", externalId: { not: null } },
			select: {
				id: true,
				externalId: true,
				draftingStage: true,
				pmAutoHidden: true,
				lastSyncedPmHash: true,
				lastPmSyncStatus: true,
			},
		});
		expect(rows[0]).toEqual({
			entityType: "STORY",
			entityId: "story_1",
			externalId: "123",
			draftingStage: "CLOSED",
			pmAutoHidden: true,
			lastSyncedPmHash: "h",
			lastPmSyncStatus: null,
		});
	});
});
