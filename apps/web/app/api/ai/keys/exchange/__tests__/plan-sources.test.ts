/**
 * The agent exchange and shared ChatGPT plans (Fizzy #2770): the agent learns
 * which plan stands behind its token, may name plans to skip after one
 * refuses a call as spent, and anything but a well-formed plan key is
 * dropped before the resolver sees it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	getPlanToken: vi.fn(),
	getSourceToken: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: async () => ({
		valid: true,
		claims: {
			sub: "user-1",
			org: "org-1",
			src: "copilotkit",
			pe: true,
			exp: Math.floor(Date.now() / 1000) + 900,
		},
	}),
	getRemainingValidity: (claims: { exp: number }) =>
		claims.exp - Math.floor(Date.now() / 1000),
}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	getRAGProviderConfig: vi.fn(),
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: mocks.getPlanToken,
	getChatGptPlanSourceAccessToken: mocks.getSourceToken,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/exhaustion-breaker", () => ({
	chatGptPlanSourceExhaustedError: async () => null,
}));

vi.mock("@repo/database", () => ({
	getSearchProviderConfig: vi.fn(async () => null),
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: (value: string) => value }));

const { POST } = await import("../route");

const exchange = (body?: unknown) =>
	POST(
		new Request("http://localhost/api/ai/keys/exchange", {
			method: "POST",
			headers: { "X-AI-Token": "jwt" },
			...(body !== undefined && { body: JSON.stringify(body) }),
		}),
	);

const SHARED = { kind: "org", organizationId: "org-1", accountId: "acc-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		metadata: {
			provider: "OPENAI_CHATGPT_PLAN",
			modelString: "gpt-6-astra",
			billingMode: "external_provider",
			billingCustomerId: null,
			planSource: SHARED,
		},
		trackUsage: vi.fn(),
	});
	mocks.getSourceToken.mockResolvedValue({
		accessToken: "shared-plan-token",
		expiresAt: new Date(Date.now() + 5 * 60_000),
	});
});

describe("POST /api/ai/keys/exchange — shared plans", () => {
	it("hands over the shared account's token and names the plan, never the member's own", async () => {
		const response = await exchange();
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			apiKey: "shared-plan-token",
			provider: "OPENAI_CHATGPT_PLAN",
			planSource: "org:acc-1",
		});
		expect(mocks.getSourceToken).toHaveBeenCalledWith(SHARED);
		expect(mocks.getPlanToken).not.toHaveBeenCalled();
	});

	it("passes well-formed plan keys to skip, and nothing else", async () => {
		await exchange({
			excludeSources: [
				"org:acc-1",
				"user:user-1",
				"org:acc-1; DROP TABLE",
				"api:anything",
				42,
			],
		});
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			expect.objectContaining({
				excludePlanSources: ["org:acc-1", "user:user-1"],
			}),
		);
	});

	it("treats a missing or malformed body as nothing to skip", async () => {
		await exchange();
		await POST(
			new Request("http://localhost/api/ai/keys/exchange", {
				method: "POST",
				headers: { "X-AI-Token": "jwt" },
				body: "not json",
			}),
		);
		for (const [, context] of mocks.getAIModelWithMetadata.mock.calls) {
			expect(context).not.toHaveProperty("excludePlanSources");
		}
	});

	it("answers 429 CHATGPT_PLAN_EXHAUSTED, never a missing provider, when every plan is spent", async () => {
		const { SubscriptionPlanExhaustedError } = await import(
			"@repo/agent-types/chatgpt-plan-fetch"
		);
		const resetAt = new Date("2026-10-07T15:00:00Z");
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new SubscriptionPlanExhaustedError("Every plan is spent.", resetAt),
		);
		const response = await exchange();
		expect(response.status).toBe(429);
		await expect(response.json()).resolves.toEqual({
			error: "Every plan is spent.",
			code: "CHATGPT_PLAN_EXHAUSTED",
			resetAt: resetAt.toISOString(),
		});
	});
});
