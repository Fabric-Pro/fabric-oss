/**
 * Tests for the agentic runner's containment and parsing logic.
 *
 * `resolveSameOriginUrl` is the guard that keeps a browser holding a customer's
 * live session from being talked into visiting somewhere else with it. It is the
 * single most security-relevant function in the runner, and the model chooses its
 * input, so it is tested against what a confused or adversarial model would
 * actually produce rather than only against happy paths.
 */

import { describe, expect, it } from "vitest";
import {
	classifyFetchFailure,
	describeBrowserRefusal,
	parseResolution,
	resolveSameOriginUrl,
} from "../browser-driver";
import { normaliseOperation } from "../run-case";

const BASE = "https://staging.example.com";

describe("resolveSameOriginUrl", () => {
	it("allows a relative path", () => {
		expect(resolveSameOriginUrl(BASE, "/settings")).toBe(
			"https://staging.example.com/settings",
		);
	});

	it("allows an absolute URL on the same origin", () => {
		expect(
			resolveSameOriginUrl(BASE, "https://staging.example.com/a"),
		).toBe("https://staging.example.com/a");
	});

	it.each([
		["a different host", "https://evil.example.com/steal"],
		["a different scheme", "http://staging.example.com/"],
		["a different port", "https://staging.example.com:8443/"],
		[
			"a subdomain that merely looks related",
			"https://api.staging.example.com/",
		],
		[
			"a host that only prefixes ours",
			"https://staging.example.com.evil.io/",
		],
		["protocol-relative to elsewhere", "//evil.example.com/"],
		["javascript:", "javascript:alert(1)"],
		["data:", "data:text/html,<h1>x</h1>"],
		["file:", "file:///etc/passwd"],
	])("refuses %s", (_label, path) => {
		expect(resolveSameOriginUrl(BASE, path)).toBeNull();
	});

	it("refuses everything when the base URL is unusable", () => {
		// A malformed environment base URL must fail CLOSED. Returning the
		// candidate here would mean an unparseable base disables the guard.
		expect(resolveSameOriginUrl("not a url", "/settings")).toBeNull();
	});

	it("does not treat a path traversal as an escape, because origin is what matters", () => {
		// `../` cannot leave an origin — the URL parser normalises it. Asserted so
		// nobody "hardens" this into rejecting legitimate relative paths.
		expect(resolveSameOriginUrl(BASE, "/a/../b")).toBe(
			"https://staging.example.com/b",
		);
	});
});

describe("parseResolution", () => {
	it("parses the settings format", () => {
		expect(parseResolution("1366x768")).toEqual({
			width: 1366,
			height: 768,
		});
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseResolution("  1920x1080 ")).toEqual({
			width: 1920,
			height: 1080,
		});
	});

	it.each(["", "1920", "1920*1080", "axb", "99x99", "1920x1080x2"])(
		"falls back to 1920x1080 for %s rather than throwing",
		(value) => {
			// A malformed row in settings must not be the reason a run cannot
			// start; the fallback is the default the settings page offers first.
			expect(parseResolution(value)).toEqual({
				width: 1920,
				height: 1080,
			});
		},
	);
});

describe("classifyFetchFailure", () => {
	it.each([
		["a TLS protocol failure", { code: "EPROTO" }, "tls-failed"],
		[
			"an aggregate whose nested cause names the TLS failure",
			new AggregateError([
				{ code: "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE" },
			]),
			"tls-failed",
		],
		["a missing host", { code: "ENOTFOUND" }, "host-not-found"],
		["a transient DNS failure", { code: "EAI_AGAIN" }, "fetch-failed"],
	])("classifies %s", (_label, cause, expected) => {
		expect(
			classifyFetchFailure(new TypeError("fetch failed", { cause })),
		).toBe(expected);
	});

	it("calls out the environment TLS configuration for a handshake failure", () => {
		expect(
			describeBrowserRefusal({
				kind: "tls-failed",
				url: BASE,
				detail: "EPROTO",
			}),
		).toContain("environment's TLS configuration");
	});
});

describe("normaliseOperation", () => {
	it("accepts the canonical operations", () => {
		expect(
			normaliseOperation({ kind: "click", role: "button", name: "Save" }),
		).toEqual({ kind: "click", role: "button", name: "Save" });
		expect(normaliseOperation({ kind: "press", key: "Enter" })).toEqual({
			kind: "press",
			key: "Enter",
		});
	});

	it("is case- and synonym-tolerant", () => {
		// A strict enum would turn these into a retry loop for a field whose whole
		// job is advisory, so the normaliser absorbs them instead.
		expect(
			normaliseOperation({ kind: "CLICK", role: "button", name: "Save" }),
		).toMatchObject({ kind: "click" });
		expect(
			normaliseOperation({
				kind: "type",
				role: "textbox",
				name: "Email",
				text: "a",
			}),
		).toMatchObject({ kind: "fill", text: "a" });
		expect(
			normaliseOperation({ kind: "navigate", path: "/x" }),
		).toMatchObject({
			kind: "goto",
		});
	});

	it("blocks an incomplete authored operation rather than assessing it as a no-op", () => {
		expect(normaliseOperation({ kind: "click", role: "button" })).toEqual({
			kind: "blocked",
			reason: "The requested click operation is missing a role or accessible name.",
		});
		expect(normaliseOperation({ kind: "fill", name: "Email" })).toEqual({
			kind: "blocked",
			reason: "The requested fill operation is missing a role or accessible name.",
		});
		expect(normaliseOperation({ kind: "goto" })).toEqual({
			kind: "blocked",
			reason: "The requested goto operation is missing a path.",
		});
		expect(normaliseOperation({ kind: "press" })).toEqual({
			kind: "blocked",
			reason: "The requested press operation is missing a key.",
		});
	});

	it("blocks an unknown authored operation", () => {
		expect(normaliseOperation({ kind: "exec", text: "rm -rf /" })).toEqual({
			kind: "blocked",
			reason: "The requested operation kind is not supported by the QA runner.",
		});
		expect(normaliseOperation({})).toEqual({
			kind: "blocked",
			reason: "The requested operation kind is missing.",
		});
	});

	it("keeps an explicit none as an observation-only operation", () => {
		expect(normaliseOperation({ kind: "none" })).toEqual({ kind: "none" });
	});

	it("defaults a wait rather than waiting forever", () => {
		expect(normaliseOperation({ kind: "wait" })).toEqual({
			kind: "wait",
			ms: 1000,
		});
	});
});
