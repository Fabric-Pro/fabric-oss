import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	generateTitle: vi.fn(
		async (_message: string, _context: { conversationId?: string }) =>
			"title",
	),
	streamAndSaveMessage: vi.fn(async () => "answer"),
	retrieveRagContextActivity: vi.fn(async (..._args: unknown[]) => ({
		context: "context",
		chunkCount: 1,
	})),
}));
vi.mock("@temporalio/workflow", () => ({
	ApplicationFailure: class extends Error {},
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	workflowInfo: () => ({
		workflowId: "execution-example",
		runId: "run-example",
	}),
	proxyActivities: () => ({
		...h,
		updateChatTitle: vi.fn(),
		updateChatMetadata: vi.fn(),
		updateWorkflowStatus: vi.fn(),
		waitForDocumentsReadyActivity: vi.fn(async () => true),
	}),
}));

import { chatMessageWorkflow } from "../chat-message";
import { chatTitleGenerationWorkflow } from "../chat-title-generation";
import { ragContextRetrievalWorkflow } from "../rag-context-retrieval";

beforeEach(() => vi.clearAllMocks());
it("sends the chats-table id from both title workflows", async () => {
	await chatTitleGenerationWorkflow({
		chatId: "chat-example",
		firstMessage: "hello",
		userId: "user-example",
	});
	await chatMessageWorkflow({
		chatId: "chat-example",
		userMessage: "hello",
		userId: "user-example",
		allMessages: [
			{ role: "user", parts: [{ type: "text", text: "hello" }] },
		],
	});
	expect(h.generateTitle.mock.calls).toHaveLength(2);
	for (const call of h.generateTitle.mock.calls) {
		expect(call[1].conversationId).toBe("chat-example");
	}
});
it.each(["conversation-example", undefined])(
	"carries only explicit RAG usage attribution (%s)",
	async (usageConversationId) => {
		await ragContextRetrievalWorkflow({
			chatId: "document-holder-example",
			userId: "user-example",
			query: "question",
			usageConversationId,
		});
		expect(h.retrieveRagContextActivity.mock.calls[0][7]).toBe(
			usageConversationId,
		);
	},
);
