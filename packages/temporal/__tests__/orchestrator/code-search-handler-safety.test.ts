/**
 * The repository reads behind the Advisor's `code_*` tools, through
 * `runFabricCatalogTool` (what the chat loop calls):
 *
 * - no exception text reaches the model or the logs (tokens hide there);
 * - a listing page stays under the loop's result cap with its range line;
 * - a tree the provider truncated is never reported as complete or empty,
 *   and "narrow with directory" is offered only where that fetches a subtree;
 * - a folder path is a folder, an empty file is empty;
 * - the repository filter is case-insensitive, and an unknown repository is
 *   "not connected", never "not found" / "no files" / "no matches".
 */
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	repos: [] as Array<Record<string, unknown>>,
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: vi.fn(),
	searchRepositoryCode: vi.fn(),
	resolveToken: vi.fn(),
	/** The project's legacy repository columns (null: none). */
	project: null as Record<string, unknown> | null,
	/** The caller's newest active WorkflowIntegration row (null: none). */
	integration: null as Record<string, unknown> | null,
	gitHubToken: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	db: {
		project: { findUnique: vi.fn(async () => h.project) },
		workflowIntegration: { findFirst: vi.fn(async () => h.integration) },
	},
	getProjectCodeIndexes: vi.fn().mockResolvedValue([]),
	getProjectReposForCodeSearch: vi.fn(async () => h.repos),
	// The real shared parser (its module's db client is lazy, so nothing
	// connects).
	parseRepoUrl: (
		await vi.importActual<
			typeof import("../../../database/prisma/queries/project-repository-integrations")
		>("../../../database/prisma/queries/project-repository-integrations")
	).parseRepoUrl,
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: h.resolveToken,
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubAccessToken: h.gitHubToken,
}));
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: h.searchRepositoryCode,
	getRepositoryFile: h.getRepositoryFile,
	listRepositoryStructure: h.listRepositoryStructure,
}));

const { runFabricCatalogTool } = await import(
	"../../src/activities/orchestrator/execution/fabric-catalog-adapter"
);
const { TOOL_RESULTS } = await import(
	"../../src/workflows/orchestrator/orchestrator-config"
);

const SECRET = "ghp_EXAMPLESECRET0123456789abcdefABCDEF";
const GITHUB_REPO = {
	provider: "GITHUB",
	owner: "example-org",
	repo: "app",
	branch: "main",
};
const ADO_REPO = {
	provider: "AZURE_DEVOPS",
	owner: "example-org",
	repo: "service",
	branch: "main",
	repositoryUrl:
		"https://dev.azure.com/example-org/example-project/_git/service",
};

/**
 * `code_search` in the chat is Direct's builder (the catalog's
 * direct-builder route), so the plan-mode handler's own `code_search` is
 * driven through the handler directly; the other two go through the adapter
 * exactly as the chat loop calls them.
 */
async function call(toolName: string, args: Record<string, unknown>) {
	if (toolName === "code_search") {
		const { CodeSearchHandler } = await import(
			"../../src/activities/orchestrator/execution/handlers/code-search-handler"
		);
		const result = await new CodeSearchHandler().execute({
			input: {
				step: { id: "step-1", app: toolName, inputs: args },
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
			} as never,
			variables: {},
			toolCalls: [],
			startTime: 0,
		});
		const output = result.output;
		const failed =
			!result.handled || output?.toolCalls?.at(-1)?.status === "error";
		const text = String(output?.response ?? result.error ?? "");
		return failed
			? { success: false as const, error: text, text }
			: { success: true as const, output: text, text };
	}
	const res = await runFabricCatalogTool({
		toolName,
		args,
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
	});
	return {
		...res,
		text: String(
			res.success ? (res as { output: unknown }).output : res.error,
		),
	};
}

function tree(paths: string[], truncated = false) {
	return {
		entries: paths.map((path) => ({ path, type: "file" as const })),
		totalFiles: paths.length,
		totalDirectories: 0,
		truncated,
	};
}

let logged: () => string;

beforeEach(() => {
	vi.clearAllMocks();
	h.project = null;
	h.integration = null;
	h.gitHubToken.mockResolvedValue(null);
	h.repos = [GITHUB_REPO];
	h.resolveToken.mockResolvedValue({ token: "token-example", method: "pat" });
	h.searchRepositoryCode.mockResolvedValue({ results: [] });
	const spies = [
		vi.spyOn(console, "error").mockImplementation(() => {}),
		vi.spyOn(console, "warn").mockImplementation(() => {}),
		vi.spyOn(console, "log").mockImplementation(() => {}),
	];
	logged = () =>
		spies
			.flatMap((spy) => spy.mock.calls.flat())
			.map((arg) => inspect(arg, { depth: 6 }))
			.join("\n");
});
afterEach(() => vi.restoreAllMocks());

describe("fix 1: no exception text reaches the model or the logs", () => {
	const leak = () =>
		new Error(`fetch failed for https://example.com/?token=${SECRET}`);

	it.each([
		["code_file_get", { path: "src/a.ts" }],
		["code_tree", {}],
		["code_search", { query: "login" }],
	] as const)("%s: a thrown read", async (tool, args) => {
		h.getRepositoryFile.mockRejectedValue(leak());
		h.listRepositoryStructure.mockRejectedValue(leak());
		h.searchRepositoryCode.mockRejectedValue(leak());
		const { text } = await call(tool, args);
		expect(text).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});

	it("a thrown credential lookup (the handler's outer catch)", async () => {
		h.resolveToken.mockRejectedValue(leak());
		const { text, success } = await call("code_tree", {});
		expect(success).toBe(false);
		expect(text).not.toContain(SECRET);
		expect(logged()).not.toContain(SECRET);
	});
});

describe("fix 3: a listing page stays under the loop's cap", () => {
	it("500 long paths come back as one bounded page with its range line", async () => {
		const longPaths = Array.from(
			{ length: 500 },
			(_, i) =>
				`packages/example-feature-area/src/components/deeply/nested/module-${String(i).padStart(4, "0")}/index.tsx`,
		);
		h.listRepositoryStructure.mockResolvedValue(tree(longPaths));
		const { text } = await call("code_tree", {});
		expect(text.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars - 2_000);
		const range = text.match(/Showing entries 1–(\d+) of 500/);
		expect(range).not.toBeNull();
		expect(text).toContain(`offset=${range?.[1]}`);
	});
});

describe("fix 4: a tree the provider truncated", () => {
	it("a directory filter that matches nothing is incomplete, not 'No files found'", async () => {
		h.listRepositoryStructure.mockResolvedValue(tree([], true));
		const { text } = await call("code_tree", { directory: "src/missing" });
		expect(text).not.toContain("No files found");
		expect(text).toMatch(/truncated/i);
		expect(text).toMatch(/incomplete/i);
	});

	it("a past-end offset keeps the warning", async () => {
		h.listRepositoryStructure.mockResolvedValue(
			tree(["a.ts", "b.ts"], true),
		);
		const { text } = await call("code_tree", { offset: 50 });
		expect(text).toContain("past the end");
		expect(text).toMatch(/truncated/i);
	});

	it("GitHub (whole tree, filtered here): no 'narrow with directory' advice", async () => {
		h.listRepositoryStructure.mockResolvedValue(
			tree(["a.ts", "b.ts"], true),
		);
		const { text } = await call("code_tree", {});
		expect(text).toMatch(/truncated/i);
		expect(text).not.toMatch(/narrow/i);
	});

	it("Azure DevOps (fetches the subtree): following the directory advice lists new entries", async () => {
		h.repos = [ADO_REPO];
		h.listRepositoryStructure.mockImplementation(
			async (params: { directory?: string }) =>
				params.directory === "src/deep"
					? tree(["src/deep/x.ts", "src/deep/y.ts"])
					: tree(["README.md", "src/a.ts"], true),
		);
		const first = await call("code_tree", {});
		expect(first.text).toMatch(/narrow it with directory/i);
		const second = await call("code_tree", { directory: "src/deep" });
		expect(second.text).toContain("src/deep/x.ts");
		expect(first.text).not.toContain("src/deep/x.ts");
		expect(h.listRepositoryStructure).toHaveBeenLastCalledWith(
			expect.objectContaining({ directory: "src/deep" }),
		);
	});
});

describe("fix 7: folders and empty files", () => {
	it("a folder path gets the folder message", async () => {
		h.getRepositoryFile.mockResolvedValue({
			path: "src",
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			error: { kind: "not_a_file", message: "Not a file." },
		});
		const { text } = await call("code_file_get", { path: "src" });
		expect(text).toContain("src is a directory");
		expect(text).toContain("code_tree");
		expect(text).not.toMatch(/not found|binary/i);
	});

	it("an empty file is reported as empty", async () => {
		h.getRepositoryFile.mockResolvedValue({
			path: "empty.txt",
			content: "",
			size: 0,
			encoding: "utf-8",
			isBinary: false,
			isTruncated: false,
		});
		const { text } = await call("code_file_get", { path: "empty.txt" });
		expect(text).toContain("exists and is empty");
	});
});

describe("fix 8: the repository filter", () => {
	it("matches owner/repo regardless of case and surrounding space", async () => {
		h.getRepositoryFile.mockResolvedValue({
			path: "src/a.ts",
			content: "export {};",
			size: 10,
			encoding: "utf-8",
			isBinary: false,
			isTruncated: false,
		});
		const { text, success } = await call("code_file_get", {
			path: "src/a.ts",
			repo: "  Example-Org/APP ",
		});
		expect(success).toBe(true);
		expect(text).toContain("export {};");
	});

	it.each([
		["code_file_get", { path: "src/a.ts" }],
		["code_tree", {}],
		["code_search", { query: "login" }],
	] as const)(
		"%s: an unknown repository is 'not connected'",
		async (tool, args) => {
			const res = await call(tool, { ...args, repo: "other-org/other" });
			expect(res.success).toBe(false);
			expect(res.text).toBe(
				"Repository other-org/other is not connected to this project. Connected: example-org/app.",
			);
			expect(h.getRepositoryFile).not.toHaveBeenCalled();
			expect(h.listRepositoryStructure).not.toHaveBeenCalled();
			expect(h.searchRepositoryCode).not.toHaveBeenCalled();
		},
	);
});

// ---------------------------------------------------------------------------
// Round 2.
// ---------------------------------------------------------------------------

async function runHandler(toolName: string, args: Record<string, unknown>) {
	const { CodeSearchHandler } = await import(
		"../../src/activities/orchestrator/execution/handlers/code-search-handler"
	);
	const result = await new CodeSearchHandler().execute({
		input: {
			step: { id: "step-1", app: toolName, inputs: args },
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		} as never,
		variables: {},
		toolCalls: [],
		startTime: 0,
	});
	return result.output;
}

const BUDGET = TOOL_RESULTS.maxChars - 2_000;

function longPath(repo: number, i: number): string {
	return `repo-${repo}/${"segment/".repeat(108)}file-${String(i).padStart(3, "0")}.ts`;
}

describe("round 2 fix 1: many repositories stay within the listing budget", () => {
	it("12 repositories with two 882-character paths each", async () => {
		h.repos = Array.from({ length: 12 }, (_, i) => ({
			provider: "GITHUB",
			owner: "example-org",
			repo: `app-${i}`,
			branch: "main",
		}));
		h.listRepositoryStructure.mockImplementation(
			async (params: { repo: string }) => {
				const n = Number(params.repo.split("-")[1]);
				return tree([longPath(n, 0), longPath(n, 1)]);
			},
		);
		expect(longPath(0, 0)).toHaveLength(882);

		const { text } = await call("code_tree", {});

		expect(text.length).toBeLessThanOrEqual(BUDGET);
		// Every repository is either listed or named for a separate request.
		for (let i = 0; i < 12; i++) {
			const listed = text.includes(`## example-org/app-${i}\n`);
			const named = text.includes(`repo="example-org/app-${i}"`);
			expect(listed || named).toBe(true);
		}
	});

	it("lists a repository whose paths are longer than its share, shortened", async () => {
		h.repos = [
			{
				provider: "GITHUB",
				owner: "example-org",
				repo: "small",
				branch: "main",
			},
			{
				provider: "GITHUB",
				owner: "example-org",
				repo: "huge",
				branch: "main",
			},
		];
		h.listRepositoryStructure.mockImplementation(
			async (params: { repo: string }) =>
				params.repo === "small"
					? tree(["src/a.ts", "src/b.ts"])
					: tree(
							Array.from(
								{ length: 3 },
								(_, i) =>
									`${"deep/".repeat(2_100)}file-${i}.ts`,
							),
						),
		);

		const { text } = await call("code_tree", {});

		expect(text.length).toBeLessThanOrEqual(BUDGET);
		expect(text).toContain("src/a.ts");
		// Each 10,510-character path is shortened in the middle, keeping
		// its start and its file name, rather than leaving the repository
		// out (it used to be named for a separate request that could not
		// list it either).
		expect(text).toContain("## example-org/huge\n");
		expect(text).not.toContain("Not listed");
		const pathLength = `${"deep/".repeat(2_100)}file-0.ts`.length;
		for (let i = 0; i < 3; i++) {
			expect(text).toMatch(
				new RegExp(
					`📄 deep/[^\\n]*…[^\\n]*file-${i}\\.ts \\[path shortened from ${pathLength} characters\\]`,
				),
			);
		}
		expect(text).not.toContain("deep/".repeat(2_100));
	});
});

describe("round 2 fix 1: the budget holds at scale", () => {
	it("300 repositories, half failing, stay within the budget", async () => {
		h.repos = Array.from({ length: 300 }, (_, i) => ({
			provider: "GITHUB",
			owner: "example-org",
			repo: `svc-${i}`,
			branch: "main",
		}));
		h.listRepositoryStructure.mockImplementation(
			async (params: { repo: string }) =>
				Number(params.repo.split("-")[1]) % 2 === 0
					? tree([
							`${params.repo}/src/index.ts`,
							`${params.repo}/README.md`,
						])
					: {
							...tree([]),
							error: {
								kind: "forbidden",
								status: 403,
								message:
									"The repository credentials do not have access to this (HTTP 403).",
							},
						},
		);
		const { text } = await call("code_tree", {});
		expect(text.length).toBeLessThanOrEqual(BUDGET);
		expect(text).toMatch(/… and \d+ more/);
	});
});

describe("round 2 fix 3: symlinks and submodules are not directories", () => {
	it.each([
		["dir", /is a directory/, true],
		["symlink", /is a symbolic link, not a regular file/, false],
		["submodule", /is a git submodule[^.]*, not a regular file/, false],
	] as const)("%s", async (objectType, message, isDirectory) => {
		h.getRepositoryFile.mockResolvedValue({
			path: "vendor/lib",
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			error: { kind: "not_a_file", objectType, message: "Not a file." },
		});
		const output = await runHandler("code_file_get", {
			path: "vendor/lib",
		});
		const text = String(output?.response);
		expect(text).toMatch(message);
		const recorded = output?.toolCalls?.at(-1)?.result as
			| Record<string, unknown>
			| undefined;
		if (isDirectory) {
			expect(text).toContain("code_tree");
			expect(recorded?.isDirectory).toBe(true);
		} else {
			expect(text).not.toContain("code_tree");
			expect(text).not.toMatch(/directory/i);
			expect(recorded?.isDirectory).toBeUndefined();
		}
	});
});

describe("round 2 fix 5: Azure DevOps repository URLs match the connected repository", () => {
	it.each([
		"https://example-org.visualstudio.com/example-project/_git/service",
		"https://dev.azure.com/example-org/example-project/_git/service",
	])("%s", async (url) => {
		h.repos = [ADO_REPO];
		h.listRepositoryStructure.mockResolvedValue(tree(["src/a.ts"]));
		const res = await call("code_tree", { repo: url });
		expect(res.success).toBe(true);
		expect(res.text).toContain("src/a.ts");
	});
});

describe("round 3 fix 1: membership comes from the project's rows, not from readable credentials", () => {
	const A = {
		provider: "GITHUB",
		owner: "example-org",
		repo: "repo-a",
		branch: "main",
	};
	const B = {
		provider: "GITHUB",
		owner: "example-org",
		repo: "repo-b",
		branch: "main",
	};

	beforeEach(() => {
		h.repos = [A, B];
		// Only A's credentials resolve.
		h.resolveToken.mockImplementation(async (row: { repo: string }) =>
			row.repo === "repo-a"
				? { token: "token-example", method: "pat" }
				: { token: null, method: "none" },
		);
		h.listRepositoryStructure.mockResolvedValue(tree(["src/a.ts"]));
	});

	it.each([
		["code_file_get", { path: "src/a.ts" }],
		["code_tree", {}],
		["code_search", { query: "login" }],
	] as const)(
		"%s: a connected repository whose credentials fail is 'unreadable', not 'not connected'",
		async (tool, args) => {
			const res = await call(tool, {
				...args,
				repo: "example-org/repo-b",
			});
			expect(res.success).toBe(false);
			expect(res.text).toBe(
				"Repository example-org/repo-b is connected to this project, but its credentials could not be used. Reconnect it in the project's repository settings.",
			);
			expect(h.getRepositoryFile).not.toHaveBeenCalled();
			expect(h.listRepositoryStructure).not.toHaveBeenCalled();
			expect(h.searchRepositoryCode).not.toHaveBeenCalled();
		},
	);

	it.each([
		["code_file_get", { path: "src/a.ts" }],
		["code_tree", {}],
		["code_search", { query: "login" }],
	] as const)(
		"%s: an unknown repository lists every connected repository",
		async (tool, args) => {
			const res = await call(tool, { ...args, repo: "other-org/other" });
			expect(res.success).toBe(false);
			expect(res.text).toBe(
				"Repository other-org/other is not connected to this project. Connected: example-org/repo-a, example-org/repo-b.",
			);
		},
	);
});

describe("round 4 fix 1: a legacy repository stays connected beside a readable integration", () => {
	const A = {
		provider: "GITHUB",
		owner: "example-org",
		repo: "repo-a",
		branch: "main",
	};

	beforeEach(() => {
		h.repos = [A];
		h.project = {
			repositoryUrl: "https://github.com/example-org/repo-b",
			repositoryOwner: "example-org",
			repositoryName: "repo-b",
			defaultBranch: "main",
		};
		h.listRepositoryStructure.mockResolvedValue(tree(["src/b.ts"]));
	});

	it.each([
		["code_file_get", { path: "src/b.ts" }],
		["code_tree", {}],
		["code_search", { query: "login" }],
	] as const)(
		"%s: legacy B without usable credentials is 'connected, credentials could not be used'",
		async (tool, args) => {
			const res = await call(tool, {
				...args,
				repo: "example-org/repo-b",
			});
			expect(res.success).toBe(false);
			expect(res.text).toBe(
				"Repository example-org/repo-b is connected to this project, but its credentials could not be used. Reconnect it in the project's repository settings.",
			);
		},
	);

	it("legacy B is read when its own credentials resolve", async () => {
		h.gitHubToken.mockResolvedValue("token-legacy");
		const res = await call("code_tree", { repo: "example-org/repo-b" });
		expect(res.success).toBe(true);
		expect(res.text).toContain("src/b.ts");
		expect(h.listRepositoryStructure).toHaveBeenCalledWith(
			expect.objectContaining({ repo: "repo-b", token: "token-legacy" }),
		);
	});

	describe("a failed legacy lookup leaves A readable", () => {
		it.each([
			["code_tree naming A", { repo: "example-org/repo-a" }],
			["code_tree by default", {}],
		] as const)(
			"B's credential lookup throws: %s still reads A",
			async (_label, args) => {
				h.gitHubToken.mockRejectedValue(new Error(`db down ${SECRET}`));
				h.listRepositoryStructure.mockResolvedValue(tree(["src/a.ts"]));
				const warn = vi
					.spyOn(console, "warn")
					.mockImplementation(() => {});
				const res = await call("code_tree", args);
				expect(res.success).toBe(true);
				expect(res.text).toContain("src/a.ts");
				expect(h.listRepositoryStructure).toHaveBeenCalledWith(
					expect.objectContaining({ repo: "repo-a" }),
				);
				expect(inspect(warn.mock.calls, { depth: 8 })).not.toContain(
					SECRET,
				);
			},
		);

		it("the legacy row lookup throws: a request naming A still reads A", async () => {
			const { db } = await import("@repo/database");
			vi.mocked(db.project.findUnique).mockRejectedValueOnce(
				new Error(`db down ${SECRET}`),
			);
			h.listRepositoryStructure.mockResolvedValue(tree(["src/a.ts"]));
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const res = await call("code_tree", { repo: "example-org/repo-a" });
			expect(res.success).toBe(true);
			expect(res.text).toContain("src/a.ts");
		});

		const LOOKUP_FAILED =
			"Could not check this project's repository connections; try again shortly.";
		const failRowLookup = async () => {
			const { db } = await import("@repo/database");
			vi.mocked(db.project.findUnique).mockRejectedValueOnce(
				new Error("db down"),
			);
			vi.spyOn(console, "warn").mockImplementation(() => {});
		};

		it.each([
			["code_file_get", { path: "src/b.ts" }],
			["code_tree", {}],
			["code_search", { query: "login" }],
		] as const)(
			"the legacy row lookup throws: %s naming B cannot check, never 'not connected'",
			async (tool, args) => {
				await failRowLookup();
				const res = await call(tool, {
					...args,
					repo: "example-org/repo-b",
				});
				expect(res.success).toBe(false);
				expect(res.text).toBe(LOOKUP_FAILED);
			},
		);

		it("the legacy row lookup throws with no integration rows: cannot check, never 'no credentials'", async () => {
			h.repos = [];
			await failRowLookup();
			const res = await call("code_tree", {});
			expect(res.success).toBe(false);
			expect(res.text).toBe(LOOKUP_FAILED);
		});

		it("the legacy row lookup throws: a default file read that misses in A is scoped and says it may be incomplete", async () => {
			await failRowLookup();
			h.getRepositoryFile.mockResolvedValue({
				path: "target.ts",
				content: "",
				size: 0,
				encoding: "utf-8",
				isBinary: false,
				isTruncated: false,
				error: { kind: "not_found", status: 404, message: "Not found" },
			});
			const res = await call("code_file_get", { path: "target.ts" });
			expect(res.success).toBe(false);
			expect(res.text).not.toContain(
				"not found in any connected repository",
			);
			expect(res.text).toContain(
				`This result may be incomplete: ${LOOKUP_FAILED}`,
			);
		});

		it("the legacy row lookup throws: a default read of A says it may be incomplete", async () => {
			await failRowLookup();
			h.listRepositoryStructure.mockResolvedValue(tree(["src/a.ts"]));
			const res = await call("code_tree", {});
			expect(res.success).toBe(true);
			expect(res.text).toContain("src/a.ts");
			expect(res.text).toContain(
				`This result may be incomplete: ${LOOKUP_FAILED}`,
			);
		});
	});

	it("an unknown repository lists A and legacy B", async () => {
		const res = await call("code_tree", { repo: "other-org/other" });
		expect(res.text).toBe(
			"Repository other-org/other is not connected to this project. Connected: example-org/repo-a, example-org/repo-b.",
		);
	});
});

describe("round 4 fix 2: a legacy repository on an unsupported provider", () => {
	beforeEach(() => {
		h.repos = [];
		h.project = {
			repositoryUrl: "https://gitlab.com/example-org/legacy-app",
			repositoryOwner: "example-org",
			repositoryName: "legacy-app",
			defaultBranch: "main",
		};
		// A usable GitLab credential exists: it must not be looked up or used.
		h.integration = { credentials: { token: "gitlab-token-example" } };
	});

	const UNSUPPORTED =
		"Repository example-org/legacy-app is connected to this project, but its provider is not supported for code reads.";

	it.each([
		["code_file_get", { path: "src/a.ts" }],
		["code_tree", {}],
		["code_search", { query: "login" }],
	] as const)(
		"%s: named, gives the unsupported-provider message",
		async (tool, args) => {
			const res = await call(tool, {
				...args,
				repo: "example-org/legacy-app",
			});
			expect(res.success).toBe(false);
			expect(res.text).toBe(UNSUPPORTED);
			expect(h.getRepositoryFile).not.toHaveBeenCalled();
			expect(h.listRepositoryStructure).not.toHaveBeenCalled();
			expect(h.searchRepositoryCode).not.toHaveBeenCalled();
		},
	);

	it.each([
		["code_file_get", { path: "src/a.ts" }],
		["code_tree", {}],
		["code_search", { query: "login" }],
	] as const)(
		"%s: unnamed, gives the unsupported-provider message",
		async (tool, args) => {
			const res = await call(tool, args);
			expect(res.success).toBe(false);
			expect(res.text).toBe(UNSUPPORTED);
			expect(h.getRepositoryFile).not.toHaveBeenCalled();
			expect(h.listRepositoryStructure).not.toHaveBeenCalled();
			expect(h.searchRepositoryCode).not.toHaveBeenCalled();
		},
	);
});
