/**
 * `retrieveRelevantContextsForSpec` leaves out the transcripts the main
 * retrieval path leaves out: a confidential series' transcript and every
 * Parlume transcript (findConfidentialTranscriptContextIds names both).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	confidentialMock,
	generateEmbeddingsMock,
	searchMock,
	getContextMock,
	folderGuidanceMock,
} = vi.hoisted(() => ({
	confidentialMock: vi.fn(),
	generateEmbeddingsMock: vi.fn(),
	searchMock: vi.fn(),
	getContextMock: vi.fn(),
	folderGuidanceMock: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getEmbeddingRAGProviderConfig: vi.fn(async () => ({ provider: "openai" })),
}));
vi.mock("@repo/database", () => ({
	findConfidentialTranscriptContextIds: confidentialMock,
	getRetrievableContextById: getContextMock,
	loadProjectDatabricksKnowledgeBinding: vi.fn(),
	fetchCredentialsByIdInTenant: vi.fn(),
	withInheritedSourceGuidance: folderGuidanceMock,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isProjectDatabricksKnowledgeEnabled: vi.fn(() => false),
}));
vi.mock("../../chunking", () => ({
	parseChunkProfilesConfig: vi.fn(() => ({})),
	chunkText: vi.fn(() => [{ content: "chunk 0" }, { content: "chunk 1" }]),
}));
vi.mock("../../embedding", () => ({
	generateEmbeddings: generateEmbeddingsMock,
}));
vi.mock("../../embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
}));
vi.mock("../store", () => ({ searchSimilarProjectContexts: searchMock }));
vi.mock("../summary-injection", () => ({
	applyContextSummary: vi.fn(async (list: unknown[]) => list),
}));

import { retrieveRelevantContextsForSpec } from "../retrieve-for-spec";

const hit = (contextId: string) => ({
	contextId,
	score: 0.8,
	content: `chunk for ${contextId}`,
});

beforeEach(() => {
	vi.clearAllMocks();
	generateEmbeddingsMock.mockImplementation(async (texts: string[]) => ({
		embeddings: texts.map(() => [0.1, 0.2, 0.3]),
	}));
	searchMock
		.mockResolvedValueOnce([hit("ctx-parlume-transcript"), hit("ctx-prd")])
		.mockResolvedValueOnce([
			hit("ctx-secret-transcript"),
			hit("ctx-notes"),
		]);
	getContextMock.mockImplementation(async (id: string) => ({
		id,
		type: "TEXT",
		content: `content of ${id}`,
		createdAt: new Date("2026-11-01T00:00:00Z"),
		metadata: null,
		originalFilename: null,
		sourceUrl: null,
		sourceTitle: null,
	}));
	confidentialMock.mockResolvedValue(
		new Set(["ctx-parlume-transcript", "ctx-secret-transcript"]),
	);
	folderGuidanceMock.mockImplementation(
		async ({ rows }: { rows: Array<{ id: string }> }) => rows,
	);
});

describe("retrieveRelevantContextsForSpec and confidential transcripts", () => {
	it("checks every hit once and never reads or returns a confidential or Parlume transcript", async () => {
		const results = await retrieveRelevantContextsForSpec({
			projectId: "proj_1",
			userId: "user_1",
			organizationId: "org_1",
			specMarkdown: "# PRD\n\nThe rollout plan.",
			baselineDate: new Date("2026-01-01T00:00:00Z"),
			topK: 5,
		});

		expect(confidentialMock).toHaveBeenCalledTimes(1);
		expect(confidentialMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			contextIds: expect.arrayContaining([
				"ctx-parlume-transcript",
				"ctx-prd",
				"ctx-secret-transcript",
				"ctx-notes",
			]),
		});
		expect(results.map((result) => result.id).sort()).toEqual([
			"ctx-notes",
			"ctx-prd",
		]);
		expect(getContextMock).not.toHaveBeenCalledWith(
			"ctx-parlume-transcript",
		);
		expect(getContextMock).not.toHaveBeenCalledWith(
			"ctx-secret-transcript",
		);
	});
});

describe("retrieveRelevantContextsForSpec and document-folder guidance", () => {
	it("gives a folder file its folder's description, resolved once for the whole batch", async () => {
		folderGuidanceMock.mockImplementation(
			async ({
				rows,
			}: {
				rows: Array<{ id: string; aiInstructions?: string | null }>;
			}) =>
				rows.map((row) =>
					row.id === "ctx-prd"
						? { ...row, aiInstructions: "Signed case studies" }
						: row,
				),
		);

		const results = await retrieveRelevantContextsForSpec({
			projectId: "proj_1",
			userId: "user_1",
			organizationId: "org_1",
			specMarkdown: "# PRD\n\nThe rollout plan.",
			baselineDate: new Date("2026-01-01T00:00:00Z"),
			topK: 5,
		});

		expect(
			results.find((result) => result.id === "ctx-prd")?.aiInstructions,
		).toBe("Signed case studies");
		expect(
			results.find((result) => result.id === "ctx-notes")?.aiInstructions,
		).toBeUndefined();
		expect(folderGuidanceMock).toHaveBeenCalledTimes(1);
		expect(folderGuidanceMock.mock.calls[0]?.[0].projectId).toBe("proj_1");
		for (const call of getContextMock.mock.calls) {
			expect(call[1]).toEqual({ inheritFolderGuidance: false });
		}
	});
});
