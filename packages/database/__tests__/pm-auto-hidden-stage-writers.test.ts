/**
 * Unit tests verifying that `pmAutoHidden` is cleared (set false) at every
 * draftingStage writer covered by Task 5 of the PM UNHIDE producer (#1360):
 *   - updateStory (when draftingStage changes)
 *   - updateStoryDraftingStage (always)
 *   - restoreFeatureVersion (always)
 *
 * Run with: pnpm --filter @repo/database test __tests__/pm-auto-hidden-stage-writers.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Shared mocks
// ──────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	// updateStory / updateStoryDraftingStage use these via tx inside $transaction
	userStoryFindUnique: vi.fn(),
	userStoryAggregate: vi.fn(),
	userStoryUpdate: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	featureVersionCreateMany: vi.fn(),
	transaction: vi.fn(),
	// restoreFeatureVersion uses these directly + a tx
	userStoryFindFirst: vi.fn(),
	featureVersionFindFirst: vi.fn(),
	featureVersionCreate: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: mocks.transaction,
		userStory: {
			findFirst: mocks.userStoryFindFirst,
		},
		featureVersion: {
			findFirst: mocks.featureVersionFindFirst,
		},
	},
}));

// tx object passed into $transaction callbacks
const tx = {
	userStory: {
		findUnique: mocks.userStoryFindUnique,
		aggregate: mocks.userStoryAggregate,
		update: mocks.userStoryUpdate,
		updateMany: mocks.userStoryUpdateMany,
	},
	featureVersion: {
		createMany: mocks.featureVersionCreateMany,
		create: mocks.featureVersionCreate,
	},
};

import { restoreFeatureVersion } from "../prisma/queries/projects/feature-versions";
import {
	updateStory,
	updateStoryDraftingStage,
} from "../prisma/queries/projects/stories";

// ──────────────────────────────────────────────────────────────────────────────
// updateStory — pmAutoHidden cleared only when draftingStage changes
// ──────────────────────────────────────────────────────────────────────────────

describe("updateStory — pmAutoHidden cleared on stage change", () => {
	beforeEach(() => {
		Object.values(mocks).forEach((m) => m.mockReset());
		mocks.transaction.mockImplementation(async (fn: any) => fn(tx));
		mocks.userStoryFindUnique.mockResolvedValue({
			version: 1,
			updatedAt: new Date("2026-08-10T10:00:00.000Z"),
			description: "desc",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			priority: "P2_MEDIUM",
			roadmapOrder: 5,
		});
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-1",
			status: null,
			tasks: [],
		});
		mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
	});

	it("includes pmAutoHidden:false in writeData when draftingStage changes", async () => {
		// draftingStageChanged → shouldCreateVersion → goes through updateMany path.
		// Mock updateMany to return { count: 1 } and then findUnique for the
		// post-update story return.
		mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
		mocks.userStoryFindUnique
			.mockResolvedValueOnce({
				version: 1,
				updatedAt: new Date("2026-08-10T10:00:00.000Z"),
				description: "desc",
				acceptanceCriteria: null,
				draftingStage: "DRAFT",
				priority: "P2_MEDIUM",
				roadmapOrder: 5,
			})
			.mockResolvedValueOnce({ id: "story-1", status: null, tasks: [] });
		mocks.featureVersionCreateMany.mockResolvedValue({ count: 1 });

		await updateStory(
			"story-1",
			"proj-1",
			{ draftingStage: "PUBLISHED" },
			{ lastEditedSource: "MANUAL" },
		);

		// draftingStageChanged=true → version bump → goes through updateMany path.
		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ pmAutoHidden: false }),
			}),
		);
	});

	it("does NOT include pmAutoHidden when draftingStage is unchanged", async () => {
		// Pass the same stage as the current story (DRAFT)
		await updateStory("story-1", "proj-1", { draftingStage: "DRAFT" });

		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.not.objectContaining({
					pmAutoHidden: expect.anything(),
				}),
			}),
		);
	});

	it("does NOT include pmAutoHidden when no draftingStage is passed", async () => {
		await updateStory(
			"story-1",
			"proj-1",
			{ title: "New title" },
			{ lastEditedSource: "MANUAL" },
		);

		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.not.objectContaining({
					pmAutoHidden: expect.anything(),
				}),
			}),
		);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// updateStoryDraftingStage — pmAutoHidden always cleared
// ──────────────────────────────────────────────────────────────────────────────

describe("updateStoryDraftingStage — pmAutoHidden always cleared", () => {
	beforeEach(() => {
		Object.values(mocks).forEach((m) => m.mockReset());
		mocks.transaction.mockImplementation(async (fn: any) => fn(tx));
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			version: 2,
			updatedAt: new Date("2026-08-10T10:00:00.000Z"),
			description: "desc",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			status: null,
			tasks: [],
		});
		mocks.featureVersionCreateMany.mockResolvedValue({ count: 1 });
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-1",
			status: null,
			tasks: [],
		});
		mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
	});

	it("includes pmAutoHidden:false in the update data", async () => {
		await updateStoryDraftingStage("story-1", "proj-1", "PUBLISHED", {
			lastEditedSource: "MANUAL",
		});

		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					draftingStage: "PUBLISHED",
					pmAutoHidden: false,
				}),
			}),
		);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// restoreFeatureVersion — pmAutoHidden always cleared
// ──────────────────────────────────────────────────────────────────────────────

describe("restoreFeatureVersion — pmAutoHidden always cleared", () => {
	beforeEach(() => {
		Object.values(mocks).forEach((m) => m.mockReset());
		mocks.transaction.mockImplementation(async (fn: any) => fn(tx));
		// getFeatureVersion (findFirst on featureVersion)
		mocks.featureVersionFindFirst.mockResolvedValue({
			id: "fv-1",
			description: "old desc",
			acceptanceCriteria: "old AC",
			draftingStage: "DRAFT",
		});
		// getCurrentStory (findFirst on userStory)
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			version: 3,
			description: "current desc",
			acceptanceCriteria: "current AC",
			draftingStage: "CLOSED",
		});
		mocks.featureVersionCreate.mockResolvedValue({});
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-1",
			status: null,
			tasks: [],
		});
	});

	it("includes pmAutoHidden:false in the restore update data", async () => {
		await restoreFeatureVersion("story-1", "proj-1", 2, "user-1", {
			userId: "user-1",
		});

		expect(mocks.userStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ pmAutoHidden: false }),
			}),
		);
	});
});
