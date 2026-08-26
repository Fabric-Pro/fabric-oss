/**
 * Edge overlay (Feature B): `getGraph` overlays user edge overrides onto the
 * structural edges — attaches a user description, DROPS a soft-deleted edge
 * (unless includeDeleted), and ADDS manual (user-drawn) edges. Mirrors the
 * node-override overlay test (queries-level with a mocked db).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNodeFindMany = vi.fn();
const mockEdgeFindMany = vi.fn();
const mockAnalysisFindFirst = vi.fn();
const mockOverrideFindMany = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		atlasNode: {
			findMany: (...a: unknown[]) => mockNodeFindMany(...a),
		},
		atlasEdge: {
			findMany: (...a: unknown[]) => mockEdgeFindMany(...a),
		},
		atlasAnalysis: {
			findFirst: (...a: unknown[]) => mockAnalysisFindFirst(...a),
		},
		atlasEdgeOverride: {
			findMany: (...a: unknown[]) => mockOverrideFindMany(...a),
		},
		// override-overlay (loadOverrideOverlay) short-circuits because
		// appliedUserOverrides is false in these tests — never queried.
		atlasNodeOverride: { findMany: vi.fn() },
	},
	Prisma: {},
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));

import { getGraph } from "../queries";

const ctx = { userId: "user-1", organizationId: "org-1" };

function node(key: string) {
	return {
		key,
		kind: "MODULE",
		label: key,
		filePath: null,
		language: null,
		parentKey: null,
		technicalDescription: `desc ${key}`,
		businessDescription: null,
		category: null,
		metrics: null,
		layout: null,
	};
}

function override(over: Record<string, unknown>) {
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
	mockNodeFindMany.mockResolvedValue([node("a"), node("b")]);
	mockEdgeFindMany.mockResolvedValue([
		{ sourceKey: "a", targetKey: "b", kind: "DEPENDS_ON", weight: 1 },
	]);
	// appliedUserOverrides=false → node overlay is skipped; analysis row carries
	// the project/repo/branch used to load edge overrides.
	mockAnalysisFindFirst.mockResolvedValue({
		projectId: "p1",
		repositoryIntegrationId: "int-1",
		branch: "main",
		appliedUserOverrides: false,
	});
	mockOverrideFindMany.mockResolvedValue([]);
});

describe("getGraph — edge overlay", () => {
	it("attaches a user description onto a matching structural edge", async () => {
		mockOverrideFindMany.mockResolvedValue([
			override({ userDescription: "calls the billing API" }),
		]);

		const { edges } = await getGraph(ctx, "an-1", "TECHNICAL");

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			source: "a",
			target: "b",
			description: "calls the billing API",
			isManual: false,
			isUserDescription: true,
			deleted: false,
			overrideId: "ov-1",
		});
	});

	it("drops a soft-deleted structural edge by default, keeps it with includeDeleted", async () => {
		mockOverrideFindMany.mockResolvedValue([
			override({ deletedAt: new Date() }),
		]);

		const def = await getGraph(ctx, "an-1", "TECHNICAL");
		expect(def.edges).toHaveLength(0);

		const incl = await getGraph(ctx, "an-1", "TECHNICAL", {
			includeDeleted: true,
		});
		expect(incl.edges).toHaveLength(1);
		expect(incl.edges[0].deleted).toBe(true);
	});

	it("adds a manual (user-drawn) edge whose endpoints both exist", async () => {
		mockEdgeFindMany.mockResolvedValue([]); // no structural edges
		mockOverrideFindMany.mockResolvedValue([
			override({
				id: "ov-manual",
				isManual: true,
				userDescription: "shares a queue",
			}),
		]);

		const { edges } = await getGraph(ctx, "an-1", "TECHNICAL");

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			source: "a",
			target: "b",
			isManual: true,
			isUserDescription: true,
			description: "shares a queue",
			overrideId: "ov-manual",
		});
	});

	it("does not add a manual edge whose endpoint node is missing", async () => {
		mockEdgeFindMany.mockResolvedValue([]);
		mockOverrideFindMany.mockResolvedValue([
			override({ id: "ov-manual", isManual: true, targetKey: "ghost" }),
		]);

		const { edges } = await getGraph(ctx, "an-1", "TECHNICAL");
		expect(edges).toHaveLength(0);
	});

	it("ignores cross-repo overrides on the solo graph (endpoints not both intra-repo)", async () => {
		mockOverrideFindMany.mockResolvedValue([
			override({
				userDescription: "cross note",
				isCrossRepo: true,
				targetRepositoryIntegrationId: "int-2",
			}),
		]);

		const { edges } = await getGraph(ctx, "an-1", "TECHNICAL");
		// The structural edge is still returned, but with NO overlaid description
		// (the override targets a different repo, so it is not a solo override).
		expect(edges).toHaveLength(1);
		expect(edges[0].description).toBeNull();
		expect(edges[0].isUserDescription).toBe(false);
	});
});
