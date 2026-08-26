/**
 * Tests for Request Correlation ID functionality
 * Validates ID generation, extraction, and propagation
 */

import {
	extractCorrelationId,
	generateCorrelationId,
	getCorrelationHeaders,
	getCorrelationIdFromContext,
	runWithCorrelationId,
} from "@repo/api/lib/correlation-id";
import { describe, expect, it } from "vitest";

describe("Correlation ID", () => {
	describe("ID Generation", () => {
		it("should generate unique IDs", () => {
			const ids = new Set<string>();

			for (let i = 0; i < 100; i++) {
				ids.add(generateCorrelationId());
			}

			expect(ids.size).toBe(100);
		});

		it("should generate IDs with correct format", () => {
			const id = generateCorrelationId();

			expect(id).toMatch(/^req_[a-z0-9]+_[a-z0-9]+$/);
		});

		it("should generate IDs starting with req_ prefix", () => {
			const id = generateCorrelationId();

			expect(id.startsWith("req_")).toBe(true);
		});
	});

	describe("ID Extraction from Headers", () => {
		it("should extract X-Correlation-ID header", () => {
			const headers = new Headers();
			headers.set("X-Correlation-ID", "test-correlation-123");

			const id = extractCorrelationId(headers);

			expect(id).toBe("test-correlation-123");
		});

		it("should extract X-Request-ID header as fallback", () => {
			const headers = new Headers();
			headers.set("X-Request-ID", "test-request-456");

			const id = extractCorrelationId(headers);

			expect(id).toBe("test-request-456");
		});

		it("should extract X-Trace-ID header as fallback", () => {
			const headers = new Headers();
			headers.set("X-Trace-ID", "test-trace-789");

			const id = extractCorrelationId(headers);

			expect(id).toBe("test-trace-789");
		});

		it("should prefer X-Correlation-ID over other headers", () => {
			const headers = new Headers();
			headers.set("X-Correlation-ID", "correlation");
			headers.set("X-Request-ID", "request");
			headers.set("X-Trace-ID", "trace");

			const id = extractCorrelationId(headers);

			expect(id).toBe("correlation");
		});

		it("should return null when no correlation header present", () => {
			const headers = new Headers();
			headers.set("Content-Type", "application/json");

			const id = extractCorrelationId(headers);

			expect(id).toBeNull();
		});

		it("should extract trace-id from W3C traceparent header", () => {
			const headers = new Headers();
			// W3C Trace Context format: version-trace_id-parent_id-flags
			headers.set(
				"traceparent",
				"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			);

			const id = extractCorrelationId(headers);

			expect(id).toBe("0af7651916cd43dd8448eb211c80319c");
		});
	});

	describe("Correlation Headers", () => {
		it("should create headers with correlation ID", () => {
			const headers = getCorrelationHeaders("my-custom-id");

			expect(headers["X-Correlation-ID"]).toBe("my-custom-id");
		});

		it("should generate new ID when not provided", () => {
			const headers = getCorrelationHeaders();

			expect(headers["X-Correlation-ID"]).toMatch(/^req_/);
		});
	});

	describe("Async Local Storage Context", () => {
		it("should store and retrieve correlation ID in async context", async () => {
			const testId = "async-test-123";

			const result = await runWithCorrelationId(testId, async () => {
				return getCorrelationIdFromContext();
			});

			expect(result).toBe(testId);
		});

		it("should return undefined outside of context", () => {
			const id = getCorrelationIdFromContext();

			expect(id).toBeUndefined();
		});

		it("should maintain context across async operations", async () => {
			const testId = "nested-async-456";

			const result = await runWithCorrelationId(testId, async () => {
				// Simulate async operations
				await new Promise((resolve) => setTimeout(resolve, 10));
				const mid = getCorrelationIdFromContext();

				await new Promise((resolve) => setTimeout(resolve, 10));
				const end = getCorrelationIdFromContext();

				return { mid, end };
			});

			expect(result.mid).toBe(testId);
			expect(result.end).toBe(testId);
		});

		it("should isolate contexts for parallel requests", async () => {
			const results = await Promise.all([
				runWithCorrelationId("request-1", async () => {
					await new Promise((resolve) =>
						setTimeout(resolve, Math.random() * 50),
					);
					return getCorrelationIdFromContext();
				}),
				runWithCorrelationId("request-2", async () => {
					await new Promise((resolve) =>
						setTimeout(resolve, Math.random() * 50),
					);
					return getCorrelationIdFromContext();
				}),
				runWithCorrelationId("request-3", async () => {
					await new Promise((resolve) =>
						setTimeout(resolve, Math.random() * 50),
					);
					return getCorrelationIdFromContext();
				}),
			]);

			expect(results).toEqual(["request-1", "request-2", "request-3"]);
		});
	});
});
