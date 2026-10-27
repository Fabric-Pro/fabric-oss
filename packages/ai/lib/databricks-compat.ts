/**
 * Databricks Model Serving / Unity AI Gateway compatibility shims for the Vercel
 * AI SDK path (`@ai-sdk/openai`, and the CopilotKit `OpenAIAdapter`).
 *
 * The shim itself — request-field strip, prompt-cache markers, response
 * normalization, reasoning stripping, error-envelope rewrite — lives in
 * `@repo/agent-types` (`src/databricks-compat.ts`), shared with the LangChain
 * agent path, which cannot import this package: the agent tsup configs mark
 * `@repo/ai` external. This module adds the one Vercel-only piece,
 * {@link applyDatabricksChatBodyCompat}, and wires it in as the request-body
 * rule, mirroring the Azure body-compat pattern in `model-factory.ts`
 * (`applyAzureChatBodyCompat`).
 */
import {
	createDatabricksFetch as createSharedDatabricksFetch,
	type DatabricksFetchOptions,
	stripDatabricksUnsupportedFields,
	stripUnsupportedRequestFields as stripSharedUnsupportedRequestFields,
} from "@repo/agent-types/databricks-compat";

import { relaxIncompatibleStrictJsonSchema } from "./strict-json-schema-middleware";

export { isReasoningModelName } from "@repo/agent-types/databricks-compat";

/**
 * Apply the Vercel-path Databricks request-body transforms in place, mirroring
 * `applyAzureChatBodyCompat` (model-factory.ts). Returns true if `body` changed.
 *
 *  - Strip fields Databricks rejects outright (`stream_options`,
 *    `parallel_tool_calls`) — the shared default rule,
 *    `stripDatabricksUnsupportedFields`.
 *  - Drop `temperature` — Databricks-served Claude (e.g. Claude Sonnet 5)
 *    rejects the sampling params with `400: does not support the temperature
 *    parameter`; callers such as the security scan pass `temperature: 0`.
 * The shared structural checker relaxes incompatible strict schemas from
 * explicit-strict callers or future clients. max_tokens is left untouched because
 * Anthropic/Databricks require it.
 */
export function applyDatabricksChatBodyCompat(
	body: Record<string, unknown>,
): boolean {
	// Strip fields Databricks rejects outright.
	let mutated = stripDatabricksUnsupportedFields(body);

	// Databricks-served Claude rejects the temperature/top_p/top_k sampling params
	// (`400: ... does not support the temperature parameter`). Drop `temperature`
	// unconditionally — serving-endpoint names are user-defined aliases so the
	// model family isn't reliably detectable; the model uses its own default.
	if (body.temperature !== undefined) {
		delete body.temperature;
		mutated = true;
	}

	mutated = relaxIncompatibleStrictJsonSchema(body) || mutated;

	return mutated;
}

/**
 * Apply {@link applyDatabricksChatBodyCompat} and the shared prompt-cache
 * marker injection to a raw request-body string. Returns the (possibly
 * rewritten) body string; input is returned unchanged when it isn't JSON or
 * nothing needed rewriting.
 */
export function stripUnsupportedRequestFields(
	bodyText: string,
	promptCache?: boolean,
): string {
	return stripSharedUnsupportedRequestFields(
		bodyText,
		applyDatabricksChatBodyCompat,
		promptCache,
	);
}

/**
 * The shared Databricks `fetch` wrapper with the Vercel-path request-body rule
 * ({@link applyDatabricksChatBodyCompat}). Passes canonical prompt-cache and
 * reasoning options through to the shared adapter.
 */
export function createDatabricksFetch(
	baseFetch: typeof fetch = fetch,
	options: Pick<
		DatabricksFetchOptions,
		"stripReasoning" | "promptCache"
	> = {},
): typeof fetch {
	return createSharedDatabricksFetch(baseFetch, {
		...options,
		applyBodyCompat: applyDatabricksChatBodyCompat,
	});
}
