/**
 * Connecting a REPOSITORY to a project through GitLab OAuth creates a project
 * repository link — a separate team grant. It must never write the person's
 * own GitLab connection: no WorkflowIntegration and no MCPConfig is created or
 * updated, and the repository's token is not borrowed for project management.
 *
 * Everything between the callback and the database is real here
 * (`handleProjectTargetCallback`, `enableGitLabPMForProject`, the persistence
 * module); only the database, GitLab's HTTP API and the person's (absent)
 * GitLab connection are doubles. Every write to a credential store is
 * recorded, so a path that still persists the repository grant as a personal
 * connection fails here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => [] as string[]);

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
	hashApiKey: (v: string) => `hash_${v}`,
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
}));

vi.mock("@repo/connectors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/connectors")>()),
	resolveDefaultBranch: vi.fn(async () => "main"),
	verifyRepositoryAccess: vi.fn(async () => ({ outcome: "accessible" })),
}));

vi.mock("../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn().mockResolvedValue(undefined),
}));

const gitlabFetch = vi.hoisted(() => vi.fn());
const getGitLabConnectionToken = vi.hoisted(() => vi.fn());
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	gitlabFetch,
	getGitLabConnectionToken,
	probeGitLabMcp: vi.fn(async () => ({
		status: "ok",
		capable: true,
		httpStatus: 200,
	})),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	const record = (name: string) =>
		vi.fn(async (args: { data?: unknown }) => {
			writes.push(name);
			return { id: `${name}-row`, ...(args?.data as object) };
		});
	const mockDb: Record<string, unknown> = {
		projectRepositoryIntegration: {
			findFirst: vi.fn(async () => null),
			findMany: vi.fn(async () => []),
			create: vi.fn(async () => ({ id: "pri_1" })),
			update: vi.fn(async () => ({ id: "pri_1" })),
			upsert: vi.fn(async () => ({ id: "pri_1" })),
		},
		workflowIntegration: {
			findFirst: vi.fn(async () => null),
			findUnique: vi.fn(async () => null),
			findMany: vi.fn(async () => []),
			create: record("workflowIntegration.create"),
			update: record("workflowIntegration.update"),
			updateMany: record("workflowIntegration.updateMany"),
			upsert: record("workflowIntegration.upsert"),
		},
		mCPConfig: {
			findFirst: vi.fn(async () => null),
			findUnique: vi.fn(async () => null),
			findMany: vi.fn(async () => []),
			create: record("mCPConfig.create"),
			update: record("mCPConfig.update"),
			updateMany: record("mCPConfig.updateMany"),
			upsert: record("mCPConfig.upsert"),
			delete: record("mCPConfig.delete"),
		},
		mCPServer: {
			findFirst: vi.fn(async () => ({ id: "srv_official" })),
			findUnique: vi.fn(async () => null),
		},
		project: {
			findUnique: vi.fn(async () => ({
				projectManagementMcpServerId: null,
				projectManagementMcpConfigId: null,
				projectManagementContainerId: null,
			})),
			update: vi.fn(async () => ({})),
		},
		dataConnection: { updateMany: vi.fn() },
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ locked: true }]),
	};
	mockDb.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(mockDb));
	return {
		...actual,
		db: mockDb,
		logRepoIntegrationActivity: vi.fn(),
		syncLegacyProjectRepoOnConnect: vi.fn(),
		createProjectRepoIntegration: vi.fn(),
		getProjectMemberRole: vi.fn().mockResolvedValue("admin"),
		getOrganizationMembership: vi.fn().mockResolvedValue({
			organization: { id: "org_1" },
			role: "admin",
		}),
	};
});

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", async () => {
	const { db } = await import("@repo/database");
	return {
		withRefreshLock: (
			_keys: unknown,
			fn: (tx: unknown, b: () => void) => unknown,
		) => fn(db, () => {}),
	};
});

vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveProjectPermissions: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../orpc/procedures", () => {
	const chain = {
		use: vi.fn().mockReturnThis(),
		route: vi.fn().mockReturnThis(),
		input: vi.fn().mockReturnThis(),
		output: vi.fn().mockReturnThis(),
		handler: vi.fn().mockReturnThis(),
	};
	return {
		tenantProtectedProcedure: chain,
		protectedProcedure: chain,
		requireOrganizationMembership: vi.fn(),
		resolveOrganizationIdForCaller: vi.fn(),
		requirePermission: vi
			.fn()
			.mockReturnValue({ use: vi.fn().mockReturnThis() }),
		requireInputOrgPermission: vi
			.fn()
			.mockReturnValue({ use: vi.fn().mockReturnThis() }),
		Permissions: {},
	};
});

const callbackArgs = {
	state: {
		userId: "u1",
		organizationId: "org_1",
		projectId: "proj_1",
		repositoryUrl: "https://gitlab.com/acme/widgets",
		repositoryOwner: "acme",
		repositoryName: "widgets",
		defaultBranch: "main",
		targetType: "project" as const,
	},
	tokenResponse: {
		access_token: "repo-token",
		refresh_token: "repo-refresh",
		expires_in: 7200,
		token_type: "Bearer",
		scope: "api",
		created_at: 1700000000,
	},
	gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
};

beforeEach(() => {
	writes.length = 0;
	gitlabFetch.mockReset();
	gitlabFetch.mockResolvedValue({
		id: 123,
		name: "widgets",
		path_with_namespace: "acme/widgets",
	});
	getGitLabConnectionToken.mockReset();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GitLab project-repository OAuth callback", () => {
	it("writes no personal connection and never borrows the repository token for PM (repo-only user)", async () => {
		getGitLabConnectionToken.mockResolvedValue({
			ok: false,
			reason: "not-connected",
			message: "GitLab is not connected",
		});
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);

		const result = await handleProjectTargetCallback(callbackArgs as never);

		expect(writes).toEqual([]);
		expect(result).toMatchObject({
			connectedStatus: "ACTIVE",
			personalConnectionRequiredForPm: true,
		});
		// GitLab was never asked anything with the repository's token.
		for (const [token] of gitlabFetch.mock.calls) {
			expect(token).not.toBe("repo-token");
		}
	});

	it("wires PM through the person's own connection when they have one, still writing no credential", async () => {
		getGitLabConnectionToken.mockResolvedValue({
			ok: true,
			accessToken: "personal-token",
			issuer: {
				kind: "app",
				clientId: "app-client",
				origin: "https://gitlab.com",
			},
			origin: "https://gitlab.com",
			integrationId: "wi_1",
			generation: 1,
			settings: {},
		});
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);

		const result = await handleProjectTargetCallback(callbackArgs as never);

		expect(result).toMatchObject({
			connectedStatus: "ACTIVE",
			personalConnectionRequiredForPm: false,
		});
		expect(gitlabFetch).toHaveBeenCalledWith(
			{ token: "personal-token", apiBase: "https://gitlab.com/api/v4" },
			"/projects/acme%2Fwidgets",
		);
		expect(writes).toEqual([]);
	});
});
