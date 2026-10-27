import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { createEmbeddingUsageLoggingMiddleware } from "@repo/ai/lib/usage-logging-middleware";
import { wrapEmbeddingModel } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("@repo/database", () => ({
	logAiUsageAsync: h.rows,
	db: {},
	getProjectRagSettings: async () => ({
		topK: 5,
		similarityThreshold: 0.1,
		enableReranking: false,
	}),
	getProjectCodeIndexes: async () => [{ status: "READY" }],
	getRetrievableContextById: vi.fn(),
	getRetrievableConversationBundleById: vi.fn(),
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
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../vector-store", () => ({ searchSimilarChunks: async () => [] }));
vi.mock("../../project-contexts/store", () => ({
	searchSimilarProjectContexts: async () => [],
}));
vi.mock("../../project-contexts/summary-injection", () => ({
	applyContextSummary: (rows: unknown) => rows,
}));
vi.mock("../../project-contexts/client", () => ({
	qdrantClient: { query: async () => ({ points: [] }) },
}));
vi.mock("../../collection-manager", () => ({
	ensureCollection: async () => "example-collection",
	getCollectionLayout: async () => ({ supportsHybrid: false }),
}));

import { searchProjectCodeIndex } from "../../project-contexts/code-search";
import { retrieveProjectContexts } from "../../project-contexts/retrieval";
import { retrieveContext } from "../retriever";

const tenant = { userId: "example-user", organizationId: "example-org" };
const operations = [
	{
		name: "retrieveContext",
		purpose: "chat-document-retrieval-embedding",
		call: () =>
			retrieveContext({
				...tenant,
				chatId: "example-chat",
				query: "example",
				apiKey: "example-key",
			}),
	},
	{
		name: "retrieveProjectContexts",
		purpose: "project-retrieval-embedding",
		call: () =>
			retrieveProjectContexts({
				...tenant,
				projectId: "example-project",
				query: "example",
			}),
	},
	{
		name: "searchProjectCodeIndex",
		purpose: "code-search-embedding",
		call: () =>
			searchProjectCodeIndex({
				...tenant,
				projectId: "example-project",
				query: "example",
			}),
	},
];
beforeEach(() => vi.clearAllMocks());
for (const operation of operations) {
	it.each([undefined, "compaction"] as const)(
		`${operation.name} owns its query label with scope=%s`,
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
				callPurpose: operation.purpose,
				...tenant,
			});
			expect(currentAiCallPurpose()).toBeUndefined();
		},
	);
}
