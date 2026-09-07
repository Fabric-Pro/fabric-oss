/**
 * `POST /api/internal/code-search` used to call `hasProjectAccess` and then
 * re-fetch the same `Project` row a second time, re-selecting
 * `organizationId` alongside the repo fields it actually needs
 * (`repositoryUrl`/`repositoryOwner`/`repositoryName`/`defaultBranch`).
 * `getProjectAccessContext` now resolves the access decision and
 * `organizationId` in one query; the route still fetches the repo fields
 * separately (they aren't part of the access context), but no longer
 * re-selects `organizationId` there.
 *
 * These tests pin the three responses that must survive unchanged, in the
 * same order: 403 no access, 404 project not found (from the now-narrower
 * repo-info fetch), 403 tenant-XOR mismatch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "signed.ai.token";
const PROJECT_ID = "project-1";
const USER_ID = "user-1";
const ORG_ID = "org-1";

const verifyAIToken = vi.fn();
vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: (token: string) => verifyAIToken(token),
}));

const getProjectAccessContext = vi.fn();
const projectFindUnique = vi.fn();
const getProjectReposForCodeSearch = vi.fn();
const parseRepoUrl = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: (args: unknown) => projectFindUnique(args) },
		workflowIntegration: { findFirst: vi.fn() },
	},
	getProjectAccessContext: (projectId: string, userId: string) =>
		getProjectAccessContext(projectId, userId),
	getProjectReposForCodeSearch: (projectId: string) =>
		getProjectReposForCodeSearch(projectId),
	parseRepoUrl: (url: string) => parseRepoUrl(url),
}));

vi.mock("@repo/connectors", () => ({
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: vi.fn(),
	searchRepositoryCode: vi.fn(),
}));

vi.mock("@repo/integrations", () => ({
	getGitHubAccessToken: vi.fn(),
}));

vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(),
}));

function callRoute(
	handler: (req: Request) => Promise<Response>,
	body: unknown,
	token: string | null = TOKEN,
) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token) {
		headers.set("X-AI-Token", token);
	}
	return handler(
		new Request("https://example.test/api/internal/code-search", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
	);
}

describe("POST /api/internal/code-search", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		verifyAIToken.mockResolvedValue({
			valid: true,
			claims: { sub: USER_ID, org: ORG_ID },
		});
		getProjectAccessContext.mockResolvedValue({ organizationId: ORG_ID });
		projectFindUnique.mockResolvedValue({
			repositoryUrl: null,
			repositoryOwner: null,
			repositoryName: null,
			defaultBranch: null,
		});
		getProjectReposForCodeSearch.mockResolvedValue([]);
	});

	const body = { projectId: PROJECT_ID, action: "search", query: "foo" };

	it("403s a valid token for a user without access to the project", async () => {
		getProjectAccessContext.mockResolvedValue(null);
		const { POST } = await import(
			"../../../app/api/internal/code-search/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "You do not have access to this project",
		});
		expect(projectFindUnique).not.toHaveBeenCalled();
	});

	it("404s when the repo-info fetch finds the project gone", async () => {
		projectFindUnique.mockResolvedValue(null);
		const { POST } = await import(
			"../../../app/api/internal/code-search/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Project not found" });
	});

	it("403s a valid token whose org does not match the project's org (tenant mismatch)", async () => {
		getProjectAccessContext.mockResolvedValue({
			organizationId: "org-other",
		});
		const { POST } = await import(
			"../../../app/api/internal/code-search/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Tenant context mismatch",
		});
	});

	it("resolves access with a single call and never re-selects organizationId in the repo-info fetch", async () => {
		const { POST } = await import(
			"../../../app/api/internal/code-search/route"
		);

		await callRoute(POST, body);

		expect(getProjectAccessContext).toHaveBeenCalledTimes(1);
		expect(getProjectAccessContext).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
		);
		expect(projectFindUnique).toHaveBeenCalledTimes(1);
		const selectArg = projectFindUnique.mock.calls[0][0]?.select;
		expect(selectArg).not.toHaveProperty("organizationId");
		expect(selectArg).toEqual({
			repositoryUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
		});
	});
});
