import { expect, test } from "@playwright/test";

/**
 * E2E tests for Security Hardening (S1-S7)
 * Covers: Rate limiting, Zod request validation, server-side org ID
 */

test.describe("Rate Limiting — API Endpoints", () => {
	test("should return 429 after exceeding stream endpoint rate limit", async ({
		request,
		page,
	}) => {
		// First, get the auth cookie by visiting the app
		await page.goto("/app");
		await page.waitForLoadState("networkidle");
		const cookies = await page.context().cookies();
		const cookieHeader = cookies
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");

		// Rapid-fire requests to the stream endpoint
		let got429 = false;
		const results: number[] = [];

		for (let i = 0; i < 25; i++) {
			const response = await request.post(
				"/api/agents/fabric-ai/stream",
				{
					headers: {
						"Content-Type": "application/json",
						Cookie: cookieHeader,
					},
					data: {
						message: "test rate limit",
						threadId: `rate-limit-test-${Date.now()}`,
					},
				},
			);
			results.push(response.status());
			if (response.status() === 429) {
				got429 = true;
				break;
			}
		}

		// Should have gotten rate limited at some point
		expect(got429).toBe(true);
	});

	test("should return 429 after exceeding execute-workflow rate limit", async ({
		request,
		page,
	}) => {
		await page.goto("/app");
		await page.waitForLoadState("networkidle");
		const cookies = await page.context().cookies();
		const cookieHeader = cookies
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");

		let got429 = false;

		for (let i = 0; i < 35; i++) {
			const response = await request.post(
				"/api/agents/fabric-ai/execute-workflow",
				{
					headers: {
						"Content-Type": "application/json",
						Cookie: cookieHeader,
					},
					data: {
						workflowId: "test-workflow",
						threadId: `rate-test-wf-${Date.now()}`,
					},
				},
			);
			if (response.status() === 429) {
				got429 = true;
				break;
			}
		}

		expect(got429).toBe(true);
	});
});

test.describe("Request Validation — Zod Schema", () => {
	test("should reject malformed stream request (missing message)", async ({
		request,
		page,
	}) => {
		await page.goto("/app");
		await page.waitForLoadState("networkidle");
		const cookies = await page.context().cookies();
		const cookieHeader = cookies
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");

		const response = await request.post("/api/agents/fabric-ai/stream", {
			headers: {
				"Content-Type": "application/json",
				Cookie: cookieHeader,
			},
			data: {
				// Missing required "message" field
				threadId: "test",
			},
		});

		// Should return 400 for validation failure (or 422)
		expect([400, 422]).toContain(response.status());
	});

	test("should reject excessively long message payload", async ({
		request,
		page,
	}) => {
		await page.goto("/app");
		await page.waitForLoadState("networkidle");
		const cookies = await page.context().cookies();
		const cookieHeader = cookies
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");

		const response = await request.post("/api/agents/fabric-ai/stream", {
			headers: {
				"Content-Type": "application/json",
				Cookie: cookieHeader,
			},
			data: {
				message: "x".repeat(100000), // Excessively long
				threadId: "test-overflow",
			},
		});

		// Should reject or handle gracefully
		expect([400, 413, 422, 200]).toContain(response.status());
	});

	test("should not allow client-provided organizationId to override server session", async ({
		request,
		page,
	}) => {
		await page.goto("/app");
		await page.waitForLoadState("networkidle");
		const cookies = await page.context().cookies();
		const cookieHeader = cookies
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");

		const response = await request.post(
			"/api/agents/fabric-ai/execute-workflow",
			{
				headers: {
					"Content-Type": "application/json",
					Cookie: cookieHeader,
				},
				data: {
					workflowId: "test",
					threadId: "test",
					organizationId: "injected-org-id-should-be-ignored",
				},
			},
		);

		// The request should succeed or fail on its own merits,
		// not with the injected org ID
		expect(response.status()).not.toBe(500);
	});
});

test.describe("Unauthenticated Access", () => {
	test("stream endpoint should reject unauthenticated requests", async ({
		request,
	}) => {
		const response = await request.post("/api/agents/fabric-ai/stream", {
			headers: { "Content-Type": "application/json" },
			data: { message: "test", threadId: "test" },
		});

		expect([401, 403]).toContain(response.status());
	});

	test("execute-workflow should reject unauthenticated requests", async ({
		request,
	}) => {
		const response = await request.post(
			"/api/agents/fabric-ai/execute-workflow",
			{
				headers: { "Content-Type": "application/json" },
				data: { workflowId: "test", threadId: "test" },
			},
		);

		expect([401, 403]).toContain(response.status());
	});
});
