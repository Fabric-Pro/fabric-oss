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
		message?: string;
	}>;
};

async function buildTool(
	preferredRepositoryUrl?: string,
	liveRepositoryReads?: boolean,
) {
	const tools = await createCodeSearchTool({
		userId: "u1",
		organizationId: "org-1",
		projectId: "p1",
		preferredRepositoryUrl,
		liveRepositoryReads,
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

// Fizzy #2926: a repository that is connected but has no code index is not a
// wrong name. Reported as unknown, the call failed; three in a row tripped the
// orchestrator's breaker, and nothing told the model the live readers exist.
describe("code_search on a connected repository with no index", () => {
	const DOCS_SITE = {
		id: "ri-docs",
		repositoryUrl: "https://dev.azure.com/example-org/site/_git/docs-site",
		repositoryOwner: "example-org",
		repositoryName: "docs-site",
		roleTag: null,
	};

	it("reports a named, connected, unindexed repository as unavailable, not as a failure", async () => {
		h.integrations.mockResolvedValue([
			...(await h.integrations()),
			DOCS_SITE,
		]);
		const tool = await buildTool();
		const result = await tool.execute({
			query: "auth",
			repository: "docs-site",
		});
		expect(result).toMatchObject({
			available: false,
			status: "missing",
			results: [],
			message: expect.stringContaining(
				"The code index for example-org/docs-site does not exist — this repository is connected but has not been indexed",
			),
		});
		expect(result).not.toHaveProperty("success");
		expect(h.query).not.toHaveBeenCalled();
	});

	it("reports a project with no index at all as unavailable, whatever repository is named", async () => {
		h.getProjectCodeIndexes.mockResolvedValue([]);
		const tool = await buildTool();
		const connected = await tool.execute({
			query: "auth",
			repository: "example-org/web-app",
		});
		expect(connected).toMatchObject({ available: false });
		expect(connected).not.toHaveProperty("success");
		expect(connected.message).not.toContain("does not identify");

		// Still not a failure, but the unrecognised name is called out.
		const unknown = await tool.execute({
			query: "auth",
			repository: "unheard-of",
		});
		expect(unknown).toMatchObject({ available: false });
		expect(unknown).not.toHaveProperty("success");
		expect(unknown.message).toContain(
			'"unheard-of" does not identify one repository connected to this project; connected: example-org/web-app, example-org/legacy-app.',
		);
	});

	it("matches the project's own legacy repository when it has no index", async () => {
		h.getProjectCodeIndexes.mockResolvedValue([
			{ repositoryIntegrationId: "ri-web", status: "READY" },
		]);
		h.project.mockResolvedValue({
			repositoryUrl: "https://gitlab.example.com/example-org/core",
			repositoryOwner: "example-org",
			repositoryName: "core",
		});
		const tool = await buildTool();
		const result = await tool.execute({
			query: "auth",
			repository: "https://gitlab.example.com/example-org/core.git",
		});
		expect(result).toMatchObject({
			available: false,
			status: "missing",
			message: expect.stringContaining("example-org/core"),
		});
	});

	it("still fails a name that matches nothing connected, listing both kinds", async () => {
		h.integrations.mockResolvedValue([
			...(await h.integrations()),
			DOCS_SITE,
		]);
		const tool = await buildTool();
		const result = await tool.execute({
			query: "auth",
			repository: "someone-else/secret",
		});
		expect(result).toMatchObject({
			success: false,
			status: "unknown_repository",
		});
		const message = result.message;
		expect(message).toContain("example-org/web-app");
		expect(message).toContain(
			"Connected but not indexed: example-org/docs-site",
		);
	});

	it.each([
		[
			"a project with no index",
			() => h.getProjectCodeIndexes.mockResolvedValue([]),
			{},
		],
		[
			"an index still building",
			() =>
				h.getProjectCodeIndexes.mockResolvedValue([
					{ repositoryIntegrationId: "ri-web", status: "INDEXING" },
				]),
			{ repository: "web-app" },
		],
	])(
		"points at code_tree and code_file_get only where the chat offers them: %s",
		async (_name, arrange, args) => {
			arrange();
			const withReaders = await (
				await buildTool(undefined, true)
			).execute({ query: "auth", ...args });
			const directChat = await (await buildTool()).execute({
				query: "auth",
				...args,
			});
			const said = (r: unknown) => (r as { message: string }).message;
			// Conditional: an explicit Fabric tool list can leave them out.
			expect(said(withReaders)).toContain(
				"If code_tree and code_file_get are among your tools",
			);
			expect(said(withReaders)).toContain("other sources");
			expect(said(directChat)).not.toContain("code_tree");
			expect(said(directChat)).toContain("other sources");
		},
	);
});
