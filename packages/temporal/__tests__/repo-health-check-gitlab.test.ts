/**
 * GitLab health-check parity tests for ProjectRepositoryIntegration rows.
 *
 * Covers the dispatch branch added in repo-health-check.ts for
 * provider=GITLAB + authMethod=OAUTH:
 * - 200 OK from GET /user → healthy
 * - 401 from GitLab → TOKEN_EXPIRED (refresh handled lazily on next PM-sync use)
 * - 429 from GitLab → treated as healthy (rate-limit wall, not auth failure)
 *
 * Run with: pnpm --filter @repo/temporal test repo-health-check-gitlab
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------------
// Mocks (must be hoisted before the SUT import resolves the modules)
// ----------------------------------------------------------------------------

const mockProjectRepositoryIntegrationUpdate = vi.fn();
const mockProjectRepositoryIntegrationFindUnique = vi.fn();
const mockSetIntegrationStatus = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockGetActiveIntegrations = vi.fn();
const mockUserFindUnique = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			update: (...args: unknown[]) =>
				mockProjectRepositoryIntegrationUpdate(...args),
			findUnique: (...args: unknown[]) =>
				mockProjectRepositoryIntegrationFindUnique(...args),
		},
		user: {
			findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
		},
		project: {
			findUnique: vi.fn(),
		},
	},
	getActiveIntegrations: (...args: unknown[]) =>
		mockGetActiveIntegrations(...args),
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
	setIntegrationStatus: (...args: unknown[]) =>
		mockSetIntegrationStatus(...args),
	restoreIntegrationActive: vi.fn(),
	createRepoIntegrationCredentialNotification: vi.fn(),
}));

const mockGitlabRequest = vi.fn();
const mockGetValidGitLabAccessToken = vi.fn();

// Mock the GitLab rest-client subpath. We re-export the real GitLabApiError
// class so `instanceof` checks inside the SUT still succeed.
vi.mock("@repo/integrations/gitlab", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/gitlab")
	>("@repo/integrations/gitlab");
	return {
		...actual,
		gitlabRequest: (...args: unknown[]) => mockGitlabRequest(...args),
		getValidGitLabAccessToken: (...args: unknown[]) =>
			mockGetValidGitLabAccessToken(...args),
	};
});

vi.mock("@repo/integrations", () => ({
	refreshProjectRepoGitHubTokenWithOutcome: vi
		.fn()
		.mockResolvedValue({ token: null, platformFault: "INTERNAL" }),
}));

const mockDecryptApiKey = vi.fn((token: string) => `decrypted:${token}`);

vi.mock("@repo/utils", () => ({
	decryptApiKey: (token: string) => mockDecryptApiKey(token),
}));

// The repo-access probe that now runs after a clean /user; these tests pin the
// account-level transitions, so the repo probe always answers healthy.
vi.mock("@repo/connectors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/connectors")>()),
	verifyRepositoryAccess: vi
		.fn()
		.mockResolvedValue({ outcome: "accessible" }),
}));

// ----------------------------------------------------------------------------
// SUT
// ----------------------------------------------------------------------------

import { GitLabApiError } from "@repo/integrations/gitlab";
import {
	type CheckIntegrationHealthInput,
	checkRepoIntegrationHealth,
} from "../src/activities/repo-health-check";

function buildInput(
	overrides: Partial<CheckIntegrationHealthInput> = {},
): CheckIntegrationHealthInput {
	return {
		integrationId: "int-gitlab-1",
		provider: "GITLAB",
		authMethod: "OAUTH",
		encryptedAccessToken: "enc-access-token",
		encryptedRefreshToken: "enc-refresh-token",
		encryptedPat: null,
		tokenExpiresAt: null,
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		configuredByUserId: "user-1",
		projectId: "project-1",
		projectName: "Project One",
		organizationId: "org-1",
		repositoryOwner: "group",
		repositoryName: "repo",
		...overrides,
	};
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("checkRepoIntegrationHealth — GitLab", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUserFindUnique.mockResolvedValue({ name: "Test User" });
		mockDecryptApiKey.mockImplementation(
			(token: string) => `decrypted:${token}`,
		);
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
			azureOrganization: "test-org",
		});
		delete process.env.GITLAB_CLIENT_ID;
		delete process.env.GITLAB_CLIENT_SECRET;
	});

	it("returns healthy on 200 from GET /user", async () => {
		mockGitlabRequest.mockResolvedValueOnce({
			status: 200,
			body: { id: 42, username: "tester" },
			headers: new Headers(),
		});
		mockProjectRepositoryIntegrationUpdate.mockResolvedValueOnce({});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockGitlabRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/user",
				token: "decrypted:enc-access-token",
			}),
		);
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalledTimes(1);
		const updateCall =
			mockProjectRepositoryIntegrationUpdate.mock.calls[0][0];
		expect(updateCall.where).toEqual({ id: "int-gitlab-1" });
		expect(updateCall.data.lastError).toBeNull();
		expect(updateCall.data.lastHealthCheck).toBeInstanceOf(Date);

		expect(result).toEqual({
			integrationId: "int-gitlab-1",
			healthy: true,
			statusChanged: false,
		});
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
	});

	it("returns TOKEN_EXPIRED on 401", async () => {
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		// ACTIVE → TOKEN_EXPIRED: the disconnect-safe write lands (genuine transition).
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});
		mockLogRepoIntegrationActivity.mockResolvedValueOnce(undefined);

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gitlab-1",
			"TOKEN_EXPIRED",
			"GitLab API returned 401",
		);
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_token_expired",
			integrationId: "int-gitlab-1",
		});
		expect(mockProjectRepositoryIntegrationUpdate).not.toHaveBeenCalled();
		expect(result).toEqual({
			integrationId: "int-gitlab-1",
			healthy: false,
			statusChanged: true,
			newStatus: "TOKEN_EXPIRED",
		});
	});

	it("returns healthy on 429 (treat rate-limited as healthy)", async () => {
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(429, "Too Many Requests"),
		);
		mockProjectRepositoryIntegrationUpdate.mockResolvedValueOnce({});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalledTimes(1);
		const updateCall =
			mockProjectRepositoryIntegrationUpdate.mock.calls[0][0];
		expect(updateCall.where).toEqual({ id: "int-gitlab-1" });
		expect(updateCall.data.lastError).toBeNull();

		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(result).toEqual({
			integrationId: "int-gitlab-1",
			healthy: true,
			statusChanged: false,
		});
	});

	it("returns TOKEN_EXPIRED early when encryptedAccessToken is missing", async () => {
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});
		mockLogRepoIntegrationActivity.mockResolvedValueOnce(undefined);

		const result = await checkRepoIntegrationHealth(
			buildInput({ encryptedAccessToken: null }),
		);

		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gitlab-1",
			"TOKEN_EXPIRED",
			"No access token configured",
		);
		expect(mockGitlabRequest).not.toHaveBeenCalled();
		expect(mockProjectRepositoryIntegrationUpdate).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_token_expired",
			integrationId: "int-gitlab-1",
		});
		expect(result).toEqual({
			integrationId: "int-gitlab-1",
			healthy: false,
			statusChanged: true,
			newStatus: "TOKEN_EXPIRED",
		});
	});

	it("returns ERROR with friendly message when decryptApiKey throws", async () => {
		mockDecryptApiKey.mockImplementationOnce(() => {
			throw new Error("crypto: bad key length");
		});
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "ERROR",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});
		mockLogRepoIntegrationActivity.mockResolvedValueOnce(undefined);

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gitlab-1",
			"ERROR",
			"Stored GitLab credentials cannot be decrypted. Please reconnect your GitLab integration.",
		);
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_decrypt_failed",
			integrationId: "int-gitlab-1",
		});
		expect(mockGitlabRequest).not.toHaveBeenCalled();
		expect(mockProjectRepositoryIntegrationUpdate).not.toHaveBeenCalled();
		expect(result).toEqual({
			integrationId: "int-gitlab-1",
			healthy: false,
			statusChanged: true,
			newStatus: "ERROR",
		});
	});

	it("treats generic 5xx as inconclusive — no transition, sweep stamped (AC2)", async () => {
		// Deliberate behaviour change (Fizzy #2252 review): a GitLab-side 5xx
		// says nothing about the credential, so the old ERROR flip — which told
		// the user to reconnect during a provider incident — is replaced by
		// stamp-and-retry.
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(503, "Service Unavailable"),
		);
		mockProjectRepositoryIntegrationUpdate.mockResolvedValueOnce({});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "int-gitlab-1" },
				data: expect.objectContaining({
					lastHealthCheck: expect.any(Date),
				}),
			}),
		);
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
	});

	it("wires onRefreshToken when refresh token + env creds are present, and invokes getValidGitLabAccessToken", async () => {
		process.env.GITLAB_CLIENT_ID = "test-client-id";
		process.env.GITLAB_CLIENT_SECRET = "test-client-secret";

		// Not `Once`: the activity itself resolves a fresh token before probing
		// the repository (so the repo verdict uses the credential valid NOW),
		// and this test then invokes the callback manually to pin its wiring.
		mockGetValidGitLabAccessToken.mockResolvedValue(
			"refreshed-access-token",
		);
		mockGitlabRequest.mockResolvedValueOnce({
			status: 200,
			body: { id: 1 },
			headers: new Headers(),
		});
		mockProjectRepositoryIntegrationUpdate.mockResolvedValue({});

		await checkRepoIntegrationHealth(buildInput());

		expect(mockGitlabRequest).toHaveBeenCalledTimes(1);
		const callArgs = mockGitlabRequest.mock.calls[0][0];
		expect(callArgs).toMatchObject({
			path: "/user",
			token: "decrypted:enc-access-token",
		});
		expect(typeof callArgs.onRefreshToken).toBe("function");
		// One call from the activity's own pre-probe resolution…
		expect(mockGetValidGitLabAccessToken).toHaveBeenCalledTimes(1);

		// …and invoking the callback still wires through to
		// getValidGitLabAccessToken.
		const fresh = await callArgs.onRefreshToken();
		expect(fresh).toBe("refreshed-access-token");
		expect(mockGetValidGitLabAccessToken).toHaveBeenCalledTimes(2);
		expect(mockGetValidGitLabAccessToken).toHaveBeenCalledWith(
			expect.objectContaining({
				integrationId: "int-gitlab-1",
				clientId: "test-client-id",
				clientSecret: "test-client-secret",
				source: "project",
			}),
		);
		// Confirm `refresh` arg is the real refreshGitLabToken (passed-through fn)
		const passedArgs = mockGetValidGitLabAccessToken.mock.calls[0][0];
		expect(typeof passedArgs.refresh).toBe("function");
	});

	it("does NOT wire onRefreshToken when refresh token is missing", async () => {
		process.env.GITLAB_CLIENT_ID = "test-client-id";
		process.env.GITLAB_CLIENT_SECRET = "test-client-secret";

		mockGitlabRequest.mockResolvedValueOnce({
			status: 200,
			body: { id: 1 },
			headers: new Headers(),
		});
		mockProjectRepositoryIntegrationUpdate.mockResolvedValueOnce({});

		await checkRepoIntegrationHealth(
			buildInput({ encryptedRefreshToken: null }),
		);

		const callArgs = mockGitlabRequest.mock.calls[0][0];
		expect(callArgs.onRefreshToken).toBeUndefined();
	});
});
