import { describe, expect, it, vi } from "vitest";
import { createFabric, FabricError } from "../src/index.js";

describe("selected context SDK", () => {
	const input = {
		selections: [
			{
				sourceKind: "project_context" as const,
				sourceId: "example-source",
				expectedRevision: "a".repeat(64),
			},
		],
	};
	it("sends exact references without discovery, tenant fallback or implicit persistence", async () => {
		const packet = {
			version: 1,
			selectionHash: "b".repeat(64),
			contentRole: "reference_data",
			sources: [],
			omissions: [],
		};
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: packet }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const client = createFabric({
			apiKey: "synthetic-key",
			baseUrl: "https://example.com",
			fetch,
		});
		expect(
			await client.contexts.assemble("example/project", input, {
				org: "example team",
			}),
		).toEqual(packet);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, request] = fetch.mock.calls[0];
		expect(new URL(String(url)).pathname).toBe(
			"/api/v1/projects/example%2Fproject/contexts/assemble",
		);
		expect(new URL(String(url)).searchParams.get("org")).toBe(
			"example team",
		);
		expect(request?.method).toBe("POST");
		expect(JSON.parse(String(request?.body))).toEqual(input);
	});
	it.each([403, 404, 409, 413, 503])(
		"preserves %s refusal without retrying against changed current context",
		async (status) => {
			const fetch = vi.fn<typeof globalThis.fetch>(
				async () =>
					new Response(
						JSON.stringify({
							error: {
								code: "UNAVAILABLE",
								message: "Inspect current selection.",
							},
						}),
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
				retry: { maxRetries: 2 },
			});
			await expect(
				client.contexts.assemble("example-project", input),
			).rejects.toBeInstanceOf(FabricError);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("honors caller cancellation before any request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const signal = AbortSignal.abort(new Error("stopped"));
		await expect(
			createFabric({
				apiKey: "synthetic-key",
				baseUrl: "https://example.com",
				fetch,
			}).contexts.assemble("example-project", input, { signal }),
		).rejects.toThrow("stopped");
		expect(fetch).not.toHaveBeenCalled();
	});
});
