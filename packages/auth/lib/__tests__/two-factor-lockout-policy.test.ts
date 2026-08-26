/**
 * Contract ("policy pin") tests for `createTwoFactorPlugin()`
 * (../two-factor-policy.ts).
 *
 * These pin the exact shape we depend on to delegate the account-level 2FA
 * lockout (SOC 2 CC6.1) to better-auth's built-in `accountLockout` instead
 * of reimplementing it: the plugin id, the exact lockout parameters, the
 * three sign-in verify endpoint paths, and the `two_factor` schema fields
 * (`failedVerificationCount`/`lockedUntil`) the Prisma model also exposes.
 * A better-auth upgrade that silently renames or drops any of these should
 * fail this suite rather than silently degrading the control.
 *
 * Deliberately asserted only against the plugin's PUBLIC surface — never
 * `better-auth/dist/**`, and never a version string (upgrades are
 * expected; behavior changes are what this suite exists to catch).
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-lockout-policy.test.ts
 */

import type { Prisma } from "@repo/database";
import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import {
	createTwoFactorPlugin,
	isTwoFactorAccountLockedError,
	TWO_FACTOR_ACCOUNT_LOCKOUT,
} from "../two-factor-policy";

describe("TWO_FACTOR_ACCOUNT_LOCKOUT", () => {
	it("pins the exact lockout parameters", () => {
		expect(TWO_FACTOR_ACCOUNT_LOCKOUT).toEqual({
			enabled: true,
			maxFailedAttempts: 10,
			durationSeconds: 900,
		});
	});
});

describe("createTwoFactorPlugin()", () => {
	const plugin = createTwoFactorPlugin();

	it('has plugin id "two-factor"', () => {
		expect(plugin.id).toBe("two-factor");
	});

	it("configures the plugin with the pinned accountLockout policy", () => {
		expect(plugin.options?.accountLockout).toEqual({
			enabled: true,
			maxFailedAttempts: 10,
			durationSeconds: 900,
		});
	});

	it("still exposes the three sign-in verify endpoints at their expected paths", () => {
		expect(plugin.endpoints.verifyTOTP.path).toBe(
			"/two-factor/verify-totp",
		);
		expect(plugin.endpoints.verifyTwoFactorOTP.path).toBe(
			"/two-factor/verify-otp",
		);
		expect(plugin.endpoints.verifyBackupCode.path).toBe(
			"/two-factor/verify-backup-code",
		);
	});

	it("still declares failedVerificationCount and lockedUntil on the twoFactor schema", () => {
		const fields = plugin.schema.twoFactor.fields;

		expect(fields.failedVerificationCount).toMatchObject({
			type: "number",
			required: false,
			defaultValue: 0,
		});
		expect(fields.lockedUntil).toMatchObject({
			type: "date",
			required: false,
		});
	});
});

describe("isTwoFactorAccountLockedError()", () => {
	it("is true for an APIError with body.code ACCOUNT_TEMPORARILY_LOCKED", () => {
		const error = new APIError("TOO_MANY_REQUESTS", {
			code: "ACCOUNT_TEMPORARILY_LOCKED",
			message: "Too many failed verification attempts.",
		});
		expect(isTwoFactorAccountLockedError(error)).toBe(true);
	});

	it("is false for an APIError with a different body.code", () => {
		const error = new APIError("UNAUTHORIZED", {
			code: "INVALID_CODE",
			message: "Invalid code",
		});
		expect(isTwoFactorAccountLockedError(error)).toBe(false);
	});

	it("is false for a plain Error", () => {
		expect(isTwoFactorAccountLockedError(new Error("boom"))).toBe(false);
	});

	it("is false for a non-error value", () => {
		expect(isTwoFactorAccountLockedError(undefined)).toBe(false);
		expect(
			isTwoFactorAccountLockedError("ACCOUNT_TEMPORARILY_LOCKED"),
		).toBe(false);
	});
});

describe("Prisma.TwoFactorSelect", () => {
	it("accepts failedVerificationCount and lockedUntil (type-level)", () => {
		// This assertion is purely type-level: it proves the currently
		// generated Prisma client exposes both fields on `TwoFactorSelect` —
		// not that a live database's schema matches it. If either field were
		// dropped from `schema.prisma` and the client regenerated, this file
		// would fail to type-check. There is nothing to run at runtime — the
		// `expect` just gives the assertion a home.
		const select: Prisma.TwoFactorSelect = {
			failedVerificationCount: true,
			lockedUntil: true,
		};
		expect(select).toBeDefined();
	});
});
