/**
 * The retention purge must never delete a row an audit seal already covers.
 *
 * A seal's `contentHash` is a fold over the rows in its window, and
 * `verifySealAgainstContent` reports a content mismatch for DELETED rows exactly
 * as it does for modified or inserted ones. So purging inside a sealed window
 * makes that seal fail verification and read as tampering — and, critically, makes
 * genuine tampering indistinguishable from routine retention, which destroys the
 * property the seal chain exists to provide (SOC 2 CC7.1/CC7.2).
 *
 * Nothing about that failure is loud. Retention would delete happily, the purge
 * would report success, and the breakage would only surface later as a
 * verification run crying tamper on old windows. Hence a test on the boundary
 * rather than trust in the comment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sealedThroughAt: null as Date | null,
	executeRawCalls: [] as unknown[],
	auditCount: 0,
	transaction: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getSealedThroughAt: async () => mocks.sealedThroughAt,
	recordAudit: () => undefined,
	db: {
		auditLog: { count: async () => mocks.auditCount },
		// Capture the DELETE template so the assertion is about the SQL actually
		// issued, not about a helper's return value.
		$executeRawUnsafe: (sql: string) => {
			mocks.executeRawCalls.push(sql);
			return 0;
		},
		$executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
			mocks.executeRawCalls.push({ sql: strings.join("?"), values });
			return 0;
		},
		$transaction: (ops: unknown[]) => mocks.transaction(ops),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock("@temporalio/activity", () => ({
	activityInfo: () => ({ workflowExecution: { runId: "test-run" } }),
}));

import { purgeExpiredAuditRowsActivity } from "../audit-log-retention";

beforeEach(() => {
	mocks.sealedThroughAt = null;
	mocks.executeRawCalls = [];
	mocks.auditCount = 0;
	// Report 0 affected rows so the batch loop exits after one pass.
	mocks.transaction.mockImplementation(async () => [0, 0]);
	process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
});

describe("retention purge respects the audit-seal floor", () => {
	it("withholds rows when sealing has covered past the retention cutoff", async () => {
		// The normal steady state: sealing runs hourly, so it is caught up to
		// roughly now, while the cutoff is 30 days back. EVERY expired row is
		// therefore sealed and none may be deleted.
		mocks.sealedThroughAt = new Date();
		mocks.auditCount = 4321;

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.withheldBySeal).toBe(4321);
		expect(result.deletedCount).toBe(0);
	});

	it("passes the seal floor into the DELETE as a lower bound", async () => {
		const sealedThrough = new Date("2026-08-01T00:00:00.000Z");
		mocks.sealedThroughAt = sealedThrough;

		await purgeExpiredAuditRowsActivity();

		const del = mocks.executeRawCalls.find(
			(c): c is { sql: string; values: unknown[] } =>
				typeof c === "object" &&
				c !== null &&
				"sql" in c &&
				String((c as { sql: string }).sql).includes("DELETE"),
		);
		expect(del).toBeDefined();
		// The floor must be part of the statement, not applied after the fact.
		expect(del?.sql).toContain('"createdAt" >=');
		expect(del?.values).toContain(sealedThrough);
	});

	it("does not withhold anything when nothing has been sealed yet", async () => {
		// A deployment with sealing not yet run: retention is unconstrained,
		// because there is no tamper evidence to invalidate.
		mocks.sealedThroughAt = null;
		mocks.auditCount = 999;

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.withheldBySeal).toBe(0);
	});

	it("short-circuits before consulting seals when retention is disabled", async () => {
		// Retain-forever is the default. It must not even query the seal state.
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "0";
		mocks.sealedThroughAt = new Date();

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.retentionDays).toBe(0);
		expect(result.deletedCount).toBe(0);
		expect(result.withheldBySeal).toBe(0);
		expect(mocks.executeRawCalls).toHaveLength(0);
	});
});
