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

import { resolveOpenAiApiKey } from "../lib/openai-provider-key";

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

	it("falls back to the environment key when the tenant has no OpenAI config", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...EMPTY_PROVIDER_CONFIG,
		});

		const key = await resolveOpenAiApiKey({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(key).toBe("env-fallback-key");
	});

	it("falls back to the environment key when the OpenAI config has no usable credentials", async () => {
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

		expect(key).toBe("env-fallback-key");
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
