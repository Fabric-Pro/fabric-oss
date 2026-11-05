import { describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

describe("actual recorded agent results SDK", () => {
	it("uses explicit project/run identities and forwards expectations without an answer", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(JSON.stringify({ data: { status: "passed" } }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const sdk = createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
		});
		await sdk.contextQuality.inspectAgentResult("example/run", {
			projectId: "example/project",
			org: "example team",
		});
		expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe(
			"/api/v1/projects/example%2Fproject/context-quality/agent-results/example%2Frun",
		);
		const input = {
			expectedRevision: "a".repeat(64),
			requiredPhrases: ["owner"],
			forbiddenPhrases: [],
		};
		await sdk.contextQuality.checkAgentResult("example/run", input, {
			projectId: "example/project",
		});
		expect(fetch.mock.calls[1][1]?.method).toBe("POST");
		expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(input);
	});
	it.each([403, 409, 412, 503])(
		"does not retry a refused %s check against changed output",
		async (status) => {
			const fetch = vi.fn<typeof globalThis.fetch>(
				async () =>
					new Response(
						JSON.stringify({
							error: {
								code: "CONFLICT",
								message: "Inspect again.",
							},
						}),
						{
							status,
							headers: { "content-type": "application/json" },
						},
					),
			);
			const sdk = createFabric({
				apiKey: "example-key",
				baseUrl: "https://example.com",
				fetch,
				retry: { maxRetries: 3 },
			});
			await expect(
				sdk.contextQuality.checkAgentResult(
					"example-run",
					{
						expectedRevision: "a".repeat(64),
						requiredPhrases: ["owner"],
						forbiddenPhrases: [],
					},
					{ projectId: "example-project" },
				),
			).rejects.toThrow();
			expect(fetch).toHaveBeenCalledOnce();
		},
	);
});
