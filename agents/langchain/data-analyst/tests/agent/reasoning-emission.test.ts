/**
 * Drives the agentNode end-to-end with a stubbed model and asserts that
 * the reasoning capture pipeline produces the expected `reasoningByTurn`
 * slice on the returned partial state. Same helper module
 * `@repo/agent-core/reasoning-trace` does the extraction.
 *
 * data-analyst differs from chat-node-style agents:
 *  - `agentNode` returns `Partial<DataAnalystState>` directly (not Command)
 *  - it uses the SYNC `bindTools` (no async helper) and `getAgentModelAsync`
 *    is imported from `@repo/agent-core`
 *  - tools come from `state.mcpTools` (not state.tools)
 *
 * We mock `getAgentModelAsync` from `@repo/agent-core` so the test
 * doesn't need network/DB and can deterministically choose the response
 * shape per case.
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const bindToolsMock = vi.fn();

vi.mock("@repo/agent-core", async (importOriginal) => {
	const actual =
		(await importOriginal<typeof import("@repo/agent-core")>()) as Record<
			string,
			unknown
		>;
	return {
		...actual,
		// Stub returns a model whose `bindTools` produces another model with
		// the SAME `invoke`. agentNode binds mcpTools only when `state.mcpTools`
		// is non-empty; cover both branches by routing through the same mock.
		getAgentModelAsync: vi.fn(async () => ({
			invoke: invokeMock,
			bindTools: bindToolsMock.mockImplementation(() => ({
				invoke: invokeMock,
			})),
		})),
		// Avoid hitting a logging side effect during tests.
		logAgentUsageFromRunnableConfig: vi.fn(),
	};
});

// Import AFTER vi.mock so the agentNode picks up the stubbed dependency.
const {
	__testing,
	DEFAULT_RECURSION_LIMIT,
	MAX_TOOL_ITERATIONS,
} = await import("@/lib/agent/graph");
const { agentNode, shouldContinue } = __testing;

const baseState = {
	messages: [],
	systemPrompt: "You are a data analyst.",
	response: "",
	error: null,
	mcpTools: [],
	mcpClients: [],
	chartArtifacts: [],
	connectionSuggestions: [],
	availableDataSources: [],
	reasoningByTurn: {},
};

function messagesWithToolRounds(rounds: number) {
	return [
		new HumanMessage("Analyze sales"),
		...Array.from(
			{ length: rounds },
			(_, index) =>
				new AIMessage({
					content: "",
					tool_calls: [
						{
							id: `call_${index}`,
							name: "list_deals",
							args: {},
							type: "tool_call" as const,
						},
					],
				}),
		),
	];
}

describe("data-analyst agentNode — reasoning emission", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		bindToolsMock.mockClear();
	});

	it("emits reasoningByTurn when response carries gateway raw_response reasoning", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Sales are up 12% QoQ.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: {
									content: "Sales are up 12% QoQ.",
									reasoning:
										"User asked about sales trend — fetch last 4 quarters and compute delta.",
								},
							},
						],
					},
				},
			}),
		);

		const result = await agentNode({
			...baseState,
			messages: [new HumanMessage("How are sales trending?")] as never,
		});

		const reasoningByTurn = (
			result as {
				reasoningByTurn?: Record<number, { text: string; durationMs: number }>;
			}
		).reasoningByTurn;
		expect(reasoningByTurn).toBeDefined();
		expect(reasoningByTurn?.[1].text).toBe(
			"User asked about sales trend — fetch last 4 quarters and compute delta.",
		);
		expect(reasoningByTurn?.[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("emits reasoningByTurn when response carries Anthropic thinking blocks", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Need to join HubSpot deals with Stripe payments.",
					},
					{ type: "text", text: "Joining the two datasets now." },
				] as never,
			}),
		);

		const result = await agentNode({
			...baseState,
			messages: [new HumanMessage("Compare deals vs payments")] as never,
		});

		const reasoningByTurn = (
			result as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Need to join HubSpot deals with Stripe payments.",
		);
	});

	it("does NOT add reasoningByTurn to the result when response has no reasoning", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({ content: "Plain answer with no thinking." }),
		);

		const result = await agentNode({
			...baseState,
			messages: [new HumanMessage("hi")] as never,
		});

		expect((result as Record<string, unknown>).reasoningByTurn).toBeUndefined();
	});

	it("captures reasoning when mcpTools are bound (bindTools branch)", async () => {
		// state.mcpTools non-empty triggers the bindTools branch. Confirm
		// reasoning capture still works there — same as backlog-updater
		// bindTools-branch test.
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Use the list_deals tool to fetch HubSpot data.",
					},
					{ type: "text", text: "Fetching deals." },
				] as never,
				tool_calls: [
					{
						id: "call_1",
						name: "list_deals",
						args: { limit: 10 },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const result = await agentNode({
			...baseState,
			mcpTools: [
				{
					name: "list_deals",
					description: "Fetch deals",
					schema: { type: "object", properties: {} },
				},
			] as never,
			messages: [new HumanMessage("list deals")] as never,
		});

		expect(bindToolsMock).toHaveBeenCalledOnce();
		expect(invokeMock).toHaveBeenCalledOnce();
		const reasoningByTurn = (
			result as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Use the list_deals tool to fetch HubSpot data.",
		);
	});

	it("unbinds tools and adds the budget-exhausted system instruction in finalize mode", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({ content: "Final analysis from gathered data." }),
		);

		await agentNode({
			...baseState,
			mcpTools: [{ name: "list_deals" }] as never,
			messages: messagesWithToolRounds(MAX_TOOL_ITERATIONS) as never,
		});

		expect(bindToolsMock).not.toHaveBeenCalled();
		const invokedMessages = invokeMock.mock.calls[0][0] as Array<{
			role?: string;
			content?: string;
		}>;
		expect(invokedMessages[0]).toMatchObject({ role: "system" });
		expect(invokedMessages[0].content).toContain(
			"The analysis tool budget is exhausted",
		);
		expect(invokedMessages[0].content).toContain(
			"Produce the final answer now using only the data already gathered",
		);
		expect(invokedMessages[0].content).toContain(
			"Do not request or call any more tools",
		);
	});

	it("never returns dangling tool calls from finalize mode", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Final analysis.",
				tool_calls: [
					{
						id: "unexpected_call",
						name: "list_deals",
						args: {},
						type: "tool_call" as const,
					},
				],
			}),
		);

		const result = await agentNode({
			...baseState,
			mcpTools: [{ name: "list_deals" }] as never,
			messages: messagesWithToolRounds(MAX_TOOL_ITERATIONS) as never,
		});

		const returnedMessage = result.messages?.[0] as AIMessage;
		expect(returnedMessage.tool_calls).toEqual([]);
		expect(result.response).toBe("Final analysis.");
	});

	it("routes to cleanup when a model requests tools past the budget", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const state = {
			...baseState,
			messages: messagesWithToolRounds(MAX_TOOL_ITERATIONS + 1),
		};

		expect(shouldContinue(state as never)).toBe("cleanup");
		expect(warnSpy).toHaveBeenCalledWith(
			"[DataAnalyst] Tool iteration limit exceeded; routing to cleanup",
			{
				toolRounds: MAX_TOOL_ITERATIONS + 1,
				maxToolIterations: MAX_TOOL_ITERATIONS,
			},
		);
	});

	it("keeps the recursion limit above the graph's required superstep floor", () => {
		expect(DEFAULT_RECURSION_LIMIT).toBe(48);
		expect(DEFAULT_RECURSION_LIMIT).toBeGreaterThanOrEqual(
			2 * MAX_TOOL_ITERATIONS + 1 + 2,
		);
	});
});
