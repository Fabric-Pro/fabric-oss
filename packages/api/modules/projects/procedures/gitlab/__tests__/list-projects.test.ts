/**
 * Integration tests for `listGitLabProjectsProcedure`.
 *
 * Tests the procedure's behaviour given different outcomes from
 * resolveGitLabSource (the credential resolver introduced in Task 8).
 * The resolver's internal fallback/refresh logic is covered separately in
 * packages/integrations/__tests__/gitlab/source.test.ts.
 *
 * Scenarios covered here:
 *   - resolveGitLabSource returns null → "GitLab not connected" error.
 *   - resolveGitLabSource returns rest-adapter → REST path executes,
 *     getAuthenticatedUser is called with the resolved token.
 *   - resolveGitLabSource returns official-mcp → callTool is used, no REST calls.
 *   - REST path: 401 from getAuthenticatedUser → rejected-token error.
 *   - REST path: network error → "Could not reach GitLab".
 *   - searchGroup input → searchGitLabProjects is called instead of listUserProjects.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class GitLabApiErrorMock extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "GitLabApiError";
	}
}

// ---------------------------------------------------------------------------
// Hoisted mock factories for the resolver symbols
// ---------------------------------------------------------------------------
const mockResolveGitLabSource = vi.fn();
const mockRefreshMcpConfigToken = vi.fn();
const mockMarkRefreshFailure = vi.fn();
const mockCreateGitLabRefreshFailureWriter = vi.fn(
	() => mockMarkRefreshFailure,
);

// Pre-existing mock factories
const mockGetAuthenticatedUser = vi.fn();
const mockGetGitLabAccessToken = vi.fn();
const mockListUserProjects = vi.fn();
const mockSearchGitLabProjects = vi.fn();

vi.mock("@repo/integrations/gitlab", () => ({
	resolveGitLabSource: (...args: unknown[]) =>
		mockResolveGitLabSource(...args),
	refreshMcpConfigToken: (...args: unknown[]) =>
		mockRefreshMcpConfigToken(...args),
	createGitLabRefreshFailureWriter: (...args: unknown[]) =>
		mockCreateGitLabRefreshFailureWriter(...args),
	getAuthenticatedUser: (...args: unknown[]) =>
		mockGetAuthenticatedUser(...args),
	getGitLabAccessToken: (...args: unknown[]) =>
		mockGetGitLabAccessToken(...args),
	listUserProjects: (...args: unknown[]) => mockListUserProjects(...args),
	searchGitLabProjects: (...args: unknown[]) =>
		mockSearchGitLabProjects(...args),
	GitLabApiError: GitLabApiErrorMock,
}));

const mockMcpConfigFindFirst = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		mCPConfig: {
			findFirst: (...args: unknown[]) => mockMcpConfigFindFirst(...args),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (s: string) => `decrypted:${s}`,
	encryptApiKey: (s: string) => `encrypted:${s}`,
	hashApiKey: (s: string) => `hash:${s}`,
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
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		organizationId?: string | null;
		searchGroup?: string;
		projectId?: string;
	};
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{
	configured: boolean;
	username: string | null;
	groups: unknown[];
	error: string | null | undefined;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../list-projects");
	return (mod.listGitLabProjectsProcedure as unknown as { handler: Handler })
		.handler;
}

const baseInput = { organizationId: null };
const baseContext = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockListUserProjects.mockResolvedValue([]);
});

describe("listGitLabProjectsProcedure — credential resolution", () => {
	it("returns 'not connected' when resolveGitLabSource returns null", async () => {
		mockResolveGitLabSource.mockResolvedValue(null);

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.error).toMatch(/GitLab not connected/);
		expect(result.configured).toBe(false);
		expect(mockGetAuthenticatedUser).not.toHaveBeenCalled();
	});

	it("hands the resolver the shared refresh-failure writer", async () => {
		// Without it a revoked grant is retried on every poll of the picker
		// and never recorded (issue #2795). What the writer then persists is
		// covered in list-projects-refresh-breaker.test.ts.
		mockResolveGitLabSource.mockResolvedValue(null);

		const handler = await loadHandler();
		await handler({ input: baseInput, context: baseContext });

		expect(mockCreateGitLabRefreshFailureWriter).toHaveBeenCalledOnce();
		const opts = mockResolveGitLabSource.mock.calls[0]![0] as {
			markRefreshFailure?: unknown;
		};
		expect(opts.markRefreshFailure).toBe(mockMarkRefreshFailure);
	});

	it("uses REST token when resolveGitLabSource returns rest-adapter; never queries MCPConfig directly", async () => {
		mockResolveGitLabSource.mockResolvedValue({
			kind: "rest-adapter",
			token: "wi-token",
		});
		mockGetAuthenticatedUser.mockResolvedValue({
			login: "alice",
			name: "Alice",
			avatar_url: "",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.error).toBeNull();
		expect(result.username).toBe("alice");
		// The procedure must pass the resolver's token directly to getAuthenticatedUser
		expect(mockGetAuthenticatedUser).toHaveBeenCalledWith("wi-token");
		// MCPConfig is not queried by the procedure itself — only by the resolver
		expect(mockMcpConfigFindFirst).not.toHaveBeenCalled();
	});

	it("uses callTool when resolveGitLabSource returns official-mcp; skips REST calls", async () => {
		const mockCallTool = vi.fn().mockResolvedValue([
			{
				name: "group/project",
				path_with_namespace: "group/project",
				description: null,
				visibility: "private",
				web_url: "https://gitlab.com/group/project",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 0,
				namespace: { full_path: "group" },
			},
		]);
		mockResolveGitLabSource.mockResolvedValue({
			kind: "official-mcp",
			callTool: mockCallTool,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.error).toBeNull();
		expect(result.configured).toBe(true);
		expect(mockCallTool).toHaveBeenCalledWith(
			"list_projects",
			expect.objectContaining({ per_page: 100 }),
		);
		// REST helpers must not be called on the MCP path
		expect(mockGetAuthenticatedUser).not.toHaveBeenCalled();
		expect(mockListUserProjects).not.toHaveBeenCalled();
	});

	it("returns rejected-token error when REST path receives 401 from getAuthenticatedUser", async () => {
		mockResolveGitLabSource.mockResolvedValue({
			kind: "rest-adapter",
			token: "stale-token",
		});
		mockGetAuthenticatedUser.mockRejectedValueOnce(
			new GitLabApiErrorMock("invalid_token", 401),
		);

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.error).toMatch(/GitLab rejected the stored token/);
		expect(result.error).toMatch(/401/);
		expect(result.username).toBeNull();
	});

	it("surfaces network errors as 'Could not reach GitLab' (not auth)", async () => {
		mockResolveGitLabSource.mockResolvedValue({
			kind: "rest-adapter",
			token: "wi-token",
		});
		mockGetAuthenticatedUser.mockRejectedValueOnce(
			new TypeError("fetch failed: ECONNREFUSED"),
		);

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.error).toMatch(/Could not reach GitLab|fetch failed/);
		expect(result.error).not.toMatch(/rejected/);
	});

	it("filters by searchGroup when input.searchGroup is provided", async () => {
		mockResolveGitLabSource.mockResolvedValue({
			kind: "rest-adapter",
			token: "wi-token",
		});
		mockGetAuthenticatedUser.mockResolvedValue({
			login: "alice",
			name: "Alice",
			avatar_url: "",
		});
		mockSearchGitLabProjects.mockResolvedValue([
			{
				name: "my-org/project-a",
				path_with_namespace: "my-org/project-a",
				description: null,
				visibility: "private",
				web_url: "https://gitlab.com/my-org/project-a",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 0,
				namespace: { full_path: "my-org" },
			},
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: { ...baseInput, searchGroup: "my-org" },
			context: baseContext,
		});

		expect(result.error).toBeNull();
		expect(mockSearchGitLabProjects).toHaveBeenCalledWith(
			"wi-token",
			"my-org",
			100,
		);
		expect(mockListUserProjects).not.toHaveBeenCalled();
		expect(result.groups).toHaveLength(1);
	});

	it("lists user projects via REST when no searchGroup provided", async () => {
		mockResolveGitLabSource.mockResolvedValue({
			kind: "rest-adapter",
			token: "wi-token",
		});
		mockGetAuthenticatedUser.mockResolvedValue({
			login: "alice",
			name: "Alice",
			avatar_url: "",
		});
		mockListUserProjects.mockResolvedValue([
			{
				name: "alice/my-project",
				path_with_namespace: "alice/my-project",
				description: null,
				visibility: "private",
				web_url: "https://gitlab.com/alice/my-project",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 2,
				namespace: { full_path: "alice" },
			},
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.error).toBeNull();
		expect(result.username).toBe("alice");
		expect(mockListUserProjects).toHaveBeenCalledWith("wi-token", 100);
		expect(result.groups).toHaveLength(1);
		expect((result.groups[0] as { ownerType: string }).ownerType).toBe(
			"user",
		);
	});

	it("groups the user's own projects under ownerType 'user' when GitLab namespace casing differs from username", async () => {
		// Regression: GitLab returns namespaces with original casing (e.g. "Alice")
		// while `username` from /user is lowercased ("alice"). Previously the
		// projectsByOwner map keyed on raw casing so the user lookup missed and
		// the filter excluded the entry — dropping the user's projects entirely.
		mockResolveGitLabSource.mockResolvedValue({
			kind: "rest-adapter",
			token: "wi-token",
		});
		mockGetAuthenticatedUser.mockResolvedValue({
			login: "alice",
			name: "Alice",
			avatar_url: "",
		});
		mockListUserProjects.mockResolvedValue([
			{
				name: "Alice/personal-repo",
				path_with_namespace: "Alice/personal-repo",
				description: null,
				visibility: "private",
				web_url: "https://gitlab.com/Alice/personal-repo",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 0,
				namespace: { full_path: "Alice" },
			},
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.error).toBeNull();
		expect(result.groups).toHaveLength(1);
		const userGroup = result.groups[0] as {
			owner: string;
			ownerType: string;
			repos: unknown[];
		};
		expect(userGroup.ownerType).toBe("user");
		// Original-cased namespace must be preserved for display
		expect(userGroup.owner).toBe("Alice");
		expect(userGroup.repos).toHaveLength(1);
	});

	it("returns configured:true with empty groups when searchGroup finds no matching projects", async () => {
		mockResolveGitLabSource.mockResolvedValue({
			kind: "rest-adapter",
			token: "wi-token",
		});
		mockGetAuthenticatedUser.mockResolvedValue({
			login: "alice",
			name: "Alice",
			avatar_url: "",
		});
		// API returns projects in a different namespace — none match
		mockSearchGitLabProjects.mockResolvedValue([
			{
				name: "other-org/project",
				path_with_namespace: "other-org/project",
				description: null,
				visibility: "public",
				web_url: "https://gitlab.com/other-org/project",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 0,
				namespace: { full_path: "other-org" },
			},
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: { ...baseInput, searchGroup: "my-org" },
			context: baseContext,
		});

		expect(result.configured).toBe(true);
		expect(result.groups).toHaveLength(0);
		expect(result.error).toMatch(/No projects found for "my-org"/);
	});
});

describe("listGitLabProjectsProcedure — official-MCP searchGroup", () => {
	it("passes search param to callTool and filters result by namespace prefix", async () => {
		const mockCallTool = vi.fn().mockResolvedValue([
			{
				name: "my-org/project-a",
				path_with_namespace: "my-org/project-a",
				description: null,
				visibility: "private",
				web_url: "https://gitlab.com/my-org/project-a",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 0,
				namespace: { full_path: "my-org" },
			},
			// Fuzzy match that should be filtered out (namespace doesn't start with "my-org")
			{
				name: "other-group/my-org-docs",
				path_with_namespace: "other-group/my-org-docs",
				description: "mentions my-org in name",
				visibility: "public",
				web_url: "https://gitlab.com/other-group/my-org-docs",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 0,
				namespace: { full_path: "other-group" },
			},
		]);
		mockResolveGitLabSource.mockResolvedValue({
			kind: "official-mcp",
			callTool: mockCallTool,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { ...baseInput, searchGroup: "my-org" },
			context: baseContext,
		});

		// Must pass search to callTool
		expect(mockCallTool).toHaveBeenCalledWith(
			"list_projects",
			expect.objectContaining({ search: "my-org" }),
		);
		// Must filter by namespace prefix — only my-org project passes
		expect(result.configured).toBe(true);
		expect(result.error).toBeNull();
		expect(result.groups).toHaveLength(1);
		expect((result.groups[0] as { owner: string }).owner).toBe("my-org");
		expect((result.groups[0] as { repos: unknown[] }).repos).toHaveLength(
			1,
		);
		// REST helpers must not be called
		expect(mockGetAuthenticatedUser).not.toHaveBeenCalled();
	});

	it("returns 'No projects found' error on official-MCP path when namespace filter eliminates all results", async () => {
		const mockCallTool = vi.fn().mockResolvedValue([
			{
				name: "other-group/something",
				path_with_namespace: "other-group/something",
				description: null,
				visibility: "public",
				web_url: "https://gitlab.com/other-group/something",
				default_branch: "main",
				last_activity_at: "2026-01-01T00:00:00Z",
				star_count: 0,
				namespace: { full_path: "other-group" },
			},
		]);
		mockResolveGitLabSource.mockResolvedValue({
			kind: "official-mcp",
			callTool: mockCallTool,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { ...baseInput, searchGroup: "my-org" },
			context: baseContext,
		});

		expect(result.configured).toBe(true);
		expect(result.groups).toHaveLength(0);
		expect(result.error).toMatch(/No projects found for "my-org"/);
	});
});
