/**
 * OpenTelemetry for AI decision calls (`experimental_decide`).
 *
 * Two layers, both built on Fabric's own span and metric code rather than the
 * AI SDK's telemetry option, so no prompt, decision state, question, answer
 * text or error message can reach an exporter:
 *
 * 1. `wrapDecisionModelWithTelemetry` opens one `llm.decide` span per
 *    `doDecide` round trip: latency, requested vs answering model, token
 *    usage, number of questions and number of per-question refusals.
 * 2. `recordDecisionOutcome` is called by each decision call site after it has
 *    decided whether to use the answer, and records the outcome and the
 *    confidence so the rate of language-model fallback can be compared
 *    between decision models.
 *
 * Only identifiers, model ids, counts, numbers, enums and error class names
 * are ever recorded. `organizationId` is a span attribute only, never a metric
 * label.
 *
 * Every metric label value, and `gen_ai.response.model`, comes from a finite
 * set Fabric controls: fixed site names, a closed outcome enum, the requested
 * model from the catalog, and the answering model only when it is the
 * requested model or a known gateway fallback (anything else is `unknown`). A
 * string a provider supplies is never passed through.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { llmInstrumentation } from "@repo/observability/llm";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import {
	Experimental_DecisionRefusalError,
	InvalidResponseDataError,
} from "ai";
import { SYSTEM_DEFAULT_DECISION_FALLBACKS } from "./decision-model-fallback";
import type { DecisionModelInstance } from "./usage-logging-middleware";

export interface DecisionTelemetryContext {
	/** Provider enum value, for example `VERCEL_GATEWAY`. */
	provider: string;
	/** Provider model id that was requested. */
	requestModelId: string;
	/** Catalog canonical name of the requested model; used as the metric label. */
	requestModelLabel?: string;
	/** Opaque id; span attribute only. */
	organizationId?: string;
	projectId?: string;
	featureKey?: string;
	jobType?: string;
}

/** Label for a model that is neither the requested model nor a known fallback. */
const UNKNOWN_MODEL = "unknown";

interface AnsweringModel {
	/** Provider model id, or `unknown`. Safe for `gen_ai.response.model`. */
	id: string;
	/** Catalog canonical name, or `unknown`. Safe as a metric label. */
	label: string;
}

/**
 * Map the model id a response names onto the finite set Fabric controls: the
 * requested model, or a known gateway fallback. Anything else, including any
 * string a provider echoes into the field, becomes `unknown`.
 */
function allowedAnsweringModel(
	requested: { id?: string | null; label: string },
	answeringId: unknown,
): AnsweringModel | undefined {
	if (typeof answeringId !== "string" || !answeringId) {
		return undefined;
	}
	if (requested.id && answeringId === requested.id) {
		return { id: requested.id, label: requested.label };
	}
	for (const fallbacks of Object.values(SYSTEM_DEFAULT_DECISION_FALLBACKS)) {
		const match = fallbacks.find(
			(fallback) => fallback.providerModelId === answeringId,
		);
		if (match) {
			return { id: match.providerModelId, label: match.canonicalName };
		}
	}
	return { id: UNKNOWN_MODEL, label: UNKNOWN_MODEL };
}

interface CaptureState {
	/** Metric label of the model that answered the latest `doDecide`. */
	answeringModelLabel?: string;
}

const captureStorage = new AsyncLocalStorage<CaptureState>();

/**
 * Request-scoped record of which model answered a decision call, for the case
 * where `experimental_decide` throws after `doDecide` returned (for example a
 * gateway fallback model that refuses) and the call site has no result.
 *
 * `run` binds the capture to the async context of one `experimental_decide`
 * call through AsyncLocalStorage, so concurrent decisions each see only their
 * own model. There is no module-level state. The latest `doDecide` wins, which
 * covers SDK retries.
 */
export interface DecisionCapture {
	run<T>(fn: () => T): T;
	/** Canonical label of the answering model, once a `doDecide` has returned. */
	readonly answeringModelLabel: string | undefined;
}

export function createDecisionCapture(): DecisionCapture {
	const state: CaptureState = {};
	return {
		run: (fn) => captureStorage.run(state, fn),
		get answeringModelLabel() {
			return state.answeringModelLabel;
		},
	};
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function countQuestions(callOptions: unknown): number | undefined {
	const questions = (callOptions as { questions?: unknown } | undefined)
		?.questions;
	return questions && typeof questions === "object"
		? Object.keys(questions).length
		: undefined;
}

function countRefusals(answers: unknown): number | undefined {
	if (!answers || typeof answers !== "object") {
		return undefined;
	}
	let refusals = 0;
	for (const answer of Object.values(answers)) {
		if ((answer as { type?: unknown } | null)?.type === "refusal") {
			refusals += 1;
		}
	}
	return refusals;
}

/**
 * Decision-model counterpart of `createLLMTelemetryMiddleware`. Decision
 * models expose `doDecide` directly instead of supporting the SDK's generic
 * model middleware, so wrap that one network boundary. Telemetry never throws
 * into or changes the model call.
 */
export function wrapDecisionModelWithTelemetry(
	model: DecisionModelInstance,
	context: DecisionTelemetryContext,
): DecisionModelInstance {
	if (typeof model?.doDecide !== "function") {
		// Not a decision model this wrapper can observe; never break resolution.
		return model;
	}
	const doDecide = model.doDecide.bind(model);

	return {
		// GatewayDecisionModel exposes `provider` through a prototype getter, so
		// copy each contract field explicitly rather than spreading the instance.
		specificationVersion: model.specificationVersion,
		provider: model.provider,
		modelId: model.modelId,
		supportedQuestionTypes: model.supportedQuestionTypes,
		doDecide: async (callOptions) => {
			let capture: CaptureState | undefined;
			try {
				capture = captureStorage.getStore();
				if (capture) {
					// The latest round trip decides the label; a retry that fails
					// before answering must not inherit an earlier attempt's model.
					capture.answeringModelLabel = undefined;
				}
			} catch {
				capture = undefined;
			}
			const invocation = llmInstrumentation.startInvocation({
				provider: context.provider,
				model: context.requestModelId,
				operation: "decide",
				context: {
					organizationId: context.organizationId,
					projectId: context.projectId,
					featureKey: context.featureKey,
					jobType: context.jobType,
					questionCount: countQuestions(callOptions),
				},
			});
			let result: Awaited<ReturnType<typeof doDecide>>;
			try {
				result = await doDecide(callOptions);
			} catch (error) {
				invocation.fail(error);
				throw error;
			}
			try {
				const answering = allowedAnsweringModel(
					{
						id: context.requestModelId,
						label:
							context.requestModelLabel ?? context.requestModelId,
					},
					result.response?.modelId,
				);
				if (capture) {
					capture.answeringModelLabel = answering?.label;
				}
				invocation.succeed(
					{
						inputTokens: finiteNonNegative(
							result.usage?.inputTokens,
						),
						outputTokens: finiteNonNegative(
							result.usage?.outputTokens,
						),
					},
					{
						responseModel: answering?.id,
						refusalCount: countRefusals(result.answers),
					},
				);
			} catch {
				// Telemetry is best-effort and never changes an answer.
			}
			return result;
		},
	};
}

/** The decision call sites. A closed set, so the `site` label is bounded. */
export const DECISION_SITES = [
	"classify-work-item",
	"delivery-track",
	"backlog-routing",
	"link-action-items",
	"question-topics",
] as const;

export type DecisionSite = (typeof DECISION_SITES)[number];

function boundedSite(site: unknown): string {
	return (DECISION_SITES as readonly unknown[]).includes(site)
		? (site as DecisionSite)
		: UNKNOWN_MODEL;
}

/** Closed set of ways a decision call site can end. */
export type DecisionOutcome =
	/** The typed decision was used. */
	| "accepted"
	/** A readable answer was under the confidence floor; the fallback ran. */
	| "below_threshold"
	/** The answer was missing, unreadable or named something outside the options; the fallback ran. */
	| "malformed"
	/** The model refused at least one question; the fallback ran. */
	| "refused"
	/** Any other decision error; the fallback ran. */
	| "failed"
	/** A usage limit stopped the call; no fallback was attempted. */
	| "limit_exceeded"
	/** No decision model was resolved; the fallback ran. */
	| "unavailable";

/** Metric label used when no decision model was resolved. */
const NO_DECISION_MODEL_LABEL = "none";

type DecisionModelRef = {
	metadata?: {
		modelString?: string | null;
		canonicalName?: string | null;
	} | null;
};

/**
 * The model label for outcome metrics. A captured label (the model that
 * answered the latest `doDecide`, set even when `experimental_decide` then
 * threw) wins; otherwise the result's model, otherwise the requested model's
 * canonical name. The answering model maps to the requested model, a known
 * gateway fallback's canonical name, or `unknown`; a provider-supplied id is
 * never used as a label. The requested model comes from the model catalog.
 */
export function decisionModelLabel(
	decisionModel: DecisionModelRef | null | undefined,
	result?: { response?: { modelId?: unknown } | null } | null,
	capturedLabel?: string,
): string {
	if (!decisionModel) {
		return NO_DECISION_MODEL_LABEL;
	}
	if (capturedLabel) {
		return capturedLabel;
	}
	const requestedId = decisionModel.metadata?.modelString ?? undefined;
	const requestedLabel =
		decisionModel.metadata?.canonicalName ?? requestedId ?? UNKNOWN_MODEL;
	return (
		allowedAnsweringModel(
			{ id: requestedId, label: requestedLabel },
			result?.response?.modelId,
		)?.label ?? requestedLabel
	);
}

/**
 * The confidence of one SDK answer, in 0..1, or undefined when the answer has
 * no readable one. A choice answer's confidence is the probability of the
 * chosen option; a boolean answer's is the probability of the more likely side
 * (the site thresholds use P(true) at either end). Scores and refusals have
 * none.
 */
export function decisionAnswerConfidence(answer: unknown): number | undefined {
	if (!answer || typeof answer !== "object") {
		return undefined;
	}
	const { type, choice, probabilities, probability } = answer as {
		type?: unknown;
		choice?: unknown;
		probabilities?: unknown;
		probability?: unknown;
	};
	const inRange = (value: unknown): value is number =>
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1;
	if (type === "choice") {
		if (
			typeof choice !== "string" ||
			!probabilities ||
			typeof probabilities !== "object"
		) {
			return undefined;
		}
		const chosen = (probabilities as Record<string, unknown>)[choice];
		return inRange(chosen) ? chosen : undefined;
	}
	if (type === "boolean") {
		return inRange(probability)
			? Math.max(probability, 1 - probability)
			: undefined;
	}
	return undefined;
}

/**
 * Outcome for a decision call that threw, classified by SDK identity and never
 * by message text:
 * - `AiUsageLimitExceededError`: a usage limit.
 * - `Experimental_DecisionRefusalError`: the model refused a question.
 * - `InvalidResponseDataError`: the response was rejected as invalid. In
 *   `experimental_decide` this is the only class thrown for answer validation
 *   (wrong number of answers, wrong type, unknown choice, bad distribution, a
 *   boolean without a probability), and it is thrown after `doDecide`
 *   returned.
 * Transport and HTTP failures (`APICallError`, gateway errors), aborts,
 * timeouts and invalid caller input (`InvalidArgumentError`) are `failed`.
 */
export function decisionOutcomeForError(
	error: unknown,
): "limit_exceeded" | "refused" | "malformed" | "failed" {
	try {
		if (error instanceof AiUsageLimitExceededError) {
			return "limit_exceeded";
		}
		if (Experimental_DecisionRefusalError.isInstance(error)) {
			return "refused";
		}
		if (InvalidResponseDataError.isInstance(error)) {
			return "malformed";
		}
	} catch {
		// Classification is best-effort; anything unreadable is a plain failure.
	}
	return "failed";
}

export type RecordDecisionOutcomeInput = {
	/** The call site; one of {@link DECISION_SITES}. */
	site: DecisionSite;
	/** The resolved decision model; omit when none was resolved. */
	decisionModel?: DecisionModelRef | null;
	/** The `experimental_decide` result, when there is one (names the answering model). */
	result?: { response?: { modelId?: unknown } | null } | null;
	/**
	 * The capture the `experimental_decide` call ran in. Names the answering
	 * model even when the call threw after `doDecide` returned, and wins over
	 * `result`.
	 */
	capture?: DecisionCapture;
	/** Raw SDK answers whose confidence should be sampled, one sample per readable answer. */
	answers?: readonly unknown[];
	/** How many decisions share this outcome (a batch that fell back as a whole). Defaults to 1. */
	count?: number;
} & (
	| {
			outcome: DecisionOutcome;
			error?: undefined;
	  }
	| {
			/**
			 * The error the decision call threw; the outcome is derived from it.
			 * Without `decisionModel`, an error other than a usage limit means
			 * no decision model could be resolved (`unavailable`).
			 */
			error: unknown;
			outcome?: undefined;
	  }
);

/**
 * Record how a decision call site ended: a `llm.decision.outcomes` counter
 * (site, outcome, model), a `llm.decision.confidence` sample per readable
 * answer (site, model), and the same facts on the active span, if any.
 *
 * A `below_threshold` outcome whose answers carry no readable confidence is
 * recorded as `malformed`. Never throws.
 */
export function recordDecisionOutcome(input: RecordDecisionOutcomeInput): void {
	try {
		const confidences: number[] = [];
		for (const answer of input.answers ?? []) {
			const confidence = decisionAnswerConfidence(answer);
			if (confidence !== undefined) {
				confidences.push(confidence);
			}
		}
		let outcome: DecisionOutcome;
		if (input.outcome !== undefined) {
			outcome = input.outcome;
		} else {
			outcome = decisionOutcomeForError(input.error);
			// A generic failure before any decision model was resolved is the
			// "no decision model" path, not a failed decision call.
			if (outcome === "failed" && !input.decisionModel) {
				outcome = "unavailable";
			}
		}
		if (
			outcome === "below_threshold" &&
			input.answers !== undefined &&
			confidences.length === 0
		) {
			outcome = "malformed";
		}
		llmInstrumentation.recordDecisionOutcome({
			site: boundedSite(input.site),
			outcome,
			model: decisionModelLabel(
				input.decisionModel,
				input.result,
				input.capture?.answeringModelLabel,
			),
			confidences,
			count: input.count,
		});
	} catch {
		// Telemetry is best-effort and never changes a decision site.
	}
}
