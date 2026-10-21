import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	resolve: vi.fn(),
	generate: vi.fn(),
	loadMcp: vi.fn(),
}));
vi.mock("@repo/agent-core", () => ({
	globalAgentRegistry: {
		get: (name: string) => ({
			name,
			config: { name },
		}),
	},
}));
vi.mock("@repo/ai", () => ({ getAIModelWithMetadata: h.resolve }));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("ai", () => ({
	generateText: h.generate,
	isStepCount: vi.fn(),
	tool: (definition: unknown) => definition,
}));
vi.mock("../../agent-execution-core", () => ({
	loadMcpToolsForAgent: h.loadMcp,
}));
vi.mock("../../shared/agent-tool-runtime", () => ({
	prepareAgentTools: vi.fn(),
	agentToolAbortSignal: () => undefined,
}));

import { createRunAgentTool, runAgent } from "../run-agent";

beforeEach(() => {
	vi.clearAllMocks();
	h.resolve.mockResolvedValue({ model: {}, metadata: {} });
	h.generate.mockResolvedValue({ text: "done", usage: {} });
	h.loadMcp.mockResolvedValue({ tools: {}, toolToConfig: {} });
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

it.each(["delegate", "inline"] as const)(
	"retains a parent usage origin in %s mode without changing tool scope",
	async (mode) => {
		const usageOrigin = {
			projectId: "origin-project",
			frameId: "origin-frame",
			workflowExecutionId: "origin-execution",
		};
		await runAgent({
			agentId: "agent-example",
			goal: "research",
			mode,
			currentDepth: 3,
			callingAgentId: "parent-example",
			userId: "user-example",
			organizationId: "org-example",
			mcpConfigIds: ["child-mcp"],
			usageOrigin,
		});
		expect(h.resolve).toHaveBeenCalledExactlyOnceWith(
			{ taskType: "TOOL_CALLING" },
			{
				userId: "user-example",
				organizationId: "org-example",
				conversationId: undefined,
				...usageOrigin,
			},
		);
		expect(h.loadMcp).toHaveBeenCalledExactlyOnceWith(
			["child-mcp"],
			"user-example",
			"org-example",
		);
	},
);

it("retains the server origin through the tool and recursive inline delegation", async () => {
	const usageOrigin = {
		projectId: "origin-project",
		frameId: "origin-frame",
		workflowExecutionId: "origin-execution",
	};
	h.generate.mockImplementationOnce(async (request) => {
		await request.tools.run_agent.execute({
			agentId: "grandchild-example",
			goal: "check",
			mode: "inline",
			usageOrigin: { frameId: "spoofed" },
		});
		return { text: "done", usage: {} };
	});
	const run = createRunAgentTool(
		"parent-example",
		0,
		"user-example",
		"org-example",
		["child-mcp"],
		undefined,
		usageOrigin,
	);
	if (!run.execute) {
		throw new Error("Delegation tool requires an executor");
	}
	await run.execute(
		{ agentId: "child-example", goal: "research", mode: "delegate" },
		{ toolCallId: "call", messages: [], context: {} },
	);
	expect(h.resolve).toHaveBeenCalledTimes(2);
	for (const [, context] of h.resolve.mock.calls) {
		expect(context).toMatchObject(usageOrigin);
	}
	expect(h.loadMcp.mock.calls).toEqual([
		[["child-mcp"], "user-example", "org-example"],
		[["child-mcp"], "user-example", "org-example"],
	]);
});
