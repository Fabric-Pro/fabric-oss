import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
	countToolRoundsSinceLastHuman,
	deriveRecursionLimit,
	isSyntheticToolImageMessage,
	SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG,
} from "@repo/agent-core/recursion";
import { describe, expect, it } from "vitest";

describe("countToolRoundsSinceLastHuman", () => {
	it("returns 0 for an empty message history", () => {
		expect(countToolRoundsSinceLastHuman([])).toBe(0);
	});

	it("returns 0 when there are no tool-calling AI messages", () => {
		const messages = [
			new HumanMessage({ content: "hi" }),
			new AIMessage({ content: "hello there" }),
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(0);
	});

	it("counts AI-with-tool_calls messages after the last human message", () => {
		const messages = [
			new HumanMessage({ content: "research this" }),
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "1",
						name: "search_x",
						args: {},
						type: "tool_call",
					},
				],
			}),
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "2",
						name: "search_y",
						args: {},
						type: "tool_call",
					},
				],
			}),
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(2);
	});

	it("breaks at the most recent human message and ignores earlier rounds", () => {
		const messages = [
			new HumanMessage({ content: "first request" }),
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "1",
						name: "search_x",
						args: {},
						type: "tool_call",
					},
				],
			}),
			new HumanMessage({ content: "second request" }),
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "2",
						name: "search_y",
						args: {},
						type: "tool_call",
					},
				],
			}),
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(1);
	});

	it("handles the camelCase toolCalls variant", () => {
		const messages = [
			new HumanMessage({ content: "hi" }),
			{
				_getType: () => "ai",
				toolCalls: [{ id: "1", name: "search_x", args: {} }],
			},
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(1);
	});

	it("handles role-based messages (role: 'assistant' / role: 'user')", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				tool_calls: [{ id: "1", name: "search_x", args: {} }],
			},
			{
				role: "assistant",
				tool_calls: [{ id: "2", name: "search_y", args: {} }],
			},
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(2);
	});

	it("does not count AI messages with an empty tool_calls array", () => {
		const messages = [
			new HumanMessage({ content: "hi" }),
			new AIMessage({ content: "no tools needed", tool_calls: [] }),
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(0);
	});
});

describe("deriveRecursionLimit", () => {
	it("adds the default safety buffer to the chat-tool finalize floor", () => {
		expect(deriveRecursionLimit({ maxToolIterations: 20 })).toBe(46);
	});

	it("includes retry self-loops and fixed graph overhead", () => {
		expect(
			deriveRecursionLimit({
				maxToolIterations: 20,
				maxRetries: 5,
				graphOverhead: 2,
			}),
		).toBe(53);
	});

	it("allows callers to choose a custom safety buffer", () => {
		expect(
			deriveRecursionLimit({
				maxToolIterations: 3,
				maxRetries: 1,
				graphOverhead: 2,
				buffer: 0,
			}),
		).toBe(10);
	});
});

// =============================================================================
// Agent-synthesized human turns
// =============================================================================
//
// Some tool output can only reach the model as user-role content — image parts
// are valid on a `user` message but not inside a tool-role message under the
// OpenAI chat-completions schema — so the tool node emits images as a
// follow-up human turn. Those turns are NOT user turns: if one were treated as
// a turn boundary it would refill the per-turn tool budget, letting a run that
// keeps fetching images slip past maxToolIterations and stop only at the
// graph's hard recursion limit.

/** A human-role message the agent synthesized to carry tool image output. */
function syntheticImageTurn(): HumanMessage {
	return new HumanMessage({
		content: [
			{ type: "text", text: "Image(s) retrieved by a_tool (call_1):" },
		],
		additional_kwargs: { [SYNTHETIC_TOOL_IMAGE_MESSAGE_FLAG]: true },
	});
}

/** An AI message carrying one tool call. */
function toolRound(id: string): AIMessage {
	return new AIMessage({
		content: "",
		tool_calls: [{ id, name: "a_tool", args: {}, type: "tool_call" }],
	});
}

describe("isSyntheticToolImageMessage", () => {
	it("detects the flag in additional_kwargs", () => {
		expect(isSyntheticToolImageMessage(syntheticImageTurn())).toBe(true);
	});

	it("returns false for a real human turn", () => {
		expect(
			isSyntheticToolImageMessage(new HumanMessage({ content: "hi" })),
		).toBe(false);
	});

	it("returns false for null/undefined/non-objects", () => {
		expect(isSyntheticToolImageMessage(null)).toBe(false);
		expect(isSyntheticToolImageMessage(undefined)).toBe(false);
		expect(isSyntheticToolImageMessage("nope")).toBe(false);
	});
});

describe("countToolRoundsSinceLastHuman — synthetic image turns", () => {
	it("does not treat a synthetic image turn as a turn boundary", () => {
		// Two rounds either side of a synthetic turn all belong to ONE user turn.
		const messages = [
			new HumanMessage({ content: "research this" }),
			toolRound("1"),
			syntheticImageTurn(),
			toolRound("2"),
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(2);
	});

	it("still stops at a real human turn that follows a synthetic one", () => {
		const messages = [
			toolRound("0"),
			new HumanMessage({ content: "new request" }),
			toolRound("1"),
			syntheticImageTurn(),
			toolRound("2"),
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(2);
	});

	it("does not reset the count when a synthetic turn trails the rounds", () => {
		// Regression guard: a synthetic turn must not reset the budget to 0.
		const messages = [
			new HumanMessage({ content: "go" }),
			toolRound("1"),
			toolRound("2"),
			syntheticImageTurn(),
		];
		expect(countToolRoundsSinceLastHuman(messages)).toBe(2);
	});
});
