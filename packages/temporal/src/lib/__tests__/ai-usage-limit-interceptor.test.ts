/**
 * The worker's activity interceptor that unwraps an AI usage-limit refusal
 * the AI SDK wrapped in a `RetryError`, so the activity fails with the
 * `AiUsageLimitExceededError` type its retry policy names as non-retryable.
 * Its effect on Temporal's retries is pinned in
 * workflows/__tests__/direct-chat-usage-limit.test.ts.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { AiUsageLimitActivityInboundInterceptor } from "../ai-usage-limit-interceptor";

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

function run(activity: () => Promise<unknown>) {
	return new AiUsageLimitActivityInboundInterceptor().execute(
		{ args: [], headers: {} } as never,
		activity as never,
	);
}

describe("AiUsageLimitActivityInboundInterceptor", () => {
	it("rethrows a limit refusal wrapped in a RetryError unwrapped", async () => {
		const limit = limitError();
		await expect(
			run(async () => {
				throw new RetryError({
					message: "Failed after 2 attempts.",
					reason: "errorNotRetryable",
					errors: [new Error("provider overloaded"), limit],
				});
			}),
		).rejects.toBe(limit);
	});

	it("passes a bare limit refusal and every other error through unchanged", async () => {
		const limit = limitError();
		await expect(
			run(async () => {
				throw limit;
			}),
		).rejects.toBe(limit);

		const other = new RetryError({
			message: "Failed after 3 attempts.",
			reason: "maxRetriesExceeded",
			errors: [new Error("provider overloaded")],
		});
		await expect(
			run(async () => {
				throw other;
			}),
		).rejects.toBe(other);
	});

	it("returns the activity's result", async () => {
		await expect(run(async () => "done")).resolves.toBe("done");
	});
});
