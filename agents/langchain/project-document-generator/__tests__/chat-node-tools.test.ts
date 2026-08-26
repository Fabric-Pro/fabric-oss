import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
	extractErrorMessage,
	isToolResultError,
	reconcileToolCalls,
	type ToolCallTrace,
} from "../nodes/chat-node-tools";

/**
 * Build a plain-object ToolMessage shape (mirrors how LangGraph deserializes
 * state across the graph boundary — class identity is lost, so we test the
 * multi-format detection on raw objects).
 */
function toolMsg(opts: {
	tool_call_id: string;
	content?: unknown;
	status?: string;
	additional_kwargs?: Record<string, unknown>;
	role?: string;
	type?: string;
}) {
	const { role = "tool", ...rest } = opts;
	return { role, ...rest };
}

describe("isToolResultError", () => {
	it("returns true when status === 'error' (LangChain ≥ 0.3)", () => {
		expect(
			isToolResultError(toolMsg({ tool_call_id: "1", status: "error" })),
		).toBe(true);
	});

	it("returns true when additional_kwargs.status === 'error' (legacy adapter)", () => {
		expect(
			isToolResultError(
				toolMsg({
					tool_call_id: "1",
					additional_kwargs: { status: "error" },
				}),
			),
		).toBe(true);
	});

	it("returns true when content starts with 'Error:'", () => {
		expect(
			isToolResultError(
				toolMsg({ tool_call_id: "1", content: "Error: bad input" }),
			),
		).toBe(true);
	});

	it("returns false for normal success content", () => {
		expect(
			isToolResultError(
				toolMsg({ tool_call_id: "1", content: "all good" }),
			),
		).toBe(false);
	});

	it("returns false for non-tool messages", () => {
		expect(isToolResultError(new HumanMessage("hi"))).toBe(false);
		expect(isToolResultError(null)).toBe(false);
		expect(isToolResultError(undefined)).toBe(false);
		expect(isToolResultError({ role: "assistant" })).toBe(false);
	});

	it("recognises AG-UI `type: 'tool'` shape", () => {
		expect(
			isToolResultError({
				type: "tool",
				tool_call_id: "1",
				status: "error",
			}),
		).toBe(true);
	});

	it("recognises class-instance `_getType()` shape", () => {
		expect(
			isToolResultError({
				_getType: () => "tool",
				tool_call_id: "1",
				status: "error",
			}),
		).toBe(true);
	});
});

describe("extractErrorMessage", () => {
	it("returns trimmed string content for error tool message", () => {
		expect(
			extractErrorMessage(
				toolMsg({
					tool_call_id: "1",
					status: "error",
					content: "  Error: anchor not found  ",
				}),
			),
		).toBe("Error: anchor not found");
	});

	it("concatenates Anthropic-style array content text blocks", () => {
		expect(
			extractErrorMessage(
				toolMsg({
					tool_call_id: "1",
					status: "error",
					content: [
						{ type: "text", text: "Part A " },
						{ type: "image", source: { data: "ignored" } },
						{ type: "text", text: "Part B" },
					],
				}),
			),
		).toBe("Part A Part B");
	});

	it("returns undefined for success tool messages", () => {
		expect(
			extractErrorMessage(toolMsg({ tool_call_id: "1", content: "ok" })),
		).toBeUndefined();
	});

	it("returns undefined for empty content", () => {
		expect(
			extractErrorMessage(
				toolMsg({
					tool_call_id: "1",
					status: "error",
					content: "   ",
				}),
			),
		).toBeUndefined();
	});

	it("truncates content longer than 240 chars", () => {
		const long = "x".repeat(500);
		const out = extractErrorMessage(
			toolMsg({
				tool_call_id: "1",
				status: "error",
				content: long,
			}),
		);
		expect(out).toBeDefined();
		expect(out?.length).toBe(240);
		expect(out?.endsWith("...")).toBe(true);
	});
});

describe("reconcileToolCalls", () => {
	const NOW = 1_000_000;

	it("appends new pending entries from fresh AIMessage tool_calls", () => {
		const result = reconcileToolCalls(
			[],
			[],
			[
				{ id: "call_1", name: "write_document_local" },
				{ id: "call_2", name: "search_teams_messages" },
			],
			NOW,
		);
		expect(result).toEqual([
			{
				id: "call_1",
				name: "write_document_local",
				status: "pending",
				startedAt: NOW,
			},
			{
				id: "call_2",
				name: "search_teams_messages",
				status: "pending",
				startedAt: NOW,
			},
		]);
	});

	it("transitions matched pending entry to success with durationMs", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_1",
				name: "write_document_local",
				status: "pending",
				startedAt: NOW - 500,
			},
		];
		const messages = [
			toolMsg({ tool_call_id: "call_1", content: "wrote 12 chars" }),
		];
		const result = reconcileToolCalls(existing, messages as never, [], NOW);
		expect(result).toEqual([
			{
				id: "call_1",
				name: "write_document_local",
				status: "success",
				startedAt: NOW - 500,
				durationMs: 500,
			},
		]);
	});

	it("transitions matched pending entry to error with errorMessage", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_1",
				name: "apply_document_patches",
				status: "pending",
				startedAt: NOW - 200,
			},
		];
		const messages = [
			toolMsg({
				tool_call_id: "call_1",
				status: "error",
				content: "Error: anchor 'foo' not found",
			}),
		];
		const result = reconcileToolCalls(existing, messages as never, [], NOW);
		expect(result).toEqual([
			{
				id: "call_1",
				name: "apply_document_patches",
				status: "error",
				startedAt: NOW - 200,
				durationMs: 200,
				errorMessage: "Error: anchor 'foo' not found",
			},
		]);
	});

	it("leaves pending entry untouched when no matching ToolMessage", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_1",
				name: "search_teams_messages",
				status: "pending",
				startedAt: NOW - 100,
			},
		];
		const result = reconcileToolCalls(existing, [], [], NOW);
		expect(result).toEqual(existing);
	});

	it("idempotently leaves resolved entries untouched on re-run", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_1",
				name: "write_document_local",
				status: "success",
				startedAt: NOW - 500,
				durationMs: 500,
			},
		];
		const messages = [
			toolMsg({ tool_call_id: "call_1", content: "result" }),
		];
		const result = reconcileToolCalls(existing, messages as never, [], NOW);
		expect(result).toEqual(existing);
	});

	it("dedups by id when a new tool_call repeats an existing entry's id", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_1",
				name: "write_document_local",
				status: "pending",
				startedAt: NOW - 100,
			},
		];
		const result = reconcileToolCalls(
			existing,
			[],
			[{ id: "call_1", name: "write_document_local" }],
			NOW,
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(existing[0]);
	});

	it("skips new tool_calls missing id or name", () => {
		const result = reconcileToolCalls(
			[],
			[],
			[
				{ id: "call_1", name: "ok_tool" },
				{ id: undefined, name: "no_id" },
				{ id: "call_3", name: undefined },
			],
			NOW,
		);
		expect(result).toEqual([
			{
				id: "call_1",
				name: "ok_tool",
				status: "pending",
				startedAt: NOW,
			},
		]);
	});

	it("handles parallel tool calls — multiple pending in same turn", () => {
		const result = reconcileToolCalls(
			[],
			[],
			[
				{ id: "call_a", name: "search_teams_messages" },
				{ id: "call_b", name: "search_slack_messages" },
				{ id: "call_c", name: "search_repository_code" },
			],
			NOW,
		);
		expect(result).toHaveLength(3);
		expect(result.every((e) => e.status === "pending")).toBe(true);
		expect(result.map((e) => e.name)).toEqual([
			"search_teams_messages",
			"search_slack_messages",
			"search_repository_code",
		]);
	});

	it("merges a turn that adds new pending while resolving previous pending", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_a",
				name: "search_teams_messages",
				status: "pending",
				startedAt: NOW - 300,
			},
		];
		const messages = [
			toolMsg({ tool_call_id: "call_a", content: "5 hits" }),
		];
		const result = reconcileToolCalls(
			existing,
			messages as never,
			[{ id: "call_b", name: "write_document_local" }],
			NOW,
		);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			id: "call_a",
			name: "search_teams_messages",
			status: "success",
			startedAt: NOW - 300,
			durationMs: 300,
		});
		expect(result[1]).toEqual({
			id: "call_b",
			name: "write_document_local",
			status: "pending",
			startedAt: NOW,
		});
	});

	it("clamps negative duration to 0 (clock drift defence)", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_1",
				name: "x",
				status: "pending",
				startedAt: NOW + 100, // future startedAt
			},
		];
		const messages = [toolMsg({ tool_call_id: "call_1", content: "ok" })];
		const result = reconcileToolCalls(existing, messages as never, [], NOW);
		expect(result[0].durationMs).toBe(0);
	});

	it("does not mutate the input existing array", () => {
		const existing: ToolCallTrace[] = [
			{
				id: "call_1",
				name: "x",
				status: "pending",
				startedAt: NOW - 100,
			},
		];
		const snapshot = JSON.parse(JSON.stringify(existing));
		reconcileToolCalls(
			existing,
			[toolMsg({ tool_call_id: "call_1", content: "ok" })] as never,
			[{ id: "call_2", name: "y" }],
			NOW,
		);
		expect(existing).toEqual(snapshot);
	});
});
