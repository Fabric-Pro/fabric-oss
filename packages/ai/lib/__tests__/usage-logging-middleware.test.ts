import { beforeEach, describe, expect, it, vi } from "vitest";

const { logAiUsageAsync } = vi.hoisted(() => ({ logAiUsageAsync: vi.fn() }));
vi.mock("@repo/database", () => ({ logAiUsageAsync }));

import { getEvaluationModel } from "../../model-factory";
import {
	createEmbeddingUsageLoggingMiddleware,
	createUsageLoggingMiddleware,
	describeModelCallError,
	recordAggregateUsage,
	selectAggregateUsageForLogging,
	wrapEvaluationModelWithUsageLogging,
} from "../usage-logging-middleware";

// A real gateway 503 error body (Fizzy #2623): `error` carries the
// user-facing message/type, `providerMetadata.gateway.routing` carries the
// gateway's own attribution of which upstream provider actually failed.
const GATEWAY_ERROR_BODY = {
	error: {
		message: "Service temporarily unavailable. Please try again shortly.",
		type: "service_unavailable_error",
		statusCode: 503,
	},
	providerMetadata: {
		gateway: {
			routing: {
				originalModelId: "typesafe-ai/jev",
				resolvedProvider: "typesafe-ai",
				fallbacksAvailable: [],
				modelAttemptCount: 1,
				totalProviderAttemptCount: 1,
				isRetryable: true,
				attempts: [
					{
						provider: "typesafe-ai",
						statusCode: 503,
						error: "Service temporarily unavailable",
					},
				],
			},
		},
	},
};

/** Build a gateway-shaped error the way `asGatewayError` leaves one: a
 * `GatewayInternalServerError`-like object with `name`/`type`/`isRetryable`
 * set as OWN properties (constructor assignment, not inherited), and `cause`
 * set to the original `@ai-sdk/provider` `APICallError` where the gateway's
 * response body actually lives. */
function buildGatewayShapedError(cause: {
	responseBody?: string;
	data?: unknown;
}): Error {
	return Object.assign(
		new Error("Service temporarily unavailable. Please try again shortly."),
		{
			name: "GatewayInternalServerError",
			statusCode: 503,
			type: "internal_server_error",
			isRetryable: true,
			cause: {
				statusCode: 503,
				responseBody: cause.responseBody,
				data: cause.data,
			},
		},
	);
}

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

	it("records statusCode/details when the stream never opens (Fizzy #2623)", async () => {
		const doStream = vi.fn().mockRejectedValue(
			buildGatewayShapedError({
				responseBody: JSON.stringify(GATEWAY_ERROR_BODY),
			}),
		);
		await expect(mw().wrapStream({ doStream })).rejects.toThrow(
			"Service temporarily unavailable",
		);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg.success).toBe(false);
		expect(arg.errorStatusCode).toBe(503);
		expect(arg.errorDetails).toMatchObject({
			type: "internal_server_error",
			bodyType: "service_unavailable_error",
			routing: expect.objectContaining({
				resolvedProvider: "typesafe-ai",
			}),
		});
	});

	it("records statusCode/details from an in-stream 'error' chunk (Fizzy #2623)", async () => {
		const chunks = [
			{ type: "text-delta", delta: "hi" },
			{
				type: "error",
				error: buildGatewayShapedError({
					responseBody: JSON.stringify(GATEWAY_ERROR_BODY),
				}),
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
		const reader = (stream as ReadableStream).getReader();
		while (true) {
			const { done } = await reader.read();
			if (done) {
				break;
			}
		}
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg.success).toBe(false);
		expect(arg.errorStatusCode).toBe(503);
		expect(arg.errorDetails).toMatchObject({
			type: "internal_server_error",
			bodyType: "service_unavailable_error",
			routing: expect.objectContaining({
				resolvedProvider: "typesafe-ai",
			}),
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

describe("usage-logging middleware — evaluation models", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("preserves metadata exposed by the real gateway evaluation-model factory", () => {
		const model = getEvaluationModel("typesafe-ai/jev", {
			apiKey: "vck_example_tenant_key",
			provider: "VERCEL_GATEWAY",
		});
		const wrapped = wrapEvaluationModelWithUsageLogging(model, CTX);

		expect(wrapped.specificationVersion).toBe(model.specificationVersion);
		expect(wrapped.provider).toBe(model.provider);
		expect(wrapped.modelId).toBe(model.modelId);
		expect(wrapped.supportedQuestionTypes).toEqual(
			model.supportedQuestionTypes,
		);
	});

	it("records successful typed evaluations with decision usage attribution", async () => {
		const doEvaluate = vi.fn().mockResolvedValue({
			answers: {},
			warnings: [],
			usage: { inputTokens: 120, outputTokens: 30 },
			providerMetadata: { gateway: { generationId: "gen_decision_01" } },
		});
		const model = wrapEvaluationModelWithUsageLogging(
			{
				specificationVersion: "v4",
				provider: "vercel-gateway",
				modelId: "typesafe-ai/jev",
				supportedQuestionTypes: ["choice", "score", "boolean"],
				doEvaluate,
			} as any,
			{
				...CTX,
				provider: "VERCEL_GATEWAY" as any,
				providerModelId: "typesafe-ai/jev",
				modelCanonicalName: "typesafe-ai-jev",
				taskType: "DECISION" as any,
			},
		);

		await model.doEvaluate({
			state: "evaluate this choice",
			questions: {
				choice: {
					type: "choice",
					instructions: "Choose one",
					criteria: { yes: "yes", no: "no" },
				},
			},
		});

		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync.mock.calls[0][0]).toMatchObject({
			userId: "u1",
			organizationId: "o1",
			projectId: "p1",
			provider: "VERCEL_GATEWAY",
			providerModelId: "typesafe-ai/jev",
			modelCanonicalName: "typesafe-ai-jev",
			taskType: "DECISION",
			inputTokens: 120,
			outputTokens: 30,
			totalTokens: 150,
			gatewayGenerationId: "gen_decision_01",
			success: true,
		});
	});

	it("records a failed evaluation without marking it successful", async () => {
		const doEvaluate = vi.fn().mockRejectedValue(new Error("gateway down"));
		const model = wrapEvaluationModelWithUsageLogging(
			{
				specificationVersion: "v4",
				provider: "vercel-gateway",
				modelId: "typesafe-ai/jev",
				supportedQuestionTypes: ["choice"],
				doEvaluate,
			} as any,
			{ ...CTX, taskType: "DECISION" as any },
		);

		await expect(
			model.doEvaluate({
				state: "evaluate this choice",
				questions: {
					choice: {
						type: "choice",
						instructions: "Choose one",
						criteria: { yes: "yes", no: "no" },
					},
				},
			}),
		).rejects.toThrow("gateway down");

		expect(logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				taskType: "DECISION",
				success: false,
				errorMessage: "gateway down",
			}),
		);
		// A plain Error carries no HTTP status or gateway body — the ledger row
		// must not fabricate either (Fizzy #2623).
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg.errorStatusCode).toBeUndefined();
		expect(arg.errorDetails).toBeUndefined();
	});

	it("captures the gateway's status code and routing metadata from a responseBody-carrying failure", async () => {
		const doEvaluate = vi.fn().mockRejectedValue(
			buildGatewayShapedError({
				responseBody: JSON.stringify(GATEWAY_ERROR_BODY),
			}),
		);
		const model = wrapEvaluationModelWithUsageLogging(
			{
				specificationVersion: "v4",
				provider: "vercel-gateway",
				modelId: "typesafe-ai/jev",
				supportedQuestionTypes: ["choice"],
				doEvaluate,
			} as any,
			{
				...CTX,
				provider: "VERCEL_GATEWAY" as any,
				providerModelId: "typesafe-ai/jev",
				taskType: "DECISION" as any,
			},
		);

		await expect(
			model.doEvaluate({
				state: "evaluate this choice",
				questions: {
					choice: {
						type: "choice",
						instructions: "Choose one",
						criteria: { yes: "yes", no: "no" },
					},
				},
			}),
		).rejects.toThrow("Service temporarily unavailable");

		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg.success).toBe(false);
		expect(arg.errorStatusCode).toBe(503);
		expect(arg.errorDetails).toMatchObject({
			type: "internal_server_error",
			// The gateway maps the body's own `service_unavailable_error` to a
			// generic `internal_server_error` bucket; `bodyType` keeps the
			// upstream body's real classification from being lost (Fizzy #2623).
			bodyType: "service_unavailable_error",
			isRetryable: true,
			routing: expect.objectContaining({
				resolvedProvider: "typesafe-ai",
			}),
		});
	});

	it("captures the same gateway body when it arrives as cause.data instead of responseBody", async () => {
		const doEvaluate = vi
			.fn()
			.mockRejectedValue(
				buildGatewayShapedError({ data: GATEWAY_ERROR_BODY }),
			);
		const model = wrapEvaluationModelWithUsageLogging(
			{
				specificationVersion: "v4",
				provider: "vercel-gateway",
				modelId: "typesafe-ai/jev",
				supportedQuestionTypes: ["choice"],
				doEvaluate,
			} as any,
			{
				...CTX,
				provider: "VERCEL_GATEWAY" as any,
				providerModelId: "typesafe-ai/jev",
				taskType: "DECISION" as any,
			},
		);

		await expect(
			model.doEvaluate({
				state: "evaluate this choice",
				questions: {
					choice: {
						type: "choice",
						instructions: "Choose one",
						criteria: { yes: "yes", no: "no" },
					},
				},
			}),
		).rejects.toThrow("Service temporarily unavailable");

		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg.errorStatusCode).toBe(503);
		expect(arg.errorDetails).toMatchObject({
			type: "internal_server_error",
			bodyType: "service_unavailable_error",
			isRetryable: true,
			routing: expect.objectContaining({
				resolvedProvider: "typesafe-ai",
			}),
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

describe("usage-logging middleware — failure status code and details (Fizzy #2623)", () => {
	beforeEach(() => logAiUsageAsync.mockReset());

	it("captures statusCode and body-derived details from a bare APICallError-shaped doGenerate failure", async () => {
		const apiCallError = Object.assign(new Error("Too many requests"), {
			statusCode: 429,
			data: { error: { type: "rate_limit", code: "x" } },
		});
		const doGenerate = vi.fn().mockRejectedValue(apiCallError);
		await expect(mw().wrapGenerate({ doGenerate })).rejects.toThrow(
			"Too many requests",
		);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		const arg = logAiUsageAsync.mock.calls[0][0];
		expect(arg.success).toBe(false);
		expect(arg.errorStatusCode).toBe(429);
		expect(arg.errorDetails).toMatchObject({
			type: "rate_limit",
			code: "x",
		});
	});
});

describe("describeModelCallError", () => {
	it("returns only the message for a non-Error, non-object throw", () => {
		expect(describeModelCallError("boom")).toEqual({ message: "boom" });
	});

	it("returns only the message for a plain Error with no gateway/provider shape", () => {
		const described = describeModelCallError(new Error("gateway down"));
		expect(described.message).toBe("gateway down");
		expect(described.statusCode).toBeUndefined();
		expect(described.details).toBeUndefined();
	});

	it("keeps the status code but drops details when responseBody does not parse as JSON", () => {
		const error = Object.assign(new Error("upstream failed"), {
			cause: { statusCode: 502, responseBody: "not-json{" },
		});
		const described = describeModelCallError(error);
		expect(described.statusCode).toBe(502);
		expect(described.details).toBeUndefined();
	});

	it("extracts statusCode and routing from a gateway-shaped error's responseBody", () => {
		const error = buildGatewayShapedError({
			responseBody: JSON.stringify(GATEWAY_ERROR_BODY),
		});
		const described = describeModelCallError(error);
		expect(described.statusCode).toBe(503);
		expect(described.details).toMatchObject({
			name: "GatewayInternalServerError",
			type: "internal_server_error",
			bodyType: "service_unavailable_error",
			isRetryable: true,
			routing: expect.objectContaining({
				resolvedProvider: "typesafe-ai",
			}),
		});
	});

	it("does not invent a status code for a network failure with no HTTP response", () => {
		// The gateway defaults `statusCode` to 500 on the WRAPPER even when the
		// original `APICallError` never received a response (e.g. DNS failure,
		// connection refused) — that 500 is `createGatewayErrorFromResponse`'s
		// own default, not a real HTTP status. `cause` carrying `url` (only set
		// on a genuine `APICallError`) with no `statusCode` of its own must win
		// over the wrapper's invented default.
		const error = Object.assign(new Error("fetch failed"), {
			name: "GatewayInternalServerError",
			statusCode: 500,
			cause: {
				url: "https://gateway.example.com/v1/chat",
				message: "fetch failed",
			},
		});
		const described = describeModelCallError(error);
		expect(described.statusCode).toBeUndefined();
	});

	it("falls back to just the message when reading a property throws", () => {
		const error = new Error("boom");
		Object.defineProperty(error, "cause", {
			get() {
				throw new Error("cause getter exploded");
			},
			configurable: true,
		});
		expect(describeModelCallError(error)).toEqual({ message: "boom" });
	});

	it("never surfaces responseBody, responseHeaders, requestBodyValues, or url in details", () => {
		const error = Object.assign(new Error("boom"), {
			name: "GatewayInternalServerError",
			statusCode: 503,
			type: "internal_server_error",
			isRetryable: true,
			url: "https://gateway.example.com/v1/chat",
			responseHeaders: { "x-request-id": "abc" },
			requestBodyValues: { secret: "shh" },
			cause: {
				statusCode: 503,
				responseBody: JSON.stringify(GATEWAY_ERROR_BODY),
				responseHeaders: { "x-request-id": "abc" },
				requestBodyValues: { secret: "shh" },
			},
		});
		const described = describeModelCallError(error);
		const keys = Object.keys(described.details ?? {});
		const forbidden = [
			"url",
			"responseBody",
			"responseHeaders",
			"requestBodyValues",
		];
		// `arrayContaining` only asserts every LISTED item is present somewhere
		// in `keys` — negating it (`not.toEqual(arrayContaining([...]))`) only
		// fails when ALL four forbidden keys leak, so a single leaked key would
		// pass. Assert the intersection is empty instead.
		expect(keys.filter((key) => forbidden.includes(key))).toEqual([]);
		expect(JSON.stringify(described.details)).not.toContain("shh");
	});
});
