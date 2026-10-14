/**
 * The typed decision model `getAIDecisionModelWithMetadata` returns goes
 * through the same two gates as every language and embedding model the
 * factory returns, when an Advisor chat turn's dispatch guard is active:
 *
 *  - the dispatch guard is checked before each physical `doDecide` (the
 *    SDK's own retries included) and its abort signal is merged into the
 *    request's, alongside the caller's own deadline;
 *  - the turn's token ledger reserves each physical `doDecide` before it is
 *    sent and settles it from the reported usage after: an AUXILIARY
 *    request (`modality: "decision"`), sized by the input estimator and an
 *    output allowance per question (a decision takes no output cap, so it
 *    is not capped and counts as MEASURED_ONLY). A denial sends nothing.
 *
 * Before, the decision model carried usage limits, usage logging and
 * telemetry but neither gate, so story classification with an organization
 * decision model sent (and retried) without any reservation, and its
 * timeout signal ignored the turn's stop.
 *
 * The real factory and the real `experimental_decide`; the gateway decision
 * model and its stores are faked.
 */

import {
	type DispatchBudget,
	type DispatchBudgetRequest,
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { APICallError, experimental_decide } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getAiProviderApiKeyByProvider: vi.fn(),
	getModelForTask: vi.fn(),
	getEvaluationModel: vi.fn(),
	assertWithinAiUsageLimits: vi.fn(),
	doDecide: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: h.getAiProviderApiKeyByProvider,
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: h.getModelForTask,
	getProviderModelIdForCanonical: vi.fn(),
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: vi.fn(),
	updateProviderLastUsed: vi.fn(),
}));
vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: h.assertWithinAiUsageLimits,
	getTenantAiGatewayBillingState: vi.fn(() => ({
		headers: null,
		mode: "external_provider",
	})),
}));
vi.mock("../model-factory", () => ({
	getEmbeddingModel: vi.fn(),
	getEvaluationModel: h.getEvaluationModel,
	getModel: vi.fn(),
}));
vi.mock("../lib/databricks-oauth", () => ({
	hasProviderCredentials: vi.fn(),
	hasServicePrincipalCredentials: vi.fn(),
	resolveProviderApiKey: vi.fn(async () => "vck_example_org_key"),
}));
vi.mock("../lib/chatgpt-plan/pool", () => ({
	chatGptPlanSourceForCall: vi.fn(async () => null),
	sharedPlansSkipMembersMessage: vi.fn(),
}));
vi.mock("../lib/usage-logging", () => ({ getAiBillingCategory: vi.fn() }));
vi.mock("../lib/usage-logging-middleware", () => ({
	recordAggregateUsage: vi.fn(),
	wrapEmbeddingModelWithUsageLogging: vi.fn(),
	wrapEvaluationModelWithUsageLogging: (model: unknown) => model,
	wrapModelWithUsageLogging: vi.fn(),
}));

import { getAIDecisionModelWithMetadata } from "../lib/dynamic-model-selector";

const JEV = {
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

const ANSWER = {
	answers: {
		workItemKind: {
			type: "choice",
			choice: "FEATURE",
			probabilities: { BUG: 0.1, FEATURE: 0.9 },
		},
	},
	usage: { inputTokens: 31, outputTokens: 4 },
	warnings: [],
	response: { modelId: "typesafe-ai/jev" },
};

class BudgetDenied extends Error {}

/** A recording ledger. */
function makeLedger(options: { deny?: boolean } = {}) {
	const events: string[] = [];
	const requests: DispatchBudgetRequest[] = [];
	let seq = 0;
	const budget: DispatchBudget = {
		reserve: vi.fn(async (request: DispatchBudgetRequest) => {
			if (options.deny) {
				throw new BudgetDenied("allowance used");
			}
			seq += 1;
			requests.push(request);
			events.push(`reserve:attempt-${seq}`);
			return { attemptId: `attempt-${seq}`, outputCap: null };
		}),
		settle: vi.fn(async (attemptId, usage) => {
			events.push(
				`settle:${attemptId}:${usage.inputTokens}/${usage.outputTokens}`,
			);
		}),
		markUnknown: vi.fn(async (attemptId) => {
			events.push(`unknown:${attemptId}`);
		}),
		release: vi.fn(async (attemptId) => {
			events.push(`release:${attemptId}`);
		}),
	};
	return { budget, events, requests };
}

function turnGuard(
	budget: DispatchBudget | undefined,
	options: { signal?: AbortSignal; refuse?: Error } = {},
): DispatchGuard {
	return {
		key: "turn-example-1",
		assertDispatchable: async () => {
			if (options.refuse) {
				throw options.refuse;
			}
		},
		abortSignal: () => options.signal,
		rethrowIfStopped: () => undefined,
		...(budget ? { budget } : {}),
	};
}

async function classify(maxRetries = 0) {
	const resolved = await getAIDecisionModelWithMetadata({
		userId: "user-example-1",
		organizationId: "org-example-1",
		projectId: "project-example-1",
	});
	return experimental_decide({
		model: resolved.model,
		state: { reporterText: "Let people save a search." },
		questions: {
			workItemKind: {
				type: "choice",
				instructions: "Choose BUG or FEATURE.",
				criteria: {
					BUG: "An existing behavior is broken.",
					FEATURE: "A requested capability.",
				},
			},
		},
		maxRetries,
		// The caller's own deadline, as classify-work-item sends it.
		abortSignal: AbortSignal.timeout(60_000),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.getAiProviderApiKeyByProvider.mockResolvedValue({
		apiKey: "encrypted:example-org-gateway-key",
		configId: "cfg-example-org",
		provider: "VERCEL_GATEWAY",
		source: "organization",
	});
	h.getModelForTask.mockResolvedValue(JEV);
	h.assertWithinAiUsageLimits.mockResolvedValue(undefined);
	h.doDecide.mockReset();
	h.doDecide.mockResolvedValue(ANSWER);
	h.getEvaluationModel.mockImplementation((modelId: string) => ({
		specificationVersion: "v4",
		provider: "gateway",
		modelId,
		supportedQuestionTypes: ["choice", "score", "boolean"],
		doDecide: h.doDecide,
	}));
});

describe("a native decision call inside a ledgered chat turn", () => {
	it("reserves an AUXILIARY decision attempt before the send and settles it from the reported usage", async () => {
		const { budget, events, requests } = makeLedger();
		h.doDecide.mockImplementation(async () => {
			events.push("send");
			return ANSWER;
		});

		await runWithDispatchGuard(turnGuard(budget), () => classify());

		expect(events).toEqual([
			"reserve:attempt-1",
			"send",
			"settle:attempt-1:31/4",
		]);
		expect(requests[0]).toMatchObject({
			modality: "decision",
			enforcesOutputCap: false,
			modelId: "typesafe-ai/jev",
		});
		// The input is estimated from the state and the questions; the
		// output allowance is the decision's own bound, and a request that
		// cannot get it is refused rather than sent with less.
		expect(requests[0]?.inputEstimate).toBeGreaterThan(0);
		expect(requests[0]?.requestedOutputTokens).toBeGreaterThan(0);
		expect(requests[0]?.minOutputTokens).toBe(
			requests[0]?.requestedOutputTokens,
		);
	});

	it("reserves a fresh attempt for each SDK retry, keeping the failed send charged", async () => {
		const { budget, events } = makeLedger();
		h.doDecide
			.mockRejectedValueOnce(
				new APICallError({
					message: "gateway overloaded",
					url: "https://gateway.example.com/v1/decision-model",
					requestBodyValues: {},
					statusCode: 503,
					isRetryable: true,
				}),
			)
			.mockResolvedValueOnce(ANSWER);

		await runWithDispatchGuard(turnGuard(budget), () => classify(1));

		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"reserve:attempt-2",
			"settle:attempt-2:31/4",
		]);
	});

	it("sends nothing when the ledger denies the request, and fails with the denial", async () => {
		const { budget } = makeLedger({ deny: true });

		const outcome = await runWithDispatchGuard(turnGuard(budget), () =>
			classify(),
		).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(h.doDecide).not.toHaveBeenCalled();
		expect(String((outcome as Error).message)).toContain("allowance used");
	});

	it("sends nothing and reserves nothing when the turn's dispatch check refuses", async () => {
		const { budget } = makeLedger();
		const refusal = new Error("turn stopped");

		await expect(
			runWithDispatchGuard(turnGuard(budget, { refuse: refusal }), () =>
				classify(),
			),
		).rejects.toThrow();

		expect(budget.reserve).not.toHaveBeenCalled();
		expect(h.doDecide).not.toHaveBeenCalled();
	});

	it("aborts the request in flight when the turn stops, though the caller sent its own deadline, and keeps it charged", async () => {
		const { budget, events } = makeLedger();
		const turnStop = new AbortController();
		let sentSignal: AbortSignal | undefined;
		h.doDecide.mockImplementation(
			(options: { abortSignal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					sentSignal = options.abortSignal;
					options.abortSignal?.addEventListener("abort", () =>
						reject(options.abortSignal?.reason),
					);
					turnStop.abort(new Error("turn stopped"));
				}),
		);

		const outcome = await runWithDispatchGuard(
			turnGuard(budget, { signal: turnStop.signal }),
			() => classify(),
		).then(
			() => "resolved",
			(error: unknown) => error,
		);

		expect(sentSignal?.aborted).toBe(true);
		expect(outcome).not.toBe("resolved");
		expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]);
	});

	it("is unchanged outside a chat turn", async () => {
		await expect(classify()).resolves.toMatchObject({
			answers: { workItemKind: { choice: "FEATURE" } },
		});
		expect(h.doDecide).toHaveBeenCalledTimes(1);
	});
});
