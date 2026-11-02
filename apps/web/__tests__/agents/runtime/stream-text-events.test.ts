// @vitest-environment node
/**
 * `streamTextRunEvents`: an AI SDK full stream as one in-process turn's
 * AG-UI events.
 *
 *   - assistant text is a text message, ids `${runId}:s<step>:m<n>`, so the
 *     ids keep text written after a tool call in its step; empty deltas and
 *     reasoning are dropped;
 *   - a tool call goes whole (START, ARGS, END) under the step's text
 *     message, or a new one when the step has none, after any open text is
 *     ended; its result, or `toolErrorText` for a tool that threw (marked
 *     with `TOOL_ERROR_METADATA`), waits for the step to finish and goes in
 *     call order;
 *   - an `error` part, or a stream that throws, ends the open text and
 *     sends the held results before the error is rethrown; `abort` ends
 *     quietly;
 *   - every output passes AG-UI's `verifyEvents` inside a run.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	verifyEvents,
} from "@ag-ui/client";
import { TOOL_ERROR_METADATA } from "@saas/agents/lib/sidekick-runtime-protocol";
import { streamTextRunEvents } from "@saas/agents/runtime/stream-text-events";
import type {
	LanguageModelUsage,
	StepResultPerformance,
	TextStreamPart,
	ToolSet,
} from "ai";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

type Part = TextStreamPart<ToolSet>;

const RUN = "run-example-0001";
const THREAD = "thread-example-0001";

const USAGE: LanguageModelUsage = {
	inputTokens: 1,
	inputTokenDetails: {
		noCacheTokens: 1,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	outputTokens: 1,
	outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
	totalTokens: 2,
};

const PERFORMANCE: StepResultPerformance = {
	effectiveOutputTokensPerSecond: 1,
	outputTokensPerSecond: 1,
	inputTokensPerSecond: 1,
	effectiveTotalTokensPerSecond: 1,
	stepTimeMs: 1,
	responseTimeMs: 1,
	toolExecutionMs: {},
};

const startStep: Part = { type: "start-step", request: {}, warnings: [] };
const finishStep: Part = {
	type: "finish-step",
	response: { id: "response-1", timestamp: new Date(0), modelId: "model" },
	usage: USAGE,
	performance: PERFORMANCE,
	finishReason: "stop",
	rawFinishReason: undefined,
	providerMetadata: undefined,
};
const finish: Part = {
	type: "finish",
	finishReason: "stop",
	rawFinishReason: undefined,
	totalUsage: USAGE,
};

function text(id: string, ...deltas: string[]): Part[] {
	return [
		{ type: "text-start", id },
		...deltas.map(
			(delta): Part => ({ type: "text-delta", id, text: delta }),
		),
		{ type: "text-end", id },
	];
}

function call(toolCallId: string, input: unknown): Part {
	return {
		type: "tool-call",
		toolCallId,
		toolName: "suggest_tools",
		input,
		dynamic: true,
	};
}

function result(toolCallId: string, output: unknown): Part {
	return {
		type: "tool-result",
		toolCallId,
		toolName: "suggest_tools",
		input: {},
		output,
		dynamic: true,
	};
}

async function* stream(parts: Part[], fail?: Error): AsyncIterable<Part> {
	yield* parts;
	if (fail) {
		throw fail;
	}
}

const toolErrorText = (error: unknown) =>
	`tool failed: ${error instanceof Error ? error.message : "?"}`;

/** The turn's events, and what it threw, if anything. */
async function translate(
	parts: AsyncIterable<Part>,
): Promise<{ events: AGUIEvent[]; error: unknown }> {
	const events: AGUIEvent[] = [];
	try {
		for await (const event of streamTextRunEvents(parts, {
			runId: RUN,
			toolErrorText,
		})) {
			events.push(event);
		}
		return { events, error: undefined };
	} catch (error) {
		return { events, error };
	}
}

/** The events inside a run, as `InProcessEngine.run` sends them, through `verifyEvents`. */
function verified(events: AGUIEvent[], failed = false): Promise<BaseEvent[]> {
	const run: AGUIEvent[] = [
		{ type: EventType.RUN_STARTED, threadId: THREAD, runId: RUN },
		...events,
		failed
			? {
					type: EventType.RUN_ERROR,
					message: "failed",
					code: "RUN_FAILED",
				}
			: { type: EventType.RUN_FINISHED, threadId: THREAD, runId: RUN },
	];
	return lastValueFrom(
		from(run as BaseEvent[]).pipe(verifyEvents(false), toArray()),
	);
}

function types(events: AGUIEvent[]): string[] {
	return events.map((event) => event.type);
}

describe("streamTextRunEvents", () => {
	it("sends a text-only step as one text message", async () => {
		const { events, error } = await translate(
			stream([
				{ type: "start" },
				startStep,
				...text("t1", "Hel", "lo"),
				finishStep,
				finish,
			]),
		);

		expect(error).toBeUndefined();
		expect(events).toEqual([
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: `${RUN}:s0:m0`,
				role: "assistant",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${RUN}:s0:m0`,
				delta: "Hel",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${RUN}:s0:m0`,
				delta: "lo",
			},
			{ type: EventType.TEXT_MESSAGE_END, messageId: `${RUN}:s0:m0` },
		]);
		await verified(events);
	});

	it("hangs a tool call that opens its step off a new message", async () => {
		const { events } = await translate(
			stream([
				startStep,
				call("call-1", { suggestions: [] }),
				result("call-1", "Done."),
				finishStep,
				finish,
			]),
		);

		expect(events).toEqual([
			{
				type: EventType.TOOL_CALL_START,
				toolCallId: "call-1",
				toolCallName: "suggest_tools",
				parentMessageId: `${RUN}:s0:m0`,
			},
			{
				type: EventType.TOOL_CALL_ARGS,
				toolCallId: "call-1",
				delta: '{"suggestions":[]}',
			},
			{ type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: "call-1:result",
				toolCallId: "call-1",
				role: "tool",
				content: "Done.",
			},
		]);
		await verified(events);
	});

	it("holds the results until the step finishes, then sends them in call order", async () => {
		const { events } = await translate(
			stream([
				startStep,
				...text("t1", "Two changes."),
				call("call-1", { a: 1 }),
				call("call-2", { b: 2 }),
				result("call-2", { ok: 2 }),
				result("call-1", "first"),
				finishStep,
				startStep,
				...text("t2", "Applied."),
				finishStep,
				finish,
			]),
		);

		expect(types(events)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_RESULT,
			EventType.TOOL_CALL_RESULT,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
		]);
		expect(
			events.flatMap((event) =>
				event.type === EventType.TOOL_CALL_START
					? [event.parentMessageId]
					: [],
			),
		).toEqual([`${RUN}:s0:m0`, `${RUN}:s0:m0`]);
		expect(
			events.flatMap((event) =>
				event.type === EventType.TOOL_CALL_RESULT
					? [[event.toolCallId, event.content]]
					: [],
			),
		).toEqual([
			["call-1", "first"],
			["call-2", '{"ok":2}'],
		]);
		expect(events.at(-3)).toMatchObject({ messageId: `${RUN}:s1:m1` });
		await verified(events);
	});

	it("names text written after a tool call as the same step's, and hangs each call off the text before it", async () => {
		const { events } = await translate(
			stream([
				startStep,
				...text("t1", "Adding a tool."),
				call("call-1", { a: 1 }),
				...text("t2", "And removing one."),
				call("call-2", { b: 2 }),
				result("call-1", "first"),
				result("call-2", "second"),
				finishStep,
				startStep,
				...text("t3", "Both changed."),
				finishStep,
				finish,
			]),
		);

		expect(
			events.flatMap((event) =>
				event.type === EventType.TEXT_MESSAGE_START
					? [event.messageId]
					: [],
			),
		).toEqual([`${RUN}:s0:m0`, `${RUN}:s0:m1`, `${RUN}:s1:m2`]);
		expect(
			events.flatMap((event) =>
				event.type === EventType.TOOL_CALL_START
					? [[event.toolCallId, event.parentMessageId]]
					: [],
			),
		).toEqual([
			["call-1", `${RUN}:s0:m0`],
			["call-2", `${RUN}:s0:m1`],
		]);
		await verified(events);
	});

	it("ends an open text message before a tool call starts", async () => {
		const { events } = await translate(
			stream([
				startStep,
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", text: "Adding a tool." },
				call("call-1", {}),
				{ type: "text-end", id: "t1" },
				result("call-1", "ok"),
				finishStep,
				finish,
			]),
		);

		expect(types(events)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_RESULT,
		]);
		await verified(events);
	});

	it("drops empty deltas", async () => {
		const { events } = await translate(
			stream([
				startStep,
				...text("t1", "", "Hi", ""),
				finishStep,
				finish,
			]),
		);

		expect(
			events.filter(
				(event) => event.type === EventType.TEXT_MESSAGE_CONTENT,
			),
		).toEqual([
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${RUN}:s0:m0`,
				delta: "Hi",
			},
		]);
		await verified(events);
	});

	it("sends nothing for reasoning", async () => {
		const { events } = await translate(
			stream([
				startStep,
				{ type: "reasoning-start", id: "r1" },
				{
					type: "reasoning-delta",
					id: "r1",
					text: "Thinking it over.",
				},
				{ type: "reasoning-end", id: "r1" },
				...text("t1", "Answer."),
				finishStep,
				finish,
			]),
		);

		expect(types(events)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
		]);
		expect(JSON.stringify(events)).not.toContain("Thinking it over.");
	});

	it("ends the open text, then throws an error part's error", async () => {
		const failure = new Error("provider failed");
		const { events, error } = await translate(
			stream([
				startStep,
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", text: "Part" },
				{ type: "error", error: failure },
			]),
		);

		expect(error).toBe(failure);
		expect(types(events)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
		]);
		await verified(events, true);
	});

	it("answers a tool that threw with toolErrorText, marked as failed, and goes on", async () => {
		const { events, error } = await translate(
			stream([
				startStep,
				call("call-1", {}),
				call("call-2", {}),
				{
					type: "tool-error",
					toolCallId: "call-1",
					toolName: "suggest_tools",
					input: {},
					error: new Error("database down"),
					dynamic: true,
				},
				result("call-2", "fine"),
				finishStep,
				startStep,
				...text("t1", "That did not work."),
				finishStep,
				finish,
			]),
		);

		expect(error).toBeUndefined();
		const results = events.filter(
			(event) => event.type === EventType.TOOL_CALL_RESULT,
		);
		expect(results).toEqual([
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: "call-1:result",
				toolCallId: "call-1",
				role: "tool",
				content: "tool failed: database down",
				metadata: TOOL_ERROR_METADATA,
			},
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: "call-2:result",
				toolCallId: "call-2",
				role: "tool",
				content: "fine",
			},
		]);
		expect(events.at(-1)).toMatchObject({
			type: EventType.TEXT_MESSAGE_END,
		});
		await verified(events);
	});

	it("ends quietly on abort, the open text ended", async () => {
		const { events, error } = await translate(
			stream([
				startStep,
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", text: "Stopped" },
				{ type: "abort" },
				...text("t2", "never sent"),
			]),
		);

		expect(error).toBeUndefined();
		expect(types(events)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
		]);
		await verified(events);
	});

	it("sends a step's held result before an error part in the same step is thrown", async () => {
		const failure = new Error("limit reached");
		const { events, error } = await translate(
			stream([
				startStep,
				call("call-1", {}),
				result(
					"call-1",
					"<sidekick_apply_tools>\n[]\n</sidekick_apply_tools>",
				),
				{ type: "error", error: failure },
			]),
		);

		expect(error).toBe(failure);
		expect(events.at(-1)).toEqual({
			type: EventType.TOOL_CALL_RESULT,
			messageId: "call-1:result",
			toolCallId: "call-1",
			role: "tool",
			content: "<sidekick_apply_tools>\n[]\n</sidekick_apply_tools>",
		});
		await verified(events, true);
	});

	it("ends the text and sends the held result before rethrowing a stream that throws mid-step", async () => {
		const failure = new Error("connection reset");
		const { events, error } = await translate(
			stream(
				[
					startStep,
					call("call-1", {}),
					result("call-1", "kept"),
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", text: "Partial" },
				],
				failure,
			),
		);

		expect(error).toBe(failure);
		expect(types(events)).toEqual([
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_RESULT,
		]);
		expect(events.at(-1)).toMatchObject({ content: "kept" });
		await verified(events, true);
	});
});
