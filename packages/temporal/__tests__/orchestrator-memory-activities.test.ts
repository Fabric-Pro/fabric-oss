/**
 * Orchestrator Memory Activities Tests
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("@repo/rag", () => ({
	boundQueryForEmbedding: vi.fn((text: string) => text),
	get generateQueryEmbedding() {
		return (this as { generateEmbedding: unknown }).generateEmbedding;
	},
	generateEmbedding: vi
		.fn()
		.mockResolvedValue({ embedding: [0.01, 0.02], tokens: 10 }),
	generateEmbeddings: vi.fn(),
	executionExists: vi.fn().mockResolvedValue(false),
	storeExecutionSummary: vi.fn().mockResolvedValue(true),
	searchSimilarExecutions: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", async () => ({
	generateText: vi.fn().mockResolvedValue("summarized"),
	isPermanentProviderFailure: (
		await import("@repo/ai/lib/usage-logging-middleware")
	).isPermanentProviderFailure,
}));

import { EmbeddingGenerationError } from "@repo/rag/lib/embedding/errors";

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
			projectId: "example-project",
			workspaceIds: ["example-workspace"],
		});

		expect(result).toBe(true);
		expect(executionExists).toHaveBeenCalledWith("exec-1", "org-1");
		expect(storeExecutionSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				execution: expect.objectContaining({
					projectId: "example-project",
					workspaceIds: ["example-workspace"],
				}),
			}),
		);
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

/**
 * Fizzy #3571: when the AI Gateway refused a key, the worker logged the
 * gateway's whole text, which tells the reader to set AI_GATEWAY_API_KEY
 * even when the refused key was an organization's own.
 */
describe("embedAndStoreTrajectory when the embedding fails", () => {
	const input = {
		executionId: "exec-1",
		taskDescription: "Do something",
		steps: [],
		outcome: "success" as const,
		durationMs: 100,
		userId: "user-1",
		organizationId: "org-1",
		useLLMSummary: false,
	};

	function gatewayRejection(
		credentialSource: "user" | "organization" | "platform",
	): EmbeddingGenerationError {
		const cause = Object.assign(
			new Error(
				"AI Gateway authentication failed: Invalid API key or token.",
			),
			{ name: "GatewayAuthenticationError", statusCode: 401 },
		);
		return new EmbeddingGenerationError(
			"Embedding generation failed: AI Gateway authentication failed: Invalid API key or token.\n" +
				"    Create a new API key: https://vercel.com/d?to=example\n" +
				"    Provide an API key or Vercel access token via 'apiKey' option or 'AI_GATEWAY_API_KEY' environment variable.",
			{ cause, credentialSource, provider: "VERCEL_GATEWAY" },
		);
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		const ragModule = await import("@repo/rag");
		vi.mocked(ragModule.executionExists).mockResolvedValue(false);
		vi.mocked(ragModule.storeExecutionSummary).mockResolvedValue(true);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.mocked(console.log).mockRestore();
		vi.mocked(console.error).mockRestore();
	});

	it.each([
		["organization", "the organization's AI provider key"],
		["user", "the user's AI provider key"],
		["platform", "the platform AI Gateway key"],
	] as const)(
		"names the %s key the provider rejected, without the provider's help text",
		async (credentialSource, owner) => {
			const ragModule = await import("@repo/rag");
			vi.mocked(ragModule.generateEmbedding).mockRejectedValue(
				gatewayRejection(credentialSource),
			);
			const { embedAndStoreTrajectory } = await import(
				"../src/activities/orchestrator-memory-activities"
			);

			const result = await embedAndStoreTrajectory(input);

			expect(result).toBe(false);
			expect(ragModule.storeExecutionSummary).not.toHaveBeenCalled();
			expect(console.error).toHaveBeenCalledTimes(1);
			expect(console.error).toHaveBeenCalledWith(
				`❌ [OrchestratorMemory] Execution exec-1 not stored: the embedding provider (VERCEL_GATEWAY) rejected ${owner}`,
			);
		},
	);

	it("logs any other failure with its message", async () => {
		const ragModule = await import("@repo/rag");
		vi.mocked(ragModule.generateEmbedding).mockRejectedValue(
			new Error("Embedding generation failed: socket hang up"),
		);
		const { embedAndStoreTrajectory } = await import(
			"../src/activities/orchestrator-memory-activities"
		);

		const result = await embedAndStoreTrajectory(input);

		expect(result).toBe(false);
		expect(console.error).toHaveBeenCalledWith(
			"❌ [OrchestratorMemory] Failed to store execution exec-1: Error: Embedding generation failed: socket hang up",
		);
	});
});
