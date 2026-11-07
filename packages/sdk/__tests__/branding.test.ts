import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

describe("branding SDK", () => {
	it("honors bound project and organization when reading branding", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: {} }), {
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			org: "example-org",
			fetch,
		}).withProject("example/project");
		await client.branding.get();
		expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe(
			"/api/v1/projects/example%2Fproject/branding",
		);
		expect(
			new URL(String(fetch.mock.calls[0][0])).searchParams.get("org"),
		).toBe("example-org");
	});
	it("does not retry a brand mutation with lost acknowledgement", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new TypeError("Lost acknowledgement"));
		const client = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		await expect(
			client.branding.updateClient("example/project", {
				expectedVersion: 2,
				name: "Example",
				website: null,
				colors: [],
			}),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0][1]?.method).toBe("PUT");
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
			expectedVersion: 2,
		});
	});
});

it("round-trips catalog typography and encoded proposal Style with reviewed timestamp", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				JSON.stringify({
					data: {
						brandSource: "CLIENT",
						coverStyle: "LIGHT",
						updatedAt: "2026-11-01T00:00:00.000Z",
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
	);
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		fetch,
	});
	await client.branding.updateClient("example/project", {
		expectedVersion: 1,
		name: "Example",
		website: null,
		colors: [],
		displayFontFamily: "Poppins",
		bodyFontFamily: "Inter",
		coverStyle: "LIGHT",
	});
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
		displayFontFamily: "Poppins",
		coverStyle: "LIGHT",
	});
	await client.branding.getProposalStyle(
		"example/project",
		"example/document",
	);
	expect(new URL(String(fetch.mock.calls[1][0])).pathname).toBe(
		"/api/v1/projects/example%2Fproject/documents/example%2Fdocument/proposal-style",
	);
	await client.branding.updateProposalStyle(
		"example/project",
		"example/document",
		{ expectedUpdatedAt: null, brandSource: "CLIENT", coverStyle: null },
	);
	expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({
		expectedUpdatedAt: null,
		brandSource: "CLIENT",
		coverStyle: null,
	});
});
it("does not retry a lost proposal Style acknowledgement", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockRejectedValue(new TypeError("Lost acknowledgement"));
	const client = createFabric({
		apiKey: "example-key",
		baseUrl: "https://example.com",
		fetch,
	});
	await expect(
		client.branding.updateProposalStyle(
			"example-project",
			"example-document",
			{ expectedUpdatedAt: null, brandSource: "CLIENT" },
		),
	).rejects.toThrow();
	expect(fetch).toHaveBeenCalledOnce();
});
