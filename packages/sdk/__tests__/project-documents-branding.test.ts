import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

describe("branded document SDK", () => {
	it("does not create a second document when the acknowledgement is lost", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new TypeError("Lost acknowledgement"));
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		await expect(
			client.projects.createDocument("example-project", {
				type: "PROPOSAL",
				title: "Example proposal",
				content: "# Draft",
				proposalBranding: "CLIENT",
				recipientBrandVersion: 2,
			}),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("sends the reviewed palette version without converting it into a generation request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					JSON.stringify({ data: { id: "example-document" } }),
					{ headers: { "Content-Type": "application/json" } },
				),
		);
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		await client.projects.createDocument("example-project", {
			type: "PROPOSAL",
			title: "Example proposal",
			content: "# Draft",
			proposalBranding: "CLIENT",
			recipientBrandVersion: 2,
		});
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			type: "PROPOSAL",
			title: "Example proposal",
			content: "# Draft",
			proposalBranding: "CLIENT",
			recipientBrandVersion: 2,
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});
