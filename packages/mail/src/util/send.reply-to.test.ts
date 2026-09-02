import { describe, expect, it, vi } from "vitest";

const sendSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../provider", () => ({
	send: (...args: unknown[]) => sendSpy(...args),
}));
vi.mock("./templates", () => ({
	getTemplate: vi
		.fn()
		.mockResolvedValue({ subject: "S", text: "T", html: "<p>H</p>" }),
}));

const { mockConfig } = vi.hoisted(() => ({
	mockConfig: { support: { email: "help@example.com" } },
}));
vi.mock("@repo/config", () => ({
	config: {
		...mockConfig,
		i18n: { defaultLocale: "en", locales: { en: {} } },
		mails: { from: "noreply@example.com" },
	},
}));

import { sendEmail } from "./send";

/**
 * The From address is a no-reply sender with no mailbox behind it. Replying to
 * a Fabric email is the most natural response to one, so these pin that the
 * reply has somewhere to land (Fizzy #2165).
 */
describe("sendEmail Reply-To", () => {
	it("points replies at the support inbox on templated mail", async () => {
		sendSpy.mockClear();
		await sendEmail({
			to: "user@example.com",
			templateId: "releaseNotesNewsletter",
			// @ts-expect-error context shape intentionally unchecked; getTemplate is mocked
			context: {},
		});
		expect(sendSpy.mock.calls[0][0]).toMatchObject({
			replyTo: "help@example.com",
		});
	});

	it("lets a caller override it", async () => {
		sendSpy.mockClear();
		await sendEmail({
			to: "user@example.com",
			subject: "S",
			text: "T",
			replyTo: "someone-else@example.com",
		});
		expect(sendSpy.mock.calls[0][0]).toMatchObject({
			replyTo: "someone-else@example.com",
		});
	});

	it("sends no Reply-To when the deployment has named no inbox", async () => {
		sendSpy.mockClear();
		mockConfig.support.email = "";
		await sendEmail({ to: "user@example.com", subject: "S", text: "T" });
		// Absent rather than empty: pointing replies at an address nobody
		// chose would be worse than leaving the header off.
		expect(sendSpy.mock.calls[0][0]).not.toHaveProperty("replyTo");
		mockConfig.support.email = "help@example.com";
	});
});
