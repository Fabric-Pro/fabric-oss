import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractUsageFromLangChainResponse,
	logAgentUsageFromRunnableConfig,
} from "../src/services/usage-logging";

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

/**
 * `logAgentUsageFromRunnableConfig` is called without `await` on the
 * project-document-generator's hot path (the usage row is observability and
 * nothing reads it back), so a rejection there would surface as an unhandled
 * rejection and take the agent process down rather than losing one row. The
 * function's contract is therefore that it never rejects.
 */
describe("logAgentUsageFromRunnableConfig — never rejects", () => {
	const config = {
		configurable: {
			ai_token: "token",
			ai_provider: "OPENAI_DIRECT",
			ai_model: "gpt-4o-mini",
		},
	};

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("resolves when the transport rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection refused");
			}),
		);

		await expect(
			logAgentUsageFromRunnableConfig(
				config,
				{ usage_metadata: { input_tokens: 1, output_tokens: 2 } },
				{ taskType: "TOOL_CALLING" },
			),
		).resolves.toBeUndefined();
	});

	it("resolves when shaping the payload throws", async () => {
		const exploding = {};
		Object.defineProperty(exploding, "usage_metadata", {
			get() {
				throw new Error("boom");
			},
		});

		await expect(
			logAgentUsageFromRunnableConfig(config, exploding, {
				taskType: "TOOL_CALLING",
			}),
		).resolves.toBeUndefined();
	});
});

describe("logAgentUsageFromRunnableConfig — cache accounting", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function captureUsageBody(
		provider: string,
		cacheRead = 3000,
		cacheCreation = 1570,
	) {
		const rawInput = 3;
		const output = 4;
		const inclusiveInput = rawInput + cacheRead + cacheCreation;
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response(null, { status: 204 });
			}),
		);

		await logAgentUsageFromRunnableConfig(
			{
				configurable: {
					ai_token: "token",
					ai_provider: provider,
					ai_model: "claude-sonnet-4-5",
				},
			},
			{
				usage_metadata: {
					// @langchain/anthropic includes both cache buckets here.
					input_tokens: inclusiveInput,
					output_tokens: output,
					total_tokens: inclusiveInput + output,
					input_token_details: {
						cache_read: cacheRead,
						cache_creation: cacheCreation,
					},
				},
				response_metadata: {
					model_provider:
						provider === "ANTHROPIC_DIRECT"
							? "anthropic"
							: "openai",
				},
			},
			{ taskType: "TOOL_CALLING" },
		);

		return requestBody;
	}

	it("removes native Anthropic cache reads from full-rate input tokens", async () => {
		await expect(
			captureUsageBody("ANTHROPIC_DIRECT", 4570, 0),
		).resolves.toMatchObject({
			inputTokens: 3,
			outputTokens: 4,
			totalTokens: 7,
			cachedInputTokens: 4570,
			cacheCreationInputTokens: 0,
		});
	});

	it("removes native Anthropic cache writes from full-rate input tokens", async () => {
		await expect(
			captureUsageBody("ANTHROPIC_DIRECT", 0, 4570),
		).resolves.toMatchObject({
			inputTokens: 3,
			outputTokens: 4,
			totalTokens: 7,
			cachedInputTokens: 0,
			cacheCreationInputTokens: 4570,
		});
	});

	it("keeps Databricks Claude cache buckets inside input tokens", async () => {
		await expect(captureUsageBody("DATABRICKS")).resolves.toMatchObject({
			inputTokens: 4573,
			outputTokens: 4,
			totalTokens: 4577,
			cachedInputTokens: 3000,
			cacheCreationInputTokens: 1570,
		});
	});
});
