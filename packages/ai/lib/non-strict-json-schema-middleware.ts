import type { LanguageModelMiddleware } from "ai";

/**
 * One provider-options namespace that carries a `strictJsonSchema` flag.
 *
 * `write` is where the default is set; `reads` lists every namespace the
 * provider SDK merges into that flag. An explicit boolean under any of them is
 * the caller's choice and is left alone, because writing `write` could
 * otherwise outrank it in the SDK's merge order.
 */
export interface StrictJsonSchemaNamespace {
	write: string;
	reads: readonly string[];
}

/**
 * `@ai-sdk/openai@4.0.66`: the Chat Completions model reads `openai`
 * (dist/index.js:1139-1143, default `true` at :1167) and the Responses model
 * reads `openai` unless the provider name contains "azure"
 * (dist/index.js:7059-7067, default `true` at :7161). No `createOpenAI` call in
 * model-factory.ts sets a custom name, so every one of them reads `openai`.
 */
const OPENAI: StrictJsonSchemaNamespace = {
	write: "openai",
	reads: ["openai"],
};

/** `@ai-sdk/groq@4.0.41`: reads `groq` only (dist/index.js:441-447, default `true`). */
const GROQ: StrictJsonSchemaNamespace = { write: "groq", reads: ["groq"] };

/**
 * `@ai-sdk/cerebras@3.0.48` extends `@ai-sdk/openai-compatible@3.0.48`, which
 * merges `openai-compatible`, `openaiCompatible`, then `cerebras` (the
 * provider name `cerebras.chat`), later keys winning, and defaults strict to
 * `true` (openai-compatible dist/index.js:498-533; cerebras dist/index.js:170).
 */
const CEREBRAS: StrictJsonSchemaNamespace = {
	write: "cerebras",
	reads: ["openai-compatible", "openaiCompatible", "cerebras"],
};

/**
 * The namespaces to default for a model `getModel` built.
 *
 * - Gateway routes (Vercel AI Gateway, OpenRouter, Cloudflare) send the call
 *   options, `providerOptions` included, to the gateway, which picks the
 *   upstream. The `openai` default was confirmed against the Vercel AI
 *   Gateway with an OpenAI model (2026-10-06); `groq` and `cerebras` are sent
 *   for upstreams of those families but were not probed.
 * - Anthropic direct gets none: `@ai-sdk/anthropic@4.0.53` sends
 *   `output_config.format` with no strict flag (dist/index.js:4037-4042).
 * - DeepSeek direct gets none: `createDeepSeek` never sets
 *   `supportsStructuredOutputs` (`@ai-sdk/deepseek@3.0.44` dist/index.js:1413-1421),
 *   so a JSON response format is sent as `json_object`, without a schema or a
 *   strict flag (dist/index.js:882-890).
 * - Every other route is a `createOpenAI` model: OpenAI direct, Azure AI
 *   Foundry, Databricks and the unknown-provider fallback.
 */
export function strictJsonSchemaNamespacesFor(
	provider: string | undefined,
	viaGateway: boolean,
): readonly StrictJsonSchemaNamespace[] {
	if (viaGateway) {
		return [OPENAI, GROQ, CEREBRAS];
	}
	switch (provider) {
		case "GROQ":
			return [GROQ];
		case "CEREBRAS":
			return [CEREBRAS];
		case "ANTHROPIC_DIRECT":
		case "DEEPSEEK":
			return [];
		default:
			return [OPENAI];
	}
}

/**
 * Defaults strict JSON-schema mode off for structured-output calls, unless
 * the caller already chose a value (Fizzy #2985).
 *
 * The OpenAI, Groq and OpenAI-compatible SDKs send `strict: true` with a JSON
 * response format when `strictJsonSchema` is unset. OpenAI-style strict mode
 * requires every property to be listed in `required`, so any schema with an
 * optional field (`z.string().optional()`) is refused with a 400 ("Invalid
 * schema for response_format ... Missing '<field>'") before the model runs.
 *
 * Non-strict mode still sends the schema as guidance, but the provider does
 * not guarantee the output matches it. The AI SDK validates the parsed object
 * against the caller's Zod schema, so a non-conforming answer is rejected
 * (`NoObjectGeneratedError`) rather than passed on.
 *
 * A call without a JSON response format passes through unchanged.
 */
export function createNonStrictJsonSchemaMiddleware(
	namespaces: readonly StrictJsonSchemaNamespace[],
): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		transformParams: async ({ params }) => {
			if (params.responseFormat?.type !== "json") {
				return params;
			}
			const pending = namespaces.filter(
				({ reads }) =>
					!reads.some(
						(name) =>
							typeof params.providerOptions?.[name]
								?.strictJsonSchema === "boolean",
					),
			);
			if (pending.length === 0) {
				return params;
			}
			const providerOptions = { ...params.providerOptions };
			for (const { write } of pending) {
				providerOptions[write] = {
					...providerOptions[write],
					strictJsonSchema: false,
				};
			}
			return { ...params, providerOptions };
		},
	};
}
