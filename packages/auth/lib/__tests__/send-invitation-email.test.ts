/**
 * `sendEmail` reports a provider or rendering failure by returning false, not
 * by throwing, so an unchecked call reported every failed invitation as sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendEmail, getUserByEmail, logError } = vi.hoisted(() => ({
	sendEmail: vi.fn(),
	getUserByEmail: vi.fn(),
	logError: vi.fn(),
}));

vi.mock("@repo/mail", () => ({ sendEmail }));
vi.mock("@repo/database", () => ({ getUserByEmail }));
vi.mock("@repo/logs", () => ({ logger: { error: logError } }));
vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
}));
vi.mock("../invitation-token", () => ({
	buildInvitationToken: () => "token/example",
}));

import { sendOrganizationInvitationEmail } from "../send-invitation-email";

const INVITATION = {
	id: "invitation_example",
	email: "new@example.com",
	organization: { name: "Example Org" },
};

beforeEach(() => {
	vi.clearAllMocks();
	sendEmail.mockResolvedValue(true);
	getUserByEmail.mockResolvedValue(null);
});

describe("sendOrganizationInvitationEmail", () => {
	it("sends a new address to sign-up with the invitation token", async () => {
		await sendOrganizationInvitationEmail(INVITATION, "en");

		expect(sendEmail).toHaveBeenCalledWith({
			to: "new@example.com",
			templateId: "organizationInvitation",
			locale: "en",
			context: {
				organizationName: "Example Org",
				url: "https://app.example.com/auth/signup/invite/token%2Fexample",
			},
		});
	});

	it("sends an existing account to sign-in", async () => {
		getUserByEmail.mockResolvedValue({ id: "user_example" });

		await sendOrganizationInvitationEmail(INVITATION, "en");

		expect(sendEmail.mock.calls[0]?.[0]?.context.url).toContain(
			"/auth/login/invite/",
		);
	});

	it("fails when the email was not sent, without naming the address", async () => {
		sendEmail.mockResolvedValue(false);

		await expect(
			sendOrganizationInvitationEmail(INVITATION, "en"),
		).rejects.toThrow("invitation_example");
		expect(logError.mock.calls[0]?.[0]).toContain("invitation_example");
		expect(JSON.stringify(logError.mock.calls)).not.toContain(
			"new@example.com",
		);
	});
});
