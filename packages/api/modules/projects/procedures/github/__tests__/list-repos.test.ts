import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks
const mockGetGitHubWorkflowCredential = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockListUserRepositories = vi.fn();
const mockSearchGitHubRepositories = vi.fn();
const mockResolveFreshRepoTokenForRow = vi.fn();
const mockHasProjectAccess = vi.fn();
const mockRepoFindMany = vi.fn();
const mockGetMcpServerByKey = vi.fn();
const mockGetMcpConfigForTenantAndServer = vi.fn();

vi.mock("@repo/integrations/github", () => ({
	getGitHubWorkflowCredential: (...args: unknown[]) =>
		mockGetGitHubWorkflowCredential(...args),
	getAuthenticatedUser: (...args: unknown[]) =>
		mockGetAuthenticatedUser(...args),
	listUserRepositories: (...args: unknown[]) =>
		mockListUserRepositories(...args),
	searchGitHubRepositories: (...args: unknown[]) =>
		mockSearchGitHubRepositories(...args),
}));

vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: (...args: unknown[]) =>
		mockResolveFreshRepoTokenForRow(...args),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findMany: (...args: unknown[]) => mockRepoFindMany(...args),
		},
		mCPConfig: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
	},
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	getMcpServerByKey: (...args: unknown[]) => mockGetMcpServerByKey(...args),
	getMcpConfigForTenantAndServer: (...args: unknown[]) =>
		mockGetMcpConfigForTenantAndServer(...args),
}));

vi.mock("@repo/mcp", () => ({
	createMcpClientForConfig: vi.fn(),
	closeMcpClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		organizationId?: string | null;
		searchOrg?: string;
		projectId?: string;
	};
	context: {
		user: { id: string; name: string };
		session: { id: string };
	};
}) => Promise<{
	configured: boolean;
	source?: "oauth" | "pat" | "mcp";
	sourceIntegrationId?: string;
	groups: unknown[];
	error?: string | null;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../list-repos");
	return (mod.listGitHubReposProcedure as unknown as { handler: Handler })
		.handler;
}

describe("listGitHubReposProcedure", () => {
	const defaultContext = {
		user: { id: "user-1", name: "Test User" },
		session: { id: "sess-1" },
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetAuthenticatedUser.mockResolvedValue({ login: "octocat" });
		mockListUserRepositories.mockResolvedValue([
			{
				name: "repo-1",
				full_name: "octocat/repo-1",
				description: "Test repo",
				private: false,
				html_url: "https://github.com/octocat/repo-1",
				default_branch: "main",
				updated_at: new Date().toISOString(),
				stargazers_count: 10,
				fork: false,
				owner: { login: "octocat" },
			},
		]);
		mockSearchGitHubRepositories.mockResolvedValue([]);
		mockHasProjectAccess.mockResolvedValue(true);
		mockGetMcpServerByKey.mockResolvedValue(null);
	});

	it("prioritizes user workflow integration (OAuth) when present (Strategy 1)", async () => {
		mockGetGitHubWorkflowCredential.mockResolvedValue({
			kind: "oauth",
			token: "gho_oauth_token",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: defaultContext,
		});

		expect(result.configured).toBe(true);
		expect(result.source).toBe("oauth");
		expect(result.sourceIntegrationId).toBeUndefined();
		expect(mockGetGitHubWorkflowCredential).toHaveBeenCalledWith(
			"user-1",
			undefined,
		);
		// Project credentials should not be queried when workflow integration succeeds
		expect(mockRepoFindMany).not.toHaveBeenCalled();
	});

	it('reports source "pat" when the workflow credential is a personal token, not an App grant', async () => {
		mockGetGitHubWorkflowCredential.mockResolvedValue({
			kind: "pat",
			token: "ghp_personal_token",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: defaultContext,
		});

		expect(result.configured).toBe(true);
		// The credential that served the list decides how Add connects. Labelling a
		// personal PAT as "oauth" sends the caller through an App authorization
		// popup that stores a credential unable to read what was just listed.
		expect(result.source).toBe("pat");
		expect(result.sourceIntegrationId).toBeUndefined();
		expect(mockRepoFindMany).not.toHaveBeenCalled();
	});

	it("evaluates project-level shared credentials when workflow integration is absent (Strategy 2)", async () => {
		mockGetGitHubWorkflowCredential.mockResolvedValue(null);
		mockRepoFindMany.mockResolvedValue([
			{
				id: "int-pat-1",
				authMethod: "PAT",
				provider: "GITHUB",
				status: "ACTIVE",
				encryptedPat: "encrypted-pat",
				encryptedAccessToken: null,
			},
		]);
		mockResolveFreshRepoTokenForRow.mockResolvedValue({
			token: "ghp_fresh_token",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: defaultContext,
		});

		expect(result.configured).toBe(true);
		expect(result.source).toBe("pat");
		expect(result.sourceIntegrationId).toBe("int-pat-1");
		expect(mockRepoFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj-1",
				provider: "GITHUB",
				status: "ACTIVE",
				OR: [
					{ encryptedAccessToken: { not: null } },
					{ encryptedPat: { not: null } },
				],
			},
			orderBy: { createdAt: "desc" },
		});
	});

	it("sorts project OAuth candidates before PAT candidates and uses OAuth first", async () => {
		mockGetGitHubWorkflowCredential.mockResolvedValue(null);
		mockRepoFindMany.mockResolvedValue([
			{
				id: "int-pat-1",
				authMethod: "PAT",
				provider: "GITHUB",
				status: "ACTIVE",
				encryptedPat: "enc-pat",
			},
			{
				id: "int-oauth-1",
				authMethod: "OAUTH",
				provider: "GITHUB",
				status: "ACTIVE",
				encryptedAccessToken: "enc-oauth",
			},
		]);

		// First candidate evaluated should be the OAuth integration
		mockResolveFreshRepoTokenForRow.mockImplementation(async (row) => {
			if (row.id === "int-oauth-1") {
				return { token: "gho_project_oauth_token" };
			}
			return { token: "ghp_project_pat_token" };
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: defaultContext,
		});

		expect(result.configured).toBe(true);
		expect(result.source).toBe("oauth");
		expect(result.sourceIntegrationId).toBe("int-oauth-1");
	});

	it("falls through to next candidate if first candidate fails to resolve or fetch", async () => {
		mockGetGitHubWorkflowCredential.mockResolvedValue(null);
		mockRepoFindMany.mockResolvedValue([
			{
				id: "int-dead-1",
				authMethod: "PAT",
				provider: "GITHUB",
				status: "ACTIVE",
				encryptedPat: "enc-dead",
			},
			{
				id: "int-working-2",
				authMethod: "PAT",
				provider: "GITHUB",
				status: "ACTIVE",
				encryptedPat: "enc-good",
			},
		]);

		mockResolveFreshRepoTokenForRow.mockImplementation(async (row) => {
			if (row.id === "int-dead-1") {
				throw new Error("Bad credentials");
			}
			return { token: "ghp_working_token" };
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: defaultContext,
		});

		expect(result.configured).toBe(true);
		expect(result.source).toBe("pat");
		expect(result.sourceIntegrationId).toBe("int-working-2");
	});

	it("caps candidate evaluation at MAX_CANDIDATE_CREDENTIALS (5)", async () => {
		mockGetGitHubWorkflowCredential.mockResolvedValue(null);
		const candidates = Array.from({ length: 7 }, (_, i) => ({
			id: `int-${i + 1}`,
			authMethod: "PAT",
			provider: "GITHUB",
			status: "ACTIVE",
			encryptedPat: `enc-${i + 1}`,
		}));
		mockRepoFindMany.mockResolvedValue(candidates);

		// Fail all candidates to see how many get evaluated
		mockResolveFreshRepoTokenForRow.mockResolvedValue({ token: null });

		const handler = await loadHandler();
		await handler({
			input: { projectId: "proj-1" },
			context: defaultContext,
		});

		// Exactly 5 candidates should be evaluated before falling through
		expect(mockResolveFreshRepoTokenForRow).toHaveBeenCalledTimes(5);
	});

	it("falls through to Strategy 3 (MCP) when no tokens are configured", async () => {
		mockGetGitHubWorkflowCredential.mockResolvedValue(null);
		mockRepoFindMany.mockResolvedValue([]);

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "proj-1" },
			context: defaultContext,
		});

		expect(result.configured).toBe(false);
		expect(result.source).toBe("mcp");
		expect(result.sourceIntegrationId).toBeUndefined();
		expect(result.error).toContain("GitHub not connected");
	});
});
