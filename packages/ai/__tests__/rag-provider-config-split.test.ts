/**
 * The RAG resolver split: `getRAGProviderConfig` (tenant-facing) vs
 * `getSystemRAGProviderConfig` (background / system).
 *
 * WHAT IS PINNED HERE (Fizzy #1875)
 *
 * A user-facing RAG operation runs on a provider the tenant configured — its
 * organization's, or the caller's own personal key used inside it — or it does
 * not run. The deployment's own gateway key takes no part in that decision.
 * Background work — document processing, context and wizard embedding,
 * connector sync, tool ingestion — keeps that fallback.
 *
 * Every test below runs against a resolver pair whose SYSTEM half does return
 * a platform credential. That is deliberate, and mirrors the lower split's
 * tests in `packages/api/lib/__tests__/payments/ai-credits.test.ts`: before
 * this change the single RAG resolver ended in that key, which is a real
 * working credential carrying a null `source`, so a keyless tenant was served
 * silently. Proving the system half still resolves it is what makes the tenant
 * half's refusal evidence of the split rather than of an unconfigured fixture.
 *
 * Mocks sit at the `@repo/database` boundary — the two named resolvers the
 * lower split produced — so the real `getRAGProviderConfig` /
 * `getSystemRAGProviderConfig` bodies (validation + key decryption) run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAiProviderApiKeyMock, getSystemAiProviderApiKeyMock } = vi.hoisted(
	() => ({
		getAiProviderApiKeyMock: vi.fn(),
		getSystemAiProviderApiKeyMock: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: getAiProviderApiKeyMock,
	getAiProviderApiKeyByProvider: vi.fn(),
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: vi.fn(),
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: getSystemAiProviderApiKeyMock,
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(),
	logAiUsageAsync: vi.fn(),
}));

// Keeps @repo/api out of the module graph — the selector only needs these two
// symbols from @repo/payments and neither participates in resolver choice.
vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: vi.fn(),
	getTenantAiGatewayBillingState: vi.fn(() => ({
		mode: "external_provider",
		headers: null,
	})),
}));

vi.mock("@repo/utils", () => ({
	// Same convention as databricks-oauth.test.ts: store "encrypted:<plaintext>"
	// and expect the plaintext back.
	decryptApiKey: vi.fn((value: string) => {
		if (!value.startsWith("encrypted:")) {
			throw new Error("Invalid encrypted value");
		}
		return value.slice("encrypted:".length);
	}),
	decryptApiKeyMaybe: vi.fn((value: string) =>
		value.startsWith("encrypted:")
			? value.slice("encrypted:".length)
			: value,
	),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	AIProviderNotConfiguredError,
	getRAGProviderConfig,
	getSystemRAGProviderConfig,
} from "../lib/dynamic-model-selector";

const CONTEXT = { userId: "user-1", organizationId: "org-1" };

/** The deployment's own gateway credential — what the system half may reach. */
const PLATFORM_GATEWAY_KEY = "platform-gateway-key";

/** The "nothing configured" shape both resolvers return when nothing resolves. */
const EMPTY_PROVIDER_CONFIG = {
	apiKey: null,
	configId: null,
	provider: null,
	baseUrl: null,
	enabledProviders: [],
	source: null,
	deploymentName: null,
	clientId: null,
	encryptedClientSecret: null,
};

/**
 * What `getSystemAiProviderApiKey`'s platform branch hands back. Note the
 * asymmetry that made the old shared fallback invisible: a real, working key
 * with a NULL source, where the organization and personal branches stamp one.
 */
const PLATFORM_PROVIDER_CONFIG = {
	...EMPTY_PROVIDER_CONFIG,
	apiKey: `encrypted:${PLATFORM_GATEWAY_KEY}`,
	provider: "VERCEL_GATEWAY",
	enabledProviders: ["OPENAI", "ANTHROPIC"],
};

/** An organization-level provider row carrying a usable API key. */
const ORG_PROVIDER_CONFIG = {
	...EMPTY_PROVIDER_CONFIG,
	apiKey: "encrypted:org-key",
	configId: "cpc_1",
	provider: "OPENAI_DIRECT",
	source: "organization" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	// The deployment DOES set a gateway key throughout this file: the system
	// half can reach it, the tenant half never sees it.
	getAiProviderApiKeyMock.mockResolvedValue({ ...EMPTY_PROVIDER_CONFIG });
	getSystemAiProviderApiKeyMock.mockResolvedValue({
		...PLATFORM_PROVIDER_CONFIG,
	});
});

describe("getRAGProviderConfig (tenant-facing)", () => {
	it("refuses when the tenant configured nothing, on a deployment that has a gateway key", async () => {
		// THE test of this change. Before the split, a brand-new signup with no
		// key of its own was served the platform credential here — which is why
		// uploading one document worked without anyone noticing BYOK was off.
		await expect(getRAGProviderConfig(CONTEXT)).rejects.toBeInstanceOf(
			AIProviderNotConfiguredError,
		);

		// And it refused on its own, without consulting the half that can reach
		// the platform key. This is the structural half of the guarantee: the
		// credential is unavailable, not merely withheld.
		expect(getSystemAiProviderApiKeyMock).not.toHaveBeenCalled();
		expect(getAiProviderApiKeyMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("proves that refusal is not an artefact of an unset gateway key", async () => {
		const config = await getSystemRAGProviderConfig(CONTEXT);

		expect(config.provider).toBe("VERCEL_GATEWAY");
		expect(config.apiKey).toBe(PLATFORM_GATEWAY_KEY);
	});

	it("resolves and decrypts the tenant's own provider when it has one", async () => {
		getAiProviderApiKeyMock.mockResolvedValue({ ...ORG_PROVIDER_CONFIG });

		const config = await getRAGProviderConfig(CONTEXT);

		expect(config.apiKey).toBe("org-key");
		expect(config.provider).toBe("OPENAI_DIRECT");
		expect(config.source).toBe("organization");
	});
});

describe("getSystemRAGProviderConfig (background/system)", () => {
	it("still resolves the platform gateway key for a tenant with nothing configured", async () => {
		// R13. Indexing, embedding and tool ingestion keep their current key
		// resolution — the fallback removal reached the user-facing path only,
		// and a temporal activity that would otherwise retry an unhandled
		// refusal five times never sees one.
		const config = await getSystemRAGProviderConfig(CONTEXT);

		expect(config.apiKey).toBe(PLATFORM_GATEWAY_KEY);
		expect(config.provider).toBe("VERCEL_GATEWAY");
		expect(config.enabledProviders).toEqual(["OPENAI", "ANTHROPIC"]);
		// The platform branch stamps no source, and this shape coalesces the null
		// to "user" on the way out — which is exactly why nothing downstream ever
		// noticed it was being served a platform key. Preserved deliberately, so
		// background callers behave as they did before the split.
		expect(config.source).toBe("user");
		expect(getAiProviderApiKeyMock).not.toHaveBeenCalled();
	});

	it("prefers the tenant's own provider over the platform key", async () => {
		getSystemAiProviderApiKeyMock.mockResolvedValue({
			...ORG_PROVIDER_CONFIG,
		});

		const config = await getSystemRAGProviderConfig(CONTEXT);

		expect(config.apiKey).toBe("org-key");
		expect(config.source).toBe("organization");
	});

	it("still refuses when neither the tenant nor the deployment has a credential", async () => {
		// A self-hosted deployment that sets no gateway key: the system half has
		// nothing left to fall back to and raises the same provider-shaped error.
		getSystemAiProviderApiKeyMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
		});

		await expect(
			getSystemRAGProviderConfig(CONTEXT),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
	});

	it("accepts a service-principal config that carries no apiKey", async () => {
		// Regression guard shared with the tenant half: `hasProviderCredentials`
		// is the configured-ness predicate, not `apiKey` truthiness, so an
		// OAuth-only Databricks row must not read as unconfigured. It fails later
		// at token minting, never at the "no provider configured" refusal.
		getSystemAiProviderApiKeyMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			provider: "DATABRICKS",
			baseUrl: "https://example-workspace.cloud.databricks.com",
			clientId: "client-abc",
			encryptedClientSecret: "encrypted:secret-xyz",
		});

		await expect(
			getSystemRAGProviderConfig(CONTEXT),
		).rejects.not.toBeInstanceOf(AIProviderNotConfiguredError);
	});
});
