import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	resolve: vi.fn(async () => ({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	})),
}));
vi.mock("../dynamic-model-selector", () => ({
	getAIModelWithMetadata: h.resolve,
}));
vi.mock("ai", () => ({
	generateText: vi.fn(async () => ({ text: "Example title", usage: {} })),
}));
vi.mock("../usage-logging", () => ({ logModelUsageAsync: vi.fn() }));

import { generateChatTitle } from "../title-generator";

it.each(["chat-example", undefined])(
	"forwards the explicit title conversation (%s)",
	async (conversationId) => {
		h.resolve.mockClear();
		await generateChatTitle("Example message", {
			userId: "user-example",
			conversationId,
		});
		expect(
			(
				h.resolve.mock.calls[0] as unknown as [
					unknown,
					{ conversationId?: string },
				]
			)[1].conversationId,
		).toBe(conversationId);
	},
);
