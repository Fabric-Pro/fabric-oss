/**
 * Edge mutation service methods (Feature B):
 *  - createEdge RESTORES a soft-deleted override for the same endpoints instead
 *    of creating a duplicate.
 *  - deleteEdge of an AI/structural edge with no override first CREATES a
 *    non-manual tracking override, then soft-deletes it.
 *  - getEdgeHistory returns [] when no override exists, else delegates by id.
 * The branch is resolved from the source repo's analysis (mocked here).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListProjectRepositories = vi.fn();
const mockFindAnalysis = vi.fn();
const mockFindLatestAnalysisForIntegration = vi.fn();
const mockFindLatestAnalysisForProject = vi.fn();
const mockFindAdoptableAnalyses = vi.fn();
const mockUpsertEdgeOverride = vi.fn();
const mockFindEdgeOverride = vi.fn();
const mockSoftDeleteEdgeOverride = vi.fn();
const mockRestoreEdgeOverride = vi.fn();
const mockGetEdgeOverrideHistory = vi.fn();

vi.mock("../queries", () => ({
	listProjectRepositories: (...a: unknown[]) =>
		mockListProjectRepositories(...a),
	findAnalysis: (...a: unknown[]) => mockFindAnalysis(...a),
	findLatestAnalysisForIntegration: (...a: unknown[]) =>
		mockFindLatestAnalysisForIntegration(...a),
	findLatestAnalysisForProject: (...a: unknown[]) =>
		mockFindLatestAnalysisForProject(...a),
	findAdoptableAnalyses: (...a: unknown[]) => mockFindAdoptableAnalyses(...a),
	upsertEdgeOverride: (...a: unknown[]) => mockUpsertEdgeOverride(...a),
	findEdgeOverride: (...a: unknown[]) => mockFindEdgeOverride(...a),
	softDeleteEdgeOverride: (...a: unknown[]) =>
		mockSoftDeleteEdgeOverride(...a),
	restoreEdgeOverride: (...a: unknown[]) => mockRestoreEdgeOverride(...a),
	getEdgeOverrideHistory: (...a: unknown[]) =>
		mockGetEdgeOverrideHistory(...a),
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
vi.mock("../commits", () => ({ countCommitsSince: vi.fn() }));
vi.mock("simple-git", () => ({ default: vi.fn() }));

import { recordAudit } from "@repo/database";
import { AtlasService } from "../service";

const ctx = { userId: "user-1", organizationId: "org-1" };

const source = { repositoryIntegrationId: "int-1", key: "a" };
const target = { repositoryIntegrationId: "int-1", key: "b" };

function overrideRow(over: Record<string, unknown> = {}) {
	return {
		id: "ov-1",
		branch: "main",
		mode: "TECHNICAL",
		sourceRepositoryIntegrationId: "int-1",
		sourceKey: "a",
		targetRepositoryIntegrationId: "int-1",
		targetKey: "b",
		kind: "DEPENDS_ON",
		userDescription: null,
		isManual: false,
		isCrossRepo: false,
		deletedAt: null,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Branch resolution: source repo -> its READY analysis on "main".
	mockListProjectRepositories.mockResolvedValue([
		{
			repositoryIntegrationId: "int-1",
			repositoryName: "repo-one",
			repositoryUrl: "https://github.com/org/repo-one",
			defaultBranch: "main",
			provider: "GITHUB",
			authMethod: "OAUTH",
			pinnedBranches: [],
			status: "ACTIVE",
			isDefault: true,
		},
	]);
	mockFindAnalysis.mockResolvedValue({ id: "an-1", branch: "main" });
});

describe("createEdge - restores a soft-deleted override", () => {
	it("restores the existing deleted override rather than creating a duplicate", async () => {
		mockFindEdgeOverride.mockResolvedValue(
			overrideRow({ deletedAt: new Date(), isManual: true }),
		);
		mockRestoreEdgeOverride.mockResolvedValue(
			overrideRow({ isManual: true, deletedAt: null }),
		);

		const service = new AtlasService(ctx);
		const result = await service.createEdge({
			projectId: "p1",
			mode: "TECHNICAL",
			source,
			target,
		});

		expect(mockRestoreEdgeOverride).toHaveBeenCalledWith(
			ctx,
			"ov-1",
			"user-1",
		);
		// No fresh create when a deleted row is being revived.
		expect(mockUpsertEdgeOverride).not.toHaveBeenCalled();
		expect(result.deletedAt).toBeNull();
		expect(result.isManual).toBe(true);
		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "atlas.edge.created" }),
		);
	});

	it("creates a manual override (isManual=true) when none exists", async () => {
		mockFindEdgeOverride.mockResolvedValue(null);
		mockUpsertEdgeOverride.mockResolvedValue(
			overrideRow({ isManual: true }),
		);

		const service = new AtlasService(ctx);
		await service.createEdge({
			projectId: "p1",
			mode: "TECHNICAL",
			source,
			target: { repositoryIntegrationId: "int-2", key: "b" },
		});

		expect(mockUpsertEdgeOverride).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				isManual: true,
				isCrossRepo: true, // int-1 != int-2
				branch: "main",
			}),
		);
		expect(mockRestoreEdgeOverride).not.toHaveBeenCalled();
	});
});

describe("deleteEdge - tracking override for a structural edge", () => {
	it("creates a non-manual tracking override then soft-deletes it", async () => {
		mockFindEdgeOverride.mockResolvedValue(null); // no override yet
		mockUpsertEdgeOverride.mockResolvedValue(overrideRow());
		mockSoftDeleteEdgeOverride.mockResolvedValue(
			overrideRow({ deletedAt: new Date() }),
		);

		const service = new AtlasService(ctx);
		const result = await service.deleteEdge({
			projectId: "p1",
			mode: "TECHNICAL",
			source,
			target,
		});

		expect(mockUpsertEdgeOverride).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ isManual: false }),
		);
		expect(mockSoftDeleteEdgeOverride).toHaveBeenCalledWith(
			ctx,
			"ov-1",
			"user-1",
		);
		expect(result.deletedAt).not.toBeNull();
		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "atlas.edge.deleted" }),
		);
	});

	it("is idempotent for an already-deleted edge (no second soft-delete)", async () => {
		mockFindEdgeOverride.mockResolvedValue(
			overrideRow({ deletedAt: new Date() }),
		);

		const service = new AtlasService(ctx);
		await service.deleteEdge({
			projectId: "p1",
			mode: "TECHNICAL",
			source,
			target,
		});

		expect(mockUpsertEdgeOverride).not.toHaveBeenCalled();
		expect(mockSoftDeleteEdgeOverride).not.toHaveBeenCalled();
	});
});

describe("getEdgeHistory", () => {
	it("returns [] when no override exists for the endpoints", async () => {
		mockFindEdgeOverride.mockResolvedValue(null);

		const service = new AtlasService(ctx);
		const history = await service.getEdgeHistory({
			projectId: "p1",
			mode: "TECHNICAL",
			source,
			target,
		});

		expect(history).toEqual([]);
		expect(mockGetEdgeOverrideHistory).not.toHaveBeenCalled();
	});

	it("delegates to the history query by override id when one exists", async () => {
		mockFindEdgeOverride.mockResolvedValue(overrideRow());
		mockGetEdgeOverrideHistory.mockResolvedValue([
			{
				id: "h1",
				action: "created",
				oldValue: null,
				newValue: "note",
				editedByUserId: "user-1",
				editedByName: "Alice",
				createdAt: "2026-06-10T00:00:00.000Z",
			},
		]);

		const service = new AtlasService(ctx);
		const history = await service.getEdgeHistory({
			projectId: "p1",
			mode: "TECHNICAL",
			source,
			target,
		});

		expect(mockGetEdgeOverrideHistory).toHaveBeenCalledWith(ctx, "ov-1");
		expect(history).toHaveLength(1);
		expect(history[0].action).toBe("created");
	});
});
