/**
 * Adversarial safety tests for `purgeExpiredAuditRowsActivity`.
 *
 * Augments the happy-path coverage in `audit-log-retention.test.ts` with:
 *  - Negative retention days (should short-circuit, NOT delete the future).
 *  - Non-integer retention days (floored, not crashed).
 *  - Cutoff timestamp captured ONCE at activity start (does not drift
 *    mid-run even when the loop takes minutes).
 *  - Idempotency: a fresh run picks up where a previous run left off
 *    (the activity is stateless apart from `cutoffAt`).
 *  - The activity's `recordAudit` call does NOT throw even if recordAudit
 *    itself errors synchronously — the deletes already succeeded and the
 *    meta-event is best-effort.
 *  - Safety cap behaviour with EXACTLY 1,000 batches that each return 0
 *    on the last batch — should exit normally, not hit safety cap.
 *
 * Spec: docs/audit-log/README.md §9.3.
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
		// DELETE's affected-count (2nd op) is what the loop reads. The
		// executeRawMock (DELETE) still receives the tagged-template args, so
		// the cutoff-stability assertions below are unaffected.
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

describe("purgeExpiredAuditRowsActivity (adversarial)", () => {
	describe("Retention-days coercion", () => {
		it("treats a NEGATIVE value as retain-forever (NO DELETES)", async () => {
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "-30";
			const result = await purgeExpiredAuditRowsActivity();
			expect(result.retentionDays).toBe(0);
			expect(mocks.executeRawMock).not.toHaveBeenCalled();
			expect(mocks.recordAuditMock).not.toHaveBeenCalled();
		});

		it("floors a NON-INTEGER value to the integer days", async () => {
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30.7";
			mocks.executeRawMock.mockResolvedValueOnce(0);
			const result = await purgeExpiredAuditRowsActivity();
			expect(result.retentionDays).toBe(30); // Math.floor(30.7)
		});

		it("treats Infinity as retain-forever (defensive)", async () => {
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "Infinity";
			const result = await purgeExpiredAuditRowsActivity();
			// Infinity > 0 but Number.isFinite returns false; the readRetentionDays
			// helper guards on isFinite.
			expect(result.retentionDays).toBe(0);
			expect(mocks.executeRawMock).not.toHaveBeenCalled();
		});

		it("clamps an absurd retention value (e.g. 1e20 days) to MAX_RETENTION_DAYS (no crash)", async () => {
			// Fix applied: `readRetentionDays` clamps to 36500 days (100
			// years) to avoid `Date.now() - 1e20 * 86400000` overflowing
			// what `Date` can represent (~8.64e15 ms from epoch). Without
			// the clamp, the first log line `cutoffAt.toISOString()` would
			// throw `RangeError: Invalid time value`.
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "1e20";
			mocks.executeRawMock.mockResolvedValueOnce(0);
			const result = await purgeExpiredAuditRowsActivity();
			// Clamped to 36500.
			expect(result.retentionDays).toBe(36_500);
			expect(result.deletedCount).toBe(0);
		});
	});

	describe("Cutoff stability", () => {
		it("uses ONE cutoffAt value for every batch (window does NOT drift mid-run)", async () => {
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
			// Return 5000 twice, then 0 — three calls total.
			mocks.executeRawMock
				.mockResolvedValueOnce(5_000)
				.mockResolvedValueOnce(5_000)
				.mockResolvedValueOnce(0);

			await purgeExpiredAuditRowsActivity();

			// All three executeRaw calls receive the same `cutoffAt` value.
			// The `db.$executeRaw` mock receives the tagged-template arguments
			// — Prisma passes them as (TemplateStringsArray, ...values). For
			// our mock the values land at indices 1+; pull `cutoffAt` from
			// each invocation and assert they're equal.
			const calls = mocks.executeRawMock.mock.calls as Array<unknown[]>;
			expect(calls.length).toBe(3);
			// The cutoff is the second item in the tagged template (after
			// the strings array). Each call must carry the SAME Date instance
			// or an equivalent timestamp.
			const cutoffs = calls.map((call) => call[1] as Date);
			expect(cutoffs[0]?.getTime()).toBe(cutoffs[1]?.getTime());
			expect(cutoffs[1]?.getTime()).toBe(cutoffs[2]?.getTime());
		});
	});

	describe("Idempotency", () => {
		it("a fresh activity invocation re-evaluates retention from env — no in-process state", async () => {
			// Invocation 1: retention=30, deletes 1000.
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
			mocks.executeRawMock
				.mockResolvedValueOnce(1_000)
				.mockResolvedValueOnce(0);
			const r1 = await purgeExpiredAuditRowsActivity();
			expect(r1.deletedCount).toBe(1_000);
			expect(r1.retentionDays).toBe(30);

			// Reset call history so we can observe invocation 2 fresh.
			mocks.executeRawMock.mockClear();
			mocks.recordAuditMock.mockClear();

			// Invocation 2: retention=7 (operator changed at runtime).
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "7";
			mocks.executeRawMock.mockResolvedValueOnce(0);
			const r2 = await purgeExpiredAuditRowsActivity();
			expect(r2.retentionDays).toBe(7);
		});
	});

	describe("Self-audit emit robustness", () => {
		it("recordAudit failure (sync throw) does NOT crash the activity — caught + warned", async () => {
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
			mocks.executeRawMock.mockResolvedValueOnce(0);
			// Defensive case: in production recordAudit is fire-and-forget
			// and never throws synchronously, but a defective mock / future
			// regression must NOT crash the activity AFTER the deletes
			// already succeeded — otherwise Temporal would retry the
			// already-complete work.
			mocks.recordAuditMock.mockImplementation(() => {
				throw new Error("simulated record fail");
			});

			// Fix applied: the activity wraps `recordAudit` in try/catch
			// and emits a `logger.warn` instead of propagating.
			const result = await purgeExpiredAuditRowsActivity();
			expect(result.deletedCount).toBe(0);
			expect(mocks.loggerWarnMock).toHaveBeenCalledTimes(1);
			const warnCall = mocks.loggerWarnMock.mock.calls[0];
			expect(warnCall?.[0]).toMatchObject({
				event: "audit.retention.meta_event_failed",
			});
		});
	});

	describe("Batch-loop edge cases", () => {
		it("exactly MAX_BATCHES iterations with each returning batch_size returns hitSafetyCap=true", async () => {
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
			mocks.executeRawMock.mockResolvedValue(5_000);
			const result = await purgeExpiredAuditRowsActivity();
			expect(result.deletedCount).toBe(5_000 * 1_000);
			expect(result.hitSafetyCap).toBe(true);
		});

		it("returns hitSafetyCap=false when last batch finds 0 rows exactly at the boundary", async () => {
			process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
			// 999 full batches then 0 — finishes normally one short of cap.
			let call = 0;
			mocks.executeRawMock.mockImplementation(async () => {
				call += 1;
				if (call <= 999) {
					return 5_000;
				}
				return 0;
			});
			const result = await purgeExpiredAuditRowsActivity();
			expect(result.deletedCount).toBe(5_000 * 999);
			expect(result.hitSafetyCap).toBe(false);
		});
	});
});
