/**
 * A connected repository whose credentials failed is not in the handler's
 * readable set, so an unfiltered `code_search`, `code_file_get` or `code_tree`
 * used to skip it silently and answer "no matches" / "not found" / "no files"
 * for a repository it never looked in. It is now reported with its reason,
 * and the answer never claims the code, file or directory is absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	repos: [] as Array<Record<string, unknown>>,
	searchRepositoryCode: vi.fn(),
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: vi.fn(),
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
	getRepositoryFile: h.getRepositoryFile,
	listRepositoryStructure: h.listRepositoryStructure,
}));

const GOOD = {
	provider: "GITHUB",
	owner: "example-org",
	repo: "app",
	branch: "main",
};
/** Connected, but its token cannot be resolved. */
const BAD = {
	provider: "GITHUB",
	owner: "example-org",
	repo: "broken",
	branch: "main",
};
/** Connected, but a provider code reads do not support. */
const ODD = {
	provider: "SOMETHING_ELSE",
	owner: "example-org",
	repo: "odd",
	branch: "main",
};
const CREDENTIALS_REASON =
	"connected to this project, but its credentials could not be used.";
const PROVIDER_REASON =
	"connected to this project, but its provider is not supported for code reads.";
const FORBIDDEN = {
	kind: "forbidden",
	status: 403,
	message:
		"The repository credentials do not have access to this (HTTP 403).",
};

async function run(tool: string, args: Record<string, unknown>) {
	const { CodeSearchHandler } = await import(
		"../../src/activities/orchestrator/execution/handlers/code-search-handler"
	);
	const result = await new CodeSearchHandler().execute({
		input: {
			step: { id: "step-1", app: tool, inputs: args },
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		} as never,
		variables: {},
		toolCalls: [] as never,
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
	h.repos = [GOOD, BAD];
	h.resolveToken.mockImplementation(async (repo: { repo: string }) => ({
		token: repo.repo === "broken" ? null : "token-example",
		method: "pat",
	}));
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("code_search: an unusable connected repository is not 'no matches'", () => {
	it("one readable repository with no matches, one unreadable: names it, not proof of absence", async () => {
		h.searchRepositoryCode.mockResolvedValue({ results: [] });
		const { text, toolCall } = await run("code_search", {
			mode: "api",
			query: "login",
		});

		expect(h.searchRepositoryCode).toHaveBeenCalledTimes(1);
		expect(text).toContain("in the repositories that could be searched");
		expect(text).toContain(`example-org/broken: ${CREDENTIALS_REASON}`);
		expect(text).toContain("not proof that the code does not exist");
		expect(text).not.toBe('No code matches found for "login".');
		expect(toolCall.status).toBe("success");
		expect(toolCall.result).toMatchObject({
			reposSearched: 1,
			failedRepos: 1,
		});
	});

	it("an unsupported provider is named too", async () => {
		h.repos = [GOOD, ODD];
		h.searchRepositoryCode.mockResolvedValue({ results: [] });
		const { text } = await run("code_search", {
			mode: "api",
			query: "login",
		});

		expect(text).toContain(`example-org/odd: ${PROVIDER_REASON}`);
	});

	it("matches in the readable repository plus the unreadable one in a note", async () => {
		h.searchRepositoryCode.mockResolvedValue({
			results: [
				{
					filePath: "src/auth.ts",
					matchedSnippets: ["export function login() {}"],
				},
			],
		});
		const { text } = await run("code_search", {
			mode: "api",
			query: "login",
		});

		expect(text).toContain("export function login() {}");
		expect(text).toContain(
			`\n\nCould not search example-org/broken: ${CREDENTIALS_REASON}`,
		);
	});

	it("the readable repository's search failed and the other is unusable: error status", async () => {
		h.searchRepositoryCode.mockResolvedValue({
			results: [],
			error: FORBIDDEN,
		});
		const { text, toolCall } = await run("code_search", {
			mode: "api",
			query: "login",
		});

		expect(text).toContain('Could not search for "login".');
		expect(text).toContain(`example-org/app: ${FORBIDDEN.message}`);
		expect(text).toContain(`example-org/broken: ${CREDENTIALS_REASON}`);
		expect(text).not.toContain("No code matches");
		expect(toolCall.status).toBe("error");
		expect(toolCall.result).toEqual({ message: text });
	});

	it("a filter that matches only the readable repository does not report the other", async () => {
		h.searchRepositoryCode.mockResolvedValue({ results: [] });
		const { text } = await run("code_search", {
			mode: "api",
			query: "login",
			repo: "example-org/app",
		});

		expect(text).toBe('No code matches found for "login".');
	});

	it("indexed mode never ran the API search, so it reports no unusable repository", async () => {
		const { toolCall } = await run("code_search", {
			mode: "indexed",
			query: "login",
		});

		expect(h.searchRepositoryCode).not.toHaveBeenCalled();
		expect(toolCall.status).toBe("success");
		expect(toolCall.result).not.toHaveProperty("failedRepos");
	});
});

describe("code_file_get: an unusable connected repository is not 'not found'", () => {
	const notFound = {
		path: "src/a.ts",
		content: "",
		size: 0,
		encoding: "none",
		isBinary: false,
		isTruncated: false,
		error: {
			kind: "not_found",
			status: 404,
			message: "Not found (HTTP 404).",
		},
	};

	it("not found in the readable repository, unreadable elsewhere: a read failure naming it", async () => {
		h.getRepositoryFile.mockResolvedValue(notFound);
		const { text, toolCall } = await run("code_file_get", {
			path: "src/a.ts",
		});

		expect(h.getRepositoryFile).toHaveBeenCalledTimes(1);
		expect(text).toContain("Could not read src/a.ts.");
		expect(text).toContain(`example-org/broken: ${CREDENTIALS_REASON}`);
		expect(text).toContain(
			"This is a read failure, not proof that the file does not exist.",
		);
		// The readable repository really was checked.
		expect(text).toContain(
			"The file was not found in the other connected repositories.",
		);
		expect(text).not.toContain("not found in any connected repository");
		expect(toolCall.status).toBe("error");
	});

	it("an unsupported provider is named too", async () => {
		h.repos = [GOOD, ODD];
		h.getRepositoryFile.mockResolvedValue(notFound);
		const { text } = await run("code_file_get", { path: "src/a.ts" });

		expect(text).toContain(`example-org/odd: ${PROVIDER_REASON}`);
	});

	it("does not say 'other repositories' when the only checked repository failed", async () => {
		h.getRepositoryFile.mockResolvedValue({
			...notFound,
			error: FORBIDDEN,
		});
		const { text } = await run("code_file_get", { path: "src/a.ts" });

		expect(text).toContain(`example-org/app: ${FORBIDDEN.message}`);
		expect(text).toContain(`example-org/broken: ${CREDENTIALS_REASON}`);
		expect(text).not.toContain("not found in the other connected");
	});

	it("a file found in the readable repository is returned as before", async () => {
		h.getRepositoryFile.mockResolvedValue({
			path: "src/a.ts",
			content: "export {};",
			size: 10,
			encoding: "utf-8",
			isBinary: false,
			isTruncated: false,
		});
		const { text, toolCall } = await run("code_file_get", {
			path: "src/a.ts",
		});

		expect(text).toContain("export {};");
		expect(text).not.toContain("broken");
		expect(toolCall.status).toBe("success");
	});
});

describe("code_tree: an unusable connected repository is not 'no files'", () => {
	const emptyTree = {
		entries: [],
		totalFiles: 0,
		totalDirectories: 0,
		truncated: false,
	};

	it("an empty listing from the readable repository, unreadable elsewhere: a read failure naming it", async () => {
		h.listRepositoryStructure.mockResolvedValue(emptyTree);
		const { text, toolCall } = await run("code_tree", {});

		expect(h.listRepositoryStructure).toHaveBeenCalledTimes(1);
		expect(text).toContain("Could not list the repository structure.");
		expect(text).toContain(`example-org/broken: ${CREDENTIALS_REASON}`);
		expect(text).not.toContain("No files found");
		expect(toolCall.status).toBe("error");
	});

	it("an unsupported provider is named too", async () => {
		h.repos = [GOOD, ODD];
		h.listRepositoryStructure.mockResolvedValue(emptyTree);
		const { text } = await run("code_tree", {});

		expect(text).toContain(`example-org/odd: ${PROVIDER_REASON}`);
	});

	it("a listing with files shows them, then the unreadable repository in the failure note", async () => {
		h.listRepositoryStructure.mockResolvedValue({
			entries: [{ path: "src/a.ts", type: "file" }],
			totalFiles: 1,
			totalDirectories: 0,
			truncated: false,
		});
		const { text, toolCall } = await run("code_tree", {});

		expect(text).toContain("src/a.ts");
		expect(text).toContain(
			`\n\nCould not list example-org/broken: ${CREDENTIALS_REASON}`,
		);
		expect(toolCall.status).toBe("success");
	});
});
