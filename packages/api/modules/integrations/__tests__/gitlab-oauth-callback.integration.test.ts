import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
}));

const upsertProjectRepo = vi.fn().mockResolvedValue({ id: "pri_1" });
const createWorkflowIntegration = vi.fn();
const enableGitLabPM = vi
	.fn()
	.mockResolvedValue({ pmWired: true, containerId: "123" });

// The repo-access probe the callback consults before deciding the row's
// status. Default "accessible" keeps the historical expectations valid.
const verifyRepositoryAccess = vi
	.fn()
	.mockResolvedValue({ outcome: "accessible" });

vi.mock("@repo/connectors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/connectors")>()),
	resolveDefaultBranch: vi
		.fn()
		.mockImplementation(
			async (input: { providedBranch?: string | null }) =>
				input.providedBranch ? input.providedBranch : "main",
		),
	verifyRepositoryAccess,
}));

vi.mock("../lib/enable-gitlab-pm-for-project", () => ({
	enableGitLabPMForProject: enableGitLabPM,
}));

// `handleProjectTargetCallback` awaits this, and it was UNMOCKED — so the test
// reached the real code-indexing trigger and did network I/O. That made the test
// take tens of seconds, and work still in flight when a test finished landed on
// the shared mocks during the NEXT test, inflating their call counts. Mocking it
// is what makes this file deterministic.
vi.mock("../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			projectRepositoryIntegration: {
				findFirst: vi.fn().mockResolvedValue(null),
				upsert: upsertProjectRepo,
				update: vi.fn(),
				create: vi.fn(),
			},
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(null),
				create: createWorkflowIntegration,
				update: vi.fn(),
			},
			mCPConfig: { findMany: vi.fn().mockResolvedValue([]) },
			dataConnection: { updateMany: vi.fn() },
		},
		logRepoIntegrationActivity: vi.fn(),
		syncLegacyProjectRepoOnConnect: vi.fn(),
		createProjectRepoIntegration: vi.fn(),
		getProjectMemberRole: vi.fn().mockResolvedValue("admin"),
	};
});

vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveProjectPermissions: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../orpc/procedures", () => ({
	tenantProtectedProcedure: {
		use: vi.fn().mockReturnThis(),
		route: vi.fn().mockReturnThis(),
		input: vi.fn().mockReturnThis(),
		output: vi.fn().mockReturnThis(),
		handler: vi.fn().mockReturnThis(),
	},
	publicProcedure: {
		use: vi.fn().mockReturnThis(),
		route: vi.fn().mockReturnThis(),
		input: vi.fn().mockReturnThis(),
		output: vi.fn().mockReturnThis(),
		handler: vi.fn().mockReturnThis(),
	},
	requirePermission: vi
		.fn()
		.mockReturnValue({ use: vi.fn().mockReturnThis() }),
	requireInputOrgPermission: vi
		.fn()
		.mockReturnValue({ use: vi.fn().mockReturnThis() }),
	Permissions: {},
}));

describe("GitLab OAuth callback — project target", () => {
	// The mocks below are module-level and were never reset, so call counts only
	// ever accumulated across tests. Any leakage read as "called twice" on an
	// assertion that expected one call.
	beforeEach(() => {
		upsertProjectRepo.mockClear();
		createWorkflowIntegration.mockClear();
		enableGitLabPM.mockClear();
		verifyRepositoryAccess.mockClear();
		verifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
	});

	it("writes encrypted token to ProjectRepositoryIntegration when targetType=project", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				refresh_token: "r-token",
				expires_in: 7200,
				token_type: "Bearer",
				scope: "api",
				created_at: 1700000000,
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(upsertProjectRepo).toHaveBeenCalledTimes(1);
		const args = upsertProjectRepo.mock.calls[0][0];
		expect(args.create.provider).toBe("GITLAB");
		expect(args.create.authMethod).toBe("OAUTH");
		expect(args.create.encryptedAccessToken).toBe("enc_a-token");
		expect(args.create.status).toBe("ACTIVE");
		expect(args.create.lastError).toBeNull();
		// Reconnect must hand the row a full retirement budget, not inherit
		// whatever count the previous credential accumulated.
		expect(args.create.probeFailCount).toBe(0);
	});

	// GitLab parity with the GitHub callback (Fizzy #2252 AC1): without these
	// pins, deleting the GitLab probe would pass CI.
	it("rejects a non-gitlab.com stored URL before any write or fetch (SSRF pin)", async () => {
		verifyRepositoryAccess.mockClear();
		upsertProjectRepo.mockClear();
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await expect(
			handleProjectTargetCallback({
				state: {
					userId: "u1",
					organizationId: "org_1",
					projectId: "proj_1",
					repositoryUrl:
						"https://internal-host.attacker.tld/acme/widgets",
					repositoryOwner: "acme",
					repositoryName: "widgets",
					defaultBranch: "main",
					targetType: "project",
				},
				tokenResponse: {
					access_token: "a-token",
					token_type: "Bearer",
					scope: "api",
				},
				gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("Only gitlab.com"),
		});
		expect(verifyRepositoryAccess).not.toHaveBeenCalled();
		expect(upsertProjectRepo).not.toHaveBeenCalled();
	});

	it("writes REPO_UNAVAILABLE when the credential cannot see the repository (404)", async () => {
		verifyRepositoryAccess.mockResolvedValue({ outcome: "not-found" });
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		const args = upsertProjectRepo.mock.calls[0][0];
		expect(args.create.status).toBe("REPO_UNAVAILABLE");
		expect(args.create.lastError).toMatch(/not visible/i);
	});

	it("keeps a rejected GitLab credential (401) on TOKEN_EXPIRED", async () => {
		verifyRepositoryAccess.mockResolvedValue({ outcome: "unauthorized" });
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		const args = upsertProjectRepo.mock.calls[0][0];
		expect(args.create.status).toBe("TOKEN_EXPIRED");
	});

	it("auto-wires GitLab as the project's PM tool from the same token", async () => {
		enableGitLabPM.mockClear();
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				refresh_token: "r-token",
				expires_in: 7200,
				token_type: "Bearer",
				scope: "api",
				created_at: 1700000000,
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(enableGitLabPM).toHaveBeenCalledTimes(1);
		const pmArgs = enableGitLabPM.mock.calls[0][0];
		expect(pmArgs.userId).toBe("u1");
		expect(pmArgs.organizationId).toBe("org_1");
		expect(pmArgs.projectId).toBe("proj_1");
		expect(pmArgs.repositoryOwner).toBe("acme");
		expect(pmArgs.repositoryName).toBe("widgets");
		expect(pmArgs.token.accessToken).toBe("a-token");
	});

	it("does not fail the repo connect when PM auto-wire throws", async () => {
		enableGitLabPM.mockRejectedValueOnce(new Error("probe failed"));
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await expect(
			handleProjectTargetCallback({
				state: {
					userId: "u1",
					organizationId: "org_1",
					projectId: "proj_1",
					repositoryUrl: "https://gitlab.com/acme/widgets",
					repositoryOwner: "acme",
					repositoryName: "widgets",
					defaultBranch: "main",
					targetType: "project",
				},
				tokenResponse: {
					access_token: "a-token",
					refresh_token: "r-token",
					expires_in: 7200,
					token_type: "Bearer",
					scope: "api",
					created_at: 1700000000,
				},
				gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
			}),
		).resolves.toMatchObject({ connectedStatus: "ACTIVE" });
	});

	it("persists roleTag from OAuth state to ProjectRepositoryIntegration", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/legacy-widgets",
				repositoryOwner: "acme",
				repositoryName: "legacy-widgets",
				defaultBranch: "main",
				roleTag: "Legacy V1",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(upsertProjectRepo).toHaveBeenCalledTimes(1);
		const args = upsertProjectRepo.mock.calls[0][0];
		expect(args.create.roleTag).toBe("Legacy V1");
	});
});
