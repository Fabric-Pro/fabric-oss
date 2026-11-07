import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

describe("report branding transport", () => {
	it("encodes report identity and sends only the reviewed branding command", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: {} }), {
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = createFabric({
			baseUrl: "https://example.com",
			apiKey: "example-key",
			org: "example-org",
			fetch,
		});
		await client.reports.getInstanceBranding("example/report");
		const change = {
			expectedInstanceVersion: 2,
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
			branding: { source: "CLIENT" as const, expectedBrandVersion: 3 },
		};
		await client.reports.applyInstanceBranding("example/report", change);
		expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe(
			"/api/v1/reports/instances/example%2Freport/branding",
		);
		expect(fetch.mock.calls[1][1]?.method).toBe("PUT");
		expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(
			change,
		);
	});
	it("does not retry an acknowledged-uncertain report mutation", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new TypeError("Lost acknowledgement"));
		const client = createFabric({
			baseUrl: "https://example.com",
			apiKey: "example-key",
			fetch,
		});
		await expect(
			client.reports.applyInstanceBranding("example-report", {
				expectedInstanceVersion: 1,
				expectedUpdatedAt: "2026-11-01T00:00:00Z",
				branding: null,
			}),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
	});
});
