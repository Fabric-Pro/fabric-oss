/**
 * Unit tests for `applyTerminalClose` (#1360).
 *
 * Task 2 of the PM terminal-status reconcile makes the lifecycle DB writes
 * transactional + idempotent so the scheduled poll and a future manual Pull
 * can both call them concurrently without (a) duplicate FeatureVersion history
 * rows or (b) state-written-but-history-missing corruption.
 *
 * Contract under test:
 *   - STORY close runs a guarded `updateMany` (predicate on id + projectId +
 *     current draftingStage + version) and the `createFeatureVersion` write in
 *     a single `db.$transaction`, returning `{ applied: boolean }`.
 *   - `applied` is false when the story is missing, already CLOSED, or the
 *     guarded `updateMany` count !== 1 (a concurrent writer won the race).
 *   - Legacy EPIC/FEATURE pending rows are no-ops returning
 *     `{ applied: false }` (the Epic/Feature folder tables were dropped).
 *   - A version-write failure rolls back the row transition (atomicity).
 *
 * Run with: pnpm --filter @repo/database test __tests__/apply-terminal-close.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userStoryFindUnique: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	featureVersionUpsert: vi.fn(),
	transaction: vi.fn(),
}));

// The tx client exposed inside db.$transaction(cb). The guarded updateMany and
// the createFeatureVersion upsert must run against THIS client (same tx) so
// they commit/roll back atomically.
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

import { applyTerminalClose } from "../prisma/queries/apply-terminal-close";

const STORY_BASE = {
	entityType: "STORY" as const,
	entityId: "story-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: null,
	changeDescription: "Terminal status: Closed",
};

beforeEach(() => {
	Object.values(mocks).forEach((m) => m.mockReset());
	// Default: a fresh DRAFT story at version 3.
	mocks.userStoryFindUnique.mockResolvedValue({
		id: "story-1",
		version: 3,
		description: "desc",
		acceptanceCriteria: null,
		draftingStage: "DRAFT",
	});
	mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
	mocks.featureVersionUpsert.mockResolvedValue({});
	// Run the transaction callback with the shared tx client.
	mocks.transaction.mockImplementation(
		async (fn: (t: typeof tx) => unknown) => fn(tx),
	);
});

describe("applyTerminalClose — STORY transactional guarded close", () => {
	it("returns { applied: true } and writes version + row in one transaction", async () => {
		const result = await applyTerminalClose({
			...STORY_BASE,
			markAutoHidden: true,
		});

		expect(result).toEqual({ applied: true });
		// The whole STORY write happens inside db.$transaction.
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		// Guarded updateMany predicate includes the optimistic-lock columns.
		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "story-1",
					projectId: "proj-1",
					draftingStage: "DRAFT",
					version: 3,
				}),
				data: expect.objectContaining({
					draftingStage: "CLOSED",
					version: 4,
					pmAutoHidden: true,
				}),
			}),
		);
		// Version snapshot written exactly once, in the same tx.
		expect(mocks.featureVersionUpsert).toHaveBeenCalledTimes(1);
	});

	it("sets pmAutoHidden:false when markAutoHidden is omitted (STORY)", async () => {
		await applyTerminalClose({ ...STORY_BASE });

		expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ pmAutoHidden: false }),
			}),
		);
	});

	it("is idempotent: second call with stale precondition is a no-op", async () => {
		// First call: DRAFT story → transitions to CLOSED, one FeatureVersion.
		mocks.userStoryFindUnique.mockResolvedValueOnce({
			id: "story-1",
			version: 3,
			description: "desc",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
		});
		mocks.userStoryUpdateMany.mockResolvedValueOnce({ count: 1 });

		const first = await applyTerminalClose({ ...STORY_BASE });
		expect(first).toEqual({ applied: true });

		// Second call: story already CLOSED → short-circuits, no write.
		mocks.userStoryFindUnique.mockResolvedValueOnce({
			id: "story-1",
			version: 4,
			description: "desc",
			acceptanceCriteria: null,
			draftingStage: "CLOSED",
		});

		const second = await applyTerminalClose({ ...STORY_BASE });
		expect(second).toEqual({ applied: false });

		// Exactly one version snapshot across both calls (no duplicate history).
		expect(mocks.featureVersionUpsert).toHaveBeenCalledTimes(1);
	});

	it("returns { applied: false } when the guarded updateMany loses the race (count 0)", async () => {
		// A concurrent writer already flipped the row between findUnique and the
		// guarded updateMany → predicate matches 0 rows → no version row written.
		mocks.userStoryUpdateMany.mockResolvedValue({ count: 0 });

		const result = await applyTerminalClose({ ...STORY_BASE });

		expect(result).toEqual({ applied: false });
		expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
	});

	it("returns { applied: false } when the story is missing", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(null);

		const result = await applyTerminalClose({ ...STORY_BASE });

		expect(result).toEqual({ applied: false });
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
	});

	it("rolls back the row transition when the version write fails (atomicity)", async () => {
		// The guarded updateMany succeeds but createFeatureVersion throws — the
		// error must propagate so the surrounding transaction rolls back the row.
		mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
		mocks.featureVersionUpsert.mockRejectedValue(
			new Error("version write boom"),
		);

		await expect(applyTerminalClose({ ...STORY_BASE })).rejects.toThrow(
			"version write boom",
		);

		// The write was attempted inside the transaction (so a real tx rolls back).
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.userStoryUpdateMany).toHaveBeenCalledTimes(1);
	});
});

describe("applyTerminalClose — legacy EPIC/FEATURE rows are no-ops", () => {
	it.each(["EPIC", "FEATURE"] as const)(
		"%s: returns { applied: false } without touching the DB (folder tables dropped)",
		async (entityType) => {
			const result = await applyTerminalClose({
				...STORY_BASE,
				entityType,
				markAutoHidden: true,
			});

			expect(result).toEqual({ applied: false });
			expect(mocks.userStoryFindUnique).not.toHaveBeenCalled();
			expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
			expect(mocks.featureVersionUpsert).not.toHaveBeenCalled();
			expect(mocks.transaction).not.toHaveBeenCalled();
		},
	);
});
