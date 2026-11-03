import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getProjectRagSettings: vi.fn(),
	searchSimilarEpisodes: vi.fn(),
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

vi.mock("@repo/rag/lib/reranking/index", () => ({
	rerankContexts: (...args: unknown[]) => mocks.rerankContexts(...args),
}));

vi.mock("@repo/rag/lib/project-contexts/store", () => ({
	searchSimilarProjectContexts: (...args: unknown[]) =>
		mocks.searchSimilarProjectContexts(...args),
}));

vi.mock("@repo/rag", async () => ({
	buildDocumentRetrievalQuery: () => "build document retrieval query",
	searchSimilarProjectContexts: (...args: unknown[]) =>
		mocks.searchSimilarProjectContexts(...args),
	extractBaseContextId: (id: string) => id,
	enrichContextsWithRoleTags: (...args: unknown[]) =>
		mocks.enrichContextsWithRoleTags(...args),
	applyContextSummary: (...args: unknown[]) =>
		mocks.applyContextSummary(...args),
	selectProjectContexts: (
		await vi.importActual<
			typeof import("@repo/rag/lib/reranking/select-project-contexts")
		>("@repo/rag/lib/reranking/select-project-contexts")
	).selectProjectContexts,
	rerankContexts: (...args: unknown[]) => mocks.rerankContexts(...args),
	embedProjectDocument: vi.fn(),
	reembedProjectDocument: vi.fn(),
	deleteStaleDocumentEmbeddingChunks: vi.fn(),
	searchSimilarEpisodes: mocks.searchSimilarEpisodes,
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
import {
	retrieveAndFormatEpisodicMemory,
	retrieveProjectContexts,
} from "../project-document-generation";

describe("retrieveProjectContexts activity roleTag string formatting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.searchSimilarEpisodes.mockResolvedValue([]);
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

	it("passes tenant attribution to reranking during document retrieval", async () => {
		mocks.getProjectRagSettings.mockResolvedValue({
			topK: 10,
			similarityThreshold: 0.5,
			enableReranking: true,
			rerankerProvider: "cross-encoder",
		});
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "example-a", score: 0.9 },
			{ contextId: "example-b", score: 0.8 },
		]);
		mocks.dbContextFindMany.mockResolvedValue([
			{ id: "example-a", type: "TEXT", content: "example content" },
			{ id: "example-b", type: "TEXT", content: "other content" },
		]);
		mocks.enrichContextsWithRoleTags.mockImplementation(
			async (contexts: any[]) => contexts,
		);
		mocks.applyContextSummary.mockImplementation(
			async (contexts: any[]) => contexts,
		);
		mocks.rerankContexts.mockResolvedValue({
			contexts: [],
			stats: {
				inputCount: 2,
				outputCount: 0,
				latencyMs: 1,
				provider: "gateway",
			},
		});
		await retrieveProjectContexts({
			projectId: "example-project",
			userId: "example-user",
			organizationId: "example-org",
			documentType: "PRD",
		});
		expect(mocks.rerankContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				tenant: {
					projectId: "example-project",
					userId: "example-user",
					organizationId: "example-org",
				},
			}),
		);
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

it("keeps the legacy episodic activity empty without searching or resolving settings", async () => {
	vi.clearAllMocks();
	const result = await retrieveAndFormatEpisodicMemory({
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
		query: "example query",
	});
	expect(result).toEqual({ formattedContext: "", episodeCount: 0 });
	expect(mocks.getProjectRagSettings).not.toHaveBeenCalled();
	expect(mocks.searchSimilarEpisodes).not.toHaveBeenCalled();
});

it("reranks matched chunks and caps skipped results without changing the activity shape", async () => {
	mocks.getProjectRagSettings.mockResolvedValue({
		topK: 50,
		rerankTopK: 1,
		enableReranking: true,
	});
	mocks.searchSimilarProjectContexts.mockResolvedValue([
		{ contextId: "example-a", content: "matched a", score: 0.9 },
		{ contextId: "example-b", content: "matched b", score: 0.8 },
	]);
	mocks.dbContextFindMany.mockResolvedValue([
		{ id: "example-a", type: "TEXT", content: "full a" },
		{ id: "example-b", type: "TEXT", content: "full b" },
	]);
	mocks.enrichContextsWithRoleTags.mockImplementation(
		async (contexts) => contexts,
	);
	mocks.applyContextSummary.mockImplementation(async (contexts) => contexts);
	mocks.rerankContexts.mockImplementation(async (input) => {
		expect(input.topK).toBe(2);
		expect(
			input.contexts.map((c: { content: string }) => c.content),
		).toEqual(["matched a", "matched b"]);
		return { contexts: input.contexts, stats: { model: "skipped" } };
	});
	const result = await retrieveProjectContexts({
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
		documentType: "PRD",
	});
	expect(result).toEqual(["full a"]);
	expect(mocks.searchSimilarProjectContexts).toHaveBeenCalledWith(
		expect.objectContaining({ excludeDocumentChunks: true }),
	);
});

it.each([1, 2])(
	"returns the summary plus %i document-generation sources",
	async (limit) => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.getProjectRagSettings.mockResolvedValue({
			topK: 50,
			rerankTopK: limit,
			enableReranking: false,
		});
		mocks.searchSimilarProjectContexts.mockResolvedValue(
			["a", "b", "c"].map((id, i) => ({
				contextId: id,
				score: 1 - i / 10,
			})),
		);
		mocks.dbContextFindMany.mockResolvedValue(
			["a", "b", "c"].map((id) => ({
				id,
				type: "TEXT",
				content: `full ${id}`,
			})),
		);
		mocks.enrichContextsWithRoleTags.mockImplementation(
			async (contexts) => contexts,
		);
		const summary = {
			id: "example-summary",
			type: "PROJECT_SUMMARY",
			content: "summary content",
			score: 1,
			sourceTitle: "Compressed project history (summary)",
			metadata: {
				isSummary: true,
				summaryId: "example-summary",
				engineVersion: 1,
				coveredThrough: "2026-01-01T00:00:00.000Z",
				coveredContextCount: 0,
				references: [],
			},
		};
		mocks.applyContextSummary.mockImplementation(async (contexts) => [
			summary,
			...contexts,
		]);
		const result = await retrieveProjectContexts({
			projectId: "example-project",
			userId: "example-user",
			organizationId: "example-org",
			documentType: "PRD",
		});
		expect(result).toEqual([
			"summary content",
			...["full a", "full b"].slice(0, limit),
		]);
		expect(result).toHaveLength(limit + 1);
	},
);
