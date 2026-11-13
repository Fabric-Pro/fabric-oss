/**
 * Unit tests for `purgeExpiredRequestSpansActivity` (SOC 2 C1.2).
 * `db.$executeRaw` is mocked so the loop / cutoff / cap logic is exercised
 * without a live DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeRawMock: vi.fn(),
	purgeReplayMock: vi.fn(),
	purgeAdvisorMock: vi.fn(),
	purgeMcpDurableMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock("@repo/database/prisma/queries/advisor-tool-results", () => ({
	advisorToolResultStorage: { deleteExpired: mocks.purgeAdvisorMock },
}));

vi.mock("@repo/database", () => ({
	purgeExpiredConversationTurnEvents: mocks.purgeReplayMock,
	purgeExpiredMcpDurableToolCalls: mocks.purgeMcpDurableMock,
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
	mocks.purgeAdvisorMock.mockReset().mockResolvedValue(0);
	mocks.purgeReplayMock.mockReset().mockResolvedValue(0);
	mocks.purgeMcpDurableMock.mockReset().mockResolvedValue(0);
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
	it("purges expired MCP durable receipts on the existing daily activity", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "0";
		mocks.purgeMcpDurableMock
			.mockResolvedValueOnce(5000)
			.mockResolvedValueOnce(0);
		await purgeExpiredRequestSpansActivity();
		expect(mocks.purgeMcpDurableMock).toHaveBeenCalledTimes(2);
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
	});

	it("continues other retention when MCP durable cleanup fails", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "0";
		mocks.purgeMcpDurableMock.mockRejectedValueOnce(
			new Error("Statement timeout"),
		);
		await purgeExpiredRequestSpansActivity();
		expect(mocks.purgeReplayMock).toHaveBeenCalledOnce();
		expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
			expect.stringContaining("continuing request-span"),
		);
	});

	it("continues span retention when replay cleanup fails", async () => {
		delete process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS;
		mocks.purgeReplayMock.mockRejectedValueOnce(
			new Error("Statement timeout"),
		);
		mocks.executeRawMock.mockResolvedValueOnce(7).mockResolvedValueOnce(0);
		expect((await purgeExpiredRequestSpansActivity()).deletedCount).toBe(7);
		expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
			expect.stringContaining("continuing request-span"),
		);
	});
	it("purges expired replay output independently of request-span retention", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "0";
		mocks.purgeReplayMock
			.mockResolvedValueOnce(5000)
			.mockResolvedValueOnce(0);
		await purgeExpiredRequestSpansActivity();
		expect(mocks.purgeReplayMock).toHaveBeenCalledTimes(2);
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
	});
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

describe("Advisor result retention", () => {
	it("purges expired results even when span retention is disabled", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "0";
		mocks.purgeAdvisorMock
			.mockResolvedValueOnce(5000)
			.mockResolvedValueOnce(0);
		await purgeExpiredRequestSpansActivity();
		expect(mocks.purgeAdvisorMock).toHaveBeenCalledTimes(2);
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
	});
	it("bounds cleanup to 1000 batches", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "0";
		mocks.purgeAdvisorMock.mockResolvedValue(1);
		await purgeExpiredRequestSpansActivity();
		expect(mocks.purgeAdvisorMock).toHaveBeenCalledTimes(1000);
		expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
			expect.stringContaining("AdvisorResultRetention"),
		);
	});
	it("continues retention without logging a failed cleanup's error", async () => {
		process.env.FABRIC_REQUEST_SPAN_RETENTION_DAYS = "7";
		mocks.purgeAdvisorMock.mockRejectedValue(
			new Error("example result content"),
		);
		mocks.executeRawMock.mockResolvedValue(0);
		await expect(purgeExpiredRequestSpansActivity()).resolves.toMatchObject(
			{ deletedCount: 0 },
		);
		expect(JSON.stringify(mocks.loggerWarnMock.mock.calls)).not.toContain(
			"example result content",
		);
		expect(mocks.executeRawMock).toHaveBeenCalledOnce();
	});
});
