/**
 * `remapSolo` service semantics:
 *  - keep mode deletes ONLY prior AI references (onlyAiGenerated:true); fresh
 *    deletes ALL of the repo's solo edge edits (onlyAiGenerated:false).
 *  - regeneration SKIPS references that duplicate a structural edge or an
 *    existing user override, and persists the rest as AI-generated manual
 *    overrides (isManual:true, isAiGenerated:true, isCrossRepo:false).
 *  - a per-repo run-history row is opened (remap/remap_fresh) and closed READY
 *    with edgeCount = references generated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const q = vi.hoisted(() => ({
	listProjectRepositories: vi.fn(),
	findAnalysis: vi.fn(),
	findLatestAnalysisForIntegration: vi.fn(),
	findLatestAnalysisForProject: vi.fn(),
	findAdoptableAnalyses: vi.fn(),
	createAnalysisRun: vi.fn(),
	deleteSoloEdgeOverrides: vi.fn(),
	getGraph: vi.fn(),
	getSoloOverrideEndpointPairs: vi.fn(),
	upsertEdgeOverride: vi.fn(),
	getModelCostRates: vi.fn(),
	completeLatestRun: vi.fn(),
}));

vi.mock("../queries", () => q);
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
vi.mock("../commits", () => ({ countCommitsSince: vi.fn() }));
vi.mock("simple-git", () => ({ default: vi.fn() }));

const mockDetect = vi.fn();
vi.mock("../intra-repo", () => ({
	detectIntraRepoReferences: (...a: unknown[]) => mockDetect(...a),
}));

import { AtlasService } from "../service";

const SEP = "\u0000";

function svc() {
	return new AtlasService({
		userId: "u1",
		organizationId: null,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	q.listProjectRepositories.mockResolvedValue([
		{
			repositoryIntegrationId: "i1",
			repositoryName: "acme-api",
			repositoryUrl: "https://github.com/acme/api",
			defaultBranch: "main",
			isDefault: true,
		},
	]);
	q.findAnalysis.mockResolvedValue({
		id: "a1",
		branch: "main",
		status: "READY",
		repositoryName: "acme-api",
		analyzedCommitSha: "sha1",
	});
	q.createAnalysisRun.mockResolvedValue({ id: "run1" });
	q.deleteSoloEdgeOverrides.mockResolvedValue(3);
	// TECHNICAL has a structural edge m1->m2; BUSINESS empty.
	q.getGraph.mockImplementation((_ctx: unknown, _id: string, mode: string) =>
		mode === "TECHNICAL"
			? {
					nodes: [
						{
							key: "m1",
							label: "A",
							kind: "MODULE",
							description: null,
							filePath: null,
						},
						{
							key: "m2",
							label: "B",
							kind: "MODULE",
							description: null,
							filePath: null,
						},
						{
							key: "m3",
							label: "C",
							kind: "MODULE",
							description: null,
							filePath: null,
						},
						{
							key: "m4",
							label: "D",
							kind: "MODULE",
							description: null,
							filePath: null,
						},
					],
					edges: [
						{
							source: "m1",
							target: "m2",
							kind: "DEPENDS_ON",
							weight: null,
						},
					],
				}
			: { nodes: [], edges: [] },
	);
	// A user override exists on the m3<->m4 pair (both orders).
	q.getSoloOverrideEndpointPairs.mockResolvedValue(
		new Set([`TECHNICAL${SEP}m3${SEP}m4`, `TECHNICAL${SEP}m4${SEP}m3`]),
	);
	q.upsertEdgeOverride.mockResolvedValue({ id: "ov" });
	q.getModelCostRates.mockResolvedValue(null);
	q.completeLatestRun.mockResolvedValue({ durationMs: 10 });
	// AI proposes: m1->m2 (dup structural → skip), m3->m4 (dup user → skip),
	// m1->m3 (new → insert).
	mockDetect.mockResolvedValue({
		edges: [
			{
				mode: "TECHNICAL",
				kind: "CALLS",
				sourceKey: "m1",
				targetKey: "m2",
				description: "dup structural",
			},
			{
				mode: "TECHNICAL",
				kind: "RELATES_TO",
				sourceKey: "m3",
				targetKey: "m4",
				description: "dup user",
			},
			{
				mode: "TECHNICAL",
				kind: "CALLS",
				sourceKey: "m1",
				targetKey: "m3",
				description: "new ref",
			},
		],
		usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		model: "test-model",
	});
});

describe("remapSolo", () => {
	it("keep mode deletes only prior AI references", async () => {
		await svc().remapSolo({
			projectId: "p1",
			repositoryIntegrationId: "i1",
		});
		expect(q.deleteSoloEdgeOverrides).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ onlyAiGenerated: true, branch: "main" }),
		);
		expect(q.createAnalysisRun).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mode: "remap" }),
		);
	});

	it("fresh mode wipes ALL of the repo's solo edits", async () => {
		await svc().remapSolo({
			projectId: "p1",
			repositoryIntegrationId: "i1",
			fresh: true,
		});
		expect(q.deleteSoloEdgeOverrides).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ onlyAiGenerated: false }),
		);
		expect(q.createAnalysisRun).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mode: "remap_fresh" }),
		);
	});

	it("skips structural + user-override duplicates, inserts only new AI refs", async () => {
		const result = await svc().remapSolo({
			projectId: "p1",
			repositoryIntegrationId: "i1",
		});
		// Only the m1->m3 reference is inserted.
		expect(q.upsertEdgeOverride).toHaveBeenCalledTimes(1);
		expect(q.upsertEdgeOverride).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				mode: "TECHNICAL",
				isManual: true,
				isAiGenerated: true,
				isCrossRepo: false,
				source: expect.objectContaining({ key: "m1" }),
				target: expect.objectContaining({ key: "m3" }),
			}),
		);
		expect(result.referencesGenerated).toBe(1);
	});

	it("closes the run READY with the generated count + model", async () => {
		await svc().remapSolo({
			projectId: "p1",
			repositoryIntegrationId: "i1",
		});
		expect(q.completeLatestRun).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				analysisId: "a1",
				status: "READY",
				edgeCount: 1,
				telemetry: expect.objectContaining({ model: "test-model" }),
			}),
		);
	});

	it("throws when the repo has no READY analysis", async () => {
		q.findAnalysis.mockResolvedValue({
			id: "a1",
			branch: "main",
			status: "ANALYZING",
		});
		q.findLatestAnalysisForIntegration.mockResolvedValue(null);
		await expect(
			svc().remapSolo({ projectId: "p1", repositoryIntegrationId: "i1" }),
		).rejects.toThrow();
	});
});
