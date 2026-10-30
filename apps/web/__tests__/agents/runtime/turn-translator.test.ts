/**
 * The Direct turn → AG-UI translation the agent runtime streams.
 *
 *   - every event it emits is a valid AG-UI event (`@ag-ui/core` schemas);
 *   - the sequence is one AG-UI's own client verifier accepts;
 *   - every field of the Direct workflow's result and every progress phase
 *     reaches the client somewhere. A new field or phase fails web
 *     type-check in the translator's `DIRECT_RESULT_MAPPING` /
 *     `DIRECT_PROGRESS_PHASES` until it is mapped, then fails here until it
 *     has a check;
 *   - a turn replayed from the start produces the same deltas once, and an
 *     approval ends the run as an interrupt carrying the recorded call.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	verifyEvents,
} from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { DirectChatWorkflowOutput } from "@repo/temporal";
import {
	approvalInterrupt,
	DIRECT_PROGRESS_PHASES,
	DIRECT_RESULT_MAPPING,
	FABRIC_EVENT,
	TurnTranslator,
} from "@saas/agents/runtime/turn-translator";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

const THREAD_ID = "thread-example-0001";
const RUN_ID = "run-example-0001";

function collect() {
	const events: AGUIEvent[] = [];
	return { events, emit: (event: AGUIEvent) => events.push(event) };
}

/** Run a turn's events through AG-UI's verifier, wrapped in its run boundary. */
async function verifyRun(events: AGUIEvent[]): Promise<BaseEvent[]> {
	const run: BaseEvent[] = [
		{ type: EventType.RUN_STARTED, threadId: THREAD_ID, runId: RUN_ID },
		...events,
	];
	return lastValueFrom(from(run).pipe(verifyEvents(false), toArray()));
}

function expectValidEvents(events: AGUIEvent[]) {
	for (const event of events) {
		const parsed = EventSchemas.safeParse(event);
		expect(
			parsed.success,
			`${event.type}: ${parsed.success ? "" : parsed.error.message}`,
		).toBe(true);
	}
}

const ANSWER = "The release is green.";

/** A successful result with every field the workflow can report. */
const FULL_RESULT: Required<DirectChatWorkflowOutput> = {
	success: true,
	responseText: ANSWER,
	reasoningText: "Check the pipeline first.",
	reasoningDurationMs: 1200,
	toolCalls: [
		{
			id: "tool-1",
			name: "search_docs",
			serverName: "docs",
			args: { query: "release" },
			result: { hits: 2 },
			status: "complete",
		},
		{
			id: "tool-2",
			name: "create_story",
			args: { title: "Ship it" },
			status: "pending",
		},
	],
	pendingConfirmation: {
		message: "Create the story?",
		toolName: "create_story",
		args: { title: "Ship it" },
		draft: { title: "Ship it" },
	},
	error: "",
	durationMs: 5400,
	usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
	model: { id: "example-model", provider: "EXAMPLE_PROVIDER" },
	sources: [{ id: "source-1", title: "Runbook", type: "document" }],
	toolsFailedThisTurn: { summary: "search timed out" },
	partialError: "The provider stopped early",
	limitSignal: { kind: "provider_overloaded", message: "overloaded" },
	usageLimit: {
		message: "Monthly AI limit reached",
		limitId: "limit-1",
		dimension: "TOKENS",
		window: "MONTHLY",
		used: "100",
		max: "100",
		manageLimitsUrl: "https://example.com/limits",
	},
	truncated: "output_limit",
	apiBilling: { resetAt: null },
};

const FAILED_RESULT: DirectChatWorkflowOutput = {
	success: false,
	error: "Monthly AI limit reached",
	toolCalls: [FULL_RESULT.toolCalls[0]],
	usageLimit: FULL_RESULT.usageLimit,
};

function finishedEvents(
	result: DirectChatWorkflowOutput,
	approval: boolean,
): AGUIEvent[] {
	const { events, emit } = collect();
	const translator = new TurnTranslator(RUN_ID, emit);
	translator.finish({
		threadId: THREAD_ID,
		runId: RUN_ID,
		result,
		approval: approval
			? {
					id: `${RUN_ID}:approval`,
					toolName: "create_story",
					args: { title: "Ship it" },
					draft: { title: "Ship it" },
					message: "Create the story?",
				}
			: null,
	});
	return events;
}

function custom(events: AGUIEvent[], name: string) {
	return events.find(
		(event) => event.type === EventType.CUSTOM && event.name === name,
	);
}

function runFinished(events: AGUIEvent[]) {
	const event = events.find(
		(candidate) => candidate.type === EventType.RUN_FINISHED,
	);
	if (event?.type !== EventType.RUN_FINISHED) {
		throw new Error("no RUN_FINISHED");
	}
	return event;
}

function runError(events: AGUIEvent[]) {
	const event = events.find(
		(candidate) => candidate.type === EventType.RUN_ERROR,
	);
	if (event?.type !== EventType.RUN_ERROR) {
		throw new Error("no RUN_ERROR");
	}
	return event;
}

type Check = (success: AGUIEvent[], failed: AGUIEvent[]) => void;

/**
 * A check for each entry of the translator's `DIRECT_RESULT_MAPPING` (which
 * fails web type-check when the workflow's result gains a field); the
 * coverage test below fails when the two key sets drift apart.
 */
const RESULT_FIELD_CHECKS: Record<keyof DirectChatWorkflowOutput, Check> = {
	success: (success, failed) => {
		expect(runFinished(success).outcome?.type).toBe("interrupt");
		expect(failed.some((e) => e.type === EventType.RUN_ERROR)).toBe(true);
	},
	responseText: (success) => {
		const text = success
			.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
			.map((e) =>
				e.type === EventType.TEXT_MESSAGE_CONTENT ? e.delta : "",
			)
			.join("");
		expect(text).toBe(ANSWER);
	},
	reasoningText: (success) => {
		expect(
			success.some(
				(e) =>
					e.type === EventType.REASONING_MESSAGE_CONTENT &&
					e.delta === FULL_RESULT.reasoningText,
			),
		).toBe(true);
	},
	reasoningDurationMs: (success) => {
		expect(custom(success, FABRIC_EVENT.reasoningDuration)).toMatchObject({
			value: { durationMs: 1200, messageId: `${RUN_ID}:reasoning` },
		});
	},
	toolCalls: (success, failed) => {
		for (const events of [success, failed]) {
			expect(
				events.some(
					(e) =>
						e.type === EventType.TOOL_CALL_RESULT &&
						e.toolCallId === "tool-1",
				),
			).toBe(true);
		}
		expect(
			success.some(
				(e) =>
					e.type === EventType.TOOL_CALL_START &&
					e.toolCallId === "tool-2" &&
					e.parentMessageId === `${RUN_ID}:assistant`,
			),
		).toBe(true);
	},
	pendingConfirmation: (success) => {
		const outcome = runFinished(success).outcome;
		expect(outcome).toEqual({
			type: "interrupt",
			interrupts: [
				{
					id: `${RUN_ID}:approval`,
					reason: "tool_approval",
					message: "Create the story?",
					toolCallId: "tool-2",
					metadata: {
						toolName: "create_story",
						args: { title: "Ship it" },
						draft: { title: "Ship it" },
					},
				},
			],
		});
	},
	error: (_success, failed) => {
		expect(runError(failed).message).toBe("Monthly AI limit reached");
	},
	durationMs: (success) => {
		expect(runFinished(success).result).toMatchObject({ durationMs: 5400 });
	},
	usage: (success) => {
		expect(runFinished(success).usage).toEqual([
			{
				provider: "EXAMPLE_PROVIDER",
				model: "example-model",
				inputTokens: 100,
				outputTokens: 20,
				totalTokens: 120,
			},
		]);
		expect(runFinished(success).result).toMatchObject({
			usage: FULL_RESULT.usage,
		});
	},
	model: (success) => {
		expect(runFinished(success).result).toMatchObject({
			model: FULL_RESULT.model,
		});
	},
	sources: (success) => {
		expect(custom(success, FABRIC_EVENT.sources)).toMatchObject({
			value: { sources: FULL_RESULT.sources },
		});
	},
	toolsFailedThisTurn: (success) => {
		expect(runFinished(success).result).toMatchObject({
			toolsFailed: { summary: "search timed out" },
		});
	},
	partialError: (success) => {
		expect(custom(success, FABRIC_EVENT.partialError)).toMatchObject({
			value: { message: "The provider stopped early" },
		});
	},
	limitSignal: (_success, failed) => {
		const { events, emit } = collect();
		new TurnTranslator(RUN_ID, emit).finish({
			threadId: THREAD_ID,
			runId: RUN_ID,
			result: {
				success: false,
				error: "overloaded",
				limitSignal: FULL_RESULT.limitSignal,
			},
			approval: null,
		});
		expect(runError(events).metadata).toEqual({
			fabric: { limit: FULL_RESULT.limitSignal },
		});
		expect(failed.length).toBeGreaterThan(0);
	},
	usageLimit: (_success, failed) => {
		expect(runError(failed)).toMatchObject({
			code: "AI_USAGE_LIMIT_EXCEEDED",
			metadata: { fabric: { data: { limitId: "limit-1" } } },
		});
	},
	truncated: (success) => {
		expect(runFinished(success).result).toMatchObject({
			truncated: "output_limit",
		});
	},
	apiBilling: (success) => {
		expect(runFinished(success).result).toMatchObject({
			apiBilling: { resetAt: null },
		});
	},
};

describe("TurnTranslator", () => {
	it("emits only valid AG-UI events, in a sequence AG-UI's client accepts", async () => {
		const success = finishedEvents(FULL_RESULT, true);
		const failed = finishedEvents(FAILED_RESULT, false);

		expectValidEvents(success);
		expectValidEvents(failed);
		await expect(verifyRun(success)).resolves.toHaveLength(
			success.length + 1,
		);
		await expect(verifyRun(failed)).resolves.toHaveLength(
			failed.length + 1,
		);
	});

	it("checks every mapped result field, and the sample sets every field", () => {
		expect(Object.keys(RESULT_FIELD_CHECKS).sort()).toEqual(
			Object.keys(DIRECT_RESULT_MAPPING).sort(),
		);
		expect(Object.keys(FULL_RESULT).sort()).toEqual(
			Object.keys(DIRECT_RESULT_MAPPING).sort(),
		);
	});

	it.each(Object.entries(RESULT_FIELD_CHECKS))(
		"maps the result's %s",
		(_field, check) => {
			check(
				finishedEvents(FULL_RESULT, true),
				finishedEvents(FAILED_RESULT, false),
			);
		},
	);

	it.each(Object.keys(DIRECT_PROGRESS_PHASES))(
		"reports the %s phase as the run's progress state",
		(phase) => {
			const { events, emit } = collect();
			new TurnTranslator(RUN_ID, emit).apply({
				phase,
				message: `Now ${phase}`,
				progress: 40,
				currentActivity: "activity",
			});
			expect(events).toEqual([
				{
					type: EventType.STATE_DELTA,
					delta: [
						{
							op: "add",
							path: "/progress",
							value: {
								phase,
								message: `Now ${phase}`,
								progress: 40,
								currentActivity: "activity",
							},
						},
					],
				},
			]);
			expectValidEvents(events);
		},
	);

	it("sends cumulative snapshots as deltas, each part once", async () => {
		const { events, emit } = collect();
		const translator = new TurnTranslator(RUN_ID, emit);
		translator.apply({
			phase: "executing_ai",
			responseText: "The release",
		});
		translator.apply({
			phase: "executing_ai",
			responseText: "The release",
		});
		translator.apply({ phase: "executing_ai", responseText: ANSWER });
		translator.finish({
			threadId: THREAD_ID,
			runId: RUN_ID,
			result: { success: true, responseText: ANSWER },
			approval: null,
		});

		const deltas = events.flatMap((e) =>
			e.type === EventType.TEXT_MESSAGE_CONTENT ? [e.delta] : [],
		);
		expect(deltas).toEqual(["The release", " is green."]);
		expect(
			events.filter((e) => e.type === EventType.STATE_DELTA),
		).toHaveLength(1);
		expect(runFinished(events).outcome).toEqual({ type: "success" });
		await verifyRun(events);
	});

	it("ends a cancelled turn as a cancelled run, closing what is open", async () => {
		const { events, emit } = collect();
		const translator = new TurnTranslator(RUN_ID, emit);
		translator.apply({ responseText: "Partial" });
		translator.cancel(THREAD_ID, RUN_ID);

		expect(events.at(-2)).toEqual({
			type: EventType.TEXT_MESSAGE_END,
			messageId: `${RUN_ID}:assistant`,
		});
		expect(runFinished(events).outcome).toEqual({ type: "cancelled" });
		expect(translator.responseText).toBe("Partial");
		expectValidEvents(events);
		await verifyRun(events);
	});

	it("is checked by a verifier that refuses an invalid sequence", async () => {
		await expect(
			verifyRun([
				{
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "never-started",
					delta: "x",
				},
			]),
		).rejects.toThrow();
	});

	it("asks to start a workflow as the stream route's confirmation_required did, and only for a workflow", async () => {
		const events = finishedEvents(
			{
				success: true,
				responseText: "I can run the release workflow.",
				pendingConfirmation: {
					message: "Run the release workflow?",
					workflowId: "workflow-example-1",
					workflowName: "Release",
					description: "Builds and tags a release",
				},
			},
			false,
		);

		expect(custom(events, FABRIC_EVENT.workflowConfirmation)).toEqual({
			type: EventType.CUSTOM,
			name: FABRIC_EVENT.workflowConfirmation,
			value: {
				messageId: `${RUN_ID}:assistant`,
				workflowId: "workflow-example-1",
				workflowName: "Release",
				description: "Builds and tags a release",
				message: "Run the release workflow?",
			},
		});
		expect(runFinished(events).outcome).toEqual({ type: "success" });
		expectValidEvents(events);
		await verifyRun(events);
		// A tool approval is the run's interrupt, not a workflow start.
		expect(
			custom(
				finishedEvents(FULL_RESULT, true),
				FABRIC_EVENT.workflowConfirmation,
			),
		).toBeUndefined();
	});

	it("keeps what a turn showed, for a turn that ends without a result", () => {
		const { emit } = collect();
		const translator = new TurnTranslator(RUN_ID, emit);
		const running = {
			...FULL_RESULT.toolCalls[0],
			status: "running" as const,
		};
		translator.apply({
			reasoningText: "Check",
			responseText: "Part",
			toolCalls: [running],
		});
		translator.apply({
			reasoningText: "Check the pipeline",
			responseText: "Partial",
			toolCalls: [FULL_RESULT.toolCalls[0]],
		});

		expect(translator.partial()).toEqual({
			responseText: "Partial",
			reasoningText: "Check the pipeline",
			toolCalls: [FULL_RESULT.toolCalls[0]],
		});
		expect(new TurnTranslator(RUN_ID, emit).partial()).toEqual({
			responseText: "",
			toolCalls: [],
		});
	});

	it("names the tool call that asked for the approval", () => {
		expect(
			approvalInterrupt(
				{
					id: "key:approval",
					toolName: "create_story",
					args: {},
					message: "Approve?",
				},
				{ toolCalls: FULL_RESULT.toolCalls },
			).interrupts[0]?.toolCallId,
		).toBe("tool-2");
	});
});
