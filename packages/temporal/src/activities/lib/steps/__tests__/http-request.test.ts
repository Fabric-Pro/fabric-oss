/**
 * SSRF-protection tests for the workflow HTTP-request step.
 *
 * These exercise only the block paths, which return before any network I/O,
 * so the test is deterministic and needs no mocking. The step now delegates
 * host/IP validation to the shared `@repo/utils` validator and issues the
 * request via `safeFetchOutbound` (redirect: "error"), closing the
 * hostname-only + redirect-follow bypasses the old local check had.
 */

import { describe, expect, it } from "vitest";
import { executeHttpRequestStep } from "../http-request";

function params(url?: string) {
	return {
		nodeConfig: url === undefined ? {} : { url },
		inputs: {},
		userId: "test-user",
	};
}

describe("executeHttpRequestStep — SSRF protection", () => {
	it("rejects a missing URL", async () => {
		const r = await executeHttpRequestStep(params());
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/URL is required/);
	});

	it.each([
		["http://169.254.169.254/latest/meta-data/", /metadata/i],
		["http://metadata.google.internal/", /metadata/i],
		["http://10.0.0.1/", /private/i],
		["http://192.168.1.1/", /private/i],
		["http://127.0.0.1:8080/", /loopback/i],
		["https://[::1]/", /loopback|ipv6/i],
	])("blocks internal/private host %s", async (url, pattern) => {
		const r = await executeHttpRequestStep(params(url as string));
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/Request blocked/);
		expect(r.error).toMatch(pattern as RegExp);
	});

	it("blocks an internal-service port even on a public host", async () => {
		const r = await executeHttpRequestStep(
			params("http://example.com:5432/"),
		);
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/Request blocked/);
		expect(r.error).toMatch(/5432/);
	});

	it("blocks a non-http(s) protocol", async () => {
		const r = await executeHttpRequestStep(params("ftp://example.com/"));
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/Request blocked/);
	});
});
