// @vitest-environment node
/**
 * OrchestratorTranslator: the stream route's Orchestrator events, as one
 * runtime response carries them (`lib/orchestrator-runtime-protocol.ts`).
 *
 *   - text opens a segment, and a new segment (after `text_start`, or the
 *     first text of a response) replaces the answer's text;
 *   - tool calls are AG-UI tool events with the route's fields in
 *     `metadata.fabric`; arguments are sent whole, a result ends the call;
 *   - phase, routing, plan, step and progress replace agent state;
 *   - events with no AG-UI counterpart are carried whole;
 *   - an approval or a clarifying question ends the run as an interrupt,
 *     unless this run just answered it, and nothing follows it;
 *   - the turn's end is held until `finish`, then sent as the run's end.
 *
 * Every event is checked against AG-UI's event schemas.
 */
import { type AGUIEvent, EventType } from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import { ORCHESTRATOR_RUN_EVENT } from "@saas/agents/lib/orchestrator-runtime-protocol";
import { OrchestratorTranslator } from "@saas/agents/runtime/orchestrator-translator";
import { describe, expect, it } from "vitest";

const KEY = "turn-key-0001";

function translator(decided: ReadonlySet<string> = new Set()) {
	const events: AGUIEvent[] = [];
	const t = new OrchestratorTranslator({
		turnKey: KEY,
		windowNonce: "nonce",
		threadId: "thread-1",
		runId: "run-0001",
		emit: (event) => events.push(event),
		decided,
	});
	return { t, events };
}

function expectValid(events: AGUIEvent[]): void {
	for (const event of events) {
		expect(
			EventSchemas.safeParse(event).success,
			JSON.stringify(event),
		).toBe(true);
	}
}

describe("OrchestratorTranslator", () => {
	it("opens a text segment on the first text and a new one after text_start", () => {
		const { t, events } = translator();

		t.apply({ type: "text_delta", content: "Hel" });
		t.apply({ type: "text_delta", content: "lo" });
		t.apply({ type: "text_start", iteration: 2 });
		t.apply({ type: "text_delta", content: "Again" });

		expect(events.map((event) => event.type)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
		]);
		const starts = events.filter(
			(event) => event.type === EventType.TEXT_MESSAGE_START,
		);
		expect(starts.map((event) => event.messageId)).toEqual([
			`${KEY}:text:1:nonce`,
			`${KEY}:text:2:nonce`,
		]);
		expect(t.facts.answerText).toBe("Again");
		expect(t.textOpen).toBe(true);
		expectValid(events);
	});

	it("sends nothing for empty text", () => {
		const { t, events } = translator();
		t.apply({ type: "text_delta", content: "" });
		expect(events).toEqual([]);
	});

	it("keeps a segment open across tool calls, so text after a tool appends", () => {
		const { t, events } = translator();
		t.apply({ type: "text_delta", content: "Before. " });
		t.apply({
			type: "tool_start",
			toolCallId: "call-1",
			toolName: "search",
			serverName: "docs",
			args: { q: "x" },
			status: "running",
		});
		t.apply({ type: "text_delta", content: "After." });

		expect(t.facts.answerText).toBe("Before. After.");
		const start = events.find(
			(event) => event.type === EventType.TOOL_CALL_START,
		);
		expect(start).toMatchObject({
			toolCallId: "call-1",
			toolCallName: "search",
			parentMessageId: `${KEY}:text:1:nonce`,
			metadata: { fabric: { serverName: "docs", args: { q: "x" } } },
		});
		expectValid(events);
	});

	it("sends tool arguments whole and ends a call on its first result", () => {
		const { t, events } = translator();
		t.apply({ type: "tool_start", toolCallId: "call-1", name: "fetch" });
		t.apply({
			type: "tool_input",
			toolCallId: "call-1",
			args: { url: "https://example.com" },
		});
		t.apply({
			type: "tool_result",
			toolCallId: "call-1",
			result: { ok: true },
			status: "complete",
			durationMs: 5,
		});
		t.apply({
			type: "tool_result",
			toolCallId: "call-1",
			result: { ok: false },
			status: "error",
			error: "boom",
		});

		expect(events.map((event) => event.type)).toEqual([
			EventType.TOOL_CALL_START,
			EventType.TOOL_CALL_ARGS,
			EventType.TOOL_CALL_END,
			EventType.TOOL_CALL_RESULT,
			EventType.TOOL_CALL_RESULT,
		]);
		expect(events[1]).toMatchObject({
			delta: JSON.stringify({ url: "https://example.com" }),
		});
		expect(events[3]).toMatchObject({
			messageId: "call-1:result",
			role: "tool",
			content: JSON.stringify({ ok: true }),
			metadata: { fabric: { status: "complete", durationMs: 5 } },
		});
		expect(events[4]).toMatchObject({
			metadata: { fabric: { status: "error", error: "boom" } },
		});
		expectValid(events);
	});

	it("carries a tool event without an id whole", () => {
		const { t, events } = translator();
		const event = { type: "tool_start" as const, toolName: "unnamed" };
		t.apply(event);
		expect(events).toEqual([
			{
				type: EventType.CUSTOM,
				name: ORCHESTRATOR_RUN_EVENT.event,
				value: event,
			},
		]);
	});

	it("replaces agent state for phase, routing, plan, step and progress", () => {
		const { t, events } = translator();
		const plan = {
			id: "plan-1",
			description: "Plan",
			riskLevel: "low" as const,
			steps: [{ id: "step-1", description: "One", order: 1 }],
		};
		t.apply({ type: "phase", phase: "planning", message: "Planning" });
		t.apply({
			type: "routing",
			primaryAgent: "task_planner",
			agentName: "Planner",
			confidence: 0.9,
		});
		t.apply({ type: "planning", plan });
		t.apply({
			type: "step_start",
			stepId: "step-1",
			description: "One",
			order: 1,
		});
		t.apply({ type: "progress", completedSteps: 0, totalSteps: 1 });

		expect(
			events.map((event) =>
				event.type === EventType.STATE_DELTA ? event.delta : event.type,
			),
		).toEqual([
			[
				{
					op: "replace",
					path: "/phase",
					value: { phase: "planning", message: "Planning" },
				},
			],
			[
				{
					op: "replace",
					path: "/routing",
					value: {
						primaryAgent: "task_planner",
						agentName: "Planner",
						confidence: 0.9,
					},
				},
			],
			[{ op: "replace", path: "/plan", value: { plan } }],
			[
				{
					op: "replace",
					path: "/currentStep",
					value: { stepId: "step-1", description: "One", order: 1 },
				},
			],
			[
				{
					op: "replace",
					path: "/progress",
					value: { completedSteps: 0, totalSteps: 1 },
				},
			],
		]);
		expect(t.facts.routing?.primaryAgent).toBe("task_planner");
		expect(t.facts.plan?.id).toBe("plan-1");
		expectValid(events);
	});

	it("carries completed steps whole and marks the plan's step", () => {
		const { t, events } = translator();
		t.apply({
			type: "planning",
			plan: {
				id: "plan-1",
				description: "Plan",
				riskLevel: "low",
				steps: [{ id: "step-1", description: "One", order: 1 }],
			},
		});
		const step = {
			type: "step_complete" as const,
			stepId: "step-1",
			stepDescription: "One",
			status: "error" as const,
			response: "Failed",
		};
		t.apply(step);

		expect(events.at(-1)).toEqual({
			type: EventType.CUSTOM,
			name: ORCHESTRATOR_RUN_EVENT.event,
			value: step,
		});
		expect(t.facts.steps.get("step-1")).toEqual(step);
		expect(t.facts.plan?.steps[0]?.status).toBe("error");
	});

	it("ends the run as an approval interrupt, closing what is open, and drops what follows", () => {
		const { t, events } = translator();
		t.apply({ type: "text_delta", content: "Working" });
		t.apply({
			type: "tool_start",
			toolCallId: "call-1",
			toolName: "write",
		});
		const approval = {
			type: "approval_required" as const,
			approvalId: "approval-1",
			stepId: "step-1",
			reason: "Writes to the repository",
		};
		t.apply(approval);
		t.apply({ type: "progress", completedSteps: 1 });
		t.apply({ type: "text_delta", content: "late" });

		expect(events.map((event) => event.type)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TOOL_CALL_START,
			EventType.TEXT_MESSAGE_END,
			EventType.TOOL_CALL_END,
			EventType.RUN_FINISHED,
		]);
		expect(events.at(-1)).toMatchObject({
			threadId: "thread-1",
			runId: "run-0001",
			outcome: {
				type: "interrupt",
				interrupts: [
					{
						id: "approval-1",
						reason: "orchestrator_approval",
						message: "Writes to the repository",
						metadata: { fabric: approval },
					},
				],
			},
		});
		expect(t.stopped).toBe(true);
		expectValid(events);
	});

	it("ends the run as a clarification interrupt", () => {
		const { t, events } = translator();
		const question = {
			type: "clarifying_question" as const,
			clarificationId: "clarification-1",
			question: "Which repository?",
			options: ["web", "api"],
		};
		t.apply(question);
		expect(events).toEqual([
			{
				type: EventType.RUN_FINISHED,
				threadId: "thread-1",
				runId: "run-0001",
				outcome: {
					type: "interrupt",
					interrupts: [
						{
							id: "clarification-1",
							reason: "orchestrator_clarification",
							message: "Which repository?",
							metadata: { fabric: question },
						},
					],
				},
			},
		]);
		expectValid(events);
	});

	it("never raises again the interrupt this run just answered", () => {
		const { t, events } = translator(new Set(["approval-1"]));
		t.apply({
			type: "approval_required",
			approvalId: "approval-1",
			stepId: "step-1",
			reason: "Writes",
		});
		t.apply({ type: "approval_resolved", approvalId: "approval-1" });
		expect(t.stopped).toBe(false);
		expect(events).toEqual([
			{
				type: EventType.CUSTOM,
				name: ORCHESTRATOR_RUN_EVENT.event,
				value: { type: "approval_resolved", approvalId: "approval-1" },
			},
		]);
	});

	it("holds the turn's end until finish, then sends it as the run's end", () => {
		const { t, events } = translator();
		t.apply({ type: "text_delta", content: "Done" });
		const completed = {
			type: "completed" as const,
			status: "completed",
			response: "Done",
			stepResults: [],
			toolCalls: [],
		};
		t.apply(completed);
		expect(events.map((event) => event.type)).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
		]);
		expect(t.terminal).toBe(completed);

		t.finish(completed);
		const { type: _type, ...result } = completed;
		expect(events.slice(2)).toEqual([
			{
				type: EventType.TEXT_MESSAGE_END,
				messageId: `${KEY}:text:1:nonce`,
			},
			{
				type: EventType.RUN_FINISHED,
				threadId: "thread-1",
				runId: "run-0001",
				result,
				outcome: { type: "success" },
			},
		]);
		expectValid(events);
	});

	it("ends a stopped turn as cancelled, with its result", () => {
		const { t, events } = translator();
		t.finish({ type: "completed", status: "cancelled", response: "" });
		expect(events).toEqual([
			{
				type: EventType.RUN_FINISHED,
				threadId: "thread-1",
				runId: "run-0001",
				result: { status: "cancelled", response: "" },
				outcome: { type: "cancelled" },
			},
		]);
	});

	it("ends a failed turn as the run's error, with the route's fields", () => {
		const { t, events } = translator();
		t.finish({
			type: "error",
			message: "Usage limit reached",
			code: "AI_USAGE_LIMIT_EXCEEDED",
			data: { limit: 10 },
		});
		expect(events).toEqual([
			{
				type: EventType.RUN_ERROR,
				message: "Usage limit reached",
				code: "AI_USAGE_LIMIT_EXCEEDED",
				metadata: {
					fabric: {
						type: "error",
						message: "Usage limit reached",
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: { limit: 10 },
					},
				},
			},
		]);
		expectValid(events);
	});
});
