/**
 * Unit tests for `purgeExpiredRequestSpansActivity` (SOC 2 C1.2).
 * `db.$executeRaw` is mocked so the loop / cutoff / cap logic is exercised
 * without a live DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeRawMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		$executeRaw: (...args: unknown[]) => mocks.executeRawMock(...args),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfoMock,
		warn: mocks.loggerWarnMock,
		error: vi.fn(),
		log: vi.fn(),
	},
}));

import { purgeExpiredRequestSpansActivity } from "../request-span-retention";

const originalEnv = process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS;

beforeEach(() => {
	mocks.executeRawMock.mockReset();
	mocks.loggerInfoMock.mockReset();
	mocks.loggerWarnMock.mockReset();
});

afterEach(() => {
	if (originalEnv === undefined) {
		delete process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS;
	} else {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = originalEnv;
	}
});

describe("purgeExpiredRequestSpansActivity", () => {
	it("defaults to a 7-day window and deletes in batches", async () => {
		delete process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS;
		mocks.executeRawMock
			.mockResolvedValueOnce(5_000)
			.mockResolvedValueOnce(1_000)
			.mockResolvedValueOnce(0);

		const result = await purgeExpiredRequestSpansActivity();

		expect(result.deletedCount).toBe(6_000);
		expect(result.retentionDays).toBe(7);
		expect(result.hitSafetyCap).toBe(false);
		expect(mocks.executeRawMock).toHaveBeenCalledTimes(3);
		expect(() => new Date(result.cutoffAt).toISOString()).not.toThrow();
	});

	it("honors an explicit retention-days override", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "30";
		mocks.executeRawMock.mockResolvedValueOnce(0);
		const result = await purgeExpiredRequestSpansActivity();
		expect(result.retentionDays).toBe(30);
	});

	it("retains forever when FABRIC_REQUEST_SPAN_RETENTION_DAYS=0 (no deletes)", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "0";
		const result = await purgeExpiredRequestSpansActivity();
		expect(result.deletedCount).toBe(0);
		expect(result.retentionDays).toBe(0);
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
	});

	it("falls back to the default for a non-numeric value", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "not-a-number";
		mocks.executeRawMock.mockResolvedValueOnce(0);
		const result = await purgeExpiredRequestSpansActivity();
		expect(result.retentionDays).toBe(7);
	});

	it("hits the safety cap after 1,000 batches", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "7";
		mocks.executeRawMock.mockResolvedValue(5_000);
		const result = await purgeExpiredRequestSpansActivity();
		expect(result.deletedCount).toBe(5_000 * 1_000);
		expect(result.hitSafetyCap).toBe(true);
		expect(mocks.executeRawMock).toHaveBeenCalledTimes(1_000);
		expect(mocks.loggerWarnMock).toHaveBeenCalledTimes(1);
	});
});
