/**
 * Unit Tests for the chat-document vector store search.
 *
 * Focus: the attached-document similarity-floor behaviour. When a chat surface
 * scopes a search to explicit `documentIds` AND marks it `explicitAttachment`
 * (the user attached those files to their message), `searchSimilarChunks` must
 * NOT apply the configured minSimilarity floor to the dense Qdrant search —
 * otherwise a document-Q&A question that embeds below the floor silently returns
 * 0 chunks and the model reports it "can't see the attachment" (the PDF/Markdown
 * Nexus attachment bug).
 *
 * The floor is dropped ONLY when both conditions hold. Programmatic/scoped
 * callers (e.g. the v1 knowledge API) that pass `documentIds` WITHOUT
 * `explicitAttachment` keep their `minSimilarity` relevance gate — so the fix
 * has no side effect outside the chat attachment surfaces.
 *
 * Run with: pnpm --filter @repo/rag test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	db: { documentChunk: { findMany: vi.fn().mockResolvedValue([]) } },
}));

const mockSearch = vi.fn();
const mockQuery = vi.fn();
const mockScroll = vi.fn();
const mockGetCollection = vi.fn();

vi.mock("../client", () => ({
	qdrantClient: {
		search: (...args: unknown[]) => mockSearch(...args),
		query: (...args: unknown[]) => mockQuery(...args),
		scroll: (...args: unknown[]) => mockScroll(...args),
		getCollection: (...args: unknown[]) => mockGetCollection(...args),
	},
}));

// Force the dense-only search branch (the one that applies score_threshold).
vi.mock("../../collection-manager", () => ({
	ensureCollection: vi.fn().mockResolvedValue("chat-documents"),
	getCollectionLayout: vi.fn().mockResolvedValue({
		collectionName: "chat-documents",
		denseVectorName: null,
		sparseVectorName: null,
		supportsHybrid: false,
	}),
}));

import { searchSimilarChunks } from "../store";

/** The "real" dense search is the only `qdrantClient.search` call that carries a `filter`. */
function realSearchOptions(): Record<string, unknown> {
	const call = mockSearch.mock.calls.find(
		(c) => c[1] && typeof c[1] === "object" && "filter" in c[1],
	);
	if (!call) {
		throw new Error("expected a filtered dense search call");
	}
	return call[1] as Record<string, unknown>;
}

describe("searchSimilarChunks — attached-document similarity floor", () => {
	const queryEmbedding = Array(1536).fill(0.1);

	beforeEach(() => {
		vi.clearAllMocks();
		mockScroll.mockResolvedValue({ points: [] });
		mockGetCollection.mockResolvedValue({
			points_count: 1,
			config: { params: { vectors: { size: 1536 } } },
		});
		// 0 results is fine — we assert on the search arguments, not the rows.
		mockSearch.mockResolvedValue([]);
	});

	it("drops the floor (score_threshold 0) for explicitly-attached documents", async () => {
		await searchSimilarChunks({
			chatId: "chat-1",
			userId: "user-1",
			organizationId: "org-1",
			queryEmbedding,
			topK: 5,
			minSimilarity: 0.5,
			documentIds: ["doc-attached-1"],
			explicitAttachment: true,
		});

		expect(realSearchOptions().score_threshold).toBe(0);
	});

	it("KEEPS the floor for documentIds-scoped retrieval WITHOUT explicitAttachment (e.g. v1 knowledge API)", async () => {
		await searchSimilarChunks({
			chatId: "chat-1",
			userId: "user-1",
			organizationId: "org-1",
			queryEmbedding,
			topK: 5,
			minSimilarity: 0.5,
			documentIds: ["doc-1"],
			// explicitAttachment omitted → programmatic/scoped caller
		});

		expect(realSearchOptions().score_threshold).toBe(0.5);
	});

	it("keeps the configured floor when no documentIds are provided", async () => {
		await searchSimilarChunks({
			chatId: "chat-1",
			userId: "user-1",
			organizationId: "org-1",
			queryEmbedding,
			topK: 5,
			minSimilarity: 0.5,
			explicitAttachment: true,
		});

		expect(realSearchOptions().score_threshold).toBe(0.5);
	});

	it("treats an empty documentIds array as no explicit filter (floor kept)", async () => {
		await searchSimilarChunks({
			chatId: "chat-1",
			userId: "user-1",
			organizationId: "org-1",
			queryEmbedding,
			topK: 5,
			minSimilarity: 0.5,
			documentIds: [],
			explicitAttachment: true,
		});

		expect(realSearchOptions().score_threshold).toBe(0.5);
	});

	it("scopes the dense search to the attached documents", async () => {
		await searchSimilarChunks({
			chatId: "chat-1",
			userId: "user-1",
			organizationId: "org-1",
			queryEmbedding,
			topK: 5,
			minSimilarity: 0.5,
			documentIds: ["doc-attached-1", "doc-attached-2"],
			explicitAttachment: true,
		});

		const filter = realSearchOptions().filter as {
			must: Array<{ key: string; match: { any?: string[] } }>;
		};
		const docClause = filter.must.find((m) => m.key === "documentId");
		expect(docClause?.match.any).toEqual([
			"doc-attached-1",
			"doc-attached-2",
		]);
	});
});
