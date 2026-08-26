/**
 * GitHub auto-refresh + re-probe tests for the scheduled health check.
 * Run with: pnpm --filter @repo/temporal test repo-health-check-github-refresh
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectRepositoryIntegrationUpdate = vi.fn();
const mockProjectRepositoryIntegrationFindUnique = vi.fn();
const mockSetIntegrationStatus = vi.fn();
const mockRestoreIntegrationActive = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockUserFindUnique = vi.fn();
const mockCreateRepoIntegrationCredentialNotification = vi.fn();
const mockRefreshGitHubTokenWithOutcome = vi.fn();
// The repo-access probe that now gates every "credential is alive" verdict.
const mockVerifyRepositoryAccess = vi
	.fn()
	.mockResolvedValue({ outcome: "accessible" });

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			update: (...a: unknown[]) =>
				mockProjectRepositoryIntegrationUpdate(...a),
			findUnique: (...a: unknown[]) =>
				mockProjectRepositoryIntegrationFindUnique(...a),
		},
		user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
		project: { findUnique: vi.fn() },
	},
	getActiveIntegrations: vi.fn(),
	logRepoIntegrationActivity: (...a: unknown[]) =>
		mockLogRepoIntegrationActivity(...a),
	setIntegrationStatus: (...a: unknown[]) => mockSetIntegrationStatus(...a),
	restoreIntegrationActive: (...a: unknown[]) =>
		mockRestoreIntegrationActive(...a),
	createRepoIntegrationCredentialNotification: (...a: unknown[]) =>
		mockCreateRepoIntegrationCredentialNotification(...a),
}));
vi.mock("@repo/integrations/gitlab", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/gitlab")
	>("@repo/integrations/gitlab");
	return {
		...actual,
		gitlabRequest: vi.fn(),
		getValidGitLabAccessToken: vi.fn(),
	};
});
vi.mock("@repo/integrations", () => ({
	refreshProjectRepoGitHubTokenWithOutcome: (...a: unknown[]) =>
		mockRefreshGitHubTokenWithOutcome(...a),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (t: string) => `decrypted:${t}`,
}));
vi.mock("@repo/connectors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/connectors")>()),
	verifyRepositoryAccess: (...a: unknown[]) =>
		mockVerifyRepositoryAccess(...a),
}));

import { checkRepoIntegrationHealth } from "../src/activities/repo-health-check";

const input = {
	integrationId: "int-gh",
	provider: "GITHUB",
	authMethod: "OAUTH",
	encryptedAccessToken: "enc-access",
	encryptedRefreshToken: "enc-refresh",
	encryptedPat: null,
	tokenExpiresAt: null,
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	configuredByUserId: "user-1",
	projectId: "project-1",
	projectName: "Project One",
	organizationId: "org-1",
	repositoryOwner: "owner",
	repositoryName: "repo",
} as const;

// First fetch = 401 (stale token); second fetch (re-probe) varies per test.
function fetchSequence(reprobeStatus: number) {
	const headers = new Headers({
		"x-ratelimit-remaining": "100",
		"x-ratelimit-limit": "5000",
	});
	return vi
		.fn()
		.mockResolvedValueOnce({ ok: false, status: 401, headers })
		.mockResolvedValueOnce({
			ok: reprobeStatus === 200,
			status: reprobeStatus,
			headers,
		});
}

describe("repo health check — GitHub auto-refresh", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUserFindUnique.mockResolvedValue({ name: "Test User" });
		mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
		mockProjectRepositoryIntegrationUpdate.mockResolvedValue({});
		mockRestoreIntegrationActive.mockResolvedValue(true);
		mockVerifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
		mockSetIntegrationStatus.mockResolvedValue({
			status: "ACTIVE",
			previousStatus: "TOKEN_EXPIRED",
			statusChanged: true,
		});
	});

	it("401 + refresh OK + re-probe 200 → restore ACTIVE + restored log", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: "new-token",
		});
		vi.stubGlobal("fetch", fetchSequence(200));

		const result = await checkRepoIntegrationHealth(input);

		expect(mockRefreshGitHubTokenWithOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				integrationId: "int-gh",
				encryptedRefreshToken: "enc-refresh",
			}),
		);
		expect(mockRestoreIntegrationActive).toHaveBeenCalledWith("int-gh");
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_restored",
		});
		expect(result).toMatchObject({
			healthy: true,
			statusChanged: true,
			newStatus: "ACTIVE",
		});
	});

	it("401 + refresh OK + re-probe 403, was TOKEN_EXPIRED → TOKEN_EXPIRED, no notify, no restore log", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: "new-token",
		});
		// Re-asserting TOKEN_EXPIRED on an already-expired row: write lands, no transition.
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "TOKEN_EXPIRED",
			statusChanged: false,
		});
		vi.stubGlobal("fetch", fetchSequence(403));

		const result = await checkRepoIntegrationHealth(input);

		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"TOKEN_EXPIRED",
			expect.stringContaining("after token refresh"),
		);
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			healthy: false,
			newStatus: "TOKEN_EXPIRED",
		});
	});

	it("401 + refresh OK + re-probe 403, was ACTIVE → TOKEN_EXPIRED + notify (AC-2 partial success)", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: "new-token",
		});
		// ACTIVE → TOKEN_EXPIRED: genuine transition, write lands.
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});
		vi.stubGlobal("fetch", fetchSequence(403));

		const result = await checkRepoIntegrationHealth(input);

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_token_expired",
		});
		expect(result).toMatchObject({
			healthy: false,
			newStatus: "TOKEN_EXPIRED",
		});
	});

	it("401 + refresh OK + re-probe 403 rate-limited (remaining 0) → no transition (not restore, not expiry)", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: "new-token",
		});
		const h100 = new Headers({
			"x-ratelimit-remaining": "100",
			"x-ratelimit-limit": "5000",
		});
		const h0 = new Headers({
			"x-ratelimit-remaining": "0",
			"x-ratelimit-limit": "5000",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 401,
					headers: h100,
				})
				.mockResolvedValueOnce({ ok: false, status: 403, headers: h0 }),
		);

		const result = await checkRepoIntegrationHealth(input);

		// Not a confirmed 200 → no restore; not an auth failure → no expiry.
		// Refresh's optimistic ACTIVE is reverted to the cycle-start status.
		expect(mockRestoreIntegrationActive).not.toHaveBeenCalled();
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"TOKEN_EXPIRED",
		);
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
		expect(result.newStatus).toBeUndefined();
	});

	it("401 + refresh OK + re-probe 403 rate-limited (remaining 0), was ACTIVE → lastHealthCheck touch only, no status change", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: "new-token",
		});
		const h100 = new Headers({
			"x-ratelimit-remaining": "100",
			"x-ratelimit-limit": "5000",
		});
		const h0 = new Headers({
			"x-ratelimit-remaining": "0",
			"x-ratelimit-limit": "5000",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 401,
					headers: h100,
				})
				.mockResolvedValueOnce({ ok: false, status: 403, headers: h0 }),
		);

		const result = await checkRepoIntegrationHealth(input);

		// Rate-limited re-probe on an already-ACTIVE row: no restore, no expiry transition.
		expect(mockRestoreIntegrationActive).not.toHaveBeenCalled();
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		// lastHealthCheck touch still fires.
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalled();
		// No transition → no notification and no activity log.
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
		expect(result.newStatus).toBeUndefined();
	});

	it("401 + refresh OK + re-probe 500 (transient) → no expiry, no notify, revert to originalStatus", async () => {
		// Row started TOKEN_EXPIRED (wasActive=false). After a successful refresh,
		// the re-probe hits a transient 500. This must NOT mark TOKEN_EXPIRED —
		// the credentials are valid. The optimistic ACTIVE written by the refresh
		// should be reverted to originalStatus ("TOKEN_EXPIRED"), no notification.
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: "new-token",
		});
		const headers = new Headers({
			"x-ratelimit-remaining": "100",
			"x-ratelimit-limit": "5000",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce({ ok: false, status: 401, headers })
				.mockResolvedValueOnce({ ok: false, status: 500, headers }),
		);

		const result = await checkRepoIntegrationHealth(input);

		// Must NOT expire: setIntegrationStatus must not be called with "TOKEN_EXPIRED" + expiry message
		expect(mockSetIntegrationStatus).not.toHaveBeenCalledWith(
			"int-gh",
			"TOKEN_EXPIRED",
			expect.stringContaining("after token refresh"),
		);
		// Must revert optimistic ACTIVE to originalStatus
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"TOKEN_EXPIRED",
		);
		// Must NOT notify or log token_expired
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalledWith(
			expect.objectContaining({
				activityType: "repo_integration_token_expired",
			}),
		);
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
		expect(result.newStatus).toBeUndefined();
	});

	it("401 + refresh OK + re-probe 500 (transient), was ACTIVE → lastHealthCheck touch only, no expiry", async () => {
		// Row started ACTIVE. After a successful refresh, re-probe hits 500.
		// Must NOT mark TOKEN_EXPIRED. Should just touch lastHealthCheck.
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: "new-token",
		});
		const headers = new Headers({
			"x-ratelimit-remaining": "100",
			"x-ratelimit-limit": "5000",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce({ ok: false, status: 401, headers })
				.mockResolvedValueOnce({ ok: false, status: 500, headers }),
		);

		const result = await checkRepoIntegrationHealth(input);

		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalled();
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalledWith(
			expect.objectContaining({
				activityType: "repo_integration_token_expired",
			}),
		);
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
		expect(result.newStatus).toBeUndefined();
	});

	it("401 + refresh fails with a platform fault → no status change, no notify", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: null,
			platformFault: "PROVIDER_UNAVAILABLE",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 401,
				headers: new Headers({
					"x-ratelimit-remaining": "100",
					"x-ratelimit-limit": "5000",
				}),
			}),
		);

		const result = await checkRepoIntegrationHealth(input);

		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
	});

	it("401 + refresh fails ambiguously (no fault, no rejection) → no status change, no notify", async () => {
		// A bare 4xx or an unrecognized RFC code blames neither side. Before,
		// absence of a platform fault was read as proof the customer's grant
		// was dead, so a corrupted deployment `client_id` would have told every
		// owner to reconnect a credential that was fine.
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: null,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 401,
				headers: new Headers({
					"x-ratelimit-remaining": "100",
					"x-ratelimit-limit": "5000",
				}),
			}),
		);

		const result = await checkRepoIntegrationHealth(input);

		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
	});

	// The bug this pair of tests pins: a refresh the provider declined because
	// the GRANT is dead used to be indistinguishable from a platform fault, so
	// the sweep deferred forever — re-probing and re-exchanging every 30
	// minutes, never flipping status, never telling the owner to reconnect.
	it("401 + refresh rejected by the provider (no platform fault), was ACTIVE → TOKEN_EXPIRED + notify", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: null,
			grantRejected: true,
			rejectedRefreshToken: "enc-refresh",
		});
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
			written: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 401,
				headers: new Headers({
					"x-ratelimit-remaining": "100",
					"x-ratelimit-limit": "5000",
				}),
			}),
		);

		const result = await checkRepoIntegrationHealth(input);

		// Fourth argument pins the write to the rejected credential — without it
		// this expiry could land on a credential a reconnect had just replaced.
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"TOKEN_EXPIRED",
			expect.stringContaining("rejected the stored refresh token"),
			"enc-refresh",
		);
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_token_expired",
		});
		expect(result).toMatchObject({
			healthy: false,
			statusChanged: true,
			newStatus: "TOKEN_EXPIRED",
		});
	});

	it("401 + rejection, but a reconnect landed before the status write → defers, no notify", async () => {
		// `grantRejected` was true when the refresh transaction committed; a
		// reconnect then replaced the credential. The pinned status write finds
		// no matching row, so the connection the user just repaired must not be
		// expired, and they must not be told to repair it again.
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: null,
			grantRejected: true,
			rejectedRefreshToken: "enc-refresh",
		});
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "ACTIVE",
			previousStatus: "ACTIVE",
			statusChanged: false,
			written: false,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 401,
				headers: new Headers({
					"x-ratelimit-remaining": "100",
					"x-ratelimit-limit": "5000",
				}),
			}),
		);

		const result = await checkRepoIntegrationHealth(input);

		// The pin is what makes the write miss — assert it was actually passed.
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"TOKEN_EXPIRED",
			expect.any(String),
			"enc-refresh",
		);
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
	});

	it("401 + refresh rejected by the provider, already TOKEN_EXPIRED → no repeat notification", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockRefreshGitHubTokenWithOutcome.mockResolvedValueOnce({
			token: null,
			grantRejected: true,
			rejectedRefreshToken: "enc-refresh",
		});
		// Re-asserting TOKEN_EXPIRED on an already-expired row: the write LANDS
		// (`written`) but is not a transition. That pair must not be mistaken
		// for the stale-evidence miss the test above covers.
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "TOKEN_EXPIRED",
			statusChanged: false,
			written: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 401,
				headers: new Headers({
					"x-ratelimit-remaining": "100",
					"x-ratelimit-limit": "5000",
				}),
			}),
		);

		const result = await checkRepoIntegrationHealth(input);

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			healthy: false,
			newStatus: "TOKEN_EXPIRED",
		});
	});
});
