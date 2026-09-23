/**
 * The budget-exhausted synthesis is sent a compacted history (Fizzy #2040,
 * F44). Behaviour is tested on the pure helpers; the wiring — that it only
 * happens behind `orch-synthesis-compacted-v1` and the unpatched call still
 * sends the full history — is read as source, as the other iterative-loop
 * wiring tests do.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IterativeMessage } from "../../types";
import {
	buildSynthesisHistory,
	renderPartialFindings,
	SYNTHESIS_INPUT,
} from "../synthesis-history";

const ts = "2026-09-23T00:00:00.000Z";

function largeHistory(iterations: number): IterativeMessage[] {
	const history: IterativeMessage[] = [
		{
			role: "user",
			content: "Audit every service for stale feature flags",
			timestamp: ts,
		},
	];
	for (let i = 1; i <= iterations; i++) {
		const calls = [1, 2, 3].map((n) => ({
			id: `call-${i}-${n}`,
			name: "code_search",
			args: { query: `flag ${i}.${n}`, blob: "x".repeat(5_000) },
		}));
		history.push({
			role: "assistant",
			content: `Iteration ${i}: searching`,
			toolCalls: calls,
			timestamp: ts,
			iteration: i,
		});
		for (const call of calls) {
			history.push({
				role: "tool",
				toolCallId: call.id,
				content: `result for ${call.id} `.repeat(3_000),
				timestamp: ts,
				iteration: i,
			});
		}
	}
	return history;
}

function totalChars(history: IterativeMessage[]): number {
	return history.reduce(
		(sum, m) =>
			sum +
			m.content.length +
			(m.toolCalls ?? []).reduce(
				(s, c) => s + c.name.length + JSON.stringify(c.args).length,
				0,
			),
		0,
	);
}

describe("buildSynthesisHistory", () => {
	it("keeps a large history under the synthesis ceiling", () => {
		const history = largeHistory(30);
		expect(totalChars(history)).toBeGreaterThan(5_000_000);

		const compacted = buildSynthesisHistory(history);

		expect(totalChars(compacted)).toBeLessThanOrEqual(
			SYNTHESIS_INPUT.maxTotalChars,
		);
		expect(compacted[0].content).toBe(history[0].content);
	});

	it("never leaves a tool result without the call that produced it", () => {
		const compacted = buildSynthesisHistory(largeHistory(30));
		const seenCalls = new Set<string>();
		for (const message of compacted) {
			for (const call of message.toolCalls ?? []) {
				seenCalls.add(call.id);
			}
			if (message.role === "tool") {
				expect(seenCalls.has(message.toolCallId ?? "")).toBe(true);
			}
		}
		const lastCall =
			[...compacted].reverse().find((m) => m.toolCalls)?.toolCalls ?? [];
		const results = compacted.filter((m) => m.role === "tool");
		for (const call of lastCall) {
			expect(results.some((r) => r.toolCallId === call.id)).toBe(true);
		}
	});

	it("keeps the most recent results longer than older ones and says what it left out", () => {
		const compacted = buildSynthesisHistory(largeHistory(3));
		const tools = compacted.filter((m) => m.role === "tool");
		const last = tools.at(-1)?.content ?? "";
		const first = tools[0]?.content ?? "";
		expect(last.length).toBeGreaterThan(first.length);
		expect(first.length).toBeLessThan(
			SYNTHESIS_INPUT.olderToolResultMaxChars + 60,
		);

		const dropped = buildSynthesisHistory(largeHistory(40));
		expect(dropped[1].content).toMatch(
			/earlier message\(s\) of this turn were left out/,
		);
	});

	it("does not modify the history it is given", () => {
		const history = largeHistory(5);
		const before = JSON.stringify(history);
		buildSynthesisHistory(history);
		expect(JSON.stringify(history)).toBe(before);
	});

	it("returns a small history unchanged in shape", () => {
		const history = largeHistory(1).map((m) => ({
			...m,
			content: m.content.slice(0, 50),
			toolCalls: m.toolCalls?.map((c) => ({ ...c, args: { q: 1 } })),
		}));
		expect(buildSynthesisHistory(history)).toEqual(history);
	});
});

describe("renderPartialFindings", () => {
	it("shows the latest successful outputs, shortened", () => {
		const text = renderPartialFindings([
			{ name: "a", status: "success", result: "old" },
			{ name: "b", status: "error", result: { error: "nope" } },
			{ name: "c", status: "success", result: { rows: 2 } },
			{ name: "d", status: "success", result: "y".repeat(2_000) },
			{ name: "e", status: "success", result: "latest finding" },
		]);
		expect(text).toContain("## What I found so far");
		expect(text).toContain("latest finding");
		expect(text).toContain('{"rows":2}');
		expect(text).not.toContain("**a**");
		expect(text).not.toContain("nope");
		expect(text?.length).toBeLessThan(2_000);
	});

	it("returns null when nothing succeeded", () => {
		expect(
			renderPartialFindings([
				{ name: "a", status: "error", result: "x" },
			]),
		).toBeNull();
	});
});

describe("budget-exhausted synthesis wiring", () => {
	const source = readFileSync(
		join(
			process.cwd(),
			"src/workflows/orchestrator/phases/iterative-execution.ts",
		),
		"utf-8",
	);

	it("compacts only behind its own patch marker, keeping the full history otherwise", () => {
		expect(source).toMatch(
			/const compactSynthesis = patched\("orch-synthesis-compacted-v1"\);\s*const synthesisHistory = compactSynthesis\s*\?\s*buildSynthesisHistory\(conversationHistory\)\s*:\s*conversationHistory;/,
		);
	});

	it("sends the (possibly compacted) history to both synthesis attempts", () => {
		const block = source.slice(
			source.indexOf('patched("orch-synthesis-compacted-v1")'),
			source.indexOf("state.pendingHandoff = {"),
		);
		expect(
			block.match(/conversationHistory: synthesisHistory,/g),
		).toHaveLength(2);
		expect(block).not.toMatch(
			/runAgentIteration\(\{\s*conversationHistory,/,
		);
	});

	it("adds findings to the fallback only on the patched path", () => {
		expect(source).toMatch(
			/summarizeAccomplishments\(state, \{\s*includeFindings: compactSynthesis,\s*\}\)/,
		);
	});
});
