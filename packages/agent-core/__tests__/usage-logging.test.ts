import { describe, expect, it } from "vitest";
import { extractUsageFromLangChainResponse } from "../src/services/usage-logging";

describe("extractUsageFromLangChainResponse", () => {
	it("reads token counts + cache/reasoning breakdown + gateway generationId", () => {
		const message = {
			usage_metadata: {
				input_tokens: 100,
				output_tokens: 40,
				total_tokens: 140,
				input_token_details: { cache_read: 80, cache_creation: 20 },
				output_token_details: { reasoning: 12 },
			},
			response_metadata: { gateway: { generationId: "gen_01ABC" } },
		};
		expect(extractUsageFromLangChainResponse(message)).toEqual({
			inputTokens: 100,
			outputTokens: 40,
			totalTokens: 140,
			cachedInputTokens: 80,
			cacheCreationInputTokens: 20,
			reasoningTokens: 12,
			gatewayGenerationId: "gen_01ABC",
		});
	});

	it("falls back to response_metadata.tokenUsage and leaves optional fields undefined", () => {
		const message = {
			response_metadata: {
				tokenUsage: {
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
				},
			},
		};
		const usage = extractUsageFromLangChainResponse(message);
		expect(usage).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
		});
		expect(usage?.cachedInputTokens).toBeUndefined();
		expect(usage?.reasoningTokens).toBeUndefined();
		expect(usage?.gatewayGenerationId).toBeUndefined();
	});

	it("returns null for a non-object response", () => {
		expect(extractUsageFromLangChainResponse(null)).toBeNull();
		expect(extractUsageFromLangChainResponse("nope")).toBeNull();
	});

	it("falls back to response_metadata.usage.cache_creation_input_tokens for Databricks-served Claude", () => {
		// @langchain/openai never maps a cache-WRITE count into
		// usage_metadata.input_token_details.cache_creation — no OpenAI wire
		// shape carries one. For Databricks (which sends `system_fingerprint`),
		// its completions parser spreads the raw wire usage object verbatim onto
		// response_metadata.usage, so the Anthropic-named field survives there.
		const message = {
			usage_metadata: {
				input_tokens: 4573,
				output_tokens: 4,
				total_tokens: 4577,
				// The compat-layer normalization already mapped the cache-READ
				// count onto prompt_tokens_details.cached_tokens before this
				// parser ran, so input_token_details.cache_read is populated as
				// usual — only the cache-WRITE count has no such mapping.
				input_token_details: { cache_read: 0 },
			},
			response_metadata: {
				usage: {
					cache_creation: {
						ephemeral_1h_input_tokens: 0,
						ephemeral_5m_input_tokens: 4570,
					},
					cache_creation_input_tokens: 4570,
					cache_read_input_tokens: 0,
					completion_tokens: 4,
					prompt_tokens: 4573,
					total_tokens: 4577,
				},
			},
		};
		expect(extractUsageFromLangChainResponse(message)).toMatchObject({
			inputTokens: 4573,
			outputTokens: 4,
			totalTokens: 4577,
			cachedInputTokens: 0,
			cacheCreationInputTokens: 4570,
		});
	});

	it("prefers usage_metadata.input_token_details.cache_creation over the response_metadata.usage fallback", () => {
		const message = {
			usage_metadata: {
				input_tokens: 100,
				output_tokens: 10,
				input_token_details: { cache_creation: 25 },
			},
			response_metadata: {
				usage: { cache_creation_input_tokens: 999 },
			},
		};
		expect(
			extractUsageFromLangChainResponse(message)
				?.cacheCreationInputTokens,
		).toBe(25);
	});

	it("does not fabricate cacheCreationInputTokens when neither source has it", () => {
		const message = {
			usage_metadata: { input_tokens: 5, output_tokens: 1 },
			response_metadata: { usage: { prompt_tokens: 5 } },
		};
		expect(
			extractUsageFromLangChainResponse(message)
				?.cacheCreationInputTokens,
		).toBeUndefined();
	});
});
