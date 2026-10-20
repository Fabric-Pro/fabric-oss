import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	embed: vi.fn(async (_query: string, _context: unknown) => ({
		embedding: [0.1],
		model: "model-example",
		tokens: 1,
	})),
}));
vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: vi.fn(async () => ({ apiKey: "key-example" })),
	getSystemEmbeddingRAGProviderConfig: vi.fn(async () => ({
		apiKey: "key-example",
	})),
}));
vi.mock("@repo/database", () => ({
	db: {
		chatDocument: {
			findMany: vi.fn(async () => [
				{ id: "doc-example", status: "READY" },
			]),
		},
	},
	waitForDocumentsReady: vi.fn(),
	filterWorkspaceIdsForTenant: vi.fn(),
	getDefaultRagSettings: vi.fn(),
	getEffectiveRagSettings: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/rag/lib/embedding", () => ({ generateEmbedding: h.embed }));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
}));
vi.mock("@repo/rag/lib/vector-store", () => ({
	searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock("@repo/rag", async () => ({
	...(await vi.importActual<
		typeof import("@repo/rag/lib/retrieval/retriever")
	>("@repo/rag/lib/retrieval/retriever")),
}));

import { retrieveRagContextForDirectChatActivity } from "../direct-chat/rag-retrieval";
import { retrieveRagContextActivity } from "../rag-activities";

it.each(["direct", "shared"])(
	"%s RAG attributes embeddings only to the explicit usage conversation",
	async (kind) => {
		for (const usageConversationId of ["conversation-example", undefined]) {
			h.embed.mockClear();
			if (kind === "direct") {
				await retrieveRagContextForDirectChatActivity(
					"query",
					"user-example",
					"org-example",
					"holder-example",
					["doc-example"],
					undefined,
					undefined,
					undefined,
					usageConversationId,
				);
			} else {
				await retrieveRagContextActivity(
					"holder-example",
					"user-example",
					"org-example",
					"query",
					undefined,
					undefined,
					["doc-example"],
					usageConversationId,
				);
			}
			expect(h.embed).toHaveBeenCalledTimes(1);
			expect(h.embed.mock.calls[0][1]).toMatchObject({
				conversationId: usageConversationId,
			});
		}
	},
);
