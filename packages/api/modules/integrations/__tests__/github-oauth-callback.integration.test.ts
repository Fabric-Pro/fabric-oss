import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
}));

const createProjectRepo = vi.fn().mockResolvedValue({ id: "pri_1" });
const updateProjectRepo = vi.fn().mockResolvedValue({ id: "pri_1" });

// The repo-access probe the callback consults before deciding what the row's
// status should be. Each test sets the outcome it simulates.
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
				upsert: vi.fn(),
				update: updateProjectRepo,
				create: createProjectRepo,
			},
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(null),
				create: vi.fn(),
				update: vi.fn(),
			},
			mCPConfig: { findMany: vi.fn().mockResolvedValue([]) },
			dataConnection: { updateMany: vi.fn() },
		},
		logRepoIntegrationActivity: vi.fn(),
		syncLegacyProjectRepoOnConnect: vi.fn(),
		createProjectRepoIntegration: createProjectRepo,
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

function projectState() {
	return {
		userId: "u1",
		organizationId: "org_1",
		projectId: "proj_1",
		repositoryUrl: "https://github.com/acme/widgets",
		repositoryOwner: "acme",
		repositoryName: "widgets",
		defaultBranch: "main",
		targetType: "project" as const,
	};
}

function tokenResponse() {
	return {
		access_token: "a-token",
		token_type: "bearer",
		scope: "repo,read:user",
		refresh_token: "r-token",
		expires_in: 28800,
	};
}

describe("GitHub OAuth callback — project target", () => {
	beforeEach(() => {
		createProjectRepo.mockClear();
		updateProjectRepo.mockClear();
		verifyRepositoryAccess.mockClear();
		verifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
	});

	it("writes an ACTIVE row when the fresh token can read the repository", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/github-oauth"
		);
		await handleProjectTargetCallback({
			state: projectState(),
			tokenResponse: tokenResponse(),
			githubUser: { id: 1, login: "u", name: "U", avatar_url: "" },
		});

		expect(verifyRepositoryAccess).toHaveBeenCalledTimes(1);
		expect(createProjectRepo).toHaveBeenCalledTimes(1);
		expect(createProjectRepo.mock.calls[0][0].status).toBe("ACTIVE");
		expect(createProjectRepo.mock.calls[0][0].lastError).toBeNull();
	});

	// Fizzy #2252 AC1. Before the probe existed this was the defect: the row was
	// written ACTIVE from the token exchange alone, while every later read of
	// the repository 404'd.
	it("does not write ACTIVE when the credential cannot see the repository (404)", async () => {
		verifyRepositoryAccess.mockResolvedValue({ outcome: "not-found" });
		const { handleProjectTargetCallback } = await import(
			"../procedures/github-oauth"
		);
		await handleProjectTargetCallback({
			state: projectState(),
			tokenResponse: tokenResponse(),
			githubUser: { id: 1, login: "u", name: "U", avatar_url: "" },
		});

		expect(createProjectRepo).toHaveBeenCalledTimes(1);
		const args = createProjectRepo.mock.calls[0][0];
		expect(args.status).toBe("REPO_UNAVAILABLE");
		expect(args.lastError).toMatch(/can(?:not|')t read|not visible/i);
	});

	it("maps authenticated-but-refused (403) to REPO_UNAVAILABLE with the install-app remedy", async () => {
		verifyRepositoryAccess.mockResolvedValue({ outcome: "forbidden" });
		const { handleProjectTargetCallback } = await import(
			"../procedures/github-oauth"
		);
		await handleProjectTargetCallback({
			state: projectState(),
			tokenResponse: tokenResponse(),
			githubUser: { id: 1, login: "u", name: "U", avatar_url: "" },
		});

		const args = createProjectRepo.mock.calls[0][0];
		expect(args.status).toBe("REPO_UNAVAILABLE");
		expect(args.lastError).toMatch(/app|install|grant/i);
	});

	it("keeps a rejected credential (401) on TOKEN_EXPIRED, not REPO_UNAVAILABLE", async () => {
		verifyRepositoryAccess.mockResolvedValue({ outcome: "unauthorized" });
		const { handleProjectTargetCallback } = await import(
			"../procedures/github-oauth"
		);
		await handleProjectTargetCallback({
			state: projectState(),
			tokenResponse: tokenResponse(),
			githubUser: { id: 1, login: "u", name: "U", avatar_url: "" },
		});

		const args = createProjectRepo.mock.calls[0][0];
		expect(args.status).toBe("TOKEN_EXPIRED");
		expect(args.status).not.toBe("REPO_UNAVAILABLE");
	});

	it("leaves the row ACTIVE when the probe is inconclusive (network/5xx)", async () => {
		verifyRepositoryAccess.mockResolvedValue("unreachable");
		const { handleProjectTargetCallback } = await import(
			"../procedures/github-oauth"
		);
		await handleProjectTargetCallback({
			state: projectState(),
			tokenResponse: tokenResponse(),
			githubUser: { id: 1, login: "u", name: "U", avatar_url: "" },
		});

		// Inconclusive ≠ cannot-read: the token exchange succeeded seconds
		// earlier, so today's behaviour stands and the sweep re-classifies.
		expect(createProjectRepo.mock.calls[0][0].status).toBe("ACTIVE");
	});

	it("reconnecting over a PAT-connected row converts it honestly to OAuth", async () => {
		const db = (await import("@repo/database")).db;
		vi.mocked(db.projectRepositoryIntegration.findFirst).mockResolvedValue({
			id: "pri_existing",
		} as never);

		const { handleProjectTargetCallback } = await import(
			"../procedures/github-oauth"
		);
		await handleProjectTargetCallback({
			state: projectState(),
			tokenResponse: tokenResponse(),
			githubUser: { id: 1, login: "u", name: "U", avatar_url: "" },
		});

		expect(updateProjectRepo).toHaveBeenCalledTimes(1);
		const data = updateProjectRepo.mock.calls[0][0].data;
		expect(data.authMethod).toBe("OAUTH");
		expect(data.encryptedPat).toBeNull();
		// Reconnect must hand the row a full retirement budget, not inherit
		// whatever count the previous credential accumulated.
		expect(data.probeFailCount).toBe(0);
	});
});
