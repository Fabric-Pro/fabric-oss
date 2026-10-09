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
 * alone, and leaves off any fallback whose HARD usage limit is exhausted.
 */

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

/**
 * Wrap a gateway decision model so every `doDecide` call carries the given
 * fallback models in `providerOptions.gateway.models`. Other gateway options
 * the caller passed are kept, and a caller that already set its own `models`
 * list keeps it unchanged.
 */
export function withGatewayDecisionFallbacks(
	model: DecisionModelInstance,
	fallbacks: readonly DecisionModelFallback[],
): DecisionModelInstance {
	if (fallbacks.length === 0) {
		return model;
	}
	const doDecide = model.doDecide.bind(model);
	const fallbackModelIds = fallbacks.map(
		(fallback) => fallback.providerModelId,
	);

	return {
		// GatewayDecisionModel exposes `provider` through a prototype getter, so
		// copy each contract field explicitly rather than spreading the instance.
		specificationVersion: model.specificationVersion,
		provider: model.provider,
		modelId: model.modelId,
		supportedQuestionTypes: model.supportedQuestionTypes,
		doDecide: (callOptions) => {
			const gatewayOptions = callOptions.providerOptions?.gateway;
			if (gatewayOptions && "models" in gatewayOptions) {
				return doDecide(callOptions);
			}
			return doDecide({
				...callOptions,
				providerOptions: {
					...callOptions.providerOptions,
					gateway: {
						...gatewayOptions,
						models: [...fallbackModelIds],
					},
				},
			});
		},
	};
}
