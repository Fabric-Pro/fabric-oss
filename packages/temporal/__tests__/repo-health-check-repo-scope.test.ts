/**
 * Repo-scoped health-check coverage (Fizzy #2252).
 *
 * The scheduled sweep used to confirm only the credential (/user) — a token
 * with no access to the repository answered 200 forever, so an unreadable repo
 * wore Active while every read failed. These tests pin the second half: after
 * the account-level probe passes, the repository itself is probed and its
 * outcome decides the status.
 *
 * Run with: pnpm --filter @repo/temporal test repo-health-check-repo-scope
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectRepositoryIntegrationUpdate = vi.fn();
const mockProjectRepositoryIntegrationFindUnique = vi.fn();
const mockSetIntegrationStatus = vi.fn();
const mockRestoreIntegrationActive = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockUserFindUnique = vi.fn();
const mockCreateRepoIntegrationCredentialNotification = vi.fn();
// The repo-access probe under test — each scenario sets its outcome.
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
vi.mock("@repo/connectors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/connectors")>()),
	verifyRepositoryAccess: (...a: unknown[]) =>
		mockVerifyRepositoryAccess(...a),
}));

vi.mock("@repo/integrations", () => ({
	refreshProjectRepoGitHubTokenWithOutcome: vi
		.fn()
		.mockResolvedValue({ token: null }),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (t: string) => `decrypted:${t}`,
}));

import {
	type CheckIntegrationHealthInput,
	checkRepoIntegrationHealth,
} from "../src/activities/repo-health-check";

function buildInput(
	overrides: Partial<CheckIntegrationHealthInput> = {},
): CheckIntegrationHealthInput {
	return {
		integrationId: "int-gh",
		provider: "GITHUB",
		authMethod: "OAUTH",
		encryptedAccessToken: "enc-access",
		encryptedRefreshToken: null,
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

const okUserResponse = () => ({
	ok: true,
	status: 200,
	headers: new Headers({
		"x-ratelimit-remaining": "100",
		"x-ratelimit-limit": "5000",
	}),
});

describe("repo health check — repository-scoped verdict", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUserFindUnique.mockResolvedValue({ name: "Test User" });
		mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
		mockProjectRepositoryIntegrationUpdate.mockResolvedValue({});
		mockRestoreIntegrationActive.mockResolvedValue(true);
		mockCreateRepoIntegrationCredentialNotification.mockResolvedValue(
			undefined,
		);
		mockVerifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okUserResponse()));
	});

	it("probes the REPOSITORY (owner+repo), not just the account", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "accessible",
		});

		await checkRepoIntegrationHealth(buildInput());

		expect(mockVerifyRepositoryAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				owner: "owner",
				repo: "repo",
			}),
		);
	});

	it("/user 200 but repo unreadable (404) → REPO_UNAVAILABLE + one notification", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "not-found",
		});
		mockSetIntegrationStatus.mockResolvedValue({
			status: "REPO_UNAVAILABLE",
			previousStatus: "ACTIVE",
			statusChanged: true,
			written: true,
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"REPO_UNAVAILABLE",
			expect.stringContaining("not visible"),
			// Snapshot CAS pin (attachPat/reconnect race) — cycle-start updatedAt.
			undefined,
			expect.any(Date),
		);
		expect(
			mockCreateRepoIntegrationCredentialNotification,
		).toHaveBeenCalledTimes(1);
		expect(mockLogRepoIntegrationActivity.mock.calls[0][0]).toMatchObject({
			activityType: "repo_integration_unavailable",
		});
		expect(result).toMatchObject({
			healthy: false,
			newStatus: "REPO_UNAVAILABLE",
		});
	});

	it("/user 200 but app not installed (403) → REPO_UNAVAILABLE with grant wording", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "forbidden",
		});
		mockSetIntegrationStatus.mockResolvedValue({
			status: "REPO_UNAVAILABLE",
			previousStatus: "ACTIVE",
			statusChanged: true,
			written: true,
		});

		await checkRepoIntegrationHealth(buildInput());

		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"REPO_UNAVAILABLE",
			expect.stringContaining("refused this repository"),
			undefined,
			expect.any(Date),
		);
	});

	it("/user 200 but repo rejected the token (401) → TOKEN_EXPIRED, not REPO_UNAVAILABLE", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "unauthorized",
		});
		mockSetIntegrationStatus.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			previousStatus: "ACTIVE",
			statusChanged: true,
			written: true,
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.newStatus).toBe("TOKEN_EXPIRED");
		expect(result.newStatus).not.toBe("REPO_UNAVAILABLE");
	});

	it("probe inconclusive (network/5xx) → no transition, sweep stamped", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
		});
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "unreachable",
		});

		const result = await checkRepoIntegrationHealth(buildInput());

		expect(result.healthy).toBe(true);
		expect(result.statusChanged).toBe(false);
		expect(result.newStatus).toBeUndefined();
		expect(mockSetIntegrationStatus).not.toHaveBeenCalled();
		expect(mockProjectRepositoryIntegrationUpdate).toHaveBeenCalled();
	});

	it("an unreachable row whose repo becomes readable again restores ACTIVE", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "REPO_UNAVAILABLE",
		});

		const result = await checkRepoIntegrationHealth(buildInput());

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

	it("ADO: connectionData 200 but the repository refuses this PAT → REPO_UNAVAILABLE", async () => {
		// A scope-limited ADO PAT passes the account-level connectionData call
		// while every repository read 403s — exactly the account-vs-repo gap.
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "ACTIVE",
			azureOrganization: "example-org",
		});
		mockVerifyRepositoryAccess.mockResolvedValueOnce({
			outcome: "forbidden",
		});
		mockSetIntegrationStatus.mockResolvedValue({
			status: "REPO_UNAVAILABLE",
			previousStatus: "ACTIVE",
			statusChanged: true,
			written: true,
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				repositoryUrl:
					"https://dev.azure.com/example-org/Proj/_git/repo",
				encryptedAccessToken: null,
				encryptedPat: "enc-pat",
			}),
		);

		expect(mockVerifyRepositoryAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "AZURE_DEVOPS",
				azureOrganization: "example-org",
			}),
		);
		expect(mockSetIntegrationStatus).toHaveBeenCalledWith(
			"int-gh",
			"REPO_UNAVAILABLE",
			expect.stringContaining("refused this repository"),
			undefined,
			expect.any(Date),
		);
		expect(result.newStatus).toBe("REPO_UNAVAILABLE");
	});

	it("ADO: connectionData 200 and repository readable → restores/handles healthy", async () => {
		mockProjectRepositoryIntegrationFindUnique.mockResolvedValue({
			status: "TOKEN_EXPIRED",
			azureOrganization: "example-org",
		});

		const result = await checkRepoIntegrationHealth(
			buildInput({
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				repositoryUrl:
					"https://dev.azure.com/example-org/Proj/_git/repo",
				encryptedAccessToken: null,
				encryptedPat: "enc-pat",
			}),
		);

		expect(mockRestoreIntegrationActive).toHaveBeenCalledWith("int-gh");
		expect(result).toMatchObject({ healthy: true, newStatus: "ACTIVE" });
	});
});
