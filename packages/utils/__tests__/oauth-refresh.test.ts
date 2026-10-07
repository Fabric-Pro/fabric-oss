import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

import {
	refreshOAuthToken,
	sanitizeOAuthErrorText,
} from "../lib/oauth-refresh";
import * as urlSecurity from "../lib/url-security";

const ENDPOINT = "https://oauth.example.com/token";

type CapturedRequest = {
	url: string;
	init: RequestInit | undefined;
};

function jsonResponse(
	status: number,
	body: Record<string, unknown> | string,
): Response {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(text, {
		status,
		headers: { "content-type": "application/json" },
	});
}

function textResponse(
	status: number,
	body: string,
	contentType = "text/plain",
): Response {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}

let captured: CapturedRequest[];
let safeFetchSpy: MockInstance<typeof urlSecurity.safeFetchOutbound>;

beforeEach(() => {
	captured = [];
	safeFetchSpy = vi.spyOn(urlSecurity, "safeFetchOutbound");
});

afterEach(() => {
	safeFetchSpy.mockRestore();
});

function mockNextFetch(response: Response | Error) {
	safeFetchSpy.mockImplementationOnce(
		async (input: string | URL, init?: RequestInit) => {
			captured.push({
				url: typeof input === "string" ? input : input.toString(),
				init,
			});
			if (response instanceof Error) {
				throw response;
			}
			return response;
		},
	);
}

function decodeBody(init: RequestInit | undefined): URLSearchParams {
	expect(init?.body).toBeInstanceOf(URLSearchParams);
	return init?.body as URLSearchParams;
}

function getHeader(init: RequestInit | undefined, name: string): string | null {
	const headers = init?.headers;
	if (!headers) {
		return null;
	}
	if (headers instanceof Headers) {
		return headers.get(name);
	}
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(
		headers as Record<string, string>,
	)) {
		if (key.toLowerCase() === lower) {
			return value;
		}
	}
	return null;
}

describe("refreshOAuthToken", () => {
	it("returns success with all fields on a happy-path response", async () => {
		mockNextFetch(
			jsonResponse(200, {
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "read:user repo",
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result).toEqual({
			ok: true,
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresIn: 3600,
			tokenType: "Bearer",
			scope: "read:user repo",
		});
	});

	it("returns refreshToken: null when the provider does not rotate", async () => {
		mockNextFetch(
			jsonResponse(200, {
				access_token: "new-access",
				expires_in: 3600,
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.refreshToken).toBeNull();
		}
	});

	it("preserves a rotated refresh token (Notion-style)", async () => {
		mockNextFetch(
			jsonResponse(200, {
				access_token: "new-access",
				refresh_token: "rotated-refresh",
				expires_in: 3600,
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.refreshToken).toBe("rotated-refresh");
		}
	});

	it("returns expiresIn: null when provider omits expires_in", async () => {
		mockNextFetch(
			jsonResponse(200, {
				access_token: "new-access",
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.expiresIn).toBeNull();
		}
	});

	it("URL-encodes the body and sets accept: application/json", async () => {
		mockNextFetch(
			jsonResponse(200, { access_token: "new-access", expires_in: 60 }),
		);

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		const req = captured[0];
		expect(req.url).toBe(ENDPOINT);
		expect(req.init?.method).toBe("POST");
		expect(getHeader(req.init, "content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(getHeader(req.init, "accept")).toBe("application/json");

		const body = decodeBody(req.init);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("old-refresh");
		expect(body.get("client_id")).toBe("client-1");
		expect(body.get("client_secret")).toBe("secret-1");
	});

	// Regression: staging stored `fabric-github-client-id` with a UTF-8 BOM
	// (PowerShell `Out-File` -> `az keyvault secret set --file`). The BOM rode
	// into the container-app env var, GitHub answered every refresh with HTTP
	// 404 {"error":"Not Found"}, and EVERY GitHub repo integration in the
	// environment stopped refreshing for seven weeks. Sanitizing here means no
	// caller can be broken this way again.
	it("strips a UTF-8 BOM and surrounding whitespace from credentials", async () => {
		mockNextFetch(
			jsonResponse(200, { access_token: "new-access", expires_in: 60 }),
		);

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "  old-refresh\n",
			clientId: "﻿Iv23liClientId",
			clientSecret: "﻿shhh-secret ",
		});

		const body = decodeBody(captured[0].init);
		expect(body.get("client_id")).toBe("Iv23liClientId");
		expect(body.get("client_secret")).toBe("shhh-secret");
		expect(body.get("refresh_token")).toBe("old-refresh");
	});

	it("omits client_secret for public clients", async () => {
		mockNextFetch(
			jsonResponse(200, { access_token: "new-access", expires_in: 60 }),
		);

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "public-client",
		});

		const body = decodeBody(captured[0].init);
		expect(body.has("client_secret")).toBe(false);
		expect(body.get("client_id")).toBe("public-client");
	});

	it("includes scope when provided", async () => {
		mockNextFetch(
			jsonResponse(200, { access_token: "new-access", expires_in: 60 }),
		);

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
			scope: "read:user repo",
		});

		const body = decodeBody(captured[0].init);
		expect(body.get("scope")).toBe("read:user repo");
	});

	it("returns the provider's error code on a 4xx with JSON error body", async () => {
		mockNextFetch(
			jsonResponse(400, {
				error: "invalid_grant",
				error_description: "The refresh token is expired",
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result).toEqual({
			ok: false,
			errorCode: "invalid_grant",
			errorMessage: "The refresh token is expired",
		});
	});

	it("falls back to http_<status> on a 4xx with non-JSON body", async () => {
		// Non-JSON error body must surface as http_<status> with the body in the message.
		mockNextFetch(
			textResponse(400, "error=bad_verification_code", "text/plain"),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("http_400");
			expect(result.errorMessage).toContain("HTTP 400");
			expect(result.errorMessage).toContain("bad_verification_code");
		}
	});

	it("returns http_5xx on a server error without JSON body", async () => {
		mockNextFetch(textResponse(503, "service unavailable", "text/plain"));

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("http_503");
			expect(result.errorMessage).toContain("HTTP 503");
		}
	});

	it("returns network_error when safeFetchOutbound throws", async () => {
		mockNextFetch(new TypeError("fetch failed"));

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result).toEqual({
			ok: false,
			errorCode: "network_error",
			errorMessage: "fetch failed",
		});
	});

	it("sends no signal when the caller sets no timeoutMs", async () => {
		mockNextFetch(jsonResponse(200, { access_token: "fresh" }));

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
		});

		expect(captured[0]?.init?.signal).toBeUndefined();
	});

	it("bounds the whole exchange by timeoutMs and reports a stalled one as network_error", async () => {
		safeFetchSpy.mockImplementationOnce(
			(_input: string | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);

		const started = Date.now();
		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			timeoutMs: 25,
		});

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result).toMatchObject({ ok: false, errorCode: "network_error" });
	});

	it("returns invalid_response when access_token is missing on 200", async () => {
		mockNextFetch(jsonResponse(200, { token_type: "Bearer" }));

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("invalid_response");
		}
	});

	it("treats a 200 OK with embedded {error: ...} as a failure", async () => {
		// GitHub returns 200 with {error: ...} for some misconfigurations.
		mockNextFetch(
			jsonResponse(200, {
				error: "bad_verification_code",
				error_description: "The code passed is incorrect or expired.",
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result).toEqual({
			ok: false,
			errorCode: "bad_verification_code",
			errorMessage: "The code passed is incorrect or expired.",
		});
	});

	it("propagates SSRF protection by routing through safeFetchOutbound", async () => {
		// Don't mock the implementation — let the real safeFetchOutbound run
		// against an unsafe URL and observe that we surface the rejection as
		// network_error rather than throwing.
		safeFetchSpy.mockRestore();

		const result = await refreshOAuthToken({
			tokenEndpoint: "http://127.0.0.1/token",
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("network_error");
			expect(result.errorMessage.toLowerCase()).toContain("loopback");
		}
	});
});

describe("refreshOAuthToken client authentication", () => {
	it("sends client_secret_basic credentials in an Authorization header, not the body", async () => {
		mockNextFetch(jsonResponse(200, { access_token: "fresh" }));

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
			clientAuthMethod: "client_secret_basic",
		});

		const init = captured[0]?.init;
		expect(getHeader(init, "authorization")).toBe(
			`Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
		);
		const body = decodeBody(init);
		expect(body.get("client_secret")).toBeNull();
		expect(body.get("client_id")).toBeNull();
		expect(body.get("refresh_token")).toBe("old-refresh");
	});

	it("sends client_secret_post credentials in the body", async () => {
		mockNextFetch(jsonResponse(200, { access_token: "fresh" }));

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
			clientAuthMethod: "client_secret_post",
		});

		const init = captured[0]?.init;
		expect(getHeader(init, "authorization")).toBeNull();
		const body = decodeBody(init);
		expect(body.get("client_id")).toBe("client-1");
		expect(body.get("client_secret")).toBe("secret-1");
	});

	it("never sends a secret for a public client, even when one is passed", async () => {
		mockNextFetch(jsonResponse(200, { access_token: "fresh" }));

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "public-client",
			clientSecret: "should-not-leave",
			clientAuthMethod: "none",
		});

		const init = captured[0]?.init;
		expect(getHeader(init, "authorization")).toBeNull();
		const body = decodeBody(init);
		expect(body.get("client_id")).toBe("public-client");
		expect(body.get("client_secret")).toBeNull();
	});

	it("refuses client_secret_basic without a secret and contacts nothing", async () => {
		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientAuthMethod: "client_secret_basic",
		});

		expect(result).toMatchObject({
			ok: false,
			errorCode: "missing_client_secret",
		});
		expect(safeFetchSpy).not.toHaveBeenCalled();
	});

	it("refuses redirects on the token request", async () => {
		mockNextFetch(jsonResponse(200, { access_token: "fresh" }));

		await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
		});

		expect(captured[0]?.init?.redirect).toBe("error");
	});
});

describe("refreshOAuthToken error text", () => {
	const SECRET_SHAPED = "rt_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c";

	it("never puts a raw non-JSON error body in the message", async () => {
		mockNextFetch(
			textResponse(
				400,
				`<html>refresh_token=old-refresh client_secret=secret-1 ${SECRET_SHAPED}</html>`,
				"text/html",
			),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorMessage).toBe("HTTP 400 from token endpoint");
			expect(result.errorMessage).not.toContain("html");
		}
	});

	it("never echoes a 2xx non-JSON body", async () => {
		mockNextFetch(
			textResponse(200, `access_token=${SECRET_SHAPED}&scope=repo`),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result).toEqual({
			ok: false,
			errorCode: "invalid_response",
			errorMessage: "Token endpoint returned a non-JSON body",
		});
	});

	it("redacts the request's own secrets and token-shaped values from error_description", async () => {
		mockNextFetch(
			jsonResponse(400, {
				error: "invalid_grant",
				error_description: `refresh token old-refresh-token-value for client secret-1 is revoked; hint ${SECRET_SHAPED} Bearer abc.def`,
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh-token-value",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorCode).toBe("invalid_grant");
			for (const leaked of [
				"old-refresh-token-value",
				"secret-1",
				SECRET_SHAPED,
				"abc.def",
			]) {
				expect(result.errorMessage).not.toContain(leaked);
			}
			expect(result.errorMessage).toContain("is revoked");
		}
	});

	it("never echoes a provider error code it does not recognise", async () => {
		// The provider puts the very refresh token it was sent in `error`.
		mockNextFetch(jsonResponse(400, { error: "old-refresh-token-value" }));

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh-token-value",
			clientId: "client-1",
			clientSecret: "secret-1",
		});

		expect(result).toEqual({
			ok: false,
			errorCode: "unrecognized_error",
			errorMessage: "unrecognized_error",
		});
	});

	it("classifies an unrecognised code the same way on a 200 and in a form-encoded body", async () => {
		mockNextFetch(jsonResponse(200, { error: "s3cr3t-in-error" }));
		mockNextFetch(textResponse(400, "error=s3cr3t-in-error"));

		const first = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "r",
			clientId: "c",
		});
		const second = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "r",
			clientId: "c",
		});

		for (const result of [first, second]) {
			expect(JSON.stringify(result)).not.toContain("s3cr3t-in-error");
		}
		expect(first).toMatchObject({ errorCode: "unrecognized_error" });
		expect(second).toMatchObject({
			errorCode: "http_400",
			errorMessage:
				"HTTP 400 from token endpoint (error: unrecognized_error)",
		});
	});

	it("bounds the description", async () => {
		mockNextFetch(
			jsonResponse(400, {
				error: "invalid_request",
				error_description: "word ".repeat(200),
			}),
		);

		const result = await refreshOAuthToken({
			tokenEndpoint: ENDPOINT,
			refreshToken: "old-refresh",
			clientId: "client-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorMessage.length).toBeLessThanOrEqual(201);
		}
	});
});

describe("sanitizeOAuthErrorText", () => {
	it("removes credential-named parameters, JWTs and listed secrets", () => {
		const out = sanitizeOAuthErrorText(
			'bad "client_secret": "s3cr3t-value" code=abc123 eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl and my-listed-secret',
			["my-listed-secret"],
		);
		expect(out).not.toContain("s3cr3t-value");
		expect(out).not.toContain("abc123");
		expect(out).not.toContain("eyJhbGciOi");
		expect(out).not.toContain("my-listed-secret");
	});

	it("keeps an ordinary message and a URL", () => {
		expect(
			sanitizeOAuthErrorText(
				"The refresh token is expired, see https://auth.example.com/docs/errors/expired",
			),
		).toBe(
			"The refresh token is expired, see https://auth.example.com/docs/errors/expired",
		);
	});
});
