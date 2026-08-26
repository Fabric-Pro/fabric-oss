/**
 * Unit tests for the in-flight tool-result compactor used by AI SDK
 * `prepareStep` callbacks in trigger-system, mcp-tool-handler, and
 * agentic-loop/run-agent.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/in-flight-tool-compaction.test.ts
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import { makeInFlightToolCompactor } from "../src/activities/agentic-loop/in-flight-tool-compaction";

function ragToolResult(id: string, contextChars: number): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: id,
				toolName: "project_rag_query",
				output: { type: "text", value: "x".repeat(contextChars) },
			},
		],
	};
}

function toolParts(m: ModelMessage): ToolResultPart[] {
	return (m as ToolModelMessage).content as ToolResultPart[];
}

function textOutput(part: ToolResultPart): string {
	const out = part.output as { type: string; value: string };
	return out.value;
}

const USER: ModelMessage = { role: "user", content: "what's in the meeting" };
const ASSISTANT_TEXT: ModelMessage = {
	role: "assistant",
	content: [{ type: "text", text: "let me check" }],
};

describe("makeInFlightToolCompactor", () => {
	it("does nothing when total chars stay under budget", () => {
		const compact = makeInFlightToolCompactor({
			charBudget: 10_000,
			keepRecentToolMessages: 1,
		});
		const messages: ModelMessage[] = [
			USER,
			ASSISTANT_TEXT,
			ragToolResult("tc1", 500),
		];
		expect(compact({ messages })).toEqual({});
	});

	it("compacts older tool results when over budget, keeps the most recent", () => {
		const compact = makeInFlightToolCompactor({
			charBudget: 10_000,
			keepRecentToolMessages: 1,
		});
		const messages: ModelMessage[] = [
			USER,
			ASSISTANT_TEXT,
			ragToolResult("tc1", 8_000),
			ASSISTANT_TEXT,
			ragToolResult("tc2", 8_000),
		];

		const result = compact({ messages });
		expect(result.messages).toBeDefined();
		const out = result.messages as ModelMessage[];

		const older = toolParts(out[2])[0];
		expect(older.toolCallId).toBe("tc1");
		expect(textOutput(older)).toMatch(/truncated/);
		expect(textOutput(older).length).toBeLessThan(500);

		const recent = toolParts(out[4])[0];
		expect(recent.toolCallId).toBe("tc2");
		expect(textOutput(recent).length).toBe(8_000);
	});

	it("preserves toolCallId, toolName, and tool-result structure on rewrite", () => {
		const compact = makeInFlightToolCompactor({
			charBudget: 1_000,
			keepRecentToolMessages: 0,
		});
		const messages: ModelMessage[] = [
			USER,
			ragToolResult("tc-keep-id", 50_000),
		];

		const result = compact({ messages });
		const out = result.messages as ModelMessage[];
		const part = toolParts(out[1])[0];

		expect(part.type).toBe("tool-result");
		expect(part.toolCallId).toBe("tc-keep-id");
		expect(part.toolName).toBe("project_rag_query");
	});

	it("does not rewrite small tool results even if total budget exceeded", () => {
		const compact = makeInFlightToolCompactor({
			charBudget: 1_000,
			keepRecentToolMessages: 1,
			minOutputCharsToCompact: 1_000,
		});
		const messages: ModelMessage[] = [
			USER,
			ragToolResult("tc-small", 200),
			ASSISTANT_TEXT,
			ragToolResult("tc-large", 50_000),
		];

		const result = compact({ messages });
		const out = result.messages as ModelMessage[];
		expect(textOutput(toolParts(out[1])[0]).length).toBe(200);
	});

	it("returns no-op when there are zero or one tool messages", () => {
		const compact = makeInFlightToolCompactor({
			charBudget: 100,
			keepRecentToolMessages: 1,
		});
		const messages: ModelMessage[] = [USER, ragToolResult("tc1", 50_000)];
		expect(compact({ messages })).toEqual({});
	});

	it("does not mutate the input messages array", () => {
		const compact = makeInFlightToolCompactor({
			charBudget: 1_000,
			keepRecentToolMessages: 1,
		});
		const original = ragToolResult("tc1", 50_000);
		const originalCopy = JSON.parse(JSON.stringify(original));
		const messages: ModelMessage[] = [
			USER,
			original,
			ASSISTANT_TEXT,
			ragToolResult("tc2", 50_000),
		];

		compact({ messages });
		expect(original).toEqual(originalCopy);
	});

	it("uses sensible defaults when called with no args", () => {
		const compact = makeInFlightToolCompactor();
		const messages: ModelMessage[] = [USER, ragToolResult("tc1", 1_000)];
		expect(compact({ messages })).toEqual({});
	});
});
