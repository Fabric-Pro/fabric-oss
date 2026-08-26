/**
 * Orchestrator Memory Activities Tests
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/rag", () => ({
	generateEmbedding: vi
		.fn()
		.mockResolvedValue({ embedding: [0.01, 0.02], tokens: 10 }),
	generateEmbeddings: vi.fn(),
	executionExists: vi.fn().mockResolvedValue(false),
	storeExecutionSummary: vi.fn().mockResolvedValue(true),
	searchSimilarExecutions: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	generateText: vi.fn().mockResolvedValue("summarized"),
}));

// Import mocked modules - these will be assigned in beforeAll
let generateEmbedding: ReturnType<typeof vi.fn>;
let executionExists: ReturnType<typeof vi.fn>;
let storeExecutionSummary: ReturnType<typeof vi.fn>;
let searchSimilarExecutions: ReturnType<typeof vi.fn>;

describe("orchestrator-memory embedding provider logic", () => {
	beforeAll(async () => {
		const ragModule = await import("@repo/rag");
		generateEmbedding = ragModule.generateEmbedding as ReturnType<
			typeof vi.fn
		>;
		executionExists = ragModule.executionExists as ReturnType<typeof vi.fn>;
		storeExecutionSummary = ragModule.storeExecutionSummary as ReturnType<
			typeof vi.fn
		>;
		searchSimilarExecutions =
			ragModule.searchSimilarExecutions as ReturnType<typeof vi.fn>;
	});

	beforeEach(() => {
		vi.clearAllMocks();
		executionExists.mockResolvedValue(false);
		generateEmbedding.mockResolvedValue({
			embedding: [0.01, 0.02],
			tokens: 42,
		});
		storeExecutionSummary.mockResolvedValue(true);
		searchSimilarExecutions.mockResolvedValue([]);
	});

	it("passes undefined providerConfig to embedAndStoreTrajectory (credentials fetched internally)", async () => {
		const { embedAndStoreTrajectory } = await import(
			"../src/activities/orchestrator-memory-activities"
		);

		const result = await embedAndStoreTrajectory({
			executionId: "exec-1",
			taskDescription: "Do something",
			steps: [],
			outcome: "success",
			durationMs: 100,
			userId: "user-1",
			organizationId: "org-1",
			useLLMSummary: false,
		});

		expect(result).toBe(true);
		expect(generateEmbedding).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
			}),
			undefined, // providerConfig is now undefined - credentials fetched internally
		);
	});

	it("passes undefined providerConfig to searchSemanticMemory (credentials fetched internally)", async () => {
		const { searchSemanticMemory } = await import(
			"../src/activities/orchestrator-memory-activities"
		);

		await searchSemanticMemory({
			query: "Find similar",
			userId: "user-2",
			organizationId: "org-2",
		});

		expect(generateEmbedding).toHaveBeenCalledWith(
			"Find similar",
			expect.objectContaining({
				userId: "user-2",
				organizationId: "org-2",
			}),
			undefined, // providerConfig is now undefined - credentials fetched internally
		);
	});
});
