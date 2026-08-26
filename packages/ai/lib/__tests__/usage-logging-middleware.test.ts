import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync } = vi.hoisted(() => ({ logAiUsageAsync: vi.fn() }));
vi.mock("@repo/database", () => ({ logAiUsageAsync }));

import {
	createEmbeddingUsageLoggingMiddleware,
	createUsageLoggingMiddleware,
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
		const doGenerate = vi.fn().mockResolvedValue({
			usage: {
				inputTokens: 100,
				outputTokens: 40,
				totalTokens: 140,
				cachedInputTokens: 80,
			},
			providerMetadata: { anthropic: { cacheCreationInputTokens: 20 } },
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
