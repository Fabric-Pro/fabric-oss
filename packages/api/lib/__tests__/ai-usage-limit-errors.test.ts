/**
 * `domainErrorMapper` maps a HARD usage-limit refusal to
 * `AI_USAGE_LIMIT_EXCEEDED` through `aiUsageLimitToORPCError`. A model checks
 * the limits again before each request it sends, and a refusal of an AI SDK
 * retry reaches the procedure inside a `RetryError`: it must map the same as
 * a bare one, not fall through to INTERNAL_SERVER_ERROR.
 */
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { aiUsageLimitToORPCError } from "../ai-usage-limit-errors";

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

const PAYLOAD = {
	limitId: "limit-1",
	dimension: "TOKENS",
	window: "MONTHLY",
	used: "100",
	max: "100",
	manageLimitsUrl: "https://example.com/limits",
};

describe("aiUsageLimitToORPCError", () => {
	it("maps a bare limit refusal", () => {
		const mapped = aiUsageLimitToORPCError(limitError());

		expect(mapped?.code).toBe("AI_USAGE_LIMIT_EXCEEDED");
		expect(mapped?.message).toBe(limitError().message);
		expect(mapped?.data).toEqual(PAYLOAD);
	});

	it("maps a limit refusal of an SDK retry, inside a RetryError", () => {
		const wrapped = new RetryError({
			message: "Failed after 2 attempts.",
			reason: "errorNotRetryable",
			errors: [new Error("provider overloaded"), limitError()],
		});

		const mapped = aiUsageLimitToORPCError(wrapped);

		expect(mapped?.code).toBe("AI_USAGE_LIMIT_EXCEEDED");
		expect(mapped?.data).toEqual(PAYLOAD);
	});

	it("leaves every other error to the caller", () => {
		expect(aiUsageLimitToORPCError(new Error("boom"))).toBeNull();
		expect(
			aiUsageLimitToORPCError(
				new RetryError({
					message: "Failed after 3 attempts.",
					reason: "maxRetriesExceeded",
					errors: [new Error("provider overloaded")],
				}),
			),
		).toBeNull();
	});
});
