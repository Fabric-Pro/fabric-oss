import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock next-intl: useTranslations returns a function that returns the key path
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

import { useAuthErrorMessages } from "../errors-messages";

describe("useAuthErrorMessages", () => {
	it("returns a non-generic message for all credential error codes (collapsed to same key)", () => {
		const { result } = renderHook(() => useAuthErrorMessages());
		const { getAuthErrorMessage } = result.current;

		const credentialCodes = [
			"INVALID_PASSWORD",
			"USER_NOT_FOUND",
			"CREDENTIAL_ACCOUNT_NOT_FOUND",
			"USER_EMAIL_NOT_FOUND",
			"ACCOUNT_NOT_FOUND",
			"INVALID_EMAIL_OR_PASSWORD",
		];

		for (const code of credentialCodes) {
			const message = getAuthErrorMessage(code);
			expect(message).toBe("auth.errors.invalidEmailOrPassword");
		}
	});

	it("does not map credential codes to old specific keys", () => {
		const { result } = renderHook(() => useAuthErrorMessages());
		const { getAuthErrorMessage } = result.current;

		const oldKeys = [
			"auth.errors.userNotFound",
			"auth.errors.invalidPassword",
			"auth.errors.credentialAccountNotFound",
			"auth.errors.userEmailNotFound",
			"auth.errors.accountNotFound",
		];

		const credentialCodes = [
			"INVALID_PASSWORD",
			"USER_NOT_FOUND",
			"CREDENTIAL_ACCOUNT_NOT_FOUND",
			"USER_EMAIL_NOT_FOUND",
			"ACCOUNT_NOT_FOUND",
		];

		for (const code of credentialCodes) {
			const message = getAuthErrorMessage(code);
			expect(oldKeys).not.toContain(message);
		}
	});

	it("returns mapped messages for all two-factor error codes", () => {
		const { result } = renderHook(() => useAuthErrorMessages());
		const { getAuthErrorMessage } = result.current;

		const twoFactorMappings: Record<string, string> = {
			INVALID_CODE: "auth.errors.twoFactor.invalidCode",
			OTP_NOT_ENABLED: "auth.errors.twoFactor.otpNotEnabled",
			OTP_HAS_EXPIRED: "auth.errors.twoFactor.otpExpired",
			TOTP_NOT_ENABLED: "auth.errors.twoFactor.totpNotEnabled",
			TWO_FACTOR_NOT_ENABLED: "auth.errors.twoFactor.notEnabled",
			BACKUP_CODES_NOT_ENABLED:
				"auth.errors.twoFactor.backupCodesNotEnabled",
			INVALID_BACKUP_CODE: "auth.errors.twoFactor.invalidBackupCode",
			TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
				"auth.errors.twoFactor.tooManyAttempts",
			INVALID_TWO_FACTOR_COOKIE: "auth.errors.twoFactor.invalidSession",
		};

		for (const [code, expectedKey] of Object.entries(twoFactorMappings)) {
			expect(getAuthErrorMessage(code)).toBe(expectedKey);
		}
	});

	it("returns mapped messages for all passkey error codes", () => {
		const { result } = renderHook(() => useAuthErrorMessages());
		const { getAuthErrorMessage } = result.current;

		const passkeyMappings: Record<string, string> = {
			CHALLENGE_NOT_FOUND: "auth.errors.passkey.challengeNotFound",
			FAILED_TO_VERIFY_REGISTRATION:
				"auth.errors.passkey.registrationFailed",
			PASSKEY_NOT_FOUND: "auth.errors.passkey.notFound",
			AUTHENTICATION_FAILED: "auth.errors.passkey.authenticationFailed",
			UNABLE_TO_CREATE_SESSION: "auth.errors.passkey.sessionFailed",
			FAILED_TO_UPDATE_PASSKEY: "auth.errors.passkey.updateFailed",
			YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY:
				"auth.errors.passkey.notAllowed",
		};

		for (const [code, expectedKey] of Object.entries(passkeyMappings)) {
			expect(getAuthErrorMessage(code)).toBe(expectedKey);
		}
	});

	it("maps USER_ALREADY_HAS_PASSWORD to the correct i18n key", () => {
		const { result } = renderHook(() => useAuthErrorMessages());
		const { getAuthErrorMessage } = result.current;
		expect(getAuthErrorMessage("USER_ALREADY_HAS_PASSWORD")).toBe(
			"auth.errors.userAlreadyHasPassword",
		);
	});

	it("returns generic unknown message for unmapped codes", () => {
		const { result } = renderHook(() => useAuthErrorMessages());
		const { getAuthErrorMessage } = result.current;
		expect(getAuthErrorMessage("SOME_UNKNOWN_CODE")).toBe(
			"auth.errors.unknown",
		);
	});

	it("returns generic unknown message for undefined", () => {
		const { result } = renderHook(() => useAuthErrorMessages());
		const { getAuthErrorMessage } = result.current;
		expect(getAuthErrorMessage(undefined)).toBe("auth.errors.unknown");
	});
});
