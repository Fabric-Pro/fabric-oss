import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
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
		sleep: vi.fn().mockResolvedValue(undefined),
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

it("clears the graph error after a backlog retry succeeds", async () => {
	const { START, StateGraph } = await import("@langchain/langgraph");
	const { BacklogUpdaterStateAnnotation } = await import("../state");
	invokeMock.mockReset();
	invokeMock.mockRejectedValueOnce(
		Object.assign(new Error("Unavailable"), { status: 503 }),
	);
	invokeMock.mockResolvedValueOnce(
		new AIMessage("Backlog analysis completed."),
	);
	const graph = new StateGraph(BacklogUpdaterStateAnnotation)
		.addNode("chat_node", chatNode)
		.addEdge(START, "chat_node")
		.compile();
	const result = await graph.invoke({
		...baseState,
		messages: [new HumanMessage("Analyze the backlog")],
	});
	expect(result.error).toBeUndefined();
	expect(result.messages.at(-1)?.content).toBe("Backlog analysis completed.");
});

describe("backlog-updater chatNode analysis failure tool binding", () => {
	beforeEach(() => {
		invokeMock
			.mockReset()
			.mockResolvedValue(new AIMessage("The analysis could not start."));
		bindToolsMock.mockClear();
	});
	async function run(messages: unknown[]) {
		return chatNode({
			...baseState,
			tools: [
				{
					name: "analyze_backlog",
					description: "Analyze",
					parameters: { type: "object", properties: {} },
				},
			],
			messages: messages as never,
		});
	}
	it.each(["analyze_backlog", undefined])(
		"does not bind tools after an analysis error with tool name %s and no assistant tool calls",
		async (name) => {
			await run([
				new HumanMessage("Analyze"),
				new AIMessage("Starting analysis"),
				new ToolMessage({
					name,
					content: "Analysis error: Input validation failed",
					tool_call_id: "example-call",
				}),
			]);
			expect(invokeMock).toHaveBeenCalledOnce();
			expect(bindToolsMock).not.toHaveBeenCalled();
			expect(invokeMock.mock.calls[0][0].at(-1).content).toContain(
				"Analysis error: Input validation failed",
			);
		},
	);
	it.each([
		{
			role: "tool",
			name: "analyze_backlog",
			content: "Analysis error: unavailable",
		},
		{ type: "tool", content: "Analysis error: unavailable" },
	])("handles plain tool message formats: %j", async (message) => {
		await run([new HumanMessage("Analyze"), message]);
		expect(invokeMock).toHaveBeenCalledOnce();
		expect(bindToolsMock).not.toHaveBeenCalled();
	});

	it("preserves tools for a named unrelated tool result", async () => {
		await run([
			new HumanMessage("Analyze"),
			new ToolMessage({
				name: "another_tool",
				content: "Analysis error: unavailable",
				tool_call_id: "example-call",
			}),
		]);
		expect(bindToolsMock).toHaveBeenCalledOnce();
		expect(invokeMock).toHaveBeenCalledOnce();
	});
	it("binds tools for a genuine new human message", async () => {
		await run([
			new HumanMessage("Analyze"),
			new HumanMessage("Analysis error: unavailable"),
		]);
		expect(bindToolsMock).toHaveBeenCalledOnce();
		expect(invokeMock).toHaveBeenCalledOnce();
	});

	// Staging shape: the assistant turn arrives with no content and no
	// tool_calls, and the tool result has no name.
	it.each([
		{
			label: "a selection result by its shape",
			assistant: new AIMessage(""),
			content: JSON.stringify({
				selectedMeetings: [
					{
						joinUrl: "https://example.com/meet/1",
						startTime: "2026-01-01T00:00:00Z",
					},
				],
				selectedChannels: [],
				daysBack: 30,
			}),
			expected: "[Result from select_review_sources]",
		},
		{
			label: "a Notion result by its shape",
			assistant: new AIMessage(""),
			content: JSON.stringify({ pageIds: [], mcpConfigId: "" }),
			expected: "[Result from select_notion_pages]",
		},
		{
			label: "a result by its matching assistant tool call",
			assistant: new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "example-call",
						name: "select_review_sources",
						args: {},
					},
				],
			}),
			content: "Selection cancelled",
			expected: "[Result from select_review_sources]",
		},
		{
			label: "other unnamed results as unknown",
			assistant: new AIMessage(""),
			content: "Done",
			expected: "[Result from unknown_tool]",
		},
	])("names $label", async ({ assistant, content, expected }) => {
		await run([
			new HumanMessage("Update the backlog from my meetings"),
			assistant,
			new ToolMessage({ content, tool_call_id: "example-call" }),
		]);
		const sent = invokeMock.mock.calls[0][0].at(-1).content as string;
		expect(sent).toContain(`${expected}: ${content}`);
	});
	it("binds tools again when a new user turn follows an analysis error", async () => {
		await run([
			new ToolMessage({
				name: "analyze_backlog",
				content: "Analysis error: unavailable",
				tool_call_id: "example-call",
			}),
			new HumanMessage("Try a different selection"),
		]);
		expect(bindToolsMock).toHaveBeenCalledOnce();
	});
});

describe("app-owned flow continuations", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		bindToolsMock.mockClear();
	});
	it.each([
		"select_review_sources",
		"select_notion_pages",
		"analyze_backlog",
		"review_backlog_changes",
		"apply_backlog_changes",
		undefined,
	])(
		"does not bind or emit tools after %s even when the model ignores bindings",
		async (name) => {
			invokeMock.mockResolvedValue(
				new AIMessage({
					content: "Status",
					tool_calls: [
						{ id: "wrong-call", name: "analyze_backlog", args: {} },
					],
					additional_kwargs: { tool_calls: [{ id: "wrong-call" }] },
				}),
			);
			const result = await chatNode({
				...baseState,
				tools: [{ name: "analyze_backlog", parameters: {} }],
				messages: [
					new HumanMessage("Review"),
					new AIMessage(""),
					new ToolMessage({
						name,
						content: "Done",
						tool_call_id: "example-call",
					}),
				],
			} as never);
			expect(bindToolsMock).not.toHaveBeenCalled();
			const last = (result.update as any).messages.at(-1);
			expect(last.tool_calls ?? []).toEqual([]);
			expect(last.additional_kwargs?.tool_calls).toBeUndefined();
		},
	);
});

it.each(["selecting", "analyzing", "reviewing", "applying"])(
	"restores entry tools for a genuine request despite stale mirror phase %s",
	async (phase) => {
		invokeMock.mockReset().mockResolvedValue(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "example-new-call",
						name: "analyze_backlog",
						args: {},
						type: "tool_call",
					},
				],
			}),
		);
		bindToolsMock.mockClear();
		const result = await chatNode({
			...baseState,
			flow: {
				version: 1,
				sessionId: "example-session",
				messageId: "example-old",
				flowId: "example-flow",
				sourcePlan: [],
				intakeMode: "standard",
				phase,
			},
			messages: [
				new ToolMessage({
					content: "Previous analysis complete",
					name: "analyze_backlog",
					tool_call_id: "example-old-call",
				}),
				new HumanMessage({
					id: "example-new-message",
					content: "Another genuine request",
				}),
			],
			tools: [{ name: "analyze_backlog", parameters: {} }],
		} as never);
		expect(bindToolsMock).toHaveBeenCalledTimes(1);
		const reply = (result.update as any).messages.at(-1);
		expect(reply.tool_calls).toEqual([
			{
				id: "example-new-call",
				name: "analyze_backlog",
				args: {},
				type: "tool_call",
			},
		]);
		expect(reply.content).toBe("");
	},
);

it.each([
	{
		content: [],
		expected:
			"The application is managing this request. Use the existing card for progress and review.",
	},
	{
		content: [
			{
				type: "tool_use",
				id: "example-call",
				name: "analyze_backlog",
				input: {},
			},
		],
		expected:
			"The application is managing this request. Use the existing card for progress and review.",
	},
	{
		content: [
			{ type: "text", text: "Existing card" },
			{
				type: "tool_use",
				id: "example-call",
				name: "analyze_backlog",
				input: {},
			},
		],
		expected: [{ type: "text", text: "Existing card" }],
	},
])(
	"strips array tool content and retains a useful reply: %j",
	async ({ content, expected }) => {
		invokeMock
			.mockReset()
			.mockResolvedValue(new AIMessage({ content } as never));
		const result = await chatNode({
			...baseState,
			messages: [
				new HumanMessage("Review"),
				new ToolMessage({
					name: "analyze_backlog",
					content: "Managed by app",
					tool_call_id: "example-call",
				}),
			],
		} as never);
		expect((result.update as any).messages.at(-1).content).toEqual(
			expected,
		);
	},
);
