/**
 * Tests for `resolveOpenAiApiKey` — the plaintext OpenAI API key resolver for
 * call sites that hit OpenAI's REST API directly (e.g. the TTS endpoint).
 *
 * Regression coverage for the bug this helper fixes: the TTS tool used to
 * pass `resolveModelWithCredentials`'s result straight through, which is
 * BOTH the wrong provider (whatever the tenant's default model selection
 * picked, not necessarily OpenAI) and the ENCRYPTED key, not plaintext.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { getAiProviderApiKeyByProviderMock } = vi.hoisted(() => ({
	getAiProviderApiKeyByProviderMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getAiProviderApiKeyByProvider: getAiProviderApiKeyByProviderMock,
}));

vi.mock("@repo/utils", () => ({
	// Mirror databricks-oauth.test.ts's convention: store "encrypted:<plaintext>"
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
	resolveAzureOpenAiResource,
	resolveOpenAiApiKey,
} from "../lib/openai-provider-key";

/** The "nothing configured" shape `getAiProviderApiKeyByProvider` returns. */
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

describe("resolveOpenAiApiKey", () => {
	const originalEnvKey = process.env.OPENAI_API_KEY;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.OPENAI_API_KEY = "env-fallback-key";
	});

	afterAll(() => {
		if (originalEnvKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalEnvKey;
		}
	});

	it("decrypts and returns a configured OPENAI_DIRECT key, not the encrypted value", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			provider: "OPENAI_DIRECT",
			apiKey: "encrypted:sk-tenant-key",
			source: "user",
		});

		const key = await resolveOpenAiApiKey({
			userId: "user-1",
			organizationId: null,
		});

		expect(key).toBe("sk-tenant-key");
		expect(getAiProviderApiKeyByProviderMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: null,
			provider: "OPENAI_DIRECT",
		});
	});

	it("passes a legacy plaintext key through instead of rejecting it", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			provider: "OPENAI_DIRECT",
			// Legacy rows without `encryptedApiKey` surface the plaintext key.
			apiKey: "sk-legacy-plaintext-key",
			source: "user",
		});

		const key = await resolveOpenAiApiKey({
			userId: "user-1",
			organizationId: null,
		});

		expect(key).toBe("sk-legacy-plaintext-key");
	});

	// Audio never runs on Fabric's own key: with the platform key set, a
	// tenant without an OpenAI config still resolves to nothing.
	it("never falls back to the platform key when the tenant has no OpenAI config", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
		});

		const key = await resolveOpenAiApiKey({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(key).toBe("");
	});

	it("never falls back to the platform key when the OpenAI config has no usable credentials", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			provider: "OPENAI_DIRECT",
			apiKey: null,
			clientId: null,
			encryptedClientSecret: null,
		});

		const key = await resolveOpenAiApiKey({
			userId: "user-1",
			organizationId: null,
		});

		expect(key).toBe("");
	});

	it("returns an empty string when neither a tenant key nor an environment key exists", async () => {
		process.env.OPENAI_API_KEY = "";
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
		});

		const key = await resolveOpenAiApiKey({ userId: "user-1" });

		expect(key).toBe("");
	});
});

describe("resolveAzureOpenAiResource", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the resource's origin and its decrypted key", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
			apiKey: "encrypted:azure-key",
			provider: "AZURE_AI_FOUNDRY",
			baseUrl:
				"https://example-resource.openai.azure.com/openai/deployments/chat/chat/completions?api-version=2025-01-01-preview",
			deploymentName: "chat",
		});

		await expect(
			resolveAzureOpenAiResource({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({
			origin: "https://example-resource.openai.azure.com",
			apiKey: "azure-key",
		});
		expect(getAiProviderApiKeyByProviderMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			provider: "AZURE_AI_FOUNDRY",
		});
	});

	it("returns null without an endpoint or an API key", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValueOnce({
			...EMPTY_PROVIDER_CONFIG,
			apiKey: "encrypted:azure-key",
		});
		getAiProviderApiKeyByProviderMock.mockResolvedValueOnce({
			...EMPTY_PROVIDER_CONFIG,
			baseUrl: "https://example-resource.openai.azure.com",
		});

		await expect(
			resolveAzureOpenAiResource({ userId: "user-1" }),
		).resolves.toBeNull();
		await expect(
			resolveAzureOpenAiResource({ userId: "user-1" }),
		).resolves.toBeNull();
	});
});
