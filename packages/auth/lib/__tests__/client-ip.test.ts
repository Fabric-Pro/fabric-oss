/**
 * Tests for `getTrustedClientIp`.
 *
 * Covers:
 *  - Each trusted proxy header wins in priority order
 *    (vercel > cloudflare > real-ip > forwarded-for).
 *  - In production, when no trusted header is present, the helper returns
 *    "unknown" (the historical fail-safe).
 *  - In non-production, the same path returns the loopback `127.0.0.1`
 *    so local dev populates the audit-log IP column (v2 item 3).
 *  - `FABRIC_IP_LOOPBACK_FALLBACK` overrides the NODE_ENV default both ways.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTrustedClientIp } from "../client-ip";

function makeHeaders(entries: Record<string, string>): Headers {
	const h = new Headers();
	for (const [k, v] of Object.entries(entries)) {
		h.set(k, v);
	}
	return h;
}

describe("getTrustedClientIp", () => {
	const savedNodeEnv = process.env.NODE_ENV;
	const savedFlag = process.env.FABRIC_IP_LOOPBACK_FALLBACK;

	beforeEach(() => {
		delete process.env.FABRIC_IP_LOOPBACK_FALLBACK;
	});

	afterEach(() => {
		if (savedNodeEnv === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = savedNodeEnv;
		}
		if (savedFlag === undefined) {
			delete process.env.FABRIC_IP_LOOPBACK_FALLBACK;
		} else {
			process.env.FABRIC_IP_LOOPBACK_FALLBACK = savedFlag;
		}
	});

	it("returns the Vercel-set header when present", () => {
		const h = makeHeaders({ "x-vercel-forwarded-for": "203.0.113.5" });
		expect(getTrustedClientIp(h)).toBe("203.0.113.5");
	});

	it("uses the Cloudflare header when Vercel is absent", () => {
		const h = makeHeaders({ "cf-connecting-ip": "198.51.100.7" });
		expect(getTrustedClientIp(h)).toBe("198.51.100.7");
	});

	it("uses x-real-ip when both Vercel and Cloudflare are absent", () => {
		const h = makeHeaders({ "x-real-ip": "192.0.2.4" });
		expect(getTrustedClientIp(h)).toBe("192.0.2.4");
	});

	it("uses the trusted XFF hop when no other proxy header is present", () => {
		const h = makeHeaders({
			"x-forwarded-for": "203.0.113.1, 198.51.100.7",
		});
		// TRUSTED_PROXY_HOP_COUNT defaults to 1, so the hop before the trusted
		// proxy (i.e. index 0 here) is the client.
		expect(getTrustedClientIp(h)).toBe("203.0.113.1");
	});

	it("returns 'unknown' in production when no trusted header is present", () => {
		process.env.NODE_ENV = "production";
		const h = new Headers();
		expect(getTrustedClientIp(h)).toBe("unknown");
	});

	it("returns 127.0.0.1 in development when no trusted header is present (item 3)", () => {
		process.env.NODE_ENV = "development";
		const h = new Headers();
		expect(getTrustedClientIp(h)).toBe("127.0.0.1");
	});

	it("returns 'unknown' in test mode by default (mirrors production semantics)", () => {
		process.env.NODE_ENV = "test";
		const h = new Headers();
		// Tests should mirror production so security regressions surface;
		// the loopback fallback only triggers in NODE_ENV=development.
		expect(getTrustedClientIp(h)).toBe("unknown");
	});

	it("explicit override 'true' forces the loopback fallback in production", () => {
		process.env.NODE_ENV = "production";
		process.env.FABRIC_IP_LOOPBACK_FALLBACK = "true";
		const h = new Headers();
		expect(getTrustedClientIp(h)).toBe("127.0.0.1");
	});

	it("explicit override 'false' suppresses the loopback fallback in dev", () => {
		process.env.NODE_ENV = "development";
		process.env.FABRIC_IP_LOOPBACK_FALLBACK = "false";
		const h = new Headers();
		expect(getTrustedClientIp(h)).toBe("unknown");
	});

	it("explicit override 'true' triggers the loopback fallback in test mode", () => {
		process.env.NODE_ENV = "test";
		process.env.FABRIC_IP_LOOPBACK_FALLBACK = "true";
		const h = new Headers();
		expect(getTrustedClientIp(h)).toBe("127.0.0.1");
	});

	it("header present in production beats the loopback fallback default", () => {
		process.env.NODE_ENV = "production";
		const h = makeHeaders({ "cf-connecting-ip": "203.0.113.99" });
		expect(getTrustedClientIp(h)).toBe("203.0.113.99");
	});
});
