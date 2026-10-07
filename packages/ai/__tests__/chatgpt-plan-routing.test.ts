/**
 * Routing to a member's own ChatGPT plan (Fizzy #2939).
 *
 * `getAIModelWithMetadata` sends a call to the plan only when it runs in an
 * organization with CHATGPT_PLAN on, the member has an ACTIVE plan they turned
 * on there, and either the caller marked the call plan-eligible or the member
 * chose to include background jobs. Every other combination — and any failure while checking —
 * resolves the organization's provider exactly as before. Plan calls are
 * logged with the plan's real model id and zero API cost.
 *
 * The real resolver and usage middleware run; the provider factories and the
 * database boundary are the seams.
 */

import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAiProviderApiKey: vi.fn(),
	getModelForTask: vi.fn(),
	getModel: vi.fn(),
	logAiUsageAsync: vi.fn(),
	isFeatureEnabled: vi.fn(),
	activeUse: vi.fn(),
	createPlanModel: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: mocks.getAiProviderApiKey,
	getAiProviderApiKeyByProvider: vi.fn(),
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: mocks.getModelForTask,
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(() => Promise.resolve()),
	touchChatGptPlanCredential: vi.fn(() => Promise.resolve()),
	logAiUsageAsync: mocks.logAiUsageAsync,
	isFeatureEnabled: mocks.isFeatureEnabled,
	getActiveChatGptPlanOrgUse: mocks.activeUse,
}));

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: vi.fn(),
	getTenantAiGatewayBillingState: vi.fn(() => ({
		mode: "external_provider",
		headers: null,
	})),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((value: string) => value.replace("encrypted:", "")),
	decryptApiKeyMaybe: vi.fn((value: string) =>
		value.replace("encrypted:", ""),
	),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../model-factory", () => ({
	getEmbeddingModel: vi.fn(),
	getEvaluationModel: vi.fn(),
	getModel: mocks.getModel,
}));

vi.mock("../lib/chatgpt-plan/provider", () => ({
	createChatGptPlanModel: mocks.createPlanModel,
}));

// The per-task choice itself is tested in chatgpt-plan-models.test.ts.
vi.mock("../lib/chatgpt-plan/models", () => ({
	resolveChatGptPlanModel: async ({ taskType }: { taskType: string }) =>
		taskType === "SIMPLE"
			? { model: "gpt-5.6-luna", reasoningEffort: "low" }
			: { model: "gpt-6-astra", reasoningEffort: "medium" },
}));

import { runWithAiInteractiveContext } from "../lib/chatgpt-plan/interactive-context";
import { getAIModelWithMetadata } from "../lib/dynamic-model-selector";

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 4, text: 4, reasoning: 0 },
};

function mockModel() {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: "Hello" }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: USAGE,
			warnings: [],
		}),
	});
}

const ORG_GATEWAY = {
	apiKey: "encrypted:example-org-gateway-key",
	baseUrl: null,
	clientId: null,
	configId: "cfg-example-org",
	deploymentName: null,
	enabledProviders: [],
	encryptedClientSecret: null,
	provider: "VERCEL_GATEWAY",
	source: "organization" as const,
};

const SELECTION = {
	model: {
		canonicalName: "gpt-4o-mini",
		capabilities: [],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		suitableForTasks: ["CHAT"],
		providerMappings: [
			{
				isAvailable: true,
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-4o-mini",
			},
		],
	},
	providerModelId: "openai/gpt-4o-mini",
	source: "org_override" as const,
};

const ELIGIBLE = {
	userId: "user-1",
	organizationId: "org-1",
	planEligible: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getModel.mockImplementation(() => mockModel());
	mocks.createPlanModel.mockImplementation(() => mockModel());
	mocks.getAiProviderApiKey.mockResolvedValue(ORG_GATEWAY);
	mocks.getModelForTask.mockResolvedValue(SELECTION);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.activeUse.mockResolvedValue({
		includeBackgroundJobs: false,
		credentialStatus: "ACTIVE",
	});
});

describe("getAIModelWithMetadata — ChatGPT plan routing", () => {
	it("routes to the member's plan when every condition holds", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);

		expect(resolved.metadata.provider).toBe("OPENAI_CHATGPT_PLAN");
		expect(resolved.metadata.modelString).toBe("gpt-6-astra");
		expect(mocks.createPlanModel).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				modelId: "gpt-6-astra",
				reasoningEffort: "medium",
			}),
		);
		expect(mocks.getModel).not.toHaveBeenCalled();
		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"CHATGPT_PLAN",
			"org-1",
		);
	});

	it("uses the plan model chosen for the task", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			ELIGIBLE,
		);
		expect(resolved.metadata.modelString).toBe("gpt-5.6-luna");
		expect(mocks.createPlanModel).toHaveBeenCalledWith(
			expect.objectContaining({
				modelId: "gpt-5.6-luna",
				reasoningEffort: "low",
			}),
		);
	});

	it("logs a plan call with the real model id and zero cost", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await generateText({ model: resolved.model, prompt: "Hi" });

		expect(mocks.logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(mocks.logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "OPENAI_CHATGPT_PLAN",
				providerModelId: "gpt-6-astra",
				modelCanonicalName: "gpt-6-astra",
				billingCategory: "EXTERNAL_BYOK",
				costUsd: 0,
				inputTokens: 10,
				outputTokens: 4,
			}),
		);
	});

	it("keeps a background call on the organization provider by default", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("routes a background call to the plan when the member included background jobs", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "ACTIVE",
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(resolved.metadata.provider).toBe("OPENAI_CHATGPT_PLAN");
	});

	it("keeps a background call on the organization provider when the flag is off, whatever the member chose", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "ACTIVE",
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.activeUse).not.toHaveBeenCalled();
	});

	it("stays on the organization provider when the flag is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.activeUse).not.toHaveBeenCalled();
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("stays on the organization provider without an active plan turned on here", async () => {
		mocks.activeUse.mockResolvedValue(null);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("stays on the organization provider when no organization resolved", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ userId: "user-1", planEligible: true },
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
	});

	it("refuses instead of billing the organization when the plan needs reconnecting", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: false,
			credentialStatus: "NEEDS_RECONNECT",
		});
		await expect(
			getAIModelWithMetadata({ taskType: "CHAT" }, ELIGIBLE),
		).rejects.toMatchObject({
			name: "ChatGptPlanAuthError",
			message: expect.stringContaining("needs to be reconnected"),
		});
		expect(mocks.getModel).not.toHaveBeenCalled();
		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
	});

	it("refuses a background job covered by background jobs when the plan needs reconnecting", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "NEEDS_RECONNECT",
		});
		await expect(
			getAIModelWithMetadata(
				{ taskType: "CHAT" },
				{ userId: "user-1", organizationId: "org-1" },
			),
		).rejects.toMatchObject({ name: "ChatGptPlanAuthError" });
	});

	it("keeps calls the plan would not serve on the organization provider, whatever the sign-in state", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: false,
			credentialStatus: "NEEDS_RECONNECT",
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
	});

	it("falls back to the organization provider when the check itself fails", async () => {
		mocks.activeUse.mockRejectedValue(new Error("connection refused"));
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("never routes a caller that hands the raw provider key to its own client", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "ACTIVE",
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ ...ELIGIBLE, excludeChatGptPlan: true },
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
	});

	it.each(["IMAGE", "AUDIO"])(
		"never routes a %s task, which the plan cannot serve",
		async (taskType) => {
			await getAIModelWithMetadata({ taskType }, ELIGIBLE).catch(
				() => undefined,
			);
			expect(mocks.createPlanModel).not.toHaveBeenCalled();
		},
	);

	it("never routes an embedding, even when marked plan-eligible", async () => {
		// Whatever the organization path then does with an embedding task, the
		// plan gate is never asked.
		await getAIModelWithMetadata({ taskType: "EMBEDDING" }, ELIGIBLE).catch(
			() => undefined,
		);
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});
});

describe("getAIModelWithMetadata — a person's own browser request", () => {
	const UNMARKED = { userId: "user-1", organizationId: "org-1" };

	it("routes an unmarked call to the plan inside that member's request", async () => {
		const resolved = await runWithAiInteractiveContext(
			{ userId: "user-1" },
			() => getAIModelWithMetadata({ taskType: "COMPLEX" }, UNMARKED),
		);
		expect(resolved.metadata.provider).toBe("OPENAI_CHATGPT_PLAN");
	});

	it("keeps the same call on the organization provider outside any request", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			UNMARKED,
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("keeps a call marked not plan-eligible on the organization provider inside a request", async () => {
		const resolved = await runWithAiInteractiveContext(
			{ userId: "user-1" },
			() =>
				getAIModelWithMetadata(
					{ taskType: "COMPLEX" },
					{ ...UNMARKED, planEligible: false },
				),
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("does not make a call for another member interactive", async () => {
		const resolved = await runWithAiInteractiveContext(
			{ userId: "user-a" },
			() =>
				getAIModelWithMetadata(
					{ taskType: "COMPLEX" },
					{ userId: "user-b", organizationId: "org-1" },
				),
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("still keeps embeddings off the plan inside a request", async () => {
		await runWithAiInteractiveContext({ userId: "user-1" }, () =>
			getAIModelWithMetadata({ taskType: "EMBEDDING" }, UNMARKED).catch(
				() => undefined,
			),
		);
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});
});

describe("getAIModelWithMetadata — an admin acting as the member", () => {
	const IMPERSONATED = { userId: "user-1", impersonated: true };

	it("refuses the plan even for a call its caller marked plan-eligible", async () => {
		const resolved = await runWithAiInteractiveContext(IMPERSONATED, () =>
			getAIModelWithMetadata({ taskType: "COMPLEX" }, ELIGIBLE),
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(mocks.createPlanModel).not.toHaveBeenCalled();
	});

	it("refuses it for background work the member included, too", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "ACTIVE",
		});
		const resolved = await runWithAiInteractiveContext(IMPERSONATED, () =>
			getAIModelWithMetadata(
				{ taskType: "COMPLEX" },
				{ userId: "user-1", organizationId: "org-1" },
			),
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
	});

	it("never asks for a reconnect on the member's behalf", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: false,
			credentialStatus: "NEEDS_RECONNECT",
		});
		const resolved = await runWithAiInteractiveContext(IMPERSONATED, () =>
			getAIModelWithMetadata({ taskType: "COMPLEX" }, ELIGIBLE),
		);
		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
	});
});
