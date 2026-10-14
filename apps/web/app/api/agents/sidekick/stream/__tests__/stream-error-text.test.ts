/**
 * The Sidekick's UI message stream reports a usage-limit refusal that ends a
 * multi-step turn as the limit payload, not the SDK's masked "An error
 * occurred.".
 *
 * Runs the real `streamText` multi-step loop and `toUIMessageStream` with the
 * route's `onError`, over a mock model wrapped in the real per-request limit
 * check: step 1 streams text and calls a tool, step 2's request is refused.
 */

import { isStepCount, streamText, tool, toUIMessageStream } from "@repo/ai";
import { wrapModelWithUsageLimits } from "@repo/ai/lib/usage-limit-middleware";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { isAiUsageLimitExceededPayload } from "@saas/payments/lib/ai-usage-limit-toast";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	SIDEKICK_STREAM_ERROR_TEXT,
	sidekickStreamErrorText,
} from "../stream-error-text";

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textThenToolCall() {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "stream-start" as const, warnings: [] },
				{ type: "text-start" as const, id: "t1" },
				{ type: "text-delta" as const, id: "t1", delta: "Updating. " },
				{ type: "text-end" as const, id: "t1" },
				{
					type: "tool-call" as const,
					toolCallId: "call-1",
					toolName: "updateField",
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

/** Run a turn whose second step's check throws `refusal`; return the UI chunks. */
async function runTurn(refusal: Error) {
	let checks = 0;
	const model = wrapModelWithUsageLimits(
		new MockLanguageModelV4({ doStream: async () => textThenToolCall() }),
		async () => {
			checks += 1;
			if (checks > 1) {
				throw refusal;
			}
		},
	);
	const result = streamText({
		model,
		prompt: "Rename the agent",
		tools: {
			updateField: tool({
				inputSchema: z.object({}),
				execute: async () => ({ ok: true }),
			}),
		},
		stopWhen: isStepCount(5),
		onError: () => {},
	});
	const chunks: Array<{ type: string; delta?: string; errorText?: string }> =
		[];
	const reader = toUIMessageStream({
		stream: result.stream,
		onError: sidekickStreamErrorText,
	}).getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value as (typeof chunks)[number]);
	}
	return chunks;
}

describe("sidekickStreamErrorText", () => {
	it("sends a step's limit refusal as the limit payload, after the text already streamed", async () => {
		const limit = limitError();
		const chunks = await runTurn(limit);

		const text = chunks
			.filter((chunk) => chunk.type === "text-delta")
			.map((chunk) => chunk.delta)
			.join("");
		expect(text).toBe("Updating. ");

		const errors = chunks.filter((chunk) => chunk.type === "error");
		expect(errors).toHaveLength(1);
		const body = JSON.parse(errors[0]?.errorText ?? "null") as {
			error?: string;
			code?: string;
			data?: unknown;
		};
		expect(body).toEqual({
			error: limit.message,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			data: {
				limitId: "limit-1",
				dimension: "TOKENS",
				window: "MONTHLY",
				used: "100",
				max: "100",
				manageLimitsUrl: "https://example.com/limits",
			},
		});
		// The shape the client's limit toast accepts.
		expect(isAiUsageLimitExceededPayload(body.data)).toBe(true);
	});

	it("keeps every other stream error masked", async () => {
		const chunks = await runTurn(
			new Error("internal detail that must not leak"),
		);

		const errors = chunks.filter((chunk) => chunk.type === "error");
		expect(errors.map((chunk) => chunk.errorText)).toEqual([
			SIDEKICK_STREAM_ERROR_TEXT,
		]);
	});
});
