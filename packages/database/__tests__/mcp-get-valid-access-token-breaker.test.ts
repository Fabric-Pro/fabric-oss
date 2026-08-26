/**
 * Pins the circuit-breaker enforcement in `getValidAccessToken`. This
 * function is reachable from several callers that bypass
 * `createMcpClientForConfig` (the test-connection route, mcp-app proxy
 * routes, the v1 API, and Temporal MCP activities). Before this fix none of
 * them consulted `needsReauth`, so a config already tripped by
 * `recordRefreshFailure` kept re-attempting its dead refresh token on every
 * call — re-hammering the provider and recording a further failure each
 * time.
 *
 * A separate, lighter-weight mock than `mcp-status-reset.test.ts` — that
 * file only stubs `db.mCPConfig.update` for `updateMcpConfigTokens` /
 * `clearRefreshFailures`. Exercising `getValidAccessToken` additionally
 * needs `db.mCPConfig.findUnique` (via `getMcpConfigByIdInternal`) and a
 * stub for the OAuth token-endpoint call so a regression that removes the
 * breaker check is caught by an unexpected call, not just a wrong return
 * value.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
// Every write `recordRefreshFailure` makes is conditional — the condemning
// ones additionally gated on the row still holding the refresh token that was
// rejected, all of them on the row still being uncondemned — so they land here
// rather than on `update`. `count` is how many rows matched; zero is a lost
// race, not an error. `update` stays stubbed for the token/status writers in
// this module, and so a regression back to an unconditional write shows up as
// a called mock rather than a TypeError.
const updateManyMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		mCPConfig: {
			findUnique: (...args: unknown[]) => findUniqueMock(...args),
			update: (...args: unknown[]) => updateMock(...args),
			updateMany: (...args: unknown[]) => updateManyMock(...args),
		},
	},
}));

const refreshOAuthTokenMock = vi.fn();
vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: (...args: unknown[]) => refreshOAuthTokenMock(...args),
}));

// The refresh path always attempts RFC 8414 discovery before falling back to
// the server's configured token endpoint. Stub it so the tests below never
// reach the network — discovery returning a non-ok response makes the fixtures
// resolve their endpoint from `mcpServer.oauthTokenEndpoint`.
const safeFetchOutboundMock = vi.fn();
vi.mock("@repo/utils/url-security", () => ({
	safeFetchOutbound: (...args: unknown[]) => safeFetchOutboundMock(...args),
}));

// The soft-window case below falls through to a real decrypt call
// (`getValidAccessToken` returns the still-valid current access token
// rather than short-circuiting to `null`), so stub the codec instead of
// requiring real encryption key material in this test.
//
// `encryptApiKey`/`hashApiKey` are only reached on the success path, but the
// refresh helper destructures all three from this module before contacting the
// provider — and a mocked module throws on an export it doesn't define.
//
// Real encryption is non-deterministic: a fresh IV per call means the same
// plaintext encrypts to a different ciphertext every time. The two comparisons
// of the refresh token depend on that in opposite directions (see the
// re-encryption suite below), so the double reproduces it with a monotonic
// version prefix that `decryptApiKey` discards. Fixtures written as plain
// `ENC:<value>` decrypt exactly as before.
let ciphertextVersion = 0;
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace(/^ENC:(?:\d+:)?/, ""),
	encryptApiKey: (value: string) => `ENC:${++ciphertextVersion}:${value}`,
	hashApiKey: (value: string) => `HASH:${value}`,
}));

import { encryptApiKey } from "@repo/utils";
import {
	getValidAccessToken,
	isPermanentGrantFailure,
	recordRefreshFailure,
} from "../prisma/queries/mcp";

describe("getValidAccessToken — needsReauth circuit breaker", () => {
	beforeEach(() => {
		findUniqueMock.mockReset();
		updateMock.mockReset();
		updateManyMock.mockReset();
		updateManyMock.mockResolvedValue({ count: 1 });
		refreshOAuthTokenMock.mockReset();
		safeFetchOutboundMock.mockReset();
		safeFetchOutboundMock.mockResolvedValue({ ok: false });
	});

	it("returns null without attempting a refresh when needsReauth is true and the token is hard-expired", async () => {
		findUniqueMock.mockResolvedValue({
			id: "cfg_1",
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
			encryptedAccessToken: "ENC:stale-access",
			encryptedRefreshToken: "ENC:dead-refresh",
			tokenExpiresAt: new Date(Date.now() - 60_000), // hard-expired
			updatedAt: new Date(Date.now() - 3_600_000),
			needsReauth: true,
			mcpServer: null,
			baseUrl: null,
		});

		const result = await getValidAccessToken({
			configId: "cfg_1",
			userId: "user-1",
		});

		expect(result).toBeNull();
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		// `recordRefreshFailure`'s only observable side effects are
		// `db.mCPConfig.update` and the conditional `updateMany` — asserting
		// neither was reached proves the breaker short-circuited before a
		// further failure could be recorded against the already-tripped
		// config.
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).not.toHaveBeenCalled();
	});

	it("returns the current access token without refreshing when needsReauth is true but the token is only in the soft proactive-refresh window", async () => {
		// mcp.notion.com is the one server with a known default token expiry
		// (`SERVER_DEFAULT_TOKEN_EXPIRY` in prisma/queries/mcp.ts, 3600s).
		// `updatedAt` 3000s ago is 83% of that lifetime — inside the 75%-100%
		// soft window, short of the 100% hard-expiry cutoff.
		const knownExpirySeconds = 3600;
		const tokenAgeMs = knownExpirySeconds * 1000 * 0.83;

		findUniqueMock.mockResolvedValue({
			id: "cfg_2",
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
			encryptedAccessToken: "ENC:current-access",
			encryptedRefreshToken: "ENC:refresh-token",
			tokenExpiresAt: null,
			updatedAt: new Date(Date.now() - tokenAgeMs),
			needsReauth: true,
			mcpServer: { defaultUrl: "https://mcp.notion.com" },
			baseUrl: null,
		});

		const result = await getValidAccessToken({
			configId: "cfg_2",
			userId: "user-1",
		});

		expect(result).toBe("current-access");
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).not.toHaveBeenCalled();
	});
});

/**
 * The other half of the contract: enforcement is only safe if the breaker
 * trips for genuinely dead credentials and nothing else. Two independent
 * axes gate it.
 *
 * 1. A proactive refresh in the 75%-100% soft window is non-fatal — the
 *    caller falls through to the still-valid access token — so a failure
 *    there is not recorded at all.
 * 2. Even for a hard-expired token, only a provider rejection of the GRANT
 *    (`invalid_grant` / `invalid_token`) may condemn. A 5xx, a network blip
 *    or a local configuration gap is recorded for triage but never flips
 *    `needsReauth`: the flag's only exit is a user reconnect, which cannot
 *    fix any of those, so condemning would turn a transient outage into a
 *    permanent hard block on a healthy credential.
 */
describe("getValidAccessToken — what does and does not spend breaker strikes", () => {
	// mcp.notion.com is the one server with a known default token expiry
	// (`SERVER_DEFAULT_TOKEN_EXPIRY`, 3600s), which is what creates a soft
	// window at all. `oauthTokenEndpoint` short-circuits endpoint resolution
	// once the stubbed discovery above returns nothing.
	const knownExpirySeconds = 3600;
	const notionServer = {
		defaultUrl: "https://mcp.notion.com",
		oauthTokenEndpoint: "https://mcp.notion.com/token",
		oauthDiscoveryUrl: null,
	};

	beforeEach(() => {
		findUniqueMock.mockReset();
		updateMock.mockReset();
		updateManyMock.mockReset();
		updateManyMock.mockResolvedValue({ count: 1 });
		refreshOAuthTokenMock.mockReset();
		safeFetchOutboundMock.mockReset();
		safeFetchOutboundMock.mockResolvedValue({ ok: false });
		// A transient upstream failure — the case that must not be counted
		// when the current token is still usable.
		refreshOAuthTokenMock.mockResolvedValue({
			ok: false,
			errorCode: "http_503",
			errorMessage: "upstream returned 503",
		});
	});

	it("does not record a refresh failure when a proactive soft-window refresh fails", async () => {
		findUniqueMock.mockResolvedValue({
			id: "cfg_3",
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
			status: "HEALTHY",
			encryptedAccessToken: "ENC:current-access",
			encryptedRefreshToken: "ENC:refresh-token",
			oauthClientId: "client-id",
			encryptedOauthClientSecret: "ENC:client-secret",
			tokenExpiresAt: null,
			// 83% of the known lifetime: inside the soft window, short of the
			// 100% hard-expiry cutoff.
			updatedAt: new Date(Date.now() - knownExpirySeconds * 1000 * 0.83),
			needsReauth: false,
			refreshFailureCount: 0,
			mcpServer: notionServer,
			baseUrl: null,
		});

		const result = await getValidAccessToken({
			configId: "cfg_3",
			userId: "user-1",
		});

		// The refresh was genuinely attempted and genuinely failed...
		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1);
		// ...but the caller still gets the valid current token...
		expect(result).toBe("current-access");
		// ...and no strike was spent. `db.mCPConfig.update` / `updateMany`
		// are `recordRefreshFailure`'s only observable side effects.
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).not.toHaveBeenCalled();
	});

	it("records the diagnostics of a hard-expired transient failure without condemning the credential", async () => {
		findUniqueMock.mockResolvedValue({
			id: "cfg_4",
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
			status: "HEALTHY",
			encryptedAccessToken: "ENC:stale-access",
			encryptedRefreshToken: "ENC:refresh-token",
			oauthClientId: "client-id",
			encryptedOauthClientSecret: "ENC:client-secret",
			tokenExpiresAt: new Date(Date.now() - 60_000), // hard-expired
			updatedAt: new Date(Date.now() - knownExpirySeconds * 1000 * 2),
			needsReauth: false,
			// One strike short of the threshold: proves the 503 is written to
			// the diagnostics columns without being allowed to condemn.
			refreshFailureCount: 2,
			mcpServer: notionServer,
			baseUrl: null,
		});

		const result = await getValidAccessToken({
			configId: "cfg_4",
			userId: "user-1",
		});

		expect(refreshOAuthTokenMock).toHaveBeenCalledTimes(1);
		expect(result).toBeNull();
		// Diagnostics ride a conditional write gated on the row still being
		// uncondemned, so they land on `updateMany`, not `update`.
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledTimes(1);
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg_4", needsReauth: false },
				data: expect.objectContaining({
					refreshFailureCount: 3,
					lastRefreshError:
						"Token refresh failed: upstream returned 503",
				}),
			}),
		);
		// An IdP 5xx says nothing about the stored grant, and a reconnect
		// cannot fix it — so it never trips the breaker, however many times it
		// repeats. It must not write `false` either: that would restore a
		// credential a concurrent, better-evidenced failure had condemned.
		const transientData = updateManyMock.mock.calls[0]![0].data;
		expect(transientData).not.toHaveProperty("needsReauth");
		expect(transientData).not.toHaveProperty("status");
	});

	it("condemns a hard-expired refresh once the provider rejects the grant itself", async () => {
		// `invalid_grant` is the exact code the production logs carried in
		// issue #2795 — the case the breaker exists for.
		refreshOAuthTokenMock.mockResolvedValue({
			ok: false,
			errorCode: "invalid_grant",
			errorMessage: "Refresh token revoked",
		});
		findUniqueMock.mockResolvedValue({
			id: "cfg_5",
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
			status: "HEALTHY",
			encryptedAccessToken: "ENC:stale-access",
			encryptedRefreshToken: "ENC:refresh-token",
			oauthClientId: "client-id",
			encryptedOauthClientSecret: "ENC:client-secret",
			tokenExpiresAt: new Date(Date.now() - 60_000), // hard-expired
			updatedAt: new Date(Date.now() - knownExpirySeconds * 1000 * 2),
			needsReauth: false,
			refreshFailureCount: 2, // third strike
			mcpServer: notionServer,
			baseUrl: null,
		});

		const result = await getValidAccessToken({
			configId: "cfg_5",
			userId: "user-1",
		});

		expect(result).toBeNull();
		// Conditional on the row still holding the refresh token that was
		// rejected — and on it not having been condemned under us — so the
		// write goes through `updateMany`.
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "cfg_5",
					encryptedRefreshToken: "ENC:refresh-token",
					needsReauth: false,
				},
				data: expect.objectContaining({
					refreshFailureCount: 3,
					needsReauth: true,
					status: "UNAVAILABLE",
				}),
			}),
		);
	});

	it("never condemns on a deterministic preflight failure, however many strikes have accumulated", async () => {
		// A missing client secret is a local configuration gap: the provider
		// was never contacted, so nothing here is evidence about the grant.
		findUniqueMock.mockResolvedValue({
			id: "cfg_6",
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
			status: "HEALTHY",
			encryptedAccessToken: "ENC:stale-access",
			encryptedRefreshToken: "ENC:refresh-token",
			oauthClientId: "client-id",
			encryptedOauthClientSecret: null,
			tokenExpiresAt: new Date(Date.now() - 60_000), // hard-expired
			updatedAt: new Date(Date.now() - knownExpirySeconds * 1000 * 2),
			needsReauth: false,
			refreshFailureCount: 2, // third strike
			mcpServer: notionServer,
			baseUrl: null,
		});

		const result = await getValidAccessToken({
			configId: "cfg_6",
			userId: "user-1",
		});

		expect(result).toBeNull();
		// The token endpoint was never contacted...
		expect(refreshOAuthTokenMock).not.toHaveBeenCalled();
		// ...but the gap is still recorded for triage, without condemning —
		// and without naming `needsReauth` at all, so the write cannot undo a
		// concurrent condemnation.
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg_6", needsReauth: false },
				data: expect.objectContaining({
					refreshFailureCount: 3,
					lastRefreshError: "OAuth client secret not configured",
				}),
			}),
		);
		expect(updateManyMock.mock.calls[0]![0].data).not.toHaveProperty(
			"needsReauth",
		);
	});
});

/**
 * The classification gate has a second input nobody was reading: WHICH token
 * the rejection was about. A provider rejection only proves the grant is dead
 * if the refresh token we posted is STILL the one stored on the row. Providers
 * that rotate refresh tokens (Atlassian Rovo, GitLab) let a concurrent caller
 * win the race and persist a valid replacement while this one is in flight —
 * the loser's `invalid_grant` then describes a token that has already been
 * superseded, and condemning on it hard-blocks a live credential until the
 * user reconnects. `packages/mcp`'s OAuth provider has had rotation-race
 * recovery for exactly this shape; this path had none.
 */
describe("getValidAccessToken — a rotated refresh token makes invalid_grant stale evidence", () => {
	const notionServer = {
		defaultUrl: "https://mcp.notion.com",
		oauthTokenEndpoint: "https://mcp.notion.com/token",
		oauthDiscoveryUrl: null,
	};

	const expiredConfig = {
		id: "cfg_8",
		userId: "user-1",
		organizationId: null,
		authType: "OAUTH2",
		status: "HEALTHY",
		encryptedAccessToken: "ENC:stale-access",
		oauthClientId: "client-id",
		encryptedOauthClientSecret: "ENC:client-secret",
		tokenExpiresAt: new Date(Date.now() - 60_000), // hard-expired
		updatedAt: new Date(Date.now() - 7_200_000),
		needsReauth: false,
		refreshFailureCount: 2, // third strike: a permanent failure condemns
		mcpServer: notionServer,
		baseUrl: null,
	};

	beforeEach(() => {
		findUniqueMock.mockReset();
		updateMock.mockReset();
		updateManyMock.mockReset();
		updateManyMock.mockResolvedValue({ count: 1 });
		refreshOAuthTokenMock.mockReset();
		safeFetchOutboundMock.mockReset();
		safeFetchOutboundMock.mockResolvedValue({ ok: false });
	});

	it("records the failure WITHOUT condemning when the stored token rotated mid-flight", async () => {
		// The winner persists its replacement while our POST is in flight, so
		// the reload after the rejection sees a token we never sent.
		let rotated = false;
		findUniqueMock.mockImplementation(async () => ({
			...expiredConfig,
			encryptedRefreshToken: rotated
				? "ENC:winner-refresh"
				: "ENC:loser-refresh",
		}));
		refreshOAuthTokenMock.mockImplementation(async () => {
			rotated = true;
			return {
				ok: false,
				errorCode: "invalid_grant",
				errorMessage: "Refresh token revoked",
			};
		});

		const result = await getValidAccessToken({
			configId: "cfg_8",
			userId: "user-1",
		});

		expect(result).toBeNull();
		// We posted the token this call actually held...
		expect(refreshOAuthTokenMock).toHaveBeenCalledWith(
			expect.objectContaining({ refreshToken: "loser-refresh" }),
		);
		// ...and the strike still lands for triage, but as diagnostics only:
		// the credential the row now holds was never rejected by anyone.
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledTimes(1);
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg_8", needsReauth: false },
				data: expect.objectContaining({
					refreshFailureCount: 3,
					lastRefreshError:
						"Token refresh failed: Refresh token revoked",
				}),
			}),
		);
		const rotatedData = updateManyMock.mock.calls[0]![0].data;
		expect(rotatedData).not.toHaveProperty("needsReauth");
		expect(rotatedData).not.toHaveProperty("status");
	});

	it("still condemns when the reload shows the very token we posted", async () => {
		// Nothing rotated, so the rejection is about the credential the row
		// still holds — the case the breaker exists for.
		findUniqueMock.mockResolvedValue({
			...expiredConfig,
			encryptedRefreshToken: "ENC:only-refresh",
		});
		refreshOAuthTokenMock.mockResolvedValue({
			ok: false,
			errorCode: "invalid_grant",
			errorMessage: "Refresh token revoked",
		});

		const result = await getValidAccessToken({
			configId: "cfg_8",
			userId: "user-1",
		});

		expect(result).toBeNull();
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "cfg_8",
					encryptedRefreshToken: "ENC:only-refresh",
					needsReauth: false,
				},
				data: expect.objectContaining({
					refreshFailureCount: 3,
					needsReauth: true,
					status: "UNAVAILABLE",
				}),
			}),
		);
	});

	it("does not reload the row for a transient failure", async () => {
		// The comparison is scoped to rejections that would otherwise condemn:
		// a 5xx never reaches the classification gate, so it must not pay for
		// an extra read on every failing refresh.
		findUniqueMock.mockResolvedValue({
			...expiredConfig,
			encryptedRefreshToken: "ENC:only-refresh",
		});
		refreshOAuthTokenMock.mockResolvedValue({
			ok: false,
			errorCode: "http_503",
			errorMessage: "upstream returned 503",
		});

		await getValidAccessToken({ configId: "cfg_8", userId: "user-1" });

		// `getValidAccessToken` reads once, `refreshAccessToken` re-reads, and
		// `recordRefreshFailure` reads again — three, with no reload in between.
		expect(findUniqueMock).toHaveBeenCalledTimes(3);
		// The transient write is guarded on `needsReauth: false` rather than
		// setting it.
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg_8", needsReauth: false },
			}),
		);
		expect(updateManyMock.mock.calls[0]![0].data).not.toHaveProperty(
			"needsReauth",
		);
	});
});

/**
 * The same evidence, with the other variable moved. The rotation suite above
 * changes the refresh token; this one changes only its ENCRYPTION, which is the
 * case that separates the two comparisons made of it:
 *
 * - the rotation check compares DECRYPTED values, because `encryptApiKey` is
 *   non-deterministic and comparing ciphertext would report a rotation on every
 *   re-encrypt;
 * - the condemning write compares CIPHERTEXT, because there the token is a row
 *   version, answering "is this still the row I read" rather than "is this a
 *   different credential".
 *
 * A non-rotating provider echoes the refresh token back on every successful
 * refresh and `updateMcpConfigTokens` re-encrypts whatever it is handed, so a
 * concurrent winner really does replace the stored ciphertext without changing
 * the credential. The consequence below is deliberate and fail-safe: the
 * condemning write misses and this attempt declines to condemn, while the next
 * one reads the new ciphertext and condemns on it.
 */
describe("getValidAccessToken — re-encrypting the same refresh token is not a rotation", () => {
	const notionServer = {
		defaultUrl: "https://mcp.notion.com",
		oauthTokenEndpoint: "https://mcp.notion.com/token",
		oauthDiscoveryUrl: null,
	};

	// One simulated row, so the conditional writes are evaluated rather than
	// stubbed: `updateMany` matches its `where` against the stored values the
	// way Postgres would, and a miss returns zero because the ciphertext
	// genuinely moved on — not because a test said so.
	let storedRow: Record<string, unknown>;
	let reEncrypted = false;

	beforeEach(() => {
		findUniqueMock.mockReset();
		updateMock.mockReset();
		updateManyMock.mockReset();
		refreshOAuthTokenMock.mockReset();
		safeFetchOutboundMock.mockReset();
		safeFetchOutboundMock.mockResolvedValue({ ok: false });

		reEncrypted = false;
		storedRow = {
			id: "cfg_10",
			userId: "user-1",
			organizationId: null,
			authType: "OAUTH2",
			status: "HEALTHY",
			encryptedAccessToken: "ENC:stale-access",
			encryptedRefreshToken: encryptApiKey("live-refresh"),
			oauthClientId: "client-id",
			encryptedOauthClientSecret: "ENC:client-secret",
			tokenExpiresAt: new Date(Date.now() - 60_000), // hard-expired
			updatedAt: new Date(Date.now() - 7_200_000),
			needsReauth: false,
			refreshFailureCount: 2, // next permanent failure is the third strike
			mcpServer: notionServer,
			baseUrl: null,
		};

		findUniqueMock.mockImplementation(async () => ({ ...storedRow }));
		updateManyMock.mockImplementation(
			async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const matched = Object.entries(args.where).every(
					([column, value]) => storedRow[column] === value,
				);
				if (!matched) {
					return { count: 0 };
				}
				Object.assign(storedRow, args.data);
				return { count: 1 };
			},
		);

		// A parallel refresh lands while our POST is in flight. The provider does
		// not rotate, so it echoes the same refresh token back and the winner
		// stores a fresh encryption of an unchanged plaintext; the grant is then
		// revoked, and our POST is the one that hears about it.
		refreshOAuthTokenMock.mockImplementation(async () => {
			if (!reEncrypted) {
				reEncrypted = true;
				storedRow.encryptedRefreshToken = encryptApiKey("live-refresh");
			}
			return {
				ok: false,
				errorCode: "invalid_grant",
				errorMessage: "Refresh token revoked",
			};
		});
	});

	it("still classifies the rejection as permanent, because the reload compares decrypted values", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const postedCiphertext = storedRow.encryptedRefreshToken;

		await getValidAccessToken({ configId: "cfg_10", userId: "user-1" });

		// The stored ciphertext did change under us...
		expect(storedRow.encryptedRefreshToken).not.toBe(postedCiphertext);
		// ...but it decrypts to the token we posted, so nothing rotated and the
		// rejection is still decisive. Collapsing this comparison onto the
		// ciphertext would downgrade it to transient, and the first write would
		// be the diagnostics-only one asserted in the next test.
		expect(updateManyMock.mock.calls[0]![0]).toEqual(
			expect.objectContaining({
				where: {
					id: "cfg_10",
					encryptedRefreshToken: postedCiphertext,
					needsReauth: false,
				},
				data: expect.objectContaining({
					refreshFailureCount: 3,
					needsReauth: true,
					status: "UNAVAILABLE",
				}),
			}),
		);
		consoleErrorSpy.mockRestore();
	});

	it("declines to condemn anyway, because the condemning write names the ciphertext it read", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const result = await getValidAccessToken({
			configId: "cfg_10",
			userId: "user-1",
		});

		expect(result).toBeNull();
		// The condemning write matched nothing — the row version it names is
		// gone — so the strike lands through the diagnostics fallback instead.
		expect(updateManyMock).toHaveBeenCalledTimes(2);
		const fallback = updateManyMock.mock.calls[1]![0];
		expect(fallback.where).toEqual({ id: "cfg_10", needsReauth: false });
		expect(fallback.data).toMatchObject({
			refreshFailureCount: 3,
			lastRefreshError: "Token refresh failed: Refresh token revoked",
		});
		expect(fallback.data).not.toHaveProperty("needsReauth");
		expect(fallback.data).not.toHaveProperty("status");
		// So the row survives a re-encryption that changed nothing. That is the
		// direction to fail in: a ciphertext-blind write would instead condemn
		// on evidence about a row version that no longer exists.
		expect(storedRow.needsReauth).toBe(false);
		expect(storedRow.status).toBe("HEALTHY");
		expect(updateMock).not.toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledOnce();
		consoleErrorSpy.mockRestore();
	});

	it("condemns on the next attempt, which reads the ciphertext the row now holds", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await getValidAccessToken({ configId: "cfg_10", userId: "user-1" });
		expect(storedRow.needsReauth).toBe(false);

		// Nothing re-encrypts this time, so the write names the version the row
		// still holds and matches it. The deferral costs one further refresh
		// attempt against a dead grant, not the breaker.
		await getValidAccessToken({ configId: "cfg_10", userId: "user-1" });

		expect(storedRow.needsReauth).toBe(true);
		expect(storedRow.status).toBe("UNAVAILABLE");
		expect(storedRow.refreshFailureCount).toBe(4);
		consoleErrorSpy.mockRestore();
	});
});

describe("isPermanentGrantFailure", () => {
	it("classifies only the codes that reject the grant itself as permanent", () => {
		expect(isPermanentGrantFailure("invalid_grant")).toBe(true);
		expect(isPermanentGrantFailure("invalid_token")).toBe(true);
	});

	it("treats every other outcome as transient", () => {
		// `network_error` / `invalid_response` / `http_<status>` are
		// `refreshOAuthToken`'s own codes; `invalid_client` is the provider
		// rejecting OUR credentials, not the user's grant.
		for (const code of [
			"network_error",
			"invalid_response",
			"invalid_client",
			"http_503",
			"",
			undefined,
			null,
		]) {
			expect(isPermanentGrantFailure(code)).toBe(false);
		}
	});
});

/**
 * `recordRefreshFailure` is the only writer of `needsReauth`, and the flag is
 * now enforced everywhere — refused at client creation, filtered out of tool
 * discovery, blocked from refreshing — with a user reconnect as its only
 * exit. These pin the classification gate directly, independent of which
 * caller supplied it.
 */
describe("recordRefreshFailure — only a dead grant condemns", () => {
	const condemnableConfig = {
		id: "cfg_7",
		status: "HEALTHY",
		needsReauth: false,
		refreshFailureCount: 2, // next failure is the third strike
		mcpServer: null,
	};

	beforeEach(() => {
		findUniqueMock.mockReset();
		updateMock.mockReset();
		updateManyMock.mockReset();
		updateManyMock.mockResolvedValue({ count: 1 });
	});

	it("flips needsReauth on the third permanent failure", async () => {
		findUniqueMock.mockResolvedValue({ ...condemnableConfig });

		const outcome = await recordRefreshFailure({
			configId: "cfg_7",
			errorMessage: "Token refresh failed: Refresh token revoked",
			permanent: true,
			expectedRefreshToken: "ENC:rejected-refresh",
		});

		expect(outcome).toEqual({ needsReauth: true, failureCount: 3 });
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "cfg_7",
					encryptedRefreshToken: "ENC:rejected-refresh",
					needsReauth: false,
				},
				data: expect.objectContaining({
					refreshFailureCount: 3,
					needsReauth: true,
					status: "UNAVAILABLE",
				}),
			}),
		);
	});

	it("records a transient failure at the threshold without condemning", async () => {
		findUniqueMock.mockResolvedValue({ ...condemnableConfig });

		const outcome = await recordRefreshFailure({
			configId: "cfg_7",
			errorMessage: "Token refresh failed: Connection refused",
			permanent: false,
		});

		expect(outcome).toEqual({ needsReauth: false, failureCount: 3 });
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg_7", needsReauth: false },
				data: expect.objectContaining({
					refreshFailureCount: 3,
					lastRefreshError:
						"Token refresh failed: Connection refused",
				}),
			}),
		);
		// Neither column is named. Writing `needsReauth: false` would clear a
		// flag a concurrent permanent failure had just set, and writing back
		// `cfg.status` would restore a stale snapshot of it; the config keeps
		// its existing status because nothing here touches it.
		const data = updateManyMock.mock.calls[0]![0].data;
		expect(data).not.toHaveProperty("needsReauth");
		expect(data).not.toHaveProperty("status");
	});

	it("still refuses to condemn a transient failure long past the threshold", async () => {
		findUniqueMock.mockResolvedValue({
			...condemnableConfig,
			refreshFailureCount: 41,
		});

		const outcome = await recordRefreshFailure({
			configId: "cfg_7",
			errorMessage: "Token refresh failed: upstream returned 503",
			permanent: false,
		});

		expect(outcome).toEqual({ needsReauth: false, failureCount: 42 });
	});

	it("defaults to transient when the caller supplies no classification", async () => {
		findUniqueMock.mockResolvedValue({ ...condemnableConfig });

		const outcome = await recordRefreshFailure({
			configId: "cfg_7",
			errorMessage: "Token refresh failed: something unclassified",
		});

		expect(outcome).toEqual({ needsReauth: false, failureCount: 3 });
	});

	it("writes nothing when the config is already condemned", async () => {
		findUniqueMock.mockResolvedValue({
			...condemnableConfig,
			needsReauth: true,
			refreshFailureCount: 3,
			status: "UNAVAILABLE",
		});

		const outcome = await recordRefreshFailure({
			configId: "cfg_7",
			errorMessage: "Token refresh failed: Refresh token revoked",
			permanent: true,
			expectedRefreshToken: "ENC:rejected-refresh",
		});

		// Re-writing an already-condemned row would inflate its counters and
		// overwrite the diagnostics of the failure that actually tripped it.
		expect(outcome).toEqual({ needsReauth: true, failureCount: 3 });
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).not.toHaveBeenCalled();
	});
});

/**
 * Comparing tokens before writing narrows the race; it does not close it. The
 * winning refresh can persist its replacement in the window between that
 * comparison and the write, so the condemning write itself has to be
 * conditional on the row version the rejection describes. Three concurrent
 * callers on a rotating provider is enough to lose that window, and the cost
 * is a hard block on a live credential that only a user reconnect clears.
 */
describe("recordRefreshFailure — the condemning write is bound to its evidence", () => {
	const condemnableConfig = {
		id: "cfg_9",
		status: "HEALTHY",
		needsReauth: false,
		refreshFailureCount: 2, // next permanent failure is the third strike
		mcpServer: null,
	};

	beforeEach(() => {
		findUniqueMock.mockReset();
		updateMock.mockReset();
		updateManyMock.mockReset();
		updateManyMock.mockResolvedValue({ count: 1 });
		findUniqueMock.mockResolvedValue({ ...condemnableConfig });
	});

	it("condemns through a write gated on the refresh token that was rejected", async () => {
		const outcome = await recordRefreshFailure({
			configId: "cfg_9",
			errorMessage: "Token refresh failed: Refresh token revoked",
			permanent: true,
			expectedRefreshToken: "ENC:rejected-refresh",
		});

		expect(outcome).toEqual({ needsReauth: true, failureCount: 3 });
		// One write, not two: the diagnostics ride along with the conditional
		// update so a matched row records everything atomically.
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledOnce();
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "cfg_9",
					encryptedRefreshToken: "ENC:rejected-refresh",
					// Bound to the breaker as well as to the token: a row
					// condemned between our read and this write already carries
					// the diagnostics of the failure that tripped it.
					needsReauth: false,
				},
				data: expect.objectContaining({
					refreshFailureCount: 3,
					needsReauth: true,
					status: "UNAVAILABLE",
				}),
			}),
		);
	});

	it("records diagnostics only when the row no longer holds the rejected token", async () => {
		// Zero matched rows is the proof the race was lost: a parallel refresh
		// persisted a replacement while this one was in flight, so our
		// rejection describes a token that is already gone. The fallback that
		// records the telemetry is itself conditional — it lands here because
		// the row is still uncondemned, which is what distinguishes a rotation
		// from a concurrent condemnation.
		updateManyMock.mockResolvedValueOnce({ count: 0 });
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const outcome = await recordRefreshFailure({
			configId: "cfg_9",
			errorMessage: "Token refresh failed: Refresh token revoked",
			permanent: true,
			expectedRefreshToken: "ENC:superseded-refresh",
		});

		expect(outcome).toEqual({ needsReauth: false, failureCount: 3 });
		// No unconditional write behind the miss — the fallback is an
		// `updateMany` gated on the breaker.
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledTimes(2);
		const arg = updateManyMock.mock.calls[1]![0];
		expect(arg.where).toEqual({ id: "cfg_9", needsReauth: false });
		expect(arg.data).toMatchObject({
			refreshFailureCount: 3,
			lastRefreshError: "Token refresh failed: Refresh token revoked",
		});
		// Absent, not `false`, and the status is left alone: a concurrent
		// failure with better evidence may have condemned the row between our
		// read and this write, and clearing that would be worse than the race
		// we are already guarding.
		expect(arg.data).not.toHaveProperty("needsReauth");
		expect(arg.data).not.toHaveProperty("status");
		// A rejection that could not be acted on is worth a line.
		expect(consoleErrorSpy).toHaveBeenCalledOnce();
		consoleErrorSpy.mockRestore();
	});

	it("writes nothing further when a concurrent failure condemned the row first", async () => {
		// The other reading of a zero-match condemnation. Both writes miss:
		// the row is condemned, so it already holds the diagnostics of the
		// failure that tripped the breaker and this one must leave them alone.
		updateManyMock.mockResolvedValue({ count: 0 });
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const outcome = await recordRefreshFailure({
			configId: "cfg_9",
			errorMessage: "Token refresh failed: Refresh token revoked",
			permanent: true,
			expectedRefreshToken: "ENC:superseded-refresh",
		});

		// Reported as condemned, because it is, and with the counter from our
		// snapshot, since the increment never landed.
		expect(outcome).toEqual({ needsReauth: true, failureCount: 2 });
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledTimes(2);
		// Declining is the guard working, so it is not logged as a failure —
		// unlike the rotation above, which leaves a rejection unacted on.
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		consoleErrorSpy.mockRestore();
	});

	it("binds a transient failure to the breaker instead of the token", async () => {
		// A 5xx is not evidence about any particular row version, so it does
		// not bind to the token. It is still conditional, on the other axis:
		// the row must still be uncondemned, or these diagnostics would be
		// overwriting the ones from the failure that actually tripped it.
		const outcome = await recordRefreshFailure({
			configId: "cfg_9",
			errorMessage: "Token refresh failed: upstream returned 503",
			permanent: false,
			expectedRefreshToken: "ENC:refresh",
		});

		expect(outcome).toEqual({ needsReauth: false, failureCount: 3 });
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledOnce();
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg_9", needsReauth: false },
			}),
		);
	});

	it("declines the diagnostics write when the breaker tripped between the read and the write", async () => {
		// Zero matched rows here means a concurrent permanent failure condemned
		// the row after our snapshot. The old unconditional write carried
		// `needsReauth: false` and would have landed last, restoring the dead
		// credential and reopening the retry storm.
		updateManyMock.mockResolvedValue({ count: 0 });
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const outcome = await recordRefreshFailure({
			configId: "cfg_9",
			errorMessage: "Token refresh failed: upstream returned 503",
			permanent: false,
		});

		// Reported as condemned, because it is — the snapshot that said
		// otherwise is stale — and with the count from that snapshot, since
		// our increment never landed.
		expect(outcome).toEqual({ needsReauth: true, failureCount: 2 });
		// No unconditional retry: declining IS the correct outcome here.
		expect(updateMock).not.toHaveBeenCalled();
		// ...and it is not a failure, so it is not logged as one.
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		consoleErrorSpy.mockRestore();
	});

	it("still condemns when the caller posted no token, bound to the breaker alone", async () => {
		// No longer reachable through the typed signature — `permanent: true`
		// must travel with the `expectedRefreshToken` it is bound to, and the
		// `@ts-expect-error` below fails the build if that constraint is ever
		// relaxed. The runtime branch survives for untyped callers: dropping
		// the strike would fail open into the retry storm. There is no row
		// version to bind to, but the breaker guard still applies.
		const outcome = await recordRefreshFailure(
			// @ts-expect-error — `permanent: true` requires `expectedRefreshToken`
			{
				configId: "cfg_9",
				errorMessage: "Token refresh failed: Refresh token revoked",
				permanent: true,
			},
		);

		expect(outcome).toEqual({ needsReauth: true, failureCount: 3 });
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledOnce();
		expect(updateManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg_9", needsReauth: false },
				data: expect.objectContaining({
					needsReauth: true,
					status: "UNAVAILABLE",
				}),
			}),
		);
	});

	it("reports an evidence-free condemnation as condemned when the row was condemned first", async () => {
		// Declining changes no outcome — the row is behind the breaker either
		// way — and it preserves the diagnostics of the failure that put it
		// there. The counter comes from our snapshot, since the increment
		// never landed.
		updateManyMock.mockResolvedValue({ count: 0 });

		const outcome = await recordRefreshFailure(
			// @ts-expect-error — `permanent: true` requires `expectedRefreshToken`
			{
				configId: "cfg_9",
				errorMessage: "Token refresh failed: Refresh token revoked",
				permanent: true,
			},
		);

		expect(outcome).toEqual({ needsReauth: true, failureCount: 2 });
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledOnce();
	});
});
