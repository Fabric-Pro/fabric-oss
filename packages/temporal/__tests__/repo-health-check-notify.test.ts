/**
 * Credential-expiry notification tests for the repo health check.
 *
 * Verifies the transition-only dedupe contract added to repo-health-check.ts:
 * a project repository integration that FLIPS into the expired / auth-failed
 * state notifies the configuring user exactly once, while a subsequent
 * scheduled re-check of an already-expired row does NOT re-notify.
 *
 * The dedupe signal is the `statusChanged` / `previousStatus` pair returned by
 * `setIntegrationStatus` (mocked here). The GitLab 401 path is used as the
 * representative expiry path; the same `notifyCredentialExpiry` helper guards
 * every TOKEN_EXPIRED / auth-ERROR site in the activity.
 *
 * Run with: pnpm --filter @repo/temporal test repo-health-check-notify
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
const mockCreateRepoIntegrationCredentialNotification = vi.fn();

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
	createRepoIntegrationCredentialNotification: (...args: unknown[]) =>
		mockCreateRepoIntegrationCredentialNotification(...args),
}));

const mockGitlabRequest = vi.fn();
const mockGetValidGitLabAccessToken = vi.fn();

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

// The repo-access probe that now runs after a clean account-level probe; these
// tests exercise the expiry transitions, so the probe always answers healthy.
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

describe("repo health check — credential-expiry notification", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUserFindUnique.mockResolvedValue({ name: "Test User" });
		mockDecryptApiKey.mockImplementation(
			(token: string) => `decrypted:${token}`,
		);
		mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
		mockCreateRepoIntegrationCredentialNotification.mockResolvedValue(
			undefined,
		);
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		delete process.env.GITLAB_CLIENT_ID;
		delete process.env.GITLAB_CLIENT_SECRET;
	});

	it("notifies once when an ACTIVE integration transitions into TOKEN_EXPIRED", async () => {
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		// Prior status ACTIVE → setting TOKEN_EXPIRED is a genuine transition.
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.newStatus).toBe("TOKEN_EXPIRED");
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
		const args =
			mockCreateRepoIntegrationCredentialNotification.mock.calls[0][0];
		expect(args).toMatchObject({
			recipientUserId: "user-1",
			organizationId: "org-1",
			integrationId: "int-gitlab-1",
			projectId: "project-1",
			projectName: "Project One",
			provider: "GITLAB",
			repositoryOwner: "group",
			repositoryName: "repo",
			status: "TOKEN_EXPIRED",
			// Context-relative deep link to the project Settings tab.
			link: "projects/project-1?tab=settings",
		});
		// The activity-log row is still written alongside the notification.
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledTimes(1);
	});

	it("does NOT re-notify OR re-log on a repeated cycle for an already-expired row", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
		});
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "TOKEN_EXPIRED",
			statusChanged: false,
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.newStatus).toBe("TOKEN_EXPIRED");
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		// Status write still happens every cycle; log + notification are suppressed.
		expect(mockSetIntegrationStatus).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
	});

	it("skips the notification when configuredByUserId is null (no recipient)", async () => {
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});

		await checkRepoIntegrationHealth(
			buildInput({ configuredByUserId: null }),
		);

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
	});

	it("notifies on a fresh transition into the auth-failed ERROR state (undecryptable credentials)", async () => {
		// decrypt throws → activity sets ERROR with the reconnect message.
		mockDecryptApiKey.mockImplementationOnce(() => {
			throw new Error("crypto: bad key length");
		});
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "ERROR",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.newStatus).toBe("ERROR");
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
		expect(
			mockCreateRepoIntegrationCredentialNotification.mock.calls[0][0],
		).toMatchObject({ status: "ERROR", integrationId: "int-gitlab-1" });
	});

	it("never fails the health check when notification dispatch throws", async () => {
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
		});
		mockCreateRepoIntegrationCredentialNotification.mockRejectedValueOnce(
			new Error("db down"),
		);

		// Must resolve (not reject) with the normal expiry result.
		const result = await checkRepoIntegrationHealth(buildInput());
		expect(result).toEqual({
			integrationId: "int-gitlab-1",
			healthy: false,
			statusChanged: true,
			newStatus: "TOKEN_EXPIRED",
		});
	});
});

/**
 * Mid-cycle disconnect race.
 *
 * The row is ACTIVE when the cycle starts (`wasActive === true`), but the user
 * disconnects it DURING the probe. By the time the activity writes the failure
 * status, the disconnect-safe `setIntegrationStatus` (`updateMany WHERE status
 * != DISCONNECTED`) matches nothing and writes NOTHING — it returns
 * `statusChanged: false`. The activity must therefore suppress BOTH the
 * credential-expiry notification AND the audit log, and report
 * `statusChanged: false` — mirroring how the healthy path already gates on
 * `restoreIntegrationActive`'s boolean. Gating on the cycle-start `wasActive`
 * snapshot alone (the bug) fires a spurious "credentials expired" notification
 * for a connection the user just removed.
 */
describe("repo health check — mid-cycle disconnect race (write no-op suppresses side-effects)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUserFindUnique.mockResolvedValue({ name: "Test User" });
		mockDecryptApiKey.mockImplementation(
			(token: string) => `decrypted:${token}`,
		);
		mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
		mockCreateRepoIntegrationCredentialNotification.mockResolvedValue(
			undefined,
		);
		// ACTIVE at cycle start → wasActive === true.
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		delete process.env.GITLAB_CLIENT_ID;
		delete process.env.GITLAB_CLIENT_SECRET;
	});

	// The disconnect-safe write that found the row already DISCONNECTED.
	const noOpWrite = {
		status: "DISCONNECTED" as const,
		previousStatus: "DISCONNECTED" as const,
		statusChanged: false,
	};

	it("GitLab 401: disconnected mid-cycle → no notify, no log, statusChanged false", async () => {
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		mockSetIntegrationStatus.mockResolvedValueOnce(noOpWrite);

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result.statusChanged).toBe(false);
		expect(result.healthy).toBe(false);
	});

	it("GitHub missing access token: disconnected mid-cycle → no notify, no log, statusChanged false", async () => {
		mockSetIntegrationStatus.mockResolvedValueOnce(noOpWrite);

		const result = await checkRepoIntegrationHealth(
			buildInput({ provider: "GITHUB", encryptedAccessToken: null }),
		);

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result.statusChanged).toBe(false);
	});

	it("GitLab decrypt failure (ERROR path): disconnected mid-cycle → no notify, no log, statusChanged false", async () => {
		mockDecryptApiKey.mockImplementationOnce(() => {
			throw new Error("crypto: bad key length");
		});
		mockSetIntegrationStatus.mockResolvedValueOnce(noOpWrite);

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result.statusChanged).toBe(false);
	});

	it("GitLab 401: row deleted mid-cycle (previousStatus null) → no notify, no log, statusChanged false", async () => {
		mockGitlabRequest.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		// Deleted-row variant of the no-op write: setIntegrationStatus's internal
		// findUnique returned null, so previousStatus is null and the conditional
		// updateMany matched nothing. The gate must still suppress side-effects.
		mockSetIntegrationStatus.mockResolvedValueOnce({
			status: "TOKEN_EXPIRED",
			previousStatus: null,
			statusChanged: false,
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result.statusChanged).toBe(false);
	});
});
