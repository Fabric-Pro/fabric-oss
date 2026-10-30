/**
 * `POST /api/internal/code-search` reads the project's connected repository
 * with a credential an organization member connected, so project access alone
 * must not reach it: the caller needs `REPOSITORY_READ` on the project, the
 * permission the repository's native Git routes enforce.
 *
 * The permission helper runs for real over mocked rows, so these cases pin the
 * role tables and the project-authoritative precedence (an active
 * ProjectMember role decides; the organization role is only the fallback),
 * not a stubbed boolean. Every refusal also proves no credential was resolved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	token: vi.fn(),
	access: vi.fn(),
	projectFindUnique: vi.fn(),
	projectMemberFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	workflowIntegrationFindFirst: vi.fn(),
	repos: vi.fn(),
	freshToken: vi.fn(),
	githubToken: vi.fn(),
	search: vi.fn(),
	getFile: vi.fn(),
	listStructure: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: h.token,
}));
vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: h.projectFindUnique },
		projectMember: { findUnique: h.projectMemberFindUnique },
		member: { findFirst: h.memberFindFirst },
		workflowIntegration: { findFirst: h.workflowIntegrationFindFirst },
	},
	getProjectAccessContext: h.access,
	getProjectReposForCodeSearch: h.repos,
	parseRepoUrl: vi.fn(),
}));
// The real helper, so the role tables decide. `@repo/permissions` is not a
// dependency of the web app, so the permission is named by its value; a wrong
// value would refuse every Editor below.
vi.mock("@repo/api/orpc/procedures", async () => {
	const { userHasProjectPermission } = await vi.importActual<
		typeof import("@repo/api/orpc/middleware/require-permission")
	>("@repo/api/orpc/middleware/require-permission");
	return {
		userHasProjectPermission,
		Permissions: { REPOSITORY_READ: "repository:read" },
	};
});
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: h.search,
	getRepositoryFile: h.getFile,
	listRepositoryStructure: h.listStructure,
}));
vi.mock("@repo/integrations", () => ({
	getGitHubAccessToken: h.githubToken,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: h.freshToken,
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(),
}));

import { POST } from "../route";

const PROJECT_ID = "example-project";
const USER_ID = "example-user";
const ORG_ID = "example-org";

function request(body: Record<string, unknown> = {}) {
	return new Request("https://example.com/api/internal/code-search", {
		method: "POST",
		headers: { "X-AI-Token": "example-token" },
		body: JSON.stringify({
			projectId: PROJECT_ID,
			action: "search",
			query: "example",
			...body,
		}),
	});
}

function projectRole(role: string, expiresAt: Date | null = null) {
	return { role, acceptedAt: new Date("2026-01-01"), expiresAt };
}

function expectNoCredentialResolved() {
	expect(h.repos).not.toHaveBeenCalled();
	expect(h.freshToken).not.toHaveBeenCalled();
	expect(h.githubToken).not.toHaveBeenCalled();
	expect(h.workflowIntegrationFindFirst).not.toHaveBeenCalled();
	expect(h.search).not.toHaveBeenCalled();
	expect(h.getFile).not.toHaveBeenCalled();
	expect(h.listStructure).not.toHaveBeenCalled();
}

async function expectRepositoryReadRefused(response: Response) {
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({
		code: "REPOSITORY_READ_REQUIRED",
	});
	expectNoCredentialResolved();
}

describe("POST /api/internal/code-search", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		h.token.mockResolvedValue({
			valid: true,
			claims: { sub: USER_ID, org: ORG_ID },
		});
		h.access.mockResolvedValue({ organizationId: ORG_ID });
		// Serves both reads of the row: the route's repository fields and the
		// permission helper's ownership fields.
		h.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			userId: "example-creator",
			organizationId: ORG_ID,
			repositoryUrl: "https://github.com/example-org/example-repo",
			repositoryOwner: "example-org",
			repositoryName: "example-repo",
			defaultBranch: "main",
		});
		h.memberFindFirst.mockResolvedValue({ role: "member" });
		h.projectMemberFindUnique.mockResolvedValue(projectRole("EDITOR"));
		h.repos.mockResolvedValue([
			{
				provider: "GITHUB",
				owner: "example-org",
				repo: "example-repo",
				branch: "main",
				repositoryUrl: "https://github.com/example-org/example-repo",
				azureOrganization: null,
			},
		]);
		h.freshToken.mockResolvedValue({
			token: "example-repo-token",
			stale: false,
		});
		h.search.mockResolvedValue({ results: [] });
		h.getFile.mockResolvedValue({ path: "README.md", content: "" });
		h.listStructure.mockResolvedValue({
			entries: [],
			totalFiles: 0,
			totalDirectories: 0,
		});
	});

	describe("allows a caller whose role grants repository read", () => {
		it("an Editor member, even when the organization role alone would not", async () => {
			h.memberFindFirst.mockResolvedValue({ role: "viewer" });

			const response = await POST(request());

			expect(response.status).toBe(200);
			expect(h.freshToken).toHaveBeenCalledTimes(1);
			expect(h.search).toHaveBeenCalledWith(
				expect.objectContaining({ token: "example-repo-token" }),
			);
		});

		it("a project guest with the Editor role", async () => {
			h.memberFindFirst.mockResolvedValue(null);

			const response = await POST(request());

			expect(response.status).toBe(200);
			expect(h.freshToken).toHaveBeenCalledTimes(1);
		});

		it("an organization member with no project role, through the organization role", async () => {
			h.projectMemberFindUnique.mockResolvedValue(null);

			const response = await POST(request());

			expect(response.status).toBe(200);
			expect(h.freshToken).toHaveBeenCalledTimes(1);
		});
	});

	describe("refuses a caller whose role does not grant repository read", () => {
		it("a Viewer member, though the organization role would grant it", async () => {
			h.projectMemberFindUnique.mockResolvedValue(projectRole("VIEWER"));

			await expectRepositoryReadRefused(await POST(request()));
		});

		it("a Commenter member", async () => {
			h.projectMemberFindUnique.mockResolvedValue(
				projectRole("COMMENTER"),
			);

			await expectRepositoryReadRefused(await POST(request()));
		});

		it("a project guest with the Viewer role", async () => {
			h.memberFindFirst.mockResolvedValue(null);
			h.projectMemberFindUnique.mockResolvedValue(projectRole("VIEWER"));

			await expectRepositoryReadRefused(await POST(request()));
		});

		it("a project guest with the Commenter role", async () => {
			h.memberFindFirst.mockResolvedValue(null);
			h.projectMemberFindUnique.mockResolvedValue(
				projectRole("COMMENTER"),
			);

			await expectRepositoryReadRefused(await POST(request()));
		});

		it("a project guest whose Editor role has expired", async () => {
			h.memberFindFirst.mockResolvedValue(null);
			h.projectMemberFindUnique.mockResolvedValue(
				projectRole("EDITOR", new Date("2026-02-01")),
			);

			await expectRepositoryReadRefused(await POST(request()));
		});

		it("an organization viewer with no project role", async () => {
			h.memberFindFirst.mockResolvedValue({ role: "viewer" });
			h.projectMemberFindUnique.mockResolvedValue(null);

			await expectRepositoryReadRefused(await POST(request()));
		});

		it.each([
			["get-file", { path: "README.md" }],
			["list-structure", {}],
		])("on the %s action too", async (action, params) => {
			h.projectMemberFindUnique.mockResolvedValue(projectRole("VIEWER"));

			await expectRepositoryReadRefused(
				await POST(request({ action, ...params })),
			);
		});

		it("checks the token's user, not one named in the body, and logs ids only", async () => {
			h.projectMemberFindUnique.mockResolvedValue(projectRole("VIEWER"));

			await expectRepositoryReadRefused(
				await POST(request({ userId: "impersonated-user" })),
			);
			expect(h.projectMemberFindUnique).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						projectId_userId: {
							projectId: PROJECT_ID,
							userId: USER_ID,
						},
					},
				}),
			);
			expect(console.warn).toHaveBeenCalledWith(
				"[Internal Code Search] Repository read refused",
				{ projectId: PROJECT_ID, userId: USER_ID },
			);
		});
	});

	describe("earlier refusals are unchanged", () => {
		it("403s a caller with no access to the project", async () => {
			h.access.mockResolvedValue(null);

			const response = await POST(request());

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: "You do not have access to this project",
			});
			expect(h.projectMemberFindUnique).not.toHaveBeenCalled();
			expectNoCredentialResolved();
		});

		it("404s when the project is gone", async () => {
			h.projectFindUnique.mockResolvedValue(null);

			const response = await POST(request());

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: "Project not found",
			});
			expectNoCredentialResolved();
		});

		it("403s a token whose organization is not the project's", async () => {
			h.access.mockResolvedValue({ organizationId: "other-org" });

			const response = await POST(request());

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: "Tenant context mismatch",
			});
			expect(h.projectMemberFindUnique).not.toHaveBeenCalled();
			expectNoCredentialResolved();
		});
	});
});
