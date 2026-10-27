import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { createEmbeddingUsageLoggingMiddleware } from "@repo/ai/lib/usage-logging-middleware";
import { wrapEmbeddingModel } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: vi.fn(), search: vi.fn(async () => []) }));
vi.mock("@repo/database", () => ({
	logAiUsageAsync: h.rows,
	fetchCredentialsByIdInTenant: vi.fn(),
	getRetrievableContextById: vi.fn(),
	loadProjectDatabricksKnowledgeBinding: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getEmbeddingRAGProviderConfig: async () => ({
		provider: "VERCEL_GATEWAY",
		apiKey: "example-key",
	}),
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
	isProjectDatabricksKnowledgeEnabled: () => false,
	isContextSummarizationEnabled: () => false,
}));
vi.mock("../store", () => ({ searchSimilarProjectContexts: h.search }));

import { retrieveRelevantContextsForSpec } from "../retrieve-for-spec";

beforeEach(() => vi.clearAllMocks());
it.each([undefined, "compaction"] as const)(
	"spec query embeddings own their project retrieval label with scope=%s",
	async (scope) => {
		const call = () =>
			retrieveRelevantContextsForSpec({
				projectId: "example-project",
				userId: "example-user",
				organizationId: "example-org",
				specMarkdown:
					"# Example specification\n\nFind the project launch requirements.",
				baselineDate: new Date("2026-01-01T00:00:00Z"),
			});
		if (scope) {
			await runWithAiCallPurpose(scope, call);
		} else {
			await call();
		}
		expect(h.search).toHaveBeenCalledWith(
			expect.objectContaining({ queryEmbedding: [0.1] }),
		);
		expect(h.rows).toHaveBeenCalledTimes(1);
		expect(h.rows.mock.calls[0][0]).toMatchObject({
			callPurpose: "project-retrieval-embedding",
			featureKey: "knowledge-search",
			success: true,
		});
		expect(currentAiCallPurpose()).toBeUndefined();
	},
);
