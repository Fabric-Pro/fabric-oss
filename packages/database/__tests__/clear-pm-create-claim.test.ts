/**
 * `clearPmCreateClaim`: Unlink & re-create on a story with no PM link drops
 * the create claim it read, so the push it enqueues may create, and never a
 * claim taken after that read (Fizzy #3045), and only once that claim is
 * older than PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS by the database clock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	userStory: { updateMany: vi.fn(), findFirst: vi.fn() },
	$queryRaw: vi.fn(),
}));
// The database clock the claim-age cutoff is read from.
const DB_NOW = new Date("2026-10-13T12:00:00.000Z");
vi.mock("../prisma/client", () => ({ db }));

import { clearPmCreateClaim } from "../prisma/queries/apply-pm-unlink";

beforeEach(() => {
	vi.clearAllMocks();
	db.$queryRaw.mockResolvedValue([{ now: DB_NOW }]);
	db.userStory.findFirst.mockResolvedValue(null);
});

describe("clearPmCreateClaim", () => {
	it("clears only the claim read, on an unlinked story in the project", async () => {
		db.userStory.updateMany.mockResolvedValue({ count: 1 });

		const r = await clearPmCreateClaim({
			projectId: "p1",
			storyId: "s1",
			claimId: "claim-read",
		});

		expect(r).toEqual({ cleared: true });
		expect(db.userStory.updateMany).toHaveBeenCalledWith({
			where: {
				id: "s1",
				projectId: "p1",
				externalId: null,
				pmCreateClaimId: "claim-read",
				pmCreateClaimedAt: {
					lte: new Date(DB_NOW.getTime() - 5 * 60_000),
				},
			},
			data: { pmCreateClaimId: null, pmCreateClaimedAt: null },
		});
	});

	it("reports nothing cleared when the story is linked or holds another claim", async () => {
		db.userStory.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await clearPmCreateClaim({
				projectId: "p1",
				storyId: "s1",
				claimId: "claim-read",
			}),
		).toEqual({ cleared: false });
	});
});
