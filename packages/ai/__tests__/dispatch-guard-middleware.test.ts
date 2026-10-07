/**
 * The dispatch guard every factory model consults (dispatch-guard-middleware.ts).
 *
 * Pins, against the real AI SDK request path with mock provider models:
 *  - with a guard active, `assertDispatchable` runs before EVERY physical
 *    `doGenerate` / `doStream` / `doEmbed`, the SDK's own retries included,
 *    and the guard's abort signal reaches the provider merged with the
 *    caller's;
 *  - a refusal stops the request before it reaches the provider and
 *    surfaces to the caller;
 *  - with no guard, the model is a pure pass-through;
 *  - the guard is read when the request is made, not when the model was
 *    created;
 *  - both factory entry points return guarded models (the aggregate usage
 *    mode included).
 */

import {
	type DispatchGuard,
	isDispatchGuardedModel,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { APICallError, embed, embedMany, generateText, streamText } from "ai";
import {
	MockEmbeddingModelV4,
	MockLanguageModelV4,
	simulateReadableStream,
} from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	wrapEmbeddingModelWithDispatchGuard,
	wrapModelWithDispatchGuard,
} from "../lib/dispatch-guard-middleware";

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const GENERATE_RESULT = {
	content: [{ type: "text" as const, text: "ok" }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

function streamResult() {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
				{ type: "text-start" as const, id: "t1" },
				{ type: "text-delta" as const, id: "t1", delta: "ok" },
				{ type: "text-end" as const, id: "t1" },
				{
					type: "finish" as const,
					finishReason: { unified: "stop" as const, raw: undefined },
					usage: USAGE,
				},
			],
		}),
	};
}

function retryableProviderError() {
	return new APICallError({
		message: "provider overloaded",
		url: "https://provider.example.com/v1",
		requestBodyValues: {},
		statusCode: 503,
		isRetryable: true,
	});
}

class StopError extends Error {
	constructor() {
		super("turn stopped");
		this.name = "StopError";
	}
}

/** A guard whose check passes `allowed` times and refuses after that. */
function makeGuard(options: { allowed?: number; signal?: AbortSignal } = {}) {
	let remaining = options.allowed ?? Number.POSITIVE_INFINITY;
	const assertDispatchable = vi.fn(async () => {
		if (remaining <= 0) {
			throw new StopError();
		}
		remaining -= 1;
	});
	const guard: DispatchGuard = {
		key: "turn-1",
		assertDispatchable,
		abortSignal: () => options.signal,
		rethrowIfStopped: (error) => {
			if (error instanceof StopError) {
				throw error;
			}
		},
	};
	return { guard, assertDispatchable };
}

describe("language models", () => {
	it("checks the guard before each physical doGenerate, the SDK's retry included", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				if (calls === 1) {
					throw retryableProviderError();
				}
				return GENERATE_RESULT;
			},
		});
		const model = wrapModelWithDispatchGuard(provider);
		const { guard, assertDispatchable } = makeGuard();

		const result = await runWithDispatchGuard(guard, () =>
			generateText({ model, prompt: "Hi", maxRetries: 1 }),
		);

		expect(result.text).toBe("ok");
		expect(provider.doGenerateCalls).toHaveLength(2);
		expect(assertDispatchable).toHaveBeenCalledTimes(2);
	});

	it("checks the guard before doStream", async () => {
		const provider = new MockLanguageModelV4({ doStream: streamResult });
		const model = wrapModelWithDispatchGuard(provider);
		const { guard, assertDispatchable } = makeGuard();

		const text = await runWithDispatchGuard(guard, async () => {
			const result = streamText({ model, prompt: "Hi" });
			return result.text;
		});

		expect(text).toBe("ok");
		expect(assertDispatchable).toHaveBeenCalledTimes(1);
		expect(provider.doStreamCalls).toHaveLength(1);
	});

	it("refuses the SDK's retry once the guard refuses, before the provider is called again", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				throw retryableProviderError();
			},
		});
		const model = wrapModelWithDispatchGuard(provider);
		const { guard, assertDispatchable } = makeGuard({ allowed: 1 });

		const error = await runWithDispatchGuard(guard, () =>
			generateText({ model, prompt: "Hi", maxRetries: 2 }),
		).catch((caught: unknown) => caught);

		// The SDK wraps a failure on a retry in a RetryError; the stop is its
		// last error.
		expect(
			(error as { lastError?: unknown }).lastError ?? error,
		).toBeInstanceOf(StopError);
		expect(assertDispatchable).toHaveBeenCalledTimes(2);
		expect(provider.doGenerateCalls).toHaveLength(1);
	});

	it("propagates a refusal of the first request without calling the provider", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const model = wrapModelWithDispatchGuard(provider);
		const { guard } = makeGuard({ allowed: 0 });

		await expect(
			runWithDispatchGuard(guard, () =>
				generateText({ model, prompt: "Hi", maxRetries: 0 }),
			),
		).rejects.toBeInstanceOf(StopError);
		expect(provider.doGenerateCalls).toHaveLength(0);
	});

	it("merges the guard's abort signal with the caller's", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const model = wrapModelWithDispatchGuard(provider);
		const guardController = new AbortController();
		const callerController = new AbortController();
		const { guard } = makeGuard({ signal: guardController.signal });

		await runWithDispatchGuard(guard, () =>
			generateText({
				model,
				prompt: "Hi",
				abortSignal: callerController.signal,
			}),
		);

		const sent = provider.doGenerateCalls[0]?.abortSignal;
		expect(sent).toBeDefined();
		expect(sent?.aborted).toBe(false);
		guardController.abort(new Error("cancelled"));
		expect(sent?.aborted).toBe(true);

		// And the caller's own signal still aborts it.
		const { guard: second } = makeGuard({
			signal: new AbortController().signal,
		});
		const otherCaller = new AbortController();
		await runWithDispatchGuard(second, () =>
			generateText({
				model,
				prompt: "Hi",
				abortSignal: otherCaller.signal,
			}),
		);
		const sentAgain = provider.doGenerateCalls[1]?.abortSignal;
		otherCaller.abort(new Error("deadline"));
		expect(sentAgain?.aborted).toBe(true);
	});

	it("uses the guard's signal when the caller passes none", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const model = wrapModelWithDispatchGuard(provider);
		const controller = new AbortController();
		const { guard } = makeGuard({ signal: controller.signal });

		await runWithDispatchGuard(guard, () =>
			generateText({ model, prompt: "Hi" }),
		);

		expect(provider.doGenerateCalls[0]?.abortSignal).toBe(
			controller.signal,
		);
	});

	it("passes requests through unchanged with no guard active", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const model = wrapModelWithDispatchGuard(provider);
		const callerController = new AbortController();

		const result = await generateText({
			model,
			prompt: "Hi",
			abortSignal: callerController.signal,
		});

		expect(result.text).toBe("ok");
		expect(provider.doGenerateCalls).toHaveLength(1);
	});

	it("reads the guard at request time, not when the model was created", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		// Created outside any guard...
		const model = wrapModelWithDispatchGuard(provider);
		const { guard, assertDispatchable } = makeGuard({ allowed: 0 });

		// ...and used inside one: the guard applies.
		await expect(
			runWithDispatchGuard(guard, () =>
				generateText({ model, prompt: "Hi", maxRetries: 0 }),
			),
		).rejects.toBeInstanceOf(StopError);
		expect(assertDispatchable).toHaveBeenCalledTimes(1);

		// Created inside a guard and used outside it: no guard applies.
		const insideModel = runWithDispatchGuard(guard, () =>
			wrapModelWithDispatchGuard(provider),
		);
		await generateText({ model: insideModel, prompt: "Hi" });
		expect(assertDispatchable).toHaveBeenCalledTimes(1);
	});

	it("marks the model it returns", () => {
		const model = wrapModelWithDispatchGuard(new MockLanguageModelV4());
		expect(isDispatchGuardedModel(model)).toBe(true);
		expect(isDispatchGuardedModel(new MockLanguageModelV4())).toBe(false);
	});
});

describe("embedding models", () => {
	const embedding = (values: string[]) => ({
		embeddings: values.map(() => [0.1, 0.2]),
		usage: { tokens: values.length },
		warnings: [],
	});

	it("checks the guard before each physical doEmbed, the SDK's retry included", async () => {
		let calls = 0;
		const provider = new MockEmbeddingModelV4({
			doEmbed: async ({ values }) => {
				calls += 1;
				if (calls === 1) {
					throw retryableProviderError();
				}
				return embedding(values);
			},
		});
		const model = wrapEmbeddingModelWithDispatchGuard(provider);
		const { guard, assertDispatchable } = makeGuard();

		await runWithDispatchGuard(guard, () =>
			embed({ model, value: "hello", maxRetries: 1 }),
		);

		expect(provider.doEmbedCalls).toHaveLength(2);
		expect(assertDispatchable).toHaveBeenCalledTimes(2);
	});

	it("checks each request an embedMany call is split into", async () => {
		const provider = new MockEmbeddingModelV4({
			maxEmbeddingsPerCall: 1,
			supportsParallelCalls: false,
			doEmbed: async ({ values }) => embedding(values),
		});
		const model = wrapEmbeddingModelWithDispatchGuard(provider);
		const { guard, assertDispatchable } = makeGuard();

		await runWithDispatchGuard(guard, () =>
			embedMany({ model, values: ["a", "b", "c"] }),
		);

		expect(provider.doEmbedCalls).toHaveLength(3);
		expect(assertDispatchable).toHaveBeenCalledTimes(3);
	});

	it("propagates a refusal without calling the provider", async () => {
		const provider = new MockEmbeddingModelV4({
			doEmbed: async ({ values }) => embedding(values),
		});
		const model = wrapEmbeddingModelWithDispatchGuard(provider);
		const { guard } = makeGuard({ allowed: 0 });

		await expect(
			runWithDispatchGuard(guard, () =>
				embed({ model, value: "hello", maxRetries: 0 }),
			),
		).rejects.toBeInstanceOf(StopError);
		expect(provider.doEmbedCalls).toHaveLength(0);
	});

	it("merges the guard's abort signal into the embed request", async () => {
		const provider = new MockEmbeddingModelV4({
			doEmbed: async ({ values }) => embedding(values),
		});
		const model = wrapEmbeddingModelWithDispatchGuard(provider);
		const guardController = new AbortController();
		const callerController = new AbortController();
		const { guard } = makeGuard({ signal: guardController.signal });

		await runWithDispatchGuard(guard, () =>
			embed({
				model,
				value: "hello",
				abortSignal: callerController.signal,
			}),
		);

		const sent = provider.doEmbedCalls[0]?.abortSignal;
		expect(sent?.aborted).toBe(false);
		guardController.abort(new Error("cancelled"));
		expect(sent?.aborted).toBe(true);
	});

	it("passes requests through unchanged with no guard active", async () => {
		const provider = new MockEmbeddingModelV4({
			doEmbed: async ({ values }) => embedding(values),
		});
		const model = wrapEmbeddingModelWithDispatchGuard(provider);

		const result = await embed({ model, value: "hello" });

		expect(result.embedding).toEqual([0.1, 0.2]);
		expect(provider.doEmbedCalls[0]?.abortSignal).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Both factory entry points apply the guard.
// ---------------------------------------------------------------------------

const factory = vi.hoisted(() => ({
	getModel: vi.fn(),
	getEmbeddingModel: vi.fn(),
	getAiProviderApiKey: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: factory.getAiProviderApiKey,
	getAiProviderApiKeyByProvider: vi.fn(),
	getEmbeddingProviderConfig: factory.getEmbeddingProviderConfig,
	getModelForTask: factory.getModelForTask,
	getOrganizationSystemAiProviderApiKey: vi.fn(),
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: factory.getSystemAiProviderApiKey,
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(() => Promise.resolve()),
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

vi.mock("../model-factory", () => ({
	getEmbeddingModel: factory.getEmbeddingModel,
	getEvaluationModel: vi.fn(),
	getModel: factory.getModel,
}));

import {
	getAIEmbeddingModelWithMetadata,
	getAIModelWithMetadata,
} from "../lib/dynamic-model-selector";

const PROVIDER_CONFIG = {
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

describe("factory entry points", () => {
	let languageProvider: MockLanguageModelV4;
	let embeddingProvider: MockEmbeddingModelV4;

	beforeEach(() => {
		vi.clearAllMocks();
		languageProvider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		embeddingProvider = new MockEmbeddingModelV4({
			doEmbed: async ({ values }) => ({
				embeddings: values.map(() => [0.3]),
				usage: { tokens: 1 },
				warnings: [],
			}),
		});
		factory.getModel.mockImplementation(() => languageProvider);
		factory.getEmbeddingModel.mockImplementation(() => embeddingProvider);
		factory.getAiProviderApiKey.mockResolvedValue(PROVIDER_CONFIG);
		factory.getSystemAiProviderApiKey.mockResolvedValue(PROVIDER_CONFIG);
		factory.getEmbeddingProviderConfig.mockResolvedValue({
			...PROVIDER_CONFIG,
			apiKey: null,
			provider: null,
			configId: null,
			source: null,
		});
		factory.getModelForTask.mockResolvedValue({
			model: {
				canonicalName: "example-model",
				capabilities: [],
				contextWindow: 1000,
				maxOutputTokens: 100,
				suitableForTasks: ["CHAT", "EMBEDDING"],
				providerMappings: [
					{
						isAvailable: true,
						provider: "VERCEL_GATEWAY",
						providerModelId: "example/model",
					},
				],
			},
			providerModelId: "example/model",
			source: "org_override",
		});
	});

	const CONTEXT = { userId: "user-1", organizationId: "org-1" };

	it.each([
		["per-call", { taskType: "CHAT" as const }],
		[
			"aggregate",
			{ taskType: "CHAT" as const, usageLogging: "aggregate" as const },
		],
	])(
		"getAIModelWithMetadata (%s usage logging) checks the guard per request",
		async (_mode, options) => {
			const { model } = await getAIModelWithMetadata(options, CONTEXT);
			const { guard, assertDispatchable } = makeGuard({ allowed: 0 });

			await expect(
				runWithDispatchGuard(guard, () =>
					generateText({ model, prompt: "Hi", maxRetries: 0 }),
				),
			).rejects.toBeInstanceOf(StopError);
			expect(assertDispatchable).toHaveBeenCalledTimes(1);
			expect(languageProvider.doGenerateCalls).toHaveLength(0);
		},
	);

	it("getAIEmbeddingModelWithMetadata checks the guard per request", async () => {
		const { model } = await getAIEmbeddingModelWithMetadata(CONTEXT);
		const { guard, assertDispatchable } = makeGuard({ allowed: 0 });

		await expect(
			runWithDispatchGuard(guard, () =>
				embed({ model, value: "hello", maxRetries: 0 }),
			),
		).rejects.toBeInstanceOf(StopError);
		expect(assertDispatchable).toHaveBeenCalledTimes(1);
		expect(embeddingProvider.doEmbedCalls).toHaveLength(0);
	});
});
