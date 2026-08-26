/**
 * Self-healing restore tests for the repo health check.
 *
 * A previously TOKEN_EXPIRED / ERROR integration whose credentials work again
 * (confirmed 200) must be restored to ACTIVE and log `repo_integration_restored`.
 * Already-ACTIVE rows must NOT re-log or change status.
 *
 * Run with: pnpm --filter @repo/temporal test repo-health-check-restore
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectRepositoryIntegrationUpdate = vi.fn();
const mockProjectRepositoryIntegrationFindUnique = vi.fn();
const mockSetIntegrationStatus = vi.fn();
const mockRestoreIntegrationActive = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockUserFindUnique = vi.fn();
const mockCreateRepoIntegrationCredentialNotification = vi.fn();
// The repo-access probe that now gates every restore; "accessible" keeps the
// historical restore expectations valid.
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

const mockGitlabRequest = vi.fn();
const mockGetValidGitLabAccessToken = vi.fn();
vi.mock("@repo/integrations/gitlab", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/gitlab")
	>("@repo/integrations/gitlab");
	return {
		...actual,
		gitlabRequest: (...a: unknown[]) => mockGitlabRequest(...a),
		getValidGitLabAccessToken: (...a: unknown[]) =>
			mockGetValidGitLabAccessToken(...a),
	};
});
vi.mock("@repo/integrations", () => ({
	refreshProjectRepoGitHubTokenWithOutcome: vi
		.fn()
		.mockResolvedValue({ token: null, platformFault: "INTERNAL" }),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (t: string) => `decrypted:${t}`,
}));
vi.mock("@repo/connectors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/connectors")>()),
	verifyRepositoryAccess: (...a: unknown[]) =>
		mockVerifyRepositoryAccess(...a),
}));

import {
	type CheckIntegrationHealthInput,
	checkRepoIntegrationHealth,
} from "../src/activities/repo-health-check";

function buildInput(
	overrides: Partial<CheckIntegrationHealthInput> = {},
): CheckIntegrationHealthInput {
	return {
		integrationId: "int-1",
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
		...overrides,
	};
}

const okResponse = () => ({
	ok: true,
	status: 200,
	headers: new Headers({
		"x-ratelimit-remaining": "100",
		"x-ratelimit-limit": "5000",
	}),
});

describe("repo health check — self-healing restore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUserFindUnique.mockResolvedValue({ name: "Test User" });
		mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
		mockVerifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
		mockSetIntegrationStatus.mockResolvedValue({
			status: "ACTIVE",
			previousStatus: "TOKEN_EXPIRED",
			statusChanged: true,
		});
		mockRestoreIntegrationActive.mockResolvedValue(true);
		mockProjectRepositoryIntegrationUpdate.mockResolvedValue({});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse()));
	});

	it("GitHub: TOKEN_EXPIRED + clean 200 restores ACTIVE and logs restored", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockRestoreIntegrationActive).toHaveBeenCalledWith("int-1");
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_restored",
			integrationId: "int-1",
		});
		expect(result).toMatchObject({
			healthy: true,
			statusChanged: true,
			newStatus: "ACTIVE",
		});
	});

	it("GitHub: already-ACTIVE + 200 does NOT restore or log", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockRestoreIntegrationActive).not.toHaveBeenCalled();
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ healthy: true, statusChanged: false });

		// A 200 from the probe validates the ACCESS token only. The refresh
		// token is a separate credential and can already be confirmed dead, so
		// this write must NOT clear `refreshTokenRejectedAt` — doing so hands a
		// known-dead grant back to the 30-minute refresh loop as soon as the
		// access token expires.
		const [call] = mockProjectRepositoryIntegrationUpdate.mock.calls[0];
		expect(call.data).not.toHaveProperty("refreshTokenRejectedAt");
	});

	it("GitLab: TOKEN_EXPIRED + 200 restores ACTIVE and logs restored", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockGitlabRequest.mockResolvedValueOnce({
			status: 200,
			body: { id: 1 },
			headers: new Headers(),
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({ provider: "GITLAB", integrationId: "int-gl" }),
		);

		expect(mockRestoreIntegrationActive).toHaveBeenCalledWith("int-gl");
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_restored",
		});
		expect(result).toMatchObject({
			healthy: true,
			statusChanged: true,
			newStatus: "ACTIVE",
		});
	});

	it("ADO: ERROR + 200 restores ACTIVE and logs restored", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ERROR",
			azureOrganization: "myorg",
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				integrationId: "int-ado",
				encryptedAccessToken: null,
				encryptedPat: "enc-pat",
			}),
		);

		expect(mockRestoreIntegrationActive).toHaveBeenCalledWith("int-ado");
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_restored",
		});
		expect(result).toMatchObject({
			healthy: true,
			statusChanged: true,
			newStatus: "ACTIVE",
		});
	});

	it("does NOT log a restore when the row was disconnected DURING the probe (conditional restore returns false)", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
		});
		mockRestoreIntegrationActive.mockResolvedValue(false); // concurrent disconnect

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockRestoreIntegrationActive).toHaveBeenCalledWith("int-1");
		expect(mockLogRepoIntegrationActivity).not.toHaveBeenCalled();
		expect(result).toMatchObject({ healthy: true, statusChanged: false });
	});

	it("does NOT resurrect a row disconnected before the probe (stale-token race)", async () => {
		// Row was disconnected (tokens wiped) between fetch and this check.
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "DISCONNECTED",
		});
		const probe = vi.fn();
		vi.stubGlobal("fetch", probe);

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(probe).not.toHaveBeenCalled(); // never probe with the stale token
		expect(mockRestoreIntegrationActive).not.toHaveBeenCalled(); // never restore
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(result).toMatchObject({ healthy: false, statusChanged: false });
	});
});
