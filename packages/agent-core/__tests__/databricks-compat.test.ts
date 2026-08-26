import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyDatabricksPromptCacheMarkers,
	createDatabricksFetch,
	createDatabricksSseTransform,
	createReasoningStripper,
	extractTextFromContentBlocks,
	isReasoningModelName,
	normalizeContentArrays,
	normalizeDatabricksErrorEnvelope,
	normalizeDatabricksUsageFields,
	stripReasoningFromMessages,
	stripUnsupportedRequestFields,
} from "../src/services/databricks-compat";

async function runThroughSseTransform(
	inputs: string[],
	stripReasoning = false,
): Promise<string> {
	const ts = createDatabricksSseTransform(stripReasoning);
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
	for (const chunk of inputs) {
		await writer.write(enc.encode(chunk));
	}
	await writer.close();
	await readAll;
	return out.join("");
}

describe("stripUnsupportedRequestFields", () => {
	it("removes stream_options", () => {
		const body = JSON.stringify({
			model: "system.ai.claude-sonnet-5",
			stream: true,
			stream_options: { include_usage: true },
			messages: [],
		});
		const out = JSON.parse(stripUnsupportedRequestFields(body));
		expect(out.stream_options).toBeUndefined();
		expect(out.stream).toBe(true);
		expect(out.model).toBe("system.ai.claude-sonnet-5");
	});

	it("removes parallel_tool_calls (Databricks Claude: 'Extra inputs are not permitted')", () => {
		const body = JSON.stringify({
			model: "system.ai.claude-sonnet-5",
			stream: true,
			parallel_tool_calls: true,
			tools: [{ type: "function", function: { name: "t" } }],
			messages: [],
		});
		const out = JSON.parse(stripUnsupportedRequestFields(body));
		expect(out.parallel_tool_calls).toBeUndefined();
		expect(out.tools).toHaveLength(1);
		expect(out.stream).toBe(true);
	});

	it("removes stream_options and parallel_tool_calls together in one pass", () => {
		const body = JSON.stringify({
			model: "system.ai.claude-sonnet-5",
			stream_options: { include_usage: true },
			parallel_tool_calls: false,
			messages: [],
		});
		const out = JSON.parse(stripUnsupportedRequestFields(body));
		expect(out.stream_options).toBeUndefined();
		expect(out.parallel_tool_calls).toBeUndefined();
	});

	it("returns the body unchanged when there is nothing to strip", () => {
		const body = JSON.stringify({ model: "x", messages: [] });
		expect(stripUnsupportedRequestFields(body)).toBe(body);
	});

	it("passes through non-JSON unchanged", () => {
		expect(stripUnsupportedRequestFields("not json")).toBe("not json");
	});
});

describe("extractTextFromContentBlocks", () => {
	it("concatenates text blocks and drops reasoning blocks", () => {
		const blocks = [
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "", signature: "abc" }],
			},
			{ type: "text", text: "Hello, " },
			{ type: "text", text: "world" },
		];
		expect(extractTextFromContentBlocks(blocks)).toBe("Hello, world");
	});

	it("returns empty string for reasoning-only content", () => {
		expect(
			extractTextFromContentBlocks([{ type: "reasoning", summary: [] }]),
		).toBe("");
	});
});

describe("normalizeContentArrays", () => {
	it("flattens a streaming delta.content array to a string", () => {
		const chunk = {
			choices: [
				{
					delta: { content: [{ type: "text", text: "Hi" }] },
					index: 0,
				},
			],
		};
		expect(normalizeContentArrays(chunk)).toBe(true);
		expect(chunk.choices[0].delta.content).toBe("Hi");
	});

	it("flattens a non-streaming message.content array", () => {
		const payload = {
			choices: [
				{ message: { content: [{ type: "text", text: "Answer" }] } },
			],
		};
		expect(normalizeContentArrays(payload)).toBe(true);
		expect(payload.choices[0].message.content).toBe("Answer");
	});

	it("flattens a tool-call chunk's reasoning-only content array to an empty string (so the stream loop keeps it)", () => {
		// Claude via Databricks emits an array delta.content alongside tool_calls;
		// after normalization content is a string ("") and tool_calls survive
		// untouched — so @langchain/openai's `typeof content !== 'string'` skip
		// no longer drops the tool call.
		const chunk = {
			choices: [
				{
					delta: {
						content: [{ type: "reasoning", summary: [] }],
						tool_calls: [{ index: 0, function: { name: "t" } }],
					},
					index: 0,
				},
			],
		};
		expect(normalizeContentArrays(chunk)).toBe(true);
		expect(chunk.choices[0].delta.content).toBe("");
		expect(chunk.choices[0].delta.tool_calls).toEqual([
			{ index: 0, function: { name: "t" } },
		]);
	});

	it("leaves string content untouched and returns false", () => {
		const chunk = { choices: [{ delta: { content: "already a string" } }] };
		expect(normalizeContentArrays(chunk)).toBe(false);
		expect(chunk.choices[0].delta.content).toBe("already a string");
	});

	it("is a no-op for payloads without choices", () => {
		expect(normalizeContentArrays({})).toBe(false);
		expect(normalizeContentArrays(null)).toBe(false);
	});
});

describe("createDatabricksSseTransform", () => {
	it("rewrites array delta.content to a string and passes [DONE] through", async () => {
		const input =
			'data: {"choices":[{"delta":{"content":[{"type":"reasoning","summary":[{"type":"summary_text","text":"","signature":"x"}]},{"type":"text","text":"Hello"}]},"index":0}]}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([input]);
		expect(out).toContain('"content":"Hello"');
		expect(out).not.toContain('"type":"reasoning"');
		expect(out).toContain("data: [DONE]");
	});

	it("handles events split across chunk boundaries", async () => {
		const full =
			'data: {"choices":[{"delta":{"content":[{"type":"text","text":"AB"}]},"index":0}]}\n\n';
		const mid = Math.floor(full.length / 2);
		const out = await runThroughSseTransform([
			full.slice(0, mid),
			full.slice(mid),
		]);
		expect(out).toContain('"content":"AB"');
	});

	it("handles CRLF-delimited SSE events and flattens content arrays", async () => {
		const input =
			'data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hello"}]},"index":0}]}\r\n\r\n' +
			"data: [DONE]\r\n\r\n";
		const out = await runThroughSseTransform([input]);
		expect(out).toContain('"content":"Hello"');
		expect(out).toContain("data: [DONE]");
	});

	it("handles a CRLF event boundary split across chunk boundaries", async () => {
		const full =
			'data: {"choices":[{"delta":{"content":[{"type":"text","text":"AB"}]},"index":0}]}\r\n\r\ndata: [DONE]\r\n\r\n';
		// Split right inside the first "\r\n\r\n" boundary (after the first "\r").
		const idx = full.indexOf("\r\n\r\n") + 1;
		const out = await runThroughSseTransform([
			full.slice(0, idx),
			full.slice(idx),
		]);
		expect(out).toContain('"content":"AB"');
		expect(out).toContain("data: [DONE]");
	});
});

describe("createDatabricksFetch", () => {
	it("strips stream_options from the outgoing request body", async () => {
		let sentBody: string | undefined;
		const baseFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
			sentBody = init?.body as string;
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const dbFetch = createDatabricksFetch(baseFetch);
		await dbFetch(
			"https://x.cloud.databricks.com/ai-gateway/mlflow/v1/chat/completions",
			{
				method: "POST",
				body: JSON.stringify({
					model: "m",
					stream: true,
					stream_options: { include_usage: true },
				}),
			},
		);

		expect(sentBody).toBeDefined();
		expect(JSON.parse(sentBody as string).stream_options).toBeUndefined();
	});

	it("normalizes array message.content on a non-streaming JSON response", async () => {
		const baseFetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: [{ type: "text", text: "Answer" }],
							},
						},
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;

		const dbFetch = createDatabricksFetch(baseFetch);
		const res = await dbFetch(
			"https://x.databricks.net/serving-endpoints",
			{
				method: "POST",
				body: "{}",
			},
		);
		const json = (await res.json()) as {
			choices: { message: { content: unknown } }[];
		};
		expect(json.choices[0].message.content).toBe("Answer");
	});

	it("keeps the body readable when a JSON-typed response is not valid JSON", async () => {
		// Regression: the non-streaming branch used to call response.json()
		// directly; on a malformed/empty 200 body it threw, the catch swallowed
		// it, and the fall-through returned an already-consumed (unreadable)
		// Response — masking the real upstream payload.
		const baseFetch = vi.fn(
			async () =>
				new Response("upstream error text", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const dbFetch = createDatabricksFetch(baseFetch);
		const res = await dbFetch(
			"https://x.databricks.net/serving-endpoints",
			{
				method: "POST",
				body: "{}",
			},
		);
		await expect(res.text()).resolves.toBe("upstream error text");
		expect(res.status).toBe(200);
	});
});

// =============================================================================
// Databricks Claude reports Anthropic-style prompt-cache usage
// (`cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation`)
// on an otherwise OpenAI-shaped response. `@ai-sdk/openai` and `@langchain/openai`
// only read the OpenAI shape (`usage.prompt_tokens_details.cached_tokens`), so
// cache-READ savings were invisible in AI usage logging until normalized here.
// Mirror of the @repo/ai copy's test block.
// =============================================================================

describe("normalizeDatabricksUsageFields", () => {
	it("maps cache_read_input_tokens onto prompt_tokens_details.cached_tokens", () => {
		const payload = {
			usage: {
				cache_creation: {
					ephemeral_1h_input_tokens: 0,
					ephemeral_5m_input_tokens: 0,
				},
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 4570,
				completion_tokens: 4,
				prompt_tokens: 4573,
				total_tokens: 4577,
			},
		};
		expect(normalizeDatabricksUsageFields(payload)).toBe(true);
		expect(
			(
				payload.usage as {
					prompt_tokens_details?: { cached_tokens?: number };
				}
			).prompt_tokens_details?.cached_tokens,
		).toBe(4570);
		// Anthropic-style fields are preserved — a cache-WRITE fallback reads
		// cache_creation_input_tokens downstream.
		expect(payload.usage.cache_read_input_tokens).toBe(4570);
		expect(payload.usage.cache_creation_input_tokens).toBe(0);
		expect(payload.usage.cache_creation).toEqual({
			ephemeral_1h_input_tokens: 0,
			ephemeral_5m_input_tokens: 0,
		});
		// prompt_tokens / completion_tokens are untouched.
		expect(payload.usage.prompt_tokens).toBe(4573);
		expect(payload.usage.completion_tokens).toBe(4);
		expect(payload.usage.total_tokens).toBe(4577);
	});

	it("is a no-op on a cache miss (field absent)", () => {
		const payload = { usage: { prompt_tokens: 10, completion_tokens: 2 } };
		expect(normalizeDatabricksUsageFields(payload)).toBe(false);
		expect(
			(payload.usage as Record<string, unknown>).prompt_tokens_details,
		).toBeUndefined();
	});

	it("is a no-op on a cache miss (cache_read_input_tokens: 0)", () => {
		const payload = {
			usage: { cache_read_input_tokens: 0, prompt_tokens: 10 },
		};
		expect(normalizeDatabricksUsageFields(payload)).toBe(false);
		expect(
			(payload.usage as Record<string, unknown>).prompt_tokens_details,
		).toBeUndefined();
	});

	it("is a no-op for non-numeric cache_read_input_tokens", () => {
		expect(
			normalizeDatabricksUsageFields({
				usage: { cache_read_input_tokens: "4570" },
			}),
		).toBe(false);
		expect(
			normalizeDatabricksUsageFields({
				usage: { cache_read_input_tokens: Number.NaN },
			}),
		).toBe(false);
		expect(
			normalizeDatabricksUsageFields({
				usage: { cache_read_input_tokens: null },
			}),
		).toBe(false);
	});

	it("does not overwrite an existing numeric cached_tokens", () => {
		const payload = {
			usage: {
				cache_read_input_tokens: 4570,
				prompt_tokens_details: { cached_tokens: 999 },
			},
		};
		expect(normalizeDatabricksUsageFields(payload)).toBe(false);
		expect(
			(payload.usage.prompt_tokens_details as { cached_tokens: number })
				.cached_tokens,
		).toBe(999);
	});

	it("preserves other fields already on prompt_tokens_details", () => {
		const payload = {
			usage: {
				cache_read_input_tokens: 10,
				prompt_tokens_details: { audio_tokens: 3 },
			},
		};
		expect(normalizeDatabricksUsageFields(payload)).toBe(true);
		expect(payload.usage.prompt_tokens_details).toEqual({
			audio_tokens: 3,
			cached_tokens: 10,
		});
	});

	it("is a no-op for a malformed payload", () => {
		expect(normalizeDatabricksUsageFields(null)).toBe(false);
		expect(normalizeDatabricksUsageFields(undefined)).toBe(false);
		expect(normalizeDatabricksUsageFields({})).toBe(false);
		expect(normalizeDatabricksUsageFields({ usage: "not-an-object" })).toBe(
			false,
		);
		expect(normalizeDatabricksUsageFields({ usage: [1, 2] })).toBe(false);
	});
});

describe("createDatabricksFetch — usage normalization", () => {
	it("maps cache_read_input_tokens on a non-streaming JSON response", async () => {
		const baseFetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{ message: { role: "assistant", content: "OK" } },
						],
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
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		) as unknown as typeof fetch;

		const dbFetch = createDatabricksFetch(baseFetch);
		const res = await dbFetch(
			"https://x.databricks.net/serving-endpoints",
			{
				method: "POST",
				body: "{}",
			},
		);
		const json = (await res.json()) as {
			usage: {
				prompt_tokens_details?: { cached_tokens?: number };
				cache_read_input_tokens: number;
				cache_creation_input_tokens: number;
				prompt_tokens: number;
				completion_tokens: number;
			};
		};
		// A cache-WRITE (no read) call: no prompt_tokens_details is fabricated,
		// since cache_read_input_tokens is 0.
		expect(json.usage.prompt_tokens_details).toBeUndefined();
		expect(json.usage.cache_creation_input_tokens).toBe(4570);
		expect(json.usage.prompt_tokens).toBe(4573);
		expect(json.usage.completion_tokens).toBe(4);
	});

	it("maps a cache-hit non-streaming response and preserves Anthropic fields", async () => {
		const baseFetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{ message: { role: "assistant", content: "OK" } },
						],
						usage: {
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 4570,
							completion_tokens: 4,
							prompt_tokens: 4573,
							total_tokens: 4577,
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		) as unknown as typeof fetch;

		const dbFetch = createDatabricksFetch(baseFetch);
		const res = await dbFetch(
			"https://x.databricks.net/serving-endpoints",
			{
				method: "POST",
				body: "{}",
			},
		);
		const json = (await res.json()) as {
			usage: {
				prompt_tokens_details?: { cached_tokens?: number };
				cache_read_input_tokens: number;
				cache_creation_input_tokens: number;
				prompt_tokens: number;
				completion_tokens: number;
			};
		};
		expect(json.usage.prompt_tokens_details?.cached_tokens).toBe(4570);
		expect(json.usage.cache_read_input_tokens).toBe(4570);
		expect(json.usage.cache_creation_input_tokens).toBe(0);
		expect(json.usage.prompt_tokens).toBe(4573);
		expect(json.usage.completion_tokens).toBe(4);
	});
});

describe("createDatabricksSseTransform — usage normalization", () => {
	// Databricks puts the running `usage` object on EVERY content chunk of a
	// stream, not just the last. @langchain/openai's streaming loop converts
	// the finish-bearing content chunk into an AIMessageChunk whose
	// response_metadata.usage carries the cache fields, AND emits its OWN
	// trailing usage-only chunk built from the same last-seen usage after the
	// loop ends — @langchain/core's additive .concat() would then sum the two
	// copies (exactly 2×) if the finish-bearing chunk were left unstripped. So
	// EVERY choices-bearing chunk, final or not, loses the three Anthropic
	// cache keys; they survive on exactly one synthesized trailing
	// choices-less usage event, emitted right before [DONE].
	it("strips the three Anthropic cache keys from every choices-bearing chunk and synthesizes exactly one trailing usage-only event before [DONE]", async () => {
		const midChunk =
			'data: {"model":"m","choices":[{"delta":{"role":"assistant","content":"OK"},"index":0,"finish_reason":null}],"usage":{"cache_creation":{"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":4570,"completion_tokens":null,"prompt_tokens":4573,"total_tokens":null,"cache_creation_input_tokens":0},"object":"chat.completion.chunk"}\n\n';
		const finalChunk =
			'data: {"model":"m","choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":"stop"}],"usage":{"cache_read_input_tokens":4570,"completion_tokens":4,"prompt_tokens":4573,"total_tokens":4577,"cache_creation_input_tokens":0}}\n\n';
		const out = await runThroughSseTransform([
			midChunk + finalChunk + "data: [DONE]\n\n",
		]);

		expect(out).toBe(
			'data: {"model":"m","choices":[{"delta":{"role":"assistant","content":"OK"},"index":0,"finish_reason":null}],"usage":{"completion_tokens":null,"prompt_tokens":4573,"total_tokens":null},"object":"chat.completion.chunk"}\n\n' +
				'data: {"model":"m","choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":"stop"}],"usage":{"completion_tokens":4,"prompt_tokens":4573,"total_tokens":4577}}\n\n' +
				'data: {"model":"m","choices":[],"usage":{"cache_read_input_tokens":4570,"completion_tokens":4,"prompt_tokens":4573,"total_tokens":4577,"cache_creation_input_tokens":0,"prompt_tokens_details":{"cached_tokens":4570}}}\n\n' +
				"data: [DONE]\n\n",
		);
	});

	it("strips cache_creation_input_tokens from the choices-bearing chunk even when cache_read_input_tokens is 0, and carries both once on the synthesized event", async () => {
		// The cache-write-only first call of a conversation: exactly the shape
		// that would otherwise multiply if the write count rode every chunk.
		const chunk =
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":4570,"completion_tokens":null,"prompt_tokens":4573,"total_tokens":null}}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([chunk]);
		expect(out).toBe(
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"completion_tokens":null,"prompt_tokens":4573,"total_tokens":null}}\n\n' +
				'data: {"choices":[],"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":4570,"completion_tokens":null,"prompt_tokens":4573,"total_tokens":null}}\n\n' +
				"data: [DONE]\n\n",
		);
	});

	it("does not fabricate prompt_tokens_details on a cache-miss (synthesized event still carries the zero-valued keys)", async () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"completion_tokens":null,"prompt_tokens":10,"total_tokens":null}}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([chunk]);
		expect(out).not.toContain("prompt_tokens_details");
	});

	it("malformed usage does not break content-array normalization on the same chunk", async () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hi"}]},"index":0}],"usage":"not-an-object"}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([chunk]);
		expect(out).toContain('"content":"Hi"');
	});

	it("maps an already-populated cached_tokens through the full SSE transform without overwriting it, on the synthesized event", async () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":""},"index":0,"finish_reason":"stop"}],"usage":{"cache_read_input_tokens":4570,"prompt_tokens_details":{"cached_tokens":999},"prompt_tokens":4573,"completion_tokens":4,"total_tokens":4577}}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([chunk]);
		expect(out).toBe(
			'data: {"choices":[{"delta":{"content":""},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens_details":{"cached_tokens":999},"prompt_tokens":4573,"completion_tokens":4,"total_tokens":4577}}\n\n' +
				'data: {"choices":[],"usage":{"cache_read_input_tokens":4570,"prompt_tokens_details":{"cached_tokens":999},"prompt_tokens":4573,"completion_tokens":4,"total_tokens":4577}}\n\n' +
				"data: [DONE]\n\n",
		);
	});

	it("suppresses cache fields on a choices-bearing chunk while stripReasoning is active, and still synthesizes the trailing usage event", async () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":"<think>hmm</think>Answer"},"index":0,"finish_reason":null}],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":4573,"completion_tokens":null,"total_tokens":null}}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([chunk], true);
		expect(out).toBe(
			'data: {"choices":[{"delta":{"content":"Answer"},"index":0,"finish_reason":null}],"usage":{"prompt_tokens":4573,"completion_tokens":null,"total_tokens":null}}\n\n' +
				'data: {"choices":[],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":4573,"completion_tokens":null,"total_tokens":null,"prompt_tokens_details":{"cached_tokens":4570}}}\n\n' +
				"data: [DONE]\n\n",
		);
	});

	it("maps final usage on a native choices-less usage-only chunk while stripReasoning is active, without synthesizing a second one", async () => {
		// Some OpenAI-compatible gateways send a trailing chunk carrying only
		// `usage`, with no `choices` array at all — this must not crash the
		// reasoning-stripper's choices handling, and being a REAL choices-less
		// usage chunk, must be the only cache-bearing event in the output.
		const chunk =
			'data: {"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":4573,"completion_tokens":4,"total_tokens":4577}}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([chunk], true);
		expect(out).toBe(
			'data: {"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":4573,"completion_tokens":4,"total_tokens":4577,"prompt_tokens_details":{"cached_tokens":4570}}}\n\n' +
				"data: [DONE]\n\n",
		);
	});

	it("produces byte-identical output when the stream never carries any Anthropic cache keys (non-Claude / cache-disabled)", async () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
			"data: [DONE]\n\n";
		const out = await runThroughSseTransform([chunk]);
		expect(out).toBe(chunk);
	});

	it("does not synthesize a trailing usage event when the stream ends without [DONE] (aborted mid-stream), but still strips the chunk's cache keys", async () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n';
		const out = await runThroughSseTransform([chunk]);
		expect(out).toBe(
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
		);
		expect(out).not.toContain('"choices":[]');
	});

	it("a native choices-less usage chunk suppresses synthesis of a second trailing event", async () => {
		const contentChunk =
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n';
		const nativeUsageChunk =
			'data: {"model":"m","choices":[],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n';
		const out = await runThroughSseTransform([
			contentChunk + nativeUsageChunk + "data: [DONE]\n\n",
		]);
		expect(out).toBe(
			'data: {"choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
				'data: {"model":"m","choices":[],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":4570}}}\n\n' +
				"data: [DONE]\n\n",
		);
		// Exactly one choices-less event — no duplicate synthesized event.
		expect(out.split('"choices":[]').length - 1).toBe(1);
	});

	it("the flushed reasoning-stripper residual never carries usage, even when the last array-choices chunk had cache fields", async () => {
		// Regression: lastEnvelope used to be built from ANY chunk with an array
		// `choices` — including a choices-less usage event (`choices: []` is
		// still an array) — and was spread verbatim (with `usage` still on it)
		// into the flushed residual CONTENT chunk. A stream ending in a held-back
		// partial reasoning-tag prefix, followed by a native choices-less usage
		// event, would then emit the cache fields TWICE: once on the native
		// event, once again on the flushed chunk.
		const contentChunk =
			'data: {"choices":[{"delta":{"content":"Answer<"},"index":0,"finish_reason":null}]}\n\n';
		const nativeUsageChunk =
			'data: {"model":"m","choices":[],"usage":{"cache_read_input_tokens":4570,"cache_creation_input_tokens":0,"prompt_tokens":4573,"completion_tokens":4,"total_tokens":4577}}\n\n';
		const out = await runThroughSseTransform(
			[contentChunk + nativeUsageChunk + "data: [DONE]\n\n"],
			true,
		);

		const dataChunks = [...out.matchAll(/^data: (\{.*\})$/gm)].map(
			(m) => JSON.parse(m[1]) as Record<string, unknown>,
		);
		// content chunk ("Answer"), native usage event, flushed "<" residual.
		expect(dataChunks).toHaveLength(3);
		const flushed = dataChunks[2] as {
			choices: { delta: { content: string } }[];
		};
		expect(flushed.choices[0].delta.content).toBe("<");
		expect(flushed).not.toHaveProperty("usage");

		// Cache fields appear exactly once across the whole output — on the
		// native usage event only.
		const occurrences = out.split("cache_read_input_tokens").length - 1;
		expect(occurrences).toBe(1);
	});
});

// =============================================================================
// Bug #1942: <think>-tag reasoning stripping (mirror of the @repo/ai copy). A
// DeepSeek-R1 endpoint served over Databricks leaks raw <think> tags in the
// streamed content; the agent path opts in via `stripReasoning: true`.
// =============================================================================

/** Concatenate every streamed `delta.content` from an SSE output string. */
function collectStreamedContent(sse: string): string {
	let out = "";
	for (const line of sse.split("\n")) {
		if (!line.startsWith("data:")) {
			continue;
		}
		const data = line.slice(5).trim();
		if (data === "" || data === "[DONE]") {
			continue;
		}
		try {
			const parsed = JSON.parse(data);
			const content = parsed?.choices?.[0]?.delta?.content;
			if (typeof content === "string") {
				out += content;
			}
		} catch {
			// ignore
		}
	}
	return out;
}

/** Build one SSE event per content fragment (mimics token-by-token streaming). */
function sseFromFragments(fragments: string[]): string {
	return `${fragments
		.map(
			(f) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					model: "deepseek-r1",
					choices: [
						{
							index: 0,
							delta: { content: f },
							finish_reason: null,
						},
					],
				})}`,
		)
		.join("\n\n")}\n\ndata: [DONE]\n\n`;
}

describe("createReasoningStripper", () => {
	it("suppresses a <think> span fed as one fragment", () => {
		const s = createReasoningStripper();
		expect(s.push("<think>reasoning</think>Answer") + s.flush()).toBe(
			"Answer",
		);
	});

	it("suppresses a span split arbitrarily across fragments", () => {
		const s = createReasoningStripper();
		const frags = ["<thi", "nk>rea", "son</th", "ink>Fin", "al"];
		let out = "";
		for (const f of frags) {
			out += s.push(f);
		}
		out += s.flush();
		expect(out).toBe("Final");
	});

	it("is a no-op for content with stray angle brackets (< in code)", () => {
		const s = createReasoningStripper();
		const frags = ["if (a ", "< b) v", "ector<", "int> x", "; 5 <"];
		let out = "";
		for (const f of frags) {
			out += s.push(f);
		}
		out += s.flush();
		expect(out).toBe("if (a < b) vector<int> x; 5 <");
	});

	it("drops an unterminated <think> (never emits leaked reasoning)", () => {
		const s = createReasoningStripper();
		expect(s.push("<think>still thinking") + s.flush()).toBe("");
	});
});

describe("stripReasoningFromMessages", () => {
	it("removes a <think> span from non-streaming message.content", () => {
		const payload = {
			choices: [
				{ message: { content: "<think>cot here</think>The answer" } },
			],
		};
		expect(stripReasoningFromMessages(payload)).toBe(true);
		expect(payload.choices[0].message.content).toBe("The answer");
	});

	it("leaves content without think tags untouched", () => {
		const payload = { choices: [{ message: { content: "plain answer" } }] };
		expect(stripReasoningFromMessages(payload)).toBe(false);
		expect(payload.choices[0].message.content).toBe("plain answer");
	});

	it("drops a trailing unterminated <think> (truncated response)", () => {
		const payload = {
			choices: [{ message: { content: "Answer<think>cut off mid" } }],
		};
		expect(stripReasoningFromMessages(payload)).toBe(true);
		expect(payload.choices[0].message.content).toBe("Answer");
	});
});

describe("createDatabricksSseTransform - reasoning stripping", () => {
	it("strips a streamed <think> span when stripReasoning is on", async () => {
		const sse = sseFromFragments([
			"<think>",
			"internal ",
			"reasoning",
			"</think>",
			"Visible ",
			"answer",
		]);
		const out = await runThroughSseTransform([sse], true);
		expect(collectStreamedContent(out)).toBe("Visible answer");
		expect(out).toContain("data: [DONE]");
	});

	it("handles <think> tags split across SSE chunk boundaries", async () => {
		const sse = sseFromFragments([
			"<th",
			"ink>reason",
			"ing</th",
			"ink>Done",
		]);
		const out = await runThroughSseTransform([sse], true);
		expect(collectStreamedContent(out)).toBe("Done");
	});

	it("preserves content with stray '<' and flushes the held tail", async () => {
		const sse = sseFromFragments(["a < b", " and c <"]);
		const out = await runThroughSseTransform([sse], true);
		expect(collectStreamedContent(out)).toBe("a < b and c <");
	});

	it("leaves <think> tags intact when stripReasoning is off (default)", async () => {
		const sse = sseFromFragments(["<think>x</think>Y"]);
		const out = await runThroughSseTransform([sse]);
		expect(collectStreamedContent(out)).toBe("<think>x</think>Y");
	});

	it("recovers the held tail on a truncated stream without a [DONE] event", async () => {
		// No [DONE], no trailing "\n\n": the final buffered event flushes in
		// TransformStream.flush(); the held "<" must be re-emitted as its OWN
		// event, not glued onto the final event's `data:` line.
		const event = `data: ${JSON.stringify({
			id: "1",
			object: "chat.completion.chunk",
			model: "deepseek-r1",
			choices: [
				{
					index: 0,
					delta: { content: "answer <" },
					finish_reason: null,
				},
			],
		})}`;
		const out = await runThroughSseTransform([event], true);
		expect(collectStreamedContent(out)).toBe("answer <");
	});
});

describe("isReasoningModelName", () => {
	it("matches DeepSeek-R1 serving-endpoint names", () => {
		expect(isReasoningModelName("deepseek-r1")).toBe(true);
		expect(isReasoningModelName("deepseek-reasoner")).toBe(true);
		expect(isReasoningModelName("databricks-deepseek-r1")).toBe(true);
		expect(isReasoningModelName("DeepSeek-R1-Distill-Llama-70B")).toBe(
			true,
		);
	});

	it("does not match non-reasoning models", () => {
		expect(isReasoningModelName("system.ai.claude-sonnet-5")).toBe(false);
		expect(
			isReasoningModelName("databricks-meta-llama-3-3-70b-instruct"),
		).toBe(false);
		expect(isReasoningModelName("gpt-4o")).toBe(false);
	});
});

describe("createDatabricksFetch - reasoning stripping", () => {
	// The fetch strips iff `stripReasoning` is true — the CALLER
	// (createProviderModel's Databricks branch) decides that flag from the
	// resolved canonical identity (Bug #1942 review), so the request-body `model`
	// (an opaque serving alias) is intentionally NOT re-checked here.
	const jsonResponse = () =>
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: "<think>cot</think>Final answer",
								},
							},
						],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		) as unknown as typeof fetch;

	// An opaque alias — proves stripping does NOT depend on the request model name.
	const call = (opts?: { stripReasoning?: boolean }) =>
		createDatabricksFetch(jsonResponse(), opts)(
			"https://x.databricks.net/serving-endpoints",
			{ method: "POST", body: JSON.stringify({ model: "prod-chat" }) },
		);

	it("strips <think> when stripReasoning is true (regardless of the alias)", async () => {
		const res = await call({ stripReasoning: true });
		const json = (await res.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(json.choices[0].message.content).toBe("Final answer");
	});

	it("does NOT strip when stripReasoning is false", async () => {
		const res = await call({ stripReasoning: false });
		const json = (await res.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(json.choices[0].message.content).toBe(
			"<think>cot</think>Final answer",
		);
	});

	it("does NOT strip <think> when not opted in (default)", async () => {
		const res = await call();
		const json = (await res.json()) as {
			choices: { message: { content: string } }[];
		};
		expect(json.choices[0].message.content).toBe(
			"<think>cot</think>Final answer",
		);
	});
});

/**
 * Databricks answers a request-schema failure with its OWN envelope
 * (`{error_code, message}`) rather than OpenAI's (`{error: {...}}`). The
 * `openai` SDK looks for `error`, finds nothing, and raises
 * "400 status code (no body)" — discarding the only useful thing on the wire.
 *
 * Verified against the real gateway on 2026-08-11: the malformed payload that
 * caused the 2026-08-07 incident returns HTTP 400 with a 247-byte body naming
 * the exact offending field, while `openai@6.22.0` reports
 * `message: "400 status code (no body)"`, `error: undefined`.
 */
/**
 * Verbatim 400 body captured from the Databricks gateway on 2026-08-11 while
 * reproducing the 2026-08-07 incident payload.
 */
const REAL_GATEWAY_400 = JSON.stringify({
	error_code: "BAD_REQUEST",
	message: JSON.stringify({
		message:
			"messages.2.content.0.tool_result.content.1: Input tag 'image_url' found using 'type' does not match any of the expected tags: 'document', 'image', 'search_result', 'text', 'tool_reference'",
	}),
});

describe("normalizeDatabricksErrorEnvelope", () => {
	const REAL_GATEWAY_BODY = REAL_GATEWAY_400;

	it("lifts the real gateway reason into an OpenAI-shaped `error`", () => {
		const out = normalizeDatabricksErrorEnvelope(REAL_GATEWAY_BODY);
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out as string) as {
			error: { message: string; code?: string };
		};
		expect(parsed.error.message).toContain("image_url");
		expect(parsed.error.message).toContain("tool_result");
		expect(parsed.error.code).toBe("BAD_REQUEST");
	});

	it("unwraps the nested JSON string rather than echoing it verbatim", () => {
		const parsed = JSON.parse(
			normalizeDatabricksErrorEnvelope(REAL_GATEWAY_BODY) as string,
		) as { error: { message: string } };
		// The reason is prose, not a serialized object.
		expect(parsed.error.message.startsWith("{")).toBe(false);
	});

	it("handles the prefill rejection (plain, unnested message)", () => {
		const body = JSON.stringify({
			error_code: "BAD_REQUEST",
			message:
				"This model does not support assistant message prefill. The conversation must end with a user message.",
		});
		const parsed = JSON.parse(
			normalizeDatabricksErrorEnvelope(body) as string,
		) as { error: { message: string } };
		expect(parsed.error.message).toContain("prefill");
	});

	it("leaves an already OpenAI-shaped body alone", () => {
		const body = JSON.stringify({ error: { message: "already fine" } });
		expect(normalizeDatabricksErrorEnvelope(body)).toBeNull();
	});

	it("leaves non-JSON alone", () => {
		expect(normalizeDatabricksErrorEnvelope("<html>502</html>")).toBeNull();
		expect(normalizeDatabricksErrorEnvelope("")).toBeNull();
	});

	it("leaves JSON carrying neither field alone", () => {
		expect(normalizeDatabricksErrorEnvelope('{"foo":1}')).toBeNull();
		expect(normalizeDatabricksErrorEnvelope("[1,2,3]")).toBeNull();
	});

	it("preserves the original fields alongside the added `error`", () => {
		const parsed = JSON.parse(
			normalizeDatabricksErrorEnvelope(REAL_GATEWAY_BODY) as string,
		) as { error_code: string };
		expect(parsed.error_code).toBe("BAD_REQUEST");
	});
});

describe("createDatabricksFetch — error responses", () => {
	it("rewrites a Databricks 400 so the SDK can read the reason", async () => {
		const baseFetch = vi.fn().mockResolvedValue(
			new Response(REAL_GATEWAY_400, {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		);
		const f = createDatabricksFetch(baseFetch as unknown as typeof fetch);
		const res = await f("https://example.invalid/chat/completions", {
			method: "POST",
			body: "{}",
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error?: { message: string } };
		expect(json.error?.message).toContain("image_url");
	});

	it("hands back a non-JSON error body unread and intact", async () => {
		const baseFetch = vi.fn().mockResolvedValue(
			new Response("upstream exploded", {
				status: 502,
				headers: { "content-type": "text/plain" },
			}),
		);
		const f = createDatabricksFetch(baseFetch as unknown as typeof fetch);
		const res = await f("https://example.invalid/chat/completions", {
			method: "POST",
			body: "{}",
		});
		expect(res.status).toBe(502);
		expect(await res.text()).toBe("upstream exploded");
	});
});

/** One `{type:"text"}` content block, with the optional cache breakpoint. */
type TextBlock = {
	type: string;
	text: string;
	cache_control?: { type: string };
};

const EPHEMERAL = { type: "ephemeral" };

/** Read `body.messages` back as plain records after an in-place rewrite. */
function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
	return body.messages as Record<string, unknown>[];
}

describe("applyDatabricksPromptCacheMarkers", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("marks the system prompt and the last user turn on a Claude endpoint", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "You are a helpful assistant." },
				{ role: "user", content: "hello" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const [system, user] = messagesOf(body);
		expect(system.content).toEqual([
			{
				type: "text",
				text: "You are a helpful assistant.",
				cache_control: EPHEMERAL,
			},
		]);
		expect(user.content).toEqual([
			{ type: "text", text: "hello", cache_control: EPHEMERAL },
		]);
	});

	it("leaves a non-Claude endpoint untouched (Databricks rejects unknown fields)", () => {
		const messages = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		];
		const body: Record<string, unknown> = {
			model: "databricks-meta-llama-3-3-70b-instruct",
			messages,
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(false);
		expect(messages).toEqual([
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		]);
	});

	it("matches the model gate case-insensitively", () => {
		const body: Record<string, unknown> = {
			model: "Prod-Claude-Endpoint",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
	});

	it("marks only the LAST text block when content is already an array", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{
					role: "system",
					content: [
						{ type: "text", text: "rules" },
						{ type: "text", text: "context" },
					],
				},
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		expect(messagesOf(body)[0].content).toEqual([
			{ type: "text", text: "rules" },
			{ type: "text", text: "context", cache_control: EPHEMERAL },
		]);
	});

	it("marks the last message of a multi-message system run", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "first" },
				{ role: "system", content: "second" },
				{ role: "user", content: "hi" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const [first, second] = messagesOf(body);
		expect(first.content).toBe("first");
		expect((second.content as TextBlock[])[0].cache_control).toEqual(
			EPHEMERAL,
		);
	});

	it("advances the rolling breakpoint to the latest assistant tool-calling turn (issue #2992)", () => {
		const toolCall = (id: string) => ({
			id,
			type: "function",
			function: { name: "t", arguments: "{}" },
		});
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "run the tool" },
				{
					role: "assistant",
					content: null,
					tool_calls: [toolCall("call_1")],
				},
				{ role: "tool", tool_call_id: "call_1", content: "result" },
				{
					role: "assistant",
					content: "",
					tool_calls: [toolCall("call_2"), toolCall("call_3")],
				},
				{ role: "tool", tool_call_id: "call_2", content: "result 2" },
				{ role: "tool", tool_call_id: "call_3", content: "result 3" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const [, user, firstAssistant, , lastAssistant, tool2, tool3] =
			messagesOf(body);
		// The marker must land on the LAST tool_call of the LATEST assistant turn
		// — the only markable spot when `content` is null or empty. Before this
		// worked, the walk-back stepped past every tool-calling turn and fell back
		// to the first user message, pinning the cached prefix at its first-turn
		// size while the growing tool-result history was re-billed in full on
		// every request of the loop.
		const calls = lastAssistant.tool_calls as Record<string, unknown>[];
		expect(calls[0].cache_control).toBeUndefined();
		expect(calls[1].cache_control).toEqual(EPHEMERAL);
		// Earlier turns stay untouched — the prefix rolls, it does not re-mark…
		expect(user.content).toBe("run the tool");
		const earlierCalls = firstAssistant.tool_calls as Record<
			string,
			unknown
		>[];
		expect(earlierCalls[0].cache_control).toBeUndefined();
		// …and `role:"tool"` results are stepped past, never rewritten (Databricks
		// documents markers on text/image blocks and tool_calls, not on tool
		// messages).
		expect(tool2.content).toBe("result 2");
		expect(tool3.content).toBe("result 3");
	});

	it("prefers the tool_calls marker over content on a mixed assistant turn", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: "let me check",
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "t", arguments: "{}" },
						},
					],
				},
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const [, assistant] = messagesOf(body);
		// tool_use blocks serialize after the turn's content blocks, so a marker
		// on the last call caches the whole turn; the content stays untouched.
		expect(assistant.content).toBe("let me check");
		const calls = assistant.tool_calls as Record<string, unknown>[];
		expect(calls[0].cache_control).toEqual(EPHEMERAL);
	});

	it("stops at an already-marked trailing tool_call without adding an earlier breakpoint", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "user", content: "earlier" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "t", arguments: "{}" },
							cache_control: EPHEMERAL,
						},
					],
				},
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(false);
		expect(messagesOf(body)[0].content).toBe("earlier");
	});

	it("steps past an assistant turn with an empty tool_calls array and null content", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "user", content: "earlier" },
				{ role: "assistant", content: null, tool_calls: [] },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		expect(messagesOf(body)[0].content).toEqual([
			{ type: "text", text: "earlier", cache_control: EPHEMERAL },
		]);
	});

	it("never duplicates a breakpoint that is already present", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{
					role: "system",
					content: [
						{ type: "text", text: "sys", cache_control: EPHEMERAL },
					],
				},
				{ role: "user", content: "earlier" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "latest",
							cache_control: EPHEMERAL,
						},
					],
				},
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(false);
		const [system, earlier, latest] = messagesOf(body);
		expect(system.content).toHaveLength(1);
		// Scanning stops at the already-marked tail — an earlier turn must not
		// pick up a redundant breakpoint.
		expect(earlier.content).toBe("earlier");
		expect(latest.content).toHaveLength(1);
	});

	it("injects at most two breakpoints", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "one" },
				{ role: "assistant", content: "two" },
				{ role: "user", content: "three" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const marked = messagesOf(body).filter((message) =>
			Array.isArray(message.content),
		);
		expect(marked).toHaveLength(2);
		expect(messagesOf(body)[1].content).toBe("one");
		expect(messagesOf(body)[2].content).toBe("two");
	});

	it("adds nothing when the caller already spent Anthropic's four breakpoints", () => {
		const marked = (text: string) => ({
			role: "user",
			content: [{ type: "text", text, cache_control: EPHEMERAL }],
		});
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "sys" },
				marked("a"),
				marked("b"),
				marked("c"),
				marked("d"),
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(false);
		expect(messagesOf(body)[0].content).toBe("sys");
	});

	it("is disabled by the DATABRICKS_PROMPT_CACHE_DISABLED kill-switch", () => {
		vi.stubEnv("DATABRICKS_PROMPT_CACHE_DISABLED", "1");
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(false);
		expect(messagesOf(body)[0].content).toBe("hi");
	});

	it("treats an explicitly falsy kill-switch value as not set", () => {
		vi.stubEnv("DATABRICKS_PROMPT_CACHE_DISABLED", "false");
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
	});

	it("passes malformed bodies through untouched", () => {
		for (const body of [
			{},
			{ model: "databricks-claude-sonnet-4-5" },
			{ model: "databricks-claude-sonnet-4-5", messages: "nope" },
			{ model: "databricks-claude-sonnet-4-5", messages: [] },
			{ model: 42, messages: [{ role: "user", content: "hi" }] },
			{
				model: "databricks-claude-sonnet-4-5",
				messages: [null, { role: "assistant", content: 7 }],
			},
		] as Record<string, unknown>[]) {
			expect(applyDatabricksPromptCacheMarkers(body)).toBe(false);
		}
	});
});

describe("stripUnsupportedRequestFields — prompt-cache passthrough", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("injects cache markers alongside the field strip in one rewrite", () => {
		const out = JSON.parse(
			stripUnsupportedRequestFields(
				JSON.stringify({
					model: "databricks-claude-sonnet-4-5",
					stream: true,
					stream_options: { include_usage: true },
					messages: [
						{ role: "system", content: "sys" },
						{ role: "user", content: "hi" },
					],
				}),
			),
		) as {
			stream_options?: unknown;
			messages: { content: TextBlock[] }[];
		};
		expect(out.stream_options).toBeUndefined();
		expect(out.messages[0].content[0].cache_control).toEqual(EPHEMERAL);
		expect(out.messages[1].content[0].cache_control).toEqual(EPHEMERAL);
	});

	it("rewrites a Claude body that has nothing else to strip", () => {
		const bodyText = JSON.stringify({
			model: "databricks-claude-sonnet-4-5",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(stripUnsupportedRequestFields(bodyText)).not.toBe(bodyText);
	});

	it("leaves an embeddings-style body (no messages) byte-identical", () => {
		const bodyText = JSON.stringify({
			model: "databricks-claude-sonnet-4-5",
			input: ["a", "b"],
		});
		expect(stripUnsupportedRequestFields(bodyText)).toBe(bodyText);
	});

	it("hands the delegated fetch a body that already carries the markers", async () => {
		const baseFetch = vi.fn().mockResolvedValue(
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const dbFetch = createDatabricksFetch(
			baseFetch as unknown as typeof fetch,
		);
		await dbFetch("https://example.invalid/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "databricks-claude-sonnet-4-5",
				stream_options: { include_usage: true },
				messages: [
					{ role: "system", content: "sys" },
					{ role: "user", content: "hi" },
				],
			}),
		});
		const sent = JSON.parse(
			(baseFetch.mock.calls[0][1] as { body: string }).body,
		) as {
			stream_options?: unknown;
			messages: { content: TextBlock[] }[];
		};
		expect(sent.stream_options).toBeUndefined();
		expect(sent.messages[0].content[0].cache_control).toEqual(EPHEMERAL);
		expect(sent.messages[1].content[0].cache_control).toEqual(EPHEMERAL);
	});
});

describe("applyDatabricksPromptCacheMarkers — placement edge cases", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("still marks the tail when there is no leading system message", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "yo" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const [user, assistant] = messagesOf(body);
		// No system run to spend a breakpoint on, so only the rolling one lands —
		// and the scan must still cover every message rather than starting at 1.
		expect(user.content).toBe("hi");
		expect(assistant.content).toEqual([
			{ type: "text", text: "yo", cache_control: EPHEMERAL },
		]);
	});

	it("does not treat a system message that follows a user turn as the system breakpoint", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "system", content: "late system" },
				{ role: "user", content: "latest" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const [first, late, latest] = messagesOf(body);
		// Only a LEADING system run is the tools+system prefix; a system message
		// wedged mid-conversation is neither that nor a rolling-scan candidate.
		expect(first.content).toBe("hi");
		expect(late.content).toBe("late system");
		expect(latest.content).toEqual([
			{ type: "text", text: "latest", cache_control: EPHEMERAL },
		]);
	});

	it("marks the trailing image block of a mixed text+image turn", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "sys" },
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,AAAA" },
						},
					],
				},
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const blocks = messagesOf(body)[1].content as Record<string, unknown>[];
		// The breakpoint caches everything BEFORE it — marking the text block
		// would leave the (far more expensive) image outside the cached prefix.
		expect(blocks[0].cache_control).toBeUndefined();
		expect(blocks[1].cache_control).toEqual(EPHEMERAL);
	});

	it("recognizes an existing marker on a trailing image block", () => {
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{
					role: "system",
					content: [
						{ type: "text", text: "sys", cache_control: EPHEMERAL },
					],
				},
				{ role: "user", content: "earlier" },
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,AAAA" },
							cache_control: EPHEMERAL,
						},
					],
				},
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(false);
		const [, earlier, tail] = messagesOf(body);
		expect(earlier.content).toBe("earlier");
		const blocks = tail.content as Record<string, unknown>[];
		expect(blocks[0].cache_control).toBeUndefined();
	});

	it("injects only one breakpoint when three are already spent", () => {
		const marked = (text: string) => ({
			role: "user",
			content: [{ type: "text", text, cache_control: EPHEMERAL }],
		});
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "sys" },
				marked("a"),
				marked("b"),
				marked("c"),
				{ role: "user", content: "latest" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const messages = messagesOf(body);
		// Budget is 4 - 3 = 1: the system prefix wins it, the rolling one is
		// skipped rather than pushing the request to five breakpoints.
		expect(messages[0].content).toEqual([
			{ type: "text", text: "sys", cache_control: EPHEMERAL },
		]);
		expect(messages[4].content).toBe("latest");
	});

	it("counts pre-existing markers inside tool_calls toward the budget", () => {
		const call = (id: string) => ({
			id,
			type: "function",
			function: { name: "t", arguments: "{}" },
			cache_control: EPHEMERAL,
		});
		const body: Record<string, unknown> = {
			model: "databricks-claude-sonnet-4-5",
			messages: [
				{ role: "system", content: "sys" },
				{
					role: "assistant",
					content: null,
					tool_calls: [call("1"), call("2"), call("3")],
				},
				{ role: "tool", tool_call_id: "1", content: "result" },
				{ role: "user", content: "next" },
			],
		};
		expect(applyDatabricksPromptCacheMarkers(body)).toBe(true);
		const messages = messagesOf(body);
		expect(messages[0].content).toEqual([
			{ type: "text", text: "sys", cache_control: EPHEMERAL },
		]);
		// Three markers already on the wire leave room for exactly one more.
		expect(messages[3].content).toBe("next");
	});
});
