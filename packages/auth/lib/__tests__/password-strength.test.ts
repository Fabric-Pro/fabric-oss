import { describe, expect, it, vi } from "vitest";

const estimatorLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock("@zxcvbn-ts/core", async (importOriginal) => {
	estimatorLoads.count += 1;
	return importOriginal();
});

import {
	assertPasswordStrength,
	PasswordTooWeakError,
} from "../password-strength";

describe("assertPasswordStrength", () => {
	it("loads the estimator on the first check, once", async () => {
		// Arrange
		expect(estimatorLoads.count).toBe(0);

		// Act
		await assertPasswordStrength("correct horse battery staple ✓", {});
		await assertPasswordStrength("another strong passphrase here ✓", {});

		// Assert
		expect(estimatorLoads.count).toBe(1);
	});

	it("rejects short passwords", async () => {
		await expect(assertPasswordStrength("short", {})).rejects.toThrow(
			PasswordTooWeakError,
		);
	});

	it("rejects common passwords", async () => {
		await expect(
			assertPasswordStrength("password1234", {}),
		).rejects.toThrow(PasswordTooWeakError);
	});

	it("rejects passwords containing the user's email local part", async () => {
		await expect(
			assertPasswordStrength("johnsmith2026!", {
				email: "johnsmith@example.com",
			}),
		).rejects.toThrow(PasswordTooWeakError);
	});

	it("accepts a strong passphrase", async () => {
		await expect(
			assertPasswordStrength("correct horse battery staple ✓", {}),
		).resolves.toBeUndefined();
	});

	it("error includes feedback suggestions", async () => {
		const error = await assertPasswordStrength("password1234", {}).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(PasswordTooWeakError);
		expect(
			(error as PasswordTooWeakError).suggestions.length,
		).toBeGreaterThan(0);
	});
});
