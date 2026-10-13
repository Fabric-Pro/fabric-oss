import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionCapture } from "../lib/decision-telemetry";
import { runWithAiJobType } from "../lib/job-context";

const {
	assertWithinAiUsageLimitsMock,
	getAiProviderApiKeyByProviderMock,
	getLanguageModelMock,
	getEvaluationModelMock,
	getModelForTaskMock,
	getTenantAiGatewayBillingStateMock,
	planSourceForCallMock,
	resolveProviderApiKeyMock,
	wrapEvaluationModelWithUsageLoggingMock,
} = vi.hoisted(() => ({
	planSourceForCallMock: vi.fn(),
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

vi.mock("../lib/chatgpt-plan/pool", () => ({
	chatGptPlanSourceForCall: planSourceForCallMock,
	sharedPlansSkipMembersMessage: vi.fn(),
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
		planSourceForCallMock.mockResolvedValue(null);
		getAiProviderApiKeyByProviderMock.mockResolvedValue(
			ORGANIZATION_GATEWAY,
		);
		getModelForTaskMock.mockResolvedValue(JEV_SELECTION);
		resolveProviderApiKeyMock.mockResolvedValue("vck_example_org_key");
		getTenantAiGatewayBillingStateMock.mockReturnValue({
			headers: null,
			mode: "external_provider",
		});
		getEvaluationModelMock.mockReturnValue({
			specificationVersion: "v4",
			provider: "gateway",
			modelId: "typesafe-ai/jev",
			supportedQuestionTypes: ["choice"],
			doDecide: vi.fn(),
		});
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
			expect.objectContaining({ modelId: "typesafe-ai/jev" }),
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

	// Fizzy #2770: a plan that can serve the call beats the organization's
	// gateway; the callers then decide with their language model, on the plan.
	it("defers to the language model when a ChatGPT plan can serve the call", async () => {
		planSourceForCallMock.mockResolvedValue({
			source: {
				kind: "org",
				organizationId: "org-1",
				accountId: "acc-1",
			},
		});

		await expect(
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
				jobType: "meeting-transcript-sync",
			}),
		).rejects.toThrow(AIProviderNotConfiguredError);
		expect(planSourceForCallMock).toHaveBeenCalledWith(
			expect.objectContaining({ jobType: "meeting-transcript-sync" }),
			expect.anything(),
		);
		expect(getAiProviderApiKeyByProviderMock).not.toHaveBeenCalled();
		expect(getEvaluationModelMock).not.toHaveBeenCalled();
	});

	// Fizzy #3033: with every plan spent a decision follows the spend policy
	// for its kind of work, like every other call — the routing answers null
	// only where that policy allows API billing (and audits it).
	it.each([
		["background", { jobType: "meeting-transcript-sync" as const }],
		["interactive", { planEligible: true }],
	])(
		"uses the gateway for %s work when the spend policy allows API billing",
		async (_kind, work) => {
			planSourceForCallMock.mockResolvedValue(null);

			const resolved = await getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
				...work,
			});

			expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
			expect(planSourceForCallMock).toHaveBeenCalledWith(
				expect.objectContaining(work),
				expect.anything(),
			);
		},
	);

	it.each([
		["background", { jobType: "meeting-transcript-sync" as const }],
		["interactive", { planEligible: true }],
	])(
		"refuses %s work with the plan's reset when the spend policy stops it, never billing the gateway",
		async (_kind, work) => {
			const spent = new SubscriptionPlanExhaustedError(
				"Every ChatGPT plan this work may use has no usage left in this window.",
				new Date("2026-10-13T18:00:00Z"),
			);
			planSourceForCallMock.mockRejectedValue(spent);

			await expect(
				getAIDecisionModelWithMetadata({
					userId: "user-1",
					organizationId: "org-1",
					...work,
				}),
			).rejects.toBe(spent);
			expect(getAiProviderApiKeyByProviderMock).not.toHaveBeenCalled();
			expect(getEvaluationModelMock).not.toHaveBeenCalled();
		},
	);

	it("asks about the plan as the job the work runs inside when the call names none", async () => {
		await runWithAiJobType("living-document-refresh", () =>
			getAIDecisionModelWithMetadata({
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
		expect(planSourceForCallMock).toHaveBeenCalledWith(
			expect.objectContaining({ jobType: "living-document-refresh" }),
			expect.anything(),
		);
	});

	it("uses the gateway when the plan lookup itself fails", async () => {
		planSourceForCallMock.mockRejectedValue(new Error("db down"));

		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(resolved.metadata.provider).toBe("VERCEL_GATEWAY");
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

	it("checks only the primary at resolution, then the primary and the fallback, with the same scope, before the call", async () => {
		getModelForTaskMock.mockResolvedValue({
			model: LUNA_MODEL,
			source: "system_default",
		});
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(
			assertWithinAiUsageLimitsMock.mock.calls.map(
				([params]) =>
					(params as { modelCanonicalName: string })
						.modelCanonicalName,
			),
		).toEqual(["gpt-6-luna-decisions"]);
		expect(doDecide).not.toHaveBeenCalled();

		await (resolved.model as any).doDecide(DECIDE_CALL);

		const checked = assertWithinAiUsageLimitsMock.mock.calls.map(
			([params]) => params as { modelCanonicalName: string },
		);
		expect(checked.map((params) => params.modelCanonicalName)).toEqual([
			"gpt-6-luna-decisions",
			"gpt-6-luna-decisions",
			"typesafe-ai-jev",
		]);
		expect(checked[2]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			projectId: null,
			providerConfigId: "cfg-example-org",
			taskType: "DECISION",
		});
		expect(checked[2]).toEqual({
			...checked[1],
			modelCanonicalName: "typesafe-ai-jev",
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
		// The attribution map is built from the full configured list: Jev is
		// only dropped from this call, and may carry a later one.
		expect(wrapEvaluationModelWithUsageLoggingMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{
				answeringModelCanonicalNames: {
					"typesafe-ai/jev": "typesafe-ai-jev",
				},
			},
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

	it("propagates a failure of the fallback's limit check that is not a limit rejection, and dispatches nothing", async () => {
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
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});

		await expect(
			(resolved.model as any).doDecide(DECIDE_CALL),
		).rejects.toThrow("limit store unavailable");
		expect(doDecide).not.toHaveBeenCalled();
	});

	it("checks the limits again on every call of a reused model, so a limit reached mid-run stops the rest", async () => {
		getModelForTaskMock.mockResolvedValue({
			model: LUNA_MODEL,
			source: "system_default",
		});
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});
		await (resolved.model as any).doDecide(DECIDE_CALL);
		expect(doDecide).toHaveBeenCalledOnce();

		exhaustLimitFor("gpt-6-luna-decisions");
		const rejection = await (resolved.model as any)
			.doDecide(DECIDE_CALL)
			.catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(AiUsageLimitExceededError);
		expect(doDecide).toHaveBeenCalledOnce();
	});

	it("drops a fallback whose limit is reached after resolution from the later calls only", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getModelForTaskMock.mockResolvedValue({
			model: LUNA_MODEL,
			source: "system_default",
		});
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});
		await (resolved.model as any).doDecide(DECIDE_CALL);
		exhaustLimitFor("typesafe-ai-jev");
		await (resolved.model as any).doDecide(DECIDE_CALL);

		const sent = doDecide.mock.calls.map(
			([options]) =>
				options as { providerOptions?: { gateway?: unknown } },
		);
		expect(sent[0].providerOptions?.gateway).toEqual({
			models: ["typesafe-ai/jev"],
		});
		expect(sent[1].providerOptions).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("omitting it from this request"),
			expect.objectContaining({
				organizationId: "org-1",
				fallbackCanonicalName: "typesafe-ai-jev",
			}),
		);
		warn.mockRestore();
	});

	it("refuses a blocked call outside the usage-logging wrapper, so it writes no usage row", async () => {
		const loggedDoDecide = vi.fn().mockResolvedValue({
			answers: {},
			warnings: [],
		});
		wrapEvaluationModelWithUsageLoggingMock.mockImplementationOnce(
			(inner: object) => ({
				...inner,
				doDecide: loggedDoDecide,
			}),
		);
		getModelForTaskMock.mockResolvedValue({
			model: LUNA_MODEL,
			source: "system_default",
		});
		const resolved = await getAIDecisionModelWithMetadata({
			userId: "user-1",
			organizationId: "org-1",
		});
		exhaustLimitFor("gpt-6-luna-decisions");

		await expect(
			(resolved.model as any).doDecide(DECIDE_CALL),
		).rejects.toBeInstanceOf(AiUsageLimitExceededError);
		expect(loggedDoDecide).not.toHaveBeenCalled();
		expect(doDecide).not.toHaveBeenCalled();
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

	it("emits no llm.decide span for a call refused by a usage limit", async () => {
		const model = await resolveDecisionModel();
		assertWithinAiUsageLimitsMock.mockRejectedValue(
			new AiUsageLimitExceededError({
				message: "AI usage limit exceeded",
				limitId: "limit-1",
				dimension: "TOKENS" as never,
				window: "MONTHLY" as never,
				used: BigInt(10),
				max: BigInt(10),
				manageLimitsUrl: "https://example.com/limits",
			}),
		);

		await expect(model.doDecide(DECIDE_CALL)).rejects.toBeInstanceOf(
			AiUsageLimitExceededError,
		);

		expect(doDecide).not.toHaveBeenCalled();
		expect(spanExporter.getFinishedSpans()).toHaveLength(0);
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
