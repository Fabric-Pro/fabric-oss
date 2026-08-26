/**
 * Tests for Databricks service-principal (OAuth M2M) credential resolution.
 *
 * `resolveProviderApiKey` is the single chokepoint that turns a stored AI
 * provider config into the plaintext bearer token sent upstream. It must:
 *  - keep existing PAT/API-key rows working byte-for-byte (regression guard);
 *  - exchange a service principal for a workspace access token;
 *  - cache that token so N AI calls don't mint N tokens;
 *  - key the cache by the credential, so a rotated secret is never served from
 *    a provider closed over the old one;
 *  - surface exchange failures as a distinct, actionable error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({
	// Mirror the real helpers closely enough to assert on: the tests store
	// "encrypted:<plaintext>" and expect the plaintext back. Strict throws on a
	// non-encrypted value; the "Maybe" variant returns it unchanged.
	decryptApiKey: vi.fn((value: string) => {
		if (!value.startsWith("encrypted:")) {
			throw new Error("Invalid encrypted value");
		}
		return value.slice("encrypted:".length);
	}),
	decryptApiKeyMaybe: vi.fn((value: string) =>
		value.startsWith("encrypted:")
			? value.slice("encrypted:".length)
			: value,
	),
}));

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock("@repo/logs", () => ({
	logger: { warn: warnSpy, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	__databricksOAuthCacheKeys,
	__databricksOAuthCacheSize,
	__resetDatabricksOAuthCache,
	DatabricksOAuthError,
	getDatabricksOAuthToken,
	hasProviderCredentials,
	hasServicePrincipalCredentials,
	resolveProviderApiKey,
} from "../lib/databricks-oauth";

const WORKSPACE = "https://example-workspace.cloud.databricks.com";

/** A fetch stub that returns a token response and records its calls. */
function tokenFetch(
	accessToken = "minted-access-token",
	expiresIn = 3600,
): ReturnType<typeof vi.fn> {
	return vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			access_token: accessToken,
			expires_in: expiresIn,
		}),
		text: async () => "",
	})) as unknown as ReturnType<typeof vi.fn>;
}

const servicePrincipalConfig = {
	provider: "DATABRICKS",
	apiKey: null,
	baseUrl: WORKSPACE,
	clientId: "client-abc",
	encryptedClientSecret: "encrypted:secret-xyz",
};

beforeEach(() => {
	__resetDatabricksOAuthCache();
	vi.clearAllMocks();
});

describe("credential predicates", () => {
	it("treats a stored API key as configured", () => {
		expect(
			hasProviderCredentials({
				apiKey: "encrypted:dapi-token",
				clientId: null,
				encryptedClientSecret: null,
			}),
		).toBe(true);
	});

	it("treats a complete service principal as configured", () => {
		expect(hasProviderCredentials(servicePrincipalConfig)).toBe(true);
		expect(hasServicePrincipalCredentials(servicePrincipalConfig)).toBe(
			true,
		);
	});

	it("does NOT treat half a service principal as configured", () => {
		expect(
			hasProviderCredentials({
				apiKey: null,
				clientId: "client-abc",
				encryptedClientSecret: null,
			}),
		).toBe(false);
		expect(
			hasProviderCredentials({
				apiKey: null,
				clientId: null,
				encryptedClientSecret: "encrypted:secret-xyz",
			}),
		).toBe(false);
	});

	it("treats an empty config as unconfigured", () => {
		expect(
			hasProviderCredentials({
				apiKey: null,
				clientId: null,
				encryptedClientSecret: null,
			}),
		).toBe(false);
	});
});

describe("resolveProviderApiKey — API key mode (regression guard)", () => {
	it("decrypts and returns a stored API key without any network call", async () => {
		const fetchImpl = tokenFetch();

		const token = await resolveProviderApiKey(
			{
				provider: "DATABRICKS",
				apiKey: "encrypted:dapi-token",
				baseUrl: WORKSPACE,
				clientId: null,
				encryptedClientSecret: null,
			},
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		expect(token).toBe("dapi-token");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("works for non-Databricks providers, which never OAuth", async () => {
		const token = await resolveProviderApiKey({
			provider: "OPENAI_DIRECT",
			apiKey: "encrypted:sk-test",
			baseUrl: null,
			clientId: null,
			encryptedClientSecret: null,
		});

		expect(token).toBe("sk-test");
	});

	it("throws on a non-encrypted stored key by default (inference paths stay strict)", async () => {
		await expect(
			resolveProviderApiKey({
				provider: "DATABRICKS",
				apiKey: "plaintext-legacy-key",
				baseUrl: WORKSPACE,
				clientId: null,
				encryptedClientSecret: null,
			}),
		).rejects.toThrow(/Invalid encrypted value/);
	});

	it("tolerates a non-encrypted stored key under lenientDecrypt (legacy rows)", async () => {
		// The gateway model listing had this tolerance before the refactor and
		// must keep it, or legacy plaintext rows stop listing models.
		await expect(
			resolveProviderApiKey(
				{
					provider: "DATABRICKS",
					apiKey: "plaintext-legacy-key",
					baseUrl: WORKSPACE,
					clientId: null,
					encryptedClientSecret: null,
				},
				{ lenientDecrypt: true },
			),
		).resolves.toBe("plaintext-legacy-key");
	});

	it("prefers a PAT over a service principal when both are somehow set", async () => {
		const fetchImpl = tokenFetch();

		const token = await resolveProviderApiKey(
			{
				...servicePrincipalConfig,
				apiKey: "encrypted:dapi-token",
			},
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		expect(token).toBe("dapi-token");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("resolveProviderApiKey — service principal mode", () => {
	it("exchanges client credentials for an access token", async () => {
		const fetchImpl = tokenFetch("minted-access-token");

		const token = await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(token).toBe("minted-access-token");
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const [url, init] = (
			fetchImpl as unknown as { mock: { calls: any[][] } }
		).mock.calls[0];
		expect(url).toBe(`${WORKSPACE}/oidc/v1/token`);
		expect(init.method).toBe("POST");
		// Client credentials go in a Basic auth header, not the body.
		expect(init.headers.Authorization).toBe(
			`Basic ${Buffer.from("client-abc:secret-xyz").toString("base64")}`,
		);
		expect(init.body).toContain("grant_type=client_credentials");
	});

	it("normalizes a serving-endpoints base URL down to the workspace host", async () => {
		const fetchImpl = tokenFetch();

		await resolveProviderApiKey(
			{
				...servicePrincipalConfig,
				baseUrl: `${WORKSPACE}/serving-endpoints`,
			},
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		// The OIDC endpoint lives at the workspace root — feeding it the
		// inference path would 404.
		const [url] = (fetchImpl as unknown as { mock: { calls: any[][] } })
			.mock.calls[0];
		expect(url).toBe(`${WORKSPACE}/oidc/v1/token`);
	});

	it("normalizes a Unity AI Gateway base URL down to the workspace host", async () => {
		const fetchImpl = tokenFetch();

		await resolveProviderApiKey(
			{
				...servicePrincipalConfig,
				baseUrl: `${WORKSPACE}/ai-gateway/mlflow/v1`,
			},
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		const [url] = (fetchImpl as unknown as { mock: { calls: any[][] } })
			.mock.calls[0];
		expect(url).toBe(`${WORKSPACE}/oidc/v1/token`);
	});

	it("caches the token across calls instead of minting one per AI call", async () => {
		const fetchImpl = tokenFetch();

		const first = await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const second = await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(first).toBe(second);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("coalesces concurrent callers onto one in-flight exchange", async () => {
		const fetchImpl = tokenFetch();

		const [a, b, c] = await Promise.all([
			resolveProviderApiKey(servicePrincipalConfig, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
			resolveProviderApiKey(servicePrincipalConfig, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
			resolveProviderApiKey(servicePrincipalConfig, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		]);

		expect([a, b, c]).toEqual([
			"minted-access-token",
			"minted-access-token",
			"minted-access-token",
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("keeps the cached provider when a caller aborts its own wait", async () => {
		// `waitAbortable` stops only the aborting caller's wait — the shared
		// exchange keeps running and still warms the provider's token cache.
		// Evicting on that abort would discard a healthy provider and force the
		// next caller into a redundant exchange.
		let releaseToken: (v: unknown) => void = () => undefined;
		const fetchImpl = vi.fn(
			() =>
				new Promise((resolve) => {
					releaseToken = resolve;
				}),
		) as unknown as typeof fetch;

		const controller = new AbortController();

		// A waits with an abortable signal; B coalesces onto the same exchange.
		const aborted = resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl,
			signal: controller.signal,
		});
		const shared = resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl,
		});

		// A gives up before the exchange completes.
		controller.abort();
		await expect(aborted).rejects.toSatisfy(
			(e: unknown) => (e as Error)?.name === "AbortError",
		);

		// The exchange then succeeds for B.
		releaseToken({
			ok: true,
			status: 200,
			json: async () => ({
				access_token: "shared-token",
				expires_in: 3600,
			}),
			text: async () => "",
		});
		await expect(shared).resolves.toBe("shared-token");

		// C must reuse the surviving cached provider — still one exchange.
		await expect(
			resolveProviderApiKey(servicePrincipalConfig, { fetchImpl }),
		).resolves.toBe("shared-token");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(__databricksOAuthCacheSize()).toBe(1);
	});

	it("re-exchanges when the secret is rotated rather than serving the stale token", async () => {
		const firstFetch = tokenFetch("token-from-old-secret");
		await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl: firstFetch as unknown as typeof fetch,
		});

		const secondFetch = tokenFetch("token-from-new-secret");
		const rotated = await resolveProviderApiKey(
			{
				...servicePrincipalConfig,
				encryptedClientSecret: "encrypted:secret-rotated",
			},
			{ fetchImpl: secondFetch as unknown as typeof fetch },
		);

		expect(rotated).toBe("token-from-new-secret");
		expect(secondFetch).toHaveBeenCalledTimes(1);
	});

	it("keys the cache by workspace host, so two workspaces don't share a token", async () => {
		const firstFetch = tokenFetch("token-workspace-a");
		await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl: firstFetch as unknown as typeof fetch,
		});

		const secondFetch = tokenFetch("token-workspace-b");
		const other = await resolveProviderApiKey(
			{
				...servicePrincipalConfig,
				baseUrl: "https://other-workspace.cloud.databricks.com",
			},
			{ fetchImpl: secondFetch as unknown as typeof fetch },
		);

		expect(other).toBe("token-workspace-b");
		expect(secondFetch).toHaveBeenCalledTimes(1);
	});
});

describe("resolveProviderApiKey — failure modes", () => {
	it("throws DatabricksOAuthError when the exchange is rejected", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 401,
			text: async () => "invalid_client",
			json: async () => ({}),
		})) as unknown as typeof fetch;

		await expect(
			resolveProviderApiKey(servicePrincipalConfig, { fetchImpl }),
		).rejects.toBeInstanceOf(DatabricksOAuthError);
	});

	it("retries the exchange after a failure instead of wedging the credential", async () => {
		const failing = vi.fn(async () => ({
			ok: false,
			status: 503,
			text: async () => "unavailable",
			json: async () => ({}),
		})) as unknown as typeof fetch;

		await expect(
			resolveProviderApiKey(servicePrincipalConfig, {
				fetchImpl: failing,
			}),
		).rejects.toBeInstanceOf(DatabricksOAuthError);

		// A transient failure must not leave a poisoned cache entry.
		const recovering = tokenFetch("token-after-recovery");
		await expect(
			resolveProviderApiKey(servicePrincipalConfig, {
				fetchImpl: recovering as unknown as typeof fetch,
			}),
		).resolves.toBe("token-after-recovery");
		expect(recovering).toHaveBeenCalledTimes(1);
	});

	it("throws when a service principal has no workspace URL", async () => {
		await expect(
			resolveProviderApiKey({
				...servicePrincipalConfig,
				baseUrl: null,
			}),
		).rejects.toThrow(/workspace URL/i);
	});

	it("throws when the config carries no credentials at all", async () => {
		await expect(
			resolveProviderApiKey({
				provider: "DATABRICKS",
				apiKey: null,
				baseUrl: WORKSPACE,
				clientId: null,
				encryptedClientSecret: null,
			}),
		).rejects.toThrow(/No credentials configured/i);
	});

	it("refuses service-principal auth for a provider that does not support it", async () => {
		await expect(
			resolveProviderApiKey({
				...servicePrincipalConfig,
				provider: "OPENAI_DIRECT",
			}),
		).rejects.toThrow(/not supported for provider OPENAI_DIRECT/i);
	});
});

describe("getDatabricksOAuthToken — URL hardening (SSRF)", () => {
	it("rejects an empty workspace URL rather than calling a bare /oidc path", async () => {
		const fetchImpl = tokenFetch();

		await expect(
			getDatabricksOAuthToken("", "client-abc", "secret-xyz", {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toBeInstanceOf(DatabricksOAuthError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses to POST the client secret over plaintext HTTP", async () => {
		const fetchImpl = tokenFetch();

		await expect(
			getDatabricksOAuthToken(
				"http://example-workspace.cloud.databricks.com",
				"client-abc",
				"secret-xyz",
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).rejects.toThrow(/must use HTTPS/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a malformed URL instead of coercing it to some origin", async () => {
		// The shared inference-path normalizer has a best-effort fallback for
		// unparseable input; this credential-bearing path must fail closed.
		const fetchImpl = tokenFetch();

		await expect(
			getDatabricksOAuthToken(
				"not-a-url/serving-endpoints",
				"client-abc",
				"secret-xyz",
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).rejects.toThrow(/not a valid absolute URL/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects a non-HTTP(S) scheme such as file:", async () => {
		const fetchImpl = tokenFetch();

		await expect(
			getDatabricksOAuthToken("file:///etc/passwd", "id", "secret", {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow(/must use HTTPS/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("token cache hygiene", () => {
	it("does not retain the plaintext secret in any cache key", async () => {
		const fetchImpl = tokenFetch();
		await getDatabricksOAuthToken(
			WORKSPACE,
			"client-abc",
			"super-secret-value",
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		// The cache is keyed by a SHA-256 digest, so the secret must not appear
		// in any live key even though rotation still produces a distinct key.
		expect(__databricksOAuthCacheSize()).toBe(1);
		const keys = __databricksOAuthCacheKeys();
		expect(keys).toHaveLength(1);
		expect(keys[0]).not.toContain("super-secret-value");
		// Still scoped to host + client id, and carries a 64-hex digest.
		expect(keys[0]).toContain(WORKSPACE);
		expect(keys[0]).toContain("client-abc");
		expect(keys[0]).toMatch(/::[0-9a-f]{64}$/);
	});

	it("keys rotated secrets distinctly despite hashing", async () => {
		await getDatabricksOAuthToken(WORKSPACE, "client-abc", "secret-one", {
			fetchImpl: tokenFetch("t1") as unknown as typeof fetch,
		});
		await getDatabricksOAuthToken(WORKSPACE, "client-abc", "secret-two", {
			fetchImpl: tokenFetch("t2") as unknown as typeof fetch,
		});

		expect(__databricksOAuthCacheSize()).toBe(2);
	});

	it("bounds the cache so rotated secrets cannot accumulate forever", async () => {
		// Simulate repeated secret rotation in a long-lived worker.
		for (let i = 0; i < 300; i++) {
			await getDatabricksOAuthToken(
				WORKSPACE,
				"client-abc",
				`rotated-secret-${i}`,
				{
					fetchImpl: tokenFetch(
						`token-${i}`,
					) as unknown as typeof fetch,
				},
			);
		}

		expect(__databricksOAuthCacheSize()).toBeLessThanOrEqual(256);
	});
});

describe("error sanitization", () => {
	it("does not echo the token endpoint's response body to the caller", async () => {
		const leaky =
			"internal-host=vault.internal; request_id=abc; hint=rotate-me";
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 401,
			text: async () => leaky,
			json: async () => ({}),
		})) as unknown as typeof fetch;

		const error = await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl,
		}).catch((e) => e as DatabricksOAuthError);

		expect(error).toBeInstanceOf(DatabricksOAuthError);
		// The status is useful and safe; the body is neither.
		expect(error.message).toContain("401");
		expect(error.message).not.toContain(leaky);
		expect(error.message).not.toContain("vault.internal");
		expect(error.status).toBe(401);
	});

	it("attaches NO cause, so the audit middleware cannot serialize a chain", async () => {
		// The oRPC audit middleware walks `Error.cause` and persists it into
		// org-admin-readable rows — the chain must be cut on this path.
		const leaky = "internal-host=vault.internal; token_hint=abc";
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 403,
			text: async () => leaky,
			json: async () => ({}),
		})) as unknown as typeof fetch;

		const error = await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl,
		}).catch((e) => e as DatabricksOAuthError);

		expect(error.cause).toBeUndefined();
		expect(
			JSON.stringify(error, Object.getOwnPropertyNames(error)),
		).not.toContain("vault.internal");
	});

	it("keeps the untrusted response body out of the log line too", async () => {
		warnSpy.mockClear();
		const leaky = "x".repeat(5000);
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 500,
			text: async () => leaky,
			json: async () => ({}),
		})) as unknown as typeof fetch;

		await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl,
		}).catch(() => undefined);

		// The wrapper's own log carries tenant context but no body — the body is
		// bounded at its source in `@repo/databricks`, which this suite mocks
		// out only for `@repo/logs`, not for the auth module itself.
		for (const call of warnSpy.mock.calls) {
			expect(String(call[0]).length).toBeLessThan(1024);
		}
	});

	it("bounds and flattens a hostile clientId in the log line", async () => {
		// `clientId` is user-supplied. A newline-bearing value could otherwise
		// forge extra log entries; a long one could produce an oversized entry.
		warnSpy.mockClear();
		const hostileClientId = `evil\n[fake] forged entry ${"z".repeat(4000)}`;
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 500,
			text: async () => "boom",
			json: async () => ({}),
		})) as unknown as typeof fetch;

		await resolveProviderApiKey(
			{
				...servicePrincipalConfig,
				clientId: hostileClientId,
			},
			{ fetchImpl },
		).catch(() => undefined);

		expect(warnSpy).toHaveBeenCalled();
		// Every emitted line must be single-line and bounded, not just the
		// wrapper's — `@repo/logs` is mocked once for both loggers here.
		for (const call of warnSpy.mock.calls) {
			const line = String(call[0]);
			expect(line).not.toContain("\n");
			expect(line.length).toBeLessThan(1200);
		}

		const wrapperLine = warnSpy.mock.calls
			.map((c) => String(c[0]))
			.find((l) => l.includes("Service-principal token exchange failed"));
		expect(wrapperLine).toBeDefined();
		// The hostile clientId was truncated rather than interpolated whole.
		expect(wrapperLine).toContain("truncated");
		expect(wrapperLine).not.toContain("z".repeat(200));
	});

	it("still produces a message when no status can be extracted", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("socket hang up to internal.example");
		}) as unknown as typeof fetch;

		const error = await resolveProviderApiKey(servicePrincipalConfig, {
			fetchImpl,
		}).catch((e) => e as DatabricksOAuthError);

		expect(error).toBeInstanceOf(DatabricksOAuthError);
		expect(error.message).toMatch(/token exchange failed/i);
		expect(error.message).not.toContain("internal.example");
	});
});
