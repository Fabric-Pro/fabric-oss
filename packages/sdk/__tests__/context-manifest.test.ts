import { describe, expect, it, vi } from "vitest";
import { createFabric, FabricError } from "../src/index.js";

describe("Context manifest SDK", () => {
	it("encodes project and filters and returns one inspectable metadata page without automatic content fetching", async () => {
		const page = {
			version: 1,
			sources: [
				{
					sourceId: "example-source",
					revision: null,
					readiness: "inspection_required",
				},
			],
			omissions: { sourceBodies: true },
			pagination: { nextOffset: 20, snapshotConsistent: false },
		};
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: page }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const client = createFabric({
			apiKey: "synthetic-key",
			baseUrl: "https://example.com",
			fetch,
		});
		await expect(
			client.contexts.manifest("project/one", {
				org: "example team",
				limit: 20,
				offset: 0,
				includeCodeContexts: false,
			}),
		).resolves.toEqual(page);
		const url = new URL(String(fetch.mock.calls[0][0]));
		expect(url.pathname).toBe(
			"/api/v1/projects/project%2Fone/contexts/manifest",
		);
		expect(url.searchParams.get("org")).toBe("example team");
		expect(url.searchParams.get("includeCodeContexts")).toBe("false");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each([400, 403, 404])(
		"propagates refusal %s without changing tenant or retrying a read elsewhere",
		async (status) => {
			const fetch = vi.fn<typeof globalThis.fetch>(
				async () =>
					new Response(
						JSON.stringify({ error: { message: "Unavailable" } }),
						{
							status,
							headers: { "content-type": "application/json" },
						},
					),
			);
			const client = createFabric({
				apiKey: "synthetic-key",
				baseUrl: "https://example.com",
				fetch,
			});
			await expect(
				client.contexts.manifest("example-project"),
			).rejects.toBeInstanceOf(FabricError);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});
