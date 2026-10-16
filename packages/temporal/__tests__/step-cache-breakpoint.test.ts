/**
 * Unit tests for the tool-loop `prepareStep` that pairs in-flight tool-result
 * compaction with the rolling Anthropic cache breakpoint (Fizzy #3094). The
 * breakpoint itself is tested in `packages/ai/lib/__tests__/step-cache-breakpoint.test.ts`.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/step-cache-breakpoint.test.ts
 */

import { withStepCacheBreakpoint } from "@repo/ai/prompt-cache";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { makeInFlightToolCompactor } from "../src/activities/agentic-loop/in-flight-tool-compaction";
import { makeToolLoopPrepareStep } from "../src/activities/agentic-loop/step-cache-breakpoint";

const BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } };

function toolResult(id: string, chars: number): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: id,
				toolName: "project_rag_query",
				output: { type: "text", value: "x".repeat(chars) },
			},
		],
	};
}

function toolCall(id: string): ModelMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: id,
				toolName: "project_rag_query",
				input: {},
			},
		],
	};
}

function breakpointIndexes(messages: ModelMessage[]): number[] {
	return messages.flatMap((m, i) =>
		m.providerOptions?.anthropic?.cacheControl ? [i] : [],
	);
}

describe("withStepCacheBreakpoint around the compactor", () => {
	it("marks the compacted array when the wrapped compactor rewrites history", () => {
		const prepare = withStepCacheBreakpoint(
			makeInFlightToolCompactor({ charBudget: 1000 }),
		);
		const { messages } = prepare({
			messages: [
				{ role: "user", content: "do the step" },
				toolCall("c1"),
				toolResult("c1", 5000),
				toolCall("c2"),
				toolResult("c2", 5000),
			],
		});
		const first = messages[2].content as Array<{
			output: { value: string };
		}>;
		expect(first[0].output.value).toContain(
			"truncated to fit context budget",
		);
		expect(breakpointIndexes(messages)).toEqual([4]);
	});
});

describe("makeToolLoopPrepareStep", () => {
	const messages: ModelMessage[] = [{ role: "user", content: "do the step" }];

	it.each([
		["ANTHROPIC_DIRECT", "claude-haiku-5-5"],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-5-5"],
	])("adds the breakpoint for %s %s", (provider, model) => {
		const result = makeToolLoopPrepareStep({
			provider,
			modelString: model,
			hasTools: true,
		})({ messages });
		expect(result.messages?.[0].providerOptions).toEqual(BREAKPOINT);
	});

	it("only compacts a call with no tools, even on Anthropic", () => {
		const prepareStep = makeToolLoopPrepareStep({
			provider: "ANTHROPIC_DIRECT",
			modelString: "claude-haiku-5-5",
			hasTools: false,
		});
		expect(prepareStep({ messages })).toEqual({});
	});

	it.each([
		["OPENAI", "gpt-6.1"],
		["AWS_BEDROCK", "anthropic.claude-sonnet-5-5"],
		["VERCEL_GATEWAY", "openai/gpt-6.1"],
	])("only compacts for %s %s", (provider, model) => {
		const prepareStep = makeToolLoopPrepareStep({
			provider,
			modelString: model,
			hasTools: true,
		});
		expect(prepareStep({ messages })).toEqual({});
	});
});
