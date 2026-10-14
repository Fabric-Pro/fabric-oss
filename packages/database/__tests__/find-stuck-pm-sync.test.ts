/**
 * Unit tests for `findStuckPmSyncItems` — the watchdog query that flags
 * PM-sync rows stuck in PENDING longer than the cutoff (default 10 min).
 *
 * Mocks the Prisma client — no real DB. Covers the itemType mapping
 * (`UserStory.kind === BUG` → `"bug"`, otherwise `"story"`, test cases →
 * `"testCase"`), the attempt id and pending-since bound each item carries,
 * and the merged oldest-first cap. Stories are the only work-item rows since
 * the Epic/Feature folder tables were dropped.
 *
 * Run with: pnpm --filter @repo/database test __tests__/find-stuck-pm-sync.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { storyFindMany, testCaseFindMany } = vi.hoisted(() => ({
	storyFindMany: vi.fn(),
	testCaseFindMany: vi.fn(),
}));

vi.mock("../prisma/client", async () => {
	const actual =
		await vi.importActual<typeof import("../prisma/client")>(
			"../prisma/client",
		);
	return {
		PmSyncStatus: actual.PmSyncStatus,
		db: {
			userStory: { findMany: storyFindMany },
			testCase: { findMany: testCaseFindMany },
		},
	};
});

import { findStuckPmSyncItems } from "../prisma/queries/projects/find-stuck-pm-sync";

const NOW = new Date("2026-05-28T12:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - 10 * 60 * 1000);
const OLD_ATTEMPT_1 = new Date(NOW.getTime() - 15 * 60 * 1000);
const OLD_ATTEMPT_2 = new Date(NOW.getTime() - 11 * 60 * 1000);

beforeEach(() => {
	storyFindMany.mockReset();
	testCaseFindMany.mockReset().mockResolvedValue([]);
});

describe("findStuckPmSyncItems", () => {
	it("returns stories with itemType correctly mapped (BUG → bug)", async () => {
		storyFindMany.mockResolvedValueOnce([
			{
				id: "bug-1",
				kind: "BUG",
				lastPmSyncAttemptAt: OLD_ATTEMPT_1,
			},
			{
				id: "story-1",
				kind: "FEATURE",
				lastPmSyncAttemptAt: OLD_ATTEMPT_2,
			},
		]);

		const items = await findStuckPmSyncItems({ olderThan: CUTOFF });

		expect(items.map((i) => i.itemId)).toEqual(["bug-1", "story-1"]);
		// itemType dispatch: BUG → "bug", non-BUG UserStory → "story"
		expect(items.find((i) => i.itemId === "bug-1")?.itemType).toBe("bug");
		expect(items.find((i) => i.itemId === "story-1")?.itemType).toBe(
			"story",
		);
	});

	it("propagates the olderThan cutoff into the Prisma where clause", async () => {
		storyFindMany.mockResolvedValueOnce([]);

		await findStuckPmSyncItems({ olderThan: CUTOFF });

		const arg = storyFindMany.mock.calls[0]?.[0] as {
			where: {
				lastPmSyncStatus: string;
				lastPmSyncAttemptAt: { lt: Date };
			};
		};
		expect(arg.where.lastPmSyncStatus).toBe("PENDING");
		expect(arg.where.lastPmSyncAttemptAt.lt).toEqual(CUTOFF);
	});

	it("skips rows whose lastPmSyncAttemptAt is null (defensive)", async () => {
		storyFindMany.mockResolvedValueOnce([
			{ id: "story-no-ts", kind: "FEATURE", lastPmSyncAttemptAt: null },
			{
				id: "story-with-ts",
				kind: "FEATURE",
				lastPmSyncAttemptAt: OLD_ATTEMPT_1,
			},
		]);

		const items = await findStuckPmSyncItems({ olderThan: CUTOFF });

		expect(items.map((i) => i.itemId)).toEqual(["story-with-ts"]);
	});

	it("honors the per-call `limit` cap (default 200)", async () => {
		storyFindMany.mockResolvedValueOnce([]);

		await findStuckPmSyncItems({ olderThan: CUTOFF, limit: 25 });

		expect(storyFindMany.mock.calls[0]?.[0]).toMatchObject({ take: 25 });
	});

	it("orders by lastPmSyncAttemptAt asc so the watchdog drains the most-stuck rows first", async () => {
		storyFindMany.mockResolvedValueOnce([]);

		await findStuckPmSyncItems({ olderThan: CUTOFF });

		expect(storyFindMany.mock.calls[0]?.[0]).toMatchObject({
			orderBy: { lastPmSyncAttemptAt: "asc" },
		});
	});

	it("returns an empty array when nothing is stuck", async () => {
		storyFindMany.mockResolvedValueOnce([]);

		const items = await findStuckPmSyncItems({ olderThan: CUTOFF });
		expect(items).toEqual([]);
	});

	it("carries the attempt id and pending-since, falling back to the attempt time for rows stamped before pending-since existed", async () => {
		const pendingSince = new Date(NOW.getTime() - 50 * 60 * 1000);
		storyFindMany.mockResolvedValueOnce([
			{
				id: "story-new",
				kind: "FEATURE",
				lastPmSyncAttemptAt: OLD_ATTEMPT_1,
				lastPmSyncAttemptId: "attempt-1",
				pmSyncPendingSince: pendingSince,
			},
			{
				id: "story-legacy",
				kind: "FEATURE",
				lastPmSyncAttemptAt: OLD_ATTEMPT_2,
				lastPmSyncAttemptId: null,
				pmSyncPendingSince: null,
			},
		]);

		const items = await findStuckPmSyncItems({ olderThan: CUTOFF });

		expect(items).toEqual([
			{
				itemId: "story-new",
				itemType: "story",
				lastPmSyncAttemptAt: OLD_ATTEMPT_1,
				lastPmSyncAttemptId: "attempt-1",
				pendingSince,
			},
			{
				itemId: "story-legacy",
				itemType: "story",
				lastPmSyncAttemptAt: OLD_ATTEMPT_2,
				lastPmSyncAttemptId: null,
				pendingSince: OLD_ATTEMPT_2,
			},
		]);
		expect(storyFindMany.mock.calls[0]?.[0]).toMatchObject({
			select: {
				lastPmSyncAttemptId: true,
				pmSyncPendingSince: true,
			},
		});
	});

	it("includes live test cases stuck PENDING, merged oldest-first under one cap", async () => {
		storyFindMany.mockResolvedValueOnce([
			{
				id: "story-1",
				kind: "FEATURE",
				lastPmSyncAttemptAt: OLD_ATTEMPT_2,
				lastPmSyncAttemptId: null,
				pmSyncPendingSince: null,
			},
		]);
		testCaseFindMany.mockResolvedValueOnce([
			{
				id: "case-1",
				lastPmSyncAttemptAt: OLD_ATTEMPT_1,
				lastPmSyncAttemptId: "attempt-case",
				pmSyncPendingSince: OLD_ATTEMPT_1,
			},
		]);

		const items = await findStuckPmSyncItems({
			olderThan: CUTOFF,
			limit: 1,
		});

		// The older test case wins the single slot.
		expect(items).toEqual([
			{
				itemId: "case-1",
				itemType: "testCase",
				lastPmSyncAttemptAt: OLD_ATTEMPT_1,
				lastPmSyncAttemptId: "attempt-case",
				pendingSince: OLD_ATTEMPT_1,
			},
		]);
		expect(testCaseFindMany.mock.calls[0]?.[0]).toMatchObject({
			where: {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptAt: { lt: CUTOFF },
				deletedAt: null,
			},
			take: 1,
		});
	});

	it("lists rows past the give-up bound first, even when their last attempt is recent, each row once", async () => {
		const PENDING_BEFORE = new Date(NOW.getTime() - 60 * 60 * 1000);
		const retriedRecently = new Date(NOW.getTime() - 2 * 60 * 1000);
		const overdueStory = {
			id: "story-overdue",
			kind: "FEATURE",
			lastPmSyncAttemptAt: retriedRecently,
			lastPmSyncAttemptId: "attempt-overdue",
			pmSyncPendingSince: new Date(NOW.getTime() - 70 * 60 * 1000),
		};
		const retryStory = {
			id: "story-retry",
			kind: "FEATURE",
			lastPmSyncAttemptAt: OLD_ATTEMPT_1,
			lastPmSyncAttemptId: "attempt-retry",
			pmSyncPendingSince: OLD_ATTEMPT_1,
		};
		// Overdue query, then the retry query (which also returns a row the
		// overdue query found).
		storyFindMany
			.mockResolvedValueOnce([overdueStory])
			.mockResolvedValueOnce([retryStory, overdueStory]);
		testCaseFindMany.mockResolvedValue([]);

		const items = await findStuckPmSyncItems({
			olderThan: CUTOFF,
			pendingBefore: PENDING_BEFORE,
			limit: 1,
		});

		// The single slot goes to the overdue row, not the older retry row.
		expect(items.map((i) => i.itemId)).toEqual(["story-overdue"]);
		expect(storyFindMany.mock.calls[0]?.[0]).toMatchObject({
			where: {
				lastPmSyncStatus: "PENDING",
				OR: [
					{ pmSyncPendingSince: { lt: PENDING_BEFORE } },
					{
						pmSyncPendingSince: null,
						lastPmSyncAttemptAt: { lt: PENDING_BEFORE },
					},
				],
			},
		});
		expect(testCaseFindMany.mock.calls[0]?.[0]).toMatchObject({
			where: { deletedAt: null, OR: expect.any(Array) },
		});

		storyFindMany
			.mockResolvedValueOnce([overdueStory])
			.mockResolvedValueOnce([retryStory, overdueStory]);
		const all = await findStuckPmSyncItems({
			olderThan: CUTOFF,
			pendingBefore: PENDING_BEFORE,
		});
		expect(all.map((i) => i.itemId)).toEqual([
			"story-overdue",
			"story-retry",
		]);
	});
});
