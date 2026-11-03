import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const m = vi.hoisted(() => ({
	stream: vi.fn(),
	model: vi.fn(),
	execute: vi.fn(),
	configs: vi.fn(),
	mcp: vi.fn(),
}));
vi.mock("@repo/ai", async (original) => ({
	...(await original<typeof import("@repo/ai")>()),
	streamText: m.stream,
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	db: { mCPConfig: { findMany: m.configs } },
	ensureSensitiveOperationAuthority: vi.fn(async () => ({
		authorized: true,
	})),
}));
vi.mock("@repo/mcp", async (original) => ({
	...(await original<typeof import("@repo/mcp")>()),
	getCachedMcpClientForConfig: m.mcp,
}));
vi.mock("../orchestrator/utils/model-selector", () => ({
	getAiModelWithSelection: m.model,
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({ cancellationSignal: new AbortController().signal }),
	},
	heartbeat: vi.fn(),
}));
vi.mock("../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(async () => {}),
}));
vi.mock("../../lib/execution-output-drain", () => ({
	flushExecutionEvents: vi.fn(async () => {}),
}));

import { executeAgentTurn } from "../agent-execution-core/agent-executor";

const turn = {
	systemPrompt: "Exact saved instructions",
	userMessage: "Current task",
	knowledgeContext: "Exact selected knowledge",
	userId: "example-user",
	organizationId: "example-org",
	mcpConfigIds: ["example-config"],
};
const calls = [
	{
		toolCallId: "example-call",
		toolName: "get_issue",
		input: { id: "example-issue" },
	},
];
const messages = [
	{
		role: "assistant" as const,
		content: [{ type: "tool-call" as const, ...calls[0] }],
	},
];
beforeEach(() => {
	vi.clearAllMocks();
	m.execute.mockResolvedValue({ value: "not executed by model" });
	m.configs.mockResolvedValue([
		{ id: "example-config", displayName: "Example tools" },
	]);
	m.mcp.mockResolvedValue({
		serverName: "example-tools",
		client: {
			tools: async () => ({
				get_issue: {
					description: "Exact selected schema",
					inputSchema: z.object({ id: z.string() }),
					execute: m.execute,
				},
			}),
		},
	});
	m.model.mockResolvedValue({
		model: { id: "example-model" },
		provider: "openai",
		modelString: "example-model",
	});
	m.stream.mockReturnValue({
		text: Promise.resolve(""),
		usage: Promise.resolve({ inputTokens: 5, outputTokens: 3 }),
		response: Promise.resolve({ messages }),
		toolCalls: Promise.resolve(calls),
	});
});
describe("saved agent one-model-step execution", () => {
	it("preserves prompt/context/current schema and exact assistant messages while omitting every execute callback", async () => {
		const continuation = [
			{ role: "assistant" as const, content: "Previous decision" },
		];
		const result = await executeAgentTurn({
			...turn,
			durableStep: { continuationMessages: continuation },
		});
		expect(result).toMatchObject({
			success: true,
			response: "",
			toolCalls: [],
			tokenUsage: { inputTokens: 5, outputTokens: 3 },
			modelStep: {
				messages,
				toolCalls: [
					{
						id: "example-call",
						name: "get_issue",
						args: { id: "example-issue" },
					},
				],
			},
		});
		const request = m.stream.mock.calls[0][0];
		expect(request.instructions).toContain(turn.systemPrompt);
		expect(request.instructions).toContain(turn.knowledgeContext);
		expect(request.messages.at(-1)).toEqual(continuation[0]);
		expect(request.tools.get_issue.description).toBe(
			"Exact selected schema",
		);
		expect(request.tools.get_issue.inputSchema).toBeDefined();
		expect(request.tools.get_issue.execute).toBeUndefined();
		expect(m.execute).not.toHaveBeenCalled();
		expect(m.stream).toHaveBeenCalledTimes(1);
	});
	it("retains executable callbacks on the untouched legacy activity path", async () => {
		await executeAgentTurn(turn);
		expect(m.stream.mock.calls[0][0].tools.get_issue.execute).toBeTypeOf(
			"function",
		);
	});
	it("refuses an invalid provider tool decision without dispatching any tool", async () => {
		m.stream.mockReturnValue({
			text: Promise.resolve(""),
			usage: Promise.resolve({}),
			response: Promise.resolve({ messages }),
			toolCalls: Promise.resolve([{ ...calls[0], invalid: true }]),
		});
		expect(
			await executeAgentTurn({
				...turn,
				durableStep: { continuationMessages: [] },
			}),
		).toMatchObject({ success: false });
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("records a no-tools response as a single completed model decision", async () => {
		m.stream.mockReturnValue({
			text: Promise.resolve("Exact response"),
			usage: Promise.resolve({}),
			response: Promise.resolve({
				messages: [{ role: "assistant", content: "Exact response" }],
			}),
		});
		const result = await executeAgentTurn({
			...turn,
			mcpConfigIds: [],
			durableStep: { continuationMessages: [] },
		});
		expect(result).toMatchObject({
			success: true,
			response: "Exact response",
			modelStep: {
				messages: [{ role: "assistant", content: "Exact response" }],
				toolCalls: [],
			},
		});
	});
});
