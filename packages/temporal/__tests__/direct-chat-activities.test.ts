/**
 * Tests for Direct Chat Activities
 *
 * Tests the activity functions used by the Direct Chat workflow.
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		mCPConfig: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		userOrchestratorPreferences: {
			findUnique: vi.fn().mockResolvedValue(null),
		},
		chatDocument: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		ragChunk: {
			findMany: vi.fn().mockResolvedValue([]),
		},
	},
	getMcpConfigsByUser: vi.fn().mockResolvedValue([]),
	getMcpConfigsByOrganization: vi.fn().mockResolvedValue([]),
	getWorkflowById: vi.fn(),
	listWorkflows: vi.fn(),
	getAiProviderApiKey: vi.fn().mockResolvedValue({ apiKey: null }),
	updateProviderLastUsed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/agent-core/backend", () => ({
	canMcpToolsHandleTask: vi
		.fn()
		.mockReturnValue({ canHandle: false, matchedTools: [] }),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn(),
	generateMemoryContext: vi
		.fn()
		.mockResolvedValue({ contextString: "", memoryCount: 0 }),
	getConfiguredAIModel: vi.fn().mockResolvedValue({}),
}));

vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	tool: vi.fn((schema) => schema),
	stepCountIs: vi.fn(() => () => true),
	selectModelDynamic: vi.fn().mockResolvedValue({
		providerModelId: "openai/gpt-oss-120b",
		selectionSource: "system-default",
	}),
	getRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "test-api-key",
		provider: "OPENAI_DIRECT",
	}),
}));

vi.mock("@repo/rag", () => ({
	retrieveContext: vi.fn().mockResolvedValue([]),
	formatContextForLLM: vi.fn().mockReturnValue(""),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((key) => key),
}));

// Static imports — see header comment.
import {
	canMcpToolsHandleTask,
	generateMemoryContext,
	getDetailedMcpToolInfo,
} from "@repo/agent-core/backend";
import { db } from "@repo/database";
import { formatContextForLLM, retrieveContext } from "@repo/rag";
import {
	collectMcpToolsActivity,
	generateMemoryContextActivity,
	generateToolSuggestionsActivity,
	retrieveRagContextForDirectChatActivity,
} from "../src/activities/direct-chat";

describe("Direct Chat Activities", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Note: getConfiguredModelActivity was removed - model configuration is now
	// handled inside executeDirectChatActivity to avoid serialization issues

	describe("collectMcpToolsActivity", () => {
		it("should return empty tools when no MCP configs", async () => {
			(
				getDetailedMcpToolInfo as ReturnType<typeof vi.fn>
			).mockResolvedValueOnce([]);

			const result = await collectMcpToolsActivity(
				"user-123",
				undefined,
				[],
			);

			expect(result.tools).toEqual({});
			expect(result.toolToServerMap).toEqual({});
			expect(result.mcpToolInfo).toEqual([]);
		});
	});

	describe("generateMemoryContextActivity", () => {
		it("should generate memory context for message", async () => {
			(
				generateMemoryContext as ReturnType<typeof vi.fn>
			).mockResolvedValueOnce({
				contextString: "Previous session context...",
				memoryCount: 2,
			});

			const result = await generateMemoryContextActivity(
				"What's the status?",
				"user-123",
				"org-456",
			);

			// When memories are found, context should include the header
			expect(result.context).toContain(
				"Relevant Context from Previous Sessions",
			);
			expect(result.memoryCount).toBe(2);
		});

		it("should return empty context when no memories found", async () => {
			(
				generateMemoryContext as ReturnType<typeof vi.fn>
			).mockResolvedValueOnce({
				contextString: "",
				memoryCount: 0,
			});

			const result = await generateMemoryContextActivity(
				"Hello",
				"user-123",
				undefined,
			);

			expect(result.context).toBe("");
			expect(result.memoryCount).toBe(0);
		});
	});

	describe("generateToolSuggestionsActivity", () => {
		it("should return empty when no tools can handle task", async () => {
			(
				canMcpToolsHandleTask as ReturnType<typeof vi.fn>
			).mockResolvedValueOnce({
				canHandle: false,
			});

			const result = await generateToolSuggestionsActivity("Hello", []);

			expect(result).toBe("");
		});
	});

	describe("retrieveRagContextForDirectChatActivity", () => {
		it("should return empty context when no document IDs provided", async () => {
			const result = await retrieveRagContextForDirectChatActivity(
				"What is in my document?",
				"user-123",
				undefined,
				"chat-123",
				[], // Empty document IDs
			);

			expect(result.context).toBe("");
			expect(result.chunkCount).toBe(0);
		});

		it("should return empty context when documentIds is undefined", async () => {
			const result = await retrieveRagContextForDirectChatActivity(
				"Search query",
				"user-123",
				"org-456",
				"chat-123",
				undefined, // No document IDs
			);

			expect(result.context).toBe("");
			expect(result.chunkCount).toBe(0);
		});

		it("should retrieve RAG context when documents are attached", async () => {
			// Mock document status check - documents are ready
			(
				db.chatDocument.findMany as ReturnType<typeof vi.fn>
			).mockResolvedValue([
				{
					id: "doc-123",
					filename: "test.pdf",
					status: "READY",
				},
			]);

			// getRAGProviderConfig is already mocked in @repo/ai mock to return test-api-key

			// Mock successful RAG retrieval
			const mockChunks = [
				{
					id: "chunk-1",
					content: "This is relevant content from the document.",
					documentId: "doc-123",
					score: 0.95,
				},
				{
					id: "chunk-2",
					content: "Another relevant section.",
					documentId: "doc-123",
					score: 0.85,
				},
			];
			(retrieveContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				mockChunks,
			);
			(
				formatContextForLLM as ReturnType<typeof vi.fn>
			).mockReturnValueOnce(
				"Document 1:\n- This is relevant content from the document.\n- Another relevant section.",
			);

			const result = await retrieveRagContextForDirectChatActivity(
				"What is in my document?",
				"user-123",
				"org-456",
				"chat-123",
				["doc-123"], // Attached document
			);

			expect(result.chunkCount).toBe(2);
			expect(result.context).toContain("Context from Attached Documents");
			expect(retrieveContext).toHaveBeenCalledWith({
				chatId: "chat-123",
				query: "What is in my document?",
				userId: "user-123",
				organizationId: "org-456",
				documentIds: ["doc-123"],
				topK: 5,
				minSimilarity: 0.1,
				apiKey: "test-api-key", // From getRAGProviderConfig mock
				// These are user-attached documents, so the activity marks the
				// retrieval as an explicit attachment to drop the similarity floor.
				explicitAttachment: true,
			});
		});

		it("should handle RAG retrieval failure gracefully", async () => {
			// Mock document status check - documents are ready
			(
				db.chatDocument.findMany as ReturnType<typeof vi.fn>
			).mockResolvedValue([
				{
					id: "doc-123",
					filename: "test.pdf",
					status: "READY",
				},
			]);

			// getRAGProviderConfig is already mocked in @repo/ai mock to return test-api-key

			// Mock RAG failure
			(retrieveContext as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new Error("Vector database connection failed"),
			);

			// Should not throw, should return error message in context
			const result = await retrieveRagContextForDirectChatActivity(
				"Search query",
				"user-123",
				undefined,
				"chat-123",
				["doc-123"],
			);

			expect(result.context).toContain("Document Processing Error");
			expect(result.chunkCount).toBe(0);
		});

		it("should return empty context when no relevant chunks found", async () => {
			// Mock document status check - documents are ready (first call)
			// Then mock the second call to get ready documents for the helpful message
			(db.chatDocument.findMany as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce([
					{
						id: "doc-456",
						filename: "test.pdf",
						status: "READY",
					},
				])
				.mockResolvedValueOnce([
					{
						filename: "test.pdf",
					},
				]);

			// getRAGProviderConfig is already mocked in @repo/ai mock to return test-api-key

			// Mock empty results
			(retrieveContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				[],
			);

			const result = await retrieveRagContextForDirectChatActivity(
				"Completely unrelated query",
				"user-123",
				undefined,
				"chat-123",
				["doc-456"],
			);

			// When documents are ready but no chunks found, should return helpful message
			expect(result.context).toContain("Document Context");
			expect(result.context).toContain("test.pdf");
			expect(result.chunkCount).toBe(0);
		});

		it("should use placeholder chatId when not provided", async () => {
			// Mock document status check - documents are ready
			(
				db.chatDocument.findMany as ReturnType<typeof vi.fn>
			).mockResolvedValue([
				{
					id: "doc-123",
					filename: "test.pdf",
					status: "READY",
				},
			]);

			// getRAGProviderConfig is already mocked in @repo/ai mock to return test-api-key

			const mockChunks = [
				{
					id: "chunk-1",
					content: "Test",
					documentId: "doc-1",
					score: 0.9,
				},
			];
			(retrieveContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				mockChunks,
			);
			(
				formatContextForLLM as ReturnType<typeof vi.fn>
			).mockReturnValueOnce("Formatted");

			await retrieveRagContextForDirectChatActivity(
				"Query",
				"user-123",
				undefined,
				undefined, // No chatId
				["doc-123"],
			);

			// Should have been called with a generated chatId and API key from getRAGProviderConfig
			expect(retrieveContext).toHaveBeenCalledWith(
				expect.objectContaining({
					chatId: expect.stringContaining("direct-chat-"),
					apiKey: "test-api-key", // From getRAGProviderConfig mock
				}),
			);
		});
	});

	describe("TokenUsage type", () => {
		it("should have correct structure for token usage", async () => {
			// TokenUsage should have these optional fields
			const usage: import("../src/types").TokenUsage = {
				inputTokens: 1000,
				outputTokens: 500,
				totalTokens: 1500,
				reasoningTokens: 100,
				cachedInputTokens: 200,
			};

			expect(usage.inputTokens).toBe(1000);
			expect(usage.outputTokens).toBe(500);
			expect(usage.totalTokens).toBe(1500);
			expect(usage.reasoningTokens).toBe(100);
			expect(usage.cachedInputTokens).toBe(200);
		});

		it("should allow partial token usage", async () => {
			const usage: import("../src/types").TokenUsage = {
				inputTokens: 500,
				outputTokens: 250,
			};

			expect(usage.inputTokens).toBe(500);
			expect(usage.outputTokens).toBe(250);
			expect(usage.totalTokens).toBeUndefined();
		});
	});

	describe("DirectChatWorkflowOutput with usage", () => {
		it("should include usage in output type", async () => {
			const output: import("../src/types").DirectChatWorkflowOutput = {
				success: true,
				responseText: "Hello!",
				toolCalls: [],
				durationMs: 1000,
				usage: {
					inputTokens: 100,
					outputTokens: 50,
					totalTokens: 150,
				},
			};

			expect(output.success).toBe(true);
			expect(output.usage).toBeDefined();
			expect(output.usage?.inputTokens).toBe(100);
			expect(output.usage?.outputTokens).toBe(50);
			expect(output.usage?.totalTokens).toBe(150);
		});

		it("should allow output without usage", async () => {
			const output: import("../src/types").DirectChatWorkflowOutput = {
				success: true,
				responseText: "Hello!",
			};

			expect(output.usage).toBeUndefined();
		});
	});
});
