import { stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEmptyToolInputRepairMiddleware } from "../lib/empty-tool-input-middleware";

/**
 * `@ai-sdk/openai@3` only emits `tool-call` once a streamed tool call's
 * accumulated `arguments` parse as JSON, and its `flush` — unlike
 * `@ai-sdk/openai-compatible` — does not emit the calls left unfinished. A
 * no-parameter tool arrives as `arguments: ""`, which never parses, so the
 * call is dropped: `tool-input-start` and then nothing. `execute` never runs.
 *
 * These tests drive the real `streamText` loop through a mock provider that
 * reproduces that chunk sequence, so they pin the behaviour that matters —
 * whether the tool actually runs — rather than the shape of the stream.
 */

const PARTS_WITHOUT_CALL = [
	{ type: "stream-start" as const, warnings: [] },
	{ type: "tool-input-start" as const, id: "c1", toolName: "ping" },
	{
		type: "finish" as const,
		finishReason: "tool-calls" as const,
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
	},
];

function mockModel(chunks: unknown[]) {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: simulateReadableStream({ chunks: chunks as never }),
		}),
	});
}

async function runWith(chunks: unknown[], repair: boolean) {
	const inputs: unknown[] = [];
	const base = mockModel(chunks);
	const model = repair
		? wrapLanguageModel({
				model: base,
				middleware: createEmptyToolInputRepairMiddleware(),
			})
		: base;

	const result = streamText({
		model,
		stopWhen: stepCountIs(1),
		messages: [{ role: "user", content: "go" }],
		tools: {
			ping: tool({
				inputSchema: z.object({}).passthrough(),
				execute: async (input) => {
					inputs.push(input);
					return { ok: true };
				},
			}),
		},
	});

	for await (const _ of result.fullStream) {
		// drain
	}
	return inputs;
}

describe("empty tool input repair", () => {
	it("reproduces the drop without the middleware", async () => {
		// Guards the premise: if the provider is ever fixed upstream this
		// fails, and the middleware can be removed rather than kept forever.
		expect(await runWith(PARTS_WITHOUT_CALL, false)).toEqual([]);
	});

	it("runs a no-parameter tool that the provider dropped", async () => {
		expect(await runWith(PARTS_WITHOUT_CALL, true)).toEqual([{}]);
	});

	/**
	 * The shape production actually sends, and the one the first version of
	 * this middleware missed. After the first chunk the provider enqueues
	 * `tool-input-delta` unconditionally as `delta: arguments ?? ""`, so a
	 * no-parameter call arrives WITH deltas — empty ones. Keying off "a delta
	 * arrived" made the middleware a silent no-op on the deployed worker while
	 * every local test passed.
	 */
	const PARTS_WITH_EMPTY_DELTAS = [
		{ type: "stream-start" as const, warnings: [] },
		{ type: "tool-input-start" as const, id: "c1", toolName: "ping" },
		{ type: "tool-input-delta" as const, id: "c1", delta: "" },
		{ type: "tool-input-delta" as const, id: "c1", delta: "" },
		{
			type: "finish" as const,
			finishReason: "tool-calls" as const,
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		},
	];

	it("reproduces the drop when the provider sends empty deltas", async () => {
		expect(await runWith(PARTS_WITH_EMPTY_DELTAS, false)).toEqual([]);
	});

	it("runs a no-parameter tool whose deltas were all empty", async () => {
		expect(await runWith(PARTS_WITH_EMPTY_DELTAS, true)).toEqual([{}]);
	});

	it("ignores whitespace-only deltas the same way", async () => {
		const whitespace = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-input-start", id: "c1", toolName: "ping" },
			{ type: "tool-input-delta", id: "c1", delta: "  \n" },
			{
				type: "finish",
				finishReason: "tool-calls",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			},
		];

		expect(await runWith(whitespace, true)).toEqual([{}]);
	});

	it("leaves a normally-emitted call untouched", async () => {
		const withCall = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-input-start", id: "c1", toolName: "ping" },
			{ type: "tool-input-delta", id: "c1", delta: '{"a":1}' },
			{ type: "tool-input-end", id: "c1" },
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "ping",
				input: '{"a":1}',
			},
			{
				type: "finish",
				finishReason: "tool-calls",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			},
		];

		expect(await runWith(withCall, true)).toEqual([{ a: 1 }]);
	});

	it("does not invent arguments for a genuinely truncated call", async () => {
		// Deltas started and stopped mid-JSON. Synthesising `{}` here would
		// run the tool with arguments the model never chose.
		const truncated = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-input-start", id: "c1", toolName: "ping" },
			{ type: "tool-input-delta", id: "c1", delta: '{"a":' },
			{
				type: "finish",
				finishReason: "length",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			},
		];

		expect(await runWith(truncated, true)).toEqual([]);
	});
});
