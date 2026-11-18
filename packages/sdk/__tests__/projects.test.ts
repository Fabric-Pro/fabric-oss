import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

function fixture() {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({
					data: { id: "p1" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	return {
		fetch,
		client: createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			org: "example-org",
			fetch,
		}),
	};
}

describe("projects SDK — initiatives", () => {
	it("createFeature sends kind in the request body", async () => {
		const { client, fetch } = fixture();
		await client.projects.createFeature("p1", {
			title: "Q3",
			kind: "INITIATIVE",
		});
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0];
		expect(String(url)).toBe(
			"https://example.com/api/v1/projects/p1/features?org=example-org",
		);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			title: "Q3",
			kind: "INITIATIVE",
		});
	});

	it("listFeatures sends kind in the query string", async () => {
		const { client, fetch } = fixture();
		await client.projects.listFeatures("p1", { kind: "INITIATIVE" });
		expect(fetch).toHaveBeenCalledOnce();
		const [url] = fetch.mock.calls[0];
		expect(String(url)).toBe(
			"https://example.com/api/v1/projects/p1/features?kind=INITIATIVE&org=example-org",
		);
	});
});
