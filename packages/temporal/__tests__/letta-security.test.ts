/**
 * Letta Security Tests
 *
 * Tests for Letta security utilities including:
 * - Agent authorization and ownership validation
 * - Memory block input validation and sanitization
 * - Rate limiting for Letta operations
 * - Multi-tenant isolation verification
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { describe, expect, it, vi } from "vitest";
import {
	LETTA_RATE_LIMITS,
	MAX_CACHE_ENTRY_SIZE,
	MAX_MEMORY_BLOCK_SIZE,
	sanitizeToolResult,
	validateMemoryBlockContent,
} from "../src/activities/letta-security";

// Mock the Letta client
vi.mock("@repo/letta", () => ({
	getLettaClient: vi.fn(() => ({
		getAgent: vi.fn(),
		listIdentities: vi.fn(),
		listAgents: vi.fn(),
	})),
}));

describe("Letta Security Utilities", () => {
	describe("validateMemoryBlockContent", () => {
		it("should pass validation for content within size limits", () => {
			const content = JSON.stringify({ key: "value" });
			const result = validateMemoryBlockContent(content, {
				maxSize: MAX_MEMORY_BLOCK_SIZE,
				blockLabel: "test_block",
			});

			expect(result.valid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("should fail validation for content exceeding size limits", () => {
			// Create content larger than MAX_MEMORY_BLOCK_SIZE (50KB)
			const largeContent = "x".repeat(MAX_MEMORY_BLOCK_SIZE + 1000);
			const result = validateMemoryBlockContent(largeContent, {
				maxSize: MAX_MEMORY_BLOCK_SIZE,
				blockLabel: "test_block",
			});

			expect(result.valid).toBe(false);
			expect(result.errorCode).toBe("INVALID_MEMORY_BLOCK_SIZE");
			expect(result.error).toContain("exceeds size limit");
		});

		it("should fail validation for invalid JSON when requireJson is true", () => {
			const invalidJson = "{ invalid json }";
			const result = validateMemoryBlockContent(invalidJson, {
				requireJson: true,
				blockLabel: "test_block",
			});

			expect(result.valid).toBe(false);
			expect(result.errorCode).toBe("INVALID_MEMORY_BLOCK_CONTENT");
			expect(result.error).toContain("valid JSON");
		});

		it("should pass validation for valid JSON when requireJson is true", () => {
			const validJson = JSON.stringify({
				key: "value",
				nested: { a: 1 },
			});
			const result = validateMemoryBlockContent(validJson, {
				requireJson: true,
				blockLabel: "test_block",
			});

			expect(result.valid).toBe(true);
		});

		it("should use default max size when not specified", () => {
			const content = JSON.stringify({ key: "value" });
			const result = validateMemoryBlockContent(content);

			expect(result.valid).toBe(true);
		});
	});

	describe("sanitizeToolResult", () => {
		const testUserId = "user-123";

		it("should return result as-is when within size limits", () => {
			const result = { data: "small result" };
			const { sanitized, truncated, originalSize } = sanitizeToolResult(
				result,
				testUserId,
			);

			expect(truncated).toBe(false);
			expect(sanitized).toEqual(result);
			expect(originalSize).toBeLessThan(MAX_CACHE_ENTRY_SIZE);
		});

		it("should truncate arrays that exceed size limits", () => {
			// Create an array that will exceed the size limit
			const largeArray = Array.from({ length: 1000 }, (_, i) => ({
				id: i,
				name: `Item ${i}`,
				description: "A".repeat(100),
			}));

			const { sanitized, truncated } = sanitizeToolResult(
				largeArray,
				testUserId,
				{ maxSize: MAX_CACHE_ENTRY_SIZE, truncate: true },
			);

			expect(truncated).toBe(true);
			expect(Array.isArray(sanitized)).toBe(true);
			expect((sanitized as unknown[]).length).toBeLessThan(
				largeArray.length,
			);

			// Should have truncation marker
			const lastItem = (sanitized as unknown[])[
				(sanitized as unknown[]).length - 1
			] as Record<string, unknown>;
			expect(lastItem._truncated).toBe(true);
		});

		it("should redact sensitive fields", () => {
			const result = {
				username: "john",
				password: "secret123",
				apiKey: "key-123",
				token: "bearer-token",
				data: {
					nested_secret: "nested-secret",
					safe_field: "safe",
				},
			};

			const { sanitized } = sanitizeToolResult(result, testUserId);
			const sanitizedObj = sanitized as Record<string, unknown>;

			expect(sanitizedObj.username).toBe("john");
			expect(sanitizedObj.password).toBe("[REDACTED]");
			expect(sanitizedObj.apiKey).toBe("[REDACTED]");
			expect(sanitizedObj.token).toBe("[REDACTED]");

			const nestedData = sanitizedObj.data as Record<string, unknown>;
			expect(nestedData.nested_secret).toBe("[REDACTED]");
			expect(nestedData.safe_field).toBe("safe");
		});

		it("should handle null and undefined values", () => {
			const { sanitized: nullResult } = sanitizeToolResult(
				null,
				testUserId,
			);
			expect(nullResult).toBeNull();

			const { sanitized: undefinedResult } = sanitizeToolResult(
				undefined,
				testUserId,
			);
			expect(undefinedResult).toBeUndefined();
		});

		it("should handle string results", () => {
			const result = "simple string result";
			const { sanitized, truncated } = sanitizeToolResult(
				result,
				testUserId,
			);

			expect(sanitized).toBe(result);
			expect(truncated).toBe(false);
		});

		it("should truncate long strings", () => {
			const longString = "x".repeat(MAX_CACHE_ENTRY_SIZE + 1000);
			const { sanitized, truncated } = sanitizeToolResult(
				longString,
				testUserId,
				{ maxSize: MAX_CACHE_ENTRY_SIZE, truncate: true },
			);

			expect(truncated).toBe(true);
			expect(typeof sanitized).toBe("string");
			expect((sanitized as string).length).toBeLessThan(
				longString.length,
			);
			expect(sanitized as string).toContain("[TRUNCATED]");
		});

		it("should return error object when truncation is disabled and result is too large", () => {
			const largeResult = {
				data: "x".repeat(MAX_CACHE_ENTRY_SIZE + 1000),
			};
			const { sanitized, truncated } = sanitizeToolResult(
				largeResult,
				testUserId,
				{ maxSize: MAX_CACHE_ENTRY_SIZE, truncate: false },
			);

			expect(truncated).toBe(true);
			const sanitizedObj = sanitized as Record<string, unknown>;
			expect(sanitizedObj._error).toBe("Result too large to cache");
		});
	});

	describe("Rate Limit Configurations", () => {
		it("should have correct rate limits for memory read operations", () => {
			expect(LETTA_RATE_LIMITS.memoryRead.limit).toBe(100);
			expect(LETTA_RATE_LIMITS.memoryRead.windowMs).toBe(60_000);
		});

		it("should have correct rate limits for memory write operations", () => {
			expect(LETTA_RATE_LIMITS.memoryWrite.limit).toBe(30);
			expect(LETTA_RATE_LIMITS.memoryWrite.windowMs).toBe(60_000);
		});

		it("should have correct rate limits for tool cache operations", () => {
			expect(LETTA_RATE_LIMITS.toolCache.limit).toBe(50);
			expect(LETTA_RATE_LIMITS.toolCache.windowMs).toBe(60_000);
		});

		it("should have correct rate limits for archival memory operations", () => {
			expect(LETTA_RATE_LIMITS.archival.limit).toBe(20);
			expect(LETTA_RATE_LIMITS.archival.windowMs).toBe(60_000);
		});

		it("should have correct rate limits for agent initialization", () => {
			expect(LETTA_RATE_LIMITS.agentInit.limit).toBe(5);
			expect(LETTA_RATE_LIMITS.agentInit.windowMs).toBe(60_000);
		});
	});

	describe("Constants", () => {
		it("should have correct MAX_MEMORY_BLOCK_SIZE (50KB)", () => {
			expect(MAX_MEMORY_BLOCK_SIZE).toBe(50 * 1024);
		});

		it("should have correct MAX_CACHE_ENTRY_SIZE (10KB)", () => {
			expect(MAX_CACHE_ENTRY_SIZE).toBe(10 * 1024);
		});
	});
});

describe("Sensitive Field Detection", () => {
	const testUserId = "user-123";

	const sensitiveFieldNames = [
		"password",
		"Password",
		"PASSWORD",
		"secret",
		"Secret",
		"SECRET",
		"token",
		"Token",
		"TOKEN",
		"apiKey",
		"api_key",
		"API_KEY",
		"authorization",
		"Authorization",
		"credential",
		"private_key",
	];

	for (const fieldName of sensitiveFieldNames) {
		it(`should redact field named "${fieldName}"`, () => {
			const result = {
				[fieldName]: "sensitive-value",
				safe: "safe-value",
			};
			const { sanitized } = sanitizeToolResult(result, testUserId);
			const sanitizedObj = sanitized as Record<string, unknown>;

			expect(sanitizedObj[fieldName]).toBe("[REDACTED]");
			expect(sanitizedObj.safe).toBe("safe-value");
		});
	}
});

describe("Edge Cases", () => {
	const testUserId = "user-123";

	it("should handle deeply nested objects", () => {
		const deepObject = {
			level1: {
				level2: {
					level3: {
						level4: {
							password: "secret",
							data: "value",
						},
					},
				},
			},
		};

		const { sanitized } = sanitizeToolResult(deepObject, testUserId);
		const sanitizedObj = sanitized as any;

		expect(sanitizedObj.level1.level2.level3.level4.password).toBe(
			"[REDACTED]",
		);
		expect(sanitizedObj.level1.level2.level3.level4.data).toBe("value");
	});

	it("should handle arrays with mixed types", () => {
		const mixedArray = [
			"string",
			123,
			{ password: "secret" },
			[1, 2, 3],
			null,
		];

		const { sanitized } = sanitizeToolResult(mixedArray, testUserId);
		const sanitizedArray = sanitized as unknown[];

		expect(sanitizedArray[0]).toBe("string");
		expect(sanitizedArray[1]).toBe(123);
		expect((sanitizedArray[2] as Record<string, unknown>).password).toBe(
			"[REDACTED]",
		);
		expect(sanitizedArray[3]).toEqual([1, 2, 3]);
		expect(sanitizedArray[4]).toBeNull();
	});

	it("should handle empty objects and arrays", () => {
		const { sanitized: emptyObj } = sanitizeToolResult({}, testUserId);
		expect(emptyObj).toEqual({});

		const { sanitized: emptyArr } = sanitizeToolResult([], testUserId);
		expect(emptyArr).toEqual([]);
	});

	it("should handle boolean and number values", () => {
		const result = { flag: true, count: 42 };
		const { sanitized } = sanitizeToolResult(result, testUserId);

		expect(sanitized).toEqual(result);
	});
});
