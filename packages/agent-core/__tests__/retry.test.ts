import { describe, expect, it } from "vitest";
import {
	calculateRetryDelay,
	isJsonParseError,
	isRetryableError,
	RETRY_BASE_DELAY_MS,
	RETRY_MAX_DELAY_MS,
	sleep,
} from "../src/retry";

describe("isJsonParseError", () => {
	it("recognizes a tool-call JSON parse failure", () => {
		expect(
			isJsonParseError(
				new Error("Failed to parse tool call arguments as JSON"),
			),
		).toBe(true);
	});

	it("recognizes an 'Invalid JSON' message", () => {
		expect(isJsonParseError(new Error("Invalid JSON in response"))).toBe(
			true,
		);
	});

	it("recognizes a 'JSON parse error' message", () => {
		expect(
			isJsonParseError(new Error("JSON parse error at position 4")),
		).toBe(true);
	});

	it("returns false for an unrelated error", () => {
		expect(isJsonParseError(new Error("Something else went wrong"))).toBe(
			false,
		);
	});
});

describe("isRetryableError", () => {
	it("is retryable for a JSON parse error", () => {
		expect(isRetryableError(new Error("Invalid JSON"))).toBe(true);
	});

	it("is retryable for a timeout", () => {
		expect(isRetryableError(new Error("Request timeout"))).toBe(true);
	});

	it("is retryable for a rate limit message", () => {
		expect(isRetryableError(new Error("rate limit exceeded"))).toBe(true);
	});

	it("is retryable for a network error", () => {
		expect(isRetryableError(new Error("network error occurred"))).toBe(
			true,
		);
	});

	it("is retryable for ECONNREFUSED", () => {
		expect(isRetryableError(new Error("connect ECONNREFUSED"))).toBe(true);
	});

	it("is NOT retryable for a non-matching error", () => {
		expect(isRetryableError(new Error("Validation failed"))).toBe(false);
	});
});

describe("calculateRetryDelay", () => {
	it("returns RETRY_BASE_DELAY_MS at retryCount 0", () => {
		expect(calculateRetryDelay(0)).toBe(RETRY_BASE_DELAY_MS);
		expect(calculateRetryDelay(0)).toBe(500);
	});

	it("doubles each retry count below the cap", () => {
		expect(calculateRetryDelay(1)).toBe(1000);
		expect(calculateRetryDelay(2)).toBe(2000);
		expect(calculateRetryDelay(3)).toBe(4000);
	});

	it("caps at RETRY_MAX_DELAY_MS beyond the cap", () => {
		expect(calculateRetryDelay(4)).toBe(RETRY_MAX_DELAY_MS);
		expect(calculateRetryDelay(5)).toBe(4000);
		expect(calculateRetryDelay(10)).toBe(4000);
	});
});

describe("sleep", () => {
	it("returns a promise", () => {
		const result = sleep(1);
		expect(result).toBeInstanceOf(Promise);
	});

	it("resolves after the delay", async () => {
		const start = Date.now();
		await sleep(20);
		expect(Date.now() - start).toBeGreaterThanOrEqual(15);
	});
});
