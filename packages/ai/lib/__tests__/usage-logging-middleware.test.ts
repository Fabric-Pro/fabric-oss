import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync } = vi.hoisted(() => ({ logAiUsageAsync: vi.fn() }));
vi.mock("@repo/database", () => ({ logAiUsageAsync }));

import {
	createEmbeddingUsageLoggingMiddleware,
	createUsageLoggingMiddleware,
	recordAggregateUsage,
	selectAggregateUsageForLogging,
} from "../usage-logging-middleware";

const CTX = {
	userId: "u1",
	organizationId: "o1",
	projectId: "p1",
	provider: "ANTHROPIC_DIRECT" as any,
	providerModelId: "anthropic/claude-sonnet-4",
	modelCanonicalName: "claude-sonnet-4",
	taskType: "COMPLEX" as any,
};

// The middleware is returned cast to the SDK type; access its hooks at runtime.
function mw() {
	return createUsageLoggingMiddleware(CTX) as any;
}

describe("usage-logging middleware — wrapGenerate", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("logs one row with the full token breakdown, including cache reads/writes", async () => {
		// AI SDK 7's top-level `LanguageModelUsage`: flat totals with the cache
		// and reasoning splits under `inputTokenDetails`/`outputTokenDetails`.
		// The 6.x names this fixture used before — a flat `cachedInputTokens`
		// and `providerMetadata.anthropic.cacheCreationInputTokens` — no longer
		// exist; `@ai-sdk/anthropic` 4 folds the cache-write count into usage
		// itself, so provider metadata is no longer a token source at all.
		const doGenerate = vi.fn().mockResolvedValue({
			usage: {
				inputTokens: 100,
				inputTokenDetails: {
					noCacheTokens: 0,
					cacheReadTokens: 80,
					cacheWriteTokens: 20,
				},
				outputTokens: 40,
				outputTokenDetails: { textTokens: 40, reasoningTokens: 0 },
				totalTokens: 140,
			},
		});
		const result = await mw().wrapGenerate({ doGenerate });
		expect(result).toBeDefined();
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg).toMatchObject({
			userId: "u1",
			organizationId: "o1",
			projectId: "p1",
			providerModelId: "anthropic/claude-sonnet-4",
			inputTokens: 100,
			outputTokens: 40,
			totalTokens: 140,
			cachedInputTokens: 80,
			cacheCreationInputTokens: 20,
			success: true,
		});
	});

	it("skips a genuinely zero-token result (no billing signal)", async () => {
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		});
		await mw().wrapGenerate({ doGenerate });
		expect(logAiUsageAsync).not.toHaveBeenCalled();
	});

	it("records a failure marker and rethrows when the call throws", async () => {
		const doGenerate = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(mw().wrapGenerate({ doGenerate })).rejects.toThrow("boom");
		// FR7 (#1894): the failure must be visible in the ledger even though the
		// SDK surfaces no usage for a thrown call.
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg).toMatchObject({
			success: false,
			errorMessage: "boom",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		});
	});

	it("still skips a zero-token SUCCESS row as noise", async () => {
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		});
		await mw().wrapGenerate({ doGenerate });
		expect(logAiUsageAsync).not.toHaveBeenCalled();
	});

	// (Logging resilience — a synchronous throw or rejected promise from
	// logAiUsageAsync never breaking the model call — is implemented via emit's
	// try/catch + promise .catch, but asserting it here fights vitest's global
	// mock-error handler, so it's covered by code review rather than a unit test.)
});

describe("usage-logging middleware — wrapStream", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("logs once on the stream's finish chunk", async () => {
		const chunks = [
			{ type: "text-delta", delta: "hi" },
			{
				type: "finish",
				usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
			},
		];
		const doStream = vi.fn().mockResolvedValue({
			stream: new ReadableStream({
				start(controller) {
					for (const c of chunks) {
						controller.enqueue(c);
					}
					controller.close();
				},
			}),
		});
		const { stream } = await mw().wrapStream({ doStream });
		// drain the tapped stream
		const reader = (stream as ReadableStream).getReader();
		while (true) {
			const { done } = await reader.read();
			if (done) {
				break;
			}
		}
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			inputTokens: 200,
			outputTokens: 30,
			totalTokens: 230,
			success: true,
		});
	});
});

describe("usage-logging middleware — wrapEmbed (embeddings)", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("logs embedding tokens as inputTokens (0 output)", async () => {
		const emw = createEmbeddingUsageLoggingMiddleware({
			...CTX,
			taskType: "EMBEDDING" as any,
		}) as any;
		const doEmbed = vi
			.fn()
			.mockResolvedValue({ embeddings: [[0.1]], usage: { tokens: 123 } });
		await emw.wrapEmbed({ doEmbed });
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			inputTokens: 123,
			outputTokens: 0,
			totalTokens: 123,
		});
	});
});

describe("usage-logging middleware — gateway generationId capture", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("captures providerMetadata.gateway.generationId", async () => {
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			providerMetadata: { gateway: { generationId: "gen_01ABC" } },
		});
		await mw().wrapGenerate({ doGenerate });
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			gatewayGenerationId: "gen_01ABC",
		});
	});

	it("passes undefined generationId for non-gateway responses", async () => {
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			providerMetadata: { anthropic: {} },
		});
		await mw().wrapGenerate({ doGenerate });
		expect(
			logAiUsageAsync.mock.calls[0][0].gatewayGenerationId,
		).toBeUndefined();
	});
});

describe("usage-logging middleware — aggregate stream usage", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("writes one multi-step aggregate row with cache and reasoning fields but no step generation ID", () => {
		recordAggregateUsage(CTX, {
			usage: {
				inputTokens: 300,
				outputTokens: 80,
				totalTokens: 380,
				inputTokenDetails: {
					cacheReadTokens: 120,
					cacheWriteTokens: 60,
				},
				outputTokenDetails: { reasoningTokens: 25 },
			},
			latencyMs: 42,
			success: true,
			steps: [
				{
					providerMetadata: {
						gateway: { generationId: "gen_step_1" },
					},
				},
				{
					providerMetadata: {
						gateway: { generationId: "gen_step_2" },
					},
				},
			],
		});

		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			inputTokens: 300,
			outputTokens: 80,
			totalTokens: 380,
			cachedInputTokens: 120,
			cacheCreationInputTokens: 60,
			reasoningTokens: 25,
			gatewayGenerationId: undefined,
		});
	});

	it("keeps a reliably single-step gateway generation ID", () => {
		recordAggregateUsage(CTX, {
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			latencyMs: 42,
			success: true,
			steps: [
				{
					providerMetadata: {
						gateway: { generationId: "gen_single" },
					},
				},
			],
		});

		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			gatewayGenerationId: "gen_single",
		});
	});

	it("uses the Direct Chat estimate when a successful SDK aggregate has no tokens", () => {
		const usage = selectAggregateUsageForLogging(
			{ inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			{
				inputTokens: 250,
				outputTokens: 75,
				totalTokens: 325,
			},
		);

		recordAggregateUsage(CTX, {
			usage,
			latencyMs: 42,
			success: true,
		});

		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			inputTokens: 250,
			outputTokens: 75,
			totalTokens: 325,
			success: true,
		});
	});
});

describe("usage-logging middleware — feature attribution", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("forwards featureKey and promptVersionId onto the usage row", async () => {
		const middleware = createUsageLoggingMiddleware({
			...CTX,
			featureKey: "answer-recommendation",
			promptVersionId: "pv_123",
		}) as any;
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});
		await middleware.wrapGenerate({ doGenerate });
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			featureKey: "answer-recommendation",
			promptVersionId: "pv_123",
		});
	});

	it("leaves both undefined for an untagged call site", async () => {
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});
		await mw().wrapGenerate({ doGenerate });
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg.featureKey).toBeUndefined();
		expect(arg.promptVersionId).toBeUndefined();
	});
});

describe("usage-logging middleware — job attribution", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("forwards jobType onto the usage row for background pipelines", async () => {
		const middleware = createUsageLoggingMiddleware({
			...CTX,
			jobType: "daily-brief",
		}) as any;
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});
		await middleware.wrapGenerate({ doGenerate });
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			jobType: "daily-brief",
		});
	});

	it("forwards jobType from the embedding interceptor", async () => {
		const emw = createEmbeddingUsageLoggingMiddleware({
			...CTX,
			taskType: "EMBEDDING" as any,
			jobType: "meeting-transcript-sync",
		}) as any;
		const doEmbed = vi
			.fn()
			.mockResolvedValue({ embeddings: [[0.1]], usage: { tokens: 50 } });
		await emw.wrapEmbed({ doEmbed });
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			jobType: "meeting-transcript-sync",
		});
	});

	it("leaves jobType undefined for user-initiated calls", async () => {
		const doGenerate = vi.fn().mockResolvedValue({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});
		await mw().wrapGenerate({ doGenerate });
		expect(logAiUsageAsync.mock.calls[0][0].jobType).toBeUndefined();
	});
});
