import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Truncated-empty response recovery (issue #2976).
 *
 * A reasoning-capable model bills its invisible thinking against the same
 * output budget as the visible answer, so a turn can come back
 * `finish_reason: length` with NO content and NO tool calls — the whole budget
 * spent before a single visible token. Before this fix that fell through the
 * "no tool call" branch and ended the run with `error: undefined`, leaving the
 * document untouched and the user with the generic "I wasn't able to generate
 * a response" fallback.
 *
 * Drives the real chat-node with a stubbed model (same pattern as
 * reasoning-emission.test.ts) so the retry decision, the escalated budget, and
 * the terminal error are all exercised through the node itself.
 */

const invokeMock = vi.fn();
const getAgentModelAsyncMock = vi.fn(async () => ({
	invoke: invokeMock,
	bindTools: vi.fn(() => ({ invoke: invokeMock })),
}));

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("../utils")
	>()) as Record<string, unknown>;
	return { ...actual, getAgentModelAsync: getAgentModelAsyncMock };
});

// Import AFTER vi.mock so chatNode sees the stubbed util.
const { chatNode, TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE } = await import(
	"../nodes/chat-node"
);

const baseState = {
	document: "# Draft\n\nExisting body.\n",
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

const truncatedEmptyResponse = () =>
	new AIMessage({
		content: "",
		tool_calls: [],
		response_metadata: { finish_reason: "length" },
	});

describe("document-generator chatNode — truncated-empty response recovery", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		getAgentModelAsyncMock.mockClear();
	});

	it("retries once with double the output budget when the response is empty and truncated", async () => {
		invokeMock.mockResolvedValueOnce(truncatedEmptyResponse());
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Updated.",
				tool_calls: [
					{
						id: "call_after_retry",
						name: "write_document_local",
						args: { document: "# Draft\n\nRewritten body.\n" },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("tighten this up")] as never,
		});

		// Exactly one retry — not a loop.
		expect(invokeMock).toHaveBeenCalledTimes(2);
		const budgets = getAgentModelAsyncMock.mock.calls.map(
			(call) =>
				(call[1] as { maxTokens?: number } | undefined)?.maxTokens,
		);
		expect(budgets).toEqual([16000, 32000]);

		// The retry's result is what the node acts on.
		const update = (command as { update?: Record<string, unknown> }).update;
		expect(update?.document).toBe("# Draft\n\nRewritten body.\n");
		expect(update?.error).toBeUndefined();
	});

	it("ends with a user-facing error when the escalated retry is also empty and truncated", async () => {
		invokeMock.mockResolvedValueOnce(truncatedEmptyResponse());
		invokeMock.mockResolvedValueOnce(truncatedEmptyResponse());

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("tighten this up")] as never,
		});

		expect(invokeMock).toHaveBeenCalledTimes(2);
		const goto = (command as { goto?: unknown }).goto;
		const update = (command as { update?: Record<string, unknown> }).update;

		expect(Array.isArray(goto) ? goto[0] : goto).toBe("__end__");
		expect(update?.error).toBe(TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE);
		const messages = update?.messages as Array<{ content?: unknown }>;
		expect(messages.at(-1)?.content).toBe(
			TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE,
		);
		// The message promises the document was not changed, so the update has
		// to SAY so rather than stay silent: `predict_state` streams partial
		// `write_document_local` arguments into state.document as they arrive,
		// and a call truncated mid-arguments lands in `invalid_tool_calls`,
		// which the emptiness check deliberately ignores. Omitting `document`
		// here would leave that fragment as the final state.
		expect(update?.document).toBe(baseState.document);
	});

	it("leaves a genuinely empty (non-truncated) response on the existing no-tool-call path", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({ content: "", tool_calls: [] }),
		);

		const command = await chatNode({
			...baseState,
			messages: [new HumanMessage("tighten this up")] as never,
		});

		// No stop reason means no evidence of truncation: no retry, and the
		// existing quiet-END behavior is unchanged.
		expect(invokeMock).toHaveBeenCalledTimes(1);
		const goto = (command as { goto?: unknown }).goto;
		const update = (command as { update?: Record<string, unknown> }).update;
		expect(Array.isArray(goto) ? goto[0] : goto).toBe("__end__");
		expect(update?.error).toBeUndefined();
	});
});
