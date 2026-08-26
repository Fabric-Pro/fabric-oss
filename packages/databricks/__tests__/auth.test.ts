import { describe, expect, it, vi } from "vitest";

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock("@repo/logs", () => ({
	logger: { warn: warnSpy, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	createDatabricksTokenProvider,
	DatabricksTokenFetchError,
	DatabricksTokenProtocolError,
	DatabricksTokenTimeoutError,
} from "../src/auth";

const BASE_HOST = "https://ws.azuredatabricks.net";

const BASE_ENV = {
	DATABRICKS_HOST: BASE_HOST,
	DATABRICKS_CLIENT_ID: "client-id",
	DATABRICKS_CLIENT_SECRET: "client-secret",
};

function makeOAuthResponse(
	accessToken = "oauth-token",
	expiresIn = 3600,
): Response {
	return new Response(
		JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

describe("createDatabricksTokenProvider — throws when unconfigured", () => {
	it("throws when no config at all", () => {
		expect(() => createDatabricksTokenProvider({ env: {} })).toThrow(
			/not configured/,
		);
	});

	it("throws when host is set but no credentials", () => {
		expect(() =>
			createDatabricksTokenProvider({
				env: { DATABRICKS_HOST: BASE_HOST },
			}),
		).toThrow(/not configured/);
	});
});

describe("PAT provider", () => {
	it("getToken resolves the static PAT token", async () => {
		const provider = createDatabricksTokenProvider({
			env: {
				DATABRICKS_HOST: BASE_HOST,
				DATABRICKS_TOKEN: "dapi-secret",
			},
		});
		expect(await provider.getToken()).toBe("dapi-secret");
	});

	it("PAT takes precedence over OAuth credentials when both are set", async () => {
		const fetchImpl = vi.fn();
		const provider = createDatabricksTokenProvider({
			env: {
				...BASE_ENV,
				DATABRICKS_TOKEN: "pat-wins",
			},
			fetchImpl,
		});
		expect(await provider.getToken()).toBe("pat-wins");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("invalidate is a no-op (token unchanged)", async () => {
		const provider = createDatabricksTokenProvider({
			env: {
				DATABRICKS_HOST: BASE_HOST,
				DATABRICKS_TOKEN: "dapi-secret",
			},
		});
		provider.invalidate();
		expect(await provider.getToken()).toBe("dapi-secret");
	});
});

describe("OAuth M2M provider — happy path", () => {
	it("requests a token from the correct endpoint with correct headers and body", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(makeOAuthResponse());
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		const token = await provider.getToken();

		expect(token).toBe("oauth-token");
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${BASE_HOST}/oidc/v1/token`);
		// auth.ts passes headers as a plain object literal.
		const headers = new Headers(init.headers);
		expect(headers.get("Content-Type")).toBe(
			"application/x-www-form-urlencoded",
		);

		// Authorization: Basic base64(clientId:clientSecret)
		const expectedCredentials = Buffer.from(
			"client-id:client-secret",
		).toString("base64");
		expect(headers.get("Authorization")).toBe(
			`Basic ${expectedCredentials}`,
		);

		// Body must include grant_type and scope
		const body = init.body as string;
		const params = new URLSearchParams(body);
		expect(params.get("grant_type")).toBe("client_credentials");
		expect(params.get("scope")).toBe("all-apis");
	});
});

describe("OAuth M2M provider — caching", () => {
	it("caches the token and does not refetch on second getToken call", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(makeOAuthResponse());
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		await provider.getToken();
		await provider.getToken();

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("OAuth M2M provider — near-expiry refresh", () => {
	it("refetches when the token is within the 10-minute refresh margin", async () => {
		// expires_in = 60s → margin of 10 minutes → token is immediately stale
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(makeOAuthResponse("first-token", 60))
			.mockResolvedValueOnce(makeOAuthResponse("second-token", 3600));

		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		const first = await provider.getToken();
		expect(first).toBe("first-token");

		// Token has expires_in=60 (1 minute from now), but margin is 10 minutes → stale
		const second = await provider.getToken();
		expect(second).toBe("second-token");

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});

describe("OAuth M2M provider — single-flight", () => {
	it("two concurrent getToken calls result in exactly one fetch", async () => {
		let resolveFirst!: (r: Response) => void;
		const first = new Promise<Response>((res) => {
			resolveFirst = res;
		});

		const fetchImpl = vi.fn().mockReturnValueOnce(first);
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		const p1 = provider.getToken();
		const p2 = provider.getToken();

		// Resolve the underlying fetch now
		resolveFirst(makeOAuthResponse("shared-token"));

		const [t1, t2] = await Promise.all([p1, p2]);

		expect(t1).toBe("shared-token");
		expect(t2).toBe("shared-token");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("OAuth M2M provider — invalidate", () => {
	it("forces a refetch on the next getToken call after invalidate", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(makeOAuthResponse("first-token"))
			.mockResolvedValueOnce(makeOAuthResponse("refreshed-token"));

		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		expect(await provider.getToken()).toBe("first-token");
		provider.invalidate();
		expect(await provider.getToken()).toBe("refreshed-token");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});

describe("OAuth M2M provider — error cases", () => {
	it("throws with status when fetch returns a non-OK response", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("Unauthorized", { status: 401 }),
			);
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		await expect(provider.getToken()).rejects.toThrow(/401/);
	});

	it("does not put the response body in the thrown error", async () => {
		// The body is untrusted and may echo request detail. Error messages
		// propagate (the API's audit middleware persists cause chains), so the
		// body must stay server-side — only the status travels.
		const leaky = "internal-host=vault.internal; request_id=abc";
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(leaky, { status: 401 }));
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		// `getToken` resolves to a string, so type the rejection explicitly.
		const error = (await provider.getToken().then(
			() => undefined,
			(e: unknown) => e,
		)) as DatabricksTokenFetchError;

		expect(error).toBeInstanceOf(DatabricksTokenFetchError);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("DatabricksTokenFetchError");
		// Programmatic surface preserved: status readable without parsing.
		expect(error.status).toBe(401);
		expect(error.message).toContain("401");
		expect(error.message).not.toContain(leaky);
		expect(error.message).not.toContain("vault.internal");
		expect(error.cause).toBeUndefined();
	});

	it("logs ONLY the status — never any part of an error response body", async () => {
		// This request sends `Authorization: Basic base64(clientId:clientSecret)`.
		// A workspace edge, debugging proxy or upstream error handler can echo
		// request headers back in its diagnostic body, so reading that body at all
		// risks writing the service principal's credentials to centralized logs.
		// Even a truncated excerpt is enough to leak them.
		warnSpy.mockClear();
		const marker = "credential-echo-do-not-leak";
		const body = `line-one\n${marker} ${"y".repeat(5000)}`;
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(body, { status: 500 }));
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		await provider.getToken().catch(() => undefined);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		for (const call of warnSpy.mock.calls) {
			const line = String(call[0]);
			expect(line).not.toContain(marker);
			expect(line).not.toContain("y".repeat(20));
			expect(line).not.toContain("line-one");
			expect(line).not.toContain("\n");
		}
		expect(String(warnSpy.mock.calls[0][0])).toContain("500");
	});

	it("does not leak body content when a 200 response is not valid JSON", async () => {
		// The native JSON.parse failure quotes the input — e.g.
		// `Unexpected token 's', "secret-mar"... is not valid JSON` — which the
		// vector-search verification path returns verbatim to its caller.
		warnSpy.mockClear();
		const marker = "secret-marker-do-not-leak";
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(marker, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		const error = (await provider.getToken().then(
			() => undefined,
			(e: unknown) => e,
		)) as DatabricksTokenProtocolError;

		expect(error).toBeInstanceOf(DatabricksTokenProtocolError);
		expect(error.name).toBe("DatabricksTokenProtocolError");
		expect(error.message).toBe(
			"Databricks OAuth response was not valid JSON",
		);
		// Marker must appear nowhere: message, cause chain, or logs.
		expect(error.message).not.toContain(marker);
		expect(error.cause).toBeUndefined();
		expect(
			JSON.stringify(error, Object.getOwnPropertyNames(error)),
		).not.toContain(marker);
		for (const call of warnSpy.mock.calls) {
			expect(String(call[0])).not.toContain(marker);
		}
	});

	it("uses a static protocol error when access_token is absent", async () => {
		const marker = "leaky-field-value";
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ other: marker }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		const error = (await provider.getToken().then(
			() => undefined,
			(e: unknown) => e,
		)) as DatabricksTokenProtocolError;

		expect(error).toBeInstanceOf(DatabricksTokenProtocolError);
		expect(error.message).toBe(
			"Databricks OAuth response did not include access_token",
		);
		expect(error.message).not.toContain(marker);
		expect(error.cause).toBeUndefined();
	});

	it("passes an abort signal so a stalled exchange cannot hang forever", async () => {
		// Production callers pass no signal. Without an intrinsic ceiling a
		// stalled request leaves the single-flight promise pending forever, and
		// every later caller coalesces onto it — wedging all token acquisition.
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(makeOAuthResponse("tok", 3600));
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		await provider.getToken();

		const init = fetchImpl.mock.calls[0][1] as RequestInit;
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("fails with a typed timeout error and frees the single-flight slot", async () => {
		const timeoutError = new Error("The operation was aborted");
		timeoutError.name = "TimeoutError";

		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(timeoutError)
			// A retry after the timeout must start a FRESH exchange rather than
			// joining the dead promise.
			.mockResolvedValueOnce(makeOAuthResponse("tok-after-retry", 3600));
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		const error = (await provider.getToken().then(
			() => undefined,
			(e: unknown) => e,
		)) as DatabricksTokenTimeoutError;

		expect(error).toBeInstanceOf(DatabricksTokenTimeoutError);
		expect(error.name).toBe("DatabricksTokenTimeoutError");
		expect(error.timeoutMs).toBeGreaterThan(0);
		expect(error.cause).toBeUndefined();

		await expect(provider.getToken()).resolves.toBe("tok-after-retry");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("rejects a non-numeric expires_in instead of caching a NaN expiry", async () => {
		// `(expires_in ?? 3600) * 1000` on a string yields NaN, every NaN
		// comparison in isStale() is false, so the token would be treated as
		// permanently fresh and never refreshed for the process lifetime.
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "tok",
					expires_in: "invalid",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		const error = (await provider.getToken().then(
			() => undefined,
			(e: unknown) => e,
		)) as DatabricksTokenProtocolError;

		expect(error).toBeInstanceOf(DatabricksTokenProtocolError);
		expect(error.message).toBe(
			"Databricks OAuth response had an invalid expires_in",
		);
	});

	it("rejects a non-positive expires_in", async () => {
		// NaN/Infinity are not tested here because JSON cannot carry them —
		// `JSON.stringify` turns both into `null`, which is the documented
		// "absent" case and correctly falls back to the default lifetime.
		for (const bad of [0, -1]) {
			const fetchImpl = vi.fn().mockResolvedValueOnce(
				new Response(
					JSON.stringify({ access_token: "tok", expires_in: bad }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
			const provider = createDatabricksTokenProvider({
				env: BASE_ENV,
				fetchImpl,
			});

			await expect(provider.getToken()).rejects.toBeInstanceOf(
				DatabricksTokenProtocolError,
			);
		}
	});

	it("rejects a non-string or empty access_token", async () => {
		for (const bad of [123, "", null, { nested: true }]) {
			const fetchImpl = vi.fn().mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: bad }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			const provider = createDatabricksTokenProvider({
				env: BASE_ENV,
				fetchImpl,
			});

			await expect(provider.getToken()).rejects.toBeInstanceOf(
				DatabricksTokenProtocolError,
			);
		}
	});

	it("clamps an absurd but finite expires_in instead of caching a non-finite expiry", async () => {
		// 1e308 passes the finite/positive checks, but `* 1000` overflows to
		// Infinity. An unclamped expiry makes every isStale() comparison false,
		// pinning the token for the process lifetime and disabling refresh.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(makeOAuthResponse("tok-1", 1e308))
				.mockResolvedValueOnce(makeOAuthResponse("tok-2", 3600));
			const provider = createDatabricksTokenProvider({
				env: BASE_ENV,
				fetchImpl,
			});

			await expect(provider.getToken()).resolves.toBe("tok-1");

			// Past the 24h cap, so a correctly clamped expiry is now stale.
			vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
			await expect(provider.getToken()).resolves.toBe("tok-2");
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts a response that omits expires_in, defaulting the lifetime", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ access_token: "tok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		await expect(provider.getToken()).resolves.toBe("tok");
	});

	it("throws when access_token is missing from response", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		await expect(provider.getToken()).rejects.toThrow(/access_token/);
	});

	it("defaults expires_in to 3600 when absent from response", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "tok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(makeOAuthResponse("second"));

		const provider = createDatabricksTokenProvider({
			env: BASE_ENV,
			fetchImpl,
		});

		// First call — gets "tok" with implied 3600s expiry, should be cached
		expect(await provider.getToken()).toBe("tok");
		// Second call — still within cache window, should NOT refetch
		expect(await provider.getToken()).toBe("tok");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
