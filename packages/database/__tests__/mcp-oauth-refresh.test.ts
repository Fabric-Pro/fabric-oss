/**
 * The one refresh path for an MCP config's own OAuth grant
 * (`refreshMcpOAuthAccessToken`): it sends a refresh token and client
 * credentials only to the token endpoint the config is bound to, never to
 * anything discovered from the MCP server, and a refresh that loses a race to
 * a revoke, re-registration or reconnect writes nothing.
 *
 * The row is simulated, so the conditional writes are evaluated the way
 * Postgres would evaluate their WHERE, not stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let storedRow: Record<string, unknown> | null;

function matches(where: Record<string, unknown>): boolean {
	if (!storedRow) {
		return false;
	}
	return Object.entries(where).every(
		([column, value]) => storedRow?.[column] === value,
	);
}

function apply(data: Record<string, unknown>) {
	if (!storedRow) {
		return;
	}
	for (const [column, value] of Object.entries(data)) {
		if (
			value &&
			typeof value === "object" &&
			"increment" in (value as Record<string, unknown>)
		) {
			storedRow[column] =
				(storedRow[column] as number) +
				((value as { increment: number }).increment ?? 0);
		} else {
			storedRow[column] = value;
		}
	}
}

const findUniqueMock = vi.fn(async () => (storedRow ? { ...storedRow } : null));
const updateManyMock = vi.fn(
	async (args: {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
	}) => {
		if (!matches(args.where)) {
			return { count: 0 };
		}
		apply(args.data);
		return { count: 1 };
	},
);

vi.mock("../prisma/client", () => ({
	Prisma: { DbNull: "DbNull" },
	db: {
		mCPConfig: {
			findUnique: (...args: unknown[]) => findUniqueMock(...(args as [])),
			// The fenced, generation-incrementing writes (registration
			// replacement, import): conditional like their WHERE.
			update: vi.fn(
				async (args: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					if (!matches(args.where)) {
						throw Object.assign(new Error("P2025"), {
							code: "P2025",
						});
					}
					apply(args.data);
					return storedRow ? { ...storedRow } : null;
				},
			),
			updateMany: (...args: unknown[]) =>
				updateManyMock(
					...(args as [
						{
							where: Record<string, unknown>;
							data: Record<string, unknown>;
						},
					]),
				),
		},
	},
}));

const refreshOAuthTokenMock = vi.fn();
vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: (...args: unknown[]) => refreshOAuthTokenMock(...args),
}));

// Nothing in the refresh path may discover anything.
const safeFetchOutboundMock = vi.fn();
vi.mock("@repo/utils/url-security", () => ({
	safeFetchOutbound: (...args: unknown[]) => safeFetchOutboundMock(...args),
}));

let ciphertextVersion = 0;
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace(/^ENC:(?:\d+:)?/, ""),
	encryptApiKey: (value: string) => `ENC:${++ciphertextVersion}:${value}`,
	hashApiKey: (value: string) => `HASH:${value}`,
}));

import {
	buildMcpOAuthBinding,
	credentialFingerprint,
	withCredentialFingerprint,
} from "../prisma/queries/lib/mcp-oauth-binding";
import { refreshMcpOAuthAccessToken } from "../prisma/queries/mcp-oauth-refresh";

/** The credential columns of `baseRow()`. */
const STORED_CREDENTIALS = {
	oauthClientId: "client-a",
	encryptedOauthClientSecret: "ENC:secret-a",
	encryptedRefreshToken: "ENC:refresh-1",
};

const UNFINGERPRINTED = buildMcpOAuthBinding({
	authorizationServerUrl: "https://as-a.example.com",
	tokenEndpoint: "https://as-a.example.com/oauth/token",
	source: "discovery",
});

// Bound with the fingerprint of the credential set `baseRow()` stores.
const PINNED = withCredentialFingerprint(UNFINGERPRINTED, STORED_CREDENTIALS);

function baseRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_r",
		userId: "user-1",
		organizationId: null,
		authType: "OAUTH2",
		status: "HEALTHY",
		baseUrl: "https://mcp.example.com/mcp",
		// Everything that could name another place to send the token says
		// "as-b": the catalog row, the stale cache. Only the binding counts.
		mcpServer: {
			defaultUrl: "https://mcp.example.com/mcp",
			oauthTokenEndpoint: "https://as-b.example.com/token",
			oauthDiscoveryUrl: "https://as-b.example.com/.well-known/x",
		},
		oauthMetadataCache: {
			token_endpoint: "https://as-b.example.com/token",
		},
		oauthBinding: PINNED,
		oauthGrantGeneration: 5,
		oauthClientId: "client-a",
		encryptedOauthClientSecret: "ENC:secret-a",
		dcrClientMetadata: {
			token_endpoint_auth_method: "client_secret_basic",
		},
		encryptedAccessToken: "ENC:old-access",
		accessTokenHash: "HASH:old-access",
		encryptedRefreshToken: "ENC:refresh-1",
		tokenExpiresAt: new Date(Date.now() - 60_000),
		updatedAt: new Date(Date.now() - 7_200_000),
		needsReauth: false,
		refreshFailureCount: 0,
		lastRefreshError: null,
		...overrides,
	};
}

beforeEach(() => {
	storedRow = baseRow();
	findUniqueMock.mockClear();
	updateManyMock.mockClear();
	refreshOAuthTokenMock.mockReset();
	safeFetchOutboundMock.mockReset();
	refreshOAuthTokenMock.mockResolvedValue({
		ok: true,
		accessToken: "new-access",
		refreshToken: "refresh-2",
		expiresIn: 3600,
		tokenType: "Bearer",
		scope: null,
	});
});

describe("refreshMcpOAuthAccessToken — where the refresh token goes", () => {
	it("posts only to the bound token endpoint, with the registered client authentication", async () => {
		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome.status).toBe("refreshed");
		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1);
		expect(refreshOAuthTokenMock).toHaveBeenCalledWith(
			expect.objectContaining({
				tokenEndpoint: "https://as-a.example.com/oauth/token",
				refreshToken: "refresh-1",
				clientId: "client-a",
				clientSecret: "secret-a",
				clientAuthMethod: "client_secret_basic",
			}),
		);
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(storedRow).toMatchObject({
			encryptedRefreshToken: expect.stringContaining("refresh-2"),
			encryptedAccessToken: expect.stringContaining("new-access"),
			oauthGrantGeneration: 5,
		});
	});

	it("never contacts anything for an unbound config, and flags it for reconnect without a strike", async () => {
		storedRow = baseRow({ oauthBinding: null });

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome).toEqual({ status: "reconnect-required" });
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(storedRow).toMatchObject({
			needsReauth: true,
			refreshFailureCount: 0,
		});
	});

	it("does not flag a soft-window caller's unbound config", async () => {
		storedRow = baseRow({ oauthBinding: null });

		const outcome = await refreshMcpOAuthAccessToken("cfg_r", {
			recordFailures: false,
		});

		expect(outcome).toEqual({ status: "reconnect-required" });
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		expect(updateManyMock).not.toHaveBeenCalled();
	});

	it("never refreshes a bearer-only import: no request, reconnect at expiry", async () => {
		storedRow = baseRow({
			oauthBinding: {
				mode: "bearer-only",
				importedAt: "2026-10-06T00:00:00.000Z",
			},
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome).toEqual({ status: "reconnect-required" });
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
		expect(storedRow?.needsReauth).toBe(true);
	});

	it("treats a malformed binding as unbound", async () => {
		storedRow = baseRow({
			oauthBinding: { tokenEndpoint: "https://as-b.example.com/token" },
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome).toEqual({ status: "reconnect-required" });
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
	});
});

describe("refreshMcpOAuthAccessToken — generation fencing", () => {
	it("does not restore old tokens when the config was revoked while the refresh was in flight", async () => {
		refreshOAuthTokenMock.mockImplementation(async () => {
			// revokeOAuthTokens lands mid-flight.
			Object.assign(storedRow ?? {}, {
				encryptedAccessToken: null,
				accessTokenHash: null,
				encryptedRefreshToken: null,
				tokenExpiresAt: null,
				oauthGrantGeneration: 6,
			});
			return {
				ok: true,
				accessToken: "late-access",
				refreshToken: "late-refresh",
				expiresIn: 3600,
				tokenType: "Bearer",
				scope: null,
			};
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome).toEqual({ status: "superseded" });
		expect(storedRow).toMatchObject({
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			oauthGrantGeneration: 6,
		});
	});

	it("does not overwrite a reconnect that landed while the refresh was in flight", async () => {
		refreshOAuthTokenMock.mockImplementation(async () => {
			// A new grant (callback) lands mid-flight: new tokens, new
			// generation. Same refresh-token ciphertext would not even matter.
			Object.assign(storedRow ?? {}, {
				encryptedAccessToken: "ENC:reconnect-access",
				encryptedRefreshToken: "ENC:refresh-1",
				oauthGrantGeneration: 6,
			});
			return {
				ok: true,
				accessToken: "late-access",
				refreshToken: "late-refresh",
				expiresIn: 3600,
				tokenType: "Bearer",
				scope: null,
			};
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome).toEqual({ status: "superseded" });
		expect(storedRow?.encryptedAccessToken).toBe("ENC:reconnect-access");
	});

	it("records no strike for a failure of a grant the config no longer holds", async () => {
		refreshOAuthTokenMock.mockImplementation(async () => {
			Object.assign(storedRow ?? {}, { oauthGrantGeneration: 6 });
			return {
				ok: false,
				errorCode: "http_503",
				errorMessage: "upstream returned 503",
			};
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome.status).toBe("failed");
		expect(storedRow?.refreshFailureCount).toBe(0);
		expect(storedRow?.lastRefreshError).toBeNull();
	});

	it("does nothing for a caller pinned to an older generation", async () => {
		const outcome = await refreshMcpOAuthAccessToken("cfg_r", {
			expectedGeneration: 4,
		});

		expect(outcome).toEqual({ status: "superseded" });
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
	});

	it("stops the rotation-race retry when the reload shows a different binding", async () => {
		refreshOAuthTokenMock.mockImplementation(async () => {
			Object.assign(storedRow ?? {}, {
				encryptedRefreshToken: "ENC:rotated",
				oauthBinding: buildMcpOAuthBinding({
					authorizationServerUrl: "https://as-b.example.com",
					tokenEndpoint: "https://as-b.example.com/token",
					source: "discovery",
				}),
			});
			return {
				ok: false,
				errorCode: "invalid_grant",
				errorMessage: "Refresh token revoked",
			};
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome).toEqual({ status: "superseded" });
		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1);
		expect(storedRow?.refreshFailureCount).toBe(0);
	});

	it("retries a rotation race once, with the snapshot's endpoint and client", async () => {
		let calls = 0;
		refreshOAuthTokenMock.mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				Object.assign(storedRow ?? {}, {
					encryptedRefreshToken: "ENC:rotated",
					// The winning refresh re-fingerprints the binding.
					oauthBinding: withCredentialFingerprint(PINNED, {
						...STORED_CREDENTIALS,
						encryptedRefreshToken: "ENC:rotated",
					}),
				});
				return {
					ok: false,
					errorCode: "invalid_grant",
					errorMessage: "Refresh token revoked",
				};
			}
			return {
				ok: true,
				accessToken: "retry-access",
				refreshToken: null,
				expiresIn: null,
				tokenType: null,
				scope: null,
			};
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome.status).toBe("refreshed");
		expect(refreshOAuthTokenMock.mock.calls[1]?.[0]).toMatchObject({
			tokenEndpoint: "https://as-a.example.com/oauth/token",
			refreshToken: "rotated",
			clientId: "client-a",
		});
		// Not rotated by the provider: the row keeps the token it spent, and so
		// does what the caller is handed — not the token the retry proved dead.
		expect(storedRow?.encryptedRefreshToken).toBe("ENC:rotated");
		expect(outcome.status === "refreshed" && outcome.refreshToken).toBe(
			"rotated",
		);
		expect(storedRow?.encryptedAccessToken).toContain("retry-access");
	});
});

describe("refreshMcpOAuthAccessToken — the stored credentials must be the set their binding was written with", () => {
	// A writer outside the credential module (the previous app version
	// during a rolling deploy) replaces one column by id, without touching
	// the binding or the generation.
	it.each([
		["the client id alone", { oauthClientId: "client-from-another-as" }],
		[
			"the client secret alone (same id)",
			{ encryptedOauthClientSecret: "ENC:secret-from-another-as" },
		],
		[
			"the refresh token alone",
			{ encryptedRefreshToken: "ENC:refresh-from-another-as" },
		],
	])(
		"sends nothing after a legacy write of %s, and flags the config for reconnect",
		async (_label, legacyWrite) => {
			Object.assign(storedRow ?? {}, legacyWrite);

			const outcome = await refreshMcpOAuthAccessToken("cfg_r");

			expect(outcome).toEqual({ status: "reconnect-required" });
			expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
			expect(safeFetchOutboundMock).not.toHaveBeenCalled();
			expect(storedRow?.needsReauth).toBe(true);
			expect(storedRow?.refreshFailureCount).toBe(0);
		},
	);

	it("marks reconnect even for a soft-window caller", async () => {
		Object.assign(storedRow ?? {}, {
			encryptedRefreshToken: "ENC:refresh-from-another-as",
		});

		await refreshMcpOAuthAccessToken("cfg_r", { recordFailures: false });

		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		expect(storedRow?.needsReauth).toBe(true);
	});

	it.each([
		["written by this code", UNFINGERPRINTED],
		["from the backfill", { ...UNFINGERPRINTED, source: "backfill" }],
	])(
		"refuses a binding %s without a fingerprint: no exception",
		async (_label, binding) => {
			storedRow = baseRow({ oauthBinding: binding });

			const outcome = await refreshMcpOAuthAccessToken("cfg_r");

			expect(outcome).toEqual({ status: "reconnect-required" });
			expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		},
	);

	it("re-fingerprints the binding for the rotated refresh token in the same write", async () => {
		await refreshMcpOAuthAccessToken("cfg_r");

		const rotated = storedRow?.encryptedRefreshToken as string;
		expect(rotated).toContain("refresh-2");
		expect(storedRow?.oauthBinding).toEqual({
			...PINNED,
			credentialFingerprint: credentialFingerprint({
				...STORED_CREDENTIALS,
				encryptedRefreshToken: rotated,
			}),
		});
		// …so the next refresh, with the rotated token, is accepted.
		Object.assign(storedRow ?? {}, {
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		await expect(
			refreshMcpOAuthAccessToken("cfg_r"),
		).resolves.toMatchObject({ status: "refreshed" });
		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(2);
	});

	it("refreshes a backfilled binding carrying the migration's fingerprint, then catches a later legacy write", async () => {
		// What 20261006200100_mcp_oauth_binding_backfill writes with each
		// binding (the SQL and TypeScript encodings are checked equal in
		// migrations/mcp-oauth-binding-backfill.test.ts).
		storedRow = baseRow({
			oauthBinding: {
				...UNFINGERPRINTED,
				source: "backfill",
				credentialFingerprint:
					credentialFingerprint(STORED_CREDENTIALS),
			},
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome.status).toBe("refreshed");
		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1);

		// The previous app version then writes a client secret by id.
		Object.assign(storedRow ?? {}, {
			encryptedOauthClientSecret: "ENC:secret-from-another-as",
			tokenExpiresAt: new Date(Date.now() - 60_000),
		});
		refreshOAuthTokenMock.mockClear();
		await expect(refreshMcpOAuthAccessToken("cfg_r")).resolves.toEqual({
			status: "reconnect-required",
		});
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
	});

	it("does not retry a rotation race with a client a legacy writer replaced meanwhile", async () => {
		refreshOAuthTokenMock.mockImplementation(async () => {
			// Another refresh rotated (fingerprinting its write), then a
			// legacy writer replaced the secret.
			Object.assign(storedRow ?? {}, {
				encryptedRefreshToken: "ENC:rotated",
				oauthBinding: withCredentialFingerprint(PINNED, {
					...STORED_CREDENTIALS,
					encryptedRefreshToken: "ENC:rotated",
				}),
				encryptedOauthClientSecret: "ENC:secret-from-another-as",
			});
			return {
				ok: false,
				errorCode: "invalid_grant",
				errorMessage: "Refresh token revoked",
			};
		});

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome.status).not.toBe("refreshed");
		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1);
	});
});

describe("a client change and a token import saved together", () => {
	it("stores bearer-only tokens that are never sent to the client's custom endpoint", async () => {
		const { replaceMcpOAuthRegistration, bearerOnlyOAuthMarker } =
			await import("../prisma/queries/mcp-oauth-credentials");
		storedRow = baseRow({
			oauthBinding: null,
			oauthGrantGeneration: 5,
		});

		// What `configs.upsert` writes for a custom server when one save
		// enters a client AND imports tokens: the import rule wins.
		await replaceMcpOAuthRegistration({
			configId: "cfg_r",
			expectedGeneration: 5,
			client: {
				oauthClientId: "manual-client",
				encryptedOauthClientSecret: "ENC:manual-secret",
				dcrClientMetadata: null,
				dcrRegistrationEndpoint: null,
				dcrRegisteredAt: null,
			},
			binding: bearerOnlyOAuthMarker(),
			tokens: {
				encryptedAccessToken: "ENC:imported-access",
				accessTokenHash: "HASH:imported-access",
				encryptedRefreshToken: "ENC:imported-refresh",
				tokenExpiresAt: new Date(Date.now() - 60_000),
			},
		});
		expect(storedRow?.oauthBinding).toMatchObject({ mode: "bearer-only" });

		const outcome = await refreshMcpOAuthAccessToken("cfg_r");

		expect(outcome).toEqual({ status: "reconnect-required" });
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		expect(safeFetchOutboundMock).not.toHaveBeenCalled();
	});
});

describe("refreshMcpOAuthAccessToken — in-process deduplication", () => {
	it("shares one token request between concurrent callers", async () => {
		let release: () => void = () => {};
		refreshOAuthTokenMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve({
							ok: true,
							accessToken: "new-access",
							refreshToken: "refresh-2",
							expiresIn: 3600,
							tokenType: "Bearer",
							scope: null,
						});
				}),
		);

		const first = refreshMcpOAuthAccessToken("cfg_r");
		const second = refreshMcpOAuthAccessToken("cfg_r");
		await vi.waitFor(() =>
			expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1),
		);
		release();

		const [a, b] = await Promise.all([first, second]);
		expect(a.status).toBe("refreshed");
		expect(b).toBe(a);
		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1);
	});
});
