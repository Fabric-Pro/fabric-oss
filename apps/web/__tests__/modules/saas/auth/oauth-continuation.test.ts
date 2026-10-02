/**
 * The way back to an agent's authorization after sign-in, whichever way the
 * person signs in. The magic-link case is the one that broke: Better Auth's
 * link endpoint decodes its `callbackURL` twice and then refuses anything
 * outside a relative-path pattern with no `:`, so a raw authorize URL — whose
 * `redirect_uri` holds `http%3A%2F%2F127.0.0.1…` — came back 403.
 */

import {
	authorizationResumeLocation,
	isServerNavigationPath,
	OAUTH_RESUME_PATH,
	oauthContinuationPath,
} from "@saas/auth/lib/oauth-continuation";
import { describe, expect, it } from "vitest";

/** Better Auth 1.6.22's relative callbackURL check (`auth/trusted-origins`). */
const BETTER_AUTH_RELATIVE_CALLBACK =
	/^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/;

const LOGIN_QUERY = new URLSearchParams({
	response_type: "code",
	client_id: "client-example",
	redirect_uri: "http://127.0.0.1:49152/callback",
	scope: "mcp:read instructions:read instructions:write offline_access",
	state: "state-example",
	code_challenge: "challenge-example_-",
	code_challenge_method: "S256",
	exp: "1900000000",
	ba_iat: "1800000000000",
	ba_param: "client_id",
	sig: "signature-example",
});

describe("resuming an agent's authorization", () => {
	it("survives a magic link's callbackURL check, decoded twice", () => {
		const path = oauthContinuationPath(LOGIN_QUERY);

		expect(path?.startsWith(`${OAUTH_RESUME_PATH}?q=`)).toBe(true);
		const twiceDecoded = decodeURIComponent(decodeURIComponent(path ?? ""));
		expect(twiceDecoded).toBe(path);
		expect(BETTER_AUTH_RELATIVE_CALLBACK.test(twiceDecoded)).toBe(true);
	});

	it("shows the check the raw authorize URL used to fail", () => {
		const raw = `/api/auth/oauth2/authorize?${new URLSearchParams({
			client_id: "client-example",
			redirect_uri: "http://127.0.0.1:49152/callback",
		}).toString()}`;

		expect(
			BETTER_AUTH_RELATIVE_CALLBACK.test(
				decodeURIComponent(decodeURIComponent(raw)),
			),
		).toBe(false);
	});

	it("resumes the authorization endpoint with the original request and without the login page's signature", () => {
		const path = oauthContinuationPath(LOGIN_QUERY) ?? "";
		const q = new URL(path, "https://app.example.com").searchParams.get(
			"q",
		);

		const location = authorizationResumeLocation(q);

		expect(location?.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
		const resumed = new URLSearchParams(location?.split("?")[1]);
		expect(resumed.get("client_id")).toBe("client-example");
		expect(resumed.get("redirect_uri")).toBe(
			"http://127.0.0.1:49152/callback",
		);
		expect(resumed.get("code_challenge")).toBe("challenge-example_-");
		for (const signed of ["sig", "exp", "ba_iat", "ba_param"]) {
			expect(resumed.has(signed), signed).toBe(false);
		}
	});

	it("is not an agent's login without a signature, a client and a redirect", () => {
		for (const missing of ["sig", "client_id", "redirect_uri"]) {
			const query = new URLSearchParams(LOGIN_QUERY);
			query.delete(missing);
			expect(oauthContinuationPath(query), missing).toBeNull();
		}
	});

	it("refuses a resume value that is not an authorization request", () => {
		expect(authorizationResumeLocation(null)).toBeNull();
		expect(authorizationResumeLocation("not base64url!")).toBeNull();
		// Well-formed base64url, but no redirect target.
		const unpadded = btoa("client_id=only-a-client").replace(/=+$/, "");
		expect(authorizationResumeLocation(unpadded)).toBeNull();
	});

	it("navigates to the resume route for real, not as a client-side route change", () => {
		expect(isServerNavigationPath(`${OAUTH_RESUME_PATH}?q=abc`)).toBe(true);
		expect(isServerNavigationPath("/api/auth/oauth2/authorize?x=1")).toBe(
			true,
		);
		expect(isServerNavigationPath("/app/example-org")).toBe(false);
	});
});
