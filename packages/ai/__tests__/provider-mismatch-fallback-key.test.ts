/**
 * The provider-mismatch fallback inside `resolveModelWithProvider`.
 *
 * WHAT IS PINNED HERE (Fizzy #1875)
 *
 * Step 1 of `resolveModelWithProvider` picks its resolver by task type: an
 * embedding task goes to `getSystemAiProviderApiKey` (indexing work, which R13
 * leaves on the deployment's own gateway key), everything else to
 * `getAiProviderApiKey`, which cannot reach that key. The comment on the
 * generation branch says the platform key is "structurally out of reach here".
 *
 * It was not. When model selection lands on a provider the tenant has not
 * configured — a system default whose only mapping is for another provider —
 * the function makes a SECOND lookup, `getAiProviderApiKeyByProvider`, to find
 * a key for the provider actually needed. That function is deliberately
 * unsplit: it refuses in organization context, but its personal branch ends in
 * `getPlatformGatewayProviderConfig()`. The call site passes
 * `context.organizationId || undefined`, so a falsy organization id reaches the
 * personal branch — and after the org-only elimination a falsy organization id
 * means something failed to resolve one, not that the caller is working
 * personally.
 *
 * The discriminator is `source`. The platform gateway hands back a real working
 * key while leaving `source` unset, so `source === null` WITH credentials is
 * exactly the platform-served shape and nothing else.
 *
 * The refusal needs no embedding carve-out, and the last test says why: an
 * embedding task with a provider mismatch returns at a fatal check earlier, so
 * it can never reach this fallback. That is pinned rather than assumed, because
 * if it ever stops being true the refusal would silently start applying to
 * indexing work, which R13 leaves on the deployment key.
 *
 * Mocks sit at the `@repo/database` boundary so the real selection and fallback
 * logic runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getAiProviderApiKeyMock,
	getSystemAiProviderApiKeyMock,
	getAiProviderApiKeyByProviderMock,
	getEmbeddingProviderConfigMock,
	getModelForTaskMock,
	getTaskDefaultModelMock,
} = vi.hoisted(() => ({
	getAiProviderApiKeyMock: vi.fn(),
	getSystemAiProviderApiKeyMock: vi.fn(),
	getAiProviderApiKeyByProviderMock: vi.fn(),
	getEmbeddingProviderConfigMock: vi.fn(),
	getModelForTaskMock: vi.fn(),
	getTaskDefaultModelMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: getAiProviderApiKeyMock,
	getAiProviderApiKeyByProvider: getAiProviderApiKeyByProviderMock,
	getEmbeddingProviderConfig: getEmbeddingProviderConfigMock,
	getModelForTask: getModelForTaskMock,
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: getSystemAiProviderApiKeyMock,
	getTaskDefaultModel: getTaskDefaultModelMock,
	updateProviderLastUsed: vi.fn(),
	logAiUsageAsync: vi.fn(),
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

import { resolveModelWithProvider } from "../lib/dynamic-model-selector";

/** No organization resolved — the state that reaches the personal branch. */
const CONTEXT = { userId: "user-1", organizationId: null };

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

/**
 * What the platform gateway returns: a real key, and no `source`. The absence
 * of `source` is the only thing distinguishing it from a tenant's own row.
 */
const PLATFORM_SERVED_CONFIG = {
	...EMPTY_PROVIDER_CONFIG,
	apiKey: "encrypted:platform-gateway-key",
	provider: "VERCEL_GATEWAY",
	enabledProviders: ["OPENAI"],
};

/** A key the tenant actually configured, for the same provider. */
const TENANT_OWNED_CONFIG = {
	...EMPTY_PROVIDER_CONFIG,
	apiKey: "encrypted:tenant-own-key",
	provider: "VERCEL_GATEWAY",
	configId: "cfg-1",
	source: "user" as const,
	enabledProviders: ["OPENAI"],
};

/**
 * Drive selection into the mismatch branch: the tenant's default provider has
 * no mapping for the task, so the system default resolves onto another
 * provider with `selectionSource: "system_default"`.
 */
function selectOntoAnotherProvider() {
	getModelForTaskMock.mockResolvedValue(null);
	getTaskDefaultModelMock.mockResolvedValue({
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
}

describe("provider-mismatch fallback key", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		selectOntoAnotherProvider();
		// The tenant's own default is a provider with no mapping above, which
		// is what makes the selected provider a mismatch.
		getAiProviderApiKeyMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			apiKey: "encrypted:tenant-default-key",
			provider: "GROQ",
			configId: "cfg-groq",
			source: "user",
		});
	});

	describe("generation (TENANT entry point)", () => {
		it("refuses a platform-served fallback key", async () => {
			getAiProviderApiKeyByProviderMock.mockResolvedValue(
				PLATFORM_SERVED_CONFIG,
			);

			const resolved = await resolveModelWithProvider("CHAT", CONTEXT);

			// The whole point: a working key was available and was not taken.
			expect(resolved.apiKey).toBeNull();
			expect(resolved.configSource).toBeNull();
		});

		it("still accepts a fallback key the tenant configured", async () => {
			// Guards the fix from over-reaching: the refusal must key on
			// `source`, not on the fallback lookup happening at all.
			getAiProviderApiKeyByProviderMock.mockResolvedValue(
				TENANT_OWNED_CONFIG,
			);

			const resolved = await resolveModelWithProvider("CHAT", CONTEXT);

			// Still encrypted here — decryption happens a layer up, in
			// `getRAGProviderConfig`.
			expect(resolved.apiKey).toBe("encrypted:tenant-own-key");
			expect(resolved.configSource).toBe("user");
		});
	});

	describe("embedding (SYSTEM entry point)", () => {
		it("never reaches the fallback at all — a mismatch is fatal first", async () => {
			// Why the refusal above needs no embedding exemption: a provider
			// mismatch on an embedding task returns at the fatal check before
			// `needsFallbackKey` is computed, because using one provider's key
			// against another's endpoint is a credential mismatch, not a fallback
			// opportunity. If that ever changes, this test fails and the refusal
			// needs an explicit SYSTEM carve-out (R13 keeps indexing on the
			// deployment key).
			getEmbeddingProviderConfigMock.mockResolvedValue({
				...EMPTY_PROVIDER_CONFIG,
				provider: "VERCEL_GATEWAY",
				apiKey: "encrypted:tenant-embedding-key",
				source: "user",
			});
			getModelForTaskMock.mockResolvedValue(null);
			getTaskDefaultModelMock.mockResolvedValue({
				id: "model-2",
				canonicalName: "text-embedding-3-small",
				displayName: "Text Embedding 3 Small",
				providerMappings: [
					{ provider: "GROQ", providerModelId: "groq/embed" },
				],
			});

			await expect(
				resolveModelWithProvider("EMBEDDING", CONTEXT),
			).rejects.toThrow(/does not have a model mapping for embeddings/);

			expect(getAiProviderApiKeyByProviderMock).not.toHaveBeenCalled();
		});
	});
});
