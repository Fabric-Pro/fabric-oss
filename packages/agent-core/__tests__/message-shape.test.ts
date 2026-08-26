import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
	dropTrailingAssistantTurns,
	endsOnAssistantTurn,
	readMessageRole,
	shapeHistoryForModel,
} from "../src/message-shape";

/**
 * The shape these tests defend is a provider rule, not a preference:
 *
 *   400 — This model does not support assistant message prefill.
 *         The conversation must end with a user message.
 *
 * Reproduced against the real Databricks-served Claude endpoint while
 * diagnosing the 2026-08-06 production incident, where the sanitizer emitted
 * `…'human','ai'` and every subsequent call on that thread failed.
 */
describe("readMessageRole", () => {
	it("reads LangChain class instances", () => {
		expect(readMessageRole(new HumanMessage({ content: "hi" }))).toBe(
			"human",
		);
		expect(readMessageRole(new AIMessage({ content: "yo" }))).toBe("ai");
	});

	it("reads AG-UI `type`-tagged plain objects", () => {
		expect(readMessageRole({ type: "ai", content: "" })).toBe("ai");
	});

	it("maps OpenAI wire roles onto LangChain names", () => {
		expect(readMessageRole({ role: "assistant", content: "" })).toBe("ai");
		expect(readMessageRole({ role: "user", content: "" })).toBe("human");
	});

	it("returns undefined for something that is not a message", () => {
		expect(readMessageRole(null)).toBeUndefined();
		expect(readMessageRole({})).toBeUndefined();
	});
});

describe("endsOnAssistantTurn", () => {
	it("is false for an empty history — that is the caller's problem", () => {
		expect(endsOnAssistantTurn([])).toBe(false);
	});

	it("is false when the last turn is a user message", () => {
		const messages: BaseMessage[] = [
			new AIMessage({ content: "a" }),
			new HumanMessage({ content: "b" }),
		];
		expect(endsOnAssistantTurn(messages)).toBe(false);
	});

	it("is true when the last turn is an assistant message", () => {
		const messages: BaseMessage[] = [
			new HumanMessage({ content: "b" }),
			new AIMessage({ content: "a" }),
		];
		expect(endsOnAssistantTurn(messages)).toBe(true);
	});
});

describe("dropTrailingAssistantTurns", () => {
	it("returns the SAME array instance when nothing needs removing", () => {
		const messages: BaseMessage[] = [
			new AIMessage({ content: "a" }),
			new HumanMessage({ content: "b" }),
		];
		expect(dropTrailingAssistantTurns(messages)).toBe(messages);
	});

	it("drops a single trailing assistant turn", () => {
		const messages: BaseMessage[] = [
			new HumanMessage({ content: "ask" }),
			new AIMessage({ content: "answer" }),
		];
		const out = dropTrailingAssistantTurns(messages);
		expect(out).toHaveLength(1);
		expect(readMessageRole(out[0])).toBe("human");
	});

	it("drops CONSECUTIVE trailing assistant turns, not just the last", () => {
		// Stripping one can expose another beneath it, so the helper runs to a
		// fixpoint. A single `pop()` would leave a history that still 400s.
		const messages: BaseMessage[] = [
			new HumanMessage({ content: "ask" }),
			new AIMessage({ content: "partial" }),
			new AIMessage({ content: "orphaned tool preamble" }),
		];
		const out = dropTrailingAssistantTurns(messages);
		expect(out).toHaveLength(1);
		expect(endsOnAssistantTurn(out)).toBe(false);
	});

	it("keeps a trailing tool turn — only assistant turns are the problem", () => {
		// A tool result following its assistant turn is a valid tail; Claude
		// only refuses to be *prefilled*.
		const messages: BaseMessage[] = [
			new HumanMessage({ content: "ask" }),
			new AIMessage({ content: "", tool_calls: [] }),
			new ToolMessage({ content: "result", tool_call_id: "call_1" }),
		];
		expect(dropTrailingAssistantTurns(messages)).toHaveLength(3);
	});

	it("does not touch assistant turns in the MIDDLE of the history", () => {
		const messages: BaseMessage[] = [
			new HumanMessage({ content: "one" }),
			new AIMessage({ content: "two" }),
			new HumanMessage({ content: "three" }),
		];
		expect(dropTrailingAssistantTurns(messages)).toHaveLength(3);
	});

	it("reproduces the 2026-08-06 production tail", () => {
		// outputTypes as logged: […,'tool','human','human','ai'] — the run had
		// dropped 3 messages, leaving an assistant turn last.
		const messages: BaseMessage[] = [
			new HumanMessage({ content: "refresh the spec" }),
			new AIMessage({ content: "", tool_calls: [] }),
			new ToolMessage({ content: "{}", tool_call_id: "call_1" }),
			new HumanMessage({ content: "follow-up" }),
			new HumanMessage({ content: "another" }),
			new AIMessage({ content: "orphaned" }),
		];
		expect(endsOnAssistantTurn(messages)).toBe(true);
		const out = dropTrailingAssistantTurns(messages);
		expect(endsOnAssistantTurn(out)).toBe(false);
		expect(readMessageRole(out[out.length - 1])).toBe("human");
	});

	it("returns empty rather than throwing when every turn is an assistant", () => {
		const messages: BaseMessage[] = [
			new AIMessage({ content: "a" }),
			new AIMessage({ content: "b" }),
		];
		expect(dropTrailingAssistantTurns(messages)).toEqual([]);
	});
});

describe("shapeHistoryForModel", () => {
	it("drops a trailing assistant turn and reports the count", () => {
		const out = shapeHistoryForModel([
			new HumanMessage("hi"),
			new AIMessage("there"),
		]);
		expect(out.messages).toHaveLength(1);
		expect(out.dropped).toBe(1);
	});

	it("reports zero dropped when nothing needed removing", () => {
		const messages = [new HumanMessage("hi")];
		const out = shapeHistoryForModel(messages);
		expect(out.messages).toBe(messages);
		expect(out.dropped).toBe(0);
	});

	it("never returns an empty history — an empty messages array is its own 400", () => {
		// The gap the raw drop left behind: a history that sanitizes down to
		// assistant turns only became `[]`, which the provider rejects with
		// "at least one message is required" — the same failure one step later.
		const out = shapeHistoryForModel([
			new AIMessage("only"),
			new AIMessage("assistant"),
		]);
		expect(out.messages).toHaveLength(1);
		expect(readMessageRole(out.messages[0])).toBe("human");
		expect(out.dropped).toBe(2);
	});

	it("does not put the assistant's words in the user's mouth", () => {
		const out = shapeHistoryForModel([new AIMessage("secret plan")]);
		expect(out.messages[0].content).not.toContain("secret plan");
	});

	it("leaves a genuinely empty history empty", () => {
		expect(shapeHistoryForModel([]).messages).toEqual([]);
	});
});
