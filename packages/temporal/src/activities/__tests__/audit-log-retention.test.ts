/**
 * Unit tests for `purgeExpiredAuditRowsActivity`.
 *
 * Exercises the three behavior modes documented in spec §9.3:
 *  1. Happy path — rows older than the cutoff are deleted in 5k-row
 *     batches; ONE `audit.retention.purged` event is emitted with the
 *     correct metadata.
 *  2. Zero-deletes path — no expired rows; still emits the meta-event
 *     (per spec, the run itself is the audit trail).
 *  3. Retain-forever short-circuit — `FABRIC_AUDIT_LOG_RETENTION_DAYS=0`
 *     (or unset / non-numeric) returns immediately with no DB calls and
 *     NO meta-event.
 *
 * The activity calls `db.$executeRaw` and `recordAudit` from
 * `@repo/database`. Both are mocked so the test stays self-contained
 * (no live DB), matching the Task 4.5 spec ("activity-body unit tests").
 * The integration counterpart against the real local DB lives in the
 * spec's Task 13.7 — see spec §13.7.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/audit-log-retention.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeRawMock: vi.fn(),
	executeRawUnsafeMock: vi.fn(),
	recordAuditMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	// The purge consults the audit-seal floor so it never deletes a row a seal
	// covers (deleting sealed rows makes the seal chain report tampering). These
	// suites exercise cutoff/coercion/batching, not the seal interaction, so
	// "nothing sealed yet" is the right stub — it leaves the purge unconstrained
	// and the assertions below unchanged. The seal boundary itself is covered in
	// audit-retention-seal-floor.test.ts.
	getSealedThroughAt: async () => null,
	db: {
		$executeRaw: (...args: unknown[]) => mocks.executeRawMock(...args),
		// The purge sets the WORM bypass GUC (`SET LOCAL
		// app.audit_allow_delete`) via $executeRawUnsafe before each DELETE.
		$executeRawUnsafe: (...args: unknown[]) =>
			mocks.executeRawUnsafeMock(...args),
		// Each batch runs inside a transaction so the SET LOCAL bypass applies
		// to the DELETE. Model it as a sequential run of the batched ops — the
		// DELETE's affected-count (2nd op) is what the loop reads.
		$transaction: (ops: unknown[]) =>
			Promise.all(ops as Array<Promise<unknown>>),
	},
	recordAudit: (...args: unknown[]) => mocks.recordAuditMock(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfoMock,
		warn: mocks.loggerWarnMock,
		error: vi.fn(),
		log: vi.fn(),
	},
}));

// Import AFTER the mocks so the activity captures them.
import { purgeExpiredAuditRowsActivity } from "../audit-log-retention";

const originalEnv = process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;

beforeEach(() => {
	mocks.executeRawMock.mockReset();
	mocks.executeRawUnsafeMock.mockReset();
	mocks.executeRawUnsafeMock.mockResolvedValue(0);
	mocks.recordAuditMock.mockReset();
	mocks.loggerInfoMock.mockReset();
	mocks.loggerWarnMock.mockReset();
});

afterEach(() => {
	if (originalEnv === undefined) {
		delete process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;
	} else {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = originalEnv;
	}
});

describe("purgeExpiredAuditRowsActivity", () => {
	it("deletes expired rows in batches and emits one audit.retention.purged event", async () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
		// Simulate 60 rows: first batch returns 5000, second returns 1000, third returns 0.
		// (The 60-row spec target is the integration test against the real DB;
		// here we exercise the loop semantics with mock returns.)
		mocks.executeRawMock
			.mockResolvedValueOnce(5_000)
			.mockResolvedValueOnce(1_000)
			.mockResolvedValueOnce(0);

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.deletedCount).toBe(6_000);
		expect(result.retentionDays).toBe(30);
		expect(result.hitSafetyCap).toBe(false);
		// Cutoff must parse as a valid ISO date.
		expect(() => new Date(result.cutoffAt).toISOString()).not.toThrow();

		// Loop ran twice with deletes + one terminating empty batch.
		expect(mocks.executeRawMock).toHaveBeenCalledTimes(3);

		// WORM bypass: every batch opts into the append-only DELETE by setting
		// the per-transaction bypass GUC before the DELETE. Once per loop
		// iteration (including the terminating empty batch) = 3.
		expect(mocks.executeRawUnsafeMock).toHaveBeenCalledWith(
			"SET LOCAL app.audit_allow_delete = 'on'",
		);
		expect(mocks.executeRawUnsafeMock).toHaveBeenCalledTimes(3);

		// Exactly one self-audit event.
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const [call] = mocks.recordAuditMock.mock.calls;
		expect(call[0]).toMatchObject({
			action: "audit.retention.purged",
			category: "audit",
			actor: { type: "system" },
			organizationId: null,
			outcome: "success",
			severity: "info",
		});
		expect(call[0].metadata).toMatchObject({
			deletedCount: 6_000,
			retentionDays: 30,
			batches: 2,
			hitSafetyCap: false,
		});
		expect(typeof call[0].metadata.cutoffAt).toBe("string");
	});

	it("emits the meta-event even when nothing was deleted", async () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
		// First (and only) batch returns 0 — loop exits immediately.
		mocks.executeRawMock.mockResolvedValueOnce(0);

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.deletedCount).toBe(0);
		expect(result.retentionDays).toBe(30);
		expect(mocks.executeRawMock).toHaveBeenCalledTimes(1);

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const [call] = mocks.recordAuditMock.mock.calls;
		expect(call[0].metadata).toMatchObject({
			deletedCount: 0,
			retentionDays: 30,
		});
	});

	it("short-circuits when FABRIC_AUDIT_LOG_RETENTION_DAYS=0 (retain forever)", async () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "0";

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.deletedCount).toBe(0);
		expect(result.retentionDays).toBe(0);
		expect(result.hitSafetyCap).toBe(false);

		// No DELETE issued, no meta-event written.
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("short-circuits when FABRIC_AUDIT_LOG_RETENTION_DAYS is unset", async () => {
		delete process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.deletedCount).toBe(0);
		expect(result.retentionDays).toBe(0);
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("short-circuits when FABRIC_AUDIT_LOG_RETENTION_DAYS is non-numeric", async () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "not-a-number";

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.deletedCount).toBe(0);
		expect(result.retentionDays).toBe(0);
		expect(mocks.executeRawMock).not.toHaveBeenCalled();
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("hits the safety cap after 1,000 batches and still emits the meta-event", async () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
		// Every batch returns the full BATCH_SIZE (5,000) — loop runs until
		// the safety cap fires at 1,000 iterations.
		mocks.executeRawMock.mockResolvedValue(5_000);

		const result = await purgeExpiredAuditRowsActivity();

		expect(result.deletedCount).toBe(5_000 * 1_000);
		expect(result.hitSafetyCap).toBe(true);
		expect(mocks.executeRawMock).toHaveBeenCalledTimes(1_000);

		// Warning logged once for safety-cap.
		expect(mocks.loggerWarnMock).toHaveBeenCalledTimes(1);
		const [warnCall] = mocks.loggerWarnMock.mock.calls;
		expect(warnCall[0]).toMatchObject({
			event: "audit.retention.safety_cap_hit",
		});

		// Meta-event still emitted with the safety-cap flag.
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const [call] = mocks.recordAuditMock.mock.calls;
		expect(call[0].metadata.hitSafetyCap).toBe(true);
	});
});
