/**
 * Delivery of a readiness help request (Fizzy #2165, FR22).
 *
 * The interesting cases are the two where nothing is sent. An unconfigured
 * deployment must not be told its request was passed on, and a provider
 * failure must not take the recorded flag down with it — both surface as
 * `false`, and both are asserted here rather than left to the caller to
 * discover in production.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockSendEmail, mockConfig } = vi.hoisted(() => ({
	mockDb: { project: { findUnique: vi.fn() } },
	mockSendEmail: vi.fn(),
	mockConfig: {
		support: { email: "" },
		i18n: { defaultLocale: "en" },
	},
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mockDb,
}));

vi.mock("@repo/mail", () => ({
	sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

vi.mock("@repo/config", () => ({ config: mockConfig }));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	toAbsoluteUrl: (path: string) => `https://example.test${path}`,
}));

import { deliverReadinessHelpRequest } from "../help-request";

const REQUEST = {
	projectId: "p1",
	itemKey: "feature-snapshot",
	requesterName: "Alex Doe",
	requesterEmail: "alex@example.com",
	requestedAt: new Date("2026-09-01T10:00:00Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mockConfig.support.email = "help@example.com";
	mockSendEmail.mockResolvedValue(true);
	mockDb.project.findUnique.mockResolvedValue({
		name: "Example project",
		organization: { slug: "example-org" },
	});
});

describe("deliverReadinessHelpRequest", () => {
	it("mails the configured inbox with the item's own name and a link back", async () => {
		const notified = await deliverReadinessHelpRequest(REQUEST);

		expect(notified).toBe(true);
		const args = mockSendEmail.mock.calls[0][0];
		expect(args.to).toBe("help@example.com");
		expect(args.templateId).toBe("readinessHelpRequested");
		// The registry's i18n key resolved against the real bundle — a rename
		// on either side should fail here rather than mail a raw key.
		expect(args.context.itemName).toBe("Feature Snapshot");
		expect(args.context.projectName).toBe("Example project");
		expect(args.context.requesterEmail).toBe("alex@example.com");
		expect(args.context.url).toBe(
			"https://example.test/app/example-org/projects/p1",
		);
	});

	it("collapses same-day repeats onto one idempotency key", async () => {
		await deliverReadinessHelpRequest(REQUEST);
		await deliverReadinessHelpRequest({
			...REQUEST,
			requestedAt: new Date("2026-09-01T23:59:00Z"),
		});
		await deliverReadinessHelpRequest({
			...REQUEST,
			requestedAt: new Date("2026-09-02T00:01:00Z"),
		});

		const keys = mockSendEmail.mock.calls.map(
			(call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
		);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[2]).not.toBe(keys[0]);
	});

	it("sends nothing, and says so, when no support inbox is configured", async () => {
		// The out-of-the-box state until a deployment sets SUPPORT_EMAIL, so
		// it has to stay silent rather than hand the provider an empty `to`.
		mockConfig.support.email = "";

		const notified = await deliverReadinessHelpRequest(REQUEST);

		expect(notified).toBe(false);
		expect(mockSendEmail).not.toHaveBeenCalled();
		// Not even the project read: a click that can go nowhere should cost
		// nothing.
		expect(mockDb.project.findUnique).not.toHaveBeenCalled();
	});

	it("reports a provider failure as not notified instead of throwing", async () => {
		mockSendEmail.mockRejectedValue(new Error("provider down"));

		await expect(deliverReadinessHelpRequest(REQUEST)).resolves.toBe(false);
	});

	it("falls back to the personal project path when the org has no slug", async () => {
		mockDb.project.findUnique.mockResolvedValue({
			name: "Example project",
			organization: null,
		});

		await deliverReadinessHelpRequest(REQUEST);

		expect(mockSendEmail.mock.calls[0][0].context.url).toBe(
			"https://example.test/app/projects/p1",
		);
	});
});
