import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { findAiUsageLimitError } from "../find-usage-limit-error";

function limitError() {
	return new AiUsageLimitExceededError({
		message: "AI usage limit exceeded",
		limitId: "limit-1",
		dimension: "TOKENS" as never,
		window: "MONTHLY" as never,
		used: BigInt(10),
		max: BigInt(10),
		manageLimitsUrl: "https://example.com/limits",
	});
}

function retryError(errors: unknown[]) {
	return new RetryError({
		message: "Failed after attempts",
		reason: "errorNotRetryable",
		errors,
	});
}

describe("findAiUsageLimitError", () => {
	it("returns an unwrapped limit error as is", () => {
		const limit = limitError();
		expect(findAiUsageLimitError(limit)).toBe(limit);
	});

	it("returns the limit error that is a RetryError's last error", () => {
		const limit = limitError();
		const wrapped = retryError([new Error("transient"), limit]);
		expect(wrapped.lastError).toBe(limit);
		expect(findAiUsageLimitError(wrapped)).toBe(limit);
	});

	it("reads lastError on its own, when the errors list does not carry the limit error", () => {
		const limit = limitError();
		const wrapped = retryError([new Error("transient"), limit]);
		Object.defineProperty(wrapped, "errors", { value: [] });
		expect(findAiUsageLimitError(wrapped)).toBe(limit);
	});

	it("returns a limit error that appears only in a RetryError's errors list", () => {
		const limit = limitError();
		const wrapped = retryError([limit, new Error("later failure")]);
		expect(wrapped.lastError).not.toBe(limit);
		expect(findAiUsageLimitError(wrapped)).toBe(limit);
	});

	it("returns undefined for a RetryError that carries no limit error", () => {
		expect(
			findAiUsageLimitError(retryError([new Error("a"), new Error("b")])),
		).toBeUndefined();
	});

	it("returns undefined for an ordinary error", () => {
		expect(findAiUsageLimitError(new Error("boom"))).toBeUndefined();
	});

	it("does not unwrap anything but the SDK's RetryError", () => {
		const limit = limitError();
		expect(
			findAiUsageLimitError({ lastError: limit, errors: [limit] }),
		).toBeUndefined();
		expect(findAiUsageLimitError(new Error("x", { cause: limit }))).toBe(
			undefined,
		);
		expect(
			findAiUsageLimitError({
				name: "AiUsageLimitExceededError",
				limitId: "limit-1",
			}),
		).toBeUndefined();
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["a string", "AiUsageLimitExceededError"],
		["a number", 429],
		["an object", {}],
	])("returns undefined for %s", (_name, value) => {
		expect(findAiUsageLimitError(value)).toBeUndefined();
	});
});
