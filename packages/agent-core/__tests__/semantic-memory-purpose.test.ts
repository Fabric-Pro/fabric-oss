import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { wrapEmbeddingModelWithUsageLogging } from "@repo/ai/lib/usage-logging-middleware";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("@repo/database", () => ({ logAiUsageAsync: h.rows }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/ai", () => ({
	getAIEmbeddingModelWithMetadata: async (
		context: Record<string, unknown>,
	) => ({
		model: wrapEmbeddingModelWithUsageLogging(
			{
				specificationVersion: "v4",
				provider: "example-provider",
				modelId: "example-embedding",
				maxEmbeddingsPerCall: 1,
				supportsParallelCalls: false,
				doEmbed: async () => ({
					embeddings: [[0.1]],
					usage: { tokens: 1 },
					warnings: [],
				}),
			},
			{
				...context,
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-embedding",
			},
		),
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
vi.mock("@repo/rag", async () => ({
	generateEmbedding: (await import("@repo/rag/lib/embedding/generator"))
		.generateEmbedding,
	searchSimilarExecutions: async () => [],
}));

import { searchSemanticMemory } from "../src/services/semantic-memory";

beforeEach(() => vi.clearAllMocks());
it.each([undefined, "compaction"] as const)(
	"execution search owns its label with scope=%s",
	async (scope) => {
		const call = () =>
			searchSemanticMemory("example", {
				userId: "example-user",
				organizationId: "example-org",
			});
		if (scope) {
			await runWithAiCallPurpose(scope, call);
		} else {
			await call();
		}
		expect(h.rows).toHaveBeenCalledTimes(1);
		expect(h.rows.mock.calls[0][0]).toMatchObject({
			callPurpose: "execution-search-embedding",
			featureKey: "chat-agent",
		});
		expect(currentAiCallPurpose()).toBeUndefined();
	},
);
