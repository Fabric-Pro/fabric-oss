import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	purgeExpiredBackgroundJobs: vi.fn(),
	failStaleBackgroundJobs: vi.fn(),
	failStaleProjectScans: vi.fn(),
	findQuietIndexingCodeIndexes: vi.fn(),
	failOrphanedCodeIndex: vi.fn(),
	getTemporalClient: vi.fn(),
	describe: vi.fn(),
	getHandle: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	purgeExpiredBackgroundJobs: mocks.purgeExpiredBackgroundJobs,
	failStaleBackgroundJobs: mocks.failStaleBackgroundJobs,
	failStaleProjectScans: mocks.failStaleProjectScans,
	findQuietIndexingCodeIndexes: mocks.findQuietIndexingCodeIndexes,
	failOrphanedCodeIndex: mocks.failOrphanedCodeIndex,
}));

vi.mock("../../client", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	failStaleBackgroundJobsActivity,
	purgeExpiredBackgroundJobsActivity,
} from "../background-job-retention";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.purgeExpiredBackgroundJobs.mockResolvedValue({
		deleted: 0,
		batches: 0,
	});
	mocks.failStaleBackgroundJobs.mockResolvedValue(0);
	mocks.failStaleProjectScans.mockResolvedValue(0);
	mocks.findQuietIndexingCodeIndexes.mockResolvedValue([]);
	mocks.failOrphanedCodeIndex.mockResolvedValue(1);
	mocks.getHandle.mockImplementation(() => ({ describe: mocks.describe }));
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: mocks.getHandle },
	});
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("purgeExpiredBackgroundJobsActivity", () => {
	it("defaults to a 7-day window", async () => {
		delete process.env.FABRIC_JOB_RETENTION_DAYS;

		const result = await purgeExpiredBackgroundJobsActivity();

		// Must match the API-side reader, or the panel and the purge disagree
		// about what "recent" means.
		expect(result.retentionDays).toBe(7);
		expect(mocks.purgeExpiredBackgroundJobs).toHaveBeenCalledWith({
			retentionDays: 7,
		});
	});

	it("honours a configured window", async () => {
		process.env.FABRIC_JOB_RETENTION_DAYS = "3";
		mocks.purgeExpiredBackgroundJobs.mockResolvedValue({
			deleted: 12,
			batches: 1,
		});

		const result = await purgeExpiredBackgroundJobsActivity();

		expect(result).toEqual({
			deletedCount: 12,
			retentionDays: 3,
			batches: 1,
		});
	});

	it("clamps a zero or negative window rather than deleting everything", async () => {
		process.env.FABRIC_JOB_RETENTION_DAYS = "0";
		await purgeExpiredBackgroundJobsActivity();
		expect(mocks.purgeExpiredBackgroundJobs).toHaveBeenCalledWith({
			retentionDays: 1,
		});
	});

	it("clamps an absurdly large window", async () => {
		process.env.FABRIC_JOB_RETENTION_DAYS = "3650";
		await purgeExpiredBackgroundJobsActivity();
		expect(mocks.purgeExpiredBackgroundJobs).toHaveBeenCalledWith({
			retentionDays: 30,
		});
	});

	it("falls back to the default for an unparseable value", async () => {
		process.env.FABRIC_JOB_RETENTION_DAYS = "forever";
		await purgeExpiredBackgroundJobsActivity();
		expect(mocks.purgeExpiredBackgroundJobs).toHaveBeenCalledWith({
			retentionDays: 7,
		});
	});
});

describe("failStaleBackgroundJobsActivity", () => {
	it("defaults to a threshold longer than the slowest instrumented activity", async () => {
		delete process.env.FABRIC_JOB_STALE_MINUTES;

		const result = await failStaleBackgroundJobsActivity();

		// The Slack backfill's startToCloseTimeout is 30 minutes and it can go
		// that long between job writes while skipping already-seen roots. A
		// threshold at or below it would fail jobs that are merely mid-step —
		// and since writers compare-and-set, the success could not repair it.
		expect(result.staleMinutes).toBeGreaterThan(30);
		expect(mocks.failStaleBackgroundJobs).toHaveBeenCalledWith({
			staleMinutes: result.staleMinutes,
		});
	});

	it("reports how many crashed jobs it closed", async () => {
		mocks.failStaleBackgroundJobs.mockResolvedValue(4);

		const result = await failStaleBackgroundJobsActivity();

		expect(result.failedCount).toBe(4);
	});

	it("ignores a sub-minute threshold that would fail live jobs", async () => {
		process.env.FABRIC_JOB_STALE_MINUTES = "0";

		const result = await failStaleBackgroundJobsActivity();

		// A 0-minute threshold would fail every job the instant it started.
		expect(result.staleMinutes).toBeGreaterThan(30);
	});
});

describe("failStaleBackgroundJobsActivity — project scans", () => {
	it("sweeps scans in the same pass, so they need no schedule of their own", async () => {
		await failStaleBackgroundJobsActivity();

		expect(mocks.failStaleProjectScans).toHaveBeenCalledTimes(1);
	});

	it("gives scans the window the readiness gate uses, not the job window", async () => {
		const result = await failStaleBackgroundJobsActivity();

		// PROJECT_SCAN_STALL_MINUTES in
		// packages/api/modules/capabilities/thresholds.ts. A scan records nothing
		// after startedAt, so this window has to outlast a legitimately long run.
		expect(result.scanStaleMinutes).toBe(90);
		expect(mocks.failStaleProjectScans).toHaveBeenCalledWith({
			staleMinutes: 90,
		});
	});

	it("does not let the job-side override move the scan window", async () => {
		process.env.FABRIC_JOB_STALE_MINUTES = "5";

		const result = await failStaleBackgroundJobsActivity();

		// The two clocks are independent: an operator shortening the job window
		// must not start killing scans that are merely slow.
		expect(result.staleMinutes).toBe(5);
		expect(result.scanStaleMinutes).toBe(90);
	});

	it("reports the two counts separately", async () => {
		mocks.failStaleBackgroundJobs.mockResolvedValue(2);
		mocks.failStaleProjectScans.mockResolvedValue(3);

		const result = await failStaleBackgroundJobsActivity();

		expect(result.failedCount).toBe(2);
		expect(result.failedScanCount).toBe(3);
	});
});

describe("failStaleBackgroundJobsActivity — orphaned code indexes", () => {
	const OBSERVED = new Date("2026-01-01T10:00:00.000Z");

	function quietRow(overrides: Record<string, unknown> = {}) {
		return {
			id: "idx-1",
			projectId: "proj-1",
			repositoryIntegrationId: "integration-1",
			branch: "main",
			workflowId: "code-index-proj-1-integration-1",
			updatedAt: OBSERVED,
			...overrides,
		};
	}

	const status = (name: string) => async () => ({ status: { name } });

	function notFound() {
		return Object.assign(new Error("workflow not found"), {
			name: "WorkflowNotFoundError",
		});
	}

	it("asks for quiet INDEXING rows within the sweep's bounds", async () => {
		await failStaleBackgroundJobsActivity();

		expect(mocks.findQuietIndexingCodeIndexes).toHaveBeenCalledWith({
			quietMinutes: 10,
			limit: 25,
		});
	});

	it("does not reach Temporal when no row is quiet", async () => {
		const result = await failStaleBackgroundJobsActivity();

		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(result.failedCodeIndexCount).toBe(0);
	});

	it("leaves a row alone while its workflow is RUNNING", async () => {
		mocks.findQuietIndexingCodeIndexes.mockResolvedValue([quietRow()]);
		mocks.describe.mockImplementation(status("RUNNING"));

		const result = await failStaleBackgroundJobsActivity();

		expect(mocks.failOrphanedCodeIndex).not.toHaveBeenCalled();
		expect(result.failedCodeIndexCount).toBe(0);
	});

	it.each(["COMPLETED", "FAILED", "TERMINATED", "TIMED_OUT", "CANCELLED"])(
		"fails a row whose workflow is %s, as it was read",
		async (name) => {
			mocks.findQuietIndexingCodeIndexes.mockResolvedValue([quietRow()]);
			mocks.describe.mockImplementation(status(name));

			const result = await failStaleBackgroundJobsActivity();

			expect(mocks.getHandle).toHaveBeenCalledWith(
				"code-index-proj-1-integration-1",
			);
			expect(mocks.failOrphanedCodeIndex).toHaveBeenCalledWith({
				id: "idx-1",
				observedUpdatedAt: OBSERVED,
				error: expect.stringContaining("no longer active"),
			});
			expect(result.failedCodeIndexCount).toBe(1);
		},
	);

	it("fails a row whose workflow Temporal has never heard of", async () => {
		mocks.findQuietIndexingCodeIndexes.mockResolvedValue([quietRow()]);
		mocks.describe.mockRejectedValue(notFound());

		const result = await failStaleBackgroundJobsActivity();

		expect(result.failedCodeIndexCount).toBe(1);
	});

	it("counts only the writes that landed (the compare-and-set can miss)", async () => {
		mocks.findQuietIndexingCodeIndexes.mockResolvedValue([
			quietRow({ id: "idx-1" }),
			quietRow({ id: "idx-2" }),
		]);
		mocks.describe.mockImplementation(status("TERMINATED"));
		mocks.failOrphanedCodeIndex
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(0);

		const result = await failStaleBackgroundJobsActivity();

		expect(mocks.failOrphanedCodeIndex).toHaveBeenCalledTimes(2);
		expect(result.failedCodeIndexCount).toBe(1);
	});

	it("treats any other describe error as live", async () => {
		mocks.findQuietIndexingCodeIndexes.mockResolvedValue([quietRow()]);
		mocks.describe.mockRejectedValue(new Error("UNAVAILABLE"));

		const result = await failStaleBackgroundJobsActivity();

		expect(mocks.failOrphanedCodeIndex).not.toHaveBeenCalled();
		expect(result.failedCodeIndexCount).toBe(0);
	});

	it("treats a describe that does not answer in time as live", async () => {
		vi.useFakeTimers();
		try {
			mocks.findQuietIndexingCodeIndexes.mockResolvedValue([quietRow()]);
			mocks.describe.mockImplementation(() => new Promise(() => {}));

			const pending = failStaleBackgroundJobsActivity();
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await pending;

			expect(mocks.failOrphanedCodeIndex).not.toHaveBeenCalled();
			expect(result.failedCodeIndexCount).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips the sweep when the Temporal client will not construct", async () => {
		mocks.failStaleBackgroundJobs.mockResolvedValue(2);
		mocks.failStaleProjectScans.mockResolvedValue(3);
		mocks.findQuietIndexingCodeIndexes.mockResolvedValue([quietRow()]);
		mocks.getTemporalClient.mockRejectedValue(new Error("no connection"));

		const result = await failStaleBackgroundJobsActivity();

		expect(mocks.failOrphanedCodeIndex).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			failedCount: 2,
			failedScanCount: 3,
			failedCodeIndexCount: 0,
		});
	});

	it("a failing sweep costs only its own count", async () => {
		mocks.failStaleBackgroundJobs.mockResolvedValue(2);
		mocks.failStaleProjectScans.mockResolvedValue(3);
		mocks.findQuietIndexingCodeIndexes.mockRejectedValue(
			new Error("database unavailable"),
		);

		const result = await failStaleBackgroundJobsActivity();

		expect(result).toMatchObject({
			failedCount: 2,
			failedScanCount: 3,
			failedCodeIndexCount: 0,
		});
	});

	it("derives the workflow id for a row that never recorded one", async () => {
		mocks.findQuietIndexingCodeIndexes.mockResolvedValue([
			quietRow({ id: "idx-1", workflowId: null }),
			quietRow({
				id: "idx-2",
				workflowId: null,
				repositoryIntegrationId: null,
			}),
		]);
		mocks.describe.mockImplementation(status("RUNNING"));

		await failStaleBackgroundJobsActivity();

		// codeIndexWorkflowId in packages/api/modules/projects/lib/code-indexing-trigger.ts.
		expect(mocks.getHandle.mock.calls.map(([id]) => id)).toEqual([
			"code-index-proj-1-integration-1",
			"code-index-proj-1-legacy",
		]);
	});

	it("keeps at most five describes in flight", async () => {
		mocks.findQuietIndexingCodeIndexes.mockResolvedValue(
			Array.from({ length: 12 }, (_, i) => quietRow({ id: `idx-${i}` })),
		);
		let inFlight = 0;
		let peak = 0;
		mocks.describe.mockImplementation(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight -= 1;
			return { status: { name: "COMPLETED" } };
		});

		const result = await failStaleBackgroundJobsActivity();

		expect(peak).toBe(5);
		expect(result.failedCodeIndexCount).toBe(12);
	});
});
