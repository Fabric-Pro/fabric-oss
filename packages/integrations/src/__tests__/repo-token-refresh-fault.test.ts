/**
 * Which OAuth token-endpoint failures are OURS and which are the customer's.
 *
 * This mapping is load-bearing in one direction more than the other. A code
 * wrongly mapped to a platform fault suppresses the "reconnect your repository"
 * signal a customer with a dead grant needs; a code wrongly left UNmapped sends
 * a provider-wide outage down the customer path — the refresh fails, the
 * expired stored token is used, the provider answers 401, and the sync records
 * `CREDENTIAL_REJECTED` at warn with a reconnect prompt. Both directions are
 * pinned here.
 */

import { describe, expect, it } from "vitest";
import { refreshFaultForOAuthErrorCode } from "../repo-token-refresh-fault";

describe("refreshFaultForOAuthErrorCode — platform faults", () => {
	it("maps refreshOAuthToken's own synthesized transport codes", () => {
		expect(refreshFaultForOAuthErrorCode("network_error")).toBe(
			"PROVIDER_UNAVAILABLE",
		);
		expect(refreshFaultForOAuthErrorCode("invalid_response")).toBe(
			"PROVIDER_UNAVAILABLE",
		);
	});

	it("maps a rejection of OUR client, not the user's token", () => {
		// The BOM-in-`client_id` failure mode: seven weeks of staging refreshes
		// failed this way, and no user could have fixed it by reconnecting.
		expect(refreshFaultForOAuthErrorCode("invalid_client")).toBe(
			"PROVIDER_UNAVAILABLE",
		);
		expect(refreshFaultForOAuthErrorCode("unauthorized_client")).toBe(
			"PROVIDER_UNAVAILABLE",
		);
	});

	// RFC 6749 §5.2 defines both as unambiguously server-side. `refreshOAuthToken`
	// passes a parsed provider error code straight through, so a token endpoint
	// answering `{"error":"temporarily_unavailable"}` arrives here verbatim —
	// left unmapped, a provider outage would be recorded as every affected
	// customer's credential being rejected.
	it("maps the RFC 6749 server-side error codes", () => {
		expect(refreshFaultForOAuthErrorCode("server_error")).toBe(
			"PROVIDER_UNAVAILABLE",
		);
		expect(refreshFaultForOAuthErrorCode("temporarily_unavailable")).toBe(
			"PROVIDER_UNAVAILABLE",
		);
	});

	it("maps every 5xx status", () => {
		for (const status of [500, 502, 503, 504, 599]) {
			expect(
				refreshFaultForOAuthErrorCode(`http_${status}`),
				`http_${status}`,
			).toBe("PROVIDER_UNAVAILABLE");
		}
	});

	// Throttling at the token endpoint says nothing about whether the grant is
	// still valid — it would have refreshed on the next attempt.
	it("maps http_429 — rate limiting is not a dead grant", () => {
		expect(refreshFaultForOAuthErrorCode("http_429")).toBe(
			"PROVIDER_UNAVAILABLE",
		);
	});
});

describe("refreshFaultForOAuthErrorCode — left to the customer", () => {
	it("does NOT map invalid_grant — that really is a reconnect", () => {
		expect(refreshFaultForOAuthErrorCode("invalid_grant")).toBeUndefined();
	});

	it("does NOT map an unrecognized code", () => {
		expect(
			refreshFaultForOAuthErrorCode("some_provider_specific_code"),
		).toBeUndefined();
		expect(refreshFaultForOAuthErrorCode("")).toBeUndefined();
	});

	// GitHub answers HTTP 404 both for a corrupted `client_id` and for a refresh
	// token a concurrent caller already rotated away, so a bare 4xx status
	// cannot separate the two and must not be guessed at either way.
	it("does NOT map a bare 4xx other than 429", () => {
		for (const status of [400, 401, 403, 404, 422]) {
			expect(
				refreshFaultForOAuthErrorCode(`http_${status}`),
				`http_${status}`,
			).toBeUndefined();
		}
	});

	it("does not treat a code that merely looks http-shaped as a status", () => {
		expect(refreshFaultForOAuthErrorCode("http_5xx")).toBeUndefined();
		expect(refreshFaultForOAuthErrorCode("http_50")).toBeUndefined();
		expect(refreshFaultForOAuthErrorCode("xhttp_500")).toBeUndefined();
	});
});
