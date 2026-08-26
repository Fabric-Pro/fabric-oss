/**
 * Tests for OAuth provider refresh-token race serialization + retry.
 *
 * Two failure modes:
 *  - Within-replica race: two `tokens()` calls observe expired token
 *    simultaneously, both try to refresh; the in-flight mutex
 *    deduplicates them so only ONE token-endpoint request is made.
 *  - Cross-replica race: a parallel temporal-worker replica just
 *    rotated the refresh token in the DB; our refresh attempt with
 *    the stale token gets `invalid_grant`; we reload the MCPConfig
 *    and retry once with the freshly-rotated token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/database — the provider loads + writes MCPConfig from here.
const mockConfigState = {
	cfg: null as null | {
		id: string;
		encryptedAccessToken: string | null;
		encryptedRefreshToken: string | null;
		encryptedOauthClientSecret: string | null;
		oauthClientId: string | null;
		tokenExpiresAt: Date | null;
		updatedAt: Date | null;
		mcpServer: {
			name?: string;
			defaultUrl?: string | null;
			oauthTokenEndpoint?: string | null;
		};
		baseUrl: string | null;
		dcrClientMetadata: Record<string, unknown> | null;
		scopes: string[] | null;
		needsReauth: boolean;
	},
};
let getMcpConfigCallCount = 0;
let recordRefreshFailureCalls: Array<{
	configId: string;
	errorMessage: string;
	permanent?: boolean;
	expectedRefreshToken?: string | null;
}> = [];
let clearRefreshFailuresCalls = 0;
let updateMcpConfigTokensCalls: Array<{
	encryptedRefreshToken: string | null;
}> = [];

vi.mock("@repo/database", () => ({
	getMcpConfigByIdInternal: vi.fn(async (_id: string) => {
		getMcpConfigCallCount++;
		return mockConfigState.cfg;
	}),
	getCachedOAuthMetadata: vi.fn(async () => ({
		tokenEndpoint: "https://example-idp/token",
	})),
	recordRefreshFailure: vi.fn(
		async (args: {
			configId: string;
			errorMessage: string;
			permanent?: boolean;
			expectedRefreshToken?: string | null;
		}) => {
			recordRefreshFailureCalls.push(args);
			return { needsReauth: false, failureCount: 1 };
		},
	),
	// Mirrors the real predicate in `@repo/database` (prisma/queries/mcp.ts),
	// whose own behaviour is pinned by that package's suite. Reproduced here
	// because this file mocks `@repo/database` wholesale.
	isPermanentGrantFailure: (errorCode: string | undefined | null) =>
		errorCode === "invalid_grant" || errorCode === "invalid_token",
	clearRefreshFailures: vi.fn(async () => {
		clearRefreshFailuresCalls++;
	}),
	updateMcpConfigTokens: vi.fn(
		async (args: { encryptedRefreshToken: string | null }) => {
			updateMcpConfigTokensCalls.push(args);
		},
	),
}));

// Mock @repo/utils — the provider decrypts tokens + calls refreshOAuthToken.
const mockRefreshOAuthToken = vi.fn();
let refreshOAuthTokenCallCount = 0;
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((encrypted: string) => encrypted.replace(/^ENC:/, "")),
	encryptApiKey: vi.fn((plain: string) => `ENC:${plain}`),
	hashApiKey: vi.fn((plain: string) => `HASH:${plain}`),
}));

vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: vi.fn(async (req: unknown) => {
		refreshOAuthTokenCallCount++;
		return mockRefreshOAuthToken(req);
	}),
}));

import { createOAuthClientProvider } from "../oauth-provider";

const baseConfig = {
	id: "config_x",
	encryptedAccessToken: "ENC:access-1",
	encryptedRefreshToken: "ENC:refresh-1",
	encryptedOauthClientSecret: "ENC:secret",
	oauthClientId: "client_id_x",
	tokenExpiresAt: new Date(Date.now() - 1000), // expired
	updatedAt: new Date(),
	mcpServer: {
		name: "Test Server",
		defaultUrl: "https://example-idp",
		oauthTokenEndpoint: "https://example-idp/token",
	},
	baseUrl: "https://example-idp",
	dcrClientMetadata: null,
	scopes: ["scope_a"],
	needsReauth: false,
	userId: "user_a",
	organizationId: "org_a",
};

function resetMocks() {
	mockConfigState.cfg = { ...baseConfig };
	getMcpConfigCallCount = 0;
	refreshOAuthTokenCallCount = 0;
	recordRefreshFailureCalls = [];
	clearRefreshFailuresCalls = 0;
	updateMcpConfigTokensCalls = [];
	mockRefreshOAuthToken.mockReset();
}

describe("OAuth provider refresh race serialization", () => {
	beforeEach(resetMocks);

	it("deduplicates concurrent refresh calls to a single token endpoint hit", async () => {
		mockRefreshOAuthToken.mockResolvedValue({
			ok: true,
			accessToken: "access-2",
			refreshToken: "refresh-2",
			expiresIn: 3600,
			tokenType: "Bearer",
			scope: null,
		});
		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		// Two concurrent tokens() calls — should dedup the refresh.
		const [r1, r2] = await Promise.all([
			provider.tokens(),
			provider.tokens(),
		]);
		expect(refreshOAuthTokenCallCount).toBe(1);
		expect(r1?.access_token).toBe("access-2");
		expect(r2?.access_token).toBe("access-2");
	});

	it("retries once with the freshly-rotated refresh token on invalid_grant", async () => {
		// Single mockImplementation handles both calls. First call returns
		// invalid_grant AND mutates the "DB" state so the reload sees a
		// rotated refresh token. Second call uses the rotated token and
		// succeeds.
		let callIndex = 0;
		mockRefreshOAuthToken.mockImplementation(
			async (req: { refreshToken: string }) => {
				callIndex++;
				if (callIndex === 1) {
					// Simulate parallel replica rotation: mutate state so the
					// reload happening AFTER this returns the new refresh token.
					if (mockConfigState.cfg) {
						mockConfigState.cfg.encryptedRefreshToken =
							"ENC:refresh-rotated";
					}
					return {
						ok: false,
						errorCode: "invalid_grant",
						errorMessage: "Invalid refresh token",
					};
				}
				// Retry should use the rotated refresh token.
				expect(req.refreshToken).toBe("refresh-rotated");
				return {
					ok: true,
					accessToken: "access-2",
					refreshToken: "refresh-4",
					expiresIn: 3600,
					tokenType: "Bearer",
					scope: null,
				};
			},
		);

		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		const tokens = await provider.tokens();
		expect(refreshOAuthTokenCallCount).toBe(2);
		expect(tokens?.access_token).toBe("access-2");
		// Refresh failure counter should NOT have been incremented since
		// the retry succeeded.
		expect(recordRefreshFailureCalls).toEqual([]);
	});

	it("persists the ROTATED refresh token when the retry response omits one", async () => {
		// Some providers return `refresh_token` only when it changes. On a
		// retried attempt the fallback must be the token we actually spent —
		// writing back the value loaded before the race would replace the
		// winner's live token with a spent one and break the next refresh.
		let callIndex = 0;
		mockRefreshOAuthToken.mockImplementation(async () => {
			callIndex++;
			if (callIndex === 1) {
				if (mockConfigState.cfg) {
					mockConfigState.cfg.encryptedRefreshToken =
						"ENC:refresh-rotated";
				}
				return {
					ok: false,
					errorCode: "invalid_grant",
					errorMessage: "Invalid refresh token",
				};
			}
			return {
				ok: true,
				accessToken: "access-2",
				refreshToken: undefined,
				expiresIn: 3600,
				tokenType: "Bearer",
				scope: null,
			};
		});

		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		await provider.tokens();

		expect(updateMcpConfigTokensCalls).toHaveLength(1);
		expect(updateMcpConfigTokensCalls[0].encryptedRefreshToken).toBe(
			"ENC:refresh-rotated",
		);
	});

	it("RETURNS the rotated refresh token when the retry response omits one", async () => {
		// The row and the returned `OAuthTokens` share one fallback, so they
		// have to fall back to the same token. Handing the caller the value
		// loaded before the race would give it a refresh token the retry
		// already proved dead, while the row correctly kept the live one —
		// so anything holding these tokens rather than re-reading the config
		// refreshes with a spent credential and gets `invalid_grant`.
		let callIndex = 0;
		mockRefreshOAuthToken.mockImplementation(async () => {
			callIndex++;
			if (callIndex === 1) {
				if (mockConfigState.cfg) {
					mockConfigState.cfg.encryptedRefreshToken =
						"ENC:refresh-rotated";
				}
				return {
					ok: false,
					errorCode: "invalid_grant",
					errorMessage: "Invalid refresh token",
				};
			}
			return {
				ok: true,
				accessToken: "access-2",
				refreshToken: undefined,
				expiresIn: 3600,
				tokenType: "Bearer",
				scope: null,
			};
		});

		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		const tokens = await provider.tokens();

		expect(tokens?.access_token).toBe("access-2");
		expect(tokens?.refresh_token).toBe("refresh-rotated");
		// Not the value this call first loaded and spent on the attempt that
		// was rejected.
		expect(tokens?.refresh_token).not.toBe("refresh-1");
	});

	it("does NOT retry when invalid_grant + refresh token has NOT been rotated", async () => {
		// True invalid_grant (token revoked, not a race). Reload returns
		// the same refresh token. No retry — record the failure.
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "invalid_grant",
			errorMessage: "Refresh token revoked",
		});
		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		const tokens = await provider.tokens();
		expect(refreshOAuthTokenCallCount).toBe(1); // only the initial attempt
		expect(tokens).toBeUndefined();
		expect(recordRefreshFailureCalls).toHaveLength(1);
		// The stored error message includes the IdP's human-readable
		// description (not the error code itself).
		expect(recordRefreshFailureCalls[0].errorMessage).toContain(
			"Refresh token revoked",
		);
		// The provider positively rejected the grant, so this failure is
		// allowed to count toward condemning the credential...
		expect(recordRefreshFailureCalls[0].permanent).toBe(true);
		// ...but only against the row version that carried the rejected
		// token. `recordRefreshFailure` turns this into a conditional write,
		// which is what makes the classification safe under a rotation that
		// lands after the reload above.
		expect(recordRefreshFailureCalls[0].expectedRefreshToken).toBe(
			"ENC:refresh-1",
		);
	});

	it("binds a post-retry rejection to the RETRIED token, not the one first loaded", async () => {
		// Three concurrent callers on a rotating provider: A spends T0→T1,
		// we reload and retry with T1, and B spends T1→T2 before our retry
		// lands. GitLab-style providers then answer `invalid_grant` about T1
		// while T2 is alive on the row. Nothing reloads after the retry, so
		// the classification stays `permanent` — the conditional write is
		// what stops it condemning, and it can only do that if the ciphertext
		// we hand it is the one the retry actually spent.
		let callIndex = 0;
		mockRefreshOAuthToken.mockImplementation(async () => {
			callIndex++;
			if (callIndex === 1 && mockConfigState.cfg) {
				// The first winner's rotation, visible to our reload.
				mockConfigState.cfg.encryptedRefreshToken =
					"ENC:refresh-rotated";
			}
			return {
				ok: false,
				errorCode: "invalid_grant",
				errorMessage: "Invalid refresh token",
			};
		});

		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		const tokens = await provider.tokens();

		expect(tokens).toBeUndefined();
		expect(refreshOAuthTokenCallCount).toBe(2);
		expect(recordRefreshFailureCalls).toHaveLength(1);
		expect(recordRefreshFailureCalls[0].permanent).toBe(true);
		expect(recordRefreshFailureCalls[0].expectedRefreshToken).toBe(
			"ENC:refresh-rotated",
		);
	});

	it("does NOT retry on non-invalid_grant errors (e.g. network)", async () => {
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "network_error",
			errorMessage: "Connection refused",
		});
		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		await provider.tokens();
		expect(refreshOAuthTokenCallCount).toBe(1);
		// Recorded for triage, but classified transient — a network error is
		// no evidence that the stored grant is dead. See the classification
		// suite below.
		expect(recordRefreshFailureCalls).toHaveLength(1);
		expect(recordRefreshFailureCalls[0].permanent).toBe(false);
	});
});

/**
 * `needsReauth` is enforced — a config carrying it is refused at client
 * creation, filtered out of tool discovery, and blocked from refreshing,
 * with a fresh user grant as its only exit. So a refresh failure may only
 * count toward it when the provider rejected the GRANT itself. A network
 * outage, an IdP 5xx or a local configuration gap is recorded for triage
 * but classified transient: condemning those would send the user into a
 * reconnect that cannot fix the problem while hard-blocking a healthy
 * credential.
 */
describe("OAuth provider refresh — failure classification", () => {
	beforeEach(resetMocks);

	async function refreshWith(result: {
		errorCode: string;
		errorMessage: string;
	}) {
		mockRefreshOAuthToken.mockResolvedValue({ ok: false, ...result });
		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		await provider.tokens();
	}

	it("classifies invalid_token as permanent, like invalid_grant", async () => {
		await refreshWith({
			errorCode: "invalid_token",
			errorMessage: "Token is not valid",
		});

		expect(recordRefreshFailureCalls).toHaveLength(1);
		expect(recordRefreshFailureCalls[0].permanent).toBe(true);
	});

	it("records a network error without letting it condemn the credential", async () => {
		await refreshWith({
			errorCode: "network_error",
			errorMessage: "Connection refused",
		});

		// The failure is still recorded — the diagnostics are what make a
		// recurring outage debuggable...
		expect(recordRefreshFailureCalls).toHaveLength(1);
		expect(recordRefreshFailureCalls[0].errorMessage).toContain(
			"Connection refused",
		);
		// ...but it must never trip the breaker.
		expect(recordRefreshFailureCalls[0].permanent).toBe(false);
	});

	it("never condemns on a repeated IdP 5xx", async () => {
		for (let attempt = 0; attempt < 5; attempt++) {
			await refreshWith({
				errorCode: "http_503",
				errorMessage: "upstream returned 503",
			});
		}

		expect(recordRefreshFailureCalls).toHaveLength(5);
		expect(
			recordRefreshFailureCalls.every((call) => call.permanent === false),
		).toBe(true);
	});

	it("never condemns on an unparseable token response", async () => {
		await refreshWith({
			errorCode: "invalid_response",
			errorMessage: "Token response missing access_token",
		});

		expect(recordRefreshFailureCalls[0].permanent).toBe(false);
	});

	it("never condemns on a deterministic preflight failure", async () => {
		// A missing client secret is a local configuration gap: the token
		// endpoint is never contacted, so nothing here is evidence about the
		// user's grant.
		if (mockConfigState.cfg) {
			mockConfigState.cfg.encryptedOauthClientSecret = null;
		}
		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		await provider.tokens();

		expect(refreshOAuthTokenCallCount).toBe(0);
		expect(recordRefreshFailureCalls).toHaveLength(1);
		expect(recordRefreshFailureCalls[0].errorMessage).toBe(
			"OAuth client secret not configured",
		);
		expect(recordRefreshFailureCalls[0].permanent).toBe(false);
	});
});

describe("OAuth provider refresh — needsReauth circuit breaker", () => {
	beforeEach(resetMocks);

	it("refuses to refresh a hard-expired token once the reloaded config has needsReauth: true, without recording a further failure", async () => {
		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		// Flip the breaker AFTER the provider is created — models the actual
		// reported failure mode (an MCP client cached before the breaker
		// tripped) and proves `tokens()` re-reads `needsReauth` from the DB
		// on each call rather than capturing it at construction.
		if (mockConfigState.cfg) {
			mockConfigState.cfg.needsReauth = true;
		}
		const tokens = await provider.tokens();
		expect(tokens).toBeUndefined();
		expect(refreshOAuthTokenCallCount).toBe(0);
		expect(recordRefreshFailureCalls).toEqual([]);
	});

	it("returns the current access token without refreshing when needsReauth is true but the token is only in the soft proactive-refresh window", async () => {
		// mcp.notion.com is the one server with a known default token expiry
		// (`SERVER_DEFAULT_TOKEN_EXPIRY`, 3600s). `updatedAt` 83% of that
		// lifetime ago lands inside the 75%-100% soft window, short of the
		// 100% hard-expiry cutoff. `tokenExpiresAt: null` matters — the
		// default fixture's `tokenExpiresAt` is already in the past, which
		// would otherwise force the hard-expired branch instead.
		if (mockConfigState.cfg) {
			mockConfigState.cfg.baseUrl = "https://mcp.notion.com";
			// Reassign rather than mutate — `resetMocks` only shallow-copies
			// `baseConfig`, so `cfg.mcpServer` is the SAME object reference
			// shared by every test; mutating it in place would leak into
			// tests that run afterward.
			mockConfigState.cfg.mcpServer = {
				...mockConfigState.cfg.mcpServer,
				defaultUrl: "https://mcp.notion.com",
			};
			mockConfigState.cfg.tokenExpiresAt = null;
			mockConfigState.cfg.updatedAt = new Date(
				Date.now() - 3600 * 1000 * 0.83,
			);
		}
		const provider = await createOAuthClientProvider({
			configId: "config_x",
			userId: "user_a",
			organizationId: "org_a",
			redirectUri: "https://app.example.com/callback",
		});
		// Flip the breaker AFTER provider creation, same as the hard-expired
		// case above.
		if (mockConfigState.cfg) {
			mockConfigState.cfg.needsReauth = true;
		}
		const tokens = await provider.tokens();
		expect(tokens?.access_token).toBe("access-1");
		expect(refreshOAuthTokenCallCount).toBe(0);
		expect(recordRefreshFailureCalls).toEqual([]);
	});
});
