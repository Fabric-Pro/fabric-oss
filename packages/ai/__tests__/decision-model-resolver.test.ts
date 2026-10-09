import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionCapture } from "../lib/decision-telemetry";

const {
	assertWithinAiUsageLimitsMock,
	getAiProviderApiKeyByProviderMock,
	getLanguageModelMock,
	getEvaluationModelMock,
	getModelForTaskMock,
	getTenantAiGatewayBillingStateMock,
	resolveProviderApiKeyMock,
	wrapEvaluationModelWithUsageLoggingMock,
} = vi.hoisted(() => ({
	assertWithinAiUsageLimitsMock: vi.fn(),
	getAiProviderApiKeyByProviderMock: vi.fn(),
	getLanguageModelMock: vi.fn(),
	getEvaluationModelMock: vi.fn(),
	getModelForTaskMock: vi.fn(),
	getTenantAiGatewayBillingStateMock: vi.fn(),
	resolveProviderApiKeyMock: vi.fn(),
	wrapEvaluationModelWithUsageLoggingMock: vi.fn((model: unknown) => model),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: getAiProviderApiKeyByProviderMock,
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: getModelForTaskMock,
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(),
}));

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: assertWithinAiUsageLimitsMock,
	getTenantAiGatewayBillingState: getTenantAiGatewayBillingStateMock,
}));

vi.mock("../model-factory", () => ({
	getEmbeddingModel: vi.fn(),
	getEvaluationModel: getEvaluationModelMock,
	getModel: getLanguageModelMock,
}));

vi.mock("../lib/databricks-oauth", () => ({
	hasProviderCredentials: vi.fn(),
	hasServicePrincipalCredentials: vi.fn(),
	resolveProviderApiKey: resolveProviderApiKeyMock,
}));

vi.mock("../lib/usage-logging", () => ({ getAiBillingCategory: vi.fn() }));
vi.mock("../lib/usage-logging-middleware", () => ({
	recordAggregateUsage: vi.fn(),
	wrapEmbeddingModelWithUsageLogging: vi.fn(),
	wrapEvaluationModelWithUsageLogging:
		wrapEvaluationModelWithUsageLoggingMock,
	wrapModelWithUsageLogging: vi.fn(),
}));

import {
	AIProviderNotConfiguredError,
	getAIDecisionModelWithMetadata,
	getAIModel,
	getAIModelWithMetadata,
	resolveModelWithProvider,
} from "../lib/dynamic-model-selector";

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

const JEV_SELECTION = {
	model: {
		canonicalName: "typesafe-ai-jev",
		capabilities: ["EVALUATION"],
		contextWindow: 0,
		maxOutputTokens: null,
		suitableForTasks: ["DECISION"],
		providerMappings: [
			{
				isAvailable: true,
				provider: "VERCEL_GATEWAY",
				providerModelId: "typesafe-ai/jev",
			},
		],
	},
	source: "org_override" as const,
};

describe("getAIDecisionModelWithMetadata", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getAiProviderApiKeyByProviderMock.mockResolvedValue(
			ORGANIZATION_GATEWAY,
		);
		getModelForTaskMock.mockResolvedValue(JEV_SELECTION);
		resolveProviderApiKeyMock.mockResolvedValue("vck_example_org_key");
		getTenantAiGatewayBillingStateMock.mockReturnValue({
			headers: null,
			mode: "external_provider",
		});
		getEvaluationModelMock.mockReturnValue({ type: "evaluation-model" });
	});

	it("uses the organization's Vercel Gateway decision preference even when it is not the text default", async () => {
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(getAiProviderApiKeyByProviderMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			provider: "VERCEL_GATEWAY",
		});
		expect(getModelForTaskMock).toHaveBeenCalledWith(
			"user-1",
			"VERCEL_GATEWAY",
			"DECISION",
			"org-1",
		);
		expect(getEvaluationModelMock).toHaveBeenCalledWith("typesafe-ai/jev", {
			apiKey: "vck_example_org_key",
			provider: "VERCEL_GATEWAY",
			headers: undefined,
		});
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				taskType: "DECISION",
			}),
		);
		expect(wrapEvaluationModelWithUsageLoggingMock).toHaveBeenCalledWith(
			{ type: "evaluation-model" },
			expect.objectContaining({
				organizationId: "org-1",
				provider: "VERCEL_GATEWAY",
				providerModelId: "typesafe-ai/jev",
				taskType: "DECISION",
			}),
			{ answeringModelCanonicalNames: {} },
		);
		expect(resolved.metadata).toMatchObject({
			canonicalName: "typesafe-ai-jev",
			configSource: "organization",
			provider: "VERCEL_GATEWAY",
		});
	});

	it("refuses to resolve without an organization context", async () => {
		await expect(
			getAIDecisionModelWithMetadata({ userId: "user-1" }),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(getAiProviderApiKeyByProviderMock).not.toHaveBeenCalled();
	});

	it("refuses a platform-served gateway key instead of selecting a tenant model", async () => {
		getAiProviderApiKeyByProviderMock.mockResolvedValue({
			...ORGANIZATION_GATEWAY,
			configId: null,
			source: null,
		});

		await expect(
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(getModelForTaskMock).not.toHaveBeenCalled();
		expect(getEvaluationModelMock).not.toHaveBeenCalled();
	});

	it("refuses when the organization has no decision model to resolve", async () => {
		// `getModelForTask` returns null both when nothing is configured and
		// when the organization explicitly switched decisions off. Either way
		// the resolver must throw the configured-provider error, because that
		// is what both production callers (work-item classification and
		// action-item routing) catch to fall back to the language model.
		getModelForTaskMock.mockResolvedValue(null);

		await expect(
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(getEvaluationModelMock).not.toHaveBeenCalled();
		expect(assertWithinAiUsageLimitsMock).not.toHaveBeenCalled();
	});

	it("rejects DECISION before the language-model factory can receive Jev", async () => {
		await expect(
			getAIModel(
				{ taskType: "DECISION" },
				{ userId: "user-1", organizationId: "org-1" },
			),
		).rejects.toThrow(
			"DECISION tasks require a typed evaluation model. Use getAIDecisionModel instead of getAIModel.",
		);

		expect(getLanguageModelMock).not.toHaveBeenCalled();
	});

	it("rejects DECISION through metadata and direct language-resolution entry points", async () => {
		const context = { userId: "user-1", organizationId: "org-1" };

		await expect(
			getAIModelWithMetadata({ taskType: "DECISION" }, context),
		).rejects.toThrow("Use getAIDecisionModel instead of getAIModel.");
		await expect(
			resolveModelWithProvider("DECISION", context),
		).rejects.toThrow("Use getAIDecisionModel instead of getAIModel.");

		expect(getLanguageModelMock).not.toHaveBeenCalled();
	});
});

const LUNA_MODEL = {
	canonicalName: "gpt-6-luna-decisions",
	capabilities: ["EVALUATION"],
	contextWindow: 0,
	maxOutputTokens: null,
	suitableForTasks: ["DECISION"],
	providerMappings: [
		{
			isAvailable: true,
			provider: "VERCEL_GATEWAY",
			providerModelId: "openai/gpt-6-luna-decisions",
		},
	],
};

const DECIDE_CALL = {
	state: "example state",
	questions: {
		kind: {
			type: "choice" as const,
			instructions: "Choose one",
			criteria: { yes: "yes", no: "no" },
		},
	},
};

describe("getAIDecisionModelWithMetadata — gateway fallback from Luna to Jev", () => {
	let doDecide: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		getAiProviderApiKeyByProviderMock.mockResolvedValue(
			ORGANIZATION_GATEWAY,
		);
		resolveProviderApiKeyMock.mockResolvedValue("vck_example_org_key");
		getTenantAiGatewayBillingStateMock.mockReturnValue({
			headers: null,
			mode: "external_provider",
		});
		assertWithinAiUsageLimitsMock.mockReset();
		doDecide = vi.fn().mockResolvedValue({ answers: {}, warnings: [] });
		getEvaluationModelMock.mockImplementation((modelId: string) => ({
			specificationVersion: "v4",
			provider: "gateway",
			modelId,
			supportedQuestionTypes: ["choice", "score", "boolean"],
			doDecide,
		}));
	});

	async function decideWith(selection: {
		model: typeof LUNA_MODEL | typeof JEV_SELECTION.model;
		source: string;
	}) {
		getModelForTaskMock.mockResolvedValue(selection);
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});
		await (
			resolved.model as unknown as {
				doDecide: (options: typeof DECIDE_CALL) => Promise<unknown>;
			}
		).doDecide(DECIDE_CALL);
		return doDecide.mock.calls[0][0] as {
			providerOptions?: { gateway?: { models?: unknown } };
		};
	}

	it("asks the gateway to fall back to Jev when Luna comes from the system default", async () => {
		const sent = await decideWith({
			model: LUNA_MODEL,
			source: "system_default",
		});

		expect(sent.providerOptions?.gateway?.models).toEqual([
			"typesafe-ai/jev",
		]);
		// The usage row follows the model that answered, so the wrapper is
		// told how to attribute a Jev answer.
		expect(wrapEvaluationModelWithUsageLoggingMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				providerModelId: "openai/gpt-6-luna-decisions",
				modelCanonicalName: "gpt-6-luna-decisions",
			}),
			{
				answeringModelCanonicalNames: {
					"typesafe-ai/jev": "typesafe-ai-jev",
				},
			},
		);
	});

	it("sends no cross-vendor fallback when the organization explicitly chose Luna", async () => {
		const sent = await decideWith({
			model: LUNA_MODEL,
			source: "org_override",
		});

		expect(sent.providerOptions?.gateway?.models).toBeUndefined();
	});

	it("sends no fallback when the organization explicitly chose Jev", async () => {
		const sent = await decideWith({
			model: JEV_SELECTION.model,
			source: "org_override",
		});

		expect(sent.providerOptions?.gateway?.models).toBeUndefined();
	});

	function exhaustLimitFor(canonicalName: string) {
		assertWithinAiUsageLimitsMock.mockImplementation(
			async (params: { modelCanonicalName?: string }) => {
				if (params.modelCanonicalName === canonicalName) {
					throw new AiUsageLimitExceededError({
						message: `AI usage limit exceeded for ${canonicalName}`,
						limitId: `limit-${canonicalName}`,
						dimension: "TOKENS" as never,
						window: "MONTHLY" as never,
						used: BigInt(10),
						max: BigInt(10),
						manageLimitsUrl: "https://example.com/limits",
					});
				}
			},
		);
	}

	it("checks the fallback's own usage limits, with the primary's scope, before attaching it", async () => {
		await decideWith({ model: LUNA_MODEL, source: "system_default" });

		const checked = assertWithinAiUsageLimitsMock.mock.calls.map(
			([params]) => params as { modelCanonicalName: string },
		);
		expect(checked.map((params) => params.modelCanonicalName)).toEqual([
			"gpt-6-luna-decisions",
			"typesafe-ai-jev",
		]);
		expect(checked[1]).toMatchObject({
			organizationId: "org-1",
			providerConfigId: "cfg-example-org",
			taskType: "DECISION",
		});
	});

	it("leaves Jev off the request when Jev's HARD limit is exhausted, and still runs Luna", async () => {
		exhaustLimitFor("typesafe-ai-jev");

		const sent = await decideWith({
			model: LUNA_MODEL,
			source: "system_default",
		});

		expect(getEvaluationModelMock).toHaveBeenCalledWith(
			"openai/gpt-6-luna-decisions",
			expect.anything(),
		);
		expect(doDecide).toHaveBeenCalledOnce();
		expect(sent.providerOptions?.gateway?.models).toBeUndefined();
		// Nothing left to attribute a fallback answer to.
		expect(wrapEvaluationModelWithUsageLoggingMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{ answeringModelCanonicalNames: {} },
		);
	});

	it("refuses as before when Luna's own limit is exhausted, without checking or dispatching anything else", async () => {
		exhaustLimitFor("gpt-6-luna-decisions");
		getModelForTaskMock.mockResolvedValue({
			model: LUNA_MODEL,
			source: "system_default",
		});

		await expect(
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toBeInstanceOf(AiUsageLimitExceededError);
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledOnce();
		expect(getEvaluationModelMock).not.toHaveBeenCalled();
	});

	it("propagates a failure of the fallback's limit check that is not a limit rejection", async () => {
		assertWithinAiUsageLimitsMock.mockImplementation(
			async (params: { modelCanonicalName?: string }) => {
				if (params.modelCanonicalName === "typesafe-ai-jev") {
					throw new Error("limit store unavailable");
				}
			},
		);
		getModelForTaskMock.mockResolvedValue({
			model: LUNA_MODEL,
			source: "system_default",
		});

		await expect(
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toThrow("limit store unavailable");
		expect(getEvaluationModelMock).not.toHaveBeenCalled();
	});
});

describe("getAIDecisionModelWithMetadata — decision-call telemetry", () => {
	let spanExporter: InMemorySpanExporter;
	let tracerProvider: BasicTracerProvider;
	let doDecide: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		trace.disable();
		spanExporter = new InMemorySpanExporter();
		tracerProvider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(spanExporter)],
		});
		trace.setGlobalTracerProvider(tracerProvider);
		getAiProviderApiKeyByProviderMock.mockResolvedValue(
			ORGANIZATION_GATEWAY,
		);
		resolveProviderApiKeyMock.mockResolvedValue("vck_example_org_key");
		getTenantAiGatewayBillingStateMock.mockReturnValue({
			headers: null,
			mode: "external_provider",
		});
		assertWithinAiUsageLimitsMock.mockReset();
		getModelForTaskMock.mockResolvedValue({
			model: LUNA_MODEL,
			source: "system_default",
		});
		doDecide = vi.fn().mockResolvedValue({
			answers: {},
			usage: { inputTokens: 31, outputTokens: 4 },
			warnings: [],
			response: { modelId: "typesafe-ai/jev" },
		});
		getEvaluationModelMock.mockImplementation((modelId: string) => ({
			specificationVersion: "v4",
			provider: "gateway",
			modelId,
			supportedQuestionTypes: ["choice", "score", "boolean"],
			doDecide,
		}));
	});

	afterEach(async () => {
		await tracerProvider.shutdown();
		trace.disable();
	});

	async function resolveDecisionModel() {
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			featureKey: "maturation",
			jobType: "meeting-transcript-sync",
		});
		return resolved.model as unknown as {
			doDecide: (options: typeof DECIDE_CALL) => Promise<unknown>;
		};
	}

	it("emits one llm.decide span per doDecide naming the requested and answering model", async () => {
		const model = await resolveDecisionModel();

		await model.doDecide(DECIDE_CALL);

		const spans = spanExporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0].name).toBe("llm.decide");
		expect(spans[0].attributes).toMatchObject({
			"gen_ai.system": "VERCEL_GATEWAY",
			"gen_ai.request.model": "openai/gpt-6-luna-decisions",
			"gen_ai.response.model": "typesafe-ai/jev",
			"gen_ai.usage.input_tokens": 31,
			"gen_ai.usage.output_tokens": 4,
			"fabric.organization.id": "org-1",
			"fabric.project.id": "proj-1",
			"fabric.feature_key": "maturation",
			"fabric.job_type": "meeting-transcript-sync",
			"llm.decision.question_count": 1,
		});
	});

	it("measures the gateway round trip, inside the fallback and usage-logging wrappers", async () => {
		const model = await resolveDecisionModel();

		await model.doDecide(DECIDE_CALL);

		// The span wraps the gateway model itself: the call that reached it
		// already carries the gateway fallback list, and there is exactly one
		// span for the one call.
		const sent = doDecide.mock.calls[0][0] as {
			providerOptions?: { gateway?: { models?: unknown } };
		};
		expect(sent.providerOptions?.gateway?.models).toEqual([
			"typesafe-ai/jev",
		]);
		expect(spanExporter.getFinishedSpans()).toHaveLength(1);
		// Usage logging wraps the telemetry-wrapped model, not the raw one.
		const [loggedModel] =
			wrapEvaluationModelWithUsageLoggingMock.mock.calls[0];
		expect(loggedModel).not.toBe(
			getEvaluationModelMock.mock.results[0].value,
		);
	});

	it("records a gateway failure on the span and rethrows it", async () => {
		const failure = new Error("gateway unavailable");
		doDecide.mockRejectedValue(failure);
		const model = await resolveDecisionModel();

		await expect(model.doDecide(DECIDE_CALL)).rejects.toBe(failure);

		const [span] = spanExporter.getFinishedSpans();
		expect(span.name).toBe("llm.decide");
		expect(span.attributes).toMatchObject({
			"llm.outcome": "error",
			"error.type": "Error",
		});
	});

	it("captures the canonical name of the model that answered, and unknown for an id it does not know", async () => {
		const model = await resolveDecisionModel();
		const answers = [
			"openai/gpt-6-luna-decisions",
			"typesafe-ai/jev",
			"vendor/not-in-the-catalog",
		];
		const labels: Array<string | undefined> = [];
		for (const modelId of answers) {
			doDecide.mockResolvedValueOnce({
				answers: {},
				warnings: [],
				response: { modelId },
			});
			const capture = createDecisionCapture();
			await capture.run(() => model.doDecide(DECIDE_CALL));
			labels.push(capture.answeringModelLabel);
		}

		expect(labels).toEqual([
			"gpt-6-luna-decisions",
			"typesafe-ai-jev",
			"unknown",
		]);
	});
});
