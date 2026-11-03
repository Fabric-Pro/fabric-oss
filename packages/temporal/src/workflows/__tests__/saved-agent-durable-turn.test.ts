import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	model: vi.fn(),
	tool: vi.fn(),
	options: [] as Array<Record<string, unknown>>,
}));
vi.mock("@temporalio/workflow", () => ({
	workflowInfo: () => ({ workflowId: "example-workflow" }),
	proxyActivities: (options: Record<string, unknown>) => {
		m.options.push(options);
		return {
			executeSavedAgentModelStep: m.model,
			executeSavedAgentToolStep: (input: unknown) =>
				m.tool(input, options),
		};
	},
}));

import { executeDurableSavedAgentTurn } from "../saved-agent-durable-turn";

const input = {
	systemPrompt: "Exact saved prompt",
	userMessage: "Exact user task",
	knowledgeContext: "Selected knowledge",
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
	agentInstanceId: "example-instance",
};
const calls = [
	{ id: "example-call-1", name: "write_one", args: { value: "one" } },
	{ id: "example-call-2", name: "read_two", args: { value: "two" } },
];
const messages = [
	{
		role: "assistant",
		content: calls.map((c) => ({
			type: "tool-call",
			toolCallId: c.id,
			toolName: c.name,
			input: c.args,
		})),
		providerOptions: { example: { preserved: true } },
	},
];
beforeEach(() => {
	vi.resetAllMocks();
	m.options.length = 0;
	m.model
		.mockResolvedValueOnce({
			success: true,
			response: "",
			toolCalls: [],
			tokenUsage: { inputTokens: 3, outputTokens: 2 },
			modelStep: { messages, toolCalls: calls },
		})
		.mockResolvedValue({
			success: true,
			response: "Exact final response",
			toolCalls: [],
			tokenUsage: { inputTokens: 5, outputTokens: 4 },
			modelStep: {
				messages: [
					{ role: "assistant", content: "Exact final response" },
				],
				toolCalls: [],
			},
		});
	m.tool.mockImplementation(async ({ decision, effectId }) => ({
		...decision,
		result: { value: decision.args.value },
		status: "success",
		durationMs: 3,
		effectId,
	}));
});
describe("durable saved-agent workflow orchestration", () => {
	it("records one model decision before ordered isolated effects and exact continuation messages", async () => {
		const result = await executeDurableSavedAgentTurn(input);
		expect(result).toMatchObject({
			success: true,
			response: "Exact final response",
			tokenUsage: { inputTokens: 8, outputTokens: 6 },
		});
		expect(result.toolCalls.map((c) => c.id)).toEqual(
			calls.map((c) => c.id),
		);
		expect(m.model).toHaveBeenCalledTimes(2);
		expect(m.tool).toHaveBeenCalledTimes(2);
		const continued = m.model.mock.calls[1][0];
		expect(continued).toMatchObject(input);
		expect(continued.continuationMessages[0]).toEqual(messages[0]);
		expect(
			continued.continuationMessages
				.slice(1)
				.map(
					(v: { content: Array<{ toolCallId: string }> }) =>
						v.content[0].toolCallId,
				),
		).toEqual(calls.map((c) => c.id));
		expect(m.tool.mock.calls[0][0].effectId).toBe(
			"saved-agent:example-workflow:turn:0:example-call-1",
		);
		for (const [, options] of m.tool.mock.calls)
			expect(options).toMatchObject({ retry: { maximumAttempts: 1 } });
	});
	it("stops at lost acknowledgement, records pending inspection and never reruns prior model or starts a sibling effect", async () => {
		m.tool.mockRejectedValue(new Error("example acknowledgement lost"));
		const result = await executeDurableSavedAgentTurn(input);
		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining("inspect"),
			toolCalls: [
				{
					id: calls[0].id,
					status: "pending",
					result: {
						inspectionRequired: true,
						effectId:
							"saved-agent:example-workflow:turn:0:example-call-1",
					},
				},
			],
		});
		expect(m.model).toHaveBeenCalledTimes(1);
		expect(m.tool).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ authorityRequired: true },
		{
			isError: true,
			content: [{ type: "text", text: "Example response lost" }],
		},
		{ error: "Example request failed" },
	])(
		"stops on an acknowledged inspection-required MCP/error result instead of asking the model to retry: %j",
		async (result) => {
			m.tool.mockResolvedValue({
				...calls[0],
				status: "error",
				result,
				inspectionRequired: true,
			});
			expect(await executeDurableSavedAgentTurn(input)).toHaveProperty(
				"success",
				false,
			);
			expect(m.model).toHaveBeenCalledTimes(1);
			expect(m.tool).toHaveBeenCalledTimes(1);
		},
	);
	it("retains known predispatch refusal without implying an external write was unacknowledged", async () => {
		m.tool.mockRejectedValue(
			ApplicationFailure.nonRetryable(
				"Example schema no longer matches",
				"SAVED_AGENT_TOOL_REFUSED",
			),
		);
		const result = await executeDurableSavedAgentTurn(input);
		expect(result).toMatchObject({
			success: false,
			toolCalls: [
				{
					status: "error",
					result: {
						dispatchState: "not_started",
						inspectionRequired: false,
					},
				},
			],
		});
		expect(result.error).toContain("before dispatch");
		expect(m.model).toHaveBeenCalledTimes(1);
		expect(m.tool).toHaveBeenCalledTimes(1);
	});
	it("retains acknowledged prior tool effects if the next model Activity fails", async () => {
		m.model
			.mockReset()
			.mockResolvedValueOnce({
				success: true,
				response: "",
				toolCalls: [],
				modelStep: { messages, toolCalls: [calls[0]] },
			})
			.mockRejectedValue(new Error("Example provider unavailable"));
		const result = await executeDurableSavedAgentTurn(input);
		expect(result).toMatchObject({
			success: false,
			toolCalls: [{ id: calls[0].id, status: "success" }],
		});
		expect(m.tool).toHaveBeenCalledTimes(1);
		expect(m.model).toHaveBeenCalledTimes(2);
	});
	it("refuses oversized accumulated context before dispatching a model or effect", async () => {
		expect(
			await executeDurableSavedAgentTurn({
				...input,
				knowledgeContext: "x".repeat(600000),
			}),
		).toHaveProperty("success", false);
		expect(m.model).not.toHaveBeenCalled();
		expect(m.tool).not.toHaveBeenCalled();
	});
});
