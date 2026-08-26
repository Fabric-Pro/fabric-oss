import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the chat-node end-to-end with a stubbed model and asserts that
 * the reasoning capture pipeline produces the expected `reasoningByTurn`
 * slice on Command.update. Mirrors the project-document-generator
 * reasoning-trace contract — same helper module from
 * `@repo/agent-core/reasoning-trace` does the extraction.
 *
 * Mocks `getAgentModelAsync` via the `../utils` barrel so the test
 * doesn't need network/DB and can deterministically choose the response
 * shape per case.
 */

const invokeMock = vi.fn();
const bindToolsMock = vi.fn();

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("../utils")
	>()) as Record<string, unknown>;
	return {
		...actual,
		// Stub returns a model whose `bindTools` produces another model with
		// the SAME `invoke`. That way both branches in chatNode (tools[]
		// empty → direct invoke; tools[] non-empty → bindTools → invoke)
		// route through `invokeMock` and the reasoning-capture assertions
		// can be exercised in either tool-binding mode.
		getAgentModelAsync: vi.fn(async () => ({
			invoke: invokeMock,
			bindTools: bindToolsMock.mockImplementation(() => ({
				invoke: invokeMock,
			})),
		})),
		// Defensive: chatNode imports MAX_RETRIES etc.; preserve real values
	};
});

// Import AFTER vi.mock so the chatNode sees the stubbed util.
const { chatNode } = await import("../nodes/chat-node");

const baseState = {
	projectId: "test-project",
	projectName: "Test",
	organizationId: "test-org",
	hasTeamsIntegration: false,
	hasSlackIntegration: false,
	hasNotionIntegration: false,
	hasPMTool: false,
	pmToolName: undefined,
	backlogSummary: "",
	analysisStatus: undefined,
	lastProposalSummary: undefined,
	error: undefined,
	retryCount: 0,
	tools: [],
	reasoningByTurn: {},
};

describe("backlog-updater chatNode — reasoning emission", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		bindToolsMock.mockClear();
	});

	it("emits reasoningByTurn when response carries gateway raw_response reasoning", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Here's the analysis.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: {
									content: "Here's the analysis.",
									reasoning:
										"Let me consider whether this backlog change is risky…",
								},
							},
						],
					},
				},
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("Analyze the backlog")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(update).toBeDefined();
		const reasoningByTurn = (
			update as {
				reasoningByTurn?: Record<
					number,
					{ text: string; durationMs: number }
				>;
			}
		).reasoningByTurn;
		expect(reasoningByTurn).toBeDefined();
		expect(reasoningByTurn?.[1].text).toBe(
			"Let me consider whether this backlog change is risky…",
		);
		expect(reasoningByTurn?.[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("emits reasoningByTurn when response carries Anthropic thinking blocks", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Step 1: enumerate backlog…",
					},
					{ type: "text", text: "Here's the analysis." },
				] as never,
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("Analyze")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe("Step 1: enumerate backlog…");
	});

	it("does NOT add reasoningByTurn to the update when response has no reasoning", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({ content: "Plain answer with no thinking." }),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("hi")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(update).toBeDefined();
		expect(
			(update as Record<string, unknown>).reasoningByTurn,
		).toBeUndefined();
	});

	it("coalesces reasoning text within the same turn (existing-text + new-text)", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{ type: "thinking", thinking: "second half." },
				] as never,
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("user")] as never,
			reasoningByTurn: {
				1: {
					text: "first half. ",
					durationMs: 500,
					startedAt: 100,
					completedAt: 600,
				},
			},
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as {
				reasoningByTurn?: Record<
					number,
					{ text: string; startedAt: number }
				>;
			}
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe("first half. second half.");
		// startedAt is preserved from the existing entry
		expect(reasoningByTurn?.[1].startedAt).toBe(100);
	});

	it("does NOT invoke model (and does NOT emit reasoning) on terminal-tool early return", async () => {
		// Construct state.messages so isAfterTerminalTool() returns true:
		// last = ToolMessage, second-last = AIMessage with apply_backlog_changes tool_call.
		const aiWithToolCall = new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_1",
					name: "apply_backlog_changes",
					args: {},
					type: "tool_call" as const,
				},
			],
		});
		// Use plain objects to mimic LangGraph deserialization shape; chatNode's
		// internal getMessageType handles both class instances and plain {type}/{role}.
		const toolMsg = {
			type: "tool",
			content: "Applied.",
			name: "apply_backlog_changes",
		};

		const command = await chatNode({
			...baseState,
			messages: [
				new HumanMessage("apply changes"),
				aiWithToolCall,
				toolMsg,
			] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(invokeMock).not.toHaveBeenCalled();
		expect(
			(update as Record<string, unknown>).reasoningByTurn,
		).toBeUndefined();
	});

	it("captures reasoning when tools are bound (bindTools branch)", async () => {
		// CopilotKit normally registers frontend actions via useCopilotAction
		// and the agent receives them on state.tools. Cover the bindTools
		// branch so the reasoning capture continues to work after tool binding
		// wraps the model.
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking:
							"Considering which backlog items match the user's intent…",
					},
					{ type: "text", text: "Here are 3 candidates." },
				] as never,
			}),
		);

		const command = await chatNode({
			...baseState,
			tools: [
				{
					name: "review_backlog_changes",
					description: "ack",
					parameters: { type: "object", properties: {} },
				},
			],
			messages: [new HumanMessage("review the backlog")] as never,
		});

		expect(bindToolsMock).toHaveBeenCalledOnce();
		expect(invokeMock).toHaveBeenCalledOnce();
		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Considering which backlog items match the user's intent…",
		);
	});
});
