import { anthropicModelRejectsForcedToolChoice } from "@repo/agent-types";
import type { LanguageModelMiddleware } from "ai";

/**
 * Replaces a JSON `responseFormat` with a system-prompt instruction that
 * carries the schema, for Claude models served over Databricks that cannot
 * take Databricks' structured-output translation (Fizzy #2823).
 *
 * Databricks serves `response_format` (`json_schema` or `json_object`) to
 * Claude by translating it into a forced tool call. Claude models that reject
 * a forced `tool_choice` (Sonnet/Opus 5.5, Fable/Mythos 5.1) make every such
 * request a 400 — `INVALID_PARAMETER_VALUE: Structured output is not supported
 * for this model because its translation requires forced tool use` — and the
 * Anthropic-native `output_config.format` is refused as an extra input on the
 * same gateway, so there is no native route. Probed on the AI Gateway chat
 * endpoint, 2026-10-01.
 *
 * Without `responseFormat` the provider sends a plain chat request. The AI SDK
 * still parses and validates the returned text against the caller's schema
 * (`generateObject`, `Output.object`), so a non-conforming answer fails as
 * `AI_NoObjectGeneratedError` instead of passing through.
 */
export function createPromptSteeredStructuredOutputMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		transformParams: async ({ params }) => {
			const responseFormat = params.responseFormat;
			if (responseFormat?.type !== "json") {
				return params;
			}

			const { schema, name, description } = responseFormat;
			const instruction = [
				schema === undefined
					? "Respond with a single JSON object."
					: "Respond with a single JSON value that conforms to the JSON Schema below.",
				"Output only the JSON: no prose before or after it, and no Markdown code fences.",
				...(name || description
					? [
							`The value is: ${[name, description].filter(Boolean).join(" — ")}`,
						]
					: []),
				...(schema === undefined
					? []
					: ["JSON Schema:", JSON.stringify(schema)]),
			].join("\n");

			const { responseFormat: _responseFormat, ...rest } = params;
			const prompt = [...params.prompt];
			const systemIndex = prompt.findIndex((m) => m.role === "system");
			const system = prompt[systemIndex];
			if (system?.role === "system") {
				prompt[systemIndex] = {
					...system,
					content: system.content
						? `${system.content}\n\n${instruction}`
						: instruction,
				};
			} else {
				prompt.unshift({ role: "system", content: instruction });
			}
			return { ...rest, prompt };
		},
	};
}

/**
 * True when a Databricks-served model needs
 * {@link createPromptSteeredStructuredOutputMiddleware}.
 *
 * Prefers the model's canonical identity, because the Databricks model string
 * is a serving-endpoint name that can be an opaque alias (`prod-chat`) for a
 * Sonnet 5.5 endpoint, or a misleading one for a different model. The endpoint
 * name is only the fallback when the caller did not resolve a canonical name.
 */
export function databricksModelNeedsPromptSteeredStructuredOutput(
	endpointName: string,
	canonicalModelName?: string | null,
): boolean {
	return anthropicModelRejectsForcedToolChoice(
		canonicalModelName || endpointName,
	);
}
