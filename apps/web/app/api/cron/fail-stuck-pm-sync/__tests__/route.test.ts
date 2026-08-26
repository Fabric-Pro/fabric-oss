/**
 * Tests for the `/api/cron/fail-stuck-pm-sync` watchdog route.
 *
 * Covers:
 *   - Cron-secret auth gate: bearer `CRON_SECRET` only, no User-Agent
 *     fallback (issue #2883).
 *   - Within retry window: calls `enqueuePmSync` to restart the workflow.
 *   - Past the give-up cap (60 min): calls `recordPmSyncFailure` so the row
 *     surfaces as recoverable-FAILED in the existing Review Center / sync
 *     badge.
 *   - Tolerates per-item failures and keeps draining the batch.
 *   - Returns counts so an external monitor can alert on retry / failed
 *     spikes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findStuckPmSyncItemsMock,
	recordPmSyncFailureMock,
	enqueuePmSyncMock,
	epicFindUniqueMock,
	featureFindUniqueMock,
	storyFindUniqueMock,
} = vi.hoisted(() => ({
	findStuckPmSyncItemsMock: vi.fn(),
	recordPmSyncFailureMock: vi.fn(),
	enqueuePmSyncMock: vi.fn(),
	epicFindUniqueMock: vi.fn(),
	featureFindUniqueMock: vi.fn(),
	storyFindUniqueMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	findStuckPmSyncItems: findStuckPmSyncItemsMock,
	db: {
		epic: { findUnique: epicFindUniqueMock },
		feature: { findUnique: featureFindUniqueMock },
		userStory: { findUnique: storyFindUniqueMock },
	},
}));

vi.mock("@repo/temporal/activities", () => ({
	recordPmSyncFailure: recordPmSyncFailureMock,
}));

vi.mock("@repo/api/modules/projects/lib/enqueue-pm-sync", () => ({
	enqueuePmSync: enqueuePmSyncMock,
}));

import { GET } from "../route";

const CRON_SECRET = "test-cron-secret-123";
const NOW = Date.now();
const MIN = 60 * 1000;

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request(
		"https://staging.fabric.pro/api/cron/fail-stuck-pm-sync",
		{ method: "GET", headers },
	);
}

beforeEach(() => {
	findStuckPmSyncItemsMock.mockReset();
	recordPmSyncFailureMock.mockReset();
	enqueuePmSyncMock.mockReset();
	epicFindUniqueMock.mockReset();
	featureFindUniqueMock.mockReset();
	storyFindUniqueMock.mockReset();
	process.env.CRON_SECRET = CRON_SECRET;

	// Default: every row exists with a known project owner so loadOwnerForRetry
	// resolves. Tests can override per-case to simulate vanished rows.
	const ownerStub = {
		projectId: "proj-1",
		project: { userId: "user-1" },
	};
	epicFindUniqueMock.mockResolvedValue(ownerStub);
	featureFindUniqueMock.mockResolvedValue(ownerStub);
	storyFindUniqueMock.mockResolvedValue(ownerStub);
	enqueuePmSyncMock.mockResolvedValue({ enqueued: true });
});

describe("GET /api/cron/fail-stuck-pm-sync", () => {
	it("rejects requests with no credentials at all", async () => {
		const res = await GET(makeRequest());
		expect(res.status).toBe(401);
		expect(findStuckPmSyncItemsMock).not.toHaveBeenCalled();
	});

	it("rejects the vercel-cron User-Agent when CRON_SECRET is unset — the fallback is gone", async () => {
		// biome-ignore lint/performance/noDelete: env-var contract test
		delete process.env.CRON_SECRET;

		const res = await GET(makeRequest({ "user-agent": "vercel-cron/1.0" }));
		expect(res.status).toBe(401);
		expect(findStuckPmSyncItemsMock).not.toHaveBeenCalled();

		process.env.CRON_SECRET = CRON_SECRET;
	});

	it("returns counts of 0 when nothing is stuck", async () => {
		findStuckPmSyncItemsMock.mockResolvedValueOnce([]);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.retriedCount).toBe(0);
		expect(body.failedCount).toBe(0);
		expect(enqueuePmSyncMock).not.toHaveBeenCalled();
		expect(recordPmSyncFailureMock).not.toHaveBeenCalled();
	});

	it("RE-ENQUEUES rows within the retry window (between 10 min and 60 min stuck)", async () => {
		// Row stuck 30 min — past the 10-min retry cutoff but well before the
		// 60-min give-up cap → should be re-enqueued.
		findStuckPmSyncItemsMock.mockResolvedValueOnce([
			{
				itemId: "story-30min",
				itemType: "story",
				lastPmSyncAttemptAt: new Date(NOW - 30 * MIN),
			},
		]);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.retriedCount).toBe(1);
		expect(body.failedCount).toBe(0);
		expect(enqueuePmSyncMock).toHaveBeenCalledTimes(1);
		expect(enqueuePmSyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "story-30min",
				itemType: "story",
				projectId: "proj-1",
				userId: "user-1",
				forceInitialPush: true,
				triggerSource: "retry",
			}),
		);
		expect(recordPmSyncFailureMock).not.toHaveBeenCalled();
	});

	it("STAMPS FAILED on rows past the 60-min give-up cap", async () => {
		findStuckPmSyncItemsMock.mockResolvedValueOnce([
			{
				itemId: "epic-90min",
				itemType: "epic",
				lastPmSyncAttemptAt: new Date(NOW - 90 * MIN),
			},
		]);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.retriedCount).toBe(0);
		expect(body.failedCount).toBe(1);
		expect(recordPmSyncFailureMock).toHaveBeenCalledTimes(1);
		expect(recordPmSyncFailureMock).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "epic-90min",
				itemType: "epic",
				errorClass: "pending_timeout",
				triggerSource: "retry",
			}),
		);
		expect(enqueuePmSyncMock).not.toHaveBeenCalled();
	});

	it("mixes both paths in a single tick (some retry, some give-up)", async () => {
		findStuckPmSyncItemsMock.mockResolvedValueOnce([
			{
				itemId: "feat-retry",
				itemType: "feature",
				lastPmSyncAttemptAt: new Date(NOW - 15 * MIN),
			},
			{
				itemId: "bug-fail",
				itemType: "bug",
				lastPmSyncAttemptAt: new Date(NOW - 75 * MIN),
			},
		]);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);
		const body = await res.json();

		expect(body.retriedCount).toBe(1);
		expect(body.failedCount).toBe(1);
		expect(enqueuePmSyncMock).toHaveBeenCalledTimes(1);
		expect(enqueuePmSyncMock.mock.calls[0]?.[0]).toMatchObject({
			itemId: "feat-retry",
			itemType: "feature",
		});
		expect(recordPmSyncFailureMock).toHaveBeenCalledTimes(1);
		expect(recordPmSyncFailureMock.mock.calls[0]?.[0]).toMatchObject({
			itemId: "bug-fail",
			itemType: "bug",
		});
	});

	it("skips rows that vanished between find and retry (loadOwnerForRetry returns null)", async () => {
		storyFindUniqueMock.mockResolvedValueOnce(null);
		findStuckPmSyncItemsMock.mockResolvedValueOnce([
			{
				itemId: "story-gone",
				itemType: "story",
				lastPmSyncAttemptAt: new Date(NOW - 15 * MIN),
			},
		]);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.retriedCount).toBe(0);
		expect(body.failedCount).toBe(0);
		expect(enqueuePmSyncMock).not.toHaveBeenCalled();
		expect(recordPmSyncFailureMock).not.toHaveBeenCalled();
	});

	it("keeps draining the batch when one item's iteration throws", async () => {
		findStuckPmSyncItemsMock.mockResolvedValueOnce([
			{
				itemId: "s1",
				itemType: "story",
				lastPmSyncAttemptAt: new Date(NOW - 15 * MIN),
			},
			{
				itemId: "s2-broken",
				itemType: "story",
				lastPmSyncAttemptAt: new Date(NOW - 15 * MIN),
			},
			{
				itemId: "s3",
				itemType: "story",
				lastPmSyncAttemptAt: new Date(NOW - 15 * MIN),
			},
		]);
		enqueuePmSyncMock.mockImplementation(
			async (input: { itemId: string }) => {
				if (input.itemId === "s2-broken") {
					throw new Error("Temporal client down");
				}
				return { enqueued: true };
			},
		);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.success).toBe(false);
		expect(body.retriedCount).toBe(2);
		expect(body.errorCount).toBe(1);
		expect(body.sampleErrors[0]).toContain("s2-broken");
		// All three were attempted.
		expect(enqueuePmSyncMock).toHaveBeenCalledTimes(3);
	});

	it("returns 500 when the find query itself throws", async () => {
		findStuckPmSyncItemsMock.mockRejectedValueOnce(new Error("DB down"));

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);
		const body = await res.json();

		expect(res.status).toBe(500);
		expect(body.success).toBe(false);
		expect(body.error).toBe("DB down");
	});
});
