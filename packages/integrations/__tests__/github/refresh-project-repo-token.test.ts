/**
 * `refreshProjectRepoGitHubToken` — serialized, single-use-safe refresh.
 *
 * GitHub rotates the refresh token on every exchange, so two un-serialized
 * refreshers would burn each other's token (the loser gets HTTP 404). The
 * refresh is serialized per-integration with a Postgres advisory lock inside an
 * interactive transaction, re-reading the CURRENT token under the lock. Locks
 * the contract:
 *  - a concurrent winner's still-fresh token (re-read expiry in the future) is
 *    reused without a second OAuth exchange;
 *  - an actually-stale token is exchanged and the rotated tokens persisted;
 *  - the CURRENT stored refresh token is exchanged, not the caller's snapshot;
 *  - a wiped row (disconnect) is never resurrected;
 *  - a failed OAuth exchange returns null without writing;
 *  - the stored refresh-token ciphertext is preserved when GitHub omits a
 *    rotation.
 */
import {
	advisoryObjectKey,
	repoIntegrationLockKey,
} from "@repo/database/prisma/queries/lib/refresh-lock-key";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTxExecuteRaw = vi.fn();
const mockTxFindUnique = vi.fn();
const mockTxUpdateMany = vi.fn();
const mockTransaction = vi.fn();
const mockWorkflowIntegrationFindFirst = vi.fn();
const mockRefreshOAuthToken = vi.fn();
const mockEncryptApiKey = vi.fn();
const mockDecryptApiKey = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		$transaction: (...args: unknown[]) => mockTransaction(...args),
		workflowIntegration: {
			findFirst: (...args: unknown[]) =>
				mockWorkflowIntegrationFindFirst(...args),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (...args: unknown[]) => mockDecryptApiKey(...args),
	encryptApiKey: (...args: unknown[]) => mockEncryptApiKey(...args),
}));

vi.mock("@repo/utils/oauth-refresh", () => ({
	refreshOAuthToken: (...args: unknown[]) => mockRefreshOAuthToken(...args),
	sanitizeCredential: (v: string) => v.replace(/^﻿/, "").trim(),
}));

import {
	refreshProjectRepoGitHubToken,
	refreshProjectRepoGitHubTokenWithOutcome,
} from "../../src/github";

const HOUR_MS = 60 * 60 * 1000;

const baseInput = {
	integrationId: "int-1",
	encryptedRefreshToken: "enc:caller-snapshot",
	expectedUpdatedAt: new Date("2026-06-01T00:00:00Z"),
	userId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	// Env-var client credentials short-circuit the DB fallback lookup.
	vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "client-id");
	vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "client-secret");
	// db.$transaction(fn, opts) runs fn with a tx that holds the advisory lock.
	// The lock is taken with $executeRaw (returns an affected-row count) because
	// pg_advisory_xact_lock() returns `void`, which $queryRaw cannot deserialize.
	mockTxExecuteRaw.mockResolvedValue(1);
	mockTxUpdateMany.mockResolvedValue({ count: 1 });
	mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			$executeRaw: (...a: unknown[]) => mockTxExecuteRaw(...a),
			projectRepositoryIntegration: {
				findUnique: (...a: unknown[]) => mockTxFindUnique(...a),
				updateMany: (...a: unknown[]) => mockTxUpdateMany(...a),
			},
		}),
	);
	mockRefreshOAuthToken.mockResolvedValue({
		ok: true,
		accessToken: "fresh-token",
		refreshToken: "rotated-refresh",
		expiresIn: 28800,
	});
	mockEncryptApiKey.mockImplementation((value: string) => `enc(${value})`);
	mockDecryptApiKey.mockImplementation((cipher: string) =>
		cipher === "enc:current-access" ? "reused-access" : `plain(${cipher})`,
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("refreshProjectRepoGitHubToken — serialized refresh", () => {
	it("exchanges the CURRENT stored refresh token and persists the rotation", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});

		const token = await refreshProjectRepoGitHubToken(baseInput);

		expect(token).toBe("fresh-token");
		// The re-read DB token is exchanged — NOT the caller's stale snapshot.
		expect(mockRefreshOAuthToken).toHaveBeenCalledWith(
			expect.objectContaining({
				refreshToken: "plain(enc:current-refresh)",
			}),
		);
		expect(mockTxUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				// Pinned to the exchanged ciphertext: a reconnect landing after
				// the exchange must not have its fresh credentials overwritten
				// by ones rotated out of the old grant.
				where: {
					id: "int-1",
					status: { not: "DISCONNECTED" },
					encryptedRefreshToken: "enc:current-refresh",
				},
				data: expect.objectContaining({
					encryptedAccessToken: "enc(fresh-token)",
					encryptedRefreshToken: "enc(rotated-refresh)",
					status: "ACTIVE",
					lastError: null,
				}),
			}),
		);
	});

	it("does NOT overwrite credentials a concurrent reconnect wrote after the exchange", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		// CAS miss: the stored ciphertext is no longer the one we exchanged.
		mockTxUpdateMany.mockResolvedValue({ count: 0 });

		const token = await refreshProjectRepoGitHubToken(baseInput);

		// No token handed back — the caller retries against what is now stored
		// rather than proceeding with a credential derived from the old grant.
		expect(token).toBeNull();
	});

	it("reuses a concurrent winner's token (re-read still fresh) without exchanging", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:current-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() + 8 * HOUR_MS),
		});

		const token = await refreshProjectRepoGitHubToken(baseInput);

		expect(token).toBe("reused-access");
		expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
		expect(mockTxUpdateMany).not.toHaveBeenCalled();
	});

	it("never resurrects credentials onto a wiped (disconnected) row", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			tokenExpiresAt: null,
		});

		const token = await refreshProjectRepoGitHubToken(baseInput);

		expect(token).toBeNull();
		expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
		expect(mockTxUpdateMany).not.toHaveBeenCalled();
	});

	it("returns null and writes NO credentials when the OAuth exchange fails", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorMessage: "HTTP 404 from token endpoint",
		});

		const token = await refreshProjectRepoGitHubToken(baseInput);

		expect(token).toBeNull();
		expect(mockTxUpdateMany).not.toHaveBeenCalled();
	});

	it("does NOT stamp refreshTokenRejectedAt on an ambiguous bare 404", async () => {
		// GitHub answers HTTP 404 both for a corrupted client_id and for a
		// refresh token a concurrent caller already rotated away. Retiring the
		// row from the health-check sweep removes the very mechanism that would
		// recover it, so ambiguity must never be enough — only a code that
		// names the refresh token can strand a connection.
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "http_404",
			errorMessage: "HTTP 404 from token endpoint",
		});

		const result =
			await refreshProjectRepoGitHubTokenWithOutcome(baseInput);

		// Neither a fault nor a rejection: blame nobody, retry next cycle. A
		// corrupted deployment client_id must not surface as a reconnect
		// prompt to every tenant at once.
		expect(result).toEqual({ token: null, platformFault: undefined });
		expect(mockTxUpdateMany).not.toHaveBeenCalled();
	});

	it("stamps refreshTokenRejectedAt when the provider rejects the grant itself", async () => {
		// `bad_refresh_token` names the refresh token, so no future exchange
		// can succeed and the scheduled sweep must retire the row rather than
		// retrying it every 30 minutes forever.
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "bad_refresh_token",
			errorMessage: "The refresh token passed is incorrect or expired.",
		});

		const result =
			await refreshProjectRepoGitHubTokenWithOutcome(baseInput);

		// The witness travels with the verdict so a LATER write can pin itself
		// to the same credential generation.
		expect(result).toEqual({
			token: null,
			grantRejected: true,
			rejectedRefreshToken: "enc:current-refresh",
		});
		expect(mockTxUpdateMany).toHaveBeenCalledTimes(1);
		const call = mockTxUpdateMany.mock.calls[0][0];
		// Guarded so a disconnect landing mid-exchange is not annotated back,
		// and CAS'd on the exact ciphertext we exchanged so a concurrent
		// reconnect's fresh grant is never stamped.
		expect(call.where).toMatchObject({
			status: { not: "DISCONNECTED" },
			encryptedRefreshToken: "enc:current-refresh",
		});
		expect(call.data.refreshTokenRejectedAt).toBeInstanceOf(Date);
	});

	it("reports invalid_grant as a rejection but does NOT make it sticky", async () => {
		// RFC 6749 also uses invalid_grant when a grant was issued to another
		// client, so a deployment resolving the wrong OAuth app would
		// permanently retire connections whose grants are alive under the
		// right one. Expiring is fine (self-heals); retiring is not.
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "invalid_grant",
			errorMessage: "The provided authorization grant is invalid.",
		});

		const result =
			await refreshProjectRepoGitHubTokenWithOutcome(baseInput);

		expect(result).toEqual({
			token: null,
			grantRejected: true,
			rejectedRefreshToken: "enc:current-refresh",
		});
		const call = mockTxUpdateMany.mock.calls[0][0];
		expect(call.data.refreshTokenRejectedAt).toBeUndefined();
	});

	it("reports NO rejection when a concurrent reconnect replaced the credential", async () => {
		// The advisory locks serialize refresh callers only — the reconnect
		// callback takes neither, so it can land between our in-lock read and
		// this write. The CAS misses, and the rejection must not be reported:
		// otherwise the caller expires, and we stamp, the grant the user just
		// successfully reconnected.
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "bad_refresh_token",
			errorMessage: "The refresh token passed is incorrect or expired.",
		});
		mockTxUpdateMany.mockResolvedValue({ count: 0 });

		const result =
			await refreshProjectRepoGitHubTokenWithOutcome(baseInput);

		expect(result).toEqual({ token: null });
	});

	it("does NOT stamp refreshTokenRejectedAt on a platform fault", async () => {
		// A token endpoint 500 says nothing about the customer's grant —
		// retiring the row here would strand a healthy connection.
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: false,
			errorCode: "http_500",
			errorMessage: "HTTP 500 from token endpoint",
		});

		const result =
			await refreshProjectRepoGitHubTokenWithOutcome(baseInput);

		expect(result).toEqual({
			token: null,
			platformFault: "PROVIDER_UNAVAILABLE",
		});
		expect(mockTxUpdateMany).not.toHaveBeenCalled();
	});

	it("clears refreshTokenRejectedAt when a refresh succeeds", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: true,
			accessToken: "fresh-token",
			refreshToken: "rotated-refresh",
			expiresIn: 28800,
		});

		await refreshProjectRepoGitHubToken(baseInput);

		expect(mockTxUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ refreshTokenRejectedAt: null }),
			}),
		);
	});

	it("preserves the stored refresh-token ciphertext when GitHub did not rotate it", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		mockRefreshOAuthToken.mockResolvedValue({
			ok: true,
			accessToken: "fresh-token",
			refreshToken: undefined,
			expiresIn: 28800,
		});

		await refreshProjectRepoGitHubToken(baseInput);

		expect(mockTxUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					encryptedRefreshToken: "enc:current-refresh",
				}),
			}),
		);
	});

	it("does NOT resurrect a row disconnected concurrently during the OAuth exchange", async () => {
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});
		// The conditional write matches no row: the user disconnected
		// (status → DISCONNECTED) while the OAuth exchange was in flight.
		mockTxUpdateMany.mockResolvedValueOnce({ count: 0 });

		const token = await refreshProjectRepoGitHubToken(baseInput);

		expect(mockRefreshOAuthToken).toHaveBeenCalledTimes(1); // exchange happened
		expect(token).toBeNull(); // but null → caller won't restore
	});

	it("acquires the advisory lock via $executeRaw, not $queryRaw (void is not deserialized)", async () => {
		// Regression: pg_advisory_xact_lock() returns `void`; under the Postgres
		// driver adapter $queryRaw throws "Failed to deserialize column of type
		// 'void'", which aborted EVERY refresh and stranded GitHub OAuth
		// integrations until a manual reconnect. The lock MUST use $executeRaw.
		mockTxFindUnique.mockResolvedValue({
			encryptedAccessToken: "enc:stale-access",
			encryptedRefreshToken: "enc:current-refresh",
			tokenExpiresAt: new Date(Date.now() - HOUR_MS),
		});

		const token = await refreshProjectRepoGitHubToken(baseInput);

		expect(token).toBe("fresh-token");
		// Two locks: the legacy bare-id key this path used before the
		// unification, then the `repo:<id>` key it uses now. Both are held for
		// the rolling deploy so a draining replica (legacy key only) still
		// serializes against a live one; the legacy acquisition comes out once
		// the revision is everywhere.
		expect(mockTxExecuteRaw).toHaveBeenCalledTimes(2);
		for (const call of mockTxExecuteRaw.mock.calls) {
			const lockSql = (call[0] as TemplateStringsArray).join("");
			expect(lockSql).toMatch(/pg_advisory_xact_lock\(::int, ::int\)/);
		}
		// Legacy key first — the ordering that makes the pair deadlock-free.
		const [legacyCall, unifiedCall] = mockTxExecuteRaw.mock.calls;
		expect(legacyCall[2]).toBe(advisoryObjectKey(baseInput.integrationId));
		expect(unifiedCall[2]).toBe(
			advisoryObjectKey(repoIntegrationLockKey(baseInput.integrationId)),
		);
	});
});
