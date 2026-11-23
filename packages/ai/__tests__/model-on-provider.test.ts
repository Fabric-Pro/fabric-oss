/**
 * Resolving a model on a provider the caller names, as the Parlume notes
 * evaluation does for a tenant whose default provider is another one. The
 * model runs on the tenant's own config for that provider (the
 * organization's in an organization, else the member's), never its default
 * or a ChatGPT plan, and a provider with no such config or no mapping for
 * the model is refused rather than replaced by another.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: vi.fn(),
	getAvailableCanonicalNameForProviderModelId: vi.fn(),
	getModelByCanonicalName: vi.fn(),
	getModelForTask: vi.fn(),
	getProviderModelMappingForCanonical: vi.fn(),
	getModel: vi.fn(),
	logAiUsageAsync: vi.fn(),
	sourceForCall: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: mocks.getAiProviderApiKey,
	getAiProviderApiKeyByProvider: mocks.getAiProviderApiKeyByProvider,
	getAvailableCanonicalNameForProviderModelId:
		mocks.getAvailableCanonicalNameForProviderModelId,
	getCanonicalNameForProviderModelId: vi.fn(async () => null),
	getEmbeddingProviderConfig: vi.fn(),
	getModelByCanonicalName: mocks.getModelByCanonicalName,
	getModelForTask: mocks.getModelForTask,
	getPlanSpentPersonalProviderConfig: vi.fn(),
	getProviderModelIdForCanonical: vi.fn(async () => null),
	getProviderModelMappingForCanonical:
		mocks.getProviderModelMappingForCanonical,
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(async () => 1),
	logAiUsageAsync: mocks.logAiUsageAsync,
	isFeatureEnabled: vi.fn(async () => true),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

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
	getAIModelOnProvider,
} from "../lib/dynamic-model-selector";

const OVERRIDE = "example-claude-model";

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

const ORG_ANTHROPIC = {
	...EMPTY,
	apiKey: "encrypted:example-org-anthropic-key",
	configId: "cfg-org-anthropic",
	provider: "ANTHROPIC_DIRECT",
	source: "organization" as const,
};

const PERSONAL_ANTHROPIC = {
	...EMPTY,
	apiKey: "encrypted:example-personal-anthropic-key",
	configId: "cfg-personal-anthropic",
	provider: "ANTHROPIC_DIRECT",
	source: "user" as const,
};

const SELECTION = {
	model: {
		canonicalName: "example-default-model",
		capabilities: [],
		contextWindow: 200000,
		maxOutputTokens: 16384,
		suitableForTasks: ["SIMPLE"],
		providerMappings: [
			{
				isAvailable: true,
				provider: "ANTHROPIC_DIRECT",
				providerModelId: "example-default-model-id",
			},
		],
	},
	providerModelId: "example-default-model-id",
	source: "org_override" as const,
};

const OPTIONS = {
	taskType: "SIMPLE",
	complexity: "simple" as const,
	modelOverride: OVERRIDE,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getModel.mockImplementation(() => ({ modelId: "mock" }));
	mocks.getModelForTask.mockResolvedValue(SELECTION);
	mocks.getModelByCanonicalName.mockResolvedValue({
		canonicalName: OVERRIDE,
		maxOutputTokens: 8192,
	});
	mocks.getProviderModelMappingForCanonical.mockResolvedValue({
		exists: true,
		providerModelId: "example-claude-model-id",
	});
	mocks.getAvailableCanonicalNameForProviderModelId.mockResolvedValue(null);
	mocks.sourceForCall.mockResolvedValue(null);
});

describe("getAIModelOnProvider", () => {
	it("runs the model on the organization's config for that provider, not its default or a plan", async () => {
		mocks.getAiProviderApiKeyByProvider.mockResolvedValue(ORG_ANTHROPIC);

		const { metadata } = await getAIModelOnProvider(
			"ANTHROPIC_DIRECT",
			OPTIONS,
			{ userId: "user-1", organizationId: "org-1" },
		);

		expect(mocks.getAiProviderApiKeyByProvider).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			provider: "ANTHROPIC_DIRECT",
		});
		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
		expect(mocks.sourceForCall).not.toHaveBeenCalled();
		expect(mocks.getModel).toHaveBeenCalledWith(
			"example-claude-model-id",
			expect.objectContaining({
				apiKey: "example-org-anthropic-key",
				provider: "ANTHROPIC_DIRECT",
			}),
		);
		expect(metadata).toMatchObject({
			canonicalName: OVERRIDE,
			provider: "ANTHROPIC_DIRECT",
			configId: "cfg-org-anthropic",
			configSource: "organization",
			selectionSource: "override",
		});
	});

	it("uses the member's own config for that provider outside an organization", async () => {
		mocks.getAiProviderApiKeyByProvider.mockResolvedValue(
			PERSONAL_ANTHROPIC,
		);

		const { metadata } = await getAIModelOnProvider(
			"ANTHROPIC_DIRECT",
			OPTIONS,
			{ userId: "user-1" },
		);

		expect(mocks.getAiProviderApiKeyByProvider).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: undefined,
			provider: "ANTHROPIC_DIRECT",
		});
		expect(metadata).toMatchObject({
			canonicalName: OVERRIDE,
			configId: "cfg-personal-anthropic",
			configSource: "user",
		});
	});

	it("refuses a provider the tenant has no enabled config for", async () => {
		mocks.getAiProviderApiKeyByProvider.mockResolvedValue(EMPTY);

		await expect(
			getAIModelOnProvider("ANTHROPIC_DIRECT", OPTIONS, {
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
		expect(mocks.getModel).not.toHaveBeenCalled();
	});

	it("refuses a model the provider does not map instead of running its default", async () => {
		mocks.getAiProviderApiKeyByProvider.mockResolvedValue(ORG_ANTHROPIC);
		mocks.getProviderModelMappingForCanonical.mockResolvedValue({
			exists: false,
			providerModelId: null,
		});

		await expect(
			getAIModelOnProvider("ANTHROPIC_DIRECT", OPTIONS, {
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toThrow(
			`ANTHROPIC_DIRECT has no available mapping for ${OVERRIDE}`,
		);
		expect(mocks.getModel).not.toHaveBeenCalled();
		expect(mocks.logAiUsageAsync).not.toHaveBeenCalled();
	});
});
