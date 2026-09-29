import { isAnthropicAdaptiveOnlyModel } from "@repo/agent-types";
import type { LanguageModelMiddleware } from "ai";

/**
 * Drops `temperature`, `topP` and `topK` from calls to an adaptive-only
 * Claude model (Opus 4.7/4.8 and the 5.x generation), which return HTTP 400
 * for any non-default sampling value.
 *
 * Only the gateway routes need it. `@ai-sdk/anthropic` already drops these
 * client-side (its `rejectsSamplingParameters` capability) and the Databricks
 * fetch deletes `temperature` for every model, but `@ai-sdk/gateway` forwards
 * call options unchanged, so on VERCEL_GATEWAY / OPENROUTER / CLOUDFLARE_AI a
 * caller's fixed temperature (planner, journey, security scan, Fabric
 * patterns) reaches the gateway server as-is.
 */
export function createAdaptiveClaudeSamplingMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		transformParams: async ({ params }) => {
			if (
				params.temperature === undefined &&
				params.topP === undefined &&
				params.topK === undefined
			) {
				return params;
			}
			const {
				temperature: _temperature,
				topP: _topP,
				topK: _topK,
				...rest
			} = params;
			return rest;
		},
	};
}

/**
 * True when a gateway model id names an adaptive-only Claude model and so
 * needs {@link createAdaptiveClaudeSamplingMiddleware}.
 */
export function gatewayModelRejectsSampling(gatewayModelId: string): boolean {
	return isAnthropicAdaptiveOnlyModel(gatewayModelId);
}
