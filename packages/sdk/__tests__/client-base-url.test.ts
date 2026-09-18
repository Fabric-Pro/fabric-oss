import { afterEach, describe, expect, it } from "vitest";
import { createFabric } from "../src/index.js";

function clientForBaseUrlTest(captured: string[]) {
	return createFabric({
		apiKey: "fab_test_key",
		fetch: async (input) => {
			captured.push(String(input));
			return new Response(
				JSON.stringify({
					data: {
						user: { name: null, email: "dev@example.com" },
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		},
		retry: { maxRetries: 0 },
	});
}

afterEach(() => {
	delete process.env.FABRIC_BASE_URL;
});

describe("FabricClient base URL resolution", () => {
	it("sends requests to fabric.pro when no base URL is configured", async () => {
		delete process.env.FABRIC_BASE_URL;
		const captured: string[] = [];

		await clientForBaseUrlTest(captured).auth.whoami();

		expect(captured).toEqual(["https://fabric.pro/api/v1/auth/whoami"]);
	});

	it("uses FABRIC_BASE_URL unless an explicit base URL is supplied", async () => {
		process.env.FABRIC_BASE_URL = "https://environment.example";
		const envCaptured: string[] = [];
		const explicitCaptured: string[] = [];

		await clientForBaseUrlTest(envCaptured).auth.whoami();
		await createFabric({
			apiKey: "fab_test_key",
			baseUrl: "https://explicit.example",
			fetch: async (input) => {
				explicitCaptured.push(String(input));
				return new Response(JSON.stringify({ data: { user: null } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			retry: { maxRetries: 0 },
		}).auth.whoami();

		expect(envCaptured).toEqual([
			"https://environment.example/api/v1/auth/whoami",
		]);
		expect(explicitCaptured).toEqual([
			"https://explicit.example/api/v1/auth/whoami",
		]);
	});
});
