/**
 * Tests for the oRPC request-counter middleware.
 *
 * Exercises the pure helper functions and `recordRequest` directly. No
 * oRPC framework plumbing is needed — the middleware itself is a thin
 * wrapper around `recordRequest`. No mocks for prom-client: we read from
 * the real shared registry.
 */

import { httpRequestsTotal, register } from "@repo/observability";
import { beforeEach, describe, expect, it } from "vitest";
import {
	normalizeMethod,
	recordRequest,
	renderRouteLabel,
	statusCodeFromOrpcError,
} from "../orpc/middleware/request-counter-middleware";

beforeEach(() => {
	httpRequestsTotal.reset();
});

describe("normalizeMethod", () => {
	it("defaults to POST when method is undefined", () => {
		expect(normalizeMethod(undefined)).toBe("POST");
	});

	it("uppercases lowercase methods", () => {
		expect(normalizeMethod("get")).toBe("GET");
		expect(normalizeMethod("post")).toBe("POST");
	});

	it("preserves the standard verbs", () => {
		expect(normalizeMethod("GET")).toBe("GET");
		expect(normalizeMethod("PUT")).toBe("PUT");
		expect(normalizeMethod("PATCH")).toBe("PATCH");
		expect(normalizeMethod("DELETE")).toBe("DELETE");
	});

	it("collapses unknown verbs to OTHER", () => {
		expect(normalizeMethod("CONNECT")).toBe("OTHER");
		expect(normalizeMethod("XOXO")).toBe("OTHER");
	});
});

describe("statusCodeFromOrpcError", () => {
	it("returns '2xx' should never be called for success — but verifies it doesn't crash on missing input", () => {
		// The function is only called in the error path; verifying its
		// behaviour with empty input is just a guard against future
		// callers misusing it.
		expect(statusCodeFromOrpcError(null)).toBe("5xx");
		expect(statusCodeFromOrpcError(undefined)).toBe("5xx");
	});

	it("reads a numeric .status property when present", () => {
		expect(statusCodeFromOrpcError({ status: 200 })).toBe("2xx");
		expect(statusCodeFromOrpcError({ status: 301 })).toBe("3xx");
		expect(statusCodeFromOrpcError({ status: 404 })).toBe("4xx");
		expect(statusCodeFromOrpcError({ status: 503 })).toBe("5xx");
	});

	it("maps oRPC UNAUTHORIZED code to 4xx", () => {
		expect(statusCodeFromOrpcError({ code: "UNAUTHORIZED" })).toBe("4xx");
	});

	it("maps oRPC FORBIDDEN code to 4xx", () => {
		expect(statusCodeFromOrpcError({ code: "FORBIDDEN" })).toBe("4xx");
	});

	it("maps oRPC NOT_FOUND code to 4xx", () => {
		expect(statusCodeFromOrpcError({ code: "NOT_FOUND" })).toBe("4xx");
	});

	it("maps oRPC TOO_MANY_REQUESTS code to 4xx", () => {
		expect(statusCodeFromOrpcError({ code: "TOO_MANY_REQUESTS" })).toBe(
			"4xx",
		);
	});

	it("falls back to 5xx for unrecognized errors", () => {
		expect(statusCodeFromOrpcError(new Error("boom"))).toBe("5xx");
		expect(statusCodeFromOrpcError("string error")).toBe("5xx");
		expect(statusCodeFromOrpcError({ code: "MYSTERY" })).toBe("5xx");
	});
});

describe("renderRouteLabel", () => {
	it("joins segments with a dot", () => {
		expect(renderRouteLabel(["incidents", "list"])).toBe("incidents.list");
	});

	it("returns (root) for empty path", () => {
		expect(renderRouteLabel([])).toBe("(root)");
	});

	it("handles single-segment paths", () => {
		expect(renderRouteLabel(["healthcheck"])).toBe("healthcheck");
	});
});

describe("recordRequest", () => {
	it("never throws on missing headers", () => {
		expect(() =>
			recordRequest({ headers: undefined, path: ["ai", "x"] }),
		).not.toThrow();
	});

	it("increments http_requests_total with 2xx on success path", async () => {
		recordRequest({ headers: new Headers(), path: ["incidents", "list"] });
		const text = await register.metrics();
		expect(text).toContain("http_requests_total");
		expect(text).toContain('service="api"');
		expect(text).toContain('route="incidents.list"');
		expect(text).toContain('status_class="2xx"');
	});

	it("increments with the error-derived status class on failure path", async () => {
		recordRequest({
			headers: new Headers(),
			path: ["ai", "x"],
			error: { code: "UNAUTHORIZED" },
		});
		const text = await register.metrics();
		expect(text).toContain('status_class="4xx"');
	});

	it("derives feature='ai_generation' from ai.* paths", async () => {
		recordRequest({
			headers: new Headers(),
			path: ["ai", "generateTitle"],
		});
		const text = await register.metrics();
		expect(text).toContain('feature="ai_generation"');
	});

	it("derives feature='payments' from billing.* paths", async () => {
		recordRequest({
			headers: new Headers(),
			path: ["billing", "checkout"],
		});
		const text = await register.metrics();
		expect(text).toContain('feature="payments"');
	});

	it("uses route TEMPLATE — never a path with IDs", async () => {
		recordRequest({ headers: new Headers(), path: ["projects", "get"] });
		const text = await register.metrics();
		// oRPC paths are tuples like ["projects", "get"], not raw URLs
		// with cuids. Verify the resulting route label is bounded.
		expect(text).toContain('route="projects.get"');
		// Cardinality guard — must not see a raw cuid in any label.
		expect(text).not.toMatch(/route="[^"]*cm[a-z0-9]{20,}/);
	});
});
