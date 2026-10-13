/**
 * The per-request HARD usage-limit check (usage-limit-middleware.ts).
 *
 * Pins, against the real AI SDK request path with mock provider models:
 *  - the check runs before every physical `doGenerate` and `doStream`, the
 *    SDK's retries included;
 *  - a reused model's later request is refused once the limit is reached, and
 *    a refused request (limit or any other check failure) dispatches nothing;
 *  - how a refusal reaches the caller: bare on a step's first attempt, inside
 *    a `RetryError` after a retryable failure (and `findAiUsageLimitError`
 *    unwraps it), and as a stream error part that keeps earlier text in
 *    `streamText`.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import {
	APICallError,
	generateText,
	isStepCount,
	RetryError,
	streamText,
	tool,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findAiUsageLimitError } from "../lib/find-usage-limit-error";
import { wrapModelWithUsageLimits } from "../lib/usage-limit-middleware";

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const TEXT_RESULT = {
	content: [{ type: "text" as const, text: "done" }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

const TOOL_CALL_RESULT = {
	content: [
		{
			type: "tool-call" as const,
			toolCallId: "call-1",
			toolName: "lookup",
			input: "{}",
		},
	],
	finishReason: { unified: "tool-calls" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

function textStream(text: string) {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
				{ type: "text-start" as const, id: "t1" },
				{ type: "text-delta" as const, id: "t1", delta: text },
				{ type: "text-end" as const, id: "t1" },
				{
					type: "finish" as const,
					finishReason: { unified: "stop" as const, raw: undefined },
					usage: USAGE,
				},
			],
		}),
	};
}

/** Step 1 of a tool turn: some text, then a tool call. */
function textThenToolCallStream() {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
				{ type: "text-start" as const, id: "t1" },
				{
					type: "text-delta" as const,
					id: "t1",
					delta: "Looking that up. ",
				},
				{ type: "text-end" as const, id: "t1" },
				{
					type: "tool-call" as const,
					toolCallId: "call-1",
					toolName: "lookup",
					input: "{}",
				},
				{
					type: "finish" as const,
					finishReason: {
						unified: "tool-calls" as const,
						raw: undefined,
					},
					usage: USAGE,
				},
			],
		}),
	};
}

const tools = {
	lookup: tool({
		inputSchema: z.object({}),
		execute: async () => ({ found: true }),
	}),
};

function limitError() {
	return new AiUsageLimitExceededError({
		message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
		limitId: "limit-1",
		dimension: "TOKENS" as never,
		window: "MONTHLY" as never,
		used: BigInt(100),
		max: BigInt(100),
		manageLimitsUrl: "https://example.com/limits",
	});
}

function retryableProviderError() {
	return new APICallError({
		message: "provider overloaded",
		url: "https://provider.example.com/v1",
		requestBodyValues: {},
		statusCode: 503,
		isRetryable: true,
	});
}

/** A limit check that passes `allowed` times and then throws `refusal`. */
function makeCheck(allowed: number, refusal: Error = limitError()) {
	let remaining = allowed;
	return vi.fn(async () => {
		if (remaining <= 0) {
			throw refusal;
		}
		remaining -= 1;
	});
}

describe("wrapModelWithUsageLimits", () => {
	it("checks before every physical doGenerate, the SDK's retry included", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				if (calls === 1) {
					throw retryableProviderError();
				}
				return TEXT_RESULT;
			},
		});
		const check = makeCheck(Number.POSITIVE_INFINITY);
		const model = wrapModelWithUsageLimits(provider, check);

		const result = await generateText({
			model,
			prompt: "Hi",
			maxRetries: 1,
		});

		expect(result.text).toBe("done");
		expect(provider.doGenerateCalls).toHaveLength(2);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("checks before every doStream, once per step", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doStream: async () => {
				calls += 1;
				return calls === 1
					? textThenToolCallStream()
					: textStream("Found it.");
			},
		});
		const check = makeCheck(Number.POSITIVE_INFINITY);
		const model = wrapModelWithUsageLimits(provider, check);

		const result = streamText({
			model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(2),
		});

		expect(await result.text).toBe("Found it.");
		expect(provider.doStreamCalls).toHaveLength(2);
		expect(check).toHaveBeenCalledTimes(2);
	});

	it("refuses a reused model's later request once the limit is reached, dispatching nothing", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => TEXT_RESULT,
		});
		const refusal = limitError();
		const check = makeCheck(1, refusal);
		const model = wrapModelWithUsageLimits(provider, check);

		await generateText({ model, prompt: "first", maxRetries: 0 });
		const error = await generateText({
			model,
			prompt: "second",
			maxRetries: 0,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(refusal);
		expect(check).toHaveBeenCalledTimes(2);
		expect(provider.doGenerateCalls).toHaveLength(1);
	});

	it("propagates a check failure that is not a limit, without dispatching", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => TEXT_RESULT,
		});
		const outage = new Error("database unavailable");
		const model = wrapModelWithUsageLimits(provider, makeCheck(0, outage));

		const error = await generateText({
			model,
			prompt: "Hi",
			maxRetries: 0,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(outage);
		expect(findAiUsageLimitError(error)).toBeUndefined();
		expect(provider.doGenerateCalls).toHaveLength(0);
	});

	it("throws a refusal on a later step's first attempt bare", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				return calls === 1 ? TOOL_CALL_RESULT : TEXT_RESULT;
			},
		});
		const refusal = limitError();
		const model = wrapModelWithUsageLimits(provider, makeCheck(1, refusal));

		const error = await generateText({
			model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(5),
			maxRetries: 2,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(refusal);
		// Step 1 ran; step 2 was refused before it reached the provider.
		expect(provider.doGenerateCalls).toHaveLength(1);
	});

	it("throws a refusal after a retryable failure inside a RetryError that findAiUsageLimitError unwraps", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				if (calls === 1) {
					return TOOL_CALL_RESULT;
				}
				// Step 2's first attempt fails retryably.
				throw retryableProviderError();
			},
		});
		const refusal = limitError();
		// Step 1 and step 2's first attempt pass; the retry is refused.
		const model = wrapModelWithUsageLimits(provider, makeCheck(2, refusal));

		const error = await generateText({
			model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(5),
			maxRetries: 2,
		}).catch((caught: unknown) => caught);

		expect(RetryError.isInstance(error)).toBe(true);
		expect(error).not.toBeInstanceOf(AiUsageLimitExceededError);
		expect(findAiUsageLimitError(error)).toBe(refusal);
		expect(provider.doGenerateCalls).toHaveLength(2);
	});

	it("ends a multi-step stream with an error part carrying the refusal, keeping step 1's text", async () => {
		const provider = new MockLanguageModelV4({
			doStream: async () => textThenToolCallStream(),
		});
		const refusal = limitError();
		const model = wrapModelWithUsageLimits(provider, makeCheck(1, refusal));
		const onError = vi.fn();

		const result = streamText({
			model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(5),
			onError,
		});

		let text = "";
		const errors: unknown[] = [];
		for await (const part of result.stream) {
			if (part.type === "text-delta") {
				text += part.text;
			} else if (part.type === "error") {
				errors.push(part.error);
			}
		}

		expect(text).toBe("Looking that up. ");
		expect(errors.map(findAiUsageLimitError)).toEqual([refusal]);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(findAiUsageLimitError(onError.mock.calls[0]?.[0]?.error)).toBe(
			refusal,
		);
		expect(provider.doStreamCalls).toHaveLength(1);
		// Step 1's results stay readable after the refusal.
		expect((await result.steps).map((step) => step.text)).toEqual([
			"Looking that up. ",
		]);
	});
});
