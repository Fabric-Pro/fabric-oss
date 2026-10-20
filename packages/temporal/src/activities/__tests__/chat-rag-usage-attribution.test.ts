import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	retrieve: vi.fn(async (_input: unknown) => []),
}));
vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: vi.fn(async () => ({
		apiKey: "key-example",
	})),
}));
vi.mock("@repo/database", () => ({ waitForDocumentsReady: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/rag", () => ({
	retrieveContext: h.retrieve,
	formatContextForLLM: vi.fn(() => "context"),
}));

import { retrieveRagContextActivity } from "../rag-activities";

it.each(["conversation-example", undefined])(
	"attributes shared RAG only from its usage input (%s)",
	async (usageConversationId) => {
		h.retrieve.mockClear();
		await retrieveRagContextActivity(
			"document-holder-example",
			"user-example",
			"org-example",
			"query",
			undefined,
			undefined,
			undefined,
			usageConversationId,
		);
		expect(h.retrieve.mock.calls[0][0]).toMatchObject({
			conversationId: usageConversationId,
		});
	},
);
