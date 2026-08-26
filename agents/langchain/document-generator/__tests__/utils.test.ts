/**
 * Unit tests for Document Generator Utils Module
 */

import { describe, expect, it } from "vitest";
import {
	calculateRetryDelay,
	DEFAULT_RECURSION_LIMIT,
	getAgentModel,
	isJsonParseError,
	isRetryableError,
	MAX_RETRIES,
	RETRY_DELAY_MS,
	sleep,
} from "../utils";

describe("Utils Module", () => {
	describe("Constants", () => {
		it("should have DEFAULT_RECURSION_LIMIT defined", () => {
			expect(DEFAULT_RECURSION_LIMIT).toBe(25);
		});

		it("should have MAX_RETRIES defined", () => {
			expect(MAX_RETRIES).toBe(3);
		});

		it("should have RETRY_DELAY_MS defined", () => {
			expect(RETRY_DELAY_MS).toBe(1000);
		});
	});

	describe("getAgentModel", () => {
		it("should be a function", () => {
			expect(typeof getAgentModel).toBe("function");
		});

		it("should throw when no AI config is available", () => {
			// getAgentModel requires config.configurable to have ai_api_key
			expect(() => getAgentModel(undefined, {})).toThrow(
				"No AI provider configured",
			);
		});
	});

	describe("isRetryableError", () => {
		it("should return true for JSON parse errors", () => {
			const error = new Error(
				"Failed to parse tool call arguments as JSON",
			);
			expect(isRetryableError(error)).toBe(true);
		});

		it("should return true for Invalid JSON errors", () => {
			const error = new Error("Invalid JSON response");
			expect(isRetryableError(error)).toBe(true);
		});

		it("should return true for timeout errors", () => {
			const error = new Error("Request timeout");
			expect(isRetryableError(error)).toBe(true);
		});

		it("should return true for rate limit errors", () => {
			const error = new Error("rate limit exceeded");
			expect(isRetryableError(error)).toBe(true);
		});

		it("should return true for network errors", () => {
			const error = new Error("network error");
			expect(isRetryableError(error)).toBe(true);
		});

		it("should return true for ECONNREFUSED errors", () => {
			const error = new Error("ECONNREFUSED");
			expect(isRetryableError(error)).toBe(true);
		});

		it("should return false for other errors", () => {
			const error = new Error("Unknown error");
			expect(isRetryableError(error)).toBe(false);
		});
	});

	describe("isJsonParseError", () => {
		it("should return true for JSON parse errors", () => {
			const error = new Error(
				"Failed to parse tool call arguments as JSON",
			);
			expect(isJsonParseError(error)).toBe(true);
		});

		it("should return true for Invalid JSON errors", () => {
			const error = new Error("Invalid JSON");
			expect(isJsonParseError(error)).toBe(true);
		});

		it("should return true for JSON parse error messages", () => {
			const error = new Error("JSON parse error: unexpected token");
			expect(isJsonParseError(error)).toBe(true);
		});

		it("should return false for non-JSON errors", () => {
			const error = new Error("timeout");
			expect(isJsonParseError(error)).toBe(false);
		});
	});

	describe("calculateRetryDelay", () => {
		it("should return base delay for first retry", () => {
			expect(calculateRetryDelay(0)).toBe(1000); // 1000 * 2^0
		});

		it("should double delay for each retry", () => {
			expect(calculateRetryDelay(1)).toBe(2000); // 1000 * 2^1
			expect(calculateRetryDelay(2)).toBe(4000); // 1000 * 2^2
			expect(calculateRetryDelay(3)).toBe(8000); // 1000 * 2^3
		});

		it("should handle high retry counts", () => {
			expect(calculateRetryDelay(5)).toBe(32000); // 1000 * 2^5
		});
	});

	describe("sleep", () => {
		it("should be a function", () => {
			expect(typeof sleep).toBe("function");
		});

		it("should return a promise", () => {
			const result = sleep(1);
			expect(result).toBeInstanceOf(Promise);
		});

		it("should resolve after specified time", async () => {
			const start = Date.now();
			await sleep(50);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
		});
	});
});
