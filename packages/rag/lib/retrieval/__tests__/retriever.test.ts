/**
 * Unit Tests for RAG Retrieval Module
 *
 * Tests context retrieval, formatting, and error handling.
 * Run with: pnpm --filter @repo/rag test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Define RetrievalResult type for tests
interface RetrievalResult {
	id: string;
	documentId: string;
	content: string;
	similarity: number;
	filename: string;
	metadata: Record<string, unknown>;
}

// Mock dependencies BEFORE importing any modules that use them
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
	},
}));

// Mock embedding module to avoid API key check
vi.mock("../../embedding", () => ({
	generateEmbedding: vi.fn(),
}));

// Mock vector-store module
vi.mock("../../vector-store", () => ({
	searchSimilarChunks: vi.fn(),
}));

import { generateEmbedding } from "../../embedding";
import { searchSimilarChunks } from "../../vector-store";
// Now import the module under test
import { formatContextForLLM, retrieveContext } from "../retriever";

// Get the mocked functions
const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockSearchSimilarChunks = vi.mocked(searchSimilarChunks);

describe("RAG Retrieval Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("retrieveContext", () => {
		const mockEmbedding = Array(1536).fill(0.1);

		it("should retrieve context successfully", async () => {
			const mockResults: RetrievalResult[] = [
				{
					id: "chunk-1",
					documentId: "doc-1",
					content: "First chunk content about machine learning",
					similarity: 0.92,
					filename: "ml-guide.pdf",
					metadata: { chunkIndex: 0 },
				},
				{
					id: "chunk-2",
					documentId: "doc-1",
					content: "Second chunk about neural networks",
					similarity: 0.85,
					filename: "ml-guide.pdf",
					metadata: { chunkIndex: 1 },
				},
			];

			mockGenerateEmbedding.mockResolvedValue({
				embedding: mockEmbedding,
				model: "text-embedding-3-small",
				tokens: 10,
			});
			mockSearchSimilarChunks.mockResolvedValue(mockResults);

			const results = await retrieveContext({
				chatId: "chat-123",
				userId: "user-123",
				organizationId: "org-123",
				apiKey: "test-api-key",
				query: "What is machine learning?",
				topK: 5,
				minSimilarity: 0.5,
			});

			expect(results).toHaveLength(2);
			expect(results[0].similarity).toBe(0.92);
			expect(mockGenerateEmbedding).toHaveBeenCalledWith(
				"What is machine learning?",
				expect.objectContaining({
					userId: "user-123",
					organizationId: "org-123",
				}),
				"test-api-key",
			);
			expect(mockSearchSimilarChunks).toHaveBeenCalledWith(
				expect.objectContaining({
					chatId: "chat-123",
					userId: "user-123",
					topK: 5,
					minSimilarity: 0.5,
				}),
			);
		});

		it("should return empty array on error", async () => {
			mockGenerateEmbedding.mockRejectedValue(
				new Error("Embedding service unavailable"),
			);

			const results = await retrieveContext({
				chatId: "chat-123",
				userId: "user-123",
				apiKey: "test-api-key",
				query: "Test query",
			});

			expect(results).toEqual([]);
		});

		it("should pass document IDs filter when provided", async () => {
			mockGenerateEmbedding.mockResolvedValue({
				embedding: mockEmbedding,
				model: "text-embedding-3-small",
				tokens: 10,
			});
			mockSearchSimilarChunks.mockResolvedValue([]);

			await retrieveContext({
				chatId: "chat-123",
				userId: "user-123",
				apiKey: "test-api-key",
				query: "Test query",
				documentIds: ["doc-1", "doc-2"],
			});

			expect(mockSearchSimilarChunks).toHaveBeenCalledWith(
				expect.objectContaining({
					documentIds: ["doc-1", "doc-2"],
				}),
			);
		});

		it("should use default topK and minSimilarity", async () => {
			mockGenerateEmbedding.mockResolvedValue({
				embedding: mockEmbedding,
				model: "text-embedding-3-small",
				tokens: 10,
			});
			mockSearchSimilarChunks.mockResolvedValue([]);

			await retrieveContext({
				chatId: "chat-123",
				userId: "user-123",
				apiKey: "test-api-key",
				query: "Test query",
			});

			expect(mockSearchSimilarChunks).toHaveBeenCalledWith(
				expect.objectContaining({
					topK: 5,
					minSimilarity: 0.5,
				}),
			);
		});
	});

	describe("formatContextForLLM", () => {
		const mockResults: RetrievalResult[] = [
			{
				id: "chunk-1",
				documentId: "doc-1",
				content: "Machine learning is a subset of AI.",
				similarity: 0.95,
				filename: "ai-overview.pdf",
				metadata: {},
			},
			{
				id: "chunk-2",
				documentId: "doc-2",
				content: "Neural networks are computing systems.",
				similarity: 0.88,
				filename: "deep-learning.pdf",
				metadata: {},
			},
		];

		it("should return empty string for empty results", () => {
			const formatted = formatContextForLLM([]);
			expect(formatted).toBe("");
		});

		it("should include all context chunks", () => {
			const formatted = formatContextForLLM(mockResults);
			expect(formatted).toContain("Machine learning is a subset of AI.");
			expect(formatted).toContain(
				"Neural networks are computing systems.",
			);
		});

		it("should include source document filenames", () => {
			const formatted = formatContextForLLM(mockResults);
			expect(formatted).toContain("ai-overview.pdf");
			expect(formatted).toContain("deep-learning.pdf");
		});

		it("should include similarity scores", () => {
			const formatted = formatContextForLLM(mockResults);
			expect(formatted).toContain("95.0%");
			expect(formatted).toContain("88.0%");
		});

		it("should include critical instructions", () => {
			const formatted = formatContextForLLM(mockResults);
			expect(formatted).toContain("CRITICAL INSTRUCTIONS");
			expect(formatted).toContain("BASE YOUR RESPONSE ONLY");
			expect(formatted).toContain("CITE YOUR SOURCES");
		});

		it("should include document count summary", () => {
			const formatted = formatContextForLLM(mockResults);
			expect(formatted).toContain("2 relevant section(s)");
			expect(formatted).toContain("2 document(s)");
		});

		it("should handle new document flag", () => {
			const formatted = formatContextForLLM(mockResults, {
				isNewDocument: true,
				documentIds: ["doc-new"],
			});
			expect(formatted).toContain("NEW DOCUMENT ATTACHED");
			expect(formatted).toContain("NEWLY ATTACHED DOCUMENT");
		});

		it("should not include new document instructions when not applicable", () => {
			const formatted = formatContextForLLM(mockResults);
			expect(formatted).not.toContain("NEW DOCUMENT ATTACHED");
		});

		describe("purpose: enrichment mode", () => {
			it("should use enrichment instructions instead of strict QA", () => {
				const formatted = formatContextForLLM(mockResults, {
					purpose: "enrichment",
				});
				expect(formatted).toContain("UPLOADED FILE CONTEXT");
				expect(formatted).toContain("ADDITIONAL CONTEXT");
				expect(formatted).toContain("INTEGRATE uploaded file content");
				expect(formatted).not.toContain("CRITICAL INSTRUCTIONS");
				expect(formatted).not.toContain("BASE YOUR RESPONSE ONLY");
			});

			it("should allow general knowledge in enrichment mode", () => {
				const formatted = formatContextForLLM(mockResults, {
					purpose: "enrichment",
				});
				expect(formatted).toContain("You MAY use general knowledge");
			});

			it("should include conflict resolution guidance in enrichment mode", () => {
				const formatted = formatContextForLLM(mockResults, {
					purpose: "enrichment",
				});
				expect(formatted).toContain("conflict with other context");
			});

			it("should default to QA mode when purpose not specified", () => {
				const formatted = formatContextForLLM(mockResults);
				expect(formatted).toContain("CRITICAL INSTRUCTIONS");
				expect(formatted).not.toContain("UPLOADED FILE CONTEXT");
			});
		});

		describe("image content detection", () => {
			const imageResults: RetrievalResult[] = [
				{
					id: "chunk-img",
					documentId: "doc-img",
					content: "Extracted text from architecture diagram",
					similarity: 0.88,
					filename: "architecture.png",
					metadata: {},
				},
			];

			it("should detect image files and add image note in QA mode", () => {
				const formatted = formatContextForLLM(imageResults);
				expect(formatted).toContain("IMAGE CONTENT NOTE");
				expect(formatted).toContain(
					"extracted from images via AI vision processing",
				);
			});

			it("should detect image files and add image note in enrichment mode", () => {
				const formatted = formatContextForLLM(imageResults, {
					purpose: "enrichment",
				});
				expect(formatted).toContain("IMAGE CONTENT NOTE");
				expect(formatted).toContain("general knowledge to interpret");
			});

			it("should not add image note when no image files", () => {
				const formatted = formatContextForLLM(mockResults);
				expect(formatted).not.toContain("IMAGE CONTENT NOTE");
			});

			it("should detect various image extensions", () => {
				const extensions = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
				for (const ext of extensions) {
					const results: RetrievalResult[] = [
						{
							id: "chunk-1",
							documentId: "doc-1",
							content: "test",
							similarity: 0.9,
							filename: `image${ext}`,
							metadata: {},
						},
					];
					const formatted = formatContextForLLM(results);
					expect(formatted).toContain("IMAGE CONTENT NOTE");
				}
			});
		});
	});
});
