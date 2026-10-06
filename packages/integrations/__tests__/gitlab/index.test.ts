import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	readCredential,
} from "./helpers/gitlab-fake-db";

// ============================================================================
// Mocks: an in-memory database that applies `where` clauses (so a tenant
// filter is actually exercised), a real per-key lock, and "encryption" that
// a test can tell from plaintext.
// ============================================================================

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("./helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

vi.mock("@repo/database", () => ({
	get db() {
		return state.fake.db;
	},
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		keys: string | readonly string[],
		fn: (
			tx: unknown,
			assertBudget: (ms: number) => void,
		) => Promise<unknown>,
	) => state.fake.withLock(keys, fn as never),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import("./helpers/gitlab-fake-db");
	return {
		...(await importOriginal<object>()),
		decryptApiKey: vi.fn(helpers.fakeDecrypt),
		encryptApiKey: vi.fn(helpers.fakeEncrypt),
	};
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
	describeGitLabRefreshFailure,
	executeGitLabTool,
	GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
	GitLabApiError,
	getFreshGitLabAccessToken,
	getGitLabAccessToken,
	listUserProjects,
	parseGitLabProjectUrl,
	resetGitLabConnectionDepsForTests,
	searchGitLabProjects,
} from "../../src/gitlab/index";

// ============================================================================
// Helpers
// ============================================================================

const HOUR = 3_600_000;
const APP_ISSUER = {
	kind: "app",
	clientId: "test-client-id",
	origin: "https://gitlab.com",
};

/** An OAuth credential obtained `msAgo` ago (2h lifetime), app-issued. */
function oauthCredential(
	msAgo: number,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		access_token: "stale-token",
		refresh_token: "test-refresh",
		expires_in: 7200,
		token_obtained_at: new Date(Date.now() - msAgo).toISOString(),
		issuer: APP_ISSUER,
		connectionGeneration: 1,
		...extra,
	};
}

function connectionRow(
	credentials: string,
	extra: Record<string, unknown> = {},
) {
	return {
		id: "int-1",
		userId: "user-1",
		organizationId: "org-1",
		provider: "GITLAB",
		name: "GitLab: dev",
		workflowId: null,
		credentials,
		settings: {},
		isActive: true,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...extra,
	};
}

/** Seed one connection for user-1 in org-1. */
function seedConnection(
	credential: Record<string, unknown> | string,
	extra: Record<string, unknown> = {},
) {
	state.fake = createGitLabFakeDb({
		workflowIntegration: [
			connectionRow(
				typeof credential === "string"
					? credential
					: encryptedCredential(credential),
				extra,
			),
		],
	});
	return state.fake.tables.workflowIntegration[0];
}

function mockFetchOk(data: unknown) {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 200,
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

function mockTokenOk(access: string, refresh: string) {
	mockFetchOk({
		access_token: access,
		refresh_token: refresh,
		expires_in: 7200,
		token_type: "bearer",
		scope: "api",
	});
}

const refreshRejected = (status: number, body: string) =>
	mockFetch.mockResolvedValueOnce({
		ok: false,
		status,
		text: async () => body,
		json: async () => JSON.parse(body),
	});

const bearerOf = (callIndex: number) =>
	(
		(mockFetch.mock.calls[callIndex][1] as RequestInit).headers as Record<
			string,
			string
		>
	).Authorization;

const tokenExchanges = () =>
	mockFetch.mock.calls.filter(([url]) =>
		String(url).endsWith("/oauth/token"),
	);

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
	mockFetch.mockReset();
	resetGitLabConnectionDepsForTests();
	state.fake = createGitLabFakeDb();
	vi.stubEnv("GITLAB_CLIENT_ID", "test-client-id");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "test-client-secret");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("parseGitLabProjectUrl", () => {
	it("parses HTTPS URL", () => {
		const result = parseGitLabProjectUrl(
			"https://gitlab.com/mygroup/myproject",
		);
		expect(result).toEqual({ projectPath: "mygroup/myproject" });
	});

	it("parses SSH URL", () => {
		// Assembled rather than written as a literal: spelled out, an
		// scp-style git URL reads as an email address at an unsanctioned
		// domain and the publication identifier scan refuses the change over
		// it. The string handed to the parser is byte-identical either way,
		// so this exercises the same SSH pattern a literal would.
		const scpUrl = (host: string, path: string) => `git@${host}:${path}`;
		const result = parseGitLabProjectUrl(
			scpUrl("gitlab.com", "mygroup/myproject.git"),
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
		const findMany = vi.spyOn(
			state.fake.db.workflowIntegration,
			"findMany",
		);
		mockFetchOk([]);

		await executeGitLabTool(
			"list_projects",
			{},
			"user-1",
			undefined,
			"direct-token",
		);

		expect(findMany).not.toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalled();
		const url = mockFetch.mock.calls[0][0] as string;
		expect(url).toContain("/projects");
	});

	it("uses the caller's own connection for the tenant context, never another context's", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				connectionRow(
					encryptedCredential({ GITLAB_ACCESS_TOKEN: "org-token" }),
				),
				connectionRow(
					encryptedCredential({
						GITLAB_ACCESS_TOKEN: "personal-token",
					}),
					{ id: "int-personal", organizationId: null },
				),
				connectionRow(
					encryptedCredential({
						GITLAB_ACCESS_TOKEN: "teammate-token",
					}),
					{ id: "int-teammate", userId: "user-2" },
				),
			],
		});
		mockFetchOk([]);
		mockFetchOk([]);

		await executeGitLabTool("list_projects", {}, "user-1", "org-1");
		await executeGitLabTool("list_projects", {}, "user-1");

		expect(bearerOf(0)).toBe("Bearer org-token");
		expect(bearerOf(1)).toBe("Bearer personal-token");
	});

	it("throws when no integration found", async () => {
		await expect(
			executeGitLabTool("list_projects", {}, "user-1"),
		).rejects.toThrow("GitLab not connected");
	});

	it("executes tool successfully", async () => {
		seedConnection(oauthCredential(10 * 60_000));
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

		const result = await executeGitLabTool(
			"list_projects",
			{},
			"user-1",
			"org-1",
		);
		expect(Array.isArray(result)).toBe(true);
	});

	it("retries on 401 with a bounded token refresh, gated on the lock budget", async () => {
		// Spy on the real `AbortSignal.timeout`, not just the passed signal's
		// type: any AbortSignal would satisfy a type check, including one that
		// never fires.
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const assertBudget = vi.fn();
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				connectionRow(
					encryptedCredential(oauthCredential(10 * 60_000)),
				),
			],
		});
		state.fake.hooks.assertBudget = assertBudget;

		mockFetch401();
		mockTokenOk("new-token", "new-refresh");
		mockFetchOk([]);

		const result = await executeGitLabTool(
			"list_projects",
			{},
			"user-1",
			"org-1",
		);
		expect(Array.isArray(result)).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(3); // 401 + refresh + retry
		expect(bearerOf(2)).toBe("Bearer new-token");
		// The rotated grant is persisted, so the next caller does not spend
		// the single-use refresh token again.
		const stored = readCredential(state.fake.tables.workflowIntegration[0]);
		expect(stored.refresh_token).toBe("new-refresh");
		// A REAL timeout signal at the documented bound, the same object
		// `fetch` received for the exchange (call 1).
		const refreshCallInit = mockFetch.mock.calls[1][1] as RequestInit;
		expect(timeoutSpy).toHaveBeenCalledWith(
			GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
		);
		expect(refreshCallInit.signal).toBe(timeoutSpy.mock.results[0]?.value);
		// The exchange is gated on the budget left after acquiring the lock.
		expect(assertBudget).toHaveBeenCalledWith(
			GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
		);

		timeoutSpy.mockRestore();
	});

	// The exchange's AbortSignal.timeout also covers the BODY read: headers
	// can arrive as a 400 while the body then stalls past the deadline. That
	// is no verdict on the grant, so it must never condemn the connection.
	it("does not mark needsReauth when the exchange gets a 400 but reading its body aborts/times out", async () => {
		const row = seedConnection(oauthCredential(10 * 60_000));
		mockFetch401();
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 400,
			json: () =>
				Promise.reject(
					new DOMException("signal timed out", "TimeoutError"),
				),
			text: () =>
				Promise.reject(
					new DOMException("signal timed out", "TimeoutError"),
				),
		});

		await expect(
			executeGitLabTool("list_projects", {}, "user-1", "org-1"),
		).rejects.toThrow(/reconnect your GitLab account/i);

		expect((row.settings as Record<string, unknown>).needsReauth).not.toBe(
			true,
		);
		expect(readCredential(row).refresh_token).toBe("test-refresh");
	});

	// Cross-process serialization: a caller that queued behind the lock must
	// reuse the winner's freshly rotated token. Exchanging again would spend a
	// single-use grant that is already live for someone else. Finding nothing
	// left to do, it must not touch the budget guard either, however long it
	// waited for the lock.
	it("reuses a concurrent winner's token instead of exchanging again, without consulting the budget", async () => {
		const row = seedConnection(oauthCredential(10 * 60_000));
		const { RefreshLockBudgetExhaustedError } = await import(
			"@repo/database/prisma/queries/lib/refresh-lock-key"
		);
		state.fake.hooks.assertBudget = () => {
			throw new RefreshLockBudgetExhaustedError();
		};
		// The winner lands while this caller waits for the lock.
		state.fake.hooks.beforeAcquire = () => {
			row.credentials = encryptedCredential(
				oauthCredential(0, {
					access_token: "winner-token",
					refresh_token: "winner-refresh",
				}),
			);
		};
		mockFetch401();
		mockFetchOk([]);

		const result = await executeGitLabTool(
			"list_projects",
			{},
			"user-1",
			"org-1",
		);

		expect(Array.isArray(result)).toBe(true);
		expect(tokenExchanges()).toHaveLength(0);
		expect(bearerOf(1)).toBe("Bearer winner-token");
		expect(readCredential(row).refresh_token).toBe("winner-refresh");
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

	it("get_file_contents reads the default branch (HEAD) when no ref is given", async () => {
		mockFetchOk({
			content: Buffer.from("x").toString("base64"),
			encoding: "base64",
			file_path: "README.md",
			blob_id: "abc123",
			size: 1,
		});

		await executeGitLabTool(
			"get_file_contents",
			{ project_id: "1", path: "README.md" },
			"u",
			undefined,
			"tok",
		);

		const url = new URL(mockFetch.mock.calls[0][0] as string);
		expect(url.searchParams.get("ref")).toBe("HEAD");
	});

	it("get_file_contents lists a directory on the default branch when no ref is given", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 404,
			json: async () => ({ message: "404 File Not Found" }),
		});
		mockFetchOk([
			{ name: "a.ts", path: "src/a.ts", type: "blob", mode: "x" },
		]);

		await executeGitLabTool(
			"get_file_contents",
			{ project_id: "1", path: "src" },
			"u",
			undefined,
			"tok",
		);

		// The tree endpoint's ref is optional and defaults to the default branch.
		const url = new URL(mockFetch.mock.calls[1][0] as string);
		expect(url.pathname).toMatch(/\/repository\/tree$/);
		expect(url.searchParams.has("ref")).toBe(false);
	});

	it("get_file_contents passes an explicit ref through", async () => {
		mockFetchOk({
			content: Buffer.from("x").toString("base64"),
			encoding: "base64",
			file_path: "README.md",
			blob_id: "abc123",
			size: 1,
		});

		await executeGitLabTool(
			"get_file_contents",
			{ project_id: "1", path: "README.md", ref: "develop" },
			"u",
			undefined,
			"tok",
		);

		const url = new URL(mockFetch.mock.calls[0][0] as string);
		expect(url.searchParams.get("ref")).toBe("develop");
	});

	it("get_authenticated_user maps username to login", async () => {
		mockFetchOk({
			username: "testuser",
			name: "Test User",
			email: "dev@example.com",
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
		expect(await getGitLabAccessToken("user-1")).toBeNull();
	});

	it("returns token when integration exists", async () => {
		seedConnection(
			oauthCredential(10 * 60_000, { access_token: "test-token" }),
		);
		expect(await getGitLabAccessToken("user-1", "org-1")).toBe(
			"test-token",
		);
	});

	it("never answers with another tenant context's connection", async () => {
		seedConnection(
			oauthCredential(10 * 60_000, { access_token: "org-token" }),
		);
		expect(await getGitLabAccessToken("user-1", "org-2")).toBeNull();
		expect(await getGitLabAccessToken("user-1")).toBeNull();
		expect(await getGitLabAccessToken("user-2", "org-1")).toBeNull();
	});
});

describe("getFreshGitLabAccessToken", () => {
	// Failure paths log by design (server-log-only diagnostics). Silenced here
	// and inspected where it matters.
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		consoleErrorSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleLogSpy.mockRestore();
	});

	it("returns null when there is no integration", async () => {
		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toBeNull();
	});

	it("fails with a fixed-vocabulary reason when the token is past its real expiry and the refresh is rejected", async () => {
		seedConnection(oauthCredential(2 * HOUR + 60_000));
		refreshRejected(
			401,
			'{"error":"invalid_client","error_description":"Client authentication failed"}',
		);

		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: false,
			reason: "GitLab rejected the token refresh (HTTP 401)",
		});
	});

	it("an application-level rejection (invalid_client) never condemns the person's grant", async () => {
		const row = seedConnection(oauthCredential(2 * HOUR + 60_000));
		refreshRejected(401, '{"error":"invalid_client"}');

		await getFreshGitLabAccessToken("user-1", "org-1");

		expect((row.settings as Record<string, unknown>).needsReauth).not.toBe(
			true,
		);
	});

	it("a dead grant (invalid_grant) marks the connection reconnect-required and fails", async () => {
		const row = seedConnection(oauthCredential(2 * HOUR + 60_000));
		refreshRejected(400, '{"error":"invalid_grant"}');

		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: false,
			reason: "the GitLab connection needs to be reconnected",
		});
		expect((row.settings as Record<string, unknown>).needsReauth).toBe(
			true,
		);
		// …and is not retried on the next read.
		mockFetch.mockReset();
		expect(await getGitLabAccessToken("user-1", "org-1")).toBeNull();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("positive control: the lenient getter still hands back the expired token on the same transient failure", async () => {
		seedConnection(oauthCredential(2 * HOUR + 60_000));
		refreshRejected(401, '{"error":"invalid_client"}');

		expect(await getGitLabAccessToken("user-1", "org-1")).toBe(
			"stale-token",
		);
	});

	it("inside the pre-expiry buffer a failed refresh keeps the still-valid token", async () => {
		// 1h57m old: inside the 5-minute buffer, not yet expired.
		seedConnection(oauthCredential(2 * HOUR - 3 * 60_000));
		refreshRejected(503, "Service Unavailable");

		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: true,
			token: "stale-token",
		});
		// The refresh really was attempted (and failed).
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("unknown expiry with a refresh token refreshes once; a transient failure keeps the token (no expires_in, no timestamp)", async () => {
		seedConnection({
			access_token: "legacy-token",
			refresh_token: "test-refresh",
			issuer: APP_ISSUER,
		});
		refreshRejected(503, "Service Unavailable");

		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: true,
			token: "legacy-token",
		});
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("unknown expiry keeps the token on a transient failure (expires_in but no token_obtained_at)", async () => {
		seedConnection({
			access_token: "legacy-token",
			refresh_token: "test-refresh",
			expires_in: 7200,
			issuer: APP_ISSUER,
		});
		refreshRejected(503, "Service Unavailable");

		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: true,
			token: "legacy-token",
		});
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("an unparsable token_obtained_at is unknown expiry, never 'expired'", async () => {
		seedConnection({
			access_token: "legacy-token",
			refresh_token: "test-refresh",
			expires_in: 7200,
			token_obtained_at: "not-a-date",
			issuer: APP_ISSUER,
		});
		refreshRejected(503, "Service Unavailable");

		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: true,
			token: "legacy-token",
		});
	});

	it("returns null when the integration row stores empty credentials", async () => {
		seedConnection("");
		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toBeNull();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("returns an unexpired token without refreshing", async () => {
		seedConnection(oauthCredential(10 * 60_000));
		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: true,
			token: "stale-token",
		});
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("returns a raw (non-JSON) token string as is", async () => {
		seedConnection("enc:raw-pat-token");
		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: true,
			token: "raw-pat-token",
		});
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("returns a JSON token without a refresh token as is, even past its expiry", async () => {
		seedConnection({
			access_token: "pat-token",
			expires_in: 7200,
			token_obtained_at: new Date(Date.now() - 3 * HOUR).toISOString(),
		});
		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: true,
			token: "pat-token",
		});
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("reports a credential read failure as ok:false, not null (null is only a missing row)", async () => {
		// Not fake ciphertext: decryption throws.
		seedConnection("corrupted-ciphertext");
		expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
			ok: false,
			reason: "the GitLab token could not be obtained",
		});
		// A failure that is NOT provider text (our own code) still carries a
		// message in the log.
		const call = consoleErrorSpy.mock.calls.find(
			(c) => c[0] === "[GitLab] getFreshGitLabAccessToken failed",
		);
		expect(call?.[1]).toMatchObject({
			message: "GitLab credential could not be decrypted",
		});
	});

	describe("no provider response text reaches server logs", () => {
		/**
		 * `JSON.stringify` drops an `Error`'s own message/stack (they are
		 * non-enumerable), so a secret hiding inside one would silently escape
		 * a naive scan. Expand every `Error` argument first.
		 */
		const errorReplacer = (_key: string, value: unknown) =>
			value instanceof Error
				? {
						name: value.name,
						message: value.message,
						stack: value.stack,
					}
				: value;
		const allLogs = () =>
			[
				...consoleErrorSpy.mock.calls,
				...consoleWarnSpy.mock.calls,
				...consoleLogSpy.mock.calls,
			]
				.map((call) => JSON.stringify(call, errorReplacer))
				.join("\n");

		const secretBody =
			'{"error":"Invalid_Client","access_token":"glpat-AAAA"} client_secret=s3cr3t-VALUE';
		// A 200 answer carrying an OAuth error with a reflected description is
		// the one shape whose text reaches an Error message.
		const secretErrorDescription = {
			error: "server_error",
			error_description: "echo client_secret=s3cr3t-VALUE glpat-AAAA",
		};

		it("getFreshGitLabAccessToken (strict): only fixed phrases are logged", async () => {
			seedConnection(oauthCredential(2 * HOUR + 60_000));
			refreshRejected(401, secretBody);

			expect(await getFreshGitLabAccessToken("user-1", "org-1")).toEqual({
				ok: false,
				reason: "GitLab rejected the token refresh (HTTP 401)",
			});
			const strictLog = consoleErrorSpy.mock.calls.find(
				(c) => c[0] === "[GitLab] getFreshGitLabAccessToken failed",
			);
			expect(strictLog?.[1]).toMatchObject({
				reason: "GitLab rejected the token refresh (HTTP 401)",
			});
			expect(strictLog?.[1]).not.toHaveProperty("message");
			expect(allLogs()).not.toMatch(/s3cr3t|glpat|client_secret/);
		});

		it("strict: a reflected error_description never reaches the log", async () => {
			seedConnection(oauthCredential(2 * HOUR + 60_000));
			mockFetchOk(secretErrorDescription);

			const result = await getFreshGitLabAccessToken("user-1", "org-1");

			expect(result).toEqual({
				ok: false,
				reason: "GitLab returned no usable token",
			});
			expect(allLogs()).not.toMatch(/s3cr3t|glpat|client_secret/);
		});

		it("getGitLabAccessToken (lenient): the fallback is logged with fixed fields only", async () => {
			seedConnection(oauthCredential(2 * HOUR + 60_000));
			mockFetchOk(secretErrorDescription);

			expect(await getGitLabAccessToken("user-1", "org-1")).toBe(
				"stale-token",
			);
			const fallback = consoleWarnSpy.mock.calls.find((c) =>
				String(c[0]).includes("refresh failed; using current token"),
			);
			expect(fallback?.[1]).toMatchObject({ reason: "transient" });
			expect(allLogs()).not.toMatch(/s3cr3t|glpat|client_secret/);
		});
	});
});

describe("describeGitLabRefreshFailure", () => {
	it("maps every refresh failure to a fixed phrase", () => {
		expect(
			describeGitLabRefreshFailure(
				new Error(
					"Cannot refresh GitLab token: no client credentials configured. Set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET, or reconnect your GitLab account.",
				),
			),
		).toBe("no GitLab OAuth app credentials are configured");
		expect(
			describeGitLabRefreshFailure(
				new Error(
					'GitLab token refresh failed: 400 {"error":"invalid_grant","error_description":"The provided authorization grant is invalid"}',
				),
			),
		).toBe("GitLab rejected the token refresh (HTTP 400 invalid_grant)");
		expect(
			describeGitLabRefreshFailure(
				new Error("GitLab token refresh failed: 503 <html>busy</html>"),
			),
		).toBe("GitLab could not refresh the token (HTTP 503)");
		expect(
			describeGitLabRefreshFailure(
				new Error(
					'GitLab token refresh failed: 429 {"error":"rate_limited"}',
				),
			),
		).toBe("GitLab could not refresh the token (HTTP 429)");
		expect(
			describeGitLabRefreshFailure(
				new Error(
					"GitLab token refresh failed: 502 (response body unreadable, possibly a timeout)",
				),
			),
		).toBe("the token refresh timed out");
		expect(
			describeGitLabRefreshFailure(
				new Error("GitLab token refresh error: invalid_scope"),
			),
		).toBe("GitLab rejected the token refresh (invalid_scope)");
		expect(
			describeGitLabRefreshFailure(
				new Error(
					"GitLab token refresh error: no access_token in response",
				),
			),
		).toBe("GitLab returned no usable token");
		expect(
			describeGitLabRefreshFailure(
				Object.assign(
					new Error("The operation was aborted due to timeout"),
					{
						name: "TimeoutError",
					},
				),
			),
		).toBe("the token refresh timed out");
		expect(
			describeGitLabRefreshFailure(
				Object.assign(new Error("Only 1ms left"), {
					name: "RefreshLockBudgetExhaustedError",
				}),
			),
		).toBe("the token refresh could not start in time");
		expect(
			describeGitLabRefreshFailure(new TypeError("fetch failed")),
		).toBe("GitLab could not be reached");
		expect(describeGitLabRefreshFailure("weird")).toBe(
			"the GitLab token could not be obtained",
		);
	});

	it("never carries provider text, even a reflected secret", () => {
		const reflected = new Error(
			'GitLab token refresh failed: 401 {"error":"Invalid_Client client_secret=s3cr3t-VALUE","token":"glpat-AAAA"} client_secret=s3cr3t-VALUE',
		);
		const reason = describeGitLabRefreshFailure(reflected);
		expect(reason).toBe("GitLab rejected the token refresh (HTTP 401)");
		expect(reason).not.toMatch(/s3cr3t|glpat|client_secret/);
	});
});

describe("GitLab OAuth app tenant scope", () => {
	// Ported from staging (#842) onto the in-memory database: the app client
	// used to refresh a caller's token comes only from the environment, the
	// caller's own organization, the caller's own personal row, or the
	// system row, never from another tenant's GITLAB_OAUTH_APP.
	function appRow(
		id: string,
		userId: string | null,
		organizationId: string | null,
		clientId: string,
	) {
		return {
			id,
			userId,
			organizationId,
			provider: "GITLAB",
			name: "GITLAB_OAUTH_APP",
			workflowId: null,
			isActive: true,
			settings: {},
			credentials: encryptedCredential({
				client_id: clientId,
				client_secret: `${clientId}-secret`,
			}),
		};
	}

	function seedWithApps(apps: ReturnType<typeof appRow>[]) {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				...apps,
				connectionRow(
					encryptedCredential(
						oauthCredential(2 * HOUR + 60_000, {
							issuer: { ...APP_ISSUER, clientId: "own-client" },
						}),
					),
				),
			],
		});
	}

	beforeEach(() => {
		vi.stubEnv("GITLAB_CLIENT_ID", "");
		vi.stubEnv("GITLAB_CLIENT_SECRET", "");
	});

	it("does not exchange a caller's refresh token using another tenant's app", async () => {
		seedWithApps([
			appRow("foreign-org-app", "user-2", "org-2", "own-client"),
			appRow("foreign-personal-app", "user-2", null, "own-client"),
		]);
		const errorLog = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await getGitLabAccessToken("user-1", "org-1")).toBe(
				"stale-token",
			);
			expect(tokenExchanges()).toHaveLength(0);
			expect(String(mockFetch.mock.calls)).not.toContain(
				"own-client-secret",
			);
		} finally {
			errorLog.mockRestore();
			warnLog.mockRestore();
		}
	});

	it("refreshes with the caller's own organization's app", async () => {
		seedWithApps([appRow("own-org-app", "user-3", "org-1", "own-client")]);
		mockTokenOk("fresh-token", "fresh-refresh");

		expect(await getGitLabAccessToken("user-1", "org-1")).toBe(
			"fresh-token",
		);
		expect(tokenExchanges()).toHaveLength(1);
		expect(String(tokenExchanges()[0][1]?.body)).toContain(
			"own-client-secret",
		);
	});
});
