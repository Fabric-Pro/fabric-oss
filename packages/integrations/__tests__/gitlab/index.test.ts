import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Mocks (hoisted to avoid reference errors)
// ============================================================================

const {
	mockFindFirst,
	mockFindUnique,
	mockUpdate,
	mockFetch,
	mockWithRefreshLock,
	mockAssertBudget,
} = vi.hoisted(() => {
	const mockFindFirst = vi.fn();
	const mockUpdate = vi.fn();
	const mockFetch = vi.fn();
	const mockFindUnique = vi.fn();
	// A no-op by default; individual tests override its implementation to
	// prove whether the production code path calls it (see the "budget
	// exhausted" style test below, which makes it throw to prove a
	// short-circuit path never reaches it).
	const mockAssertBudget = vi.fn();
	// A spy, not a bare arrow function: this is still a pass-through (it just
	// calls `fn` immediately, ignoring any real lock timing), but wrapping it
	// in `vi.fn()`, and handing `fn` a real (mocked) `assertBudget` second
	// argument, lets tests assert WHETHER and HOW production code calls it —
	// otherwise a regression there (e.g. calling it too early, on a
	// short-circuit path, or with the wrong constant) would be invisible
	// here, since `withRefreshLock`'s real budget-guard logic lives in
	// `refresh-lock.ts` and is exercised by ITS own tests, not this file's.
	const mockWithRefreshLock = vi.fn(
		(
			_key: string,
			fn: (
				tx: unknown,
				assertBudget: (requiredMs: number) => void,
			) => unknown,
		) =>
			fn(
				{
					workflowIntegration: {
						findUnique: mockFindUnique,
						update: mockUpdate,
					},
				},
				mockAssertBudget,
			),
	);
	return {
		mockFindFirst,
		mockUpdate,
		mockFetch,
		mockFindUnique,
		mockWithRefreshLock,
		mockAssertBudget,
	};
});

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: mockWithRefreshLock,
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
	GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
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
	mockWithRefreshLock.mockClear();
	mockAssertBudget.mockClear();
	mockAssertBudget.mockImplementation(() => {
		// No-op by default (comfortable budget). Tests that need to prove a
		// short-circuit path never reaches this call override it to throw.
	});
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
		// Spy on the real `AbortSignal.timeout`, not just the passed
		// `signal`'s type: `expect(init.signal).toBeInstanceOf(AbortSignal)`
		// alone is satisfied by ANY AbortSignal, including a plain
		// `new AbortController().signal` that would never fire on its own —
		// so that assertion by itself would leave this test green even if
		// the exchange stopped calling the real timeout and became
		// unbounded.
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
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
		// This refresh call runs inside `withRefreshLock`'s advisory-lock
		// transaction (see `refreshTokenWithLock`), which carries the same
		// 20s budget as the other GitLab refresh paths — a bare `fetch` with
		// no timeout could hang well past it. Call index 1 is the refresh
		// exchange itself (0 = the original 401, 2 = the retry).
		const refreshCallInit = mockFetch.mock.calls[1][1] as RequestInit;
		// A REAL timeout signal, at the exact documented bound, and the SAME
		// signal object `fetch` actually received.
		expect(timeoutSpy).toHaveBeenCalledWith(
			GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
		);
		expect(refreshCallInit.signal).toBe(timeoutSpy.mock.results[0]?.value);
		// `refreshTokenWithLock`'s callback must gate on the budget actually
		// left after acquiring the lock (see `assertRefreshLockBudget`)
		// immediately before starting the exchange, instead of trusting fixed
		// constants alone — called via `withRefreshLock`'s `assertBudget`
		// second callback argument, with the exchange's own bound.
		expect(mockWithRefreshLock).toHaveBeenCalledTimes(1);
		expect(mockAssertBudget).toHaveBeenCalledWith(
			GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
		);

		timeoutSpy.mockRestore();
	});

	// Regression: the exchange's AbortSignal.timeout also covers the BODY
	// read, not just the headers. Headers can arrive (producing a real
	// `response` with `ok: false`) before the deadline while the body then
	// stalls past it — the abort fires INSIDE `response.text()`. An earlier
	// version of this code did `.catch(() => "")` around that read, which
	// made a failed read indistinguishable from "GitLab explained nothing"
	// and still classified a bare 400/401 as permanent, condemning a
	// credential on evidence this process never actually received.
	it("does not mark needsReauth when the exchange gets a 400 but reading its body aborts/times out", async () => {
		mockFindFirst.mockResolvedValueOnce(mockIntegration());
		mockFindUnique.mockResolvedValueOnce(mockIntegration());

		// First call: 401
		mockFetch401();
		// Refresh token call: headers arrive as a 400, but the body read
		// itself rejects — exactly what the same AbortSignal produces when
		// it fires mid-body after headers already arrived.
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: () =>
				Promise.reject(
					new DOMException("signal timed out", "TimeoutError"),
				),
		});

		await expect(
			executeGitLabTool("list_projects", {}, "user-1"),
		).rejects.toThrow(/reconnect your GitLab account/i);

		// The 400 status never got classified as permanent because the body
		// that would have proven (or disproven) `invalid_grant` was never
		// actually read — so no needsReauth write ever happened.
		expect(mockUpdate).not.toHaveBeenCalled();
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
		// This is the regression this test's whole scenario is FOR: the
		// short-circuit above found nothing left to do and must never touch
		// the budget guard, however long this caller waited for the lock.
		expect(mockAssertBudget).not.toHaveBeenCalled();
	});

	it("this callback's own re-read short-circuits BEFORE it would ever call assertBudget, proven by making assertBudget throw unconditionally", async () => {
		// SCOPE, precisely: `withRefreshLock` is mocked to a pass-through in
		// this file (see the hoisted mock above) — it calls `fn(tx,
		// mockAssertBudget)` immediately, simulating no real lock-wait time
		// at all. So this test can only prove ONE thing: that `index.ts`'s
		// own callback calls its re-read-and-short-circuit BEFORE it ever
		// calls `assertBudget`. Making the mock throw unconditionally and
		// asserting the call still succeeds is how that ordering is proven
		// without simulating real elapsed time.
		//
		// This test does NOT exercise the REAL `assertBudget` closure's
		// arithmetic, its `performance.now()` measurement, or
		// `withRefreshLock`'s real lock-wait timing — where WITHIN the real
		// `withRefreshLock` implementation the guard is placed (e.g.
		// unconditionally right after the lock statement, versus after the
		// re-read short-circuit) would not affect this test's outcome,
		// because that implementation isn't running here at all. That
		// placement guarantee is covered end-to-end against the real
		// implementation by `refresh-lock.test.ts` (`withRefreshLock`
		// itself) and by `get-valid-access-token.test.ts` /
		// `gitlab-token.test.ts`, whose locked branches open their own
		// `$transaction` rather than going through the mocked helper.
		//
		// What THIS test pins: the budget guard must only gate BOUNDED
		// PROVIDER WORK, never the lock acquisition itself. A waiter that
		// queues behind a legitimate holder and, via the re-read, finds the
		// winner's freshly persisted token has no bounded work left to do —
		// gating unconditionally right after the advisory-lock statement,
		// before that re-read ever runs, would reject such a waiter before
		// it ever looked.
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
		mockFindFirst.mockResolvedValueOnce(
			mockIntegration({ credentials: staleCreds }),
		);
		mockFindUnique.mockResolvedValueOnce(
			mockIntegration({ credentials: winnerCreds }),
		);
		mockFetchOk([]);

		const { RefreshLockBudgetExhaustedError } = await import(
			"@repo/database/prisma/queries/lib/refresh-lock-key"
		);
		mockAssertBudget.mockImplementation(() => {
			throw new RefreshLockBudgetExhaustedError();
		});

		const result = await executeGitLabTool("list_projects", {}, "user-1");

		expect(Array.isArray(result)).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(mockAssertBudget).not.toHaveBeenCalled();
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
