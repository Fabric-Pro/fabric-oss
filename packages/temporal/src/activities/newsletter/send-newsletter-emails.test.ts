import { describe, expect, it, vi } from "vitest";

// heartbeat() throws outside an activity context; mock it.
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const sendEmail = vi.fn();
vi.mock("@repo/mail", () => ({
	sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

const claimDelivery = vi.fn().mockResolvedValue({ alreadySent: false });
const markDelivery = vi.fn().mockResolvedValue(undefined);
vi.mock("@repo/database", () => ({
	claimDelivery: (...a: unknown[]) => claimDelivery(...a),
	markDelivery: (...a: unknown[]) => markDelivery(...a),
}));

import { sendNewsletterEmailsActivity } from "./send-newsletter-emails";

const baseInput = {
	sendId: "s1",
	projectId: "p",
	organizationId: null,
	userId: null,
	projectName: "Acme",
	content: {
		schemaVersion: 1 as const,
		headline: "H",
		intro: "I",
		hasMajorFeatures: true,
		highlights: [],
	},
	subscribers: [
		{ id: "1", email: "a@example.com", name: null, unsubscribeToken: "t1" },
		{ id: "2", email: "c@example.org", name: null, unsubscribeToken: "t2" },
	],
};

describe("sendNewsletterEmailsActivity", () => {
	it("claims, sends, and marks SENT for each recipient", async () => {
		claimDelivery.mockReset().mockResolvedValue({ alreadySent: false });
		sendEmail.mockReset().mockResolvedValue(true);
		const out = await sendNewsletterEmailsActivity(baseInput);
		expect(out).toEqual({ sentCount: 2, failedCount: 0 });
		expect(claimDelivery).toHaveBeenCalledTimes(2);
		expect(sendEmail).toHaveBeenCalledTimes(2);
		expect(sendEmail.mock.calls[0][0]).toMatchObject({
			templateId: "releaseNotesNewsletter",
			idempotencyKey: expect.stringContaining("newsletter-s1-"),
		});
	});

	it("skips a recipient already marked SENT (no re-send)", async () => {
		sendEmail.mockReset().mockResolvedValue(true);
		claimDelivery
			.mockReset()
			.mockResolvedValueOnce({ alreadySent: true })
			.mockResolvedValueOnce({ alreadySent: false });
		const out = await sendNewsletterEmailsActivity(baseInput);
		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(out.sentCount).toBe(2); // already-sent counts as sent
	});

	it("counts a provider failure and continues", async () => {
		claimDelivery.mockReset().mockResolvedValue({ alreadySent: false });
		markDelivery.mockReset().mockResolvedValue(undefined);
		// pass 1: a@example.com fails, c@example.org sends; pass 2 retry of a@example.com also fails.
		sendEmail
			.mockReset()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const out = await sendNewsletterEmailsActivity(baseInput);
		expect(out).toEqual({ sentCount: 1, failedCount: 1 });
		expect(markDelivery).toHaveBeenCalledWith(
			"s1",
			"a@example.com",
			"FAILED",
			expect.any(String),
		);
	});
});
