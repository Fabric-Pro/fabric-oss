import { describe, expect, it } from "vitest";
import {
	assertPasswordStrength,
	PasswordTooWeakError,
} from "../password-strength";

describe("assertPasswordStrength", () => {
	it("rejects short passwords", () => {
		expect(() => assertPasswordStrength("short", {})).toThrow(
			PasswordTooWeakError,
		);
	});

	it("rejects common passwords", () => {
		expect(() => assertPasswordStrength("password1234", {})).toThrow(
			PasswordTooWeakError,
		);
	});

	it("rejects passwords containing the user's email local part", () => {
		expect(() =>
			assertPasswordStrength("johnsmith2026!", {
				email: "johnsmith@example.com",
			}),
		).toThrow(PasswordTooWeakError);
	});

	it("accepts a strong passphrase", () => {
		expect(() =>
			assertPasswordStrength("correct horse battery staple ✓", {}),
		).not.toThrow();
	});

	it("error includes feedback suggestions", () => {
		try {
			assertPasswordStrength("password1234", {});
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(PasswordTooWeakError);
			expect(
				(e as PasswordTooWeakError).suggestions.length,
			).toBeGreaterThan(0);
		}
	});
});
