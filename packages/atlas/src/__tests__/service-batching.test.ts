import { beforeEach, describe, expect, it, vi } from "vitest";

const q = vi.hoisted(() => ({
	listProjectRepositories: vi.fn(),
	findAnalysesForRepositories: vi.fn(),
	findAdoptableAnalyses: vi.fn(),
	adoptAnalysis: vi.fn(),
	getGraph: vi.fn(),
	loadEdgeOverrides: vi.fn(),
	getCrossEdges: vi.fn(),
	getCrossLink: vi.fn(),
	getSystemNodeLayout: vi.fn(),
	startCrossLink: vi.fn(),
	replaceCrossEdges: vi.fn(),
	finishCrossLink: vi.fn(),
	recordCrossLinkRun: vi.fn(),
}));
const detect = vi.hoisted(() => vi.fn());
vi.mock("../queries", () => q);
vi.mock("../cross-repo", async (original) => ({
	...(await original<typeof import("../cross-repo")>()),
	detectAiEdges: detect,
}));
vi.mock("@repo/database", () => ({ recordAudit: vi.fn() }));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(),
	streamText: vi.fn(),
}));
vi.mock("@repo/connectors", () => ({ listRepositoryBranches: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../credentials", () => ({ ensureFreshRepoCredentials: vi.fn() }));
vi.mock("simple-git", () => ({ default: vi.fn() }));

import { AtlasService } from "../service";
import type { GraphMode, GraphNode, RepoOption } from "../types";

const ctx = { userId: "user-1", organizationId: "org-1" };
const repos: RepoOption[] = ["web", "api"].map((name) => ({
	repositoryIntegrationId: name,
	repositoryName: name,
	repositoryUrl: `https://github.com/example-org/${name}`,
	defaultBranch: "main",
	provider: "GITHUB",
	authMethod: "OAUTH",
	status: "ACTIVE",
	isDefault: false,
	pinnedBranches: [],
}));
const analysis = (repo: string, branch = "main", status = "READY") => ({
	id: `a-${repo}`,
	repositoryIntegrationId: repo,
	branch,
	status,
	analyzedCommitSha: `sha-${repo}`,
	techStack: [],
	publishedPackages: [],
});
const graph = () => ({
	nodes: [
		{
			key: "module",
			kind: "MODULE",
			label: "Module",
			filePath: null,
			language: null,
			parentKey: null,
			description: null,
			category: null,
			isUserCategory: false,
			metrics: null,
			layout: null,
		} satisfies GraphNode,
	],
	edges: [],
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
beforeEach(() => {
	vi.resetAllMocks();
	q.listProjectRepositories.mockResolvedValue(repos);
	q.findAnalysesForRepositories.mockResolvedValue(
		new Map(
			repos.map((repo) => [
				repo.repositoryIntegrationId,
				analysis(repo.repositoryName),
			]),
		),
	);
	q.getGraph.mockResolvedValue(graph());
	q.loadEdgeOverrides.mockResolvedValue([]);
	q.getCrossEdges.mockResolvedValue([]);
	q.getCrossLink.mockResolvedValue(null);
	q.getSystemNodeLayout.mockResolvedValue({});
	q.startCrossLink.mockResolvedValue(undefined);
	q.replaceCrossEdges.mockResolvedValue(0);
	q.finishCrossLink.mockResolvedValue(undefined);
	q.recordCrossLinkRun.mockResolvedValue(undefined);
	detect.mockResolvedValue({
		edges: [],
		model: null,
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	});
});
const input = {
	projectId: "p1",
	repositoryIntegrationIds: ["web", "api"],
	mode: "TECHNICAL" as const,
};

describe("Atlas batched service reads", () => {
	it("starts both graphs before either finishes, preserving repo order and sharing overrides with cross edges", async () => {
		const first = deferred<ReturnType<typeof graph>>();
		q.getGraph.mockImplementation((_ctx, id) =>
			id === "a-web" ? first.promise : Promise.resolve(graph()),
		);
		const service = new AtlasService(ctx);
		const pending = service.getSystemGraph(input);
		await vi.waitFor(() => expect(q.getGraph).toHaveBeenCalledTimes(2));
		expect(q.loadEdgeOverrides).toHaveBeenCalledTimes(1);
		expect(q.getGraph.mock.calls[0]?.[3].edgeOverrides).toBe(
			q.getGraph.mock.calls[1]?.[3].edgeOverrides,
		);
		first.resolve(graph());
		const result = await pending;
		expect(result.repos.map((repo) => repo.repoId)).toEqual(["web", "api"]);
		expect(result.nodes.map((node) => node.id)).toEqual([
			"repo::a-web",
			"a-web::module",
			"repo::a-api",
			"a-api::module",
		]);
		expect(q.loadEdgeOverrides).toHaveBeenCalledTimes(1);
		await service.getSystemGraph(input);
		expect(q.loadEdgeOverrides).toHaveBeenCalledTimes(2); // cache belongs to this read only
	});

	it("loads separate override sets for distinct served branches", async () => {
		q.findAnalysesForRepositories.mockResolvedValue(
			new Map([
				["web", analysis("web")],
				["api", analysis("api", "release")],
			]),
		);
		await new AtlasService(ctx).getSystemGraph(input);
		expect(
			q.loadEdgeOverrides.mock.calls.map((call) => call.slice(1)),
		).toEqual([
			["p1", "main", "TECHNICAL"],
			["p1", "release", "TECHNICAL"],
		]);
	});

	it("keeps orphan adoption ordered and does not adopt an existing unfinished analysis", async () => {
		q.findAnalysesForRepositories.mockResolvedValue(new Map());
		const adopted = deferred<ReturnType<typeof analysis>>();
		q.findAdoptableAnalyses
			.mockResolvedValueOnce([{ id: "orphan" }])
			.mockResolvedValueOnce([]);
		q.adoptAnalysis.mockReturnValue(adopted.promise);
		const pending = new AtlasService(ctx).getSystemGraph(input);
		await vi.waitFor(() =>
			expect(q.adoptAnalysis).toHaveBeenCalledTimes(1),
		);
		expect(q.findAdoptableAnalyses).toHaveBeenCalledTimes(1);
		adopted.resolve(analysis("web"));
		const result = await pending;
		expect(q.findAdoptableAnalyses).toHaveBeenCalledTimes(2);
		expect(result.repos.map((repo) => repo.repoId)).toEqual(["web"]);
		expect(result.unavailableRepos).toEqual([
			{ repoId: "api", repoName: "api", reason: "Not analysed yet" },
		]);
		q.findAdoptableAnalyses.mockClear();
		q.findAnalysesForRepositories.mockResolvedValue(
			new Map([
				["web", analysis("web", "main", "ANALYZING")],
				["api", analysis("api")],
			]),
		);
		const next = await new AtlasService(ctx).getSystemGraph(input);
		expect(q.findAdoptableAnalyses).not.toHaveBeenCalled();
		expect(next.unavailableRepos).toEqual([
			{ repoId: "web", repoName: "web", reason: "Analysis not finished" },
		]);
	});

	it("links repos with concurrent graphs and one override load per branch and lens", async () => {
		const first = deferred<ReturnType<typeof graph>>();
		q.getGraph.mockImplementation((_ctx, id: string, mode: GraphMode) =>
			id === "a-web" && mode === "TECHNICAL"
				? first.promise
				: Promise.resolve(graph()),
		);
		const pending = new AtlasService(ctx).linkRepositories({
			projectId: "p1",
		});
		await vi.waitFor(() => expect(q.getGraph).toHaveBeenCalledTimes(4));
		expect(q.loadEdgeOverrides).toHaveBeenCalledTimes(2);
		first.resolve(graph());
		expect(await pending).toEqual({
			status: "READY",
			stale: false,
			edgeCount: 0,
		});
		expect(
			detect.mock.calls[0]?.[1].map(
				(repo: { repoId: string }) => repo.repoId,
			),
		).toEqual(["web", "api"]);
	});
});
