/**
 * Unit tests for `applyTerminalUnhide` — reverses an auto-hide for a STORY.
 * Task 3 of the PM terminal-status UNHIDE producer (#1360).
 *
 * Run with: pnpm --filter @repo/database test __tests__/apply-terminal-unhide.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userStoryFindUnique: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	featureVersionUpsert: vi.fn(),
	transaction: vi.fn(),
}));

// The tx client exposed inside db.$transaction(cb). The STORY unhide runs its
// guarded compare-and-swap (updateMany) + version snapshot against THIS client
// so they commit/roll back atomically (#1360).
const tx = {
	userStory: { updateMany: mocks.userStoryUpdateMany },
	featureVersion: { upsert: mocks.featureVersionUpsert },
};

vi.mock("../prisma/client", () => ({
	db: {
		userStory: {
			findUnique: mocks.userStoryFindUnique,
			updateMany: mocks.userStoryUpdateMany,
		},
		featureVersion: { upsert: mocks.featureVersionUpsert },
		$transaction: mocks.transaction,
	},
}));

import {
	type ApplyTerminalUnhideParams,
	applyTerminalUnhide,
} from "../prisma/queries/apply-terminal-unhide";

const BASE = {
	entityType: "STORY",
	entityId: "story-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: null,
	changeDescription: "Auto-unhidden: PM ticket reopened",
} satisfies ApplyTerminalUnhideParams;

beforeEach(() => {
	Object.values(mocks).forEach((m) => m.mockReset());
	mocks.userStoryFindUnique.mockResolvedValue({
		id: "story-1",
		version: 5,
		description: "Feature desc",
		acceptanceCriteria: "AC text",
		draftingStage: "CLOSED",
		pmAutoHidden: true,
	});
	mocks.featureVersionUpsert.mockResolvedValue({});
	// Default: the guarded compare-and-swap wins the race (this writer).
	mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
	// Run the transaction callback with the shared tx client.
	mocks.transaction.mockImplementation(
		async (fn: (t: typeof tx) => unknown) => fn(tx),
	);
});

describe("applyTerminalUnhide", () => {
	it("returns { applied: true } and creates a FeatureVersion at version+1 with draftingStage DRAFT", async () => {
		const result = await applyTerminalUnhide(BASE);

		expect(result).toEqual({ applied: true });
		expect(mocks.featureVersionUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					version: 6,
					draftingStage: "DRAFT",
					storyId: "story-1",
				}),
			}),
		);
	});

	it("transitions the story via a guarded updateMany (CAS on CLOSED + pmAutoHidden + version) to DRAFT with cleared terminal markers", async () => {
		await applyTerminalUnhide(BASE);

		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "story-1",
					projectId: "proj-1",
					draftingStage: "CLOSED",
					pmAutoHidden: true,
					version: 5,
				}),
				data: expect.objectContaining({
					draftingStage: "DRAFT",
					pmAutoHidden: false,
					pmTicketTerminal: false,
					pmTicketTerminalStatus: null,
					version: 6,
				}),
			}),
		);
	});

	it("returns { applied: false } and writes NO FeatureVersion when the guarded updateMany loses the race (count 0)", async () => {
		// Both writers passed the pre-tx findUnique guard at version 5; the other
		// writer committed first, so this writer's CAS predicate matches 0 rows.
		mocks.userStoryUpdateMany.mockResolvedValue({ count: 0 });

		const result = await applyTerminalUnhide(BASE);

		expect(result).toEqual({ applied: false });
		expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
	});

	it("returns { applied: false } without any write when story is not found", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(null);
		const result = await applyTerminalUnhide(BASE);
		expect(result).toEqual({ applied: false });
		expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
		expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
	});

	it("returns { applied: false } without any write when story is not CLOSED (idempotency guard)", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			version: 5,
			description: "Feature desc",
			acceptanceCriteria: "AC text",
			draftingStage: "DRAFT", // already unhidden
			pmAutoHidden: true,
		});
		const result = await applyTerminalUnhide(BASE);
		expect(result).toEqual({ applied: false });
		expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
		expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
	});

	it("returns { applied: false } without any write when pmAutoHidden is false (not auto-hidden)", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			version: 5,
			description: "Feature desc",
			acceptanceCriteria: "AC text",
			draftingStage: "CLOSED",
			pmAutoHidden: false, // manually closed, not auto-hidden
		});
		const result = await applyTerminalUnhide(BASE);
		expect(result).toEqual({ applied: false });
		expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
		expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
	});

	it("passes changeDescription to the FeatureVersion", async () => {
		await applyTerminalUnhide({
			...BASE,
			changeDescription: "custom reason",
		});

		expect(mocks.featureVersionUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					changeDescription: "custom reason",
				}),
			}),
		);
	});

	describe("legacy EPIC/FEATURE rows are no-ops (folder tables dropped)", () => {
		it.each(["EPIC", "FEATURE"] as const)(
			"%s: returns { applied: false } without touching the DB",
			async (entityType) => {
				const result = await applyTerminalUnhide({
					...BASE,
					entityType,
					entityId: "legacy-1",
				});

				expect(result).toEqual({ applied: false });
				expect(mocks.userStoryFindUnique).not.toHaveBeenCalled();
				expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
				expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
				expect(mocks.transaction).not.toHaveBeenCalled();
			},
		);
	});
});
