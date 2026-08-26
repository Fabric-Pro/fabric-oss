import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Mocks (hoisted to avoid reference errors)
// ============================================================================

const { mockFindFirst, mockFindUnique, mockUpdate, mockFetch } = vi.hoisted(
	() => ({
		mockFindFirst: vi.fn(),
		mockUpdate: vi.fn(),
		mockFetch: vi.fn(),
		mockFindUnique: vi.fn(),
	}),
);

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (_key: string, fn: (tx: unknown) => unknown) =>
		fn({
			workflowIntegration: {
				findUnique: mockFindUnique,
				update: mockUpdate,
			},
		}),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: mockFindFirst,
			findUnique: mockFindUnique,
			update: mockUpdate,
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((val: string) => val),
	encryptApiKey: vi.fn((val: string) => `encrypted-${val}`),
}));

vi.stubGlobal("fetch", mockFetch);

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
	executeGitLabTool,
	GitLabApiError,
	getGitLabAccessToken,
	listUserProjects,
	parseGitLabProjectUrl,
	searchGitLabProjects,
} from "../../src/gitlab/index";

// ============================================================================
// Helpers
// ============================================================================

const CREDS_JSON = JSON.stringify({
	access_token: "test-token",
	refresh_token: "test-refresh",
	expires_in: 7200,
	token_obtained_at: new Date(Date.now() + 3600000).toISOString(), // future = not expired
});

function mockIntegration(overrides?: Record<string, unknown>) {
	return {
		id: "int-1",
		credentials: CREDS_JSON,
		settings: {},
		...overrides,
	};
}

function mockFetchOk(data: unknown) {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		json: async () => data,
	});
}

function mockFetch401() {
	mockFetch.mockResolvedValueOnce({
		ok: false,
		status: 401,
		json: async () => ({ message: "401 Unauthorized" }),
	});
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
	mockFindFirst.mockReset();
	mockUpdate.mockReset();
	mockFetch.mockReset();
	vi.stubEnv("GITLAB_CLIENT_ID", "test-client-id");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "test-client-secret");
});

describe("parseGitLabProjectUrl", () => {
	it("parses HTTPS URL", () => {
		const result = parseGitLabProjectUrl(
			"https://gitlab.com/mygroup/myproject",
		);
		expect(result).toEqual({ projectPath: "mygroup/myproject" });
	});

	it("parses SSH URL", () => {
		const result = parseGitLabProjectUrl(
			"git@gitlab.com:mygroup/myproject.git",
		);
		expect(result).toEqual({ projectPath: "mygroup/myproject" });
	});

	it("parses nested group URL", () => {
		const result = parseGitLabProjectUrl(
			"https://gitlab.com/org/sub/project",
		);
		expect(result).toEqual({ projectPath: "org/sub/project" });
	});

	it("strips .git suffix", () => {
		const result = parseGitLabProjectUrl(
			"https://gitlab.com/org/project.git",
		);
		expect(result).toEqual({ projectPath: "org/project" });
	});

	it("returns null for non-GitLab URL", () => {
		expect(
			parseGitLabProjectUrl("https://github.com/owner/repo"),
		).toBeNull();
	});

	it("returns null for URL without project path", () => {
		expect(parseGitLabProjectUrl("https://gitlab.com/onlyone")).toBeNull();
	});
});

describe("executeGitLabTool", () => {
	it("throws for unknown method", async () => {
		await expect(
			executeGitLabTool("unknown_method", {}, "user-1"),
		).rejects.toThrow("Unknown GitLab tool: unknown_method");
	});

	it("uses projectAccessToken directly, skips DB", async () => {
		mockFetchOk([]);

		await executeGitLabTool(
			"list_projects",
			{},
			"user-1",
			undefined,
			"direct-token",
		);

		expect(mockFindFirst).not.toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalled();
		const url = mockFetch.mock.calls[0][0] as string;
		expect(url).toContain("/projects");
	});

	it("queries DB with org context", async () => {
		mockFindFirst.mockResolvedValueOnce(mockIntegration());
		mockFetchOk([]);

		await executeGitLabTool("list_projects", {}, "user-1", "org-1");

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
					provider: "GITLAB",
					isActive: true,
				}),
			}),
		);
	});

	it("queries DB with personal context (null org)", async () => {
		mockFindFirst.mockResolvedValueOnce(mockIntegration());
		mockFetchOk([]);

		await executeGitLabTool("list_projects", {}, "user-1");

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					organizationId: null,
					provider: "GITLAB",
				}),
			}),
		);
	});

	it("throws when no integration found", async () => {
		mockFindFirst.mockResolvedValueOnce(null);

		await expect(
			executeGitLabTool("list_projects", {}, "user-1"),
		).rejects.toThrow("GitLab not connected");
	});

	it("executes tool successfully", async () => {
		mockFindFirst.mockResolvedValueOnce(mockIntegration());
		mockFetchOk([
			{
				id: 1,
				path_with_namespace: "group/project",
				visibility: "private",
				default_branch: "main",
				description: "A project",
				web_url: "https://gitlab.com/group/project",
				last_activity_at: "2024-01-01",
			},
		]);

		const result = await executeGitLabTool("list_projects", {}, "user-1");
		expect(Array.isArray(result)).toBe(true);
	});

	it("retries on 401 with token refresh", async () => {
		mockFindFirst.mockResolvedValueOnce(mockIntegration());
		// The 401 retry MUST re-read the row: GitLab rotates refresh tokens
		// single-use, so the pre-emptive refresh may already have spent the one
		// in the snapshot. Reusing it is what produced the paired
		// "pre-emptive failed"/"after 401 failed" storm on staging.
		mockFindUnique.mockResolvedValueOnce(mockIntegration());

		// First call: 401
		mockFetch401();
		// Refresh token call: success
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				access_token: "new-token",
				refresh_token: "new-refresh",
				expires_in: 7200,
				token_type: "bearer",
				scope: "api",
			}),
		});
		// Retry call: success
		mockFetchOk([]);

		const result = await executeGitLabTool("list_projects", {}, "user-1");
		expect(Array.isArray(result)).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(3); // 401 + refresh + retry
		expect(mockFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "int-1" } }),
		);
	});

	// Cross-process serialization: a caller that queued behind the advisory lock
	// must reuse the winner's freshly rotated token. Exchanging again would spend
	// a single-use grant that is already live for someone else and brick it.
	it("reuses a concurrent winner's token instead of exchanging again", async () => {
		const staleCreds = JSON.stringify({
			access_token: "stale-token",
			refresh_token: "stale-refresh",
			expires_in: 7200,
			token_obtained_at: new Date(Date.now() - 7200000).toISOString(),
		});
		const winnerCreds = JSON.stringify({
			access_token: "winner-token",
			refresh_token: "winner-refresh",
			expires_in: 7200,
			token_obtained_at: new Date().toISOString(),
		});
		// Our snapshot is stale, so a refresh looks necessary...
		mockFindFirst.mockResolvedValueOnce(
			mockIntegration({ credentials: staleCreds }),
		);
		// ...but inside the lock the row already carries the winner's fresh token.
		mockFindUnique.mockResolvedValueOnce(
			mockIntegration({ credentials: winnerCreds }),
		);
		mockFetchOk([]);

		await executeGitLabTool("list_projects", {}, "user-1");

		// Exactly one fetch: the API call. No token exchange happened.
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(mockFetch.mock.calls[0][0]).toContain("/projects");
	});
});

describe("tool handler argument validation", () => {
	beforeEach(() => {
		// Use projectAccessToken to skip DB lookup
	});

	it("get_project throws when project_id missing", async () => {
		await expect(
			executeGitLabTool("get_project", {}, "u", undefined, "tok"),
		).rejects.toThrow("project_id is required");
	});

	it("get_issue throws when args missing", async () => {
		await expect(
			executeGitLabTool(
				"get_issue",
				{ project_id: "p" },
				"u",
				undefined,
				"tok",
			),
		).rejects.toThrow("project_id and issue_iid are required");
	});

	it("create_merge_request throws when args missing", async () => {
		await expect(
			executeGitLabTool(
				"create_merge_request",
				{ project_id: "p", title: "t" },
				"u",
				undefined,
				"tok",
			),
		).rejects.toThrow("are required");
	});

	it("get_file_contents throws when path missing", async () => {
		await expect(
			executeGitLabTool(
				"get_file_contents",
				{ project_id: "p" },
				"u",
				undefined,
				"tok",
			),
		).rejects.toThrow("project_id and path are required");
	});

	it("search_commits throws when search missing", async () => {
		await expect(
			executeGitLabTool(
				"search_commits",
				{ project_id: "p" },
				"u",
				undefined,
				"tok",
			),
		).rejects.toThrow("search query is required");
	});

	it("get_commit throws when sha missing", async () => {
		await expect(
			executeGitLabTool(
				"get_commit",
				{ project_id: "p" },
				"u",
				undefined,
				"tok",
			),
		).rejects.toThrow("project_id and sha are required");
	});
});

describe("tool response mapping", () => {
	it("get_file_contents decodes base64", async () => {
		const base64Content = Buffer.from("hello world").toString("base64");
		mockFetchOk({
			content: base64Content,
			encoding: "base64",
			file_path: "README.md",
			blob_id: "abc123",
			size: 11,
		});

		const result = (await executeGitLabTool(
			"get_file_contents",
			{ project_id: "1", path: "README.md" },
			"u",
			undefined,
			"tok",
		)) as { content: string };
		expect(result.content).toBe("hello world");
	});

	it("get_authenticated_user maps username to login", async () => {
		mockFetchOk({
			username: "testuser",
			name: "Test User",
			email: "test@test.com",
			web_url: "https://gitlab.com/testuser",
			organization: null,
		});

		const result = (await executeGitLabTool(
			"get_authenticated_user",
			{},
			"u",
			undefined,
			"tok",
		)) as { login: string };
		expect(result.login).toBe("testuser");
	});
});

describe("repo-listing helpers propagate typed errors", () => {
	it("searchGitLabProjects re-throws GitLabApiError on 401", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			json: async () => ({ message: "401 Unauthorized" }),
		});

		await expect(
			searchGitLabProjects("tok", "mygroup"),
		).rejects.toBeInstanceOf(GitLabApiError);

		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			json: async () => ({ message: "401 Unauthorized" }),
		});

		await expect(
			searchGitLabProjects("tok", "mygroup"),
		).rejects.toMatchObject({
			status: 401,
		});
	});

	it("listUserProjects re-throws GitLabApiError on 429", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 429,
			json: async () => ({ message: "429 Too Many Requests" }),
		});

		await expect(listUserProjects("tok")).rejects.toBeInstanceOf(
			GitLabApiError,
		);

		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 429,
			json: async () => ({ message: "429 Too Many Requests" }),
		});

		await expect(listUserProjects("tok")).rejects.toMatchObject({
			status: 429,
		});
	});
});

describe("getGitLabAccessToken", () => {
	it("returns null when no integration found", async () => {
		mockFindFirst.mockResolvedValueOnce(null);
		const token = await getGitLabAccessToken("user-1");
		expect(token).toBeNull();
	});

	it("returns token when integration exists", async () => {
		mockFindFirst.mockResolvedValueOnce(mockIntegration());
		const token = await getGitLabAccessToken("user-1");
		expect(token).toBe("test-token");
	});

	it("uses org context when organizationId provided", async () => {
		mockFindFirst.mockResolvedValueOnce(mockIntegration());
		await getGitLabAccessToken("user-1", "org-1");
		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: "org-1",
				}),
			}),
		);
	});
});
