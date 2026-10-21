import { anthropicModelRejectsForcedToolChoice } from "@repo/agent-types";
import type { LanguageModelMiddleware } from "ai";

type CallParams = Parameters<
	NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"];

/**
 * Replaces a JSON `responseFormat` with a system-prompt instruction that
 * carries the schema. Databricks uses this for Claude models that reject its
 * forced-tool translation (Fizzy #2823); direct Anthropic uses it when the
 * schema exceeds native structured-output limits (Fizzy #3189).
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

			return promptSteerJsonResponse(params);
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

function promptSteerJsonResponse(params: CallParams): CallParams {
	if (params.responseFormat?.type !== "json") {
		return params;
	}
	const { schema, name, description } = params.responseFormat;
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
}

/**
 * Counts optional properties and union-typed schema nodes across JSON Schema
 * containers.
 * References and unsupported schema keywords return Infinity for both counts:
 * native output is only safe here when the walk can establish both limits.
 */
export function countAnthropicSchemaParameters(schema: unknown): {
	optionalParameters: number;
	unionParameters: number;
} {
	let optionalParameters = 0;
	let unionParameters = 0;
	let uncertain = false;
	const active = new Set<object>();
	const annotationsAndConstraints = new Set([
		"$schema",
		"$id",
		"$comment",
		"title",
		"description",
		"default",
		"examples",
		"deprecated",
		"readOnly",
		"writeOnly",
		"type",
		"enum",
		"const",
		"required",
		"minimum",
		"maximum",
		"exclusiveMinimum",
		"exclusiveMaximum",
		"multipleOf",
		"minLength",
		"maxLength",
		"pattern",
		"format",
		"minItems",
		"maxItems",
		"uniqueItems",
		"minProperties",
		"maxProperties",
	]);
	const isObject = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	function walk(node: unknown): void {
		if (typeof node === "boolean") {
			return;
		}
		if (!isObject(node) || active.has(node)) {
			uncertain = true;
			return;
		}
		if (
			node.required !== undefined &&
			(!Array.isArray(node.required) ||
				!node.required.every((name) => typeof name === "string"))
		) {
			uncertain = true;
		}
		if (
			node.type !== undefined &&
			typeof node.type !== "string" &&
			(!Array.isArray(node.type) ||
				!node.type.every((type) => typeof type === "string"))
		) {
			uncertain = true;
		}
		// Counted wherever it sits (property, array item, root, nested branch),
		// not only on properties: Anthropic does not say which positions count,
		// and over-counting costs only a needless prompt-steered fallback.
		if ("anyOf" in node || "oneOf" in node || Array.isArray(node.type)) {
			unionParameters++;
		}
		active.add(node);
		for (const [key, value] of Object.entries(node)) {
			if (
				key === "properties" ||
				key === "$defs" ||
				key === "definitions"
			) {
				if (!isObject(value)) {
					uncertain = true;
					continue;
				}
				const required = Array.isArray(node.required)
					? node.required
					: [];
				for (const [name, child] of Object.entries(value)) {
					if (key === "properties" && !required.includes(name)) {
						optionalParameters++;
					}
					walk(child);
				}
			} else if (key === "items") {
				if (Array.isArray(value)) {
					value.forEach(walk);
				} else {
					walk(value);
				}
			} else if (
				["prefixItems", "anyOf", "oneOf", "allOf"].includes(key)
			) {
				if (Array.isArray(value)) {
					value.forEach(walk);
				} else {
					uncertain = true;
				}
			} else if (key === "additionalProperties") {
				walk(value);
			} else if (!annotationsAndConstraints.has(key)) {
				uncertain = true;
			}
		}
		active.delete(node);
	}
	walk(schema);
	return uncertain
		? {
				optionalParameters: Number.POSITIVE_INFINITY,
				unionParameters: Number.POSITIVE_INFINITY,
			}
		: { optionalParameters, unionParameters };
}

/**
 * Prompt-steers tool-free JSON calls whose schema exceeds Anthropic's native
 * structured-output limits (Fizzy #3189). Applied to direct-Anthropic models
 * only, by `wrapWithProviderMiddleware` in model-factory.ts.
 */
export function createAnthropicStructuredOutputLimitsMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		transformParams: async ({ params, model }) => {
			// Calls with tools pass through: rewriting their format changes tool semantics.
			if (
				params.responseFormat?.type !== "json" ||
				params.responseFormat.schema === undefined ||
				params.tools?.length
			) {
				return params;
			}
			const { optionalParameters, unionParameters } =
				countAnthropicSchemaParameters(params.responseFormat.schema);
			if (optionalParameters <= 24 && unionParameters <= 16) {
				return params;
			}
			console.warn(
				`[AI] Prompt-steering structured output for ${model.modelId}: ${optionalParameters} optional parameters, ${unionParameters} union parameters (limits: 24 optional, 16 union; Infinity means uncountable).`,
			);
			return promptSteerJsonResponse(params);
		},
	};
}
