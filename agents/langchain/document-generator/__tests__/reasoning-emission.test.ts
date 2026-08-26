import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the chat-node end-to-end with a stubbed model and asserts that
 * the reasoning capture pipeline produces the expected `reasoningByTurn`
 * slice on Command.update. Mirrors the project-document-generator and
 * backlog-updater reasoning-trace contracts — same helper module from
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
		// the SAME `invoke`. document-generator chatNode always binds
		// write_document_local, so all happy-path returns flow through this
		// bindTools → invoke chain.
		getAgentModelAsync: vi.fn(async () => ({
			invoke: invokeMock,
			bindTools: bindToolsMock.mockImplementation(() => ({
				invoke: invokeMock,
			})),
		})),
	};
});

// Import AFTER vi.mock so the chatNode sees the stubbed util.
const { chatNode } = await import("../nodes/chat-node");

const baseState = {
	document: undefined,
	focusAnchor: undefined,
	documentType: "general" as const,
	projectContext: undefined,
	ragContexts: [],
	systemPrompt: undefined,
	error: undefined,
	retryCount: 0,
	tools: [],
	reasoningByTurn: {},
};

describe("document-generator chatNode — reasoning emission", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		bindToolsMock.mockClear();
	});

	it("emits reasoningByTurn when response carries gateway raw_response reasoning", async () => {
		// Mimic a complete document tool-call so chatNode reaches the
		// post-invoke happy path (otherwise it falls into the empty-args
		// retry branch which still preserves reasoning but is a noisier test).
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Here's a draft.",
				tool_calls: [
					{
						id: "call_1",
						name: "write_document_local",
						args: { document: "# Draft\n\nHello." },
						type: "tool_call" as const,
					},
				],
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: {
									content: "Here's a draft.",
									reasoning:
										"User wants a quick draft — I'll keep it concise.",
								},
							},
						],
					},
				},
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("Draft a quick doc")] as never,
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
			"User wants a quick draft — I'll keep it concise.",
		);
		expect(reasoningByTurn?.[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("emits reasoningByTurn when response carries Anthropic thinking blocks", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Plan: 3 sections — intro, body, conclusion.",
					},
					{ type: "text", text: "Drafting now." },
				] as never,
				tool_calls: [
					{
						id: "call_2",
						name: "write_document_local",
						args: { document: "# Title\n\nBody." },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("Write a doc")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Plan: 3 sections — intro, body, conclusion.",
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
						args: { document: "# Plain\n\nNo reasoning here." },
						type: "tool_call" as const,
					},
				],
			}),
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
				tool_calls: [
					{
						id: "call_4",
						name: "write_document_local",
						args: { document: "# Doc" },
						type: "tool_call" as const,
					},
				],
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

	it("preserves reasoningByTurn on corrective-retry path (empty tool_call args, under MAX_RETRIES)", async () => {
		// Codex #6 regression — the 4-site spread covers retry branches too.
		// When the model returns write_document_local with empty args while
		// retryCount < MAX_RETRIES, chatNode appends a corrective HumanMessage
		// and routes back to chat_node. That return MUST still carry
		// reasoningByTurn or the trace is lost across the retry.
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Forgot to include the doc — retry.",
					},
				] as never,
				tool_calls: [
					{
						id: "call_retry_1",
						name: "write_document_local",
						args: {}, // empty — triggers corrective retry branch
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("Draft a doc")] as never,
			retryCount: 0, // under MAX_RETRIES → corrective retry path
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Forgot to include the doc — retry.",
		);
		// Confirm we routed back to chat_node, not END (LangGraph Command.goto
		// can be either a string or string[]; check both shapes for robustness).
		const goto = (command as { goto?: string | string[] }).goto;
		const gotoStr = Array.isArray(goto) ? goto[0] : goto;
		expect(gotoStr).toBe("chat_node");
	});

	it("preserves reasoningByTurn on no-tool-call fallback path", async () => {
		// Model returned only text content (no tool call) — chatNode falls
		// through to the "No tool call - return current state with messages"
		// branch. Reasoning capture must survive that path.
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{ type: "thinking", thinking: "Just answer in chat." },
					{ type: "text", text: "Hello!" },
				] as never,
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("hi")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe("Just answer in chat.");
	});
});
