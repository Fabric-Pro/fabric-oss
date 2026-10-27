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
	getModelByCanonicalName: vi.fn(),
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

vi.mock("@repo/ai", async () => ({
	isReasoningModelName: (await import("@repo/agent-types/databricks-compat"))
		.isReasoningModelName,
	DEFAULT_BASE_URLS: { OPENROUTER: "https://openrouter.ai/api/v1" },
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	getRAGProviderConfigForModel: (context: unknown) =>
		mocks.getRAGProviderConfig(context),
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
	getModelByCanonicalName: mocks.getModelByCanonicalName,
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
			canonicalName: modelString,
			billingMode: "external_provider",
			billingCustomerId: null,
		},
		trackUsage: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getModelByCanonicalName.mockResolvedValue(null);
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

describe("signed delegated model override", () => {
	it.each(["claude-haiku-4-5", undefined])(
		"resolves the signed selection (%s)",
		async (mo) => {
			mocks.verifyAIToken.mockResolvedValue(claims({ mo }));
			const result = resolved("OPENROUTER", "anthropic/claude-haiku-4-5");
			Object.assign(result.metadata, {
				selectionSource: mo ? "override" : "task_preference",
			});
			mocks.getAIModelWithMetadata.mockResolvedValue(result);
			const response = await exchange();
			expect(response.status).toBe(200);
			expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
				{ taskType: "COMPLEX", ...(mo ? { modelOverride: mo } : {}) },
				expect.anything(),
			);
			const body = await response.json();
			expect(body.modelPinned).toBe(mo ? true : undefined);
		},
	);
	it("does not pin a dropped plan override", async () => {
		mocks.verifyAIToken.mockResolvedValue(
			claims({ mo: "chatgpt-plan:gpt-6" }),
		);
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENROUTER", "anthropic/claude-sonnet-5"),
		);
		expect((await (await exchange()).json()).modelPinned).toBeUndefined();
	});
	it("pins a plan selection actually served", async () => {
		mocks.verifyAIToken.mockResolvedValue(
			claims({ mo: "chatgpt-plan:gpt-6", pe: true }),
		);
		const result = resolved("OPENAI_CHATGPT_PLAN", "gpt-6");
		Object.assign(result.metadata, { planPick: "gpt-6" });
		mocks.getAIModelWithMetadata.mockResolvedValue(result);
		expect((await (await exchange()).json()).modelPinned).toBe(true);
	});
});

describe("pinned model metadata", () => {
	it.each(["GROQ", "OPENAI_CHATGPT_PLAN"])(
		"returns canonical catalog caps for a pinned %s model",
		async (provider) => {
			const canonicalName = provider === "GROQ" ? "deepseek-r1" : "gpt-6";
			mocks.verifyAIToken.mockResolvedValue(
				claims({
					mo:
						provider === "GROQ"
							? canonicalName
							: `chatgpt-plan:${canonicalName}`,
				}),
			);
			const result = resolved(
				provider,
				provider === "GROQ" ? "opaque-example-alias" : canonicalName,
			);
			Object.assign(result.metadata, {
				canonicalName,
				selectionSource:
					provider === "GROQ" ? "override" : "chatgpt_plan",
				...(provider === "OPENAI_CHATGPT_PLAN" && {
					planPick: canonicalName,
				}),
			});
			mocks.getAIModelWithMetadata.mockResolvedValue(result);
			mocks.getModelByCanonicalName.mockResolvedValue({
				maxOutputTokens: 8192,
				contextWindow: 32768,
			});
			const body = await (await exchange()).json();
			expect(body).toMatchObject({
				modelPinned: true,
				isReasoningModel: provider === "GROQ",
				maxOutputTokens: 8192,
				contextWindow: 32768,
			});
			expect(mocks.getModelByCanonicalName).toHaveBeenCalledWith(
				canonicalName,
			);
		},
	);
	it("uses resolved metadata caps when present", async () => {
		mocks.verifyAIToken.mockResolvedValue(claims({ mo: "example-model" }));
		const result = resolved("GROQ", "example-model");
		Object.assign(result.metadata, {
			canonicalName: "example-model",
			selectionSource: "override",
			maxOutputTokens: 8192,
			contextWindow: 32768,
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(result);
		expect(await (await exchange()).json()).toMatchObject({
			isReasoningModel: false,
			maxOutputTokens: 8192,
			contextWindow: 32768,
		});
		expect(mocks.getModelByCanonicalName).not.toHaveBeenCalled();
	});
	it("omits metadata when not pinned", async () => {
		mocks.verifyAIToken.mockResolvedValue(claims());
		const result = resolved("GROQ", "example-model");
		Object.assign(result.metadata, {
			canonicalName: "example-model",
			maxOutputTokens: 8192,
			contextWindow: 32768,
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(result);
		const body = await (await exchange()).json();
		for (const key of [
			"isReasoningModel",
			"maxOutputTokens",
			"contextWindow",
		]) {
			expect(body).not.toHaveProperty(key);
		}
		expect(mocks.getModelByCanonicalName).not.toHaveBeenCalled();
	});
	it("returns unknown caps as null for an uncatalogued raw model", async () => {
		mocks.verifyAIToken.mockResolvedValue(
			claims({ mo: "raw-example-model" }),
		);
		const result = resolved("GROQ", "raw-example-model");
		Object.assign(result.metadata, {
			canonicalName: "raw-example-model",
			selectionSource: "override",
		});
		mocks.getAIModelWithMetadata.mockResolvedValue(result);
		expect(await (await exchange()).json()).toMatchObject({
			modelPinned: true,
			isReasoningModel: false,
			maxOutputTokens: null,
			contextWindow: null,
		});
	});
	it("pins a plan pick the plan serves under a different model ID", async () => {
		// A model added from the plan's own list keeps a suffixed catalog name
		// and is served under the plan's model ID (Fizzy #3122).
		mocks.verifyAIToken.mockResolvedValue(
			claims({ mo: "chatgpt-plan:gpt-7-sol-chatgpt-plan", pe: true }),
		);
		const result = resolved("OPENAI_CHATGPT_PLAN", "gpt-7-sol");
		Object.assign(result.metadata, { planPick: "gpt-7-sol-chatgpt-plan" });
		mocks.getAIModelWithMetadata.mockResolvedValue(result);
		mocks.getModelByCanonicalName.mockResolvedValue({
			maxOutputTokens: 8192,
			contextWindow: 32768,
		});
		expect(await (await exchange()).json()).toMatchObject({
			model: "gpt-7-sol",
			modelPinned: true,
			isReasoningModel: false,
			maxOutputTokens: 8192,
			contextWindow: 32768,
		});
		expect(mocks.getModelByCanonicalName).toHaveBeenCalledWith(
			"gpt-7-sol-chatgpt-plan",
		);
	});
	it("does not pin a plan fallback that shares the picked name", async () => {
		// The pick mapped to a model the plan did not serve; the plan's
		// fallback ID happens to equal the picked catalog name.
		mocks.verifyAIToken.mockResolvedValue(
			claims({ mo: "chatgpt-plan:gpt-6", pe: true }),
		);
		mocks.getAIModelWithMetadata.mockResolvedValue(
			resolved("OPENAI_CHATGPT_PLAN", "gpt-6"),
		);
		const body = await (await exchange()).json();
		expect(body.modelPinned).toBeUndefined();
		expect(mocks.getModelByCanonicalName).not.toHaveBeenCalled();
	});
	it("does not pin a plan serving a different model", async () => {
		mocks.verifyAIToken.mockResolvedValue(
			claims({ mo: "chatgpt-plan:gpt-6", pe: true }),
		);
		const result = resolved("OPENAI_CHATGPT_PLAN", "gpt-6-astra");
		Object.assign(result.metadata, { canonicalName: "gpt-6-astra" });
		mocks.getAIModelWithMetadata.mockResolvedValue(result);
		const body = await (await exchange()).json();
		expect(body.model).toBe("gpt-6-astra");
		for (const key of [
			"modelPinned",
			"isReasoningModel",
			"maxOutputTokens",
			"contextWindow",
		]) {
			expect(body).not.toHaveProperty(key);
		}
	});
});

it("returns the resolved canonical model for an unpinned Databricks alias", async () => {
	mocks.verifyAIToken.mockResolvedValue(claims());
	const result = resolved("DATABRICKS", "custom-chat");
	Object.assign(result.metadata, { canonicalName: "claude-sonnet-5" });
	mocks.getAIModelWithMetadata.mockResolvedValue(result);
	expect(await (await exchange()).json()).toMatchObject({
		model: "custom-chat",
		canonicalModelName: "claude-sonnet-5",
	});
});
