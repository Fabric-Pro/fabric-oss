/**
 * Unit tests for graphRequest's transient-failure retry policy: which statuses
 * are retried (isRetryableGraphStatus) and how long it waits between attempts
 * (computeGraphThrottleBackoffMs).
 */

import { describe, expect, it, vi } from "vitest";

// microsoft/index.ts statically imports these; stub them so importing the
// module under test stays light (no DB / LLM stack).
vi.mock("@repo/database", () => ({
	db: { workflowIntegration: { findFirst: vi.fn(), update: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));
vi.mock("@repo/ai", () => ({ extractRelevantExcerpts: vi.fn() }));

import {
	computeGraphThrottleBackoffMs,
	isRetryableGraphStatus,
} from "../index";

describe("computeGraphThrottleBackoffMs", () => {
	it("honors a sane Retry-After header (seconds → ms)", () => {
		expect(computeGraphThrottleBackoffMs("5", 0)).toBe(5000);
		// Header wins over the exponential schedule.
		expect(computeGraphThrottleBackoffMs("1", 2)).toBe(1000);
	});

	it("caps Retry-After at 15s to protect the activity timeout", () => {
		expect(computeGraphThrottleBackoffMs("120", 0)).toBe(15000);
	});

	it("falls back to exponential backoff (1s, 2s, 4s) without a usable header", () => {
		expect(computeGraphThrottleBackoffMs(null, 0)).toBe(1000);
		expect(computeGraphThrottleBackoffMs(null, 1)).toBe(2000);
		expect(computeGraphThrottleBackoffMs(null, 2)).toBe(4000);
		expect(computeGraphThrottleBackoffMs("not-a-number", 0)).toBe(1000);
		expect(computeGraphThrottleBackoffMs("0", 0)).toBe(1000);
		expect(computeGraphThrottleBackoffMs("-3", 0)).toBe(1000);
	});

	it("caps exponential backoff at 8s", () => {
		expect(computeGraphThrottleBackoffMs(null, 5)).toBe(8000);
	});
});

describe("isRetryableGraphStatus", () => {
	it("retries throttling statuses regardless of method", () => {
		for (const status of [429, 503]) {
			expect(isRetryableGraphStatus(status)).toBe(true);
			expect(isRetryableGraphStatus(status, "GET")).toBe(true);
			expect(isRetryableGraphStatus(status, "POST")).toBe(true);
			expect(isRetryableGraphStatus(status, "DELETE")).toBe(true);
		}
	});

	it("retries gateway failures on reads (issue #2859)", () => {
		// A 502 from Graph's front door dropped a transcript fetch in prod.
		for (const status of [502, 504]) {
			// No method — fetch defaults to GET.
			expect(isRetryableGraphStatus(status)).toBe(true);
			expect(isRetryableGraphStatus(status, "GET")).toBe(true);
			expect(isRetryableGraphStatus(status, "get")).toBe(true);
			expect(isRetryableGraphStatus(status, "HEAD")).toBe(true);
		}
	});

	it("does not replay writes on a gateway failure", () => {
		// The front door can fail after the backend applied the write, so a
		// retry could post the same Teams message twice.
		for (const status of [502, 504]) {
			expect(isRetryableGraphStatus(status, "POST")).toBe(false);
			expect(isRetryableGraphStatus(status, "PATCH")).toBe(false);
			expect(isRetryableGraphStatus(status, "PUT")).toBe(false);
			expect(isRetryableGraphStatus(status, "DELETE")).toBe(false);
		}
	});

	it("leaves client errors and success to the caller", () => {
		for (const status of [200, 201, 400, 401, 403, 404, 409, 500, 501]) {
			expect(isRetryableGraphStatus(status, "GET")).toBe(false);
		}
	});
});
