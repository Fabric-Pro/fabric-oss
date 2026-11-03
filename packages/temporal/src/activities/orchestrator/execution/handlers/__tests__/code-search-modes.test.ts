/**
 * The code tools follow the project's one code search mode (spec 2026-10-29
 * code-index-sync §6a): OFF reaches nothing, CODE_SEARCH searches the
 * provider only, RAG searches the code index only and names each included
 * repository whose index is not ready. A repository excluded from AI code
 * search is never touched. Multi-repository reads run in parallel and keep
 * the repositories' order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	mode: "RAG" as string,
	repos: [] as Array<Record<string, unknown>>,
	indexes: [] as Array<{
		repositoryIntegrationId: string | null;
		status: string;
	}>,
	getRepos: vi.fn(),
	getIndexes: vi.fn(),
	search: vi.fn(),
	getFile: vi.fn(),
	listTree: vi.fn(),
	query: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn(async () => null) },
		workflowIntegration: { findFirst: vi.fn(async () => null) },
	},
	getProjectAccessContext: vi.fn(async () => ({
		organizationId: "org-example-1",
	})),
	getProjectRagSettings: vi.fn(async () => ({ codeSearchMode: h.mode })),
	getProjectReposForCodeSearch: h.getRepos,
	getProjectCodeIndexes: h.getIndexes,
	parseRepoUrl: vi.fn(() => null),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi.fn(async () => ({
		token: "token-example",
		method: "pat",
	})),
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubAccessToken: vi.fn(),
}));
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: h.search,
	getRepositoryFile: h.getFile,
	listRepositoryStructure: h.listTree,
}));
vi.mock("@repo/rag/lib/embedding", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
}));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	ensureCollection: vi.fn(async () => "project-contexts-example"),
	getCollectionLayout: vi.fn(async () => ({ supportsHybrid: false })),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { query: h.query },
}));

const { CodeSearchHandler } = await import("../code-search-handler");

function repoRow(integrationId: string, name: string, included = true) {
	return {
		integrationId,
		provider: "GITHUB",
		owner: "example-org",
		repo: name,
		branch: "main",
		repositoryUrl: `https://github.com/example-org/${name}`,
		includedInCodeSearch: included,
	};
}

async function run(tool: string, inputs: Record<string, unknown>) {
	const result = await new CodeSearchHandler().execute({
		input: {
			step: {
				id: `chat-${tool}`,
				description: `Run ${tool}`,
				type: "api",
				status: "in_progress",
				order: 1,
				app: tool,
				executor: tool,
				inputs,
			},
			message: "",
			systemPrompt: "",
			variables: {},
			userId: "user-example-1",
			organizationId: "org-example-1",
			projectId: "project-example-1",
			executionMode: "iterative",
			totalSteps: 1,
			stepIndex: 1,
			previousStepResults: [],
		},
		variables: {},
		toolCalls: [],
		startTime: Date.now(),
	});
	return {
		response: result.output?.response ?? "",
		status: result.output?.toolCalls?.at(-1)?.status,
	};
}

/** Every repository name any connector call was made for. */
function touchedRepos(): string[] {
	return [h.search, h.getFile, h.listTree].flatMap((fn) =>
		fn.mock.calls.map(([args]) => (args as { repo: string }).repo),
	);
}

/** A promise with its resolver, to control which read finishes first. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	h.mode = "RAG";
	h.repos = [
		repoRow("ri-api", "api"),
		repoRow("ri-web", "web"),
		repoRow("ri-secret", "secret-repo", false),
	];
	h.indexes = [
		{ repositoryIntegrationId: "ri-api", status: "READY" },
		{ repositoryIntegrationId: "ri-web", status: "INDEXING" },
		{ repositoryIntegrationId: "ri-secret", status: "READY" },
	];
	h.getRepos.mockImplementation(async () => h.repos);
	h.getIndexes.mockImplementation(async () => h.indexes);
	h.search.mockResolvedValue({
		results: [{ filePath: "src/auth.ts", matchedSnippets: ["login()"] }],
	});
	h.query.mockResolvedValue({
		points: [
			{
				payload: {
					repositoryIntegrationId: "ri-api",
					filePath: "src/auth.ts",
					content: "export function login() {}",
				},
			},
		],
	});
});

describe("OFF", () => {
	it.each([
		["code_search", { query: "login" }],
		["code_search_semantic", { query: "login" }],
		["code_file_get", { path: "src/auth.ts" }],
		["code_tree", {}],
	])(
		"%s says code search is off and touches nothing",
		async (tool, inputs) => {
			h.mode = "OFF";
			const { response, status } = await run(tool, inputs);
			expect(response).toContain("Code search is off for this project");
			expect(response).toContain("How AI agents search code");
			expect(status).toBe("success");
			expect(h.getRepos).not.toHaveBeenCalled();
			expect(touchedRepos()).toEqual([]);
			expect(h.query).not.toHaveBeenCalled();
		},
	);
});

describe("CODE_SEARCH", () => {
	it("code_search runs the provider search over included repositories only, never the index", async () => {
		h.mode = "CODE_SEARCH";
		const { response } = await run("code_search", { query: "login" });
		expect(touchedRepos().sort()).toEqual(["api", "web"]);
		expect(h.query).not.toHaveBeenCalled();
		expect(h.getIndexes).not.toHaveBeenCalled();
		expect(response).toContain("Found 2 code matches across 2 repo(s)");
		expect(response).not.toContain("secret-repo");
	});

	it("code_search_semantic points at code_search", async () => {
		h.mode = "CODE_SEARCH";
		const { response } = await run("code_search_semantic", {
			query: "login",
		});
		expect(response).toContain("uses live code search");
		expect(response).toContain("Use code_search");
		expect(h.query).not.toHaveBeenCalled();
		expect(touchedRepos()).toEqual([]);
	});

	it("a named excluded repository is not connected as far as the tools know", async () => {
		h.mode = "CODE_SEARCH";
		const { response, status } = await run("code_search", {
			query: "login",
			repo: "example-org/secret-repo",
		});
		expect(status).toBe("error");
		expect(response).toContain("is not connected to this project");
		expect(touchedRepos()).toEqual([]);
	});
});

describe("RAG", () => {
	it("code_search queries only the index, scoped to included ready repositories, and names the rest", async () => {
		const { response } = await run("code_search", { query: "login" });
		expect(h.search).not.toHaveBeenCalled();
		expect(h.query).toHaveBeenCalledTimes(1);
		const [, request] = h.query.mock.calls[0] as [
			string,
			{ filter: { must: unknown[] } },
		];
		expect(request.filter.must).toContainEqual({
			key: "repositoryIntegrationId",
			match: { any: ["ri-api"] },
		});
		expect(JSON.stringify(request.filter.must)).not.toContain("ri-secret");
		expect(response).toContain("example-org/api: src/auth.ts");
		expect(response).toContain("example-org/web: still indexing");
		expect(response).not.toContain("secret-repo");
	});

	it("reports failed and missing indexes per repository without any live fallback", async () => {
		h.indexes = [{ repositoryIntegrationId: "ri-api", status: "FAILED" }];
		const { response, status } = await run("code_search", {
			query: "login",
		});
		expect(status).toBe("success");
		expect(h.query).not.toHaveBeenCalled();
		expect(h.search).not.toHaveBeenCalled();
		expect(response).toContain(
			"example-org/api: indexing failed — reconnect it or re-index it",
		);
		expect(response).toContain("example-org/web: not indexed yet");
	});

	it("a named repository narrows the index search", async () => {
		h.indexes[1].status = "STALE";
		await run("code_search", { query: "login", repo: "web" });
		const [, request] = h.query.mock.calls[0] as [
			string,
			{ filter: { must: unknown[] } },
		];
		expect(request.filter.must).toContainEqual({
			key: "repositoryIntegrationId",
			match: { any: ["ri-web"] },
		});
	});

	it("code_search_semantic searches the index like code_search", async () => {
		const { response } = await run("code_search_semantic", {
			query: "login",
		});
		expect(h.search).not.toHaveBeenCalled();
		expect(h.query).toHaveBeenCalledTimes(1);
		expect(response).toContain("semantic code matches");
		expect(response).toContain("example-org/web: still indexing");
	});
});

describe.each(["CODE_SEARCH", "RAG"])("live reads in %s mode", (mode) => {
	it("code_file_get reads every included repository at once and the first in order wins", async () => {
		h.mode = mode;
		const api = deferred<unknown>();
		const web = deferred<unknown>();
		h.getFile.mockImplementation(({ repo }: { repo: string }) =>
			repo === "api" ? api.promise : web.promise,
		);
		const pending = run("code_file_get", { path: "README.md" });
		await vi.waitFor(() => expect(h.getFile).toHaveBeenCalledTimes(2));
		// The later repository answers first; the earlier one still wins.
		web.resolve({ path: "README.md", content: "web readme", size: 10 });
		api.resolve({ path: "README.md", content: "api readme", size: 10 });
		const { response } = await pending;
		expect(response).toContain("example-org/api: README.md");
		expect(response).toContain("api readme");
		expect(touchedRepos()).not.toContain("secret-repo");
	});

	it("code_file_get keeps the not-a-file and read-failure notes", async () => {
		h.mode = mode;
		h.getFile.mockImplementation(async ({ repo }: { repo: string }) =>
			repo === "api"
				? { error: { kind: "forbidden", message: "access denied" } }
				: { error: { kind: "not_a_file", objectType: "dir" } },
		);
		const { response } = await run("code_file_get", { path: "src" });
		expect(response).toContain("example-org/web: src is a directory");

		h.getFile.mockImplementation(async ({ repo }: { repo: string }) =>
			repo === "api"
				? { error: { kind: "forbidden", message: "access denied" } }
				: { error: { kind: "not_found", message: "missing" } },
		);
		const missing = await run("code_file_get", { path: "src/x.ts" });
		expect(missing.response).toContain("example-org/api: access denied");
		expect(missing.response).toContain(
			"The file was not found in the other connected repositories.",
		);
	});

	it("code_tree lists every included repository at once, in order", async () => {
		h.mode = mode;
		const api = deferred<unknown>();
		const web = deferred<unknown>();
		h.listTree.mockImplementation(({ repo }: { repo: string }) =>
			repo === "api" ? api.promise : web.promise,
		);
		const pending = run("code_tree", {});
		await vi.waitFor(() => expect(h.listTree).toHaveBeenCalledTimes(2));
		web.resolve({
			entries: [{ path: "web.ts", type: "file" }],
			totalFiles: 1,
			totalDirectories: 0,
			truncated: false,
		});
		api.resolve({
			entries: [{ path: "api.ts", type: "file" }],
			totalFiles: 1,
			totalDirectories: 0,
			truncated: false,
		});
		const { response } = await pending;
		expect(response.indexOf("## example-org/api")).toBeGreaterThan(-1);
		expect(response.indexOf("## example-org/api")).toBeLessThan(
			response.indexOf("## example-org/web"),
		);
		expect(touchedRepos()).not.toContain("secret-repo");
		expect(h.query).not.toHaveBeenCalled();
	});
});
