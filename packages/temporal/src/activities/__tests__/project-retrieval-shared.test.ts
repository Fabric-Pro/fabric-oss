import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	query: vi.fn(),
	search: vi.fn(),
	rows: vi.fn(),
	pages: vi.fn(),
	context: vi.fn(),
	sparse: vi.fn(),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { query: h.query, search: h.search },
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	ensureCollection: async () => "example-collection",
	getCollectionLayout: async () => ({ supportsHybrid: true }),
}));
vi.mock("@repo/rag/lib/embedding/sparse", async (original) => {
	const actual =
		await original<typeof import("@repo/rag/lib/embedding/sparse")>();
	return { ...actual, generateSparseVector: h.sparse };
});
vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findMany: h.rows },
		projectContextUrlPage: { findMany: h.pages },
	},
	getRetrievableContextById: h.context,
	getRetrievableConversationBundleById: vi.fn(),
	getProjectRagSettings: async () => ({
		topK: 7,
		similarityThreshold: 0.67,
		enableReranking: false,
		rerankTopK: 3,
	}),
}));
vi.mock("@repo/ai", () => ({
	embed: async () => ({ embedding: [0.1, 0.2], usage: { tokens: 2 } }),
	getAIEmbeddingModelWithMetadata: async () => ({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	}),
	logEmbeddingUsageAsync: vi.fn(),
}));
vi.mock("@repo/rag", async () => ({
	SUMMARY_CONTEXT_TYPE: "CONTEXT_SUMMARY",
	searchSimilarProjectContexts: (
		await import("@repo/rag/lib/project-contexts/store")
	).searchSimilarProjectContexts,
	extractBaseContextId: (await import("@repo/rag/lib/utils/chunk-id"))
		.extractBaseContextId,
	buildDocumentRetrievalQuery: (
		await import("@repo/rag/lib/project-contexts/document-intents")
	).buildDocumentRetrievalQuery,
	selectProjectContexts: (
		await import("@repo/rag/lib/reranking/select-project-contexts")
	).selectProjectContexts,
	applyContextSummary: async (contexts: unknown) => contexts,
	enrichContextsWithRoleTags: async (contexts: unknown) => contexts,
	contextMetaHeader: () => "",
}));

import { retrieveProjectContexts as documentContexts } from "../project-document-generation";
import { retrieveProjectContexts as taskContexts } from "../task-agent/rag-context";

const tenant = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
};
const page = {
	id: "example-page",
	type: "LINK",
	content: "Website launch requirements",
	metadata: { parentContextId: "example-source" },
	sourceUrl: "https://example.com/launch",
	sourceTitle: "Launch",
};
const point = {
	id: "example-point",
	score: 0.9,
	payload: { contextId: page.id, projectId: tenant.projectId, type: "LINK" },
};

beforeEach(async () => {
	vi.clearAllMocks();
	const actual = await vi.importActual<
		typeof import("@repo/rag/lib/embedding/sparse")
	>("@repo/rag/lib/embedding/sparse");
	h.sparse.mockImplementation(actual.generateSparseVector);
	h.query.mockResolvedValue({ points: [point] });
	h.search.mockResolvedValue([point]);
	h.rows.mockResolvedValue([]);
	h.pages.mockResolvedValue([{ id: page.id }]);
	h.context.mockResolvedValue(page);
});

for (const operation of [
	{
		name: "document generation",
		call: () => documentContexts({ ...tenant, documentType: "PRD" }),
	},
	{
		name: "task agent",
		call: () =>
			taskContexts({
				...tenant,
				taskTitle: "Launch",
				taskDescription: "Requirements",
			}),
	},
]) {
	describe(operation.name, () => {
		it("reaches the store's dense plus sparse RRF branch", async () => {
			await operation.call();
			expect(h.sparse).toHaveBeenCalledTimes(1);
			expect(h.query).toHaveBeenCalledWith(
				"example-collection",
				expect.objectContaining({
					query: { fusion: "rrf" },
					prefetch: expect.arrayContaining([
						expect.objectContaining({ query: [0.1, 0.2] }),
						expect.objectContaining({
							query: h.sparse.mock.results[0].value,
							using: "sparse",
						}),
					]),
				}),
			);
			expect(
				h.sparse.mock.results[0].value.indices.length,
			).toBeGreaterThan(0);
			expect(h.search).not.toHaveBeenCalled();
		});

		it("hydrates a URL-page hit into the activity result", async () => {
			expect(await operation.call()).toEqual([page.content]);
			expect(h.context).toHaveBeenCalledWith(page.id);
		});

		it("uses dense search and still returns context when sparse encoding fails", async () => {
			h.sparse.mockImplementation(() => {
				throw new Error("encoder unavailable");
			});
			expect(await operation.call()).toEqual([page.content]);
			expect(h.query).not.toHaveBeenCalled();
			expect(h.search).toHaveBeenCalledWith(
				"example-collection",
				expect.objectContaining({ vector: [0.1, 0.2] }),
			);
		});
	});
}

it("identifies a URL page by its parent context source in the manifest", async () => {
	const result = await documentContexts({
		...tenant,
		documentType: "PRD",
		includeSourceManifest: true,
	});
	expect(result.contexts).toEqual([page.content]);
	expect(result.manifest).toEqual([
		expect.objectContaining({
			id: page.metadata.parentContextId,
			title: page.sourceTitle,
		}),
	]);
});

it.each([null, 42])(
	"keeps the context id when parent source metadata is %s",
	async (parentContextId) => {
		h.context.mockResolvedValue({ ...page, metadata: { parentContextId } });
		const result = await documentContexts({
			...tenant,
			documentType: "PRD",
			includeSourceManifest: true,
		});
		expect(result.manifest[0].id).toBe(page.id);
	},
);

it("passes the configured document semantic threshold to the dense prefetch", async () => {
	await documentContexts({ ...tenant, documentType: "PRD" });
	const query = h.query.mock.calls[0][1];
	expect(query.prefetch[0].score_threshold).toBe(0.67);
	expect(query.prefetch[1]).not.toHaveProperty("score_threshold");
	expect(query).not.toHaveProperty("score_threshold");
});
