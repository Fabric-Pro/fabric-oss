/**
 * Rotation between ChatGPT plans inside one model call (Fizzy #2770), with
 * the real selector, plan model and plan fetch; only OpenAI is simulated, by
 * the 429 `subscription_sharing_usage_limit_exceeded` a spent plan answers.
 *
 * - A spent shared account hands the call to the next one, silently; the
 *   usage row names the account that answered and the spent one stays
 *   closed for every process.
 * - A member's own plan spent mid-call hands it to a shared account that
 *   serves people.
 * - A sign-in rejected mid-call never rotates.
 * - A plan spent after output started ends the stream with
 *   `PlanSourceRotatedError` while another plan remains, and with
 *   `SubscriptionPlanExhaustedError` when none does.
 */

import { metrics, trace } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Account = {
	id: string;
	enabled: boolean;
	status: "ACTIVE";
	serveInteractive: boolean;
	serveBackground: boolean;
};

const state = vi.hoisted(() => ({
	ownUse: null as null | {
		includeBackgroundJobs: boolean;
		credentialStatus: "ACTIVE" | "NEEDS_RECONNECT";
	},
	accounts: [] as Account[],
	usage: new Map<string, number>(),
	rows: new Map<
		string,
		{
			openUntil: Date | null;
			resetAt: Date | null;
			credentialFingerprint?: string | null;
		}
	>(),
	logUsage: vi.fn(),
	limits: vi.fn(),
	authFailure: null as Error | null,
	fallbackModel: null as string | null,
	apiFallbackInteractive: "ASK" as "ASK" | "AUTO",
	orgHasLlm: false,
	apiModel: null as MockLanguageModelV4 | null,
	apiOutputCap: 16384,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: state.limits,
	getTenantAiGatewayBillingState: vi.fn(() => ({
		mode: "external_provider",
		headers: null,
	})),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getModelByCanonicalName: vi.fn(),
	getAiProviderApiKey: async () =>
		state.orgHasLlm ? ORG_PROVIDER : { provider: null },
	getAiProviderApiKeyByProvider: async () =>
		state.orgHasLlm ? ORG_PROVIDER : { provider: null },
	getEmbeddingProviderConfig: vi.fn(),
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(() => Promise.resolve()),
	isFeatureEnabled: async () => true,
	getActiveChatGptPlanOrgUse: async () => state.ownUse,
	hasDeclinedChatGptPlanInOrganization: async () => false,
	getChatGptPlanOrgPolicy: async () => ({
		apiFallbackInteractive: "ASK",
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedById: "owner_1",
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z"),
	}),
	getCachedChatGptPlanOrgPolicy: async () => ({
		apiFallbackInteractive: state.apiFallbackInteractive,
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedById: "owner_1",
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z"),
		fallbackModel: state.fallbackModel,
	}),
	listChatGptPlanOrgAccounts: async () => state.accounts,
	getChatGptPlanOrgAccountWindows: async (params: { accountIds: string[] }) =>
		new Map(
			params.accountIds
				.filter((id) => state.usage.has(id))
				.map((id) => [
					id,
					{
						requests: 1,
						inputTokens: state.usage.get(id),
						weightedInputTokens: state.usage.get(id),
						outputTokens: 0,
						resetsAt: null,
					},
				]),
		),
	getChatGptPlanWindowBudget: async () => 750_000,
	getChatGptPlanWindowBudgets: async (_kind: string, ids: string[]) =>
		new Map(ids.map((id) => [id, 750_000])),
	getChatGptPlanWindowCalibrations: async (_kind: string, ids: string[]) =>
		new Map(ids.map((id) => [id, { budget: 750_000, calibrated: false }])),
	chatGptPlanReportedUsage: () => null,
	getChatGptPlanSourceStates: async (kind: string, ids: string[]) =>
		ids
			.filter((id) => state.rows.has(`${kind}:${id}`))
			.map((id) => ({
				sourceKind: kind,
				sourceId: id,
				consecutiveUnknownResets: 0,
				...state.rows.get(`${kind}:${id}`),
			})),
	recordChatGptPlanSourceExhausted: async (input: {
		sourceKind: string;
		sourceId: string;
		openUntil: Date;
		resetAt: Date | null;
		credentialFingerprint: string | null;
	}) => {
		state.rows.set(`${input.sourceKind}:${input.sourceId}`, {
			openUntil: input.openUntil,
			resetAt: input.resetAt,
			credentialFingerprint: input.credentialFingerprint,
		});
		return true;
	},
	markChatGptPlanSourceAnswered: async () => true,
	getUserModelPreference: async () => null,
	getModelForTask: async (_userId: string, provider: string) =>
		state.orgHasLlm && provider === ORG_PROVIDER.provider
			? {
					...ORG_SELECTION,
					model: {
						...ORG_SELECTION.model,
						maxOutputTokens: state.apiOutputCap,
					},
				}
			: null,
	organizationHasLlmApiProvider: async () => state.orgHasLlm,
	touchChatGptPlanCredential: async () => {},
	touchChatGptPlanOrgAccount: async () => {},
	logAiUsageAsync: state.logUsage,
	recordAudit: vi.fn(),
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	decryptApiKey: (value: string) => value.replace("encrypted:", ""),
}));

// The organization's own provider, standing in for every plan once its
// "Use API billing" policy takes over (Fizzy #3048).
vi.mock("../model-factory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../model-factory")>();
	return {
		...actual,
		getModel: (...args: Parameters<typeof actual.getModel>) =>
			state.apiModel ?? actual.getModel(...args),
	};
});

// The re-read of a plan's model list after it refuses one never reaches
// OpenAI here.
vi.mock("../lib/chatgpt-plan/served-models", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../lib/chatgpt-plan/served-models")
	>()),
	refreshChatGptPlanServedModelsInBackground: vi.fn(),
}));

// Each source's access token names it, so the simulated OpenAI can tell
// which plan a request is billed to.
vi.mock("../lib/chatgpt-plan/plan-credentials", () => {
	const token = (name: string) => {
		if (state.authFailure) {
			throw state.authFailure;
		}
		return {
			accessToken: name,
			expiresAt: new Date(Date.now() + 3_600_000),
			credentialFingerprint: `sign-in-of-${name}`,
		};
	};
	return {
		getChatGptPlanAccessToken: async (userId: string) =>
			token(`user:${userId}`),
		refreshChatGptPlanAfterUnauthorized: async (userId: string) =>
			token(`user:${userId}`),
		getChatGptPlanSourceAccessToken: async (ref: { accountId: string }) =>
			token(`org:${ref.accountId}`),
		refreshChatGptPlanSourceAfterUnauthorized: async (ref: {
			accountId: string;
		}) => token(`org:${ref.accountId}`),
	};
});

import { __resetChatGptPlanBreaker } from "../lib/chatgpt-plan/exhaustion-breaker";
import { ChatGptPlanAuthError } from "../lib/chatgpt-plan/oauth";
import { createChatGptPlanRotationMiddleware } from "../lib/chatgpt-plan/rotation";
import { planSourceKey } from "../lib/chatgpt-plan/sources";
import { __resetChatGptPlanWindowCache } from "../lib/chatgpt-plan/window-cache";
import { getAIModelWithMetadata } from "../lib/dynamic-model-selector";

function sse(events: object[], separateEvents = false): Response {
	const chunks = events.map(
		(event, index) =>
			`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
	);
	const encoder = new TextEncoder();
	const body = separateEvents
		? new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = chunks.shift();
					if (chunk === undefined) {
						controller.close();
					} else {
						controller.enqueue(encoder.encode(chunk));
					}
				},
			})
		: chunks.join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const message = (text: string) => ({
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});

const response = (output: object[], status = "completed") => ({
	id: "resp_1",
	object: "response",
	created_at: 1_790_000_000,
	status,
	model: "gpt-6-astra",
	output,
	incomplete_details: null,
	usage: {
		input_tokens: 10,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 5,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 15,
	},
});

const answered = (text: string) =>
	sse([
		{ type: "response.created", response: response([], "in_progress") },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message(""), status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: message(text),
		},
		{ type: "response.completed", response: response([message(text)]) },
	]);

const SPENT = {
	code: "subscription_sharing_usage_limit_exceeded",
	message: "Usage limit reached",
};

const refusedSpent = () =>
	new Response(JSON.stringify({ error: SPENT }), {
		status: 429,
		headers: { "content-type": "application/json" },
	});

const spentMidReply = () => failedMidReply(SPENT);

const partialReply = () => [
	{ type: "response.created", response: response([], "in_progress") },
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { ...message(""), status: "in_progress", content: [] },
	},
	{
		type: "response.output_text.delta",
		item_id: "msg_1",
		output_index: 0,
		content_index: 0,
		delta: "Half an",
	},
];

const failedEvent = (
	error: { code: string; message: string },
	usage: unknown,
) => ({
	type: "response.failed",
	response: { ...response([], "failed"), error, usage },
});

const failedMidReply = (
	error: { code: string; message: string },
	usage: unknown = response([]).usage,
) => sse([...partialReply(), failedEvent(error, usage)]);

const failedBeforeOutput = (error: { code: string; message: string }) =>
	sse([
		{ type: "response.created", response: response([], "in_progress") },
		{
			type: "response.failed",
			response: { ...response([], "failed"), error },
		},
	]);

const refusedModel = () =>
	new Response(
		JSON.stringify({
			error: {
				message:
					"The model 'gpt-6.2-sol' is not supported on this plan.",
				code: "model_not_found",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);

/**
 * OpenAI, simulated per plan: `replies[token]` answers that plan's calls,
 * given the model each one asks for.
 */
function openai(replies: Record<string, (model: string) => Response>) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			const token =
				new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
			calls.push(token);
			const reply = replies[token];
			if (!reply) {
				throw new Error(`unexpected plan ${token}`);
			}
			const { model } = JSON.parse(String(init?.body ?? "{}")) as {
				model: string;
			};
			return reply(model);
		}),
	);
	return calls;
}

const servedRows = () =>
	state.logUsage.mock.calls
		.map(
			(call: unknown[]) =>
				call[0] as {
					success?: boolean;
					providerConfigId?: string;
					modelCanonicalName?: string;
				},
		)
		.filter((row) => row.success !== false);

const account = (id: string): Account => ({
	id,
	enabled: true,
	status: "ACTIVE",
	serveInteractive: true,
	serveBackground: true,
});

const ORG_PROVIDER = {
	apiKey: "encrypted:example-org-key",
	baseUrl: null,
	clientId: null,
	configId: "cfg_org",
	deploymentName: null,
	enabledProviders: [],
	encryptedClientSecret: null,
	provider: "OPENAI_DIRECT",
	source: "organization" as const,
};

const ORG_SELECTION = {
	model: {
		id: "model_api",
		canonicalName: "gpt-api-model",
		displayName: "GPT API model",
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
	},
	providerModelId: "gpt-api-model",
	source: "org_preference",
};

const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** The organization's provider, answering `text`. */
function apiModel(text: string) {
	return new MockLanguageModelV4({
		provider: "openai",
		modelId: "gpt-api-model",
		doGenerate: async () => ({
			content: [{ type: "text" as const, text }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage,
			warnings: [],
		}),
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					for (const part of [
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "t1" },
						{ type: "text-delta", id: "t1", delta: text },
						{ type: "text-end", id: "t1" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage,
						},
					]) {
						controller.enqueue(part);
					}
					controller.close();
				},
			}),
		}),
	});
}

const ELIGIBLE = {
	userId: "user_1",
	organizationId: "org_a",
	planEligible: true,
};

beforeEach(() => {
	__resetChatGptPlanWindowCache();
	__resetChatGptPlanBreaker();
	vi.clearAllMocks();
	state.ownUse = null;
	state.accounts = [account("acc_A"), account("acc_B")];
	state.usage = new Map([
		["acc_A", 10],
		["acc_B", 20],
	]);
	state.rows = new Map();
	state.authFailure = null;
	state.fallbackModel = null;
	state.apiFallbackInteractive = "ASK";
	state.orgHasLlm = false;
	state.apiModel = null;
	state.apiOutputCap = 16384;
	state.limits.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ChatGPT plan LLM telemetry", () => {
	let exporter: InMemorySpanExporter;
	let tracer: BasicTracerProvider;
	let metricReader: PeriodicExportingMetricReader;
	let meterProvider: MeterProvider;

	beforeEach(() => {
		trace.disable();
		exporter = new InMemorySpanExporter();
		tracer = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		trace.setGlobalTracerProvider(tracer);
		metricReader = new PeriodicExportingMetricReader({
			exporter: new InMemoryMetricExporter(
				AggregationTemporality.CUMULATIVE,
			),
			exportIntervalMillis: 60_000,
		});
		meterProvider = new MeterProvider({ readers: [metricReader] });
		metrics.setGlobalMeterProvider(meterProvider);
	});

	afterEach(async () => {
		await Promise.all([tracer.shutdown(), meterProvider.shutdown()]);
		trace.disable();
		metrics.disable();
	});

	const spans = () =>
		exporter.getFinishedSpans().map((span) => span.attributes);
	const attempt = (
		model: string,
		outcome: "success" | "error",
		provider = "OPENAI_CHATGPT_PLAN",
	) => ({
		"gen_ai.system": provider,
		"gen_ai.request.model": model,
		"llm.outcome": outcome,
		"gen_ai.usage.input_tokens": outcome === "success" ? 10 : 0,
		"gen_ai.usage.output_tokens": outcome === "success" ? 5 : 0,
	});
	const failedPlanAttempt = {
		...attempt("gpt-6.2-sol", "error"),
		"error.type": expect.any(String),
	};
	const failedPlanAttemptWithUsage = {
		...failedPlanAttempt,
		"gen_ai.usage.input_tokens": 10,
		"gen_ai.usage.output_tokens": 5,
	};
	const callsByMode = [
		["generate", generateText],
		["stream", streamText],
	] as const;

	async function metricPoints() {
		const { resourceMetrics } = await metricReader.collect();
		return (name: string) =>
			resourceMetrics.scopeMetrics
				.flatMap((scope) =>
					scope.metrics
						.filter((metric) => metric.descriptor.name === name)
						.flatMap((metric) => metric.dataPoints),
				)
				.map(({ attributes, value }) => ({
					attributes,
					value: typeof value === "number" ? value : value.count,
				}));
	}

	function modelLabels(model = "gpt-6.2-sol") {
		return { provider: "OPENAI_CHATGPT_PLAN", model };
	}

	it.each(callsByMode)(
		"records one plan invocation in %s mode",
		async (_mode, run) => {
			openai({ "org:acc_A": () => answered("Example answer") });
			const { model } = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				ELIGIBLE,
			);
			const result = await run({ model, prompt: "Example prompt" });
			expect(await result.text).toBe("Example answer");
			expect(spans()).toEqual([attempt("gpt-6.2-sol", "success")]);
			const points = await metricPoints();
			expect(points("llm.request.duration")).toEqual([
				{
					attributes: { ...modelLabels(), operation: "chat" },
					value: 1,
				},
			]);
		},
	);

	it.each(callsByMode)(
		"attributes fallback usage to the model that answered in %s mode",
		async (_mode, run) => {
			state.fallbackModel = "gpt-6-astra";
			openai({
				"org:acc_A": (model) =>
					model === "gpt-6.2-sol"
						? failedBeforeOutput({
								code: "model_not_found",
								message: "Example unavailable model",
							})
						: answered("Fallback answer"),
			});
			const { model } = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				ELIGIBLE,
			);
			const result = await run({ model, prompt: "Example prompt" });
			expect(await result.text).toBe("Fallback answer");
			expect(spans()).toEqual([
				failedPlanAttemptWithUsage,
				attempt("gpt-6-astra", "success"),
			]);
			const points = await metricPoints();
			expect(points("llm.request.duration")).toEqual([
				{
					attributes: { ...modelLabels(), operation: "chat" },
					value: 1,
				},
				{
					attributes: {
						...modelLabels("gpt-6-astra"),
						operation: "chat",
					},
					value: 1,
				},
			]);
			expect(points("llm.requests")).toEqual([
				{
					attributes: {
						...modelLabels(),
						operation: "chat",
						status: "error",
					},
					value: 1,
				},
				{
					attributes: {
						...modelLabels("gpt-6-astra"),
						operation: "chat",
						status: "success",
					},
					value: 1,
				},
			]);
			expect(points("llm.tokens")).toEqual([
				{ attributes: { ...modelLabels(), type: "input" }, value: 10 },
				{ attributes: { ...modelLabels(), type: "output" }, value: 5 },
				{
					attributes: {
						...modelLabels("gpt-6-astra"),
						type: "input",
					},
					value: 10,
				},
				{
					attributes: {
						...modelLabels("gpt-6-astra"),
						type: "output",
					},
					value: 5,
				},
			]);
		},
	);

	it("records no invocation for a fallback denied by its usage limit", async () => {
		state.fallbackModel = "gpt-6-astra";
		const calls = openai({ "org:acc_A": refusedModel });
		const { model } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const denied = new Error("Example usage limit");
		state.limits.mockImplementation(async ({ modelCanonicalName }) => {
			if (modelCanonicalName === "gpt-6-astra") {
				throw denied;
			}
		});
		await expect(
			generateText({ model, prompt: "Example prompt", maxRetries: 0 }),
		).rejects.toBe(denied);
		expect(calls).toEqual(["org:acc_A"]);
		expect(spans()).toEqual([failedPlanAttempt]);
	});

	it.each([
		["generate", "early SSE failure", () => failedBeforeOutput(SPENT)],
		["generate", "late SSE failure", spentMidReply],
		["stream", "early SSE failure", () => failedBeforeOutput(SPENT)],
		["stream", "late SSE failure", spentMidReply],
	] as const)(
		"records %s usage for %s without exposing provider data",
		async (mode, _timing, reply) => {
			state.accounts = [account("acc_A")];
			const calls = openai({ "org:acc_A": reply });
			const { model } = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				ELIGIBLE,
			);
			const params = { model, prompt: "Example prompt", maxRetries: 0 };
			if (mode === "generate") {
				await expect(generateText(params)).rejects.toBeInstanceOf(
					SubscriptionPlanExhaustedError,
				);
			} else {
				const onError = vi.fn();
				await streamText({ ...params, onError }).consumeStream();
				expect(onError).toHaveBeenCalledWith({
					error: expect.any(SubscriptionPlanExhaustedError),
				});
			}
			expect(calls).toEqual(["org:acc_A"]);
			expect(spans()).toEqual([failedPlanAttemptWithUsage]);
			const [span] = exporter.getFinishedSpans();
			expect(span.status).not.toHaveProperty("message");
			expect(span.events).toEqual([]);
			const points = await metricPoints();
			const labels = modelLabels();
			expect(points("llm.requests")).toEqual([
				{
					attributes: {
						...labels,
						operation: "chat",
						status: "error",
					},
					value: 1,
				},
			]);
			expect(points("llm.errors")).toEqual([
				{
					attributes: {
						...labels,
						operation: "chat",
						error_type: expect.any(String),
					},
					value: 1,
				},
			]);
			expect(points("llm.tokens")).toEqual([
				{ attributes: { ...labels, type: "input" }, value: 10 },
				{ attributes: { ...labels, type: "output" }, value: 5 },
			]);
			expect(points("llm.request.duration")).toEqual([
				{
					attributes: { ...labels, operation: "chat" },
					value: 1,
				},
			]);
		},
	);

	it("keeps a reported count even when the stream SDK rejects the other count", async () => {
		const calls = openai({
			"org:acc_A": () =>
				failedMidReply(
					{
						code: "invalid_prompt",
						message: "Example private failure",
					},
					{ input_tokens: 7, output_tokens: "5" },
				),
		});
		const { model } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const onError = vi.fn();
		const result = streamText({
			model,
			prompt: "Example prompt",
			maxRetries: 0,
			onError,
		});
		let output = "";
		for await (const part of result.fullStream) {
			if (part.type === "text-delta") {
				output += part.text;
			}
		}
		expect(output).toBe("Half an");
		expect(onError).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["org:acc_A"]);
		expect(spans()).toEqual([
			{ ...failedPlanAttempt, "gen_ai.usage.input_tokens": 7 },
		]);
		const points = await metricPoints();
		expect(points("llm.request.duration")).toEqual([
			{
				attributes: { ...modelLabels(), operation: "chat" },
				value: 1,
			},
		]);
	});

	it.each([
		{
			mode: "stream",
			observed: [{ input_tokens: 7, output_tokens: 3 }],
			input: 7,
			output: 3,
		},
		{
			mode: "stream",
			observed: [
				{ input_tokens: 7, output_tokens: 3 },
				{ input_tokens: 0 },
				{ output_tokens: 4 },
				null,
			],
			input: 0,
			output: 4,
		},
		{
			mode: "generate",
			observed: [{ input_tokens: 7 }, { output_tokens: 3 }, null],
			input: 7,
			output: 3,
		},
	])(
		"records later failure usage in $mode mode ($input input, $output output)",
		async ({ mode, observed, input, output }) => {
			const error = {
				code: "invalid_prompt",
				message: "Example private failure",
			};
			const calls = openai({
				"org:acc_A": () =>
					sse(
						[
							...partialReply(),
							{ type: "error", ...error, param: null },
							...observed.map((usage) =>
								failedEvent(error, usage),
							),
						],
						true,
					),
			});
			const { model } = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				ELIGIBLE,
			);
			const options = { model, prompt: "Example prompt", maxRetries: 0 };
			if (mode === "stream") {
				const onError = vi.fn();
				const result = streamText({ ...options, onError });
				expect(await result.text).toBe("Half an");
				expect(onError).toHaveBeenCalled();
			} else {
				await expect(generateText(options)).rejects.toThrow(
					error.message,
				);
			}
			expect(calls).toEqual(["org:acc_A"]);
			expect(spans()).toEqual([
				{
					...failedPlanAttempt,
					"gen_ai.usage.input_tokens": input,
					"gen_ai.usage.output_tokens": output,
				},
			]);
			const points = await metricPoints();
			expect(points("llm.requests")).toEqual([
				{
					attributes: {
						...modelLabels(),
						operation: "chat",
						status: "error",
					},
					value: 1,
				},
			]);
			expect(points("llm.tokens")).toEqual([
				{
					attributes: { ...modelLabels(), type: "input" },
					value: input,
				},
				{
					attributes: { ...modelLabels(), type: "output" },
					value: output,
				},
			]);
		},
	);

	it("records rotation as one refused and one successful attempt", async () => {
		openai({
			"org:acc_A": () => failedBeforeOutput(SPENT),
			"org:acc_B": () => answered("Next plan"),
		});
		const { model } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model, prompt: "Example prompt" }),
		).resolves.toMatchObject({ text: "Next plan" });
		expect(spans()).toEqual([
			failedPlanAttemptWithUsage,
			attempt("gpt-6.2-sol", "success"),
		]);
	});

	it.each(callsByMode)(
		"records an API billing transfer once under the API provider in %s mode",
		async (mode, run) => {
			state.accounts = [account("acc_A")];
			state.apiFallbackInteractive = "AUTO";
			state.orgHasLlm = true;
			const calls = openai({
				"org:acc_A": () =>
					Response.json(
						{ ...response([]), error: SPENT },
						{ status: 429 },
					),
				"example-org-key": () =>
					mode === "generate"
						? Response.json(response([message("API answer")]))
						: answered("API answer"),
			});
			const { model } = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				ELIGIBLE,
			);
			const result = await run({ model, prompt: "Example prompt" });
			expect(await result.text).toBe("API answer");
			expect(calls).toEqual(["org:acc_A", "example-org-key"]);
			expect(spans()).toEqual([
				failedPlanAttemptWithUsage,
				attempt("gpt-api-model", "success", "OPENAI_DIRECT"),
			]);
		},
	);
});

describe("rotation before any output", () => {
	it("moves a spent shared account's call to the next one, logging the account that answered", async () => {
		const calls = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const result = await generateText({
			model: resolved.model,
			prompt: "Hi",
		});

		expect(result.text).toBe("From B");
		expect(calls).toEqual(["org:acc_A", "org:acc_B"]);
		// A rotation before any output writes exactly one row (Fizzy #2972 AC3).
		expect(state.logUsage).toHaveBeenCalledTimes(1);
		expect(state.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "OPENAI_CHATGPT_PLAN",
				providerConfigId: "acc_B",
			}),
		);
		// Closed for every process, through the shared state.
		expect(state.rows.get("ORG:acc_A")?.openUntil).toBeInstanceOf(Date);
		expect(state.limits).toHaveBeenCalledWith(
			expect.objectContaining({ providerConfigId: "acc_A" }),
		);
	});

	it("sends the next call straight to the open account, from the shared state, after a cache clear", async () => {
		openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await generateText({ model: first.model, prompt: "Hi" });

		__resetChatGptPlanBreaker();
		const calls = openai({ "org:acc_B": () => answered("Again B") });
		const next = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model: next.model, prompt: "Hi" }),
		).resolves.toMatchObject({ text: "Again B" });
		expect(calls).toEqual(["org:acc_B"]);
	});

	it("moves a member's own plan, spent mid-call, to a shared account that serves people", async () => {
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		const calls = openai({
			"user:user_1": refusedSpent,
			"org:acc_A": () => answered("From the shared plan"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const result = await generateText({
			model: resolved.model,
			prompt: "Hi",
		});

		expect(result.text).toBe("From the shared plan");
		expect(calls).toEqual(["user:user_1", "org:acc_A"]);
		// The status the shell's warning reads now sees the own plan spent.
		expect(state.rows.get("USER:user_1")?.openUntil).toBeInstanceOf(Date);
		expect(state.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({ providerConfigId: "acc_A" }),
		);
	});

	it("fails with SubscriptionPlanExhaustedError once every plan is spent", async () => {
		openai({ "org:acc_A": refusedSpent, "org:acc_B": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SubscriptionPlanExhaustedError);
		// Only the failed attempt is recorded; nothing was served.
		expect(state.logUsage).not.toHaveBeenCalledWith(
			expect.objectContaining({ success: true }),
		);
	});

	it("stops, without going round, when the member's own plan and every shared account are spent", async () => {
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		const calls = openai({
			"user:user_1": refusedSpent,
			"org:acc_A": refusedSpent,
			"org:acc_B": refusedSpent,
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(calls).toEqual(["user:user_1", "org:acc_A", "org:acc_B"]);
	});

	it("checks the usage limits of the account it moves to, and stops there when one is reached", async () => {
		const calls = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("must not run"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const limitReached = new Error("token limit reached for this account");
		state.limits.mockImplementation(
			async (input: { providerConfigId: string | null }) => {
				if (input.providerConfigId === "acc_B") {
					throw limitReached;
				}
			},
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBe(limitReached);
		expect(calls).toEqual(["org:acc_A"]);
		expect(state.limits).toHaveBeenLastCalledWith(
			expect.objectContaining({ providerConfigId: "acc_B" }),
		);
	});

	it("never rotates away from a sign-in rejected mid-call", async () => {
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		const calls = openai({ "org:acc_A": () => answered("must not run") });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		state.authFailure = new ChatGptPlanAuthError(
			"Reconnect",
			"needs_reconnect",
			true,
		);
		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ChatGptPlanAuthError);
		expect(calls).toEqual([]);
	});
});

describe("a plan spent after output started", () => {
	async function streamErrors() {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const errors: unknown[] = [];
		const result = streamText({
			model: resolved.model,
			prompt: "Hi",
			onError: ({ error }) => {
				errors.push(error);
			},
		});
		await result.consumeStream();
		return errors;
	}

	it("ends the stream with PlanSourceRotatedError while another plan remains", async () => {
		openai({ "org:acc_A": spentMidReply });
		const errors = await streamErrors();
		const rotated = errors.find(
			(error) => error instanceof PlanSourceRotatedError,
		);
		expect(rotated).toBeInstanceOf(PlanSourceRotatedError);
		expect((rotated as Error).message).toBe(
			"The ChatGPT plan ran out mid-reply. Send your message again to continue on another plan.",
		);
		expect(state.rows.get("ORG:acc_A")?.openUntil).toBeInstanceOf(Date);
		// Bound to the sign-in whose token the cut-off stream used (Fizzy #3037).
		expect(state.rows.get("ORG:acc_A")).toMatchObject({
			credentialFingerprint: "sign-in-of-org:acc_A",
		});

		// The retry lands on the next plan.
		const calls = openai({ "org:acc_B": () => answered("From B") });
		const retry = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model: retry.model, prompt: "Hi" }),
		).resolves.toMatchObject({ text: "From B" });
		expect(calls).toEqual(["org:acc_B"]);

		// Fizzy #2972 AC3: the cut-off attempt is a failed row and the retry a
		// successful one; usage totals count the success only.
		const rows = state.logUsage.mock.calls.map(
			(call: unknown[]) =>
				call[0] as { success?: boolean; providerConfigId?: string },
		);
		expect(rows.filter((row) => row.success !== false)).toEqual([
			expect.objectContaining({ providerConfigId: "acc_B" }),
		]);
		expect(rows.filter((row) => row.success === false)).toEqual([
			expect.objectContaining({ providerConfigId: "acc_A" }),
		]);
	});

	it("ends it with SubscriptionPlanExhaustedError when no plan remains", async () => {
		state.accounts = [account("acc_A")];
		openai({ "org:acc_A": spentMidReply });
		const errors = await streamErrors();
		expect(
			errors.some(
				(error) => error instanceof SubscriptionPlanExhaustedError,
			),
		).toBe(true);
	});
});

describe("per-request usage limits on a reused plan model", () => {
	it("refuses a later request once its account's limit is reached, before anything is sent", async () => {
		const calls = openai({ "org:acc_A": () => answered("From A") });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const limitReached = new Error("token limit reached for this account");
		state.limits.mockImplementation(
			async (input: { providerConfigId: string | null }) => {
				if (input.providerConfigId === "acc_A") {
					throw limitReached;
				}
			},
		);

		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
		}).catch((caught: unknown) => caught);

		expect(error).toBe(limitReached);
		expect(calls).toEqual([]);
		expect(state.logUsage).not.toHaveBeenCalled();
	});

	it("checks each request against the account it starts on, after an earlier request moved to another", async () => {
		let accountASpent = true;
		const calls = openai({
			"org:acc_A": () =>
				accountASpent ? refusedSpent() : answered("From A"),
			"org:acc_B": () => answered("From B"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model: resolved.model, prompt: "first" }),
		).resolves.toMatchObject({ text: "From B" });
		// Resolution and the request's own check on acc_A, then the
		// rotation's check on acc_B.
		expect(
			state.limits.mock.calls.map(
				(call: unknown[]) =>
					(call[0] as { providerConfigId: string | null })
						.providerConfigId,
			),
		).toEqual(["acc_A", "acc_A", "acc_B"]);

		// acc_A has usage again. The same model's next request is sent to
		// acc_A first, so that is the account its check covers.
		accountASpent = false;
		state.rows = new Map();
		__resetChatGptPlanBreaker();
		await expect(
			generateText({ model: resolved.model, prompt: "second" }),
		).resolves.toMatchObject({ text: "From A" });

		expect(calls).toEqual(["org:acc_A", "org:acc_B", "org:acc_A"]);
		expect(state.limits).toHaveBeenCalledTimes(4);
		expect(state.limits).toHaveBeenLastCalledWith(
			expect.objectContaining({ providerConfigId: "acc_A" }),
		);
		// Each request's row names the account that served it (Fizzy #3025).
		expect(servedRows().map((row) => row.providerConfigId)).toEqual([
			"acc_B",
			"acc_A",
		]);
	});
});

describe("rotation state on a reused plan model (Fizzy #3025)", () => {
	it("starts each request with nothing ruled out, so a later rotation can still reach an account an earlier one moved to", async () => {
		let accountASpent = true;
		const calls = openai({
			"org:acc_A": () =>
				accountASpent ? refusedSpent() : answered("From A"),
			"org:acc_B": () => answered("From B"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await generateText({ model: resolved.model, prompt: "first" });

		// acc_A served a request in between, then ran out again.
		accountASpent = false;
		state.rows = new Map();
		__resetChatGptPlanBreaker();
		await generateText({ model: resolved.model, prompt: "second" });
		accountASpent = true;

		await expect(
			generateText({ model: resolved.model, prompt: "third" }),
		).resolves.toMatchObject({ text: "From B" });
		expect(calls).toEqual([
			"org:acc_A",
			"org:acc_B",
			"org:acc_A",
			"org:acc_A",
			"org:acc_B",
		]);
		expect(servedRows().map((row) => row.providerConfigId)).toEqual([
			"acc_B",
			"acc_A",
			"acc_B",
		]);
	});

	it("keeps overlapping requests apart: one moving to another account does not relabel the other", async () => {
		let releaseFirst: () => void = () => {};
		const firstHeld = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let callsToA = 0;
		openai({
			"org:acc_A": () => {
				callsToA++;
				if (callsToA === 1) {
					// The slow request, still on acc_A while the other moves.
					return new Response(
						new ReadableStream({
							async start(controller) {
								await firstHeld;
								const body = await answered("Slow A").text();
								controller.enqueue(
									new TextEncoder().encode(body),
								);
								controller.close();
							},
						}),
						{
							status: 200,
							headers: { "content-type": "text/event-stream" },
						},
					);
				}
				return refusedSpent();
			},
			"org:acc_B": () => answered("From B"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);

		const slow = generateText({ model: resolved.model, prompt: "slow" });
		await vi.waitFor(() => expect(callsToA).toBe(1));
		await expect(
			generateText({ model: resolved.model, prompt: "fast" }),
		).resolves.toMatchObject({ text: "From B" });
		releaseFirst();
		await expect(slow).resolves.toMatchObject({ text: "Slow A" });

		expect(servedRows().map((row) => row.providerConfigId)).toEqual([
			"acc_B",
			"acc_A",
		]);
	});

	it("gives each call through one rotation middleware its own rotation", async () => {
		const spentModel = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new SubscriptionPlanExhaustedError("spent", null);
			},
		});
		const servingModel = new MockLanguageModelV4({
			doGenerate: async () => ({
				content: [{ type: "text" as const, text: "From B" }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: 1,
						cacheRead: 0,
						cacheWrite: 0,
					},
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			}),
		});
		const accountA = {
			kind: "org" as const,
			organizationId: "org_a",
			accountId: "acc_A",
		};
		const accountB = { ...accountA, accountId: "acc_B" };
		const ruledOut: string[][] = [];
		const model = wrapLanguageModel({
			model: spentModel,
			middleware: createChatGptPlanRotationMiddleware({
				source: accountA,
				build: () => servingModel,
				repick: async (exclude) => {
					ruledOut.push([...exclude]);
					return [accountA, accountB].find(
						(source) => !exclude.has(planSourceKey(source)),
					) as typeof accountA;
				},
			}),
		});

		for (const prompt of ["first", "second"]) {
			await expect(
				generateText({ model, prompt, maxRetries: 0 }),
			).resolves.toMatchObject({ text: "From B" });
		}
		expect(ruledOut).toEqual([
			[planSourceKey(accountA)],
			[planSourceKey(accountA)],
		]);
	});

	it("names the account of the turn's latest request on an aggregate usage row", async () => {
		openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", usageLogging: "aggregate" },
			ELIGIBLE,
		);
		await generateText({ model: resolved.model, prompt: "Hi" });
		expect(state.logUsage).not.toHaveBeenCalled();

		resolved.recordAggregateUsage({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			latencyMs: 1,
			success: true,
		});
		expect(state.logUsage).toHaveBeenCalledWith(
			expect.objectContaining({ providerConfigId: "acc_B" }),
		);
	});
});

describe("the plan's fallback model (Fizzy #3026)", () => {
	it("checks the fallback model's usage limits before falling back, and stops there when one is reached", async () => {
		state.fallbackModel = "gpt-6-astra";
		const models: string[] = [];
		const calls = openai({
			"org:acc_A": (model) => {
				models.push(model);
				return model === "gpt-6-astra"
					? answered("must not run")
					: refusedModel();
			},
			"org:acc_B": () => answered("must not run"),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const limitReached = new Error("token limit reached for this model");
		state.limits.mockImplementation(
			async (input: { modelCanonicalName: string }) => {
				if (input.modelCanonicalName === "gpt-6-astra") {
					throw limitReached;
				}
			},
		);

		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
			maxRetries: 0,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(limitReached);
		expect(models).toEqual(["gpt-6.2-sol"]);
		expect(calls).toEqual(["org:acc_A"]);
		expect(state.limits).toHaveBeenLastCalledWith(
			expect.objectContaining({
				providerConfigId: "acc_A",
				modelCanonicalName: "gpt-6-astra",
			}),
		);
		expect(servedRows()).toEqual([]);
	});

	it("names the model that served each request, after an earlier one fell back", async () => {
		state.fallbackModel = "gpt-6-astra";
		let primaryRefused = true;
		openai({
			"org:acc_A": (model) =>
				model === "gpt-6.2-sol" && primaryRefused
					? refusedModel()
					: answered(`From ${model}`),
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model: resolved.model, prompt: "first" }),
		).resolves.toMatchObject({ text: "From gpt-6-astra" });
		primaryRefused = false;
		await expect(
			generateText({ model: resolved.model, prompt: "second" }),
		).resolves.toMatchObject({ text: "From gpt-6.2-sol" });

		expect(servedRows().map((row) => row.modelCanonicalName)).toEqual([
			"gpt-6-astra",
			"gpt-6.2-sol",
		]);
	});
});

describe('plans exhausted mid-turn under "Use API billing" (Fizzy #3048)', () => {
	beforeEach(() => {
		state.accounts = [account("acc_A")];
		state.apiFallbackInteractive = "AUTO";
		state.orgHasLlm = true;
		state.apiModel = apiModel("From the API");
	});

	it.each(["generate", "stream"] as const)(
		"caps an unledgered API handoff during %s",
		async (mode) => {
			state.apiOutputCap = 8192;
			openai({ "org:acc_A": refusedSpent });
			const resolved = await getAIModelWithMetadata(
				{ taskType: "CHAT" },
				ELIGIBLE,
			);
			if (mode === "generate") {
				expect(
					(
						await generateText({
							model: resolved.model,
							prompt: "Example",
							maxOutputTokens: 16384,
						})
					).text,
				).toBe("From the API");
				expect(
					state.apiModel?.doGenerateCalls[0]?.maxOutputTokens,
				).toBe(8192);
			} else {
				expect(
					await streamText({
						model: resolved.model,
						prompt: "Example",
						maxOutputTokens: 16384,
					}).text,
				).toBe("From the API");
				expect(state.apiModel?.doStreamCalls[0]?.maxOutputTokens).toBe(
					8192,
				);
			}
		},
	);

	it("moves a call the last plan refused before any output to the organization's provider, billed there", async () => {
		const calls = openai({ "org:acc_A": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const result = await generateText({
			model: resolved.model,
			prompt: "Hi",
		});

		expect(result.text).toBe("From the API");
		expect(calls).toEqual(["org:acc_A"]);
		expect(resolved.metadata.planSpentApiBilling).toEqual({
			resetAt: null,
		});
		expect(state.logUsage).toHaveBeenCalledTimes(1);
		const row = state.logUsage.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(row).toMatchObject({
			provider: "OPENAI_DIRECT",
			providerConfigId: "cfg_org",
			modelCanonicalName: "gpt-api-model",
		});
		// Priced as the API call it was, not as a plan's free one.
		expect(row.costUsd).toBeUndefined();
	});

	it("sends the turn's later requests straight to the organization's provider", async () => {
		const calls = openai({ "org:acc_A": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await generateText({ model: resolved.model, prompt: "first" });
		await expect(
			generateText({ model: resolved.model, prompt: "second" }),
		).resolves.toMatchObject({ text: "From the API" });

		expect(calls).toEqual(["org:acc_A"]);
		expect(
			state.logUsage.mock.calls.map(
				(call: unknown[]) => (call[0] as { provider: string }).provider,
			),
		).toEqual(["OPENAI_DIRECT", "OPENAI_DIRECT"]);
	});

	it("names the organization's provider on the turn's aggregate row", async () => {
		openai({ "org:acc_A": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", usageLogging: "aggregate" },
			ELIGIBLE,
		);
		const result = streamText({ model: resolved.model, prompt: "Hi" });
		await expect(result.text).resolves.toBe("From the API");
		expect(state.logUsage).not.toHaveBeenCalled();

		resolved.recordAggregateUsage({
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			latencyMs: 1,
			success: true,
		});
		const row = state.logUsage.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(row).toMatchObject({
			provider: "OPENAI_DIRECT",
			providerConfigId: "cfg_org",
		});
		expect(row.costUsd).toBeUndefined();
	});

	it("ends a reply cut off mid-output with PlanSourceRotatedError that points at API billing", async () => {
		openai({ "org:acc_A": spentMidReply });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const errors: unknown[] = [];
		await streamText({
			model: resolved.model,
			prompt: "Hi",
			onError: ({ error }) => {
				errors.push(error);
			},
		}).consumeStream();

		const rotated = errors.find(
			(error) => error instanceof PlanSourceRotatedError,
		);
		expect((rotated as Error | undefined)?.message).toBe(
			"The ChatGPT plans ran out mid-reply. Send your message again to continue on your organization's API billing.",
		);
	});

	it('still stops the call under "Stop and show the reset time"', async () => {
		state.apiFallbackInteractive = "ASK";
		openai({ "org:acc_A": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({
				model: resolved.model,
				prompt: "Hi",
				maxRetries: 0,
			}),
		).rejects.toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(resolved.metadata.planSpentApiBilling).toBeUndefined();
	});

	it("keeps a member's own spent plan off the organization's provider under \"Stop and show the reset time\"", async () => {
		state.apiFallbackInteractive = "ASK";
		state.accounts = [];
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		const calls = openai({ "user:user_1": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({
				model: resolved.model,
				prompt: "Hi",
				maxRetries: 0,
			}),
		).rejects.toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(calls).toEqual(["user:user_1"]);
		expect(
			state.logUsage.mock.calls.some(
				(call: unknown[]) =>
					(call[0] as { provider: string }).provider ===
					"OPENAI_DIRECT",
			),
		).toBe(false);
	});

	it("moves a member's own spent plan to the organization's provider under \"Use API billing\"", async () => {
		state.accounts = [];
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		openai({ "user:user_1": refusedSpent });
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		await expect(
			generateText({ model: resolved.model, prompt: "Hi" }),
		).resolves.toMatchObject({ text: "From the API" });
	});
});

describe("answer route stickiness", () => {
	it("keeps the initial fair-share pick despite changes in relative usage", async () => {
		const calls = openai({
			"org:acc_A": () => answered("From A"),
			"org:acc_B": () => answered("From B"),
		});
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		state.usage = new Map([
			["acc_A", 1000],
			["acc_B", 1],
		]);
		__resetChatGptPlanWindowCache();
		const next = await getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
			ELIGIBLE,
		);
		const result = await generateText({
			model: next.model,
			prompt: "Example",
		});
		expect(result.text).toBe("From A");
		expect(calls).toEqual(["org:acc_A"]);
		expect(next.metadata.answerRouteChanges).toEqual([]);
	});
	it("rotates a disabled account once and records opaque fingerprints", async () => {
		const calls = openai({ "org:acc_B": () => answered("From B") });
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		state.accounts[0].enabled = false;
		const next = await getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
			ELIGIBLE,
		);
		await generateText({ model: next.model, prompt: "Example" });
		const third = await getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: next.metadata.answerSnapshot },
			ELIGIBLE,
		);
		await generateText({ model: third.model, prompt: "Example" });
		expect(calls).toEqual(["org:acc_B", "org:acc_B"]);
		expect(next.metadata.answerRouteChanges).toEqual([
			{
				cause: "plan_account_rotation",
				reason: "account_ineligible",
				from: expect.stringMatching(/^[a-f0-9]{12}$/),
				to: expect.stringMatching(/^[a-f0-9]{12}$/),
			},
		]);
		expect(third.metadata.answerRouteChanges).toEqual([]);
		const { logger } = await import("@repo/logs");
		const logged = vi
			.mocked(logger.info)
			.mock.calls.filter(
				([event]) => event === "advisor.answer_route_change",
			);
		expect(logged).toHaveLength(1);
		expect(JSON.stringify(logged)).not.toContain("acc_A");
		expect(JSON.stringify(logged)).not.toContain("acc_B");
	});
	it("retains a rotation within the same resolved answer model for its next request", async () => {
		const calls = openai({
			"org:acc_A": refusedSpent,
			"org:acc_B": () => answered("From B"),
		});
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const next = await getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
			ELIGIBLE,
		);
		await generateText({ model: next.model, prompt: "Example" });
		await generateText({ model: next.model, prompt: "Example again" });
		expect(calls).toEqual(["org:acc_A", "org:acc_B", "org:acc_B"]);
		expect(next.metadata.answerSnapshot?.planSource).toMatchObject({
			accountId: "acc_B",
		});
		expect(next.metadata.answerRouteChanges).toMatchObject([
			{ cause: "plan_account_rotation", reason: "plan_exhausted" },
		]);
	});
});

it("rechecks a pinned account's eligibility before another request on the same model", async () => {
	const calls = openai({
		"org:acc_A": () => answered("From A"),
		"org:acc_B": () => answered("From B"),
	});
	const first = await getAIModelWithMetadata({ taskType: "CHAT" }, ELIGIBLE);
	const next = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
		ELIGIBLE,
	);
	await generateText({ model: next.model, prompt: "Example" });
	state.accounts[0].enabled = false;
	await generateText({ model: next.model, prompt: "Example again" });
	expect(calls).toEqual(["org:acc_A", "org:acc_B"]);
	expect(next.metadata.answerRouteChanges).toMatchObject([
		{ cause: "plan_account_rotation", reason: "account_ineligible" },
	]);
});

it("records one API-billing handoff and keeps its route for the next round", async () => {
	state.accounts = [account("acc_A")];
	state.orgHasLlm = true;
	state.apiFallbackInteractive = "AUTO";
	state.apiModel = apiModel("API reply");
	const calls = openai({ "org:acc_A": refusedSpent });
	const first = await getAIModelWithMetadata({ taskType: "CHAT" }, ELIGIBLE);
	const next = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
		ELIGIBLE,
	);
	await generateText({ model: next.model, prompt: "Example" });
	expect(next.metadata.answerSnapshot?.provider).toBe("OPENAI_DIRECT");
	expect(next.metadata.answerRouteChanges).toMatchObject([
		{ cause: "api_billing_handoff", reason: "plan_exhausted" },
	]);
	const { logger } = await import("@repo/logs");
	expect(
		vi
			.mocked(logger.info)
			.mock.calls.filter(
				([event]) => event === "advisor.answer_route_change",
			),
	).toHaveLength(1);
	const third = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: next.metadata.answerSnapshot },
		ELIGIBLE,
	);
	await generateText({ model: third.model, prompt: "Example again" });
	expect(third.metadata.answerRouteChanges).toEqual([]);
	expect(calls).toEqual(["org:acc_A"]);
});

it("records the fallback model that serves a forced model refresh", async () => {
	const models: string[] = [];
	openai({
		"org:acc_A": (model) => {
			models.push(model);
			if (model === "gpt-6-astra") {
				return answered("Fallback reply");
			}
			state.fallbackModel = "gpt-6-astra";
			return refusedModel();
		},
	});
	const first = await getAIModelWithMetadata({ taskType: "CHAT" }, ELIGIBLE);
	const next = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
		ELIGIBLE,
	);
	await generateText({ model: next.model, prompt: "Example", maxRetries: 0 });
	expect(models).toEqual(["gpt-6.2-sol", "gpt-6.2-sol", "gpt-6-astra"]);
	expect(next.metadata.answerSnapshot).toMatchObject({
		modelString: "gpt-6-astra",
		reResolved: true,
	});
	await generateText({
		model: next.model,
		prompt: "Example again",
		maxRetries: 0,
	});
	expect(models).toEqual([
		"gpt-6.2-sol",
		"gpt-6.2-sol",
		"gpt-6-astra",
		"gpt-6-astra",
	]);
	expect(next.metadata.answerRouteChanges?.map((c) => c.cause)).toEqual([
		"model_unavailable",
		"plan_model_fallback",
	]);
});

it("checks the serving account's usage limits after an answer has rotated", async () => {
	const calls = openai({
		"org:acc_A": refusedSpent,
		"org:acc_B": () => answered("From B"),
	});
	const first = await getAIModelWithMetadata({ taskType: "CHAT" }, ELIGIBLE);
	const next = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
		ELIGIBLE,
	);
	await generateText({ model: next.model, prompt: "Example" });
	state.limits.mockImplementation(async ({ providerConfigId }) => {
		if (providerConfigId === "acc_A") {
			throw new Error("Retired account limit");
		}
	});
	await expect(
		generateText({ model: next.model, prompt: "Example again" }),
	).resolves.toMatchObject({ text: "From B" });
	expect(calls).toEqual(["org:acc_A", "org:acc_B", "org:acc_B"]);
	state.limits.mockImplementation(async ({ providerConfigId }) => {
		if (providerConfigId === "acc_B") {
			throw new Error("Serving account limit");
		}
	});
	await expect(
		generateText({ model: next.model, prompt: "Example denied" }),
	).rejects.toThrow("Serving account limit");
	expect(calls).toEqual(["org:acc_A", "org:acc_B", "org:acc_B"]);
});

it.each([false, true])(
	"refuses an own-plan disconnect mid-answer (shared pool=%s)",
	async (shared) => {
		const { ChatGptPlanAuthError } = await import(
			"../lib/chatgpt-plan/oauth"
		);
		state.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		state.accounts = shared ? [account("acc_A")] : [];
		state.orgHasLlm = true;
		state.apiFallbackInteractive = "AUTO";
		state.apiModel = apiModel("Unapproved API reply");
		const calls = openai({
			"user:user_1": () => answered("Own reply"),
			"org:acc_A": () => answered("Unapproved shared reply"),
		});
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			ELIGIBLE,
		);
		const current = await getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
			ELIGIBLE,
		);
		await generateText({ model: current.model, prompt: "Example" });
		state.ownUse.credentialStatus = "NEEDS_RECONNECT";
		await expect(
			generateText({
				model: current.model,
				prompt: "Example again",
				maxRetries: 0,
			}),
		).rejects.toBeInstanceOf(ChatGptPlanAuthError);
		await expect(
			getAIModelWithMetadata(
				{
					taskType: "CHAT",
					answerSnapshot: current.metadata.answerSnapshot,
				},
				ELIGIBLE,
			),
		).rejects.toBeInstanceOf(ChatGptPlanAuthError);
		expect(calls).toEqual(["user:user_1"]);
		expect(state.apiModel.doGenerateCalls).toHaveLength(0);
		expect(current.metadata.planSpentApiBilling).toBeUndefined();
		expect(current.metadata.answerRouteChanges).toEqual([]);
	},
);
