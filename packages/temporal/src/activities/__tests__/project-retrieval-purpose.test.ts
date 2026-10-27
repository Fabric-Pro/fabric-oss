import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { createEmbeddingUsageLoggingMiddleware } from "@repo/ai/lib/usage-logging-middleware";
import { embed, wrapEmbeddingModel } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: vi.fn(), search: vi.fn(async () => []) }));
vi.mock("@repo/database", () => ({
	logAiUsageAsync: h.rows,
	db: {},
	getProjectRagSettings: async () => ({
		topK: 5,
		similarityThreshold: 0.1,
		enableReranking: false,
	}),
}));
vi.mock("@repo/ai", () => ({
	embed,
	getAIEmbeddingModelWithMetadata: async (
		context: Record<string, unknown>,
	) => ({
		model: wrapEmbeddingModel({
			model: new MockEmbeddingModelV4({
				doEmbed: async ({ values }) => ({
					embeddings: values.map(() => [0.1]),
					usage: { tokens: values.length },
					warnings: [],
				}),
			}),
			middleware: createEmbeddingUsageLoggingMiddleware({
				...context,
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-embedding",
			}),
		}),
		metadata: {
			canonicalName: "text-embedding-3-small",
			modelString: "openai/text-embedding-3-small",
			provider: "VERCEL_GATEWAY",
			selectionSource: "system_default",
		},
		trackUsage: vi.fn(),
	}),
	logEmbeddingUsageAsync: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isContextSummarizationEnabled: () => false,
}));
vi.mock("@repo/rag", async () => ({
	buildDocumentRetrievalQuery: (
		await import("@repo/rag/lib/project-contexts/document-intents")
	).buildDocumentRetrievalQuery,
	extractBaseContextId: (await import("@repo/rag/lib/utils/chunk-id"))
		.extractBaseContextId,
	applyContextSummary: (
		await import("@repo/rag/lib/project-contexts/summary-injection")
	).applyContextSummary,
	searchSimilarProjectContexts: h.search,
}));

import { retrieveProjectContexts as retrieveDocumentContexts } from "../project-document-generation";
import { retrieveProjectContexts as retrieveTaskContexts } from "../task-agent/rag-context";

const tenant = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
};
const operations = [
	{
		name: "document generation",
		featureKey: "document-generation",
		call: () =>
			retrieveDocumentContexts({ ...tenant, documentType: "PRD" }),
	},
	{
		name: "task agent",
		featureKey: "knowledge-search",
		call: () =>
			retrieveTaskContexts({
				...tenant,
				taskTitle: "Example task",
				taskDescription: "Find the project launch requirements.",
			}),
	},
];
beforeEach(() => vi.clearAllMocks());
for (const operation of operations) {
	it.each([undefined, "compaction"] as const)(
		`${operation.name} query owns its project retrieval label with scope=%s`,
		async (scope) => {
			if (scope) {
				await runWithAiCallPurpose(scope, async () => {
					await operation.call();
				});
			} else {
				await operation.call();
			}
			expect(h.search).toHaveBeenCalledWith(
				expect.objectContaining({ queryEmbedding: [0.1] }),
			);
			expect(h.rows).toHaveBeenCalledTimes(1);
			expect(h.rows.mock.calls[0][0]).toMatchObject({
				callPurpose: "project-retrieval-embedding",
				featureKey: operation.featureKey,
				success: true,
			});
			expect(currentAiCallPurpose()).toBeUndefined();
		},
	);
}
