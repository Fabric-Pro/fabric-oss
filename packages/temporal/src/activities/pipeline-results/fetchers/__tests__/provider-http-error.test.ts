/**
 * What a provider's failure response means — and, more to the point, what it
 * must NOT be allowed to mean.
 *
 * The bug being guarded: every client collapsed 401 and 403 into "authentication
 * failed — check the token and its scope" and discarded the provider's own body.
 * A rate-limited sync then told the user to reconnect a perfectly good
 * credential, and a real 403 arrived with the one sentence that would have
 * explained it already thrown away. The assertions below are therefore about
 * the REMEDY each branch recommends, not about wording.
 */

import { describe, expect, it } from "vitest";
import { classifyProviderHttpFailure } from "../provider-http-error";

const github = (
	status: number,
	headers: Record<string, string> = {},
	body = "",
) =>
	classifyProviderHttpFailure({
		provider: "github",
		status,
		headers,
		body,
	});

describe("classifyProviderHttpFailure", () => {
	describe("rate limiting is never a credential problem", () => {
		it("reads a 403 with an exhausted primary limit as RATE_LIMITED", () => {
			const { kind, message } = github(403, {
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": "1800000000",
			});

			expect(kind).toBe("RATE_LIMITED");
			// The load-bearing assertion: this must not send anyone to re-auth.
			expect(message).toMatch(/does not need reconnecting/i);
			expect(message).not.toMatch(/expired|invalid/i);
		});

		it("reads a 403 with only retry-after as RATE_LIMITED too", () => {
			// The SECONDARY limiter does not zero the remaining counter, so a
			// check that looks only at x-ratelimit-remaining misreads it as a dead
			// credential — which is the more common of the two in practice.
			const { kind, message } = github(403, { "retry-after": "60" });

			expect(kind).toBe("RATE_LIMITED");
			expect(message).toContain("Retry after 60 seconds");
		});

		it("treats 429 as rate limiting whatever the headers say", () => {
			expect(github(429).kind).toBe("RATE_LIMITED");
		});

		it("names the reset instant absolutely, not relatively", () => {
			// The message is stored on a sync record and read later, when "in 5
			// minutes" would be false.
			const { message } = github(403, {
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": "1800000000",
			});

			expect(message).toContain("2027-01-15T08:00:00.000Z");
		});
	});

	describe("SSO", () => {
		it("surfaces the authorisation URL GitHub hands back", () => {
			// GitHub returns the URL that fixes it in the header. Dropping that is
			// the difference between a fixable error and a mystery.
			const { kind, message } = github(
				403,
				{
					"x-github-sso":
						"https://github.com/orgs/acme/sso?authorization_request=abc",
				},
				"Resource protected by organization SAML enforcement",
			);

			expect(kind).toBe("SSO_REQUIRED");
			expect(message).toContain(
				"https://github.com/orgs/acme/sso?authorization_request=abc",
			);
			expect(message).toMatch(/credential itself is valid/i);
		});

		it("prefers the rate-limit reading when both signals are present", () => {
			// A throttled response can still carry an SSO header. Rate limiting is
			// transient and self-healing; telling someone to go and authorise SSO
			// would be busywork that does not fix the sync.
			expect(
				github(403, {
					"x-github-sso": "https://example.com/sso",
					"retry-after": "30",
				}).kind,
			).toBe("RATE_LIMITED");
		});
	});

	describe("the two that look alike and are not", () => {
		it("401 is the only status that advises reconnecting", () => {
			const { kind, message } = github(401, {}, "Bad credentials");

			expect(kind).toBe("UNAUTHENTICATED");
			expect(message).toMatch(/reconnect/i);
			// The provider's words live in `providerDetail`, NOT spliced into the
			// sentence — the surface shows one and reveals the other on hover.
			expect(github(401, {}, "Bad credentials").providerDetail).toBe(
				"Bad credentials",
			);
		});

		it("a plain 403 explicitly says reconnecting will NOT help", () => {
			// The whole point. A 403 means the credential authenticated and was
			// refused the resource; for a GitHub App the missing permission is
			// granted at install time and no amount of reconnecting adds it.
			const { kind, message } = github(
				403,
				{},
				"Resource not accessible",
			);

			expect(kind).toBe("FORBIDDEN");
			expect(message).toMatch(/Reconnecting will not add a permission/i);
			expect(message).toContain("Actions: read");
			expect(message).not.toMatch(/expired/i);
		});
	});

	it("keeps the provider's own words on every failure, separately", () => {
		// The half of the bug that made the live 403 undiagnosable: the body was
		// read for other statuses and thrown away for exactly 401 and 403. It is
		// now always kept — and always kept APART from the readable sentence, so
		// a banner can show one and hover the other.
		for (const status of [401, 403, 404, 500]) {
			expect(
				github(status, {}, "the provider explanation"),
			).toMatchObject({ providerDetail: "the provider explanation" });
		}
	});

	it("reports no detail when the provider sent no body", () => {
		// Null, not "": a control that reveals an empty tooltip is worse than no
		// control, and the surface decides on exactly this.
		expect(github(500, {}, "").providerDetail).toBeNull();
	});

	it("does not claim a 404 is definitely a missing repository", () => {
		// GitHub answers 404 both for "does not exist" and for "you may not see
		// it", so naming only the first sends someone hunting a typo.
		const { message } = github(404);

		expect(message).toMatch(/may not exist/i);
		expect(message).toMatch(/not be permitted to see it/i);
	});

	it("names the scope each provider actually needs", () => {
		expect(
			classifyProviderHttpFailure({
				provider: "gitlab",
				status: 403,
				headers: {},
				body: "",
			}).message,
		).toContain("read_api");
		expect(
			classifyProviderHttpFailure({
				provider: "azure-devops",
				status: 403,
				headers: {},
				body: "",
			}).message,
		).toContain("Test Management: Read");
	});

	it("reads headers from a real Headers object as well as a plain map", () => {
		// The clients pass `res.headers`; the tests pass object literals. A
		// classifier that only understood one of the two would pass here and do
		// nothing in production.
		const { kind } = classifyProviderHttpFailure({
			provider: "github",
			status: 403,
			headers: new Headers({ "X-RateLimit-Remaining": "0" }),
			body: "",
		});

		expect(kind).toBe("RATE_LIMITED");
	});

	it("collapses whitespace so an HTML error page stays one readable line", () => {
		const { message } = github(
			500,
			{},
			"<html>\n  <body>\n   oops\n</body>",
		);

		expect(message).toBe("<html> <body> oops </body>");
	});

	it("redacts exact credentials and authorization headers before returning detail", () => {
		const secret = "glpat-customer-secret-value";
		const { providerDetail } = classifyProviderHttpFailure({
			provider: "gitlab",
			status: 500,
			headers: {},
			body: `PRIVATE-TOKEN: ${secret}; Authorization: Bearer ${secret}`,
			secrets: [secret],
		});

		expect(providerDetail).toContain("[REDACTED]");
		expect(providerDetail).not.toContain(secret);
	});

	it("redacts common secret fields even when the exact credential is unavailable", () => {
		const { providerDetail } = github(
			500,
			{},
			'{"access_token":"echoed-value","error":"Authorization: Basic abc123=="}',
		);

		expect(providerDetail).not.toContain("echoed-value");
		expect(providerDetail).not.toContain("abc123");
		expect(providerDetail).toContain("[REDACTED]");
	});
});
