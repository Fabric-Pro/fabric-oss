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
 *  - Relax strict JSON-schema structured outputs
 *    (`response_format.json_schema.strict: true → false`). `@ai-sdk/openai`
 *    defaults `strict` to `true` for `generateObject`; strict mode requires
 *    every property in `required`, so the optional-heavy schemas used by the
 *    security scan / review / grouping / backlog analysis get a 400 (the same
 *    "Bug #1681" already fixed for Azure). The AI SDK still validates the
 *    result against the Zod schema. `max_tokens` is intentionally left
 *    untouched — Anthropic/Databricks require it (unlike Azure's o1/o3 rename).
 *
 * The `temperature` and strict-`json_schema` transforms are Vercel-EXCLUSIVE:
 * the agent path omits `temperature` at the `ChatOpenAI` constructor and does
 * structured output via tool-calling (never `response_format.json_schema`), so
 * it keeps the shared default rule and never runs this function.
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

	// Bug #1681: @ai-sdk/openai defaults strict JSON-schema structured outputs
	// (`response_format.json_schema.strict = true`); strict mode requires every
	// property to appear in `required`, so optional-heavy schemas (security scan,
	// review, grouping, backlog analysis) are rejected with a 400. Force
	// non-strict — the AI SDK still validates the result against the Zod schema.
	const responseFormat = body.response_format as
		| { type?: string; json_schema?: { strict?: boolean } }
		| undefined;
	if (
		responseFormat?.type === "json_schema" &&
		responseFormat.json_schema?.strict === true
	) {
		responseFormat.json_schema.strict = false;
		mutated = true;
	}

	return mutated;
}

/**
 * Apply {@link applyDatabricksChatBodyCompat} and the shared prompt-cache
 * marker injection to a raw request-body string. Returns the (possibly
 * rewritten) body string; input is returned unchanged when it isn't JSON or
 * nothing needed rewriting.
 */
export function stripUnsupportedRequestFields(bodyText: string): string {
	return stripSharedUnsupportedRequestFields(
		bodyText,
		applyDatabricksChatBodyCompat,
	);
}

/**
 * The shared Databricks `fetch` wrapper with the Vercel-path request-body rule
 * ({@link applyDatabricksChatBodyCompat}). Same signature as before the shim
 * moved to `@repo/agent-types`; `stripReasoning` is passed through.
 */
export function createDatabricksFetch(
	baseFetch: typeof fetch = fetch,
	options: Pick<DatabricksFetchOptions, "stripReasoning"> = {},
): typeof fetch {
	return createSharedDatabricksFetch(baseFetch, {
		...options,
		applyBodyCompat: applyDatabricksChatBodyCompat,
	});
}
