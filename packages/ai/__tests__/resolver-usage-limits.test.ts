/**
 * `getAIModelWithMetadata` checks HARD usage limits before every request its
 * model makes, not only when it resolves the model.
 *
 * These run the real resolver, the real middleware chain and the real
 * `generateText`/`streamText` against a mock provider model, with the limit
 * check and the usage-row writer replaced at the package boundary, so they
 * pin what the unit tests of the middleware cannot: the scope the resolver
 * binds, and that the check sits outside the usage logger (a refused request
 * writes no row) in both usage modes. The ChatGPT plan resolver is covered
 * in chatgpt-plan-rotation.test.ts.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { generateText, isStepCount, streamText, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
	assertWithinAiUsageLimitsMock,
	getAiProviderApiKeyMock,
	getModelForTaskMock,
	getModelMock,
	logAiUsageAsyncMock,
} = vi.hoisted(() => ({
	assertWithinAiUsageLimitsMock: vi.fn(),
	getAiProviderApiKeyMock: vi.fn(),
	getModelForTaskMock: vi.fn(),
	getModelMock: vi.fn(),
	logAiUsageAsyncMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: getAiProviderApiKeyMock,
	getAiProviderApiKeyByProvider: vi.fn(),
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: getModelForTaskMock,
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(() => Promise.resolve()),
	logAiUsageAsync: logAiUsageAsyncMock,
}));

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: assertWithinAiUsageLimitsMock,
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
	getModel: getModelMock,
}));

import { getAIModelWithMetadata } from "../lib/dynamic-model-selector";

const CONTEXT = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

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

const PROVIDER_MODEL_ID = "openai/gpt-4o-mini-2024-07-18";

const SELECTION = {
	model: {
		canonicalName: "gpt-4o-mini",
		capabilities: [],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		suitableForTasks: ["CHAT"],
		providerMappings: [
			{
				isAvailable: true,
				provider: "VERCEL_GATEWAY",
				providerModelId: PROVIDER_MODEL_ID,
			},
		],
	},
	providerModelId: PROVIDER_MODEL_ID,
	source: "org_override" as const,
};

/** The scope the resolution-time check uses for this context. */
const LIMIT_SCOPE = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
	providerConfigId: "cfg-example-org",
	modelCanonicalName: "gpt-4o-mini",
	taskType: "CHAT",
};

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 4, text: 4, reasoning: 0 },
};

const TOOL_CALL_RESULT = {
	content: [
		{
			type: "tool-call" as const,
			toolCallId: "call-1",
			toolName: "lookup",
			input: "{}",
		},
	],
	finishReason: { unified: "tool-calls" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

const TEXT_RESULT = {
	content: [{ type: "text" as const, text: "Hello" }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

const tools = {
	lookup: tool({
		inputSchema: z.object({}),
		execute: async () => ({ found: true }),
	}),
};

function limitError() {
	return new AiUsageLimitExceededError({
		message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
		limitId: "limit-1",
		dimension: "TOKENS" as never,
		window: "MONTHLY" as never,
		used: BigInt(100),
		max: BigInt(100),
		manageLimitsUrl: "https://example.com/limits",
	});
}

/** Passes the resolution-time check and `requests` request checks, then refuses. */
function allowRequests(requests: number, refusal = limitError()) {
	let remaining = requests + 1;
	assertWithinAiUsageLimitsMock.mockImplementation(async () => {
		if (remaining <= 0) {
			throw refusal;
		}
		remaining -= 1;
	});
	return refusal;
}

let model: MockLanguageModelV4;

beforeEach(() => {
	vi.clearAllMocks();
	assertWithinAiUsageLimitsMock.mockReset();
	assertWithinAiUsageLimitsMock.mockResolvedValue(undefined);
	let calls = 0;
	model = new MockLanguageModelV4({
		doGenerate: async () => {
			calls += 1;
			return calls === 1 ? TOOL_CALL_RESULT : TEXT_RESULT;
		},
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: "stream-start" as const, warnings: [] },
					{ type: "text-start" as const, id: "t1" },
					{ type: "text-delta" as const, id: "t1", delta: "Hello" },
					{ type: "text-end" as const, id: "t1" },
					{
						type: "finish" as const,
						finishReason: {
							unified: "stop" as const,
							raw: undefined,
						},
						usage: USAGE,
					},
				],
			}),
		}),
	});
	getModelMock.mockImplementation(() => model);
	getAiProviderApiKeyMock.mockResolvedValue(ORGANIZATION_GATEWAY);
	getModelForTaskMock.mockResolvedValue(SELECTION);
});

describe("getAIModelWithMetadata — per-request usage-limit check", () => {
	it("checks every step's request with the scope the resolution check used", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(1);

		await generateText({
			model: resolved.model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(2),
		});

		// Resolution, then one check per step.
		expect(model.doGenerateCalls).toHaveLength(2);
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(3);
		for (const call of assertWithinAiUsageLimitsMock.mock.calls) {
			expect(call).toEqual([LIMIT_SCOPE]);
		}
	});

	it("binds a chat's model override into the per-request scope", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", modelOverride: "example-override-model" },
			CONTEXT,
		);

		await generateText({ model: resolved.model, prompt: "Hi" });

		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(2);
		expect(assertWithinAiUsageLimitsMock.mock.calls[1]).toEqual([
			{
				...LIMIT_SCOPE,
				modelCanonicalName: "example-override-model",
			},
		]);
	});

	it("refuses a later step once the limit is reached: nothing is dispatched and no usage row is written for it", async () => {
		const refusal = allowRequests(1);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(5),
			maxRetries: 0,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(refusal);
		// Step 1 ran and wrote its row; step 2 reached neither the provider
		// nor the usage logger.
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({ success: true }),
		);
	});

	it("refuses a reused model's next stream before it is opened, writing no row", async () => {
		const refusal = allowRequests(0);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		const onError = vi.fn();

		const result = streamText({
			model: resolved.model,
			prompt: "Hi",
			onError,
		});
		for await (const _ of result.stream) {
			// drain
		}

		expect(onError).toHaveBeenCalledWith({ error: refusal });
		expect(model.doStreamCalls).toHaveLength(0);
		expect(logAiUsageAsyncMock).not.toHaveBeenCalled();
	});

	it("checks per request in aggregate usage mode too", async () => {
		const refusal = allowRequests(1);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", usageLogging: "aggregate" },
			CONTEXT,
		);

		await generateText({ model: resolved.model, prompt: "first" });
		const error = await generateText({
			model: resolved.model,
			prompt: "second",
			maxRetries: 0,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(refusal);
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(3);
		expect(assertWithinAiUsageLimitsMock.mock.calls[2]).toEqual([
			LIMIT_SCOPE,
		]);
	});
});
