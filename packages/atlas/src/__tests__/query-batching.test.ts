/**
 * Regression coverage for the Atlas query batching work in Fizzy #2435.
 * These tests deliberately assert the query scopes that prevent per-repository
 * and per-node reads, alongside the returned values those scopes support.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAnalysisFindFirst = vi.fn();
const mockAnalysisFindMany = vi.fn();
const mockNodeFindFirst = vi.fn();
const mockNodeFindMany = vi.fn();
const mockEdgeFindMany = vi.fn();
const mockNodeOverrideFindFirst = vi.fn();
const mockNodeOverrideFindMany = vi.fn();
const mockNodeOverrideCreate = vi.fn();
const mockNodeOverrideUpdate = vi.fn();
const mockNodeOverrideHistoryCreateMany = vi.fn();
const mockEdgeOverrideFindMany = vi.fn();
const mockEdgeOverrideHistoryCreateMany = vi.fn();
const mockTransaction = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		atlasAnalysis: {
			findFirst: (...args: unknown[]) => mockAnalysisFindFirst(...args),
			findMany: (...args: unknown[]) => mockAnalysisFindMany(...args),
		},
		atlasNode: {
			findFirst: (...args: unknown[]) => mockNodeFindFirst(...args),
			findMany: (...args: unknown[]) => mockNodeFindMany(...args),
		},
		atlasEdge: {
			findMany: (...args: unknown[]) => mockEdgeFindMany(...args),
		},
		atlasNodeOverride: {
			findFirst: (...args: unknown[]) =>
				mockNodeOverrideFindFirst(...args),
			findMany: (...args: unknown[]) => mockNodeOverrideFindMany(...args),
			create: (...args: unknown[]) => mockNodeOverrideCreate(...args),
			update: (...args: unknown[]) => mockNodeOverrideUpdate(...args),
		},
		atlasNodeOverrideHistory: {
			createMany: (...args: unknown[]) =>
				mockNodeOverrideHistoryCreateMany(...args),
		},
		atlasEdgeOverride: {
			findMany: (...args: unknown[]) => mockEdgeOverrideFindMany(...args),
		},
		atlasEdgeOverrideHistory: {
			createMany: (...args: unknown[]) =>
				mockEdgeOverrideHistoryCreateMany(...args),
		},
		$transaction: (...args: unknown[]) => mockTransaction(...args),
	},
	Prisma: {},
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));

import {
	createAiSoloEdgeOverrides,
	type EdgeOverrideRow,
	findAnalysesForRepositories,
	getGraph,
	getModulesForDescribe,
	updateNodeDetail,
} from "../queries";

const ctx = { userId: "user-1", organizationId: "org-1" };

function repo(repositoryIntegrationId: string | null, defaultBranch = "main") {
	return {
		repositoryIntegrationId,
		defaultBranch,
		provider: "GITHUB",
		authMethod: "OAUTH",
		repositoryName: repositoryIntegrationId ?? "legacy",
		repositoryUrl: "https://github.com/acme/widgets",
		pinnedBranches: [],
		status: "ACTIVE",
		isDefault: false,
	};
}

function analysis(overrides: Record<string, unknown> = {}) {
	return {
		id: "analysis-1",
		projectId: "project-1",
		repositoryIntegrationId: "repo-1",
		branch: "main",
		status: "READY",
		updatedAt: new Date("2026-09-09T00:00:00Z"),
		appliedUserOverrides: false,
		...overrides,
	};
}

function node(key: string, overrides: Record<string, unknown> = {}) {
	return {
		key,
		kind: "MODULE",
		label: key,
		filePath: null,
		language: null,
		parentKey: null,
		technicalDescription: `AI ${key}`,
		businessDescription: null,
		category: "data",
		documentation: null,
		contentPreview: null,
		metrics: null,
		layout: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockAnalysisFindFirst.mockResolvedValue(analysis());
	mockAnalysisFindMany.mockResolvedValue([]);
	mockNodeFindFirst.mockResolvedValue(node("module-a"));
	mockNodeFindMany.mockResolvedValue([]);
	mockEdgeFindMany.mockResolvedValue([]);
	mockNodeOverrideFindFirst.mockResolvedValue(null);
	mockNodeOverrideFindMany.mockResolvedValue([]);
	mockNodeOverrideCreate.mockResolvedValue({
		id: "node-override-1",
		userDescription: null,
		userCategory: null,
	});
	mockNodeOverrideUpdate.mockResolvedValue({
		id: "node-override-1",
		userDescription: null,
		userCategory: null,
	});
	mockNodeOverrideHistoryCreateMany.mockResolvedValue({ count: 0 });
	mockEdgeOverrideFindMany.mockResolvedValue([]);
	mockEdgeOverrideHistoryCreateMany.mockResolvedValue({ count: 0 });
});

describe("findAnalysesForRepositories", () => {
	it("keeps every exact branch match, including a non-READY analysis, ahead of fallback", async () => {
		const pending = analysis({ id: "pending", status: "PENDING" });
		mockAnalysisFindMany.mockResolvedValueOnce([pending]);

		const result = await findAnalysesForRepositories(ctx, "project-1", [
			repo("repo-1"),
		]);

		expect(result.get("repo-1")).toBe(pending);
		expect(mockAnalysisFindMany).toHaveBeenCalledTimes(1);
		expect(mockAnalysisFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				organizationId: "org-1",
				OR: [{ repositoryIntegrationId: "repo-1", branch: "main" }],
			},
		});
	});

	it("falls back once for missing repositories with project, tenant, and null-repository scopes", async () => {
		const exact = analysis({
			id: "exact",
			repositoryIntegrationId: "repo-1",
		});
		const fallback = analysis({
			id: "legacy-fallback",
			repositoryIntegrationId: null,
			branch: "old-main",
		});
		mockAnalysisFindMany
			.mockResolvedValueOnce([exact])
			.mockResolvedValueOnce([fallback]);

		const result = await findAnalysesForRepositories(ctx, "project-1", [
			repo("repo-1"),
			repo(null, "main"),
		]);

		expect(result.get("repo-1")).toBe(exact);
		expect(result.get(null)).toBe(fallback);
		expect(mockAnalysisFindMany).toHaveBeenCalledTimes(2);
		expect(mockAnalysisFindMany.mock.calls[1][0]).toEqual({
			where: {
				projectId: "project-1",
				organizationId: "org-1",
				OR: [{ repositoryIntegrationId: null }],
			},
			orderBy: { updatedAt: "desc" },
			distinct: ["repositoryIntegrationId"],
		});
	});

	it("uses the fail-closed personal tenant filter for batched analysis reads", async () => {
		const personalCtx = { userId: "user-personal", organizationId: null };
		mockAnalysisFindMany.mockResolvedValueOnce([analysis()]);

		await findAnalysesForRepositories(personalCtx, "project-1", [
			repo("repo-1"),
		]);

		expect(mockAnalysisFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				userId: "user-personal",
				organizationId: null,
				OR: [{ repositoryIntegrationId: "repo-1", branch: "main" }],
			},
		});
	});
});

describe("getGraph", () => {
	it("uses the slim node projection and executes a lazy analysis thenable once", async () => {
		mockNodeFindMany.mockResolvedValue([node("module-a")]);
		let analysisThenExecutions = 0;
		mockAnalysisFindFirst.mockReturnValueOnce({
			// biome-ignore lint/suspicious/noThenProperty: PrismaPromise-like query execution is intentionally lazy.
			then: (resolve: (value: ReturnType<typeof analysis>) => void) => {
				analysisThenExecutions += 1;
				resolve(analysis());
			},
		});

		await getGraph(ctx, "analysis-1", "TECHNICAL");

		const select = mockNodeFindMany.mock.calls[0][0].select;
		expect(select).toMatchObject({
			key: true,
			technicalDescription: true,
			businessDescription: true,
		});
		expect(select).not.toHaveProperty("contentPreview");
		expect(select).not.toHaveProperty("documentation");
		expect(mockAnalysisFindFirst).toHaveBeenCalledTimes(1);
		expect(analysisThenExecutions).toBe(1);
	});

	it("uses supplied shared edge overrides while preserving node and edge overlays", async () => {
		mockAnalysisFindFirst.mockResolvedValue(
			analysis({ appliedUserOverrides: true }),
		);
		mockNodeFindMany.mockResolvedValue([node("a"), node("b")]);
		mockEdgeFindMany.mockResolvedValue([
			{ sourceKey: "a", targetKey: "b", kind: "DEPENDS_ON", weight: 1 },
		]);
		mockNodeOverrideFindMany.mockResolvedValue([
			{
				key: "a",
				userDescription: "Human description",
				userCategory: "ops",
			},
		]);
		const supplied: Promise<EdgeOverrideRow[]> = Promise.resolve([
			{
				id: "edge-override-1",
				branch: "main",
				mode: "TECHNICAL",
				sourceRepositoryIntegrationId: "repo-1",
				sourceKey: "a",
				targetRepositoryIntegrationId: "repo-1",
				targetKey: "b",
				kind: "DEPENDS_ON",
				userDescription: "Human edge note",
				isManual: false,
				isCrossRepo: false,
				isAiGenerated: false,
				isUserKind: false,
				deletedAt: null,
			},
		]);

		const graph = await getGraph(ctx, "analysis-1", "TECHNICAL", {
			edgeOverrides: supplied,
		});

		expect(graph.nodes[0]).toMatchObject({
			key: "a",
			description: "Human description",
			category: "ops",
			isUserCategory: true,
		});
		expect(graph.edges[0]).toMatchObject({
			description: "Human edge note",
			isUserDescription: true,
			overrideId: "edge-override-1",
		});
		expect(mockEdgeOverrideFindMany).not.toHaveBeenCalled();
	});

	it("propagates a supplied edge-override rejection while the analysis lookup is pending", async () => {
		let settleAnalysis:
			| ((value: ReturnType<typeof analysis>) => void)
			| undefined;
		const pendingAnalysis = new Promise<ReturnType<typeof analysis>>(
			(resolve) => {
				settleAnalysis = resolve;
			},
		);
		const failure = new Error("edge override query failed");
		mockAnalysisFindFirst.mockReturnValueOnce(pendingAnalysis);

		const graph = getGraph(ctx, "analysis-1", "TECHNICAL", {
			edgeOverrides: Promise.reject(failure),
		});

		await expect(graph).rejects.toBe(failure);
		expect(settleAnalysis).toBeTypeOf("function");
		settleAnalysis?.(analysis());
		await pendingAnalysis;
	});
});

describe("getModulesForDescribe", () => {
	it("loads only adjacent dependency edges and exposes both incoming and outgoing labels", async () => {
		mockNodeFindMany
			.mockResolvedValueOnce([
				{
					key: "a",
					label: "A",
					filePath: "a.ts",
					language: "ts",
					metrics: {},
				},
				{
					key: "b",
					label: "B",
					filePath: "b.ts",
					language: "ts",
					metrics: {},
				},
			])
			.mockResolvedValueOnce([]);
		mockEdgeFindMany.mockResolvedValue([
			{ sourceKey: "outside", targetKey: "a" },
			{ sourceKey: "a", targetKey: "b" },
			{ sourceKey: "b", targetKey: "outside" },
		]);

		const modules = await getModulesForDescribe("analysis-1", ["a", "b"]);

		expect(mockEdgeFindMany).toHaveBeenCalledWith({
			where: {
				analysisId: "analysis-1",
				mode: "TECHNICAL",
				kind: "DEPENDS_ON",
				OR: [
					{ sourceKey: { in: ["a", "b"] } },
					{ targetKey: { in: ["a", "b"] } },
				],
			},
			select: { sourceKey: true, targetKey: true },
		});
		expect(modules).toEqual([
			expect.objectContaining({
				key: "a",
				dependsOn: ["B"],
				dependedOnBy: ["outside"],
			}),
			expect.objectContaining({
				key: "b",
				dependsOn: ["outside"],
				dependedOnBy: ["A"],
			}),
		]);
	});
});

describe("updateNodeDetail", () => {
	function prepareSnapshot(appliedUserOverrides: boolean) {
		mockNodeFindFirst.mockResolvedValue(
			node("module-a", {
				category: "ai",
				technicalDescription: "AI detail",
			}),
		);
		mockAnalysisFindFirst.mockResolvedValue(
			analysis({ appliedUserOverrides }),
		);
		mockEdgeFindMany.mockResolvedValue([]);
		mockNodeFindMany.mockResolvedValue([]);
	}

	it("clears a user category back to the raw AI category using one node/neighbour snapshot", async () => {
		prepareSnapshot(true);
		mockNodeOverrideFindMany.mockResolvedValue([
			{
				key: "module-a",
				userDescription: "Human detail",
				userCategory: "ops",
			},
		]);
		mockNodeOverrideFindFirst.mockResolvedValue({
			id: "node-override-1",
			userDescription: "Human detail",
			userCategory: "ops",
		});
		mockNodeOverrideUpdate.mockResolvedValue({
			id: "node-override-1",
			userDescription: "Human detail",
			userCategory: null,
		});

		const detail = await updateNodeDetail(ctx, {
			analysisId: "analysis-1",
			projectId: "project-1",
			repositoryIntegrationId: "repo-1",
			branch: "main",
			mode: "TECHNICAL",
			key: "module-a",
			userCategory: null,
			updatedByUserId: "user-1",
		});

		expect(detail).toMatchObject({
			description: "Human detail",
			category: "ai",
			isUserCategory: false,
			userCategory: null,
		});
		expect(mockNodeFindFirst).toHaveBeenCalledTimes(1);
		expect(mockEdgeFindMany).toHaveBeenCalledTimes(1);
		expect(mockNodeFindMany).toHaveBeenCalledTimes(1);
	});

	it("keeps an omitted override field intact and returns raw values when overrides were not applied", async () => {
		prepareSnapshot(false);
		mockNodeOverrideFindFirst.mockResolvedValue({
			id: "node-override-1",
			userDescription: "Existing description",
			userCategory: "ops",
		});
		mockNodeOverrideUpdate.mockResolvedValue({
			id: "node-override-1",
			userDescription: "Existing description",
			userCategory: "security",
		});

		const detail = await updateNodeDetail(ctx, {
			analysisId: "analysis-1",
			projectId: "project-1",
			repositoryIntegrationId: "repo-1",
			branch: "main",
			mode: "TECHNICAL",
			key: "module-a",
			userCategory: "security",
			updatedByUserId: "user-1",
		});

		expect(mockNodeOverrideUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { userCategory: "security", updatedByUserId: "user-1" },
			}),
		);
		expect(detail).toMatchObject({
			description: "AI detail",
			category: "ai",
			userDescription: null,
			userCategory: null,
		});
		expect(mockNodeOverrideFindMany).not.toHaveBeenCalled();
	});

	it("does not write when the requested node is absent", async () => {
		mockNodeFindFirst.mockResolvedValue(null);

		await expect(
			updateNodeDetail(ctx, {
				analysisId: "analysis-1",
				projectId: "project-1",
				repositoryIntegrationId: "repo-1",
				branch: "main",
				mode: "TECHNICAL",
				key: "missing",
				userDescription: "never saved",
				updatedByUserId: "user-1",
			}),
		).resolves.toBeNull();

		expect(mockNodeOverrideFindFirst).not.toHaveBeenCalled();
		expect(mockNodeOverrideCreate).not.toHaveBeenCalled();
		expect(mockNodeOverrideUpdate).not.toHaveBeenCalled();
	});
});

describe("createAiSoloEdgeOverrides", () => {
	function transactionClient(existing: unknown[], inserted: unknown[]) {
		return {
			atlasEdgeOverride: {
				findMany: vi.fn().mockResolvedValue(existing),
				createManyAndReturn: vi.fn().mockResolvedValue(inserted),
			},
			atlasEdgeOverrideHistory: {
				createMany: vi
					.fn()
					.mockResolvedValue({ count: inserted.length }),
			},
		};
	}

	it("filters existing pairs in either direction per lens, dedupes proposals, and records only inserted IDs", async () => {
		const tx = transactionClient(
			[{ mode: "TECHNICAL", sourceKey: "a", targetKey: "b" }],
			[
				{ id: "inserted-business", userDescription: "business edge" },
				{ id: "inserted-tech", userDescription: null },
			],
		);
		mockTransaction.mockImplementation(
			async (callback: (client: typeof tx) => unknown) => callback(tx),
		);

		const count = await createAiSoloEdgeOverrides(ctx, {
			projectId: "project-1",
			repositoryIntegrationId: "repo-1",
			branch: "main",
			edges: [
				{
					mode: "TECHNICAL",
					sourceKey: "b",
					targetKey: "a",
					kind: "DEPENDS_ON",
					description: "old reverse",
				},
				{
					mode: "BUSINESS",
					sourceKey: "a",
					targetKey: "b",
					kind: "RELATES_TO",
					description: "business edge",
				},
				{
					mode: "BUSINESS",
					sourceKey: "b",
					targetKey: "a",
					kind: "RELATES_TO",
					description: "duplicate reverse",
				},
				{
					mode: "TECHNICAL",
					sourceKey: "c",
					targetKey: "d",
					kind: "DEPENDS_ON",
					description: null,
				},
				{
					mode: "TECHNICAL",
					sourceKey: "d",
					targetKey: "c",
					kind: "DEPENDS_ON",
					description: "duplicate reverse",
				},
			],
		});

		expect(count).toBe(2);
		expect(tx.atlasEdgeOverride.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "project-1",
					branch: "main",
					sourceRepositoryIntegrationId: "repo-1",
					targetRepositoryIntegrationId: "repo-1",
					organizationId: "org-1",
				}),
			}),
		);
		expect(tx.atlasEdgeOverride.createManyAndReturn).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						mode: "BUSINESS",
						sourceKey: "a",
						targetKey: "b",
					}),
					expect.objectContaining({
						mode: "TECHNICAL",
						sourceKey: "c",
						targetKey: "d",
					}),
				],
			}),
		);
		expect(tx.atlasEdgeOverrideHistory.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					overrideId: "inserted-business",
					newValue: "business edge",
				}),
				expect.objectContaining({
					overrideId: "inserted-tech",
					newValue: null,
				}),
			],
		});
	});

	it("sorts fresh rows identically when concurrent callers propose the same edges in opposite orders", async () => {
		const insertedBatches: unknown[][] = [];
		const tx = transactionClient([], []);
		tx.atlasEdgeOverride.createManyAndReturn.mockImplementation(
			({ data }: { data: unknown[] }) => {
				insertedBatches.push(data);
				return Promise.resolve([]);
			},
		);
		mockTransaction.mockImplementation(
			async (callback: (client: typeof tx) => unknown) => callback(tx),
		);
		const proposals = [
			{
				mode: "TECHNICAL" as const,
				sourceKey: "b",
				targetKey: "a",
				kind: "DEPENDS_ON",
				description: null,
			},
			{
				mode: "BUSINESS" as const,
				sourceKey: "z",
				targetKey: "y",
				kind: "RELATES_TO",
				description: null,
			},
			{
				mode: "TECHNICAL" as const,
				sourceKey: "a",
				targetKey: "z",
				kind: "DEPENDS_ON",
				description: null,
			},
			{
				mode: "BUSINESS" as const,
				sourceKey: "a",
				targetKey: "z",
				kind: "RELATES_TO",
				description: null,
			},
		];
		const input = {
			projectId: "project-1",
			repositoryIntegrationId: "repo-1",
			branch: "main",
		};

		await createAiSoloEdgeOverrides(ctx, { ...input, edges: proposals });
		await createAiSoloEdgeOverrides(ctx, {
			...input,
			edges: [...proposals].reverse(),
		});

		expect(insertedBatches).toHaveLength(2);
		expect(insertedBatches[1]).toEqual(insertedBatches[0]);
		expect(insertedBatches[0]).toEqual([
			expect.objectContaining({
				mode: "BUSINESS",
				sourceKey: "a",
				targetKey: "z",
			}),
			expect.objectContaining({
				mode: "BUSINESS",
				sourceKey: "z",
				targetKey: "y",
			}),
			expect.objectContaining({
				mode: "TECHNICAL",
				sourceKey: "a",
				targetKey: "z",
			}),
			expect.objectContaining({
				mode: "TECHNICAL",
				sourceKey: "b",
				targetKey: "a",
			}),
		]);
	});

	it("propagates a transaction failure", async () => {
		const failure = new Error("database unavailable");
		mockTransaction.mockRejectedValue(failure);

		await expect(
			createAiSoloEdgeOverrides(ctx, {
				projectId: "project-1",
				repositoryIntegrationId: "repo-1",
				branch: "main",
				edges: [
					{
						mode: "TECHNICAL",
						sourceKey: "a",
						targetKey: "b",
						kind: "DEPENDS_ON",
						description: null,
					},
				],
			}),
		).rejects.toBe(failure);
	});
});
