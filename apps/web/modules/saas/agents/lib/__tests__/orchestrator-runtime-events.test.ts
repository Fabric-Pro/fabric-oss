/**
 * The runtime's AG-UI events for an Orchestrator turn read back as the
 * stream route's events (`orchestrator-runtime-protocol.ts`), so the chat
 * applies both transports with one reducer.
 */

import { type AGUIEvent, EventType } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import {
	readOrchestratorRuntimeEvent,
	savedOrchestratorAnswerEvent,
} from "../orchestrator-runtime-events";

const read = (event: AGUIEvent) => readOrchestratorRuntimeEvent(event);

describe("readOrchestratorRuntimeEvent", () => {
	it("reads a text segment's start as text_start and its content as text_delta", () => {
		expect(
			read({
				type: EventType.TEXT_MESSAGE_START,
				messageId: "m",
				role: "assistant",
			}),
		).toEqual([{ kind: "event", event: { type: "text_start" } }]);
		expect(
			read({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "m",
				delta: "Hi",
			}),
		).toEqual([
			{ kind: "event", event: { type: "text_delta", content: "Hi" } },
		]);
	});

	it("reads tool calls with the fields the run carried in metadata", () => {
		expect(
			read({
				type: EventType.TOOL_CALL_START,
				toolCallId: "t1",
				toolCallName: "search",
				metadata: { fabric: { toolName: "search", stepId: "s1" } },
			}),
		).toEqual([
			{
				kind: "event",
				event: expect.objectContaining({
					type: "tool_start",
					toolCallId: "t1",
					toolName: "search",
				}),
			},
		]);
		expect(
			read({
				type: EventType.TOOL_CALL_RESULT,
				messageId: "r1",
				toolCallId: "t1",
				content: JSON.stringify({ hits: 2 }),
				metadata: { fabric: { toolName: "search" } },
			}),
		).toEqual([
			{
				kind: "event",
				event: expect.objectContaining({
					type: "tool_result",
					toolCallId: "t1",
					result: { hits: 2 },
				}),
			},
		]);
	});

	it("reads a state replacement back as the event its path names", () => {
		expect(
			read({
				type: EventType.STATE_DELTA,
				delta: [
					{
						op: "replace",
						path: "/phase",
						value: { phase: "planning" },
					},
					{ op: "replace", path: "/unknown", value: { x: 1 } },
				],
			}),
		).toEqual([
			{ kind: "event", event: { type: "phase", phase: "planning" } },
		]);
	});

	it("reads the execution handshake as the stream route's started", () => {
		expect(
			read({
				type: EventType.CUSTOM,
				name: "fabric.execution",
				value: {
					executionId: "orch-1",
					turnId: "turn-1",
					turnGeneration: 2,
					resumed: true,
				},
			}),
		).toEqual([
			{
				kind: "event",
				event: {
					type: "started",
					executionId: "orch-1",
					workflowId: "orch-1",
					resumed: true,
					turnId: "turn-1",
					turnGeneration: 2,
				},
			},
		]);
	});

	it("reads the runtime's own signals", () => {
		const custom = (name: string) =>
			read({ type: EventType.CUSTOM, name, value: {} });
		expect(custom("fabric.reconnect")).toEqual([{ kind: "reconnect" }]);
		expect(custom("fabric.heartbeat")).toEqual([{ kind: "heartbeat" }]);
		expect(custom("fabric.orchestrator.follow-up")).toEqual([
			{ kind: "follow-up" },
		]);
		expect(custom("fabric.orchestrator.interrupt-stale")).toEqual([
			{ kind: "stale" },
		]);
		expect(custom("someone.else")).toEqual([]);
	});

	it("reads an interrupt as its event, then the interruption", () => {
		expect(
			read({
				type: EventType.RUN_FINISHED,
				threadId: "t",
				runId: "r",
				outcome: {
					type: "interrupt",
					interrupts: [
						{
							id: "approval-1",
							reason: "orchestrator_approval",
							metadata: {
								fabric: {
									type: "approval_required",
									approvalId: "approval-1",
									stepId: "s1",
									reason: "Writes",
								},
							},
						},
					],
				},
			}),
		).toEqual([
			{
				kind: "event",
				event: {
					type: "approval_required",
					approvalId: "approval-1",
					stepId: "s1",
					reason: "Writes",
				},
			},
			{ kind: "interrupted" },
		]);
	});

	it("reads a finished run as completed, and a run stopped before it started as cancelled", () => {
		expect(
			read({
				type: EventType.RUN_FINISHED,
				threadId: "t",
				runId: "r",
				result: { status: "completed", response: "Done" },
				outcome: { type: "success" },
			}),
		).toEqual([
			{
				kind: "event",
				event: {
					type: "completed",
					status: "completed",
					response: "Done",
				},
			},
			{ kind: "ended" },
		]);
		expect(
			read({
				type: EventType.RUN_FINISHED,
				threadId: "t",
				runId: "r",
				outcome: { type: "cancelled" },
			}),
		).toEqual([
			{
				kind: "event",
				event: expect.objectContaining({
					type: "completed",
					status: "cancelled",
					response: "",
				}),
			},
			{ kind: "ended" },
		]);
	});

	it("tells a turn that failed from a run that was refused", () => {
		expect(
			read({
				type: EventType.RUN_ERROR,
				message: "Workflow failed",
				metadata: {
					fabric: { type: "error", message: "Workflow failed" },
				},
			}),
		).toEqual([
			{
				kind: "event",
				event: { type: "error", message: "Workflow failed" },
			},
			{ kind: "ended" },
		]);
		expect(
			read({
				type: EventType.RUN_ERROR,
				message: "Limit",
				code: "AI_USAGE_LIMIT_EXCEEDED",
				metadata: {
					fabric: { status: 429, code: "AI_USAGE_LIMIT_EXCEEDED" },
				},
			}),
		).toEqual([
			{
				kind: "refused",
				code: "AI_USAGE_LIMIT_EXCEEDED",
				message: "Limit",
				status: 429,
				body: { status: 429, code: "AI_USAGE_LIMIT_EXCEEDED" },
			},
		]);
	});
});

describe("savedOrchestratorAnswerEvent", () => {
	const messages = [
		{ id: "key-1:user", role: "user" as const, content: "Q" },
		{
			id: "key-1:assistant",
			role: "assistant" as const,
			content: "Stopped half",
			metadata: {
				fabric: {
					streamStatus: "cancelled",
					metadata: { executionId: "orch-1" },
				},
			},
		},
	];

	it("finds the turn's saved answer by its key, with the status it ended in", () => {
		expect(
			savedOrchestratorAnswerEvent(messages, {
				turnKey: "key-1",
				executionId: null,
			}),
		).toEqual({
			type: "completed",
			status: "cancelled",
			response: "Stopped half",
		});
	});

	it("finds an attached turn's answer by its execution", () => {
		expect(
			savedOrchestratorAnswerEvent(messages, {
				turnKey: null,
				executionId: "orch-1",
			}),
		).toEqual(expect.objectContaining({ response: "Stopped half" }));
	});

	it("finds nothing for a turn that is not saved", () => {
		expect(
			savedOrchestratorAnswerEvent(messages, {
				turnKey: "key-2",
				executionId: "orch-2",
			}),
		).toBeNull();
	});
});
