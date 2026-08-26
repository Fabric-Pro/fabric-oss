import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

import { refreshOAuthToken } from "../lib/oauth-refresh";
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
