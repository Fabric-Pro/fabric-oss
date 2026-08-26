import { beforeEach, describe, expect, it, vi } from "vitest";

// heartbeat() throws outside an activity context; mock it.
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const sendEmail = vi.fn();
const isMailConfigured = vi.fn();
vi.mock("@repo/mail", () => ({
	sendEmail: (...a: unknown[]) => sendEmail(...a),
	isMailConfigured: () => isMailConfigured(),
}));

const warn = vi.fn();
const resolveNewsletterReviewRecipients = vi.fn();
vi.mock("@repo/database", () => ({
	resolveNewsletterReviewRecipients: (...a: unknown[]) =>
		resolveNewsletterReviewRecipients(...a),
}));

vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://example.com/",
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: (...a: unknown[]) => warn(...a),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

import { sendNewsletterApprovalEmailsActivity } from "./send-newsletter-approval-emails";

const orgContext = {
	sendId: "s1",
	projectId: "p1",
	projectName: "Example Project",
	organizationId: "org-1",
	organizationSlug: "example-org",
	recipients: [
		{ userId: "u1", email: "one@example.com", reviewEmails: true },
		{ userId: "u2", email: "two@example.com", reviewEmails: true },
	],
};

const personalContext = {
	...orgContext,
	organizationId: null,
	organizationSlug: null,
	recipients: [
		{ userId: "u1", email: "one@example.com", reviewEmails: true },
	],
};

describe("sendNewsletterApprovalEmailsActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isMailConfigured.mockReturnValue(true);
		sendEmail.mockResolvedValue(true);
		resolveNewsletterReviewRecipients.mockResolvedValue(orgContext);
	});

	it("throws before sending anything when mail is unconfigured", async () => {
		// Retry-safe: nothing has been attempted, so a Temporal retry after the
		// key is supplied delivers to everybody.
		isMailConfigured.mockReturnValue(false);

		await expect(
			sendNewsletterApprovalEmailsActivity({ sendId: "s1" }),
		).rejects.toThrow(/not configured/i);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(resolveNewsletterReviewRecipients).not.toHaveBeenCalled();
	});

	it("sends nothing when the send is no longer awaiting review", async () => {
		resolveNewsletterReviewRecipients.mockResolvedValue(null);

		await sendNewsletterApprovalEmailsActivity({ sendId: "s1" });

		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("sends one email per recipient with a per-recipient idempotency key", async () => {
		await sendNewsletterApprovalEmailsActivity({ sendId: "s1" });

		expect(sendEmail).toHaveBeenCalledTimes(2);
		expect(sendEmail.mock.calls[0][0]).toMatchObject({
			to: "one@example.com",
			templateId: "newsletterApprovalPending",
			idempotencyKey: "newsletter-approval-s1-u1",
		});
		expect(sendEmail.mock.calls[1][0]).toMatchObject({
			to: "two@example.com",
			idempotencyKey: "newsletter-approval-s1-u2",
		});
	});

	it("builds a tenant-complete URL for an organization send", async () => {
		await sendNewsletterApprovalEmailsActivity({ sendId: "s1" });

		expect(sendEmail.mock.calls[0][0].context.url).toBe(
			"https://example.com/app/example-org/projects/p1?tab=settings&settingsTab=newsletter",
		);
	});

	it("builds a personal URL with no slug segment", async () => {
		resolveNewsletterReviewRecipients.mockResolvedValue(personalContext);

		await sendNewsletterApprovalEmailsActivity({ sendId: "s1" });

		expect(sendEmail.mock.calls[0][0].context.url).toBe(
			"https://example.com/app/projects/p1?tab=settings&settingsTab=newsletter",
		);
	});

	it("sends nothing for an organization whose organization has no slug", async () => {
		// /app/{slug}/… cannot be built, and interpolating the null would point
		// an authorized reviewer at /app/null/…. Falling back to the personal
		// path would be worse — a URL in the wrong tenant context.
		resolveNewsletterReviewRecipients.mockResolvedValue({
			...orgContext,
			organizationSlug: null,
		});

		await sendNewsletterApprovalEmailsActivity({ sendId: "s1" });

		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("skips a recipient who turned reviewEmails off", async () => {
		resolveNewsletterReviewRecipients.mockResolvedValue({
			...orgContext,
			recipients: [
				{ userId: "u1", email: "one@example.com", reviewEmails: false },
				{ userId: "u2", email: "two@example.com", reviewEmails: true },
			],
		});

		await sendNewsletterApprovalEmailsActivity({ sendId: "s1" });

		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(sendEmail.mock.calls[0][0].to).toBe("two@example.com");
	});

	it("skips a recipient with no email address", async () => {
		resolveNewsletterReviewRecipients.mockResolvedValue({
			...orgContext,
			recipients: [
				{ userId: "u1", email: null, reviewEmails: true },
				{ userId: "u2", email: "two@example.com", reviewEmails: true },
			],
		});

		await sendNewsletterApprovalEmailsActivity({ sendId: "s1" });

		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it("attempts every recipient even when the first one fails", async () => {
		sendEmail.mockRejectedValueOnce(new Error("boom"));

		await expect(
			sendNewsletterApprovalEmailsActivity({ sendId: "s1" }),
		).rejects.toThrow();
		expect(sendEmail).toHaveBeenCalledTimes(2);
	});

	it("throws when ANY recipient fails, so Temporal retries the batch", async () => {
		// Returning success on a mixed outcome would mean the failed reviewer is
		// never told: nothing re-drives this. Retrying the whole batch is safe
		// because there is no claim — delivered recipients are suppressed by
		// their idempotency keys.
		sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		await expect(
			sendNewsletterApprovalEmailsActivity({ sendId: "s1" }),
		).rejects.toThrow(/1 of 2/);
	});

	it("treats a false return as a failure, not just a throw", async () => {
		// sendEmail swallows provider errors and reports them as `false`.
		sendEmail.mockResolvedValue(false);

		await expect(
			sendNewsletterApprovalEmailsActivity({ sendId: "s1" }),
		).rejects.toThrow();
	});

	it("names the failed recipient in the log, on both failure shapes", async () => {
		// sendEmail already logs the address, provider error and stack; userId
		// is the field it cannot know, and without it a triager reading
		// "1 of 2 failed" has no way to tell WHICH reviewer went untold.
		sendEmail
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(false);

		await expect(
			sendNewsletterApprovalEmailsActivity({ sendId: "s1" }),
		).rejects.toThrow();

		const loggedUserIds = warn.mock.calls.map((c) => c[1]?.userId);
		expect(loggedUserIds).toEqual(["u1", "u2"]);
	});

	it("does not throw when nobody is eligible", async () => {
		resolveNewsletterReviewRecipients.mockResolvedValue({
			...orgContext,
			recipients: [],
		});

		await expect(
			sendNewsletterApprovalEmailsActivity({ sendId: "s1" }),
		).resolves.toBeUndefined();
		expect(sendEmail).not.toHaveBeenCalled();
	});
});
