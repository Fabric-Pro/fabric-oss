import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getProjectRagSettings: vi.fn(),
	searchSimilarProjectContexts: vi.fn(),
	dbContextFindMany: vi.fn(),
	enrichContextsWithRoleTags: vi.fn(),
	applyContextSummary: vi.fn(),
	rerankContexts: vi.fn(),
	generateEmbedding: vi.fn(),
	hasProjectAccess: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			findMany: (...args: unknown[]) => mocks.dbContextFindMany(...args),
		},
		projectRepositoryIntegration: {
			findMany: vi.fn().mockResolvedValue([]),
		},
	},
	getProjectRagSettings: (...args: unknown[]) =>
		mocks.getProjectRagSettings(...args),
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/rag", () => ({
	buildDocumentRetrievalQuery: () => "build document retrieval query",
	searchSimilarProjectContexts: (...args: unknown[]) =>
		mocks.searchSimilarProjectContexts(...args),
	extractBaseContextId: (id: string) => id,
	enrichContextsWithRoleTags: (...args: unknown[]) =>
		mocks.enrichContextsWithRoleTags(...args),
	applyContextSummary: (...args: unknown[]) =>
		mocks.applyContextSummary(...args),
	rerankContexts: (...args: unknown[]) => mocks.rerankContexts(...args),
	embedProjectDocument: vi.fn(),
	reembedProjectDocument: vi.fn(),
	deleteStaleDocumentEmbeddingChunks: vi.fn(),
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	embed: vi.fn().mockResolvedValue({
		embedding: [0.1, 0.2],
		usage: { tokens: 10 },
	}),
	getAIEmbeddingModelWithMetadata: vi.fn().mockReturnValue({
		model: {},
		metadata: { modelString: "text-embedding-3-small", provider: "openai" },
		trackUsage: vi.fn(),
	}),
	getAIModelWithMetadata: vi.fn().mockReturnValue({ model: {} }),
	getSystemRAGProviderConfig: vi.fn().mockReturnValue({}),
	logEmbeddingUsageAsync: vi.fn().mockResolvedValue({ trackUsage: vi.fn() }),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
	DEFAULT_BASE_URLS: {},
}));

vi.mock("@temporalio/activity", () => ({
	Context: { current: { heartbeat: vi.fn() } },
	heartbeat: vi.fn(),
	ApplicationFailure: { nonRetryable: (msg: string) => new Error(msg) },
}));

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import AFTER mocks
import { retrieveProjectContexts } from "../project-document-generation";

describe("retrieveProjectContexts activity roleTag string formatting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getProjectRagSettings.mockResolvedValue({
			topK: 10,
			similarityThreshold: 0.5,
			enableReranking: false,
		});
		mocks.hasProjectAccess.mockResolvedValue(true);
	});

	it("formats live roleTag headers directly into returned string[] content array", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx-1", score: 0.95 },
		]);

		mocks.dbContextFindMany.mockResolvedValue([
			{
				id: "ctx-1",
				type: "TEXT",
				content: "function processPayments() {}",
				originalFilename: "example-org/payment-v1/checkout.ts",
				metadata: { provider: "CODE_ANALYSIS" },
			},
		]);

		// Simulate enrichContextsWithRoleTags enriching the context with a roleTag
		mocks.enrichContextsWithRoleTags.mockImplementation(
			async (contexts: any[]) =>
				contexts.map((c) => ({
					...c,
					metadata: {
						...c.metadata,
						roleTag: "V1 Deprecated",
					},
					filename: "example-org/payment-v1/checkout.ts",
				})),
		);

		mocks.applyContextSummary.mockImplementation(
			async (contexts: any[]) => contexts,
		);

		const resultStrings = await retrieveProjectContexts({
			projectId: "proj-123",
			userId: "user-123",
			documentType: "PRD",
		});

		expect(resultStrings).toHaveLength(1);
		expect(resultStrings[0]).toContain(
			"--- V1 Deprecated: example-org/payment-v1/checkout.ts ---",
		);
		expect(resultStrings[0]).toContain("function processPayments() {}");
	});

	it("returns raw content without tag header when roleTag is absent", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx-doc", score: 0.9 },
		]);

		mocks.dbContextFindMany.mockResolvedValue([
			{
				id: "ctx-doc",
				type: "TEXT",
				content: "Product requirements specification content...",
				originalFilename: "prd.pdf",
				metadata: { provider: "DOCUMENT" },
			},
		]);

		mocks.enrichContextsWithRoleTags.mockImplementation(
			async (contexts: any[]) => contexts,
		);

		mocks.applyContextSummary.mockImplementation(
			async (contexts: any[]) => contexts,
		);

		const resultStrings = await retrieveProjectContexts({
			projectId: "proj-123",
			userId: "user-123",
			documentType: "PRD",
		});

		expect(resultStrings).toHaveLength(1);
		expect(resultStrings[0]).toBe(
			"Product requirements specification content...",
		);
		expect(resultStrings[0]).not.toContain("---");
	});
});
