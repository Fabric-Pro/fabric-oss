/**
 * Unit tests for `findStuckPmSyncItems` — the watchdog query that flags
 * PM-sync rows stuck in PENDING longer than the cutoff (default 10 min).
 *
 * Mocks the Prisma client — no real DB. Covers the itemType mapping
 * (`UserStory.kind === BUG` → `"bug"`, otherwise `"story"`). Stories are the
 * only work-item rows since the Epic/Feature folder tables were dropped.
 *
 * Run with: pnpm --filter @repo/database test __tests__/find-stuck-pm-sync.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { storyFindMany } = vi.hoisted(() => ({
	storyFindMany: vi.fn(),
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
});
