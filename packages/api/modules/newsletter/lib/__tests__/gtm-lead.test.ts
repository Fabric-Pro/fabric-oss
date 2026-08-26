import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { warn } }));

import { captureConfirmedNewsletterLead } from "../gtm-lead";

describe("confirmed newsletter GTM delivery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.GTM_BRAIN_WEBSITE_LEAD_URL;
		delete process.env.GTM_BRAIN_WEBSITE_LEAD_SECRET;
	});

	it("is disabled unless both endpoint and secret are configured", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await captureConfirmedNewsletterLead({
			email: "subscriber@example.com",
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends only a confirmed, email-only Fabric lead", async () => {
		process.env.GTM_BRAIN_WEBSITE_LEAD_URL =
			"https://gtm.example.com/api/webhooks/gtm/org/website-lead";
		process.env.GTM_BRAIN_WEBSITE_LEAD_SECRET = "secret";
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);

		await captureConfirmedNewsletterLead({
			email: " Subscriber@Example.com ",
			confirmedAt: new Date("2026-07-22T17:00:00.000Z"),
		});

		const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect(url.href).toBe(
			"https://gtm.example.com/api/webhooks/gtm/org/website-lead",
		);
		expect(init.headers).toMatchObject({
			"x-gtm-webhook-secret": "secret",
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			source: "fabric_web",
			event: "fabric_updates_submitted",
			email: "subscriber@example.com",
			marketingConsent: true,
			consentVersion: "fabric-newsletter-double-opt-in-v1",
		});
	});
});
