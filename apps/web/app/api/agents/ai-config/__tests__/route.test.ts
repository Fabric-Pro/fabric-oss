/**
 * Tests for the agent AI-config route (GET /api/agents/ai-config).
 *
 * Focus: the gateway-URL resolution. A provider that requires a
 * tenant-supplied base URL (Databricks, Azure AI Foundry, AWS Bedrock,
 * Cloudflare AI, ...) but has none stored must NOT fall back to OpenRouter's
 * host — sending the tenant's provider key (e.g. a Databricks PAT) to
 * openrouter.ai is a wrong-host failure. Instead the route returns
 * `gatewayUrl: null` so the agent surfaces its own "requires a base URL"
 * error. Gateway/direct providers (and an unresolved provider) still fall back
 * to the OpenRouter default.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	verifySignedTenantRequestMock,
	getAIModelWithMetadataMock,
	getRAGProviderConfigMock,
} = vi.hoisted(() => ({
	verifySignedTenantRequestMock: vi.fn(),
	getAIModelWithMetadataMock: vi.fn(),
	getRAGProviderConfigMock: vi.fn(),
}));

vi.mock("@repo/agent-runtime", () => ({
	verifySignedTenantRequest: verifySignedTenantRequestMock,
}));

// Faithful, hermetic stand-ins for the real gateway-config helpers. Mirrors
// AI_PROVIDER_METADATA: providers with an empty metadata.baseUrl (Databricks,
// Azure, Bedrock, Cloudflare, Custom) have no default and declare
// requiresBaseUrl; gateways/direct providers carry a default and do not.
const DEFAULT_BASE_URLS: Record<string, string> = {
	OPENROUTER: "https://openrouter.ai/api/v1",
	VERCEL_GATEWAY: "https://ai-gateway.vercel.sh/v1",
	OPENAI_DIRECT: "https://api.openai.com/v1",
	ANTHROPIC_DIRECT: "https://api.anthropic.com/v1",
	GROQ: "https://api.groq.com/openai/v1",
};
const REQUIRES_BASE_URL = new Set([
	"CLOUDFLARE_AI",
	"AZURE_AI_FOUNDRY",
	"GOOGLE_VERTEX_AI",
	"AWS_BEDROCK",
	"DATABRICKS",
	"CUSTOM",
	"AZURE_OPENAI",
]);

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: getAIModelWithMetadataMock,
	getRAGProviderConfig: getRAGProviderConfigMock,
	buildEffectiveBaseUrl: (provider: string, customBaseUrl?: string) =>
		customBaseUrl || DEFAULT_BASE_URLS[provider],
	requiresBaseUrl: (provider: string) => REQUIRES_BASE_URL.has(provider),
	isReasoningModelName: (model?: string | null) =>
		!!model && /deepseek-r1|deepseek-reasoner|r1-distill/i.test(model),
}));

vi.mock("@repo/payments", () => ({
	// Only referenced in the error branch (instanceof check); a plain class
	// suffices since the happy path never throws it.
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

// Import the route AFTER the mocks are registered.
import { GET } from "../route";

const USER_ID = "user_123";

function makeRequest(): NextRequest {
	// The route only forwards `req.headers` to the (mocked) auth verifier.
	return { headers: new Headers() } as unknown as NextRequest;
}

function setupModel(provider: string | undefined, modelString = "some-model") {
	getAIModelWithMetadataMock.mockResolvedValue({
		metadata: { provider, modelString },
		trackUsage: vi.fn(),
	});
}

function setupProviderConfig(config: {
	apiKey?: string;
	baseUrl?: string;
	deploymentName?: string | null;
}) {
	getRAGProviderConfigMock.mockResolvedValue({
		apiKey: config.apiKey ?? "provider-key",
		baseUrl: config.baseUrl ?? "",
		deploymentName: config.deploymentName ?? null,
	});
}

describe("GET /api/agents/ai-config — gatewayUrl resolution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		verifySignedTenantRequestMock.mockReturnValue({
			ok: true,
			userId: USER_ID,
			organizationId: null,
		});
	});

	it("returns 401 when the signed-tenant auth fails", async () => {
		verifySignedTenantRequestMock.mockReturnValue({
			ok: false,
			error: "bad signature",
			status: 401,
		});

		const res = await GET(makeRequest());

		expect(res.status).toBe(401);
		expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
	});

	it("returns null gatewayUrl (NOT openrouter.ai) for Databricks without a base URL", async () => {
		setupModel("DATABRICKS");
		setupProviderConfig({ apiKey: "dapi-secret", baseUrl: "" });

		const res = await GET(makeRequest());
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.provider).toBe("DATABRICKS");
		expect(body.gatewayUrl).toBeNull();
		// The core of the bug: the Databricks key must never be routed to OpenRouter.
		expect(body.gatewayUrl).not.toBe("https://openrouter.ai/api/v1");
	});

	it("returns the tenant's custom base URL for Databricks when one is stored", async () => {
		setupModel("DATABRICKS");
		setupProviderConfig({
			apiKey: "dapi-secret",
			baseUrl: "https://xyz.cloud.databricks.com",
		});

		const res = await GET(makeRequest());
		const body = await res.json();

		expect(body.gatewayUrl).toBe("https://xyz.cloud.databricks.com");
	});

	it("returns null gatewayUrl for Azure AI Foundry without a base URL", async () => {
		setupModel("AZURE_AI_FOUNDRY");
		setupProviderConfig({ apiKey: "azure-secret", baseUrl: "" });

		const res = await GET(makeRequest());
		const body = await res.json();

		expect(body.gatewayUrl).toBeNull();
	});

	it("falls back to the OpenRouter default when the provider is unset", async () => {
		setupModel(undefined);
		setupProviderConfig({ apiKey: "sk-or-secret", baseUrl: "" });

		const res = await GET(makeRequest());
		const body = await res.json();

		expect(body.gatewayUrl).toBe("https://openrouter.ai/api/v1");
	});

	it("falls back to the OpenRouter default for an OpenRouter provider without a base URL", async () => {
		setupModel("OPENROUTER");
		setupProviderConfig({ apiKey: "sk-or-secret", baseUrl: "" });

		const res = await GET(makeRequest());
		const body = await res.json();

		expect(body.gatewayUrl).toBe("https://openrouter.ai/api/v1");
	});

	it("uses the provider's own default base URL for a non-requiresBaseUrl gateway", async () => {
		setupModel("VERCEL_GATEWAY");
		setupProviderConfig({ apiKey: "vck-secret", baseUrl: "" });

		const res = await GET(makeRequest());
		const body = await res.json();

		expect(body.gatewayUrl).toBe("https://ai-gateway.vercel.sh/v1");
	});
});
