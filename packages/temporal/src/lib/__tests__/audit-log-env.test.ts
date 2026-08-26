/**
 * Unit tests for `validateAuditRetentionDays`.
 *
 * Per spec §9.5, the helper emits a non-fatal warning when
 * `FABRIC_AUDIT_LOG_RETENTION_DAYS` is set between 1 and 89 inclusive
 * (below the 90-day documented floor). It is silent for 0 (retain
 * forever), unset, non-numeric, negative, and values >= 90.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/lib/__tests__/audit-log-env.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAuditRetentionDays } from "../audit-log-env";

const originalEnv = process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;

// Vitest 4's bare `vi.fn()` infers `Mock<Procedure | Constructable>`, which
// isn't assignable to the validator's `(msg: string) => void` param. Pin the
// signature so the mock types as `Mock<(msg: string) => void>`.
let logSink: ReturnType<typeof vi.fn<(msg: string) => void>>;

beforeEach(() => {
	logSink = vi.fn<(msg: string) => void>();
});

afterEach(() => {
	if (originalEnv === undefined) {
		delete process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;
	} else {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = originalEnv;
	}
});

describe("validateAuditRetentionDays", () => {
	it("does not warn when unset", () => {
		delete process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;
		validateAuditRetentionDays(logSink);
		expect(logSink).not.toHaveBeenCalled();
	});

	it("does not warn for empty string", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "";
		validateAuditRetentionDays(logSink);
		expect(logSink).not.toHaveBeenCalled();
	});

	it("does not warn for 0 (retain forever)", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "0";
		validateAuditRetentionDays(logSink);
		expect(logSink).not.toHaveBeenCalled();
	});

	it("does not warn for non-numeric values", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "not-a-number";
		validateAuditRetentionDays(logSink);
		expect(logSink).not.toHaveBeenCalled();
	});

	it("does not warn for negative values", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "-30";
		validateAuditRetentionDays(logSink);
		expect(logSink).not.toHaveBeenCalled();
	});

	it("warns for 30 (below the 90-day floor)", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "30";
		validateAuditRetentionDays(logSink);
		expect(logSink).toHaveBeenCalledTimes(1);
		expect(logSink.mock.calls[0][0]).toContain(
			"FABRIC_AUDIT_LOG_RETENTION_DAYS=30",
		);
		expect(logSink.mock.calls[0][0]).toContain("90");
	});

	it("warns for 89 (just below the floor)", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "89";
		validateAuditRetentionDays(logSink);
		expect(logSink).toHaveBeenCalledTimes(1);
	});

	it("does not warn for 90 (at the floor)", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "90";
		validateAuditRetentionDays(logSink);
		expect(logSink).not.toHaveBeenCalled();
	});

	it("does not warn for 365 (Fabric Cloud default)", () => {
		process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS = "365";
		validateAuditRetentionDays(logSink);
		expect(logSink).not.toHaveBeenCalled();
	});
});
