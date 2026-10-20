import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	resolve: vi.fn(),
}));
vi.mock("@repo/agent-core", () => ({
	globalAgentRegistry: {
		get: () => ({
			name: "agent-example",
			config: { name: "agent-example" },
		}),
	},
}));
vi.mock("@repo/ai", () => ({ getAIModelWithMetadata: h.resolve }));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("ai", () => ({
	generateText: vi.fn(async () => ({ text: "done", usage: {} })),
	isStepCount: vi.fn(),
	tool: (definition: unknown) => definition,
}));
vi.mock("../../agent-execution-core", () => ({
	loadMcpToolsForAgent: vi.fn(),
}));
vi.mock("../../shared/agent-tool-runtime", () => ({
	prepareAgentTools: vi.fn(),
	agentToolAbortSignal: () => undefined,
}));

import { runAgent } from "../run-agent";

beforeEach(() => {
	vi.clearAllMocks();
	h.resolve.mockResolvedValue({ model: {}, metadata: {} });
});
it.each(["delegate", "inline"] as const)(
	"attributes %s mode only to the explicit conversation",
	async (mode) => {
		for (const usageConversationId of ["conversation-example", undefined]) {
			h.resolve.mockClear();
			const result = await runAgent({
				agentId: "agent-example",
				goal: "research",
				mode,
				currentDepth: 3,
				callingAgentId: "parent-example",
				userId: "user-example",
				usageConversationId,
			});
			expect(result.success).toBe(true);
			expect(h.resolve.mock.calls[0][1].conversationId).toBe(
				usageConversationId,
			);
		}
	},
);
