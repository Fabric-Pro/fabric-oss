/**
 * Read overlays (T5): `getNodeDetail` returns the EFFECTIVE description/category
 * — the user override wins when `analysis.appliedUserOverrides` is true, and the
 * AI value is served when it is false (a "from fresh" analysis). The raw
 * override values + the source flags are always surfaced for the panel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNodeFindFirst = vi.fn();
const mockNodeFindMany = vi.fn();
const mockEdgeFindMany = vi.fn();
const mockAnalysisFindFirst = vi.fn();
const mockOverrideFindMany = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		atlasNode: {
			findFirst: (...a: unknown[]) => mockNodeFindFirst(...a),
			findMany: (...a: unknown[]) => mockNodeFindMany(...a),
		},
		atlasEdge: {
			findMany: (...a: unknown[]) => mockEdgeFindMany(...a),
		},
		atlasAnalysis: {
			findFirst: (...a: unknown[]) => mockAnalysisFindFirst(...a),
		},
		atlasNodeOverride: {
			findMany: (...a: unknown[]) => mockOverrideFindMany(...a),
		},
	},
	Prisma: {},
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));

import { getNodeDetail } from "../queries";

const ctx = { userId: "user-1", organizationId: "org-1" };

function makeNode() {
	return {
		key: "cap-1",
		kind: "CAPABILITY",
		label: "Billing",
		filePath: null,
		language: null,
		parentKey: null,
		technicalDescription: null,
		businessDescription: "AI billing description",
		category: "data",
		documentation: null,
		contentPreview: null,
		metrics: null,
		layout: null,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockNodeFindFirst.mockResolvedValue(makeNode());
	mockEdgeFindMany.mockResolvedValue([]); // no neighbours
	mockNodeFindMany.mockResolvedValue([]);
});

describe("getNodeDetail — override overlay", () => {
	it("serves the user override as effective desc/category when appliedUserOverrides is true", async () => {
		mockAnalysisFindFirst.mockResolvedValue({
			projectId: "p1",
			repositoryIntegrationId: "int-1",
			branch: "main",
			appliedUserOverrides: true,
		});
		mockOverrideFindMany.mockResolvedValue([
			{
				key: "cap-1",
				userDescription: "Human-written billing note",
				userCategory: "experience",
			},
		]);

		const detail = await getNodeDetail(ctx, {
			analysisId: "an-1",
			mode: "BUSINESS",
			key: "cap-1",
		});

		expect(detail).not.toBeNull();
		expect(detail?.description).toBe("Human-written billing note");
		expect(detail?.category).toBe("experience");
		expect(detail?.isUserCategory).toBe(true);
		expect(detail?.isUserDescription).toBe(true);
		expect(detail?.userDescription).toBe("Human-written billing note");
		expect(detail?.userCategory).toBe("experience");
		// The AI values are still carried for reference.
		expect(detail?.businessDescription).toBe("AI billing description");
		expect(detail?.editable).toBe(true);
	});

	it("serves the AI value (no overlay) when appliedUserOverrides is false (from-fresh)", async () => {
		mockAnalysisFindFirst.mockResolvedValue({
			projectId: "p1",
			repositoryIntegrationId: "int-1",
			branch: "main",
			appliedUserOverrides: false,
		});

		const detail = await getNodeDetail(ctx, {
			analysisId: "an-1",
			mode: "BUSINESS",
			key: "cap-1",
		});

		expect(detail?.description).toBe("AI billing description");
		expect(detail?.category).toBe("data");
		expect(detail?.isUserCategory).toBe(false);
		expect(detail?.isUserDescription).toBe(false);
		expect(detail?.userDescription).toBeNull();
		expect(detail?.userCategory).toBeNull();
		// `applied:false` short-circuits — the override table is never queried.
		expect(mockOverrideFindMany).not.toHaveBeenCalled();
	});

	it("falls back to the AI value when overrides apply but the node has none", async () => {
		mockAnalysisFindFirst.mockResolvedValue({
			projectId: "p1",
			repositoryIntegrationId: "int-1",
			branch: "main",
			appliedUserOverrides: true,
		});
		mockOverrideFindMany.mockResolvedValue([]); // no override for this node

		const detail = await getNodeDetail(ctx, {
			analysisId: "an-1",
			mode: "BUSINESS",
			key: "cap-1",
		});

		expect(detail?.description).toBe("AI billing description");
		expect(detail?.category).toBe("data");
		expect(detail?.isUserCategory).toBe(false);
		expect(detail?.userDescription).toBeNull();
	});
});
