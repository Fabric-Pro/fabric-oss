/**
 * Integration regression test for the Databricks streaming cache-usage
 * multiplication bug (Codex round-2 review): the SSE transform's per-chunk
 * cache-key stripping + trailing usage-event synthesis
 * (`applyChunkCacheUsageHandling` / `buildSynthesizedUsageEvent` in
 * `@repo/agent-types`' `databricks-compat.ts`) must survive the REAL `@langchain/openai` +
 * `@langchain/core` streaming merge without the cache counts being summed
 * across chunks.
 *
 * Unlike the unit tests in `@repo/ai`'s `databricks-compat.test.ts` (which assert the SSE
 * transform's OWN output shape) and `usage-logging.test.ts` (which feed
 * hand-built message shapes straight to the extractor), this test drives the
 * transform's output through the ACTUALLY-INSTALLED
 * `convertCompletionsDeltaToBaseMessageChunk` — the same converter
 * `ChatOpenAICompletions._streamResponseChunks` calls internally for every
 * delta — plus a hand-built post-loop usage chunk constructed the SAME way
 * that private method builds it, then `.concat()`s everything with the real
 * `AIMessageChunk.concat()` (`@langchain/core`'s `_mergeDicts`, which SUMS
 * colliding numeric fields — verified against the installed package source;
 * see the `applyChunkCacheUsageHandling` docstring). Only then does it call
 * the real `extractUsageFromLangChainResponse`. If the SSE transform ever
 * regresses to carrying the Anthropic cache keys on more than one chunk, this
 * test fails on the real merge math, not a mock of it.
 */
import { AIMessageChunk } from "@langchain/core/messages";
import { convertCompletionsDeltaToBaseMessageChunk } from "@langchain/openai";
import { createDatabricksSseTransform } from "@repo/agent-types/databricks-compat";
import { describe, expect, it } from "vitest";
import { extractUsageFromLangChainResponse } from "../src/services/usage-logging";

async function runSseTransform(input: string): Promise<string> {
	const ts = createDatabricksSseTransform();
	const writer = ts.writable.getWriter();
	const reader = ts.readable.getReader();
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const out: string[] = [];
	const readAll = (async () => {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			out.push(dec.decode(value));
		}
	})();
	await writer.write(enc.encode(input));
	await writer.close();
	await readAll;
	return out.join("");
}

/** Every `data: {...}` JSON payload from an SSE output string, in order (excludes [DONE]). */
function parseDataChunks(sse: string): Record<string, unknown>[] {
	return [...sse.matchAll(/^data: (\{.*\})$/gm)].map(
		(m) => JSON.parse(m[1]) as Record<string, unknown>,
	);
}

/**
 * Build the post-loop synthetic usage chunk the same way
 * `ChatOpenAICompletions._streamResponseChunks` does once the SSE stream's
 * final `usage` object is known (`@langchain/openai` 1.5.11,
 * `dist/chat_models/completions.cjs`): `response_metadata.usage` is the raw
 * usage object spread verbatim, and `usage_metadata.input_token_details`
 * maps `cache_read` from `prompt_tokens_details.cached_tokens` and
 * `cache_creation` from `prompt_tokens_details.cache_write_tokens`. The
 * Databricks transform only adds those aliases on the one choices-less usage
 * event, so the raw `cache_*_input_tokens` fields surviving on
 * `response_metadata.usage` exactly once is the crux of this test.
 */
function buildSyntheticUsageChunk(
	usage: Record<string, unknown>,
): AIMessageChunk {
	const promptTokensDetails = usage.prompt_tokens_details as
		| Record<string, unknown>
		| undefined;
	const inputTokenDetails: Record<string, unknown> = {};
	if (promptTokensDetails?.cached_tokens !== undefined) {
		inputTokenDetails.cache_read = promptTokensDetails.cached_tokens;
	}
	if (promptTokensDetails?.cache_write_tokens != null) {
		inputTokenDetails.cache_creation =
			promptTokensDetails.cache_write_tokens;
	}
	return new AIMessageChunk({
		content: "",
		response_metadata: { usage: { ...usage } },
		usage_metadata: {
			input_tokens: usage.prompt_tokens as number,
			output_tokens: usage.completion_tokens as number,
			total_tokens: usage.total_tokens as number,
			...(Object.keys(inputTokenDetails).length > 0 && {
				input_token_details: inputTokenDetails,
			}),
		},
	});
}

/**
 * Replay one SSE-transform output (already stripped/synthesized by
 * `createDatabricksSseTransform`) through the real LangChain converters and
 * `.concat()` chain, in the order `ChatOpenAICompletions._streamResponseChunks`
 * uses: every chunk's `usage` replaces the retained one, a choices-less chunk
 * contributes no content chunk of its own, and ONE usage chunk built from the
 * last retained `usage` is appended after the loop. Returns the fully merged
 * message.
 */
function replayThroughRealLangChainMerge(
	dataChunks: Record<string, unknown>[],
): AIMessageChunk {
	let merged: AIMessageChunk | undefined;
	let retainedUsage: Record<string, unknown> | undefined;
	const append = (messageChunk: AIMessageChunk) => {
		merged = merged
			? (merged.concat(messageChunk) as AIMessageChunk)
			: messageChunk;
	};
	for (const chunk of dataChunks) {
		if (chunk.usage) {
			retainedUsage = chunk.usage as Record<string, unknown>;
		}
		const choices = (chunk.choices ?? []) as Array<Record<string, unknown>>;
		if (choices.length === 0) {
			continue;
		}
		append(
			convertCompletionsDeltaToBaseMessageChunk({
				delta: choices[0].delta as Record<string, unknown>,
				// The real converter's param type is the OpenAI SDK's
				// ChatCompletionChunk; our canned fixture is structurally
				// compatible for every field it reads.
				rawResponse: chunk as never,
			}) as AIMessageChunk,
		);
	}
	if (retainedUsage) {
		append(buildSyntheticUsageChunk(retainedUsage));
	}
	if (!merged) {
		throw new Error("no chunks to merge");
	}
	return merged;
}

describe("Databricks streaming cache usage survives the real LangChain merge", () => {
	it("a 2-chunk cache-READ stream reports the true single-count cache_read, not doubled", async () => {
		const midChunk =
			'data: {"id":"c1","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":4573,"completion_tokens":null,"total_tokens":null}}\n\n';
		const finalChunk =
			'data: {"id":"c1","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":4573,"completion_tokens":4,"total_tokens":4577}}\n\n';
		const sse = await runSseTransform(
			midChunk + finalChunk + "data: [DONE]\n\n",
		);

		const dataChunks = parseDataChunks(sse);
		// mid content chunk, final content chunk, synthesized usage-only event.
		expect(dataChunks).toHaveLength(3);

		const merged = replayThroughRealLangChainMerge(dataChunks);

		// The raw merged response_metadata.usage — where an unguarded pass-through
		// would show 2x (4570 + 4570) — carries the true single value.
		const rawMergedUsage = merged.response_metadata?.usage as
			| Record<string, unknown>
			| undefined;
		expect(rawMergedUsage?.cache_read_input_tokens).toBe(4570);
		expect(rawMergedUsage?.cache_creation_input_tokens).toBe(0);

		const usage = extractUsageFromLangChainResponse(merged);
		expect(usage?.cachedInputTokens).toBe(4570);
		expect(usage?.cacheCreationInputTokens).toBe(0);
		expect(usage?.inputTokens).toBe(4573);
		expect(usage?.outputTokens).toBe(4);
	});

	it("a 3-chunk cache-WRITE stream reports the true single-count cache_creation_input_tokens, not summed across N chunks", async () => {
		const chunk1 =
			'data: {"id":"c2","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Wo"},"finish_reason":null}],"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":1200,"prompt_tokens":1203,"completion_tokens":null,"total_tokens":null}}\n\n';
		const chunk2 =
			'data: {"id":"c2","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"rk"},"finish_reason":null}],"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":1200,"prompt_tokens":1203,"completion_tokens":null,"total_tokens":null}}\n\n';
		const chunk3 =
			'data: {"id":"c2","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":1200,"prompt_tokens":1203,"completion_tokens":6,"total_tokens":1209}}\n\n';
		const sse = await runSseTransform(
			chunk1 + chunk2 + chunk3 + "data: [DONE]\n\n",
		);

		const dataChunks = parseDataChunks(sse);
		// 3 content chunks + 1 synthesized usage-only event.
		expect(dataChunks).toHaveLength(4);

		const merged = replayThroughRealLangChainMerge(dataChunks);

		const rawMergedUsage = merged.response_metadata?.usage as
			| Record<string, unknown>
			| undefined;
		// Would read 3600 (3 x 1200) if any content chunk still carried the key.
		expect(rawMergedUsage?.cache_creation_input_tokens).toBe(1200);
		expect(rawMergedUsage?.cache_read_input_tokens).toBe(0);

		const usage = extractUsageFromLangChainResponse(merged);
		expect(usage?.cacheCreationInputTokens).toBe(1200);
		// cache_read_input_tokens is 0 throughout, so normalizeDatabricksUsageFields
		// correctly never injects prompt_tokens_details — extractUsageFromLangChainResponse
		// then has no numeric source for cachedInputTokens (consistent with the
		// cache-miss contract: a miss is absent, never a fabricated zero).
		expect(usage?.cachedInputTokens).toBeUndefined();
		expect(usage?.outputTokens).toBe(6);
	});

	// Fizzy #2911: the cache read reported only on an earlier chunk must still
	// be recorded once, whichever shape the stream's final usage takes.
	it("reports an earlier chunk's cache read once when the final content chunk's usage omits the cache keys", async () => {
		const firstChunk =
			'data: {"id":"c3","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}],"usage":{"cache_read_input_tokens":90,"cache_creation_input_tokens":0,"prompt_tokens":100,"completion_tokens":null,"total_tokens":null}}\n\n';
		const finalChunk =
			'data: {"id":"c3","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":4,"total_tokens":104}}\n\n';
		const sse = await runSseTransform(
			firstChunk + finalChunk + "data: [DONE]\n\n",
		);

		const dataChunks = parseDataChunks(sse);
		// 2 content chunks + 1 synthesized usage-only event.
		expect(dataChunks).toHaveLength(3);

		const merged = replayThroughRealLangChainMerge(dataChunks);
		const rawMergedUsage = merged.response_metadata?.usage as
			| Record<string, unknown>
			| undefined;
		expect(rawMergedUsage?.cache_read_input_tokens).toBe(90);

		const usage = extractUsageFromLangChainResponse(merged);
		expect(usage?.cachedInputTokens).toBe(90);
		expect(usage?.cacheCreationInputTokens).toBe(0);
		expect(usage?.inputTokens).toBe(100);
		expect(usage?.outputTokens).toBe(4);
	});

	it("reports an earlier chunk's cache read once when a native usage-only chunk without cache keys ends the stream", async () => {
		const contentChunk =
			'data: {"id":"c4","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"cache_read_input_tokens":90,"cache_creation_input_tokens":0,"prompt_tokens":100,"completion_tokens":2,"total_tokens":102}}\n\n';
		const nativeUsageChunk =
			'data: {"id":"c4","model":"m","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102}}\n\n';
		const sse = await runSseTransform(
			contentChunk + nativeUsageChunk + "data: [DONE]\n\n",
		);

		const dataChunks = parseDataChunks(sse);
		// content chunk + the native usage-only chunk; nothing synthesized.
		expect(dataChunks).toHaveLength(2);

		const merged = replayThroughRealLangChainMerge(dataChunks);
		const rawMergedUsage = merged.response_metadata?.usage as
			| Record<string, unknown>
			| undefined;
		expect(rawMergedUsage?.cache_read_input_tokens).toBe(90);

		const usage = extractUsageFromLangChainResponse(merged);
		expect(usage?.cachedInputTokens).toBe(90);
		expect(usage?.inputTokens).toBe(100);
		expect(usage?.outputTokens).toBe(2);
	});
	it("reports the cache read once when usage-bearing content follows an earlier native usage-only chunk", async () => {
		const contentChunk =
			'data: {"id":"c5","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}],"usage":{"cache_read_input_tokens":90,"cache_creation_input_tokens":0,"prompt_tokens":100,"completion_tokens":1,"total_tokens":101}}\n\n';
		const nativeUsageChunk =
			'data: {"id":"c5","model":"m","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":1,"total_tokens":101}}\n\n';
		const finalChunk =
			'data: {"id":"c5","model":"m","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102}}\n\n';
		const sse = await runSseTransform(
			contentChunk + nativeUsageChunk + finalChunk + "data: [DONE]\n\n",
		);

		const merged = replayThroughRealLangChainMerge(parseDataChunks(sse));
		const rawMergedUsage = merged.response_metadata?.usage as
			| Record<string, unknown>
			| undefined;
		expect(rawMergedUsage?.cache_read_input_tokens).toBe(90);

		const usage = extractUsageFromLangChainResponse(merged);
		expect(usage?.cachedInputTokens).toBe(90);
		expect(usage?.inputTokens).toBe(100);
		expect(usage?.outputTokens).toBe(2);
	});
});
