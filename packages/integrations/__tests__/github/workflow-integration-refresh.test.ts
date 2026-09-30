/**
 * GitHub `WorkflowIntegration` token refresh — the cross-process lock path.
 *
 * GitLab's equivalent had coverage; GitHub did not, which is exactly the
 * asymmetry that lets a regression slip back in unnoticed. These tests pin the
 * two properties that matter:
 *   1. Everything the lock guards writes through the TRANSACTION client, never
 *      the outer `db` — writing on `db` while holding the lock checks out a
 *      second pooled connection and can starve a pool that defaults to 10.
 *   2. A caller that queued behind the lock reuses the winner's freshly rotated
 *      token instead of spending it again (GitHub rotates single-use).
 *   3. The exchange is bounded, and starts only when the lock transaction's
 *      remaining budget still fits it — an exchange that outlives the
 *      transaction can rotate the refresh token after Prisma has rolled back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockFindFirst,
	mockFindUnique,
	mockUpdate,
	mockTxFindUnique,
	mockTxUpdate,
	mockAssertBudget,
	mockFetch,
} = vi.hoisted(() => ({
	mockFindFirst: vi.fn(),
	mockFindUnique: vi.fn(),
	mockUpdate: vi.fn(),
	mockTxFindUnique: vi.fn(),
	mockTxUpdate: vi.fn(),
	mockAssertBudget: vi.fn(),
	mockFetch: vi.fn(),
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		_key: string,
		fn: (
			tx: unknown,
			assertBudget: (requiredMs: number) => void,
		) => unknown,
	) =>
		fn(
			{
				workflowIntegration: {
					findUnique: mockTxFindUnique,
					update: mockTxUpdate,
				},
			},
			mockAssertBudget,
		),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: mockFindFirst,
			findUnique: mockFindUnique,
			update: mockUpdate,
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((v: string) => v),
	encryptApiKey: vi.fn((v: string) => `enc-${v}`),
}));

vi.mock("@repo/utils/oauth-refresh", () => ({
	sanitizeCredential: (v: string) => v.replace(/^﻿/, "").trim(),
	refreshOAuthToken: vi.fn(async () => ({
		ok: true,
		accessToken: "rotated-access",
		refreshToken: "rotated-refresh",
		expiresIn: 28800,
		tokenType: "bearer",
		scope: "repo",
	})),
}));

vi.stubGlobal("fetch", mockFetch);

import { refreshOAuthToken } from "@repo/utils/oauth-refresh";
import { executeGitHubTool, getGitHubAccessToken } from "../../src/github";

const EXPIRED_CREDS = JSON.stringify({
	access_token: "stale-access",
	refresh_token: "stale-refresh",
	expires_in: 28800,
	token_obtained_at: new Date(Date.now() - 9 * 3600_000).toISOString(),
});

const FRESH_CREDS = JSON.stringify({
	access_token: "winner-access",
	refresh_token: "winner-refresh",
	expires_in: 28800,
	token_obtained_at: new Date().toISOString(),
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "Iv23liTestClientId");
	vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "test-secret");
});

describe("GitHub WorkflowIntegration refresh under the advisory lock", () => {
	it("persists the rotated token through the TRANSACTION client, not the outer db", async () => {
		mockFindFirst.mockResolvedValue({
			id: "wf-1",
			credentials: EXPIRED_CREDS,
			settings: {},
		});
		// Inside the lock the row is still stale, so a real exchange happens.
		mockTxFindUnique.mockResolvedValue({ credentials: EXPIRED_CREDS });

		const token = await getGitHubAccessToken("user-1");

		expect(token).toBe("rotated-access");
		expect(mockTxUpdate).toHaveBeenCalledTimes(1);
		// The whole point: nothing wrote on the outer client while the lock was
		// held. A regression here silently reintroduces pool starvation.
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("reuses a concurrent winner's token instead of exchanging again", async () => {
		mockFindFirst.mockResolvedValue({
			id: "wf-1",
			credentials: EXPIRED_CREDS,
			settings: {},
		});
		// A winner rotated while we queued on the lock.
		mockTxFindUnique.mockResolvedValue({ credentials: FRESH_CREDS });

		const token = await getGitHubAccessToken("user-1");

		expect(token).toBe("winner-access");
		// No exchange, no write — spending the winner's single-use grant would
		// invalidate a token that is already live for them.
		expect(mockTxUpdate).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("fails fast without taking the lock when app credentials are missing", async () => {
		vi.stubEnv("FABRIC_GITHUB_CLIENT_ID", "");
		vi.stubEnv("FABRIC_GITHUB_CLIENT_SECRET", "");
		mockFindFirst.mockResolvedValue({
			id: "wf-1",
			credentials: EXPIRED_CREDS,
			settings: {},
		});
		// No GITHUB_OAUTH_APP fallback record either.
		mockFindFirst.mockResolvedValueOnce({
			id: "wf-1",
			credentials: EXPIRED_CREDS,
			settings: {},
		});

		// refreshTokenIfNeeded swallows the failure and returns the stale token
		// rather than throwing — but it must not have touched the lock.
		await getGitHubAccessToken("user-1");

		expect(mockTxFindUnique).not.toHaveBeenCalled();
		expect(mockTxUpdate).not.toHaveBeenCalled();
	});

	it("bounds the exchange and gates it on the lock's remaining budget", async () => {
		mockFindFirst.mockResolvedValue({
			id: "wf-1",
			credentials: EXPIRED_CREDS,
			settings: {},
		});
		mockTxFindUnique.mockResolvedValue({ credentials: EXPIRED_CREDS });

		await getGitHubAccessToken("user-1");

		expect(mockAssertBudget).toHaveBeenCalledWith(10_000);
		expect(refreshOAuthToken).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 10_000 }),
		);
		// The gate runs before the exchange is sent, never after.
		expect(mockAssertBudget.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(refreshOAuthToken).mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("sends nothing and keeps the current token when the budget is spent", async () => {
		mockFindFirst.mockResolvedValue({
			id: "wf-1",
			credentials: EXPIRED_CREDS,
			settings: {},
		});
		mockTxFindUnique.mockResolvedValue({ credentials: EXPIRED_CREDS });
		mockAssertBudget.mockImplementationOnce(() => {
			throw new Error("REFRESH_LOCK_BUDGET_EXHAUSTED");
		});

		const token = await getGitHubAccessToken("user-1");

		// Transient: no exchange spends the refresh token, nothing is written,
		// and the caller falls back to the stored token.
		expect(refreshOAuthToken).not.toHaveBeenCalled();
		expect(mockTxUpdate).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(token).toBe("stale-access");
	});

	it("never budget-gates a caller that reuses the winner's token", async () => {
		mockFindFirst.mockResolvedValue({
			id: "wf-1",
			credentials: EXPIRED_CREDS,
			settings: {},
		});
		mockTxFindUnique.mockResolvedValue({ credentials: FRESH_CREDS });

		await getGitHubAccessToken("user-1");

		expect(mockAssertBudget).not.toHaveBeenCalled();
	});
});

describe("GitHub tool 401 retry — refresh failure messaging", () => {
	const REJECTED_TOKEN_RESPONSE = {
		ok: false,
		status: 401,
		json: async () => ({ message: "Bad credentials" }),
	};

	beforeEach(() => {
		// The stored token looks fresh, so only the 401 triggers a refresh.
		mockFindFirst.mockResolvedValue({
			id: "wf-1",
			credentials: FRESH_CREDS,
			settings: {},
		});
		mockFindUnique.mockResolvedValue({ credentials: FRESH_CREDS });
		// Under the lock the row is stale, so a real exchange is attempted.
		mockTxFindUnique.mockResolvedValue({ credentials: EXPIRED_CREDS });
		mockFetch.mockResolvedValue(REJECTED_TOKEN_RESPONSE);
	});

	it("asks for a reconnect only when GitHub rejects the grant", async () => {
		vi.mocked(refreshOAuthToken).mockResolvedValueOnce({
			ok: false,
			errorCode: "bad_refresh_token",
			errorMessage: "The refresh token passed is incorrect or expired.",
		});

		await expect(
			executeGitHubTool("list_repositories", {}, "user-1"),
		).rejects.toThrow(/reconnect your GitHub account/);
	});

	it("reports a timed-out exchange as transient, not a dead connection", async () => {
		vi.mocked(refreshOAuthToken).mockResolvedValueOnce({
			ok: false,
			errorCode: "network_error",
			errorMessage: "The operation was aborted due to timeout",
		});

		const failure = executeGitHubTool("list_repositories", {}, "user-1");

		await expect(failure).rejects.toThrow(/try again shortly/);
		await expect(failure).rejects.not.toThrow(/reconnect/);
		expect(mockTxUpdate).not.toHaveBeenCalled();
	});

	it("reports a spent lock budget as transient, not a dead connection", async () => {
		mockAssertBudget.mockImplementationOnce(() => {
			throw new Error("REFRESH_LOCK_BUDGET_EXHAUSTED");
		});

		const failure = executeGitHubTool("list_repositories", {}, "user-1");

		await expect(failure).rejects.toThrow(/try again shortly/);
		await expect(failure).rejects.not.toThrow(/reconnect/);
		expect(refreshOAuthToken).not.toHaveBeenCalled();
	});

	it("surfaces an API error after a successful refresh as itself", async () => {
		mockFetch.mockResolvedValueOnce(REJECTED_TOKEN_RESPONSE);
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 404,
			json: async () => ({ message: "Not Found" }),
		});

		await expect(
			executeGitHubTool("list_repositories", {}, "user-1"),
		).rejects.toThrow("Not Found");
	});
});
