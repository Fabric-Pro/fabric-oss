import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
	userStory: {
		findUnique: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		aggregate: vi.fn(),
	},
	featureVersion: { upsert: vi.fn(), createMany: vi.fn() },
	pmTicketMissingStreak: { deleteMany: vi.fn() },
	pendingPmStateChange: { updateMany: vi.fn() },
}));
vi.mock("../prisma/client", () => ({
	db: { $transaction: vi.fn(async (fn: any) => fn(tx)) },
}));

import { updateStory } from "../prisma/queries/projects/stories";

beforeEach(() => {
	vi.clearAllMocks();
	tx.userStory.findUnique.mockResolvedValue({
		version: 1,
		updatedAt: new Date("2026-08-10T10:00:00.000Z"),
		description: "d",
		acceptanceCriteria: "a",
		draftingStage: "DRAFT",
		priority: "MEDIUM",
		roadmapOrder: 1,
		externalId: "OLD",
		externalMcpServerId: "srv-1",
	});
	tx.userStory.update.mockResolvedValue({ id: "s1" });
	tx.userStory.updateMany.mockResolvedValue({ count: 1 });
});

describe("updateStory relink-clear", () => {
	it("clears streaks + supersedes PENDING FLAG_MISSING when externalId changes", async () => {
		await updateStory("s1", "p1", { externalId: "NEW" });
		expect(tx.pmTicketMissingStreak.deleteMany).toHaveBeenCalledWith({
			where: { projectId: "p1", entityType: "STORY", entityId: "s1" },
		});
		expect(tx.pendingPmStateChange.updateMany).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				entityType: "STORY",
				entityId: "s1",
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
			},
			data: { status: "DISMISSED" },
		});
	});

	it("also fires when only externalMcpServerId changes (same id, new server)", async () => {
		await updateStory("s1", "p1", { externalMcpServerId: "srv-2" });
		expect(tx.pmTicketMissingStreak.deleteMany).toHaveBeenCalled();
		expect(tx.pendingPmStateChange.updateMany).toHaveBeenCalled();
	});

	it("clears on a relink BUNDLED with a versioned edit (version path, not just early-return)", async () => {
		// description change → shouldCreateVersion → path 2 (updateMany + createMany).
		tx.userStory.updateMany.mockResolvedValue({ count: 1 });
		tx.featureVersion.createMany.mockResolvedValue({ count: 1 });
		// findUnique: 1st = currentStory (with the OLD link), 2nd = updated story.
		tx.userStory.findUnique
			.mockResolvedValueOnce({
				version: 1,
				updatedAt: new Date("2026-08-10T10:00:00.000Z"),
				description: "old",
				acceptanceCriteria: "a",
				draftingStage: "DRAFT",
				priority: "MEDIUM",
				roadmapOrder: 1,
				externalId: "OLD",
				externalMcpServerId: "srv-1",
			})
			.mockResolvedValueOnce({ id: "s1" });
		await updateStory(
			"s1",
			"p1",
			{
				externalId: "NEW",
				description: "changed",
			},
			{ lastEditedSource: "MANUAL" },
		);
		expect(tx.pmTicketMissingStreak.deleteMany).toHaveBeenCalled();
		expect(tx.pendingPmStateChange.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "DISMISSED" } }),
		);
	});

	it("does NOT clear when link identity is unchanged", async () => {
		await updateStory(
			"s1",
			"p1",
			{ title: "new title" },
			{ lastEditedSource: "MANUAL" },
		);
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
		expect(tx.pendingPmStateChange.updateMany).not.toHaveBeenCalled();
	});
});
