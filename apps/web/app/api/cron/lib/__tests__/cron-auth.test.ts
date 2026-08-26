/**
 * Contract tests for the shared cron auth gate.
 *
 * The gate accepts exactly one credential: `Authorization: Bearer
 * ${CRON_SECRET}`. There is no fallback. An earlier revision accepted the
 * spoofable `vercel-cron` User-Agent whenever `CRON_SECRET` was unset, to keep
 * scheduled work running through that misconfiguration (issue #2331) — at the
 * cost of leaving both cron routes open to anyone who set the header (issue
 * #2883). These cases pin both halves of the replacement contract: the bearer
 * token is honoured when the secret is configured, and *nothing* is honoured
 * when it is not.
 *
 * A missing secret is now surfaced at server startup by
 * `apps/web/instrumentation.ts` rather than per request, which is why the gate
 * itself is a silent predicate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	describeMissingCronSecret,
	isCronRequestAuthorized,
	readCronSecret,
} from "../cron-auth";

const SECRET = "test-cron-secret-123";

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://example.com/api/cron/example", {
		method: "GET",
		headers,
	});
}

function authorize(headers: Record<string, string> = {}): boolean {
	return isCronRequestAuthorized(makeRequest(headers));
}

/**
 * Runs the gate against an exact `Authorization` value.
 *
 * A real `Request` normalizes header values — `"Bearer "` arrives as `"Bearer"`
 * — so the trailing-space forms below are unrepresentable through `makeRequest`
 * and a test using it would pass no matter what the gate did. Stub the single
 * method the gate calls instead.
 */
function authorizeRawHeader(authorization: string | null): boolean {
	const request = {
		headers: { get: () => authorization },
	} as unknown as Request;
	return isCronRequestAuthorized(request);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("isCronRequestAuthorized — CRON_SECRET configured", () => {
	it("accepts the matching bearer token", () => {
		vi.stubEnv("CRON_SECRET", SECRET);
		expect(authorize({ authorization: `Bearer ${SECRET}` })).toBe(true);
	});

	it("rejects a wrong bearer token", () => {
		vi.stubEnv("CRON_SECRET", SECRET);
		expect(authorize({ authorization: "Bearer nope" })).toBe(false);
	});

	it("rejects a spoofed vercel-cron User-Agent — a configured secret is not bypassable", () => {
		vi.stubEnv("CRON_SECRET", SECRET);
		expect(authorize({ "user-agent": "vercel-cron/1.0" })).toBe(false);
	});

	it("rejects a spoofed User-Agent paired with a wrong bearer token", () => {
		vi.stubEnv("CRON_SECRET", SECRET);
		expect(
			authorize({
				authorization: "Bearer nope",
				"user-agent": "vercel-cron/1.0",
			}),
		).toBe(false);
	});

	it("rejects a request with no credentials at all", () => {
		vi.stubEnv("CRON_SECRET", SECRET);
		expect(authorize()).toBe(false);
	});
});

describe("isCronRequestAuthorized — CRON_SECRET unset", () => {
	it("rejects the vercel-cron User-Agent — the fallback is gone", () => {
		vi.stubEnv("CRON_SECRET", "");
		expect(authorize({ "user-agent": "vercel-cron/1.0" })).toBe(false);
	});

	it("rejects any User-Agent claiming to be Vercel Cron", () => {
		vi.stubEnv("CRON_SECRET", "");
		// The header was always client-controlled; the point of #2883 is that no
		// spelling of it opens the route any more.
		expect(authorize({ "user-agent": "attacker-vercel-cron-spoof" })).toBe(
			false,
		);
	});

	it("rejects the exact header an empty secret would mint", () => {
		vi.stubEnv("CRON_SECRET", "");
		// Pins the falsy-secret guard itself: drop it and the comparison becomes
		// `"Bearer " === `Bearer ${""}`` — true — which would open both routes on
		// any deployment that has the variable set to an empty string.
		expect(authorizeRawHeader("Bearer ")).toBe(false);
	});

	it("rejects the exact header Vercel would send for a padded secret", () => {
		vi.stubEnv("CRON_SECRET", "  padded-secret  ");
		// What actually arrives: `Bearer ` + the raw value, with only the
		// trailing edge stripped by HTTP. Nothing admits it, so the routes stay
		// closed and `describeMissingCronSecret` reports the deployment.
		expect(authorizeRawHeader("Bearer   padded-secret")).toBe(false);
		expect(authorizeRawHeader("Bearer padded-secret")).toBe(false);
	});

	it("rejects the exact header a whitespace-only secret would mint", () => {
		vi.stubEnv("CRON_SECRET", " ");
		// ` ` is truthy, so without the trim in `readCronSecret` this would be
		// treated as configured while no client could ever satisfy it.
		expect(authorizeRawHeader("Bearer  ")).toBe(false);
	});

	it("rejects a bare `Bearer undefined` header", () => {
		vi.stubEnv("CRON_SECRET", "");
		expect(authorize({ authorization: "Bearer undefined" })).toBe(false);
	});

	it("rejects a request with no headers", () => {
		vi.stubEnv("CRON_SECRET", "");
		expect(authorize()).toBe(false);
	});
});

describe("readCronSecret", () => {
	it("returns null when CRON_SECRET is unset", () => {
		vi.stubEnv("CRON_SECRET", "");
		expect(readCronSecret()).toBeNull();
	});

	it("returns null for a whitespace-only secret", () => {
		// HTTP strips optional whitespace around a header value, so the header
		// this would demand is unsendable — treat it as no secret at all.
		vi.stubEnv("CRON_SECRET", "   ");
		expect(readCronSecret()).toBeNull();
	});

	it("rejects a padded secret rather than canonicalizing it", () => {
		// Trimming here would be worse than rejecting. Vercel Cron sends the
		// configured value verbatim after `Bearer `, and HTTP strips only the
		// edges of the finished header value, so this arrives as
		// `"Bearer   padded-secret"` — which a trimmed expectation of
		// `"Bearer padded-secret"` would reject while the startup check called
		// the deployment healthy. Fail closed and report instead.
		vi.stubEnv("CRON_SECRET", "  padded-secret  ");
		expect(readCronSecret()).toBeNull();
	});

	it("rejects a secret with an interior newline", () => {
		// The realistic route in: `openssl rand -base64 64` wraps its output, so
		// a pasted long secret carries a line break. No HTTP header can carry it,
		// so every scheduled tick would 401 against a configured-looking value.
		vi.stubEnv("CRON_SECRET", "first-half\nsecond-half");
		expect(readCronSecret()).toBeNull();
	});

	it("rejects a secret containing DEL", () => {
		vi.stubEnv("CRON_SECRET", "abc\u007fdef");
		expect(readCronSecret()).toBeNull();
	});

	it("documents that NUL cannot reach this function at all", () => {
		// `process.env` truncates at NUL, so the value arrives as "abc" — a
		// perfectly usable secret, just shorter than intended. Whoever sends the
		// header reads the same truncated variable, so both sides still agree and
		// the schedule keeps working. Nothing to reject, and nothing to report.
		vi.stubEnv("CRON_SECRET", "abc\u0000def");
		expect(readCronSecret()).toBe("abc");
	});

	it("rejects control characters this runtime would tolerate", () => {
		// `Headers` only hard-rejects NUL, LF and CR; the rest of the C0 range is
		// accepted locally but forbidden in a header value by HTTP, so it may be
		// mangled in transit rather than failing cleanly. Rejected deliberately.
		vi.stubEnv("CRON_SECRET", "abc\u0001def");
		expect(readCronSecret()).toBeNull();
	});

	it("rejects a secret with a character above U+00FF", () => {
		// A header field value is a byte string, so these throw outright when the
		// sender tries to build the header — configured-looking, unsendable.
		vi.stubEnv("CRON_SECRET", "secret-\u{1F600}");
		expect(readCronSecret()).toBeNull();

		vi.stubEnv("CRON_SECRET", "secret-\u0411");
		expect(readCronSecret()).toBeNull();
	});

	it("accepts a high-byte character, which does transmit", () => {
		// Marks where the line is: Latin-1 round-trips through a header value, so
		// rejecting it would be over-reach rather than safety.
		vi.stubEnv("CRON_SECRET", "secret-\u00e9");
		expect(readCronSecret()).toBe("secret-\u00e9");
	});

	it("accepts a realistic base64 secret — the rule must not over-reject", () => {
		// Guards the strictness above from creeping into real secrets: `+`, `/`
		// and `=` are exactly what `openssl rand -base64` emits.
		vi.stubEnv("CRON_SECRET", "aB3+cD4/eF5gH6i=");
		expect(readCronSecret()).toBe("aB3+cD4/eF5gH6i=");
	});

	it("accepts an otherwise-falsy-looking secret", () => {
		vi.stubEnv("CRON_SECRET", "0");
		expect(readCronSecret()).toBe("0");
	});
});

describe("describeMissingCronSecret", () => {
	it("reports a production deployment with no secret", () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("CRON_SECRET", "");

		const message = describeMissingCronSecret();

		expect(message).toContain("CRON_SECRET is unset");
		expect(message).toContain("apps/web/vercel.json");
	});

	it("reports a production deployment whose secret is whitespace-only", () => {
		// The case the truthiness check used to miss: configured-looking, but
		// no tick can ever authenticate against it.
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("CRON_SECRET", " ");

		expect(describeMissingCronSecret()).toContain("CRON_SECRET is unset");
	});

	it("reports a production deployment whose secret is padded", () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("CRON_SECRET", "  padded-secret  ");

		expect(describeMissingCronSecret()).toContain("CRON_SECRET");
	});

	it("reports a production secret that no header could carry", () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("CRON_SECRET", "first-half\nsecond-half");

		expect(describeMissingCronSecret()).toContain("CRON_SECRET");
	});

	it("stays silent on a correctly configured production deployment", () => {
		vi.stubEnv("VERCEL_ENV", "production");
		vi.stubEnv("CRON_SECRET", "test-cron-secret-123");

		expect(describeMissingCronSecret()).toBeNull();
	});

	it("stays silent on preview — Vercel never runs the schedule there", () => {
		vi.stubEnv("VERCEL_ENV", "preview");
		vi.stubEnv("CRON_SECRET", "");

		expect(describeMissingCronSecret()).toBeNull();
	});

	it("stays silent off Vercel, where nothing invokes the cron routes", () => {
		vi.stubEnv("VERCEL_ENV", "");
		vi.stubEnv("CRON_SECRET", "");

		expect(describeMissingCronSecret()).toBeNull();
	});
});
