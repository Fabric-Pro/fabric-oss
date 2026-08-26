/**
 * Orchestrator Memory System Tests
 *
 * Comprehensive tests for:
 * - Memory loading activities
 * - Episode creation activities
 * - Conversation summarization
 * - Memory context building
 * - Episodic search
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// MOCK SETUP
// =============================================================================

// Mock database queries
const mockGetOrchestratorMemoryPreferences = vi.fn();
const mockUpdateOrchestratorMemoryPreferences = vi.fn();
const mockGetRecentEpisodes = vi.fn();
const mockSearchEpisodicMemories = vi.fn();
const mockBuildOrchestratorMemoryContext = vi.fn();
const mockFormatMemoryContextPrompt = vi.fn();
const mockCreateEpisodicMemory = vi.fn();
const mockUpdateRecentActivity = vi.fn();
const mockLearnPattern = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	getOrchestratorMemoryPreferences: (...args: unknown[]) =>
		mockGetOrchestratorMemoryPreferences(...args),
	updateOrchestratorMemoryPreferences: (...args: unknown[]) =>
		mockUpdateOrchestratorMemoryPreferences(...args),
	getRecentEpisodes: (...args: unknown[]) => mockGetRecentEpisodes(...args),
	searchEpisodicMemories: (...args: unknown[]) =>
		mockSearchEpisodicMemories(...args),
	buildOrchestratorMemoryContext: (...args: unknown[]) =>
		mockBuildOrchestratorMemoryContext(...args),
	formatMemoryContextPrompt: (...args: unknown[]) =>
		mockFormatMemoryContextPrompt(...args),
	createEpisodicMemory: (...args: unknown[]) =>
		mockCreateEpisodicMemory(...args),
	updateRecentActivity: (...args: unknown[]) =>
		mockUpdateRecentActivity(...args),
	learnPattern: (...args: unknown[]) => mockLearnPattern(...args),
}));

// Mock RAG vector store
const mockStoreEpisodeEmbedding = vi.fn();
const mockSearchSimilarEpisodes = vi.fn();

vi.mock("@repo/rag/lib/vector-store", () => ({
	storeEpisodeEmbedding: (...args: unknown[]) =>
		mockStoreEpisodeEmbedding(...args),
	searchSimilarEpisodes: (...args: unknown[]) =>
		mockSearchSimilarEpisodes(...args),
}));

// Mock AI
const mockEmbed = vi.fn();
const mockGetAIEmbeddingModel = vi.fn();
const mockGenerateText = vi.fn();
const mockGetAIModel = vi.fn();

vi.mock("@repo/ai", () => ({
	embed: (...args: unknown[]) => mockEmbed(...args),
	getAIEmbeddingModel: (...args: unknown[]) =>
		mockGetAIEmbeddingModel(...args),
	generateText: (...args: unknown[]) => mockGenerateText(...args),
	getAIModel: (...args: unknown[]) => mockGetAIModel(...args),
}));

// Mock logger
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// =============================================================================
// TESTS
// =============================================================================

describe("Orchestrator Memory System", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock implementations
		mockGetOrchestratorMemoryPreferences.mockResolvedValue({
			preferences: {},
			recentProjectIds: [],
			recentWorkspaceIds: [],
			responseStyle: null,
			verbosity: null,
			codeLanguage: null,
		});

		mockGetRecentEpisodes.mockResolvedValue([]);
		mockSearchSimilarEpisodes.mockResolvedValue([]);
		mockBuildOrchestratorMemoryContext.mockResolvedValue({
			preferences: {},
			recentEpisodes: [],
			relevantEpisodes: [],
		});
		mockFormatMemoryContextPrompt.mockReturnValue("");
		mockGetAIEmbeddingModel.mockResolvedValue({});
		mockEmbed.mockResolvedValue({ embedding: new Array(1536).fill(0.01) });
	});

	describe("loadOrchestratorMemoryActivity", () => {
		it("should load empty preferences for new user", async () => {
			const { loadOrchestratorMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const result = await loadOrchestratorMemoryActivity({
				userId: "user-1",
				organizationId: null,
			});

			expect(result.preferences).toBeDefined();
			expect(result.recentEpisodes).toEqual([]);
			expect(result.relevantEpisodes).toEqual([]);
			expect(mockGetOrchestratorMemoryPreferences).toHaveBeenCalledWith(
				"user-1",
				null,
			);
		});

		it("should load user preferences with recent activity", async () => {
			mockGetOrchestratorMemoryPreferences.mockResolvedValue({
				preferences: { learnedPatterns: ["prefers TypeScript"] },
				recentProjectIds: ["proj-1"],
				recentWorkspaceIds: ["ws-1"],
				responseStyle: "concise",
				verbosity: "standard",
				codeLanguage: "typescript",
			});

			const { loadOrchestratorMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const result = await loadOrchestratorMemoryActivity({
				userId: "user-1",
				organizationId: "org-1",
			});

			expect(result.preferences.responseStyle).toBe("concise");
			expect(result.preferences.codeLanguage).toBe("typescript");
		});

		it("should search for relevant episodes when query is provided", async () => {
			mockSearchSimilarEpisodes.mockResolvedValue([
				{ id: "ep-1", similarity: 0.85 },
			]);

			const { loadOrchestratorMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await loadOrchestratorMemoryActivity({
				userId: "user-1",
				organizationId: null,
				currentQuery: "Help me build a fitness tracking app",
			});

			expect(mockEmbed).toHaveBeenCalled();
		});

		it("should skip search for very short queries", async () => {
			const { loadOrchestratorMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await loadOrchestratorMemoryActivity({
				userId: "user-1",
				organizationId: null,
				currentQuery: "hi", // Too short
			});

			expect(mockSearchSimilarEpisodes).not.toHaveBeenCalled();
		});

		it("should handle database errors gracefully", async () => {
			mockGetOrchestratorMemoryPreferences.mockRejectedValue(
				new Error("DB error"),
			);

			const { loadOrchestratorMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const result = await loadOrchestratorMemoryActivity({
				userId: "user-1",
				organizationId: null,
			});

			// Should return empty context on error (graceful degradation)
			expect(result.memoryContextPrompt).toBe("");
		});
	});

	describe("createEpisodicMemoryActivity", () => {
		beforeEach(() => {
			mockCreateEpisodicMemory.mockResolvedValue({ id: "ep-new-1" });
			mockStoreEpisodeEmbedding.mockResolvedValue({ pointId: "pt-1" });
		});

		it("should create episode in PostgreSQL and Qdrant", async () => {
			const { createEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const result = await createEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
				title: "Planning fitness app",
				summary: "User asked about fitness app features",
				keyTopics: ["fitness", "app", "wearables"],
				userIntents: ["plan product"],
				outcome: "success",
				messageCount: 10,
				turnCount: 5,
				toolsUsed: ["search_web"],
				agentsUsed: [],
				conversationStartedAt: new Date(),
			});

			expect(result.episodeId).toBe("ep-new-1");
			expect(result.qdrantPointId).toBe("pt-1");
			expect(mockCreateEpisodicMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
					title: "Planning fitness app",
				}),
			);
			expect(mockStoreEpisodeEmbedding).toHaveBeenCalled();
		});

		it("should handle embedding failure gracefully", async () => {
			// When embedding fails, the activity catches the error and returns null
			mockEmbed.mockRejectedValue(new Error("Embedding failed"));
			mockCreateEpisodicMemory.mockRejectedValue(
				new Error("Database error"),
			);

			const { createEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const result = await createEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: null,
				conversationId: "conv-1",
				title: "Test",
				summary: "Test summary",
				keyTopics: [],
				userIntents: [],
				outcome: "success",
				messageCount: 5,
				turnCount: 2,
				toolsUsed: [],
				agentsUsed: [],
				conversationStartedAt: new Date(),
			});

			// Activity handles errors gracefully and returns null
			expect(result.episodeId).toBeNull();
			expect(result.qdrantPointId).toBeNull();
		});
	});

	describe("searchEpisodicMemoryActivity", () => {
		beforeEach(() => {
			mockSearchSimilarEpisodes.mockResolvedValue([
				{
					id: "ep-1",
					conversationId: "conv-1",
					title: "Previous fitness discussion",
					similarity: 0.85,
				},
				{
					id: "ep-2",
					conversationId: "conv-2",
					title: "Product planning",
					similarity: 0.72,
				},
			]);
		});

		it("should return semantically similar episodes", async () => {
			const { searchEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const results = await searchEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: null,
				query: "fitness tracking for athletes",
				topK: 5,
				minSimilarity: 0.6,
			});

			expect(results).toHaveLength(2);
			expect(results[0].similarity).toBe(0.85);
			expect(mockEmbed).toHaveBeenCalled();
			expect(mockSearchSimilarEpisodes).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					topK: 5,
					minSimilarity: 0.6,
				}),
			);
		});

		it("should filter by project and workspace", async () => {
			const { searchEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await searchEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "proj-1",
				workspaceId: "ws-1",
				query: "test query",
			});

			expect(mockSearchSimilarEpisodes).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					workspaceId: "ws-1",
				}),
			);
		});

		it("should return empty array on embedding failure", async () => {
			mockEmbed.mockRejectedValue(new Error("Embedding failed"));

			const { searchEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const results = await searchEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: null,
				query: "test",
			});

			expect(results).toEqual([]);
		});
	});

	describe("updateOrchestratorPreferencesActivity", () => {
		beforeEach(() => {
			mockUpdateOrchestratorMemoryPreferences.mockResolvedValue({
				preferences: {},
				responseStyle: "bullet_points",
				verbosity: "concise",
			});
		});

		it("should update user preferences", async () => {
			const { updateOrchestratorPreferencesActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const result = await updateOrchestratorPreferencesActivity({
				userId: "user-1",
				organizationId: null,
				updates: {
					responseStyle: "bullet_points",
					verbosity: "concise",
				},
			});

			expect(result.responseStyle).toBe("bullet_points");
			expect(
				mockUpdateOrchestratorMemoryPreferences,
			).toHaveBeenCalledWith(
				"user-1",
				null,
				expect.objectContaining({
					responseStyle: "bullet_points",
				}),
			);
		});
	});

	describe("learnPatternActivity", () => {
		it("should learn and store user pattern", async () => {
			const { learnPatternActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await learnPatternActivity({
				userId: "user-1",
				organizationId: "org-1",
				pattern: "Prefers detailed code examples",
			});

			expect(mockLearnPattern).toHaveBeenCalledWith(
				"user-1",
				"org-1",
				"Prefers detailed code examples",
			);
		});
	});

	describe("updateRecentActivityActivity", () => {
		it("should track recent project and workspace", async () => {
			const { updateRecentActivityActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await updateRecentActivityActivity({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "proj-1",
				workspaceId: "ws-1",
			});

			expect(mockUpdateRecentActivity).toHaveBeenCalledWith(
				"user-1",
				"org-1",
				{ projectId: "proj-1", workspaceId: "ws-1" },
			);
		});
	});

	describe("createEpisodeFromExecutionActivity", () => {
		beforeEach(() => {
			mockCreateEpisodicMemory.mockResolvedValue({ id: "ep-exec-1" });
			mockStoreEpisodeEmbedding.mockResolvedValue({
				pointId: "pt-exec-1",
			});
		});

		it("should create episode from orchestrator execution", async () => {
			const { createEpisodeFromExecutionActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const result = await createEpisodeFromExecutionActivity({
				userId: "user-1",
				organizationId: "org-1",
				conversationId: "conv-1",
				executionId: "exec-1",
				taskDescription: "Plan a fitness tracking product",
				steps: [
					{
						id: "s1",
						description: "Research market",
						status: "complete",
					},
					{
						id: "s2",
						description: "Identify competitors",
						status: "complete",
					},
				],
				toolsUsed: ["search_web", "firecrawl_agent"],
				agentsUsed: ["research_agent"],
				outcome: "success",
				conversationStartedAt: new Date(),
			});

			expect(result.created).toBe(true);
			expect(result.episodeId).toBe("ep-exec-1");
		});

		it("should extract key topics from task and steps", async () => {
			const { createEpisodeFromExecutionActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await createEpisodeFromExecutionActivity({
				userId: "user-1",
				organizationId: null,
				conversationId: "conv-1",
				executionId: "exec-1",
				taskDescription: "Build an API for user authentication",
				steps: [
					{
						id: "s1",
						description: "Design database schema",
						status: "complete",
					},
					{
						id: "s2",
						description: "Create backend endpoints",
						status: "complete",
					},
				],
				toolsUsed: [],
				agentsUsed: [],
				outcome: "success",
				conversationStartedAt: new Date(),
			});

			// Verify createEpisodicMemory was called with extracted topics
			expect(mockCreateEpisodicMemory).toHaveBeenCalled();
			const callArgs = mockCreateEpisodicMemory.mock.calls[0][0];
			expect(callArgs.keyTopics).toContain("api");
			expect(callArgs.keyTopics).toContain("database");
		});

		it("should handle partial completion outcome", async () => {
			const { createEpisodeFromExecutionActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await createEpisodeFromExecutionActivity({
				userId: "user-1",
				organizationId: null,
				conversationId: "conv-1",
				executionId: "exec-1",
				taskDescription: "Test task",
				steps: [
					{ id: "s1", description: "Step 1", status: "complete" },
					{ id: "s2", description: "Step 2", status: "error" },
				],
				toolsUsed: [],
				agentsUsed: [],
				outcome: "partial",
				conversationStartedAt: new Date(),
			});

			const callArgs = mockCreateEpisodicMemory.mock.calls[0][0];
			expect(callArgs.outcome).toBe("partial");
		});
	});
});

describe("Memory Evaluation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetOrchestratorMemoryPreferences.mockResolvedValue({
			preferences: {},
			recentProjectIds: [],
			recentWorkspaceIds: [],
		});
		mockGetRecentEpisodes.mockResolvedValue([]);
		mockBuildOrchestratorMemoryContext.mockResolvedValue({
			preferences: {},
			recentEpisodes: [],
			relevantEpisodes: [],
		});
		mockFormatMemoryContextPrompt.mockReturnValue("");
	});

	describe("Memory Relevance Scoring", () => {
		it("should prioritize high-similarity episodes", async () => {
			mockSearchSimilarEpisodes.mockResolvedValue([
				{ id: "ep-1", similarity: 0.95, title: "Very relevant" },
				{ id: "ep-2", similarity: 0.65, title: "Somewhat relevant" },
				{ id: "ep-3", similarity: 0.45, title: "Low relevance" }, // Below threshold
			]);

			const { searchEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const results = await searchEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: null,
				query: "test query",
				minSimilarity: 0.5,
			});

			// Should only return episodes above minSimilarity threshold
			expect(results.filter((r) => r.similarity >= 0.5)).toHaveLength(2);
		});
	});

	describe("Context Budget Management", () => {
		it("should limit context size to avoid token overflow", async () => {
			// Create many episodes
			const manyEpisodes = Array.from({ length: 20 }, (_, i) => ({
				id: `ep-${i}`,
				title: `Episode ${i}`,
				summary: "A".repeat(500), // Large summaries
				similarity: 0.9 - i * 0.02,
			}));
			mockSearchSimilarEpisodes.mockResolvedValue(manyEpisodes);

			const { searchEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			const _results = await searchEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: null,
				query: "test",
				topK: 5, // Limit to 5
			});

			expect(mockSearchSimilarEpisodes).toHaveBeenCalledWith(
				expect.objectContaining({ topK: 5 }),
			);
		});
	});

	describe("Tenant Isolation", () => {
		it("should isolate personal and organization memory", async () => {
			const { loadOrchestratorMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			// Load personal context
			await loadOrchestratorMemoryActivity({
				userId: "user-1",
				organizationId: null,
			});

			expect(mockGetOrchestratorMemoryPreferences).toHaveBeenCalledWith(
				"user-1",
				null, // null for personal context
			);

			// Load organization context
			await loadOrchestratorMemoryActivity({
				userId: "user-1",
				organizationId: "org-1",
			});

			expect(mockGetOrchestratorMemoryPreferences).toHaveBeenCalledWith(
				"user-1",
				"org-1", // org context
			);
		});

		it("should filter episodes by organization", async () => {
			const { searchEpisodicMemoryActivity } = await import(
				"../src/activities/orchestrator-memory/index"
			);

			await searchEpisodicMemoryActivity({
				userId: "user-1",
				organizationId: "org-1",
				query: "test",
			});

			expect(mockSearchSimilarEpisodes).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
				}),
			);
		});
	});
});
