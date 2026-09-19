import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	assertWithinAiUsageLimitsMock,
	getAiProviderApiKeyByProviderMock,
	getLanguageModelMock,
	getEvaluationModelMock,
	getModelForTaskMock,
	getTenantAiGatewayBillingStateMock,
	resolveProviderApiKeyMock,
	wrapEvaluationModelWithUsageLoggingMock,
} = vi.hoisted(() => ({
	assertWithinAiUsageLimitsMock: vi.fn(),
	getAiProviderApiKeyByProviderMock: vi.fn(),
	getLanguageModelMock: vi.fn(),
	getEvaluationModelMock: vi.fn(),
	getModelForTaskMock: vi.fn(),
	getTenantAiGatewayBillingStateMock: vi.fn(),
	resolveProviderApiKeyMock: vi.fn(),
	wrapEvaluationModelWithUsageLoggingMock: vi.fn((model: unknown) => model),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: getAiProviderApiKeyByProviderMock,
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: getModelForTaskMock,
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(),
}));

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: assertWithinAiUsageLimitsMock,
	getTenantAiGatewayBillingState: getTenantAiGatewayBillingStateMock,
}));

vi.mock("../model-factory", () => ({
	getEmbeddingModel: vi.fn(),
	getEvaluationModel: getEvaluationModelMock,
	getModel: getLanguageModelMock,
}));

vi.mock("../lib/databricks-oauth", () => ({
	hasProviderCredentials: vi.fn(),
	hasServicePrincipalCredentials: vi.fn(),
	resolveProviderApiKey: resolveProviderApiKeyMock,
}));

vi.mock("../lib/usage-logging", () => ({ getAiBillingCategory: vi.fn() }));
vi.mock("../lib/usage-logging-middleware", () => ({
	recordAggregateUsage: vi.fn(),
	wrapEmbeddingModelWithUsageLogging: vi.fn(),
	wrapEvaluationModelWithUsageLogging:
		wrapEvaluationModelWithUsageLoggingMock,
	wrapModelWithUsageLogging: vi.fn(),
}));

import {
	AIProviderNotConfiguredError,
	getAIDecisionModelWithMetadata,
	getAIModel,
	getAIModelWithMetadata,
	resolveModelWithProvider,
} from "../lib/dynamic-model-selector";

const ORGANIZATION_GATEWAY = {
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

const JEV_SELECTION = {
	model: {
		canonicalName: "typesafe-ai-jev",
		capabilities: ["EVALUATION"],
		contextWindow: 0,
		maxOutputTokens: null,
		suitableForTasks: ["DECISION"],
		providerMappings: [
			{
				isAvailable: true,
				provider: "VERCEL_GATEWAY",
				providerModelId: "typesafe-ai/jev",
			},
		],
	},
	source: "org_override" as const,
};

describe("getAIDecisionModelWithMetadata", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getAiProviderApiKeyByProviderMock.mockResolvedValue(
			ORGANIZATION_GATEWAY,
		);
		getModelForTaskMock.mockResolvedValue(JEV_SELECTION);
		resolveProviderApiKeyMock.mockResolvedValue("vck_example_org_key");
		getTenantAiGatewayBillingStateMock.mockReturnValue({
			headers: null,
			mode: "external_provider",
		});
		getEvaluationModelMock.mockReturnValue({ type: "evaluation-model" });
	});

	it("uses the organization's Vercel Gateway decision preference even when it is not the text default", async () => {
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(getAiProviderApiKeyByProviderMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			provider: "VERCEL_GATEWAY",
		});
		expect(getModelForTaskMock).toHaveBeenCalledWith(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);
		expect(getEvaluationModelMock).toHaveBeenCalledWith("typesafe-ai/jev", {
			apiKey: "vck_example_org_key",
			provider: "VERCEL_GATEWAY",
			headers: undefined,
		});
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				taskType: "DECISION",
			}),
		);
		expect(wrapEvaluationModelWithUsageLoggingMock).toHaveBeenCalledWith(
			{ type: "evaluation-model" },
			expect.objectContaining({
				organizationId: "org-1",
				provider: "VERCEL_GATEWAY",
				providerModelId: "typesafe-ai/jev",
				taskType: "DECISION",
			}),
		);
		expect(resolved.metadata).toMatchObject({
			canonicalName: "typesafe-ai-jev",
			configSource: "organization",
			provider: "VERCEL_GATEWAY",
		});
	});

	it("refuses to resolve without an organization context", async () => {
		await expect(
			getAIDecisionModelWithMetadata({ userId: "user-1" }),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(getAiProviderApiKeyByProviderMock).not.toHaveBeenCalled();
	});

	it("refuses a platform-served gateway key instead of selecting a tenant model", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...ORGANIZATION_GATEWAY,
			configId: null,
			source: null,
		});

		await expect(
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(getModelForTaskMock).not.toHaveBeenCalled();
		expect(getEvaluationModelMock).not.toHaveBeenCalled();
	});

	it("refuses when the organization has no decision model to resolve", async () => {
		// `getModelForTask` returns null both when nothing is configured and
		// when the organization explicitly switched decisions off. Either way
		// the resolver must throw the configured-provider error, because that
		// is what both production callers (work-item classification and
		// action-item routing) catch to fall back to the language model.
		getModelForTaskMock.mockResolvedValue(null);

		await expect(
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(getEvaluationModelMock).not.toHaveBeenCalled();
		expect(assertWithinAiUsageLimitsMock).not.toHaveBeenCalled();
	});

	it("rejects DECISION before the language-model factory can receive Jev", async () => {
		await expect(
			getAIModel(
				{ taskType: "DECISION" },
				{ userId: "user-1", organizationId: "org-1" },
			),
		).rejects.toThrow(
			"DECISION tasks require a typed evaluation model. Use getAIDecisionModel instead of getAIModel.",
		);

		expect(getLanguageModelMock).not.toHaveBeenCalled();
	});

	it("rejects DECISION through metadata and direct language-resolution entry points", async () => {
		const context = { userId: "user-1", organizationId: "org-1" };

		await expect(
			getAIModelWithMetadata({ taskType: "DECISION" }, context),
		).rejects.toThrow("Use getAIDecisionModel instead of getAIModel.");
		await expect(
			resolveModelWithProvider("DECISION", context),
		).rejects.toThrow("Use getAIDecisionModel instead of getAIModel.");

		expect(getLanguageModelMock).not.toHaveBeenCalled();
	});
});
