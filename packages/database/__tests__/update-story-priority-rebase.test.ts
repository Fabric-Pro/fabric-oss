import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateStory } from "../prisma/queries/projects/stories";

const mocks = vi.hoisted(() => ({
	userStoryFindUnique: vi.fn(),
	userStoryAggregate: vi.fn(),
	userStoryUpdate: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	featureVersionCreateMany: vi.fn(),
	priorityChangeCreate: vi.fn(),
	transaction: vi.fn(),
}));

const tx = {
	userStory: {
		findUnique: mocks.userStoryFindUnique,
		aggregate: mocks.userStoryAggregate,
		update: mocks.userStoryUpdate,
		updateMany: mocks.userStoryUpdateMany,
	},
	featureVersion: { createMany: mocks.featureVersionCreateMany },
	// A band move now also writes its history row in this same transaction —
	// the rebase and the record are two halves of one change.
	storyPriorityChange: { create: mocks.priorityChangeCreate },
};

vi.mock("../prisma/client", () => ({
	db: { $transaction: mocks.transaction },
}));

beforeEach(() => {
	Object.values(mocks).forEach((m) => m.mockReset());
	mocks.transaction.mockImplementation(async (fn: any) => fn(tx));
	// Default current-story shape (no version-bump-relevant change).
	mocks.userStoryFindUnique.mockResolvedValue({
		version: 1,
		updatedAt: new Date("2026-08-10T10:00:00.000Z"),
		description: "old desc",
		acceptanceCriteria: null,
		draftingStage: "DRAFT",
		priority: "P2_MEDIUM",
		roadmapOrder: 7,
	});
	mocks.userStoryUpdate.mockResolvedValue({
		id: "story-1",
		priority: "P2_MEDIUM",
		roadmapOrder: 7,
		status: null,
		tasks: [],
	});
	mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
});

describe("updateStory — priority rebase", () => {
	it("does not aggregate when priority is omitted", async () => {
		await updateStory(
			"story-1",
			"proj-1",
			{ title: "New" },
			{ lastEditedSource: "MANUAL" },
		);
		expect(mocks.userStoryAggregate).not.toHaveBeenCalled();
		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.not.objectContaining({
					roadmapOrder: expect.anything(),
				}),
			}),
		);
	});

	// Task 5 extends the updateStory currentStory.findUnique select to read
	// `priority` so this branch becomes meaningful. Until then this assertion
	// passes trivially (aggregate is never called regardless).
	it("does not aggregate when priority equals current", async () => {
		await updateStory("story-1", "proj-1", { priority: "P2_MEDIUM" });
		expect(mocks.userStoryAggregate).not.toHaveBeenCalled();
	});

	// The product rule behind the whole history table: it records movement, not
	// evaluation. An update that names the band the story already has — which is
	// what a re-prioritization pass returns for most items — must leave no trace.
	it("writes NO history entry when the band is unchanged", async () => {
		await updateStory("story-1", "proj-1", { priority: "P2_MEDIUM" });
		expect(mocks.priorityChangeCreate).not.toHaveBeenCalled();
	});

	it("writes one history entry, with provenance, when the band moves", async () => {
		mocks.userStoryAggregate.mockResolvedValueOnce({
			_max: { roadmapOrder: 2 },
		});
		await updateStory(
			"story-1",
			"proj-1",
			{ priority: "P0_CRITICAL" },
			{
				changedBy: "user-9",
				lastEditedByName: "A. Diaz",
				lastEditedSource: "AI_BACKLOG_UPDATE",
				prioritySource: "AI",
				priorityReason: "Security exposure",
			},
		);
		expect(mocks.priorityChangeCreate).toHaveBeenCalledTimes(1);
		expect(mocks.priorityChangeCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				storyId: "story-1",
				projectId: "proj-1",
				fromPriority: "P2_MEDIUM",
				toPriority: "P0_CRITICAL",
				source: "AI",
				reason: "Security exposure",
				actorId: "user-9",
				actorName: "A. Diaz",
			}),
		});
	});

	// Most writers of `priority` (the work-item form, the public v1 API) pass no
	// provenance at all, so the default has to be the honest one.
	it("rejects an unattributed band move", async () => {
		mocks.userStoryAggregate.mockResolvedValueOnce({
			_max: { roadmapOrder: 2 },
		});
		await expect(
			updateStory("story-1", "proj-1", { priority: "P1_HIGH" }),
		).rejects.toThrow("Genuine story edits require last-edit context");
		expect(mocks.priorityChangeCreate).not.toHaveBeenCalled();
	});

	it("aggregates max+1 when priority differs and writes it via update", async () => {
		mocks.userStoryAggregate.mockResolvedValueOnce({
			_max: { roadmapOrder: 2 },
		});
		mocks.userStoryUpdate.mockResolvedValueOnce({
			id: "story-1",
			priority: "P0_CRITICAL",
			roadmapOrder: 3,
			status: null,
			tasks: [],
		});
		await updateStory(
			"story-1",
			"proj-1",
			{ priority: "P0_CRITICAL" },
			{ lastEditedSource: "MANUAL" },
		);
		expect(mocks.userStoryAggregate).toHaveBeenCalledWith({
			where: { projectId: "proj-1", priority: "P0_CRITICAL" },
			_max: { roadmapOrder: true },
		});
		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					priority: "P0_CRITICAL",
					roadmapOrder: 3,
				}),
			}),
		);
	});

	it("uses 1 when target bucket is empty (max is null)", async () => {
		mocks.userStoryAggregate.mockResolvedValueOnce({
			_max: { roadmapOrder: null },
		});
		await updateStory(
			"story-1",
			"proj-1",
			{ priority: "P3_LOW" },
			{ lastEditedSource: "MANUAL" },
		);
		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ roadmapOrder: 1 }),
			}),
		);
	});

	it("includes the rebased roadmapOrder in the version-bumped updateMany when description changes", async () => {
		mocks.userStoryAggregate.mockResolvedValueOnce({
			_max: { roadmapOrder: 5 },
		});
		mocks.userStoryUpdateMany.mockResolvedValueOnce({ count: 1 });
		// findUnique is called twice in the version-bump path: first to read
		// currentStory (default mock from beforeEach), then to return the
		// post-update story. Push the post-update result so it resolves on the
		// SECOND call, after the default currentStory shape.
		mocks.userStoryFindUnique
			.mockResolvedValueOnce({
				version: 1,
				updatedAt: new Date("2026-08-10T10:00:00.000Z"),
				description: "old desc",
				acceptanceCriteria: null,
				draftingStage: "DRAFT",
				priority: "P2_MEDIUM",
				roadmapOrder: 7,
			})
			.mockResolvedValueOnce({
				id: "story-1",
				priority: "P0_CRITICAL",
				roadmapOrder: 6,
				status: null,
				tasks: [],
			});
		await updateStory(
			"story-1",
			"proj-1",
			{ priority: "P0_CRITICAL", description: "new desc" },
			{
				userId: "u-1",
				changedBy: "u-1",
				lastEditedSource: "MANUAL",
			},
		);
		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					priority: "P0_CRITICAL",
					roadmapOrder: 6,
					version: { increment: 1 },
				}),
			}),
		);
	});
});
