import { runWithAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import {
	createEmbeddingUsageLoggingMiddleware,
	createUsageLoggingMiddleware,
} from "@repo/ai/lib/usage-logging-middleware";
import { MockActivityEnvironment } from "@temporalio/testing";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("@repo/database", () => ({ logAiUsageAsync: h.rows }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../handlers", () => ({
	getHandlerForDataSource: vi.fn(),
	inferDataSourceType: vi.fn(),
}));
vi.mock("../../orchestrator/utils/model-selector", () => ({
	getEmbeddingConfig: async () => ({}),
}));
vi.mock("../rag-processing", () => ({
	buildRagContextPrompt: () => "example context",
	deleteReportCollection: vi.fn(),
	processDataForRag: vi.fn(),
	searchReportCollection: async () => [],
}));
vi.mock("@repo/rag", () => ({
	generateEmbedding: async (
		_text: string,
		context: Record<string, unknown>,
	) => {
		await (
			createEmbeddingUsageLoggingMiddleware({
				...context,
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-embedding",
			}) as any
		).wrapEmbed({ doEmbed: async () => ({ usage: { tokens: 1 } }) });
		return { embedding: [0.1] };
	},
}));
vi.mock("@repo/ai", async () => ({
	...(await vi.importActual<typeof import("ai")>("ai")),
	getAIModelWithMetadata: async (
		_options: unknown,
		context: Record<string, unknown>,
	) => ({
		model: wrapLanguageModel({
			model: new MockLanguageModelV4({
				doStream: async () => ({
					stream: simulateReadableStream({
						chunks: [
							{ type: "text-start", id: "example" },
							{
								type: "text-delta",
								id: "example",
								delta: "Example report",
							},
							{ type: "text-end", id: "example" },
							{
								type: "finish",
								finishReason: { unified: "stop", raw: "stop" },
								usage: {
									inputTokens: {
										total: 2,
										noCache: 2,
										cacheRead: 0,
										cacheWrite: 0,
									},
									outputTokens: {
										total: 1,
										text: 1,
										reasoning: 0,
									},
								},
							},
						],
					}),
				}),
			}),
			middleware: createUsageLoggingMiddleware({
				...context,
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-analysis",
			}),
		}),
		metadata: { provider: "VERCEL_GATEWAY", modelString: "example-model" },
		trackUsage: vi.fn(),
	}),
}));
vi.mock("@repo/rag/lib/vector-store/client", () => ({
	DISTANCE_METRIC: "Cosine",
	VECTOR_SIZE: 1,
	qdrantClient: {
		getCollections: async () => ({
			collections: [{ name: "report_exec_example-execution" }],
		}),
		upsert: async () => ({}),
	},
}));

import { executeAiAnalysis } from "../data-fetching";

beforeEach(() => h.rows.mockClear());
it.each([false, true])(
	"report analysis records report-generation with RAG=%s",
	async (rag) => {
		const result = await new MockActivityEnvironment().run(() =>
			runWithAiCallPurpose("compaction", () =>
				executeAiAnalysis({
					aiAgents: [{ agentId: "example-agent", task: "Summarize" }],
					dataResults: [],
					userId: "example-user",
					organizationId: "example-org",
					jobType: "scheduled-report",
					...(rag
						? { qdrantCollectionId: "example-collection" }
						: {}),
				}),
			),
		);
		expect(
			(result as Awaited<ReturnType<typeof executeAiAnalysis>>)[0].output,
		).toBe("Example report");
		expect(
			h.rows.mock.calls.map(([row]) => [
				row.featureKey,
				row.providerModelId,
			]),
		).toEqual([
			...(rag ? [["report-generation", "example-embedding"]] : []),
			["report-generation", "example-analysis"],
		]);
		expect(h.rows.mock.calls.at(-1)?.[0]).toMatchObject({
			jobType: "scheduled-report",
			callPurpose: "data-analysis",
		});
	},
);

it("report data indexing records report-generation", async () => {
	const { processDataForRag } =
		await vi.importActual<typeof import("../rag-processing")>(
			"../rag-processing",
		);
	await processDataForRag(
		"example-execution",
		{
			id: "example-source",
			type: "MCP",
			provider: "example",
			config: {},
		} as any,
		[{ text: "Example data" }],
		"example-user",
		"example-org",
	);
	expect(h.rows.mock.calls.length).toBeGreaterThan(0);
	expect(h.rows.mock.calls.map(([row]) => row.featureKey)).toEqual([
		"report-generation",
	]);
});
