/**
 * Tests for the getBackupCodesStatus handler (B4 — M7).
 *
 * We import the real `getBackupCodesStatusHandler` and pass a mock
 * `deps.viewBackupCodes`, so changes to the procedure are caught by
 * these tests. The exported handler pattern matches
 * `revokeEmailChangeHandler` in the sibling revoke-email-change.ts.
 */

import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import {
	type GetBackupCodesStatusDeps,
	getBackupCodesStatusHandler,
} from "../procedures/get-backup-codes-status";

// ---------------------------------------------------------------------------
// Mock @repo/logs so log output doesn't pollute the test runner
// ---------------------------------------------------------------------------

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCodesArray = (n: number) =>
	Array.from({ length: n }, (_, i) => `code-${String(i).padStart(2, "0")}`);

const makeDeps = (codes: string[]): GetBackupCodesStatusDeps => ({
	viewBackupCodes: vi.fn().mockResolvedValue({ backupCodes: codes }),
});

const makeThrowingDeps = (err: unknown): GetBackupCodesStatusDeps => ({
	viewBackupCodes: vi.fn().mockRejectedValue(err),
});

/**
 * Mimics the shape Better Auth's `APIError` produces for a missing
 * TwoFactor row: an Error subclass with `body.message` set to the exact
 * `BACKUP_CODES_NOT_ENABLED` constant from
 * `better-auth/dist/plugins/two-factor/error-code.mjs`.
 */
const makeBackupCodesNotEnabledError = () => {
	const err = new Error("Backup codes aren't enabled") as Error & {
		body: { message: string };
	};
	err.body = { message: "Backup codes aren't enabled" };
	return err;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getBackupCodesStatusHandler", () => {
	it("returns remaining count from decrypted codes", async () => {
		const codes = makeCodesArray(7);
		const result = await getBackupCodesStatusHandler(
			"user-1",
			makeDeps(codes),
		);

		expect(result.remaining).toBe(7);
	});

	it("returns 0 when 2FA not enabled (BACKUP_CODES_NOT_ENABLED APIError)", async () => {
		const deps = makeThrowingDeps(makeBackupCodesNotEnabledError());
		const result = await getBackupCodesStatusHandler("user-2", deps);

		expect(result.remaining).toBe(0);
		expect(result.total).toBe(10);
	});

	it("total is always 10", async () => {
		const [fullResult, emptyResult] = await Promise.all([
			getBackupCodesStatusHandler("user-3", makeDeps(makeCodesArray(10))),
			getBackupCodesStatusHandler(
				"user-4",
				makeThrowingDeps(makeBackupCodesNotEnabledError()),
			),
		]);

		expect(fullResult.total).toBe(10);
		expect(emptyResult.total).toBe(10);
	});

	it("handles empty backup codes array gracefully", async () => {
		const result = await getBackupCodesStatusHandler(
			"user-5",
			makeDeps([]),
		);

		expect(result.remaining).toBe(0);
		expect(result.total).toBe(10);
	});

	it("passes userId to viewBackupCodes", async () => {
		const deps = makeDeps(makeCodesArray(5));
		await getBackupCodesStatusHandler("user-abc", deps);

		expect(deps.viewBackupCodes).toHaveBeenCalledWith({
			body: { userId: "user-abc" },
		});
	});

	it("throws ORPCError on non-BACKUP_CODES_NOT_ENABLED errors", async () => {
		// A generic infrastructure error (DB outage, decryption failure, etc.)
		// must surface to the caller so React Query can render an error state.
		const deps = makeThrowingDeps(new Error("connection refused"));

		await expect(
			getBackupCodesStatusHandler("user-6", deps),
		).rejects.toThrow(ORPCError);
	});

	it("returns 0 when backupCodes field is missing from response", async () => {
		const deps: GetBackupCodesStatusDeps = {
			viewBackupCodes: vi
				.fn()
				.mockResolvedValue({ status: true } as never),
		};
		const result = await getBackupCodesStatusHandler("user-x", deps);

		expect(result.remaining).toBe(0);
		expect(result.total).toBe(10);
	});
});
