/**
 * MCP sampling resolves its model through the single plan-aware entry point
 * (Fizzy #2770 D9): a member whose work runs on a ChatGPT plan has sampling
 * served there, by the same rules as every other call, instead of on the
 * organization's raw API key; otherwise it resolves on API billing with the
 * server's preferred model, and refuses like every other call when nothing
 * is configured.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateText: vi.fn(),
	getRAGProviderConfig: vi.fn(),
	getModel: vi.fn(),
}));

vi.mock("@repo/ai", () => ai);

import { createSamplingHandler, samplingTaskType } from "../sampling";

const handler = createSamplingHandler({
	userId: "user-1",
	organizationId: "org-1",
	defaultModel: "claude-sonnet-5",
});

const request = (modelPreferences?: Record<string, unknown>) =>
	handler.handleSamplingRequest({
		messages: [{ role: "user", content: { type: "text", text: "Hi" } }],
		maxTokens: 100,
		...(modelPreferences && { modelPreferences }),
	} as Parameters<typeof handler.handleSamplingRequest>[0]);

beforeEach(() => {
	vi.clearAllMocks();
	ai.generateText.mockResolvedValue({ text: "Hello", finishReason: "stop" });
});

describe("MCP sampling on a ChatGPT plan", () => {
	it("runs on the plan when the plan serves the member's work", async () => {
		ai.getAIModelWithMetadata.mockResolvedValue({
			model: "plan-model",
			metadata: {
				provider: "OPENAI_CHATGPT_PLAN",
				modelString: "gpt-5.6-sol",
			},
		});

		const result = await request();

		expect(ai.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "CHAT", modelOverride: "claude-sonnet-5" },
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(ai.generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "plan-model",
				maxOutputTokens: 100,
			}),
		);
		expect(result.model).toBe("gpt-5.6-sol");
		// No raw key is read on this path at all.
		expect(ai.getRAGProviderConfig).not.toHaveBeenCalled();
		expect(ai.getModel).not.toHaveBeenCalled();
	});

	it("names the provider's model when it runs on API billing", async () => {
		ai.getAIModelWithMetadata.mockResolvedValue({
			model: "api-model",
			metadata: {
				provider: "OPENROUTER",
				modelString: "anthropic/claude-sonnet-5",
			},
		});
		await expect(
			request({ intelligencePriority: 1 }),
		).resolves.toMatchObject({ model: "anthropic/claude-sonnet-5" });
		expect(ai.getAIModelWithMetadata.mock.calls[0]?.[0]).toMatchObject({
			taskType: "COMPLEX",
		});
	});

	it("refuses like every other call when nothing can serve it", async () => {
		ai.getAIModelWithMetadata.mockRejectedValue(
			new Error("No AI provider configured."),
		);
		await expect(request()).rejects.toThrow("No AI provider configured.");
		expect(ai.generateText).not.toHaveBeenCalled();
	});
});

describe("samplingTaskType", () => {
	it("maps the server's priorities to the work it asks for", () => {
		expect(samplingTaskType()).toBe("CHAT");
		expect(samplingTaskType({ intelligencePriority: 0.9 })).toBe("COMPLEX");
		expect(samplingTaskType({ speedPriority: 0.9 })).toBe("SIMPLE");
		expect(
			samplingTaskType({ costPriority: 0.8, intelligencePriority: 0.2 }),
		).toBe("SIMPLE");
	});
});
