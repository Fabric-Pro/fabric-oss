/**
 * When the model call fails, the log line has to carry the fields that tell the
 * causes apart.
 *
 * `generateObject` throws the same sentence — "No object generated: could not
 * parse the response" — whether the model answered in prose, hit a token cap
 * midway through valid JSON, or returned nothing. Those are three different
 * fixes. `NoObjectGeneratedError` distinguishes them via `finishReason`, `usage`
 * and `text`, and all three were being thrown away, which is why the first real
 * runs on staging could not be diagnosed from their own logs.
 *
 * This pins the log payload rather than the runner's control flow: the point of
 * the change is that the evidence reaches the log.
 */

import {
	type FinishReason,
	type LanguageModelUsage,
	NoObjectGeneratedError,
} from "ai";
import { describe, expect, it } from "vitest";
import { modelFailureDetail } from "../run-case";

/**
 * The SDK's constructor requires the full metadata shape. Spelled out once rather
 * than cast away, so a shape change in the SDK fails here loudly instead of
 * quietly degrading what the log carries.
 */
const USAGE: LanguageModelUsage = {
	inputTokens: 3200,
	inputTokenDetails: {
		noCacheTokens: 3200,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	outputTokens: 12,
	outputTokenDetails: { textTokens: 12, reasoningTokens: 0 },
	totalTokens: 3212,
};

const RESPONSE = {
	id: "resp-1",
	timestamp: new Date(0),
	modelId: "test-model",
};

function parseFailure(text: string, finishReason: FinishReason) {
	return new NoObjectGeneratedError({
		message: "No object generated: could not parse the response.",
		text,
		finishReason,
		usage: USAGE,
		response: RESPONSE,
	});
}

describe("modelFailureDetail", () => {
	it("carries finishReason, usage and the raw reply for a parse failure", () => {
		const detail = modelFailureDetail(
			parseFailure("Sure! Here is what I would click…", "stop"),
		);

		expect(detail).toMatchObject({
			errorKind: "NoObjectGeneratedError",
			finishReason: "stop",
			rawReply: "Sure! Here is what I would click…",
			rawReplyLength: 33,
		});
		// `usage` is what settles "was the prompt too big" without guessing.
		expect(detail.usage).toMatchObject({ inputTokens: 3200 });
	});

	it("distinguishes a token cap, which needs a different fix from bad format", () => {
		expect(
			modelFailureDetail(parseFailure('{"kind":"cl', "length")),
		).toMatchObject({ finishReason: "length", rawReply: '{"kind":"cl' });
	});

	it("truncates a huge reply instead of swamping the log line", () => {
		const detail = modelFailureDetail(
			parseFailure("x".repeat(5_000), "stop"),
		);

		// The full length is still reported, so truncation cannot hide the size.
		expect(detail.rawReplyLength).toBe(5_000);
		expect((detail.rawReply as string).length).toBe(2_000);
	});

	it("still names the error kind when it is not a parse failure", () => {
		// A timeout or an auth error must not masquerade as a format problem.
		expect(modelFailureDetail(new TypeError("fetch failed"))).toEqual({
			errorKind: "TypeError",
		});
	});
});
