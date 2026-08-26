import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			signUpEmail: vi.fn(),
			getSession: vi.fn(),
		},
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		user: {
			findUnique: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
	},
	acceptProjectInvitation: vi.fn(),
	declineProjectInvitation: vi.fn(),
	getProjectInvitationWithEmail: vi.fn(),
}));

// The action must no longer send the welcome email itself — that moved to
// the `afterEmailVerification` hook in packages/auth/auth.ts. The mock stays
// as a tripwire: if the welcome-email block is ever reintroduced here, the
// not-called assertions below fail.
vi.mock("@repo/mail", () => ({
	sendEmail: vi.fn(),
}));

vi.mock("next/headers", () => ({
	headers: vi.fn(),
}));

import { auth } from "@repo/auth";
import { db, getProjectInvitationWithEmail } from "@repo/database";
import { sendEmail } from "@repo/mail";
import { headers } from "next/headers";
import { signUpForProjectInvitationAction } from "../project-invitation-actions";

const signUpEmailMock = auth.api.signUpEmail as unknown as ReturnType<
	typeof vi.fn
>;
const findUniqueMock = db.user.findUnique as unknown as ReturnType<
	typeof vi.fn
>;
const userUpdateMock = db.user.update as unknown as ReturnType<typeof vi.fn>;
const userUpdateManyMock = db.user.updateMany as unknown as ReturnType<
	typeof vi.fn
>;
const getInvitationMock =
	getProjectInvitationWithEmail as unknown as ReturnType<typeof vi.fn>;
const sendEmailMock = sendEmail as unknown as ReturnType<typeof vi.fn>;
const headersMock = headers as unknown as ReturnType<typeof vi.fn>;

const VALID_PASSWORD = "Aabcdefghij2!"; // 13 chars, well over MIN_LENGTH=12

function setupHappyPath() {
	getInvitationMock.mockResolvedValueOnce({
		email: "Invitee@Example.test",
		status: "PENDING",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	});
	findUniqueMock.mockResolvedValueOnce(null);
	signUpEmailMock.mockResolvedValueOnce({ user: { id: "user-1" } });
	userUpdateMock.mockResolvedValue({});
}

beforeEach(() => {
	vi.clearAllMocks();
	headersMock.mockResolvedValue({
		get: () => "",
	});
});

describe("signUpForProjectInvitationAction", () => {
	it("returns PASSWORD_TOO_WEAK with message and suggestions when Better Auth throws that code", async () => {
		getInvitationMock.mockResolvedValueOnce({
			email: "Invitee@Example.test",
			status: "PENDING",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		findUniqueMock.mockResolvedValueOnce(null);
		signUpEmailMock.mockRejectedValueOnce({
			body: {
				code: "PASSWORD_TOO_WEAK",
				message: "Try a longer phrase.",
				suggestions: ["use 3 words", "avoid common words"],
			},
		});

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
			captchaToken: "tok",
		});

		expect(result).toEqual({
			success: false,
			code: "PASSWORD_TOO_WEAK",
			message: "Try a longer phrase.",
			suggestions: ["use 3 words", "avoid common words"],
		});
		expect(sendEmailMock).not.toHaveBeenCalled();
	});

	it("returns CAPTCHA_FAILED when Better Auth throws that code", async () => {
		getInvitationMock.mockResolvedValueOnce({
			email: "Invitee@Example.test",
			status: "PENDING",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		findUniqueMock.mockResolvedValueOnce(null);
		signUpEmailMock.mockRejectedValueOnce({
			body: { code: "CAPTCHA_FAILED" },
		});

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
		});

		expect(result).toEqual({ success: false, code: "CAPTCHA_FAILED" });
	});

	it("collapses any unrecognised error to UNKNOWN_ERROR (no message leakage)", async () => {
		getInvitationMock.mockResolvedValueOnce({
			email: "Invitee@Example.test",
			status: "PENDING",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		findUniqueMock.mockResolvedValueOnce(null);
		signUpEmailMock.mockRejectedValueOnce(new Error("internal DB outage"));

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
		});

		expect(result).toEqual({ success: false, code: "UNKNOWN_ERROR" });
		expect(JSON.stringify(result)).not.toContain("internal DB outage");
	});

	it("fast-fails with PASSWORD_TOO_WEAK + canonical suggestion when the password is shorter than 12 characters", async () => {
		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: "ShortPwd11x", // 11 chars
		});

		expect(result).toEqual({
			success: false,
			code: "PASSWORD_TOO_WEAK",
			message: "Password must be at least 12 characters.",
			suggestions: ["Use a passphrase of multiple words."],
		});
		expect(getInvitationMock).not.toHaveBeenCalled();
		expect(signUpEmailMock).not.toHaveBeenCalled();
	});

	it("accepts a 12-character password and proceeds past the fast-fail guard", async () => {
		setupHappyPath();

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: "twelveCharac", // exactly 12 chars
		});

		expect(result).toEqual({
			success: true,
			email: "invitee@example.test",
			requiresVerification: true,
		});
		expect(signUpEmailMock).toHaveBeenCalledTimes(1);
	});

	it("returns INVITATION_NOT_FOUND when the invitation row does not exist", async () => {
		getInvitationMock.mockResolvedValueOnce(null);

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-missing",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
		});

		expect(result).toEqual({
			success: false,
			code: "INVITATION_NOT_FOUND",
		});
	});

	it("returns INVITATION_EXPIRED when the invitation is past its expiry date", async () => {
		getInvitationMock.mockResolvedValueOnce({
			email: "Invitee@Example.test",
			status: "PENDING",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		});

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-old",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
		});

		expect(result).toEqual({ success: false, code: "INVITATION_EXPIRED" });
	});

	it("returns USER_EXISTS when a row already exists for the invited email", async () => {
		getInvitationMock.mockResolvedValueOnce({
			email: "Invitee@Example.test",
			status: "PENDING",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		findUniqueMock.mockResolvedValueOnce({ id: "existing-id" });

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
		});

		expect(result).toEqual({ success: false, code: "USER_EXISTS" });
		expect(signUpEmailMock).not.toHaveBeenCalled();
	});

	it("returns requiresVerification: true on success (verify-first contract)", async () => {
		setupHappyPath();

		const result = await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
			captchaToken: "tok",
		});

		expect(result).toEqual({
			success: true,
			email: "invitee@example.test",
			requiresVerification: true,
		});
	});

	it("passes the invitation-page callbackURL and the captcha token through to signUpEmail", async () => {
		setupHappyPath();

		await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
			captchaToken: "tok",
		});

		expect(signUpEmailMock).toHaveBeenCalledTimes(1);
		const body = signUpEmailMock.mock.calls[0][0].body;
		expect(body.email).toBe("invitee@example.test");
		expect(body.callbackURL).toBe("/project-invitation/inv-1");
		expect(body.captchaToken).toBe("tok");
	});

	it("sets onboardingComplete but does NOT mark the email verified", async () => {
		setupHappyPath();

		await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
		});

		expect(userUpdateMock).toHaveBeenCalledTimes(1);
		const updateArg = userUpdateMock.mock.calls[0][0];
		expect(updateArg.where).toEqual({ id: "user-1" });
		expect(updateArg.data).toEqual({ onboardingComplete: true });
		expect(updateArg.data).not.toHaveProperty("emailVerified");
	});

	it("does not send any email itself — the welcome email moved to afterEmailVerification", async () => {
		setupHappyPath();

		await signUpForProjectInvitationAction({
			invitationId: "inv-1",
			name: "Ada Lovelace",
			password: VALID_PASSWORD,
		});

		expect(sendEmailMock).not.toHaveBeenCalled();
		// The atomic welcomeEmailSentAt guard lived in this action before the
		// verify-first flow; it must not come back.
		expect(userUpdateManyMock).not.toHaveBeenCalled();
	});
});
