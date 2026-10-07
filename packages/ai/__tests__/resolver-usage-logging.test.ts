/**
 * `getAIModelWithMetadata` hands back a model that records its own usage.
 *
 * In the default `usageLogging: "per-call"` mode the resolver wraps the
 * provider model with `wrapModelWithUsageLogging`, and that wrapper is the
 * only writer of the `AiUsageLog` row for an in-process language-model call:
 * `logModelUsageAsync` is a no-op, and routes such as `/api/ai/generate` write
 * no row of their own (Fizzy #2913). If the resolver stopped wrapping, those
 * calls would record no usage at all and the middleware's own tests, which
 * exercise it directly, would stay green.
 *
 * So these tests run the real resolver, the real middleware and the real
 * `generateText`/`streamText` against a mock provider model, and count the
 * writes at the `@repo/database` boundary. Aggregate mode is pinned too: its
 * caller records one row for a whole turn, so a usage-logged model there
 * would count every step twice.
 */

import { isDispatchGuardedModel } from "@repo/utils/dispatch-guard";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getAiProviderApiKeyMock,
	getModelForTaskMock,
	getModelMock,
	logAiUsageAsyncMock,
} = vi.hoisted(() => ({
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

// The provider factory is the one seam replaced: everything between it and
// the database boundary is the production code path.
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

/**
 * The provider's model id differs from the canonical name on purpose: when a
 * selection carries no `providerModelId`, the resolver falls back to the
 * canonical name, and these rows must show the mapped id was used instead.
 */
const PROVIDER_MODEL_ID = "openai/gpt-4o-mini-2024-07-18";

/** The shape `getModelForTask` returns for an organization's chosen model. */
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

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 4, text: 4, reasoning: 0 },
};

/** The tenant and billing fields every row for this resolution must carry. */
const RESOLVED_ROW_FIELDS = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
	provider: "VERCEL_GATEWAY",
	providerConfigId: "cfg-example-org",
	providerModelId: PROVIDER_MODEL_ID,
	modelCanonicalName: "gpt-4o-mini",
	taskType: "CHAT",
	billingCategory: "EXTERNAL_BYOK",
	billingCustomerId: null,
};

function providerModel() {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: "Hello" }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: USAGE,
			warnings: [],
		}),
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
}

/**
 * A provider stream that delivers some text and then fails before `finish`.
 * Each part is handed out by its own `pull`, and the error comes on the read
 * after the text: erroring inside `start` would discard the queued parts, so
 * the consumer would see the failure before any text.
 */
function streamFailingMidRead() {
	const parts = [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: "partial" },
	];
	return new ReadableStream({
		pull(controller) {
			const next = parts.shift();
			if (next) {
				controller.enqueue(next);
			} else {
				controller.error(new Error("provider connection reset"));
			}
		},
	});
}

/** Read a text stream to its end, returning the text delivered before any failure. */
async function readText(stream: AsyncIterable<string>) {
	let text = "";
	try {
		for await (const delta of stream) {
			text += delta;
		}
	} catch {
		// the failure is what is under test; its row is asserted by the caller
	}
	return text;
}

let model: MockLanguageModelV4;

beforeEach(() => {
	vi.clearAllMocks();
	model = providerModel();
	getModelMock.mockImplementation(() => model);
	getAiProviderApiKeyMock.mockResolvedValue(ORGANIZATION_GATEWAY);
	getModelForTaskMock.mockResolvedValue(SELECTION);
});

describe("getAIModelWithMetadata — per-call usage logging (default)", () => {
	it("records one row with the resolved tenant and billing fields for a generateText call", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		await generateText({ model: resolved.model, prompt: "Hi" });

		expect(getModelMock).toHaveBeenCalledWith(
			PROVIDER_MODEL_ID,
			expect.objectContaining({ provider: "VERCEL_GATEWAY" }),
		);
		expect(logAiUsageAsyncMock).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				...RESOLVED_ROW_FIELDS,
				inputTokens: 10,
				outputTokens: 4,
				totalTokens: 14,
				success: true,
			}),
		);
	});

	it("records one row for a streamText call once the stream finishes", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		const result = streamText({ model: resolved.model, prompt: "Hi" });
		expect(await readText(result.textStream)).toBe("Hello");

		expect(logAiUsageAsyncMock).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				...RESOLVED_ROW_FIELDS,
				inputTokens: 10,
				outputTokens: 4,
				totalTokens: 14,
				success: true,
			}),
		);
	});

	it("records one failed row when the stream errors mid-read", async () => {
		model = new MockLanguageModelV4({
			doStream: async () => ({ stream: streamFailingMidRead() as never }),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		const result = streamText({
			model: resolved.model,
			prompt: "Hi",
			onError: () => {},
		});
		// The text arrived before the failure, so this is a mid-read error,
		// not a stream that failed to open.
		expect(await readText(result.textStream)).toBe("partial");

		expect(logAiUsageAsyncMock).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				...RESOLVED_ROW_FIELDS,
				success: false,
				errorMessage: expect.stringContaining(
					"provider connection reset",
				),
			}),
		);
	});

	it("records one failed row when a generateText call fails", async () => {
		model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("provider unavailable");
			},
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		await expect(
			generateText({
				model: resolved.model,
				prompt: "Hi",
				maxRetries: 0,
			}),
		).rejects.toThrow("provider unavailable");

		expect(logAiUsageAsyncMock).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				...RESOLVED_ROW_FIELDS,
				success: false,
				errorMessage: "provider unavailable",
			}),
		);
	});
});

describe("getAIModelWithMetadata — aggregate usage logging", () => {
	it("returns the provider model without the usage logger, so its calls write no row", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", usageLogging: "aggregate" },
			CONTEXT,
		);

		// Wrapped only in the dispatch guard (a pass-through with no guard
		// active; see dispatch-guard-middleware.test.ts), never in the usage
		// logger: the call reaches the provider model and writes no row.
		expect(isDispatchGuardedModel(resolved.model)).toBe(true);
		await generateText({ model: resolved.model, prompt: "Hi" });
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(logAiUsageAsyncMock).not.toHaveBeenCalled();
	});
});
