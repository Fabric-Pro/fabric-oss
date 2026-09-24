import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	HISTORY_MAX_TOTAL_CHARS,
	historyWindowSchema,
	windowHistory,
	windowUntypedHistory,
} from "../history-window";
import {
	doneTurnEvent,
	failedTurnEvent,
	partialTurnEvent,
	ROUTE_TIMEOUT_MESSAGE,
} from "../turn-events";

/**
 * Direct chat turn-ending events and the history window (Fizzy #2040 review:
 * F4, F11, F22/F26, F24, F32).
 */

describe("failedTurnEvent", () => {
	it("carries the workflow's error", () => {
		expect(failedTurnEvent({ error: "tools: too many tools" })).toEqual({
			type: "error",
			message: "tools: too many tools",
		});
	});

	it("attaches the limit the activity classified", () => {
		const event = failedTurnEvent({
			error: "Too Many Requests",
			limitSignal: { kind: "provider_rate_limit", message: "429" },
		});
		expect(event.limit?.kind).toBe("provider_rate_limit");
	});

	it("classifies a limit from the message when the activity could not", () => {
		const event = failedTurnEvent({
			error: "This model's maximum context length is 128000 tokens",
		});
		expect(event.limit?.kind).toBe("context_length");
	});
});

describe("partialTurnEvent", () => {
	it("is null for a clean turn", () => {
		expect(partialTurnEvent({})).toBeNull();
	});

	it("reports a provider error that cut the answer short", () => {
		expect(
			partialTurnEvent({ partialError: "rate limit exceeded" }),
		).toMatchObject({
			type: "error",
			partial: true,
			message: "rate limit exceeded",
			limit: { kind: "provider_rate_limit" },
		});
	});
});

describe("doneTurnEvent", () => {
	it("flags an answer produced after the tools failed", () => {
		expect(
			doneTurnEvent({
				toolsFailedThisTurn: { summary: "schema rejected" },
			}),
		).toMatchObject({
			type: "done",
			toolsFailed: { summary: "schema rejected" },
		});
	});

	it("does not flag a normal turn", () => {
		expect(doneTurnEvent({})).not.toHaveProperty("toolsFailed");
		expect(doneTurnEvent({})).not.toHaveProperty("truncated");
	});

	it("says when the answer stopped on a limit (review F25)", () => {
		expect(doneTurnEvent({ truncated: "step_limit" })).toMatchObject({
			type: "done",
			truncated: "step_limit",
		});
		expect(doneTurnEvent({ truncated: "output_limit" })).toMatchObject({
			truncated: "output_limit",
		});
	});
});

describe("windowHistory total size (review F38)", () => {
	const big = (i: number) => ({
		role: "user" as const,
		content: `${i}${"x".repeat(100_000)}`,
	});

	it("drops the oldest entries past the character budget", () => {
		const history = Array.from({ length: 10 }, (_, i) => big(i));
		const windowed = windowHistory(history);
		const total = windowed.reduce((sum, e) => sum + e.content.length, 0);
		expect(total).toBeLessThanOrEqual(HISTORY_MAX_TOTAL_CHARS);
		expect(windowed.length).toBeLessThan(history.length);
		expect(windowed.at(-1)).toBe(history.at(-1));
	});

	it("keeps a newest entry larger than the budget, cut to fit", () => {
		const windowed = windowHistory(
			[
				{ role: "user", content: "old" },
				{ role: "assistant", content: "abcdef" },
			],
			{ maxTotalChars: 4 },
		);
		expect(windowed).toEqual([{ role: "assistant", content: "cdef" }]);
	});

	it("bounds the orchestrator's hand-parsed history too", () => {
		const windowed = windowUntypedHistory([
			...Array.from({ length: 10 }, (_, i) => big(i)),
			{ role: "tool", content: "dropped" },
			{ role: "assistant", content: "" },
			{ role: "user", content: 42 },
			null,
		]);
		const total = windowed.reduce((sum, e) => sum + e.content.length, 0);
		expect(total).toBeLessThanOrEqual(HISTORY_MAX_TOTAL_CHARS);
		expect(windowed.every((e) => e.role === "user")).toBe(true);
		expect(windowed.some((e) => e.content === "")).toBe(false);
	});

	it("treats a missing or malformed history as empty", () => {
		expect(windowUntypedHistory(undefined)).toEqual([]);
		expect(windowUntypedHistory("nope")).toEqual([]);
	});
});

describe("historyWindowSchema", () => {
	const turns = (count: number) =>
		Array.from({ length: count }, (_, i) => ({
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content: `turn ${i}`,
		}));

	it("keeps the most recent window instead of rejecting a long thread", () => {
		const parsed = historyWindowSchema.safeParse(turns(260));

		expect(parsed.success).toBe(true);
		expect(parsed.data).toHaveLength(200);
		expect(parsed.data?.at(-1)?.content).toBe("turn 259");
	});

	it("accepts the system rows a persisted conversation carries", () => {
		expect(
			historyWindowSchema.safeParse([
				{ role: "system", content: "SYSTEM" },
			]).success,
		).toBe(true);
	});

	it("still refuses an absurd payload", () => {
		expect(historyWindowSchema.safeParse(turns(5_000)).success).toBe(false);
	});
});

describe("stream route wiring", () => {
	const source = readFileSync(
		join(process.cwd(), "app/api/agents/fabric-ai/stream/route.ts"),
		"utf-8",
	);

	it("forwards settled tool calls before a failure", () => {
		const completed = source.slice(
			source.indexOf('description.status.name === "COMPLETED"'),
			source.indexOf('description.status.name === "FAILED"'),
		);
		const toolCalls = completed.indexOf(
			"for (const toolCall of result.toolCalls)",
		);
		const failure = completed.indexOf(
			"sendEvent(failedTurnEvent(result));",
		);
		expect(toolCalls).toBeGreaterThan(-1);
		expect(failure).toBeGreaterThan(toolCalls);
	});

	it("cancels the workflow when it runs out of poll budget", () => {
		const timeout = source.slice(source.indexOf("Out of poll budget"));
		expect(timeout).toMatch(/handle\.cancel\(\)/);
		expect(timeout).toMatch(/message: ROUTE_TIMEOUT_MESSAGE/);
		expect(ROUTE_TIMEOUT_MESSAGE).toMatch(/stopped/);
	});
});
