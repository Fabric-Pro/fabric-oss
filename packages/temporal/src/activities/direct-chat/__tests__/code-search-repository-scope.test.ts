/**
 * `code_search` can be scoped to one repository (#2040 review F8).
 *
 * It searched every repository of the project in one top-K, so on a project
 * with a large legacy repo the one the user was looking at could be crowded
 * out. The tool now lists the project's indexed repositories, takes a
 * `repository` argument, and defaults to the repository the chat was launched
 * from. The project filter is unchanged: a repository is only ever resolved
 * among the attached project's own indexes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getProjectCodeIndexes: vi.fn(),
	integrations: vi.fn(),
	project: vi.fn(),
	count: vi.fn(),
	query: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getProjectCodeIndexes: h.getProjectCodeIndexes,
	db: {
		projectRepositoryIntegration: { findMany: h.integrations },
		project: { findUnique: h.project },
	},
}));
vi.mock("@repo/rag/lib/embedding", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
}));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [1], values: [1] })),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	ensureCollection: vi.fn(async () => "project-contexts-org"),
	getCollectionLayout: vi.fn(async () => ({ supportsHybrid: false })),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { count: h.count, query: h.query },
}));
vi.mock("@repo/rag", () => ({
	getProjectRoleTagMaps: vi.fn(async () => ({
		byIntegrationId: new Map(),
		byRepoKey: new Map(),
	})),
	resolveRoleTag: vi.fn(() => undefined),
}));

const { createCodeSearchTool } = await import("../built-in-tools");

type CodeSearchTool = {
	description: string;
	execute: (args: Record<string, unknown>) => Promise<{
		success: boolean;
		searchedRepository?: string;
		status?: string;
	}>;
};

async function buildTool(preferredRepositoryUrl?: string) {
	const tools = await createCodeSearchTool({
		userId: "u1",
		organizationId: "org-1",
		projectId: "p1",
		preferredRepositoryUrl,
	});
	return tools.code_search as CodeSearchTool;
}

function lastQueryMust(): unknown[] {
	const [, request] = h.query.mock.calls.at(-1) as [
		string,
		{ filter: { must: unknown[] } },
	];
	return request.filter.must;
}

beforeEach(() => {
	vi.clearAllMocks();
	h.getProjectCodeIndexes.mockResolvedValue([
		{ repositoryIntegrationId: "ri-web", status: "READY" },
		{ repositoryIntegrationId: "ri-legacy", status: "READY" },
	]);
	h.integrations.mockResolvedValue([
		{
			id: "ri-web",
			repositoryUrl: "https://github.com/example-org/web-app",
			repositoryOwner: "example-org",
			repositoryName: "web-app",
			roleTag: "Primary",
		},
		{
			id: "ri-legacy",
			repositoryUrl: "https://github.com/example-org/legacy-app.git",
			repositoryOwner: "example-org",
			repositoryName: "legacy-app",
			roleTag: "Legacy",
		},
	]);
	h.project.mockResolvedValue(null);
	h.count.mockResolvedValue({ count: 10 });
	h.query.mockResolvedValue({ points: [] });
});

describe("code_search repository scope", () => {
	it("lists the project's indexed repositories in its description", async () => {
		const tool = await buildTool();
		expect(tool.description).toContain("example-org/web-app [Primary]");
		expect(tool.description).toContain("example-org/legacy-app [Legacy]");
	});

	it("searches every repository when none is named or preferred", async () => {
		const tool = await buildTool();
		const result = await tool.execute({ query: "auth", maxResults: 5 });
		expect(result.searchedRepository).toBe("all");
		expect(JSON.stringify(lastQueryMust())).not.toContain(
			"repositoryIntegrationId",
		);
		expect(lastQueryMust()).toContainEqual({
			key: "projectId",
			match: { value: "p1" },
		});
	});

	it("defaults to the repository the chat was launched from", async () => {
		const tool = await buildTool(
			"https://github.com/example-org/legacy-app",
		);
		expect(tool.description).toContain(
			"searches example-org/legacy-app, the repository the user is viewing",
		);
		const result = await tool.execute({ query: "auth", maxResults: 5 });
		expect(result.searchedRepository).toBe("example-org/legacy-app");
		expect(lastQueryMust()).toContainEqual({
			key: "repositoryIntegrationId",
			match: { value: "ri-legacy" },
		});
	});

	it("lets the model pick a repository by name, or search all", async () => {
		const tool = await buildTool(
			"https://github.com/example-org/legacy-app",
		);
		await tool.execute({ query: "auth", repository: "web-app" });
		expect(lastQueryMust()).toContainEqual({
			key: "repositoryIntegrationId",
			match: { value: "ri-web" },
		});
		const all = await tool.execute({ query: "auth", repository: "all" });
		expect(all.searchedRepository).toBe("all");
	});

	it("refuses a repository that is not one of the project's", async () => {
		const tool = await buildTool();
		const result = await tool.execute({
			query: "auth",
			repository: "https://github.com/someone-else/secret",
		});
		expect(result).toMatchObject({
			success: false,
			status: "unknown_repository",
		});
		expect(h.query).not.toHaveBeenCalled();
	});

	// Not a failure (Fizzy #2578): a failed call counted toward the
	// orchestrator's three-strike breaker, which aborted the turn.
	it("reports a named repository whose index is not ready as a plain result", async () => {
		h.getProjectCodeIndexes.mockResolvedValue([
			{ repositoryIntegrationId: "ri-web", status: "READY" },
			{ repositoryIntegrationId: "ri-legacy", status: "INDEXING" },
		]);
		const tool = await buildTool();
		const result = await tool.execute({
			query: "auth",
			repository: "legacy-app",
		});
		expect(result).toMatchObject({
			available: false,
			status: "INDEXING",
			results: [],
			message: expect.stringContaining(
				"The code index for example-org/legacy-app is still building",
			),
		});
		expect(result).not.toHaveProperty("success");
		expect(result).not.toHaveProperty("error");
		expect(h.query).not.toHaveBeenCalled();
	});

	it("reports a project whose only index is still building as a plain result", async () => {
		h.getProjectCodeIndexes.mockResolvedValue([
			{ repositoryIntegrationId: "ri-web", status: "PENDING" },
		]);
		const tool = await buildTool();
		const result = await tool.execute({ query: "auth" });
		expect(result).toMatchObject({
			available: false,
			status: "PENDING",
			message: expect.stringContaining("Do not call code_search again"),
		});
		expect(result).not.toHaveProperty("success");
	});

	it("scopes to the project's own default repository by an empty integration id", async () => {
		h.getProjectCodeIndexes.mockResolvedValue([
			{ repositoryIntegrationId: null, status: "READY" },
			{ repositoryIntegrationId: "ri-web", status: "READY" },
		]);
		h.project.mockResolvedValue({
			repositoryUrl: "https://gitlab.example.com/example-org/core",
			repositoryOwner: "example-org",
			repositoryName: "core",
		});
		const tool = await buildTool(
			"https://gitlab.example.com/example-org/core.git",
		);
		const result = await tool.execute({ query: "auth" });
		expect(result.searchedRepository).toBe("example-org/core");
		expect(lastQueryMust()).toContainEqual({
			is_empty: { key: "repositoryIntegrationId" },
		});
	});

	it("ignores a launch repository the project does not have", async () => {
		const tool = await buildTool("https://github.com/someone-else/secret");
		const result = await tool.execute({ query: "auth" });
		expect(result.searchedRepository).toBe("all");
	});
});
