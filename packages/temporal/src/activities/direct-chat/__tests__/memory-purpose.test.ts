import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { createEmbeddingUsageLoggingMiddleware } from "@repo/ai/lib/usage-logging-middleware";
import { wrapEmbeddingModel } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
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
		model: wrapEmbeddingModel({
			model: new MockEmbeddingModelV4({
				doEmbed: async () => ({
					embeddings: [[0.1]],
					usage: { tokens: 1 },
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
vi.mock("@repo/rag", async () => ({
	generateEmbedding: (await import("@repo/rag/lib/embedding/generator"))
		.generateEmbedding,
	searchSimilarExecutions: async () => [],
}));

vi.mock(
	"@repo/agent-core/backend",
	async () =>
		import("../../../../../agent-core/src/services/semantic-memory"),
);

import { searchSemanticMemory } from "../../orchestrator-memory-activities";
import { generateMemoryContextActivity } from "../memory-context";

beforeEach(() => vi.clearAllMocks());
for (const operation of [
	{
		name: "Direct execution recall",
		call: () =>
			generateMemoryContextActivity(
				"example",
				"example-user",
				"example-org",
			),
	},
	{
		name: "Orchestrator execution search",
		call: () =>
			searchSemanticMemory({
				query: "example",
				userId: "example-user",
				organizationId: "example-org",
			}),
	},
]) {
	it.each([undefined, "compaction"] as const)(
		`${operation.name} owns its label with scope=%s`,
		async (scope) => {
			if (scope) {
				await runWithAiCallPurpose(scope, async () => {
					await operation.call();
				});
			} else {
				await operation.call();
			}
			expect(h.rows).toHaveBeenCalledTimes(1);
			expect(h.rows.mock.calls[0][0]).toMatchObject({
				callPurpose: "execution-search-embedding",
				featureKey: "chat-agent",
			});
			expect(currentAiCallPurpose()).toBeUndefined();
		},
	);
}
