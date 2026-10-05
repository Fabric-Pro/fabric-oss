/**
 * The chat's `code_search` step (plan-mode handler): a repository whose
 * search failed is reported as a failed search, never as "no matches".
 *
 * - every repository failed, nothing found → error status, "Could not search";
 * - some failed, nothing found → success, names the failed repository and
 *   says it is not proof of absence;
 * - some failed, some found → the matches plus a failure note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	repos: [] as Array<Record<string, unknown>>,
	searchRepositoryCode: vi.fn(),
	resolveToken: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	db: {
		project: { findUnique: vi.fn(async () => null) },
		workflowIntegration: { findFirst: vi.fn(async () => null) },
	},
	getProjectCodeIndexes: vi.fn().mockResolvedValue([]),
	getProjectReposForCodeSearch: vi.fn(async () => h.repos),
	parseRepoUrl: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: h.resolveToken,
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubAccessToken: vi.fn(),
}));
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: h.searchRepositoryCode,
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: vi.fn(),
}));

const SECRET = "ghp_EXAMPLESECRET0123456789abcdefABCDEF";
const APP = {
	provider: "GITHUB",
	owner: "example-org",
	repo: "app",
	branch: "main",
};
const API = {
	provider: "GITHUB",
	owner: "example-org",
	repo: "api",
	branch: "main",
};

const RATE_LIMITED = {
	kind: "rate_limited",
	status: 429,
	message:
		"The repository provider rate-limited the request (HTTP 429); try again shortly.",
};
const FORBIDDEN = {
	kind: "forbidden",
	status: 403,
	message:
		"The repository credentials do not have access to this (HTTP 403).",
};
const MATCH = {
	filePath: "src/auth.ts",
	fileName: "auth.ts",
	repository: "example-org/app",
	matchedSnippets: ["export function login() {}"],
};

/** Per-repository answers, keyed by repo name. */
function answers(byRepo: Record<string, unknown>) {
	h.searchRepositoryCode.mockImplementation(
		async (params: { repo: string }) => byRepo[params.repo],
	);
}

async function search(args: Record<string, unknown> = {}) {
	const { CodeSearchHandler } = await import(
		"../../src/activities/orchestrator/execution/handlers/code-search-handler"
	);
	const toolCalls: Array<{
		status: string;
		result: Record<string, unknown>;
	}> = [];
	const result = await new CodeSearchHandler().execute({
		input: {
			step: {
				id: "step-1",
				app: "code_search",
				inputs: { query: "login", ...args },
			},
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		} as never,
		variables: {},
		toolCalls: toolCalls as never,
		startTime: 0,
	});
	const output = result.output;
	return {
		text: String(output?.response ?? ""),
		toolCall: output?.toolCalls?.at(-1) as unknown as {
			status: string;
			result: Record<string, unknown>;
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	h.repos = [APP, API];
	h.resolveToken.mockResolvedValue({ token: "token-example", method: "pat" });
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("code_search: a failed search is not 'no matches'", () => {
	it("every repository failed: error status, and no 'No code matches'", async () => {
		answers({
			app: { results: [], error: RATE_LIMITED },
			api: { results: [], error: FORBIDDEN },
		});
		const { text, toolCall } = await search({ mode: "api" });

		expect(text).toContain('Could not search for "login".');
		expect(text).toContain(`example-org/app: ${RATE_LIMITED.message}`);
		expect(text).toContain(`example-org/api: ${FORBIDDEN.message}`);
		expect(text).toContain(
			"This is a search failure, not proof that the code does not exist.",
		);
		expect(text).not.toContain("No code matches");
		expect(toolCall.status).toBe("error");
		expect(toolCall.result).toEqual({ message: text });
	});

	it("one repository only, and it failed: error status", async () => {
		h.repos = [APP];
		answers({ app: { results: [], error: FORBIDDEN } });
		const { text, toolCall } = await search({ mode: "api" });

		expect(text).toContain("Could not search");
		expect(text).not.toContain("No code matches");
		expect(toolCall.status).toBe("error");
	});

	it("a search that throws counts as failed, without its exception text", async () => {
		h.searchRepositoryCode.mockRejectedValue(
			new Error(`fetch failed for https://example.com/?token=${SECRET}`),
		);
		const { text, toolCall } = await search({ mode: "api" });

		expect(text).toContain("the search failed unexpectedly");
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("No code matches");
		expect(toolCall.status).toBe("error");
	});

	it("some repositories failed and nothing was found: success, naming the failed repository", async () => {
		answers({
			app: { results: [] },
			api: { results: [], error: RATE_LIMITED },
		});
		const { text, toolCall } = await search({ mode: "api" });

		expect(text).toContain(
			'No code matches found for "login" in the repositories that could be searched.',
		);
		expect(text).toContain(`example-org/api: ${RATE_LIMITED.message}`);
		expect(text).not.toContain("example-org/app:");
		expect(text).toContain("not proof that the code does not exist");
		expect(toolCall.status).toBe("success");
		expect(toolCall.result).toMatchObject({
			totalCount: 0,
			failedRepos: 1,
		});
	});

	it("matches plus a failure: the matches are shown, then the failure note", async () => {
		answers({
			app: { results: [MATCH] },
			api: { results: [], error: FORBIDDEN },
		});
		const { text, toolCall } = await search({ mode: "api" });

		expect(text).toContain("Found 1 code matches");
		expect(text).toContain("export function login() {}");
		expect(text).toContain(
			`\n\nCould not search example-org/api: ${FORBIDDEN.message}`,
		);
		expect(toolCall.status).toBe("success");
		expect(toolCall.result).toMatchObject({
			totalCount: 1,
			failedRepos: 1,
		});
	});

	it("a clean search with no matches keeps its wording and reports no failures", async () => {
		answers({ app: { results: [] }, api: { results: [] } });
		const { text, toolCall } = await search({ mode: "api" });

		expect(text).toBe('No code matches found for "login".');
		expect(toolCall.status).toBe("success");
		expect(toolCall.result).not.toHaveProperty("failedRepos");
	});

	it("a successful search reports no failed repositories", async () => {
		answers({ app: { results: [MATCH] }, api: { results: [] } });
		const { text, toolCall } = await search({ mode: "api" });

		expect(text).not.toContain("Could not search");
		expect(toolCall.result).not.toHaveProperty("failedRepos");
	});

	it("the API search never runs in indexed mode, so no failure is reported", async () => {
		const { toolCall } = await search({ mode: "indexed" });

		expect(h.searchRepositoryCode).not.toHaveBeenCalled();
		expect(toolCall.status).toBe("success");
	});
});
