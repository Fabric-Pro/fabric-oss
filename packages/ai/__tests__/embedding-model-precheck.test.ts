import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsupportedEmbeddingModelError } from "../lib/embedding-dimensions";

const db = vi.hoisted(() => ({
	getAiProviderApiKey: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getOrganizationSystemAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: vi.fn(),
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: vi.fn(),
	getTaskDefaultModel: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getProviderModelIdForCanonical: vi.fn(),
	updateProviderLastUsed: vi.fn(() => Promise.resolve()),
	logAiUsageAsync: vi.fn(),
	...db,
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

// Detect provider model construction without calling an external provider.
vi.mock("../model-factory", () => ({
	getEmbeddingModel: vi.fn(
		(modelString: string, options: { provider: string }) => ({
			modelString,
			provider: options.provider,
		}),
	),
	getEvaluationModel: vi.fn(),
	getModel: vi.fn(),
}));

vi.mock("../lib/usage-logging-middleware", () => ({
	recordAggregateUsage: vi.fn(),
	wrapEmbeddingModelWithUsageLogging: vi.fn((model: unknown) => model),
	wrapEvaluationModelWithUsageLogging: vi.fn((model: unknown) => model),
	wrapModelWithUsageLogging: vi.fn((model: unknown) => model),
}));

import {
	AIProviderNotConfiguredError,
	assertEmbeddingModelUsable,
} from "../lib/dynamic-model-selector";

const ORG = "org-1";
const ADMIN = "user-admin";
const MEMBER = "user-member";

const EMPTY_PROVIDER_CONFIG = {
	apiKey: null,
	provider: null,
	baseUrl: null,
	enabledProviders: [],
	configId: null,
	source: null,
	clientId: null,
	encryptedClientSecret: null,
	deploymentName: null,
};

/** Each member's personal default provider. */
const PERSONAL_PROVIDERS: Record<string, string> = {
	[ADMIN]: "OPENAI_DIRECT",
	[MEMBER]: "MISTRAL",
};

/** The embedding model each provider maps to. */
const EMBEDDING_MODELS: Record<string, string> = {
	OPENAI_DIRECT: "text-embedding-3-small",
	MISTRAL: "mistral-embed",
	VERCEL_GATEWAY: "openai/text-embedding-3-small",
};

beforeEach(() => {
	vi.clearAllMocks();
	// No dedicated embedding provider in the organization.
	db.getEmbeddingProviderConfig.mockResolvedValue({
		...EMPTY_PROVIDER_CONFIG,
	});
	// The organization has no default provider either, so today's fallback
	// ends in the acting member's personal one.
	db.getSystemAiProviderApiKey.mockImplementation(
		async ({ userId }: { userId: string }) => ({
			...EMPTY_PROVIDER_CONFIG,
			provider: PERSONAL_PROVIDERS[userId],
			apiKey: `encrypted:${userId}-personal-key`,
			configId: `cfg-${userId}`,
			source: "user",
		}),
	);
	// The organization-only fallback: the deployment's gateway.
	db.getOrganizationSystemAiProviderApiKey.mockResolvedValue({
		...EMPTY_PROVIDER_CONFIG,
		provider: "VERCEL_GATEWAY",
		apiKey: "encrypted:platform-gateway-key",
	});
	db.getModelForTask.mockImplementation(
		async (_userId: string, provider: string) => ({
			model: {
				id: `model-${provider}`,
				canonicalName: EMBEDDING_MODELS[provider]?.replace(
					"openai/",
					"",
				),
				displayName: EMBEDDING_MODELS[provider],
			},
			providerModelId: EMBEDDING_MODELS[provider],
			source: "system_default",
		}),
	);
});

describe("assertEmbeddingModelUsable", () => {
	it("refuses an unsupported canonical width before using a provider", async () => {
		db.getModelForTask.mockResolvedValue({
			model: {
				id: "model-example",
				canonicalName: "text-embedding-3-large",
				displayName: "Embedding",
			},
			providerModelId: "custom-deployment",
			source: "system_default",
		});
		await expect(
			assertEmbeddingModelUsable({ userId: ADMIN, organizationId: ORG }),
		).rejects.toBeInstanceOf(UnsupportedEmbeddingModelError);
	});
	it("refuses missing provider credentials", async () => {
		db.getSystemAiProviderApiKey.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
		});
		await expect(
			assertEmbeddingModelUsable({ userId: ADMIN, organizationId: ORG }),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
	});
	it("accepts a 1536 model without usage gating, decryption or model creation", async () => {
		await expect(
			assertEmbeddingModelUsable({ userId: ADMIN, organizationId: ORG }),
		).resolves.toBeUndefined();
		const { assertWithinAiUsageLimits } = await import("@repo/payments");
		const { decryptApiKey, decryptApiKeyMaybe } = await import(
			"@repo/utils"
		);
		const { getEmbeddingModel } = await import("../model-factory");
		expect(assertWithinAiUsageLimits).not.toHaveBeenCalled();
		expect(decryptApiKey).not.toHaveBeenCalled();
		expect(decryptApiKeyMaybe).not.toHaveBeenCalled();
		expect(getEmbeddingModel).not.toHaveBeenCalled();
	});
	it("forwards organizationOnly to the organization-only provider resolver", async () => {
		await assertEmbeddingModelUsable({
			userId: ADMIN,
			organizationId: ORG,
			organizationOnly: true,
		});
		expect(db.getOrganizationSystemAiProviderApiKey).toHaveBeenCalledWith({
			organizationId: ORG,
		});
		expect(db.getSystemAiProviderApiKey).not.toHaveBeenCalled();
	});
});
