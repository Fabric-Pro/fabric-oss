/**
 * Gateway-level fallback for the system-default decision model.
 *
 * GPT-6 Luna Decisions is the catalog's default DECISION model on Vercel AI
 * Gateway. An organization that never chose a decision model receives it
 * through that default, so a Luna failure at the gateway (an organization
 * provider allowlist that excludes OpenAI, an OpenAI outage) would otherwise
 * leave the organization with no typed decision at all. For those
 * organizations the gateway is asked to retry the same request on TypeSafe AI
 * Jev, inside the one gateway call, before Fabric's own language-model
 * fallback runs.
 *
 * An organization that explicitly chose a decision model gets no automatic
 * cross-vendor decision-model fallback. (If its chosen model refuses or fails,
 * the decision site's own language-model fallback still runs, and that model
 * may come from another vendor.) `getAIDecisionModelWithMetadata` decides
 * which case applies from the selection source, never from the model name
 * alone.
 *
 * HARD usage limits are checked per `doDecide` dispatch, not once when the
 * model is resolved: callers reuse one resolved model for many decisions (a
 * batch, a loop), and a limit can be reached partway through. Immediately
 * before each dispatch `withDecisionUsageLimits` checks the primary model
 * (any failure aborts the call) and every fallback the request would carry
 * (an exhausted one is left off that request only; any other failure aborts
 * the call).
 *
 * A check reads the limit counters as they stand. Usage rows and counter
 * increments are written asynchronously after a call completes, so a call
 * that exhausts a limit stops later calls only once its usage is recorded;
 * concurrent calls can each pass the check before that.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import type { DecisionModelInstance } from "./usage-logging-middleware";

export interface DecisionModelFallback {
	/** Gateway model id sent in `providerOptions.gateway.models`. */
	providerModelId: string;
	/** Catalog canonical name, for attributing usage when this model answers. */
	canonicalName: string;
}

/**
 * Fallbacks for a decision model reached through the system default, keyed by
 * that default's catalog canonical name. Plain string fallbacks only: a
 * conditional (`{ model, when }`) fallback is out of scope here.
 */
export const SYSTEM_DEFAULT_DECISION_FALLBACKS: Readonly<
	Record<string, readonly DecisionModelFallback[]>
> = {
	"gpt-6-luna-decisions": [
		{
			providerModelId: "typesafe-ai/jev",
			canonicalName: "typesafe-ai-jev",
		},
	],
};

/**
 * The gateway fallbacks to attach for one resolved decision model. Empty unless
 * the model came from the system default and has fallbacks configured.
 */
export function getDecisionModelFallbacks(params: {
	selectionSource: string;
	canonicalName: string;
}): readonly DecisionModelFallback[] {
	if (params.selectionSource !== "system_default") {
		return [];
	}
	return SYSTEM_DEFAULT_DECISION_FALLBACKS[params.canonicalName] ?? [];
}

export interface DecisionUsageLimitOptions {
	/** Catalog canonical name of the primary decision model. */
	primaryCanonicalName: string;
	/** Fallbacks the gateway may be asked to retry on. May be empty. */
	fallbacks: readonly DecisionModelFallback[];
	/**
	 * Runs the HARD-limit check for one model, with the caller's scope. Throws
	 * `AiUsageLimitExceededError` when that model's limit is exhausted.
	 */
	assertWithinLimits: (modelCanonicalName: string) => Promise<void>;
	/** Attached to the warning logged when a fallback is dropped. */
	organizationId: string;
}

/**
 * Wrap a gateway decision model so that every `doDecide` dispatch is preceded,
 * immediately, by a HARD-limit check of the primary model and of each
 * fallback the request will carry, and then carries the allowed fallbacks in
 * `providerOptions.gateway.models`.
 *
 * - A failure of the primary's check, limit rejection or otherwise, rejects
 *   the call unchanged and the wrapped model is not called.
 * - A fallback whose limit is exhausted is left off this call only; the next
 *   call checks it again. Any other failure of a fallback's check rejects the
 *   call without dispatching.
 * - Other gateway options the caller passed are kept. A call that sets its
 *   own `models` list is rejected without any check or dispatch, since those
 *   models would bypass the fallback checks. No `models` key is added when no
 *   fallback is allowed.
 */
export function withDecisionUsageLimits(
	model: DecisionModelInstance,
	options: DecisionUsageLimitOptions,
): DecisionModelInstance {
	const doDecide = model.doDecide.bind(model);

	return {
		// GatewayDecisionModel exposes `provider` through a prototype getter, so
		// copy each contract field explicitly rather than spreading the instance.
		specificationVersion: model.specificationVersion,
		provider: model.provider,
		modelId: model.modelId,
		supportedQuestionTypes: model.supportedQuestionTypes,
		doDecide: async (callOptions) => {
			const gatewayOptions = callOptions.providerOptions?.gateway;
			// A caller's own gateway `models` list would send the request to
			// models this wrapper never limit-checked, so it is refused before
			// any check or dispatch. Fallbacks come only from the configured list.
			if (gatewayOptions && "models" in gatewayOptions) {
				throw new Error(
					"Decision models do not accept a caller-supplied gateway models list; fallbacks are configured centrally and limit-checked per call.",
				);
			}

			await options.assertWithinLimits(options.primaryCanonicalName);

			const allowedModelIds: string[] = [];
			for (const fallback of options.fallbacks) {
				try {
					await options.assertWithinLimits(fallback.canonicalName);
					allowedModelIds.push(fallback.providerModelId);
				} catch (error) {
					if (!(error instanceof AiUsageLimitExceededError)) {
						throw error;
					}
					console.warn(
						"[getAIDecisionModelWithMetadata] usage limit reached for a decision fallback model — omitting it from this request",
						{
							organizationId: options.organizationId,
							fallbackCanonicalName: fallback.canonicalName,
							limitId: error.limitId,
						},
					);
				}
			}
			if (allowedModelIds.length === 0) {
				return doDecide(callOptions);
			}
			return doDecide({
				...callOptions,
				providerOptions: {
					...callOptions.providerOptions,
					gateway: {
						...gatewayOptions,
						models: allowedModelIds,
					},
				},
			});
		},
	};
}
