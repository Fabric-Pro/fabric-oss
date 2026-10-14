/**
 * `POST /api/ai/keys/exchange` and a member's own ChatGPT plan (Fizzy #2939).
 *
 * Only a token minted for interactive work (`pe`) may resolve the plan. When
 * it does, the agent receives the server-refreshed plan access token — never
 * the organization's key, base URL or deployment — and its cache of it ends
 * before the access token does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyAIToken: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfig: vi.fn(),
	getPlanToken: vi.fn(),
	exhausted: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: mocks.verifyAIToken,
	getRemainingValidity: (claims: { exp: number }) =>
		claims.exp - Math.floor(Date.now() / 1000),
}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: { OPENROUTER: "https://openrouter.ai/api/v1" },
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	getRAGProviderConfig: mocks.getRAGProviderConfig,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: mocks.getPlanToken,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/exhaustion-breaker", () => ({
	chatGptPlanExhaustedError: mocks.exhausted,
	// The cross-process read the agent config uses since Fizzy #2770.
	chatGptPlanSourceExhaustedError: async () => mocks.exhausted(),
}));

vi.mock("@repo/database", () => ({
	getSearchProviderConfig: vi.fn(async () => null),
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: (value: string) => value }));

const { POST } = await import("../route");

const ORG_KEY = "sk-org-key-must-never-leave";

function exchange() {
	return POST(
		new Request("http://localhost/api/ai/keys/exchange", {
			method: "POST",
			headers: { "X-AI-Token": "jwt" },
		}),
	);
}

function claims(extra: Record<string, unknown> = {}) {
	return {
		valid: true,
		claims: {
			sub: "user-1",
			org: "org-1",
			src: "copilotkit",
			exp: Math.floor(Date.now() / 1000) + 900,
			...extra,
		},
	};
}

function resolved(provider: string, modelString: string) {
	return {
		metadata: {
			provider,
			modelString,
			billingMode: "external_provider",
			billingCustomerId: null,
		},
		trackUsage: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.exhausted.mockReturnValue(null);
	mocks.getRAGProviderConfig.mockResolvedValue({
		apiKey: ORG_KEY,
		baseUrl: "https://gateway.example.com/v1",
		deploymentName: "example-deployment",
	});
	mocks.getPlanToken.mockResolvedValue({
		accessToken: "plan-access-token",
		expiresAt: new Date(Date.now() + 5 * 60_000),
	});
});

describe("POST /api/ai/keys/exchange — ChatGPT plan", () => {
	it("hands over the plan access token, never the organization key", async () => {
		mocks.verifyAIToken.mockResolvedValue(claims({ pe: true }));
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENAI_CHATGPT_PLAN", "gpt-6-astra"),
		);

		const response = await exchange();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ userId: "user-1", organizationId: "org-1", planEligible: true },
		);
		expect(body).toMatchObject({
			apiKey: "plan-access-token",
			provider: "OPENAI_CHATGPT_PLAN",
			model: "gpt-6-astra",
		});
		expect(body).not.toHaveProperty("baseUrl");
		expect(body).not.toHaveProperty("deploymentName");
		expect(JSON.stringify(body)).not.toContain(ORG_KEY);
		expect(mocks.getRAGProviderConfig).not.toHaveBeenCalled();
		// Five minutes of token life less the margin, not the JWT's fifteen.
		expect(body.expiresIn).toBeLessThanOrEqual(240);
		expect(body.expiresIn).toBeGreaterThan(200);
	});

	it("does not ask for the plan with a token minted for background work", async () => {
		mocks.verifyAIToken.mockResolvedValue(claims());
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENROUTER", "openai/gpt-4o-mini"),
		);

		const response = await exchange();
		const body = await response.json();

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ userId: "user-1", organizationId: "org-1", planEligible: false },
		);
		expect(body.apiKey).toBe(ORG_KEY);
		expect(mocks.getPlanToken).not.toHaveBeenCalled();
	});

	it("refuses rather than falling back to the organization key when the plan token is unavailable", async () => {
		mocks.verifyAIToken.mockResolvedValue(claims({ pe: true }));
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENAI_CHATGPT_PLAN", "gpt-6-astra"),
		);
		mocks.getPlanToken.mockRejectedValue(new Error("needs_reconnect"));

		const response = await exchange();
		const text = await response.text();

		expect(response.status).toBe(409);
		expect(text).not.toContain(ORG_KEY);
	});

	it("refuses with the reconnect error, never the organization key, when the plan needs reconnecting", async () => {
		const { ChatGptPlanAuthError } = await import(
			"@repo/ai/lib/chatgpt-plan/oauth"
		);
		mocks.verifyAIToken.mockResolvedValue(claims({ pe: true }));
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new ChatGptPlanAuthError("reconnect", "needs_reconnect", true),
		);

		const response = await exchange();
		const text = await response.text();

		expect(response.status).toBe(409);
		expect(JSON.parse(text)).toMatchObject({
			code: "CHATGPT_PLAN_UNAVAILABLE",
			error: expect.stringContaining("needs to be reconnected"),
		});
		expect(text).not.toContain(ORG_KEY);
		expect(mocks.getRAGProviderConfig).not.toHaveBeenCalled();
	});

	it("fails fast while the plan window is known to be spent", async () => {
		mocks.verifyAIToken.mockResolvedValue(claims({ pe: true }));
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENAI_CHATGPT_PLAN", "gpt-6-astra"),
		);
		mocks.exhausted.mockReturnValue(new Error("spent"));

		const response = await exchange();

		expect(response.status).toBe(429);
		expect(mocks.getPlanToken).not.toHaveBeenCalled();
	});
});

// Fizzy #2939: a token an admin minted while acting as the member.
describe("POST /api/ai/keys/exchange — a token minted under impersonation", () => {
	it("resolves the model as an impersonated request, which the plan gate refuses", async () => {
		const { isAiImpersonatedRequest } = await import(
			"@repo/ai/lib/chatgpt-plan/interactive-context"
		);
		let impersonated: boolean | undefined;
		mocks.verifyAIToken.mockResolvedValue(claims({ imp: true }));
		mocks.getAIModelWithMetadata.mockImplementation(async () => {
			impersonated = isAiImpersonatedRequest();
			return resolved("OPENROUTER", "openai/gpt-4o-mini");
		});

		const response = await exchange();
		const body = await response.json();

		expect(impersonated).toBe(true);
		expect(body.apiKey).toBe(ORG_KEY);
		expect(mocks.getPlanToken).not.toHaveBeenCalled();
	});

	it("resolves a token minted by the member themselves as an ordinary request", async () => {
		const { isAiImpersonatedRequest } = await import(
			"@repo/ai/lib/chatgpt-plan/interactive-context"
		);
		let impersonated: boolean | undefined;
		mocks.verifyAIToken.mockResolvedValue(claims({ pe: true }));
		mocks.getAIModelWithMetadata.mockImplementation(async () => {
			impersonated = isAiImpersonatedRequest();
			return resolved("OPENROUTER", "openai/gpt-4o-mini");
		});

		await exchange();

		expect(impersonated).toBe(false);
	});
});

// Fizzy #2770: a bulk run's agents (batch generation, project setup) hold a
// token naming the run's job, so the exchange resolves on the organization's
// shared plans for that job, never the member's own.
describe("POST /api/ai/keys/exchange — a token minted for a job", () => {
	it("resolves as the token's job, never as the member's own work", async () => {
		mocks.verifyAIToken.mockResolvedValue(
			claims({ jt: "batch-document-generation" }),
		);
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENROUTER", "openai/gpt-4o-mini"),
		);

		await exchange();

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{
				userId: "user-1",
				organizationId: "org-1",
				planEligible: false,
				jobType: "batch-document-generation",
			},
		);
	});

	it("drops a job this build does not know", async () => {
		mocks.verifyAIToken.mockResolvedValue(claims({ jt: "not-a-job" }));
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENROUTER", "openai/gpt-4o-mini"),
		);

		await exchange();

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ userId: "user-1", organizationId: "org-1", planEligible: false },
		);
	});

	it("passes the job's own reason through when nothing can serve it", async () => {
		const reason =
			"Scans, project setup, Atlas and batch generation run on your organization's shared ChatGPT plans.";
		const refusal = new Error(reason);
		refusal.name = "AIProviderNotConfiguredError";
		mocks.verifyAIToken.mockResolvedValue(claims({ jt: "project-setup" }));
		mocks.getAIModelWithMetadata.mockRejectedValue(refusal);

		const response = await exchange();

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: reason });
	});

	it("keeps the generic refusal for a token minted for no job", async () => {
		const refusal = new Error("No AI provider configured.");
		refusal.name = "AIProviderNotConfiguredError";
		mocks.verifyAIToken.mockResolvedValue(claims());
		mocks.getAIModelWithMetadata.mockRejectedValue(refusal);

		const response = await exchange();

		expect((await response.json()).error).toMatch(
			/Please configure an AI provider in Settings/,
		);
	});
});
