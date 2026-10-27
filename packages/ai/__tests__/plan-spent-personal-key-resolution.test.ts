/**
 * Resolving a call on the member's own key while their ChatGPT plans are
 * spent (Fizzy #3085). Whether the fallback applies is the pool's decision
 * (chatgpt-plan-pool.test.ts); this pins what the resolver does with it: the
 * model runs on exactly that key, never the organization's default, and a
 * model the key cannot serve resolves nothing rather than another key of the
 * organization's. A caller needing the raw key gets the same row back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: vi.fn(),
	getPlanSpentPersonalProviderConfig: vi.fn(),
	getModelForTask: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	getModel: vi.fn(),
	sourceForCall: vi.fn(),
	updateProviderLastUsed: vi.fn(),
	waitUntil: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: mocks.getAiProviderApiKey,
	getAiProviderApiKeyByProvider: mocks.getAiProviderApiKeyByProvider,
	getPlanSpentPersonalProviderConfig:
		mocks.getPlanSpentPersonalProviderConfig,
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: mocks.getModelForTask,
	getProviderModelIdForCanonical: vi.fn(async () => null),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: mocks.getTaskDefaultModel,
	updateProviderLastUsed: mocks.updateProviderLastUsed,
	logAiUsageAsync: vi.fn(),
	isFeatureEnabled: vi.fn(async () => true),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

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

vi.mock("../lib/chatgpt-plan/pool", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/chatgpt-plan/pool")>()),
	chatGptPlanSourceForCall: mocks.sourceForCall,
}));

import {
	AIProviderNotConfiguredError,
	getAIModelWithMetadata,
	getRAGProviderConfigForModel,
} from "../lib/dynamic-model-selector";

const CONTEXT = {
	userId: "user-1",
	organizationId: "org-1",
	planEligible: true,
};
const RESET = new Date("2026-10-16T18:00:00Z");

const EMPTY = {
	apiKey: null,
	baseUrl: null,
	clientId: null,
	configId: null,
	deploymentName: null,
	enabledProviders: [],
	encryptedClientSecret: null,
	provider: null,
	source: null,
};

const ORG_KEY = {
	...EMPTY,
	apiKey: "encrypted:example-org-key",
	configId: "cfg-org",
	provider: "OPENAI_DIRECT",
	source: "organization" as const,
};

const PERSONAL_KEY = {
	...EMPTY,
	apiKey: "encrypted:example-personal-key",
	configId: "cfg-personal",
	provider: "OPENAI_DIRECT",
	source: "user" as const,
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
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-4o-mini",
			},
		],
	},
	providerModelId: "gpt-4o-mini",
	source: "org_override" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getModel.mockImplementation(() => ({ modelId: "mock" }));
	mocks.getAiProviderApiKey.mockResolvedValue(ORG_KEY);
	mocks.getModelForTask.mockResolvedValue(SELECTION);
	mocks.sourceForCall.mockResolvedValue(null);
	mocks.updateProviderLastUsed.mockResolvedValue(1);
});

describe("getAIModelWithMetadata trackUsage", () => {
	// On Vercel a bare promise can be frozen between the UPDATE and its
	// COMMIT once the response is sent, stranding an idle transaction that
	// blocks migrations (Fizzy #3263). The bump must outlive the response.
	it("hands the last-used bump to waitUntil without waiting for it", async () => {
		const { trackUsage } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		expect(trackUsage()).toBeUndefined();

		expect(mocks.updateProviderLastUsed).toHaveBeenCalledWith({
			configId: "cfg-org",
			source: "organization",
		});
		expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
		await expect(mocks.waitUntil.mock.calls[0][0]).resolves.toBe(1);
	});

	it("registers a promise that settles even when the write fails", async () => {
		mocks.updateProviderLastUsed.mockRejectedValue(new Error("db down"));
		const { trackUsage } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		trackUsage();

		await expect(mocks.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
	});
});

describe("getAIModelWithMetadata on a plan-spent personal key", () => {
	it("runs on the member's own key and says so, never reading the organization's", async () => {
		mocks.sourceForCall.mockResolvedValue({
			personalKey: PERSONAL_KEY,
			resetAt: RESET,
		});

		const { metadata } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
		expect(mocks.getModel).toHaveBeenCalledWith(
			"gpt-4o-mini",
			expect.objectContaining({ apiKey: "example-personal-key" }),
		);
		expect(metadata).toMatchObject({
			configId: "cfg-personal",
			configSource: "user",
			planSpentPersonalKey: { provider: "OPENAI_DIRECT", resetAt: RESET },
		});
	});

	it("leaves an ordinary resolution unmarked, on the organization's key", async () => {
		const { metadata } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		expect(metadata.configSource).toBe("organization");
		expect(metadata.planSpentPersonalKey).toBeUndefined();
	});

	it("resolves nothing rather than another organization key when the personal key cannot serve the model", async () => {
		mocks.sourceForCall.mockResolvedValue({
			personalKey: { ...PERSONAL_KEY, provider: "GROQ" },
			resetAt: RESET,
		});
		// Selection lands on a provider the personal key is not.
		mocks.getModelForTask.mockResolvedValue(null);
		mocks.getTaskDefaultModel.mockResolvedValue({
			id: "model-1",
			canonicalName: "gpt-4o-mini",
			displayName: "GPT-4o mini",
			contextWindow: 128000,
			maxOutputTokens: 16384,
			providerMappings: [
				{
					provider: "VERCEL_GATEWAY",
					providerModelId: "openai/gpt-4o-mini",
				},
			],
		});
		mocks.getAiProviderApiKeyByProvider.mockResolvedValue({
			...ORG_KEY,
			provider: "VERCEL_GATEWAY",
		});

		await expect(
			getAIModelWithMetadata({ taskType: "CHAT" }, CONTEXT),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(mocks.getAiProviderApiKeyByProvider).not.toHaveBeenCalled();
		expect(mocks.getModel).not.toHaveBeenCalled();
	});
});

describe("getRAGProviderConfigForModel", () => {
	it("hands back the personal row the model was resolved on, by the caller's id", async () => {
		mocks.getPlanSpentPersonalProviderConfig.mockResolvedValue(
			PERSONAL_KEY,
		);

		const config = await getRAGProviderConfigForModel(CONTEXT, {
			configId: "cfg-personal",
			planSpentPersonalKey: { provider: "OPENAI_DIRECT", resetAt: RESET },
		});

		expect(mocks.getPlanSpentPersonalProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			configId: "cfg-personal",
		});
		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
		expect(config).toMatchObject({
			apiKey: "example-personal-key",
			source: "user",
		});
	});

	it("refuses when that personal row no longer qualifies", async () => {
		mocks.getPlanSpentPersonalProviderConfig.mockResolvedValue(null);

		await expect(
			getRAGProviderConfigForModel(CONTEXT, {
				configId: "cfg-personal",
				planSpentPersonalKey: {
					provider: "OPENAI_DIRECT",
					resetAt: null,
				},
			}),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
	});

	it("resolves the tenant's key as before for any other model", async () => {
		const config = await getRAGProviderConfigForModel(CONTEXT, {
			configId: "cfg-org",
		});

		expect(mocks.getPlanSpentPersonalProviderConfig).not.toHaveBeenCalled();
		expect(config).toMatchObject({
			apiKey: "example-org-key",
			source: "organization",
		});
	});
});
