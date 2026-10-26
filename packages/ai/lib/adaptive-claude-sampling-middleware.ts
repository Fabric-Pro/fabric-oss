import { isAnthropicAdaptiveOnlyModel } from "@repo/agent-types";
import type { LanguageModelMiddleware } from "ai";

/**
 * Drops `temperature`, `topP` and `topK` from calls to an adaptive-only
 * Claude model (Opus 4.7/4.8 and the 5.x generation), which return HTTP 400
 * for any non-default sampling value.
 *
 * Applied to Vercel, OpenRouter and Cloudflare gateway routes. The Vercel
 * SDK forwards sampling options unchanged; prefixed Claude IDs on the
 * OpenAI-compatible routes also need this transform, matching LangChain.
 * The native Anthropic client handles its own sampling restrictions, while
 * the Databricks fetch applies its separate compatibility transform.
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
