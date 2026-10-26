import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	delegate: vi.fn(async () => ({ response: "done", durationMs: 1 })),
}));
vi.mock("../../delegation", () => ({
	delegateToAgent: h.delegate,
	resolveAgentEndpoint: vi.fn(async () => ({ agentId: "agent-example" })),
}));
vi.mock("../../turn-dispatch", () => ({ assertTurnDispatchable: vi.fn() }));

import { executeAgentAsTool } from "../execute-agent-as-tool";

it.each(["conversation-example", undefined])(
	"forwards usage only from the caller (%s)",
	async (usageConversationId) => {
		h.delegate.mockClear();
		await executeAgentAsTool({
			agentId: "agent-example",
			userId: "user-example",
			input: { threadId: "thread-example" },
			parentExecutionId: "execution-example",
			usageConversationId,
		});
		const input = (
			h.delegate.mock.calls[0] as unknown as [
				{ usageConversationId?: string },
			]
		)[0];
		expect(input.usageConversationId).toBe(usageConversationId);
	},
);

it.each(["claude-haiku-4-5", undefined])(
	"forwards the selected model (%s)",
	async (modelOverride) => {
		h.delegate.mockClear();
		await executeAgentAsTool({
			agentId: "example-agent",
			userId: "example-user",
			input: {},
			modelOverride,
		});
		const request = (
			h.delegate.mock.calls[0] as unknown as [Record<string, unknown>]
		)[0];
		if (modelOverride) {
			expect(request).toHaveProperty("modelOverride", modelOverride);
		} else {
			expect(request).not.toHaveProperty("modelOverride");
		}
	},
);

it("forwards the explicit accounting origin independently of retrieval project and tool input", async () => {
	h.delegate.mockClear();
	const usageOrigin = {
		conversationId: "turn-conversation",
		frameId: "turn-frame",
		projectId: "origin-project",
		featureKey: "chat-agent" as const,
	};
	await executeAgentAsTool({
		agentId: "agent-example",
		userId: "user-example",
		projectId: "retrieval-project",
		input: { usageOrigin: { projectId: "forged-project" } },
		usageOrigin,
	});
	expect(h.delegate).toHaveBeenCalledWith(
		expect.objectContaining({
			projectId: "retrieval-project",
			usageOrigin,
		}),
	);
});

it.each(["completed", "failed", "input-required"])(
	"preserves A2A status %s for the workflow",
	async (status) => {
		h.delegate.mockResolvedValueOnce({
			response: "Delegation response",
			durationMs: 1,
			status,
		} as never);
		const result = await executeAgentAsTool({
			agentId: "example-agent",
			userId: "example-user",
			input: { message: "Summarize commits" },
		});
		expect(result).toMatchObject({ output: "Delegation response", status });
	},
);
