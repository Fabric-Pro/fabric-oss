import { generateText } from "ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	getAIModelWithMetadata,
	getRAGProviderConfig,
} from "../lib/dynamic-model-selector";

const organizationId = "example-org";
const modelId = "claude-haiku-4-5-20251001";
const context = {
	userId: "example-user",
	organizationId,
	excludeChatGptPlan: true,
};

// Local Prisma fixtures keep the provider lookup, catalog selection and usage
// gate real without opening a database connection.
vi.mock("../../database/prisma/client", () => ({
	db: {
		cloudProviderConfig: {
			findFirst: async ({
				where,
			}: {
				where: { isEmbeddingProvider?: boolean };
			}) =>
				where.isEmbeddingProvider
					? null
					: {
							id: "example-config",
							organizationId: "example-org",
							provider: "ANTHROPIC_DIRECT",
							config: { authMode: "federated" },
							encryptedApiKey: null,
							clientId: null,
							encryptedClientSecret: null,
						},
		},
		organizationModelPreference: {
			findUnique: async () => ({
				modelId: "example-model",
				model: {
					id: "example-model",
					canonicalName: "claude-haiku-4-5",
					displayName: "Claude Haiku 4.5",
					contextWindow: 200000,
					maxOutputTokens: 8192,
					providerMappings: [
						{
							provider: "ANTHROPIC_DIRECT",
							providerModelId: "claude-haiku-4-5-20251001",
							isAvailable: true,
						},
					],
				},
			}),
		},
		organization: { findUnique: async () => ({ timezone: "UTC" }) },
		aiUsageLimit: { findMany: async () => [] },
	},
}));

vi.mock("@azure/identity", () => ({
	DefaultAzureCredential: class {
		async getToken() {
			return { token: "example-assertion" };
		}
	},
}));

const messages = vi.fn(async (_request: Request) =>
	Response.json({
		id: "msg_example",
		type: "message",
		role: "assistant",
		model: modelId,
		content: [{ type: "text", text: "example reply" }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 2 },
	}),
);

beforeEach(() => {
	messages.mockClear();
	vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_example");
	vi.stubEnv(
		"ANTHROPIC_ORGANIZATION_ID",
		"00000000-0000-0000-0000-000000000000",
	);
	vi.stubEnv("ANTHROPIC_FEDERATION_AUDIENCE", "example-audience");
	vi.stubEnv("ANTHROPIC_FEDERATION_ALLOWED_ORGANIZATION_IDS", organizationId);
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.url === "https://api.anthropic.com/v1/oauth/token") {
				return Response.json({
					access_token: "example-access",
					expires_in: 600,
					token_type: "Bearer",
				});
			}
			if (request.url === "https://api.anthropic.com/v1/messages") {
				return messages(request);
			}
			throw new Error("Unexpected test request");
		},
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("resolves a federated organization model and sends a Bearer request", async () => {
	const { model } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE", usageLogging: "aggregate" },
		context,
	);
	await expect(
		generateText({ model, prompt: "Hello", maxRetries: 0 }),
	).resolves.toMatchObject({ text: "example reply" });
	expect(messages).toHaveBeenCalledTimes(1);
	const request = messages.mock.calls[0][0];
	expect(request.headers.get("authorization")).toBe("Bearer example-access");
	expect(request.headers.has("x-api-key")).toBe(false);
});

it("resolves the federation credential through the real provider-config conversion", async () => {
	const config = await getRAGProviderConfig(context);
	expect(config).toMatchObject({ provider: "ANTHROPIC_DIRECT", apiKey: "" });
	await expect(config.anthropicBearerSource?.()).resolves.toMatchObject({
		kind: "bearer",
		token: "example-access",
	});
});

it("returns the Anthropic endpoint even when the stored provider has no URL", async () => {
	expect(await getRAGProviderConfig(context)).toMatchObject({
		baseUrl: "https://api.anthropic.com/v1",
	});
});

it.each([
	"getEmbeddingRAGProviderConfig",
	"getSystemEmbeddingRAGProviderConfig",
] as const)("refuses a federated text credential at %s", async (name) => {
	const selectors = await import("../lib/dynamic-model-selector");
	await expect(selectors[name](context)).rejects.toThrow(
		"Anthropic federation cannot be used for embeddings",
	);
});

it("refuses a federated text credential before selecting an embedding model", async () => {
	const { resolveModelWithProvider } = await import(
		"../lib/dynamic-model-selector"
	);
	await expect(
		resolveModelWithProvider("EMBEDDING", context),
	).rejects.toThrow("Anthropic federation cannot be used for embeddings");
});

it("reports an exchange failure without dispatching Messages or using an environment key", async () => {
	vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_example_rejected");
	vi.stubEnv("ANTHROPIC_API_KEY", "example-environment-key");
	const exchange = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(request.url).toBe(
				"https://api.anthropic.com/v1/oauth/token",
			);
			return Response.json(
				{ error: { message: "Authentication failed" } },
				{ status: 401 },
			);
		},
	);
	vi.stubGlobal("fetch", exchange);

	const { model } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE", usageLogging: "aggregate" },
		context,
	);
	await expect(
		generateText({ model, prompt: "Hello", maxRetries: 0 }),
	).rejects.toThrow("Anthropic identity token exchange failed.");
	expect(exchange).toHaveBeenCalledTimes(1);
});

it("refuses a revoked default when the selected task still routes to Anthropic", async () => {
	vi.stubEnv("ANTHROPIC_FEDERATION_ALLOWED_ORGANIZATION_IDS", "");
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(
		getAIModelWithMetadata({ taskType: "SIMPLE" }, context),
	).rejects.toThrow(
		"Anthropic federation is unavailable for this organization.",
	);
	expect(fetch).not.toHaveBeenCalled();
});
