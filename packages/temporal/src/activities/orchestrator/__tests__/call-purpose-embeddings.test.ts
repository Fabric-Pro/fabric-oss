import { currentAiCallPurpose } from "@repo/ai/lib/call-purpose-context";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ purposes: [] as (string | undefined)[] }));
vi.mock("@repo/rag", () => ({
	generateEmbedding: async () => {
		h.purposes.push(currentAiCallPurpose());
		return { embedding: [0.1], model: "example-model" };
	},
	generateEmbeddings: async () => {
		h.purposes.push(currentAiCallPurpose());
		return { embeddings: [[0.1]], model: "example-model" };
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	embeddingCache,
	getOrGenerateEmbedding,
	getOrGenerateEmbeddings,
} from "../tools/capability-embeddings";

beforeEach(() => {
	h.purposes.length = 0;
	embeddingCache.clear();
});
it("attributes uncached capability embeddings without dispatching for cached values", async () => {
	await getOrGenerateEmbedding(
		"Example query",
		"example-query",
		"example-key",
		"example-user",
		"example-org",
	);
	await getOrGenerateEmbedding(
		"Example query",
		"example-query",
		"example-key",
		"example-user",
		"example-org",
	);
	expect(h.purposes).toEqual(["capability-search-embedding"]);
});
it("attributes capability batch embeddings", async () => {
	await getOrGenerateEmbeddings(
		[{ text: "Example tool", cacheKey: "example-tool" }],
		"example-key",
		"example-user",
		"example-org",
	);
	expect(h.purposes).toEqual(["capability-index-embedding"]);
});

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: async () => ({}),
}));
vi.mock("../../oauth-tool-ingestion", () => ({
	ingestOAuthIntegrationToolsActivity: vi.fn(),
}));
vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbeddings: async () => {
		h.purposes.push(currentAiCallPurpose());
		return { embeddings: [[0.1]] };
	},
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	getCapabilitiesByTenant: vi.fn(),
	searchCapabilities: async () => [],
}));
it("server search labels its one-element query as a search embedding", async () => {
	const { findRelevantServersBySemantic } = await import(
		"../tools/search-tools"
	);
	await findRelevantServersBySemantic(
		"Example query",
		"example-user",
		"example-org",
	);
	expect(h.purposes).toEqual(["capability-search-embedding"]);
});
