import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
	userStory: {
		findUnique: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		aggregate: vi.fn(),
	},
	featureVersion: { upsert: vi.fn(), createMany: vi.fn() },
	// A band move writes its history row in this same transaction.
	storyPriorityChange: { create: vi.fn() },
	pmTicketMissingStreak: { deleteMany: vi.fn() },
	pendingPmStateChange: { updateMany: vi.fn() },
}));
vi.mock("../prisma/client", () => ({
	db: { $transaction: vi.fn(async (fn: any) => fn(tx)) },
}));

import { updateStory } from "../prisma/queries/projects/stories";

const CURRENT = {
	version: 1,
	title: "Current title",
	description: "Current description",
	acceptanceCriteria: "a",
	draftingStage: "DRAFT",
	priority: "MEDIUM",
	roadmapOrder: 1,
	externalId: "EXT",
	externalMcpServerId: "srv-1",
	updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	tx.userStory.findUnique.mockResolvedValue(CURRENT);
	tx.userStory.update.mockResolvedValue({ id: "s1" });
	tx.userStory.updateMany.mockResolvedValue({ count: 1 });
	tx.featureVersion.createMany.mockResolvedValue({ count: 1 });
});

describe("updateStory — last-edit provenance stamping (IN-1)", () => {
	it("stamps lastEditedByName + lastEditedSource on a description change (versioned path)", async () => {
		// description change → shouldCreateVersion → updateMany path.
		tx.userStory.findUnique
			.mockResolvedValueOnce(CURRENT)
			.mockResolvedValueOnce({ id: "s1" });

		await updateStory(
			"s1",
			"p1",
			{ description: "new body" },
			{ lastEditedSource: "MANUAL", lastEditedByName: "Ada Lovelace" },
		);

		expect(tx.userStory.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastEditedAt: expect.any(Date),
					lastEditedByName: "Ada Lovelace",
					lastEditedSource: "MANUAL",
				}),
			}),
		);
	});

	it("stamps on a TITLE-ONLY change (regression guard: shouldCreateVersion omits title)", async () => {
		// title-only → shouldCreateVersion is FALSE → simple update path. The
		// stamp must still apply, which it wouldn't if gated on shouldCreateVersion.
		await updateStory(
			"s1",
			"p1",
			{ title: "Brand new title" },
			{ lastEditedSource: "MANUAL", lastEditedByName: "Ada Lovelace" },
		);

		expect(tx.userStory.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastEditedAt: expect.any(Date),
					lastEditedByName: "Ada Lovelace",
					lastEditedSource: "MANUAL",
				}),
			}),
		);
	});

	it("stamps a genuine metadata edit (priority only) when a source is passed", async () => {
		tx.userStory.aggregate.mockResolvedValue({
			_max: { roadmapOrder: 5 },
		});

		await updateStory(
			"s1",
			"p1",
			{ priority: "P0_CRITICAL" },
			{ lastEditedSource: "MANUAL", lastEditedByName: "Ada Lovelace" },
		);

		const writeArg = tx.userStory.updateMany.mock.calls[0]?.[0];
		expect(writeArg.data).toMatchObject({
			lastEditedAt: expect.any(Date),
			lastEditedByName: "Ada Lovelace",
			lastEditedSource: "MANUAL",
		});
	});

	it("rejects a genuine edit when its source is omitted", async () => {
		await expect(
			updateStory("s1", "p1", { title: "Brand new title" }),
		).rejects.toThrow(/require last-edit context/i);
		expect(tx.userStory.updateMany).not.toHaveBeenCalled();
	});

	it("stamps AI_BACKLOG_UPDATE with a null author for system edits", async () => {
		tx.userStory.findUnique
			.mockResolvedValueOnce(CURRENT)
			.mockResolvedValueOnce({ id: "s1" });

		await updateStory(
			"s1",
			"p1",
			{ description: "ai body" },
			{ lastEditedSource: "AI_BACKLOG_UPDATE" },
		);

		expect(tx.userStory.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastEditedAt: expect.any(Date),
					lastEditedByName: null,
					lastEditedSource: "AI_BACKLOG_UPDATE",
				}),
			}),
		);
	});
});
