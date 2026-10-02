/**
 * Organization-only embedding resolution (`organizationOnly`, Fizzy #2719).
 *
 * Company context is one index per organization: one member writes its
 * vectors, every member searches them, and a source is ready only while its
 * vectors are the organization's current model. The model must therefore be
 * the same whoever is acting.
 *
 * In organization context the model string is already organization-level —
 * `getModelForTask` reads only organization overrides there. The provider is
 * not: with no dedicated embedding provider, resolution falls back to
 * `getSystemAiProviderApiKey`, which ends in the ACTING USER's personal
 * provider when the organization has no default provider of its own. Two
 * members with different personal providers then resolve different models.
 *
 * `organizationOnly` swaps that fallback for the organization-only one. What
 * this pins:
 *  - two members with different personal providers resolve the same provider
 *    and model, for the identity and for the embedding model instance alike;
 *  - the personal rung is never consulted;
 *  - without the flag — every existing caller, the project path included —
 *    resolution is unchanged, personal fallback and all;
 *  - the flag is refused where it has no meaning.
 *
 * Mocks sit at the `@repo/database` boundary so the real selection runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

// The embedding instance itself is not under test, only what it is built from.
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
	getAIEmbeddingModelWithMetadata,
	resolveModelWithProvider,
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
				canonicalName: EMBEDDING_MODELS[provider],
				displayName: EMBEDDING_MODELS[provider],
			},
			providerModelId: EMBEDDING_MODELS[provider],
			source: "system_default",
		}),
	);
});

describe("organizationOnly embedding resolution", () => {
	it("resolves the same provider and model for two members with different personal providers", async () => {
		const [admin, member] = await Promise.all(
			[ADMIN, MEMBER].map((userId) =>
				resolveModelWithProvider("EMBEDDING", {
					userId,
					organizationId: ORG,
					organizationOnly: true,
				}),
			),
		);

		expect(`${admin.provider}:${admin.modelString}`).toBe(
			"VERCEL_GATEWAY:openai/text-embedding-3-small",
		);
		expect(`${member.provider}:${member.modelString}`).toBe(
			`${admin.provider}:${admin.modelString}`,
		);
		expect(db.getSystemAiProviderApiKey).not.toHaveBeenCalled();
		expect(db.getOrganizationSystemAiProviderApiKey).toHaveBeenCalledWith({
			organizationId: ORG,
		});
	});

	it("builds the embedding model from the same organization-level resolution", async () => {
		const [admin, member] = await Promise.all(
			[ADMIN, MEMBER].map((userId) =>
				getAIEmbeddingModelWithMetadata({
					userId,
					organizationId: ORG,
					organizationOnly: true,
				}),
			),
		);

		expect(admin.metadata.provider).toBe("VERCEL_GATEWAY");
		expect(admin.metadata.modelString).toBe(
			"openai/text-embedding-3-small",
		);
		expect(member.metadata.provider).toBe(admin.metadata.provider);
		expect(member.metadata.modelString).toBe(admin.metadata.modelString);
		expect(db.getSystemAiProviderApiKey).not.toHaveBeenCalled();
	});

	it("uses the organization's dedicated embedding provider when it has one, whoever acts", async () => {
		db.getEmbeddingProviderConfig.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			provider: "OPENAI_DIRECT",
			apiKey: "encrypted:org-embedding-key",
			configId: "cfg-org",
			source: "organization",
		});

		const member = await resolveModelWithProvider("EMBEDDING", {
			userId: MEMBER,
			organizationId: ORG,
			organizationOnly: true,
		});

		expect(`${member.provider}:${member.modelString}`).toBe(
			"OPENAI_DIRECT:text-embedding-3-small",
		);
		expect(db.getOrganizationSystemAiProviderApiKey).not.toHaveBeenCalled();
	});

	it("reports nothing configured when the organization has no provider and no gateway, rather than a member's key", async () => {
		db.getOrganizationSystemAiProviderApiKey.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
		});

		const resolved = await resolveModelWithProvider("EMBEDDING", {
			userId: ADMIN,
			organizationId: ORG,
			organizationOnly: true,
		});

		expect(resolved.apiKey).toBeNull();
		expect(resolved.modelString).toBe("");
		expect(resolved._error).toMatch(/No embedding provider configured/);
	});

	it("refuses the flag outside an organization or for a non-embedding task", async () => {
		await expect(
			resolveModelWithProvider("EMBEDDING", {
				userId: ADMIN,
				organizationOnly: true,
			}),
		).rejects.toThrow(/organizationOnly/);
		await expect(
			resolveModelWithProvider("CHAT", {
				userId: ADMIN,
				organizationId: ORG,
				organizationOnly: true,
			}),
		).rejects.toThrow(/organizationOnly/);
	});
});

describe("without organizationOnly (every existing caller)", () => {
	it("keeps today's fallback: the acting user's resolution, which differs per member", async () => {
		const [admin, member] = await Promise.all(
			[ADMIN, MEMBER].map((userId) =>
				resolveModelWithProvider("EMBEDDING", {
					userId,
					organizationId: ORG,
				}),
			),
		);

		expect(db.getSystemAiProviderApiKey).toHaveBeenCalledWith({
			userId: ADMIN,
			organizationId: ORG,
		});
		expect(db.getOrganizationSystemAiProviderApiKey).not.toHaveBeenCalled();
		expect(`${admin.provider}:${admin.modelString}`).toBe(
			"OPENAI_DIRECT:text-embedding-3-small",
		);
		expect(`${member.provider}:${member.modelString}`).toBe(
			"MISTRAL:mistral-embed",
		);
	});
});
