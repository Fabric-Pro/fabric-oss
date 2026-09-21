import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	purgeExpiredBackgroundJobs: vi.fn(),
	failStaleBackgroundJobs: vi.fn(),
	failStaleProjectScans: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	purgeExpiredBackgroundJobs: mocks.purgeExpiredBackgroundJobs,
	failStaleBackgroundJobs: mocks.failStaleBackgroundJobs,
	failStaleProjectScans: mocks.failStaleProjectScans,
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
