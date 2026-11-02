import { APIError, createEmailVerificationToken } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checks = vi.hoisted(() => ({
	exact: vi.fn(),
	tuple: vi.fn(),
}));

vi.mock("../email-verify-blocklist", () => ({
	getEmailVerifyJWTBlockStatus: checks.exact,
	getEmailChangeRevocationStatus: checks.tuple,
}));

import { assertEmailVerifyNotRevoked } from "../email-verify-revocation";

const SECRET = "email-revocation-test-secret-long-enough-for-hs256";
const OLD_EMAIL = "old@example.com";
const NEW_EMAIL = "new@example.com";

async function changeEmailToken(
	requestType: "change-email-confirmation" | "change-email-verification",
) {
	return createEmailVerificationToken(SECRET, OLD_EMAIL, NEW_EMAIL, 3600, {
		requestType,
	});
}

async function expectAPIError(
	operation: Promise<void>,
	status: string,
	message: string,
) {
	try {
		await operation;
	} catch (error) {
		expect(error).toBeInstanceOf(APIError);
		expect(error).toMatchObject({ status, message });
		return;
	}
	throw new Error("Expected verification guard to throw an APIError");
}

beforeEach(() => {
	checks.exact.mockReset().mockResolvedValue("clear");
	checks.tuple.mockReset().mockResolvedValue("clear");
});

describe("email verification revocation guard", () => {
	it.each([
		"change-email-confirmation",
		"change-email-verification",
	] as const)(
		"refuses a %s token when the tuple revocation read is unavailable",
		async (requestType) => {
			checks.tuple.mockResolvedValue("unavailable");
			const token = await changeEmailToken(requestType);

			await expectAPIError(
				assertEmailVerifyNotRevoked(token, SECRET),
				"SERVICE_UNAVAILABLE",
				"Email verification is temporarily unavailable. Please try again.",
			);
		},
	);

	it("refuses an email-change token when the exact-token read is unavailable", async () => {
		checks.exact.mockResolvedValue("unavailable");
		const token = await changeEmailToken("change-email-verification");

		await expectAPIError(
			assertEmailVerifyNotRevoked(token, SECRET),
			"SERVICE_UNAVAILABLE",
			"Email verification is temporarily unavailable. Please try again.",
		);
	});

	it("allows an email-change token when both revocation reads are clear", async () => {
		const token = await changeEmailToken("change-email-verification");

		await expect(
			assertEmailVerifyNotRevoked(token, SECRET),
		).resolves.toBeUndefined();
		expect(checks.exact).toHaveBeenCalledOnce();
		expect(checks.exact).toHaveBeenCalledWith(token);
		expect(checks.tuple).toHaveBeenCalledOnce();
		expect(checks.tuple).toHaveBeenCalledWith(OLD_EMAIL, NEW_EMAIL);
	});

	it("reports a stored tuple marker as revoked", async () => {
		checks.tuple.mockResolvedValue("revoked");
		const token = await changeEmailToken("change-email-verification");

		await expectAPIError(
			assertEmailVerifyNotRevoked(token, SECRET),
			"BAD_REQUEST",
			"This verification link has been revoked.",
		);
	});

	it.each([
		[
			"a plain verification token",
			() => createEmailVerificationToken(SECRET, OLD_EMAIL),
		],
		[
			"an email-change token",
			() => changeEmailToken("change-email-verification"),
		],
	] as const)(
		"refuses %s blocked by the exact-token check while the tuple read is clear",
		async (_label, makeToken) => {
			checks.exact.mockResolvedValue("revoked");
			const token = await makeToken();

			await expectAPIError(
				assertEmailVerifyNotRevoked(token, SECRET),
				"BAD_REQUEST",
				"This verification link has been revoked.",
			);
		},
	);

	it("keeps plain email verification fail-open when the exact-token read is unavailable", async () => {
		checks.exact.mockResolvedValue("unavailable");
		const token = await createEmailVerificationToken(SECRET, OLD_EMAIL);

		await expect(
			assertEmailVerifyNotRevoked(token, SECRET),
		).resolves.toBeUndefined();
		expect(checks.exact).toHaveBeenCalledOnce();
		expect(checks.exact).toHaveBeenCalledWith(token);
		expect(checks.tuple).not.toHaveBeenCalled();
	});

	it("lets Better Auth handle an invalid or expired JWT", async () => {
		await expect(
			assertEmailVerifyNotRevoked("not-a-jwt", SECRET),
		).resolves.toBeUndefined();
		expect(checks.exact).not.toHaveBeenCalled();
		expect(checks.tuple).not.toHaveBeenCalled();
	});
});
