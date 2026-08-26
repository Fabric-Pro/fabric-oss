import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the breakdown-node end-to-end with a stubbed model and asserts that
 * the reasoning capture pipeline produces the expected `reasoningByTurn`
 * slice on Command.update. Same helper module
 * `@repo/agent-core/reasoning-trace` does the extraction.
 *
 * Mocks `getAgentModel` (sync) via the `../utils` barrel so the test
 * doesn't need network/DB and can deterministically choose the response
 * shape per case. story-breakdown uses the SYNC `getAgentModel` (not
 * `getAgentModelAsync`) — keep that distinction.
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
		// the SAME `invoke`. breakdown-node always binds WRITE_DOCUMENT_TOOL,
		// so all happy-path returns flow through this bindTools → invoke chain.
		getAgentModel: vi.fn(() => ({
			invoke: invokeMock,
			bindTools: bindToolsMock.mockImplementation(() => ({
				invoke: invokeMock,
			})),
		})),
	};
});

// Import AFTER vi.mock so the breakdownNode sees the stubbed util.
const { breakdownNode } = await import("../nodes/breakdown-node");

const baseState = {
	projectName: "Test Project",
	projectDescription: undefined,
	prdContent: "A short PRD describing a simple feature.",
	systemPrompt: undefined,
	tools: [],
	document: undefined,
	focusAnchor: undefined,
	error: undefined,
	retryCount: 0,
	reasoningByTurn: {},
};

describe("story-breakdown breakdownNode — reasoning emission", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		bindToolsMock.mockClear();
	});

	it("emits reasoningByTurn when response carries gateway raw_response reasoning", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Stories drafted.",
				tool_calls: [
					{
						id: "call_1",
						name: "write_document_local",
						args: { document: "# Stories\n\n- Login" },
						type: "tool_call" as const,
					},
				],
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: {
									content: "Stories drafted.",
									reasoning:
										"Let me identify the 3 main flows in the PRD first.",
								},
							},
						],
					},
				},
			}),
		);

		const command = await breakdownNode({
			...baseState,
			messages: [new HumanMessage("Break down the PRD")] as never,
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
			"Let me identify the 3 main flows in the PRD first.",
		);
		expect(reasoningByTurn?.[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("emits reasoningByTurn when response carries Anthropic thinking blocks", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Step 1: enumerate features in PRD.",
					},
					{ type: "text", text: "Drafting now." },
				] as never,
				tool_calls: [
					{
						id: "call_2",
						name: "write_document_local",
						args: { document: "# Stories" },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await breakdownNode({
			...baseState,
			messages: [new HumanMessage("Break it down")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Step 1: enumerate features in PRD.",
		);
	});

	it("does NOT add reasoningByTurn to the update when response has no reasoning", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Plain answer with no thinking.",
				tool_calls: [
					{
						id: "call_3",
						name: "write_document_local",
						args: { document: "# Stories" },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await breakdownNode({
			...baseState,
			messages: [new HumanMessage("hi")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(update).toBeDefined();
		expect(
			(update as Record<string, unknown>).reasoningByTurn,
		).toBeUndefined();
	});

	it("preserves reasoningByTurn on corrective-retry path (empty tool_call args, under MAX_RETRIES)", async () => {
		// Codex #6 regression — the 4-site spread covers retry branches too.
		// When the model returns write_document_local with empty args while
		// retryCount < MAX_RETRIES, breakdownNode appends a corrective
		// HumanMessage and routes back to "breakdown". That return MUST still
		// carry reasoningByTurn or the trace is lost across the retry.
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Forgot the features payload — retry.",
					},
				] as never,
				tool_calls: [
					{
						id: "call_retry_1",
						name: "write_document_local",
						args: {}, // empty → corrective retry branch
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await breakdownNode({
			...baseState,
			messages: [new HumanMessage("Break it down")] as never,
			retryCount: 0,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Forgot the features payload — retry.",
		);
		// Confirm we routed back to "breakdown", not END (LangGraph Command.goto
		// can be either a string or string[]; check both shapes for robustness).
		const goto = (command as { goto?: string | string[] }).goto;
		const gotoStr = Array.isArray(goto) ? goto[0] : goto;
		expect(gotoStr).toBe("breakdown");
	});

	it("coalesces reasoning text within the same turn (existing-text + new-text)", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{ type: "thinking", thinking: "second half." },
				] as never,
				tool_calls: [
					{
						id: "call_4",
						name: "write_document_local",
						args: { document: "# X" },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await breakdownNode({
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
});
