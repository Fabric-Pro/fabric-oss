/**
 * `ensureFreshRepoCredentials` — on-demand GitHub OAuth refresh orchestration.
 *
 * Locks the contract: refresh attempted only for GITHUB+OAUTH rows with a
 * stored refresh token; near-expiry (60 s buffer) triggers proactively;
 * non-forced calls respect the 5-minute `lastHealthCheck` cooldown; `force`
 * bypasses it; a failed refresh on a dead token records TOKEN_EXPIRED exactly
 * once and — only on a genuine transition INTO the expired state — fires the
 * same credential-expiry notification the scheduled health check sends (the
 * request path must not consume the transition and swallow the notification
 * with it); concurrent callers share one attempt; and the helper never
 * throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockSetIntegrationStatus = vi.fn();
const mockCreateRepoIntegrationCredentialNotification = vi.fn();
const mockRefreshProjectRepoGitHubToken = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findUnique: (...args: unknown[]) => mockFindUnique(...args),
		},
	},
	setIntegrationStatus: (...args: unknown[]) =>
		mockSetIntegrationStatus(...args),
	createRepoIntegrationCredentialNotification: (...args: unknown[]) =>
		mockCreateRepoIntegrationCredentialNotification(...args),
}));

vi.mock("@repo/integrations", () => ({
	refreshProjectRepoGitHubToken: (...args: unknown[]) =>
		mockRefreshProjectRepoGitHubToken(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ensureFreshRepoCredentials } from "../credentials";

const MINUTE_MS = 60_000;

interface RowOverrides {
	provider?: string;
	authMethod?: string;
	status?: string;
	encryptedRefreshToken?: string | null;
	tokenExpiresAt?: Date | null;
	lastHealthCheck?: Date | null;
	updatedAt?: Date;
	configuredByUserId?: string | null;
}

/**
 * An expired GitHub OAuth row with a stored refresh token (the happy case).
 * Carries the notification-read fields too — the same `findUnique` mock also
 * serves the failure path's targeted notification lookup.
 */
function expiredGitHubRow(overrides: RowOverrides = {}) {
	return {
		provider: "GITHUB",
		authMethod: "OAUTH",
		status: "TOKEN_EXPIRED",
		encryptedRefreshToken: "enc:refresh",
		tokenExpiresAt: new Date(Date.now() - 60 * MINUTE_MS),
		lastHealthCheck: null,
		updatedAt: new Date("2026-06-01T00:00:00Z"),
		projectId: "p1",
		configuredByUserId: "user-config-1",
		repositoryOwner: "acme",
		repositoryName: "widgets",
		project: { name: "Project One", organizationId: "org-1" },
		...overrides,
	};
}

const baseInput = {
	integrationId: "int-1",
	userId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	mockSetIntegrationStatus.mockResolvedValue({
		status: "TOKEN_EXPIRED",
		previousStatus: "TOKEN_EXPIRED",
		statusChanged: false,
	});
});

describe("ensureFreshRepoCredentials — refreshability gate", () => {
	it("refreshes an expired GITHUB+OAUTH row with a stored refresh token", async () => {
		mockFindUnique.mockResolvedValue(expiredGitHubRow());
		mockRefreshProjectRepoGitHubToken.mockResolvedValue("fresh-token");

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).toHaveBeenCalledTimes(1);
		expect(mockRefreshProjectRepoGitHubToken).toHaveBeenCalledWith({
			integrationId: "int-1",
			encryptedRefreshToken: "enc:refresh",
			expectedUpdatedAt: new Date("2026-06-01T00:00:00Z"),
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(result).toEqual({ status: "ACTIVE", canAutoRefresh: true });
	});

	it("never attempts a refresh for GitLab OAuth (no refresh path)", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({ provider: "GITLAB" }),
		);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).not.toHaveBeenCalled();
		expect(result).toEqual({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: false,
		});
	});

	it("never attempts a refresh for Azure DevOps PAT", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				encryptedRefreshToken: null,
			}),
		);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).not.toHaveBeenCalled();
		expect(result.canAutoRefresh).toBe(false);
	});

	it("never attempts a refresh for GITHUB+OAUTH without a stored refresh token", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({ encryptedRefreshToken: null }),
		);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).not.toHaveBeenCalled();
		expect(result).toEqual({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: false,
		});
	});

	it("resolves DISCONNECTED/non-refreshable when the integration row is missing", async () => {
		mockFindUnique.mockResolvedValue(null);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).not.toHaveBeenCalled();
		expect(result).toEqual({
			status: "DISCONNECTED",
			canAutoRefresh: false,
		});
	});
});

describe("ensureFreshRepoCredentials — expiry windows", () => {
	it("short-circuits an ACTIVE row whose token is comfortably valid", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({
				status: "ACTIVE",
				tokenExpiresAt: new Date(Date.now() + 10 * MINUTE_MS),
			}),
		);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).not.toHaveBeenCalled();
		expect(result).toEqual({ status: "ACTIVE", canAutoRefresh: true });
	});

	it("refreshes proactively when an ACTIVE token is within the 60 s near-expiry buffer", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({
				status: "ACTIVE",
				tokenExpiresAt: new Date(Date.now() + 30_000),
			}),
		);
		mockRefreshProjectRepoGitHubToken.mockResolvedValue("fresh-token");

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("ACTIVE");
	});

	it("keeps an ACTIVE row usable when a proactive (near-expiry) refresh fails", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({
				status: "ACTIVE",
				tokenExpiresAt: new Date(Date.now() + 30_000),
			}),
		);
		mockRefreshProjectRepoGitHubToken.mockResolvedValue(null);

		const result = await ensureFreshRepoCredentials(baseInput);

		// Grace window: the stored token has not actually expired, so the row
		// must not be flipped to TOKEN_EXPIRED by a transient refresh failure.
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(result).toEqual({ status: "ACTIVE", canAutoRefresh: true });
	});
});

describe("ensureFreshRepoCredentials — cooldown", () => {
	it("skips a non-forced attempt when lastHealthCheck is within the last 5 minutes", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({
				lastHealthCheck: new Date(Date.now() - 2 * MINUTE_MS),
			}),
		);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).not.toHaveBeenCalled();
		expect(result).toEqual({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});
	});

	it("attempts again once lastHealthCheck is at least 5 minutes old", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({
				lastHealthCheck: new Date(Date.now() - 6 * MINUTE_MS),
			}),
		);
		mockRefreshProjectRepoGitHubToken.mockResolvedValue("fresh-token");

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockRefreshProjectRepoGitHubToken).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("ACTIVE");
	});

	it("force bypasses the cooldown (user-initiated retry)", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({
				lastHealthCheck: new Date(Date.now() - 1 * MINUTE_MS),
			}),
		);
		mockRefreshProjectRepoGitHubToken.mockResolvedValue("fresh-token");

		const result = await ensureFreshRepoCredentials({
			...baseInput,
			force: true,
		});

		expect(mockRefreshProjectRepoGitHubToken).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("ACTIVE");
	});
});

describe("ensureFreshRepoCredentials — failure recording + notification", () => {
	it("records TOKEN_EXPIRED exactly once on a dead-token failure", async () => {
		mockFindUnique.mockResolvedValue(expiredGitHubRow());
		mockRefreshProjectRepoGitHubToken.mockResolvedValue(null);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(mockSetIntegrationStatus).toHaveBeenCalledTimes(1);
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-1",
			"TOKEN_EXPIRED",
			expect.any(String),
		);
		expect(result).toEqual({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});
	});

	it("fires the credential-expiry notification once on a genuine transition into TOKEN_EXPIRED", async () => {
		mockFindUnique.mockResolvedValue(expiredGitHubRow({ status: "ERROR" }));
		mockRefreshProjectRepoGitHubToken.mockResolvedValue(null);
		// This failure consumed the transition — the scheduled health check
		// only notifies on transition, so the request path must notify here.
		mockSetIntegrationStatus.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});

		await ensureFreshRepoCredentials(baseInput);

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).toHaveBeenCalledWith({
			recipientUserId: "user-config-1",
			organizationId: "org-1",
			integrationId: "int-1",
			projectId: "p1",
			projectName: "Project One",
			provider: "GITHUB",
			repositoryOwner: "acme",
			repositoryName: "widgets",
			status: "TOKEN_EXPIRED",
			link: "projects/p1?tab=settings",
		});
	});

	it("does NOT notify when the row was already TOKEN_EXPIRED (no transition)", async () => {
		mockFindUnique.mockResolvedValue(expiredGitHubRow());
		mockRefreshProjectRepoGitHubToken.mockResolvedValue(null);
		mockSetIntegrationStatus.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			previousStatus: "TOKEN_EXPIRED",
			statusChanged: false,
		});

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(result.status).toBe("TOKEN_EXPIRED");
	});

	it("skips the notification when the configuring user was removed", async () => {
		mockFindUnique.mockResolvedValue(
			expiredGitHubRow({ status: "ERROR", configuredByUserId: null }),
		);
		mockRefreshProjectRepoGitHubToken.mockResolvedValue(null);
		mockSetIntegrationStatus.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(result.status).toBe("TOKEN_EXPIRED");
	});

	it("swallows a notification dispatch failure (best-effort)", async () => {
		mockFindUnique.mockResolvedValue(expiredGitHubRow({ status: "ERROR" }));
		mockRefreshProjectRepoGitHubToken.mockResolvedValue(null);
		mockSetIntegrationStatus.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});
		mockCreateRepoIntegrationCredentialNotification.mockRejectedValue(
			new Error("notification write failed"),
		);

		await expect(ensureFreshRepoCredentials(baseInput)).resolves.toEqual({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});
	});
});

describe("ensureFreshRepoCredentials — in-process lock", () => {
	it("shares a single refresh attempt across concurrent callers", async () => {
		mockFindUnique.mockResolvedValue(expiredGitHubRow());
		let releaseRefresh!: (token: string) => void;
		mockRefreshProjectRepoGitHubToken.mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					releaseRefresh = resolve;
				}),
		);

		const calls = [
			ensureFreshRepoCredentials(baseInput),
			ensureFreshRepoCredentials(baseInput),
			ensureFreshRepoCredentials(baseInput),
		];
		// Let all three callers reach the lock before the attempt resolves.
		await new Promise((resolve) => setImmediate(resolve));
		releaseRefresh("fresh-token");
		const results = await Promise.all(calls);

		expect(mockRefreshProjectRepoGitHubToken).toHaveBeenCalledTimes(1);
		for (const result of results) {
			expect(result).toEqual({ status: "ACTIVE", canAutoRefresh: true });
		}
	});
});

describe("ensureFreshRepoCredentials — never throws", () => {
	it("resolves (does not throw) when the integration read rejects", async () => {
		mockFindUnique.mockRejectedValue(new Error("db down"));

		await expect(ensureFreshRepoCredentials(baseInput)).resolves.toEqual({
			status: "ERROR",
			canAutoRefresh: false,
		});
	});

	it("resolves with the row state when the OAuth exchange itself throws", async () => {
		mockFindUnique.mockResolvedValue(expiredGitHubRow());
		mockRefreshProjectRepoGitHubToken.mockRejectedValue(
			new Error("github 500"),
		);

		const result = await ensureFreshRepoCredentials(baseInput);

		expect(result).toEqual({
			status: "TOKEN_EXPIRED",
			canAutoRefresh: true,
		});
	});
});
