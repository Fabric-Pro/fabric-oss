import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn() }));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: h.resolve,
	convertToModelMessages: vi.fn(async (messages) => messages),
	streamText: vi.fn(() => ({ text: "answer", usage: {} })),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/database", () => ({ getAiChatById: h.load }));
vi.mock("@repo/database/prisma/queries/ai-chats", () => ({
	updateAiChat: vi.fn(),
}));
vi.mock("@repo/database/prisma/queries/agent-reply-notifications", () => ({
	createAgentReplyReadyNotifications: vi.fn(),
}));

import { streamAndSaveMessage } from "../chat-activities";

beforeEach(() => {
	vi.clearAllMocks();
	h.load.mockResolvedValue({
		userId: "user-example",
		organizationId: "org-example",
	});
	h.resolve.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	});
});
it("uses the loaded chat id in the answer resolver", async () => {
	await streamAndSaveMessage("chat-example", []);
	expect(h.resolve.mock.calls[0][1].conversationId).toBe("chat-example");
});
it("does not resolve a model for a missing chat", async () => {
	h.load.mockResolvedValue(null);
	await expect(streamAndSaveMessage("missing-example", [])).rejects.toThrow(
		"Chat not found",
	);
	expect(h.resolve).not.toHaveBeenCalled();
});
