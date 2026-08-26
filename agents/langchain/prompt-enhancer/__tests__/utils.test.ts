/**
 * Utils Module Tests
 *
 * Tests for utility functions and constants.
 */

import { describe, expect, it } from "vitest";
import {
	calculateRetryDelay,
	DEFAULT_RECURSION_LIMIT,
	extractProviderConfig,
	getAgentModel,
	isJsonParseError,
	MAX_JSON_RETRIES,
	MAX_RETRIES,
	sleep,
} from "../utils";

describe("DEFAULT_RECURSION_LIMIT", () => {
	it("should be a number", () => {
		expect(typeof DEFAULT_RECURSION_LIMIT).toBe("number");
	});

	it("should be a positive integer", () => {
		expect(DEFAULT_RECURSION_LIMIT).toBeGreaterThan(0);
		expect(Number.isInteger(DEFAULT_RECURSION_LIMIT)).toBe(true);
	});

	it("should be 25", () => {
		expect(DEFAULT_RECURSION_LIMIT).toBe(25);
	});

	it("should be reasonable for graph execution", () => {
		expect(DEFAULT_RECURSION_LIMIT).toBeGreaterThanOrEqual(10);
		expect(DEFAULT_RECURSION_LIMIT).toBeLessThanOrEqual(100);
	});
});

describe("getAgentModel", () => {
	it("should be a function", () => {
		expect(typeof getAgentModel).toBe("function");
	});

	it("should require runtime AI provider configuration", () => {
		// Agents are stateless and must receive config at runtime
		expect(() => getAgentModel()).toThrow("No AI provider configured");
	});

	it("should require ai_api_key in configurable", () => {
		expect(() => getAgentModel({ configurable: {} })).toThrow(
			"No AI provider configured",
		);
	});
});

describe("extractProviderConfig", () => {
	it("should be a function", () => {
		expect(typeof extractProviderConfig).toBe("function");
	});

	it("should return undefined when no config", () => {
		expect(extractProviderConfig()).toBeUndefined();
		expect(extractProviderConfig(null)).toBeUndefined();
	});

	it("should extract provider config from configurable", () => {
		const config = {
			configurable: {
				ai_api_key: "test-key",
				ai_model: "test-model",
				ai_gateway_url: "https://test.com",
			},
		};
		const result = extractProviderConfig(config);
		expect(result).toBeDefined();
		expect(result?.apiKey).toBe("test-key");
		expect(result?.model).toBe("test-model");
		expect(result?.baseUrl).toBe("https://test.com");
	});
});

describe("isJsonParseError", () => {
	it("should return true for JSON parse errors", () => {
		const error = new Error("Failed to parse tool call arguments as JSON");
		expect(isJsonParseError(error)).toBe(true);
	});

	it("should return true for Invalid JSON errors", () => {
		const error = new Error("Invalid JSON");
		expect(isJsonParseError(error)).toBe(true);
	});

	it("should return false for non-JSON errors", () => {
		const error = new Error("timeout");
		expect(isJsonParseError(error)).toBe(false);
	});
});

describe("calculateRetryDelay", () => {
	it("should return base delay for first retry", () => {
		expect(calculateRetryDelay(0)).toBe(500);
	});

	it("should double delay for each retry", () => {
		expect(calculateRetryDelay(1)).toBe(1000);
		expect(calculateRetryDelay(2)).toBe(2000);
	});

	it("should cap at 4000ms", () => {
		expect(calculateRetryDelay(10)).toBe(4000);
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
});

describe("Module exports", () => {
	it("should export DEFAULT_RECURSION_LIMIT", () => {
		expect(DEFAULT_RECURSION_LIMIT).toBeDefined();
	});

	it("should export MAX_RETRIES", () => {
		expect(MAX_RETRIES).toBe(3);
	});

	it("should export MAX_JSON_RETRIES", () => {
		expect(MAX_JSON_RETRIES).toBe(4);
	});

	it("should export getAgentModel", () => {
		expect(getAgentModel).toBeDefined();
	});

	it("should export extractProviderConfig", () => {
		expect(extractProviderConfig).toBeDefined();
	});
});
