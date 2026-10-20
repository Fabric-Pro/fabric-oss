/**
 * Unlink & re-create for a test case (Fizzy #3045): `applyTestCasePmUnlink`
 * drops the link and the create claim the caller read, together, and only
 * while the case still carries exactly what was read (id, URL, server and
 * claim); `clearTestCasePmCreateClaim` drops the claim of an unlinked case,
 * and only the claim that was read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The database clock the claim-age cutoff is read from.
const DB_NOW = new Date("2026-10-13T12:00:00.000Z");
const CUTOFF = new Date(DB_NOW.getTime() - 5 * 60_000);
const tx = vi.hoisted(() => ({
	testCase: { updateMany: vi.fn(), findFirst: vi.fn() },
	pmTicketMissingStreak: { deleteMany: vi.fn() },
	$queryRaw: vi.fn(),
}));
const db = vi.hoisted(() => ({
	testCase: { updateMany: vi.fn(), findFirst: vi.fn() },
	$transaction: vi.fn(),
	$queryRaw: vi.fn(),
}));
vi.mock("../prisma/client", () => ({ db }));

import {
	applyTestCasePmUnlink,
	clearTestCasePmCreateClaim,
} from "../prisma/queries/apply-pm-unlink";

beforeEach(() => {
	vi.clearAllMocks();
	tx.$queryRaw.mockResolvedValue([{ now: DB_NOW }]);
	db.$queryRaw.mockResolvedValue([{ now: DB_NOW }]);
	tx.testCase.findFirst.mockResolvedValue(null);
	db.testCase.findFirst.mockResolvedValue(null);
	db.$transaction.mockImplementation(
		async (fn: (client: typeof tx) => unknown) => fn(tx),
	);
});

const read = {
	projectId: "p1",
	testCaseId: "tc1",
	expectedExternalId: "123",
	expectedExternalUrl: "https://pm.example.com/cards/123",
	expectedExternalMcpServerId: "srv-1",
	expectedPmCreateClaimId: null,
};

describe("applyTestCasePmUnlink", () => {
	it("clears the link, the sync state and the claim read, scoped to the link, URL, server and claim read", async () => {
		tx.testCase.updateMany.mockResolvedValue({ count: 1 });
		tx.pmTicketMissingStreak.deleteMany.mockResolvedValue({ count: 0 });

		const r = await applyTestCasePmUnlink(read);

		expect(r).toEqual({ applied: true });
		expect(tx.testCase.updateMany).toHaveBeenCalledWith({
			where: {
				id: "tc1",
				projectId: "p1",
				externalId: "123",
				externalUrl: "https://pm.example.com/cards/123",
				externalMcpServerId: "srv-1",
				pmCreateClaimId: null,
				OR: [
					{ lastPmSyncStatus: null },
					{ lastPmSyncStatus: { not: "PENDING" } },
					{ lastPmSyncAttemptId: null },
				],
			},
			data: {
				externalId: null,
				externalUrl: null,
				externalMcpServerId: null,
				externalPmTarget: null,
				lastSyncedPmHash: null,
				lastSyncedAt: null,
				lastPmSyncStatus: null,
				lastPmSyncError: null,
				lastPmSyncAttemptAt: null,
				lastPmSyncAttemptId: null,
				pmSyncPendingSince: null,
				pmCreateClaimId: null,
				pmCreateClaimedAt: null,
			},
		});
		expect(tx.pmTicketMissingStreak.deleteMany).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				entityType: "TEST_CASE",
				entityId: "tc1",
			},
		});
	});

	it("names the claim read in the WHERE, so a claim taken since is kept", async () => {
		tx.testCase.updateMany.mockResolvedValue({ count: 0 });

		const r = await applyTestCasePmUnlink({
			...read,
			expectedPmCreateClaimId: "claim-read",
		});

		expect(r).toEqual({ applied: false });
		expect(tx.testCase.updateMany.mock.calls[0]?.[0].where).toMatchObject({
			pmCreateClaimId: "claim-read",
			// Only once it is older than the recovery bound (DB clock).
			pmCreateClaimedAt: { lte: CUTOFF },
		});
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
	});

	it("a case whose link changed since it was read is left alone", async () => {
		tx.testCase.updateMany.mockResolvedValue({ count: 0 });

		expect(await applyTestCasePmUnlink(read)).toEqual({ applied: false });
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
	});
});

describe("clearTestCasePmCreateClaim", () => {
	it("clears only the claim read, on an unlinked case in the project", async () => {
		db.testCase.updateMany.mockResolvedValue({ count: 1 });

		const r = await clearTestCasePmCreateClaim({
			projectId: "p1",
			testCaseId: "tc1",
			claimId: "claim-read",
		});

		expect(r).toEqual({ cleared: true });
		expect(db.testCase.updateMany).toHaveBeenCalledWith({
			where: {
				id: "tc1",
				projectId: "p1",
				externalId: null,
				pmCreateClaimId: "claim-read",
				pmCreateClaimedAt: { lte: CUTOFF },
				OR: [
					{ lastPmSyncStatus: null },
					{ lastPmSyncStatus: { not: "PENDING" } },
					{ lastPmSyncAttemptId: null },
				],
			},
			data: { pmCreateClaimId: null, pmCreateClaimedAt: null },
		});
	});

	it("reports nothing cleared when the case is linked or holds another claim", async () => {
		db.testCase.updateMany.mockResolvedValue({ count: 0 });

		expect(
			await clearTestCasePmCreateClaim({
				projectId: "p1",
				testCaseId: "tc1",
				claimId: "claim-read",
			}),
		).toEqual({ cleared: false });
	});
});
