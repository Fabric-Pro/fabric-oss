import type { DirectStreamMessage } from "@saas/agents/hooks/useDirectStream";
import {
	applyReasoningDelta,
	applyReasoningDuration,
	applyToolResult,
} from "@saas/agents/hooks/useDirectStream";
import { describe, expect, it } from "vitest";

describe("applyReasoningDelta", () => {
	const base = (id: string, reasoningText?: string): DirectStreamMessage => ({
		id,
		role: "assistant" as const,
		content: "",
		timestamp: new Date(),
		reasoningText,
	});

	it("appends to an empty reasoningText", () => {
		const next = applyReasoningDelta([base("m1")], "m1", "Hello ");
		expect(next[0]?.reasoningText).toBe("Hello ");
	});

	it("appends to an existing reasoningText", () => {
		const next = applyReasoningDelta(
			[base("m1", "Hello ")],
			"m1",
			"world.",
		);
		expect(next[0]?.reasoningText).toBe("Hello world.");
	});

	it("does not touch other messages", () => {
		const next = applyReasoningDelta(
			[base("m1", "A"), base("m2", "B")],
			"m1",
			"!",
		);
		expect(next[0]?.reasoningText).toBe("A!");
		expect(next[1]?.reasoningText).toBe("B");
	});
});

describe("applyReasoningDuration", () => {
	const base = (id: string): DirectStreamMessage => ({
		id,
		role: "assistant" as const,
		content: "",
		timestamp: new Date(),
	});

	it("sets reasoningDurationMs on the matched message", () => {
		const next = applyReasoningDuration([base("m1")], "m1", 2400);
		expect(next[0]?.reasoningDurationMs).toBe(2400);
	});

	it("does not touch other messages", () => {
		const next = applyReasoningDuration(
			[base("m1"), base("m2")],
			"m1",
			1000,
		);
		expect(next[0]?.reasoningDurationMs).toBe(1000);
		expect(next[1]?.reasoningDurationMs).toBeUndefined();
	});
});

/**
 * `error` is carried separately from `result` because a tool that never ran
 * has no output to explain itself with. The direct-chat activity settles such
 * a call with an error string and no result (Fizzy #2040), and the tool card
 * renders `error` first, falling back to `result`. The field was being dropped
 * at every layer of the path — the SSE route's `tool_result` event, this
 * reducer, and the client-side type — so a real staging run showed a red
 * "Error" heading over an empty box.
 */
describe("applyToolResult", () => {
	const withToolCall = (
		status: "pending" | "running" | "complete" | "error",
		error?: string,
	): DirectStreamMessage => ({
		id: "m1",
		role: "assistant" as const,
		content: "",
		timestamp: new Date(),
		toolCalls: [
			{
				id: "call-1",
				name: "mcp_example_get_identity",
				args: {},
				status,
				error,
			},
		],
	});

	it("keeps the error message that explains why nothing ran", () => {
		const next = applyToolResult([withToolCall("pending")], "m1", {
			toolCallId: "call-1",
			status: "error",
			error: "The model's request for this tool ended before it was complete, so the tool never ran.",
		});

		expect(next[0]?.toolCalls?.[0]?.status).toBe("error");
		expect(next[0]?.toolCalls?.[0]?.error).toMatch(/never ran/);
	});

	it("does not wipe an existing error when the event carries none", () => {
		const next = applyToolResult(
			[withToolCall("error", "earlier detail")],
			"m1",
			{
				toolCallId: "call-1",
				status: "error",
			},
		);

		expect(next[0]?.toolCalls?.[0]?.error).toBe("earlier detail");
	});

	it("still marks a successful call complete", () => {
		const next = applyToolResult([withToolCall("running")], "m1", {
			toolCallId: "call-1",
			status: "complete",
			result: { ok: true },
		});

		expect(next[0]?.toolCalls?.[0]?.status).toBe("complete");
		expect(next[0]?.toolCalls?.[0]?.result).toEqual({ ok: true });
	});

	it("matches by tool name when the id is absent", () => {
		const next = applyToolResult([withToolCall("pending")], "m1", {
			toolName: "mcp_example_get_identity",
			status: "error",
			error: "boom",
		});

		expect(next[0]?.toolCalls?.[0]?.error).toBe("boom");
	});

	it("leaves other messages untouched", () => {
		const other: DirectStreamMessage = {
			id: "m2",
			role: "assistant" as const,
			content: "",
			timestamp: new Date(),
			toolCalls: [
				{ id: "call-1", name: "x", args: {}, status: "pending" },
			],
		};
		const next = applyToolResult([withToolCall("pending"), other], "m1", {
			toolCallId: "call-1",
			status: "error",
			error: "boom",
		});

		expect(next[1]?.toolCalls?.[0]?.status).toBe("pending");
	});
});
