/**
 * The chat's reading of a multi-agent run (`multi-agent-runtime-events.ts`)
 * and its view of the turn (`multi-agent-turn.ts`), each agent's answer
 * built as Nexus builds it (`AgentResponse`):
 *
 *   - each agent's attributed events land on that agent only: its text
 *     (a new segment replaces it; a tool starts a new paragraph), its tools
 *     merged as they stream (ids without the agent prefix, arguments,
 *     results and MCP App fields kept);
 *   - an agent's approval becomes its approval card, with the scoped
 *     interrupt id the resume must send; a resolution clears it;
 *   - SUBAGENT_FINISHED / SUBAGENT_ERROR end one agent (tool calls that
 *     arrive only at the end are merged; the usage limit leaves it idle);
 *     RUN_FINISHED with the final record ends the turn;
 *   - a stop marks every agent still answering as stopped, and nothing it
 *     sends after changes that;
 *   - a saved record reads back as the same view (with its tool calls), as
 *     labelled history, and as the picker's picks.
 */
import { type AGUIEvent, EventType } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import { readMultiAgentRuntimeEvent } from "../multi-agent-runtime-events";
import type { MultiAgentTurnRecord } from "../multi-agent-runtime-protocol";
import {
	applyMultiAgentSignal,
	type MultiAgentTurnView,
	multiAgentExecutionFields,
	multiAgentPicks,
	multiAgentViewFromRecord,
	pendingMultiAgentTurn,
	stopMultiAgentTurn,
} from "../multi-agent-turn";

const KEY = "ma_run-example-0001";
const SECOND = `${KEY}_a1`;

function apply(view: MultiAgentTurnView, events: AGUIEvent[]) {
	return events
		.flatMap((event) => readMultiAgentRuntimeEvent(event))
		.reduce(applyMultiAgentSignal, view);
}

const pending = () =>
	pendingMultiAgentTurn(KEY, "Compare the plans", [
		{ agentId: "model:alpha", name: "Alpha" },
		{ agentId: "model:beta", name: "Beta", vendor: "Example" },
	]);

const record: MultiAgentTurnRecord = {
	version: 1,
	final: true,
	agents: [
		{
			index: 0,
			agentId: "model:alpha",
			name: "Alpha",
			memberKey: KEY,
			executionId: `orch-${KEY}`,
			turnId: "turn-0",
			status: "complete",
			answer: "Plan A",
			record: {
				stepResults: [
					{
						stepId: "execution",
						toolCalls: [
							{
								id: "call-9",
								name: "create_view",
								args: { elements: [] },
								result: { checkpointId: "cp-1" },
								status: "success",
								mcpAppResourceUri: "ui://excalidraw/view",
								mcpAppConfigId: "mcp-1",
							},
						],
					},
				],
			},
		},
		{
			index: 1,
			agentId: "model:beta",
			name: "Beta",
			memberKey: SECOND,
			executionId: `orch-${SECOND}`,
			turnId: "turn-1",
			status: "error",
			error: "Workflow execution failed",
		},
	],
};

const text = (memberKey: string, segment: number, delta: string) => [
	{
		type: EventType.TEXT_MESSAGE_START,
		messageId: `${memberKey}:text:${segment}:n`,
		role: "assistant",
		subagentRunId: memberKey,
	} as const,
	{
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: `${memberKey}:text:${segment}:n`,
		delta,
		subagentRunId: memberKey,
	} as const,
];

describe("a multi-agent run, read by the chat", () => {
	it("keeps each agent's text and tools to that agent, merged as Nexus merges them", () => {
		const view = apply(pending(), [
			{ type: EventType.RUN_STARTED, threadId: "t", runId: KEY },
			{
				type: EventType.CUSTOM,
				name: "fabric.execution",
				value: { executionId: `orch-${KEY}` },
			},
			...text(KEY, 1, "Draft"),
			...text(KEY, 2, "Plan A"),
			{
				type: EventType.TOOL_CALL_START,
				toolCallId: `${SECOND}:call-1`,
				toolCallName: "create_view",
				metadata: {
					fabric: {
						toolName: "create_view",
						serverName: "Excalidraw",
						mcpAppResourceUri: "ui://excalidraw/view",
						mcpAppConfigId: "mcp-1",
					},
				},
				subagentRunId: SECOND,
			},
			{
				type: EventType.TOOL_CALL_ARGS,
				toolCallId: `${SECOND}:call-1`,
				delta: JSON.stringify({ elements: [1] }),
				metadata: { fabric: { toolName: "create_view" } },
				subagentRunId: SECOND,
			},
			{
				type: EventType.TOOL_CALL_RESULT,
				messageId: `${SECOND}:call-1:result`,
				toolCallId: `${SECOND}:call-1`,
				role: "tool",
				content: JSON.stringify({ checkpointId: "cp-1" }),
				metadata: { fabric: { toolName: "create_view" } },
				subagentRunId: SECOND,
			},
		]);

		expect(view.executionId).toBe(`orch-${KEY}`);
		expect(view.agents[0]).toMatchObject({
			agentName: "Alpha",
			content: "Plan A",
			toolCalls: [],
			isLoading: true,
		});
		expect(view.agents[1]).toMatchObject({
			agentName: "Beta",
			vendor: "Example",
			content: "",
			toolCalls: [
				{
					id: "call-1",
					name: "create_view",
					args: { elements: [1] },
					result: { checkpointId: "cp-1" },
					serverName: "Excalidraw",
					status: "complete",
					mcpAppResourceUri: "ui://excalidraw/view",
					mcpAppConfigId: "mcp-1",
				},
			],
		});
	});

	it("starts a new paragraph when text resumes after a tool", () => {
		const view = apply(pending(), [
			...text(KEY, 1, "Looking it up."),
			{
				type: EventType.TOOL_CALL_START,
				toolCallId: `${KEY}:call-1`,
				toolCallName: "search",
				metadata: { fabric: { toolName: "search" } },
				subagentRunId: KEY,
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${KEY}:text:1:n`,
				delta: "Found it.",
				subagentRunId: KEY,
			},
		]);

		expect(view.agents[0]?.content).toBe("Looking it up.\n\nFound it.");
	});

	it("shows only the asking agent's approval card, with the id its answer sends", () => {
		const interrupt = {
			id: `${SECOND}:approval-1`,
			reason: "orchestrator_approval",
			message: "Send the email?",
			subagentRunId: SECOND,
			metadata: {
				fabric: { type: "approval_required", stepId: "step-2" },
			},
		};
		const waiting = apply(pending(), [
			{
				type: EventType.CUSTOM,
				name: "fabric.multi-agent.interrupt",
				value: { interrupts: [interrupt] },
				subagentRunId: SECOND,
			},
			{
				type: EventType.SUBAGENT_FINISHED,
				subagentRunId: SECOND,
				outcome: { type: "suspended", interruptIds: [interrupt.id] },
			},
			{
				type: EventType.RUN_FINISHED,
				threadId: "t",
				runId: KEY,
				outcome: { type: "interrupt", interrupts: [interrupt] },
			},
		]);

		expect(waiting.status).toBe("waiting");
		expect(waiting.agents[0]?.pendingApproval).toBeNull();
		expect(waiting.agents[1]).toMatchObject({
			isLoading: true,
			pendingApproval: {
				approvalId: `${SECOND}:approval-1`,
				stepId: "step-2",
				reason: "Send the email?",
			},
		});

		const resolved = apply(waiting, [
			{
				type: EventType.CUSTOM,
				name: "fabric.multi-agent.interrupt-resolved",
				value: { subagentRunId: SECOND, event: {} },
			},
		]);
		expect(resolved.agents[1]).toMatchObject({
			pendingApproval: null,
			interrupts: [],
		});
	});

	it("ends each agent, then the turn with the saved answers", () => {
		const ended = apply(pending(), [
			{
				type: EventType.SUBAGENT_FINISHED,
				subagentRunId: KEY,
				result: {
					status: "completed",
					response: "Plan A",
					toolCalls: [
						{
							id: "cta-1",
							name: "fabric_default_mcp_status",
							result: { kind: "connection_needed" },
							status: "success",
						},
					],
				},
				outcome: { type: "success" },
			},
			{
				type: EventType.SUBAGENT_ERROR,
				subagentRunId: SECOND,
				message: "Workflow execution failed",
			},
		]);
		expect(ended.agents.map((agent) => agent.status)).toEqual([
			"completed",
			"error",
		]);
		expect(ended.agents[0]).toMatchObject({
			isLoading: false,
			content: "Plan A",
			toolCalls: [
				{
					id: "cta-1",
					name: "fabric_default_mcp_status",
					result: { kind: "connection_needed" },
					status: "complete",
				},
			],
		});
		expect(ended.agents[1]).toMatchObject({
			isError: true,
			errorMessage: "Workflow execution failed",
		});
		expect(ended.status).toBe("running");

		const final = apply(ended, [
			{
				type: EventType.RUN_FINISHED,
				threadId: "t",
				runId: KEY,
				result: { multiAgent: record },
				outcome: { type: "success" },
			},
		]);
		expect(final.status).toBe("ended");
		expect(final.agents[0]?.content).toBe("Plan A");
		expect(final.agents[0]?.toolCalls.map((tc) => tc.id)).toEqual([
			"cta-1",
			"call-9",
		]);
		expect(final.agents[1]?.status).toBe("error");
	});

	it("leaves an agent the usage limit stopped idle, not failed", () => {
		const ended = apply(pending(), [
			{
				type: EventType.SUBAGENT_ERROR,
				subagentRunId: SECOND,
				message: "AI usage limit reached",
				code: "AI_USAGE_LIMIT_EXCEEDED",
				metadata: {
					fabric: {
						type: "error",
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: { scope: "organization" },
					},
				},
			},
		]);

		expect(ended.agents[1]).toMatchObject({
			status: "idle",
			isLoading: false,
			isError: false,
		});
	});

	it("keeps a stopped agent stopped, whatever it sends after", () => {
		const answered = apply(pending(), [
			{
				type: EventType.SUBAGENT_FINISHED,
				subagentRunId: KEY,
				result: { status: "completed", response: "Plan A" },
				outcome: { type: "success" },
			},
			...text(SECOND, 1, "Part"),
		]);
		const stopped = stopMultiAgentTurn(
			answered,
			"2026-10-30T10:00:00.000Z",
		);

		expect(stopped.agents.map((agent) => agent.status)).toEqual([
			"completed",
			"cancelled",
		]);
		expect(stopped.agents[1]).toMatchObject({
			isLoading: false,
			cancelledAt: "2026-10-30T10:00:00.000Z",
			content: "Part",
		});

		const after = apply(stopped, [
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${SECOND}:text:1:n`,
				delta: " more",
				subagentRunId: SECOND,
			},
			{
				type: EventType.SUBAGENT_FINISHED,
				subagentRunId: SECOND,
				result: { status: "cancelled", response: "Part more" },
				outcome: { type: "success" },
			},
		]);
		expect(after.agents[1]).toMatchObject({
			status: "cancelled",
			cancelledAt: "2026-10-30T10:00:00.000Z",
			isLoading: false,
		});
	});

	it("reads a saved record back as the view, as labelled history and as picks", () => {
		expect(
			multiAgentViewFromRecord(record, "Compare the plans"),
		).toMatchObject({
			turnKey: KEY,
			status: "ended",
			agents: [
				{
					agentName: "Alpha",
					status: "completed",
					content: "Plan A",
					toolCalls: [
						{
							id: "call-9",
							mcpAppResourceUri: "ui://excalidraw/view",
							status: "complete",
						},
					],
				},
				{
					agentName: "Beta",
					status: "error",
					errorMessage: "Workflow execution failed",
				},
			],
		});
		expect(multiAgentExecutionFields({ multiAgent: record })).toEqual({
			multiAgent: record,
			response: "[Alpha]\nPlan A",
		});
		expect(
			multiAgentExecutionFields({ multiAgent: { version: 2 } }),
		).toEqual({});
		expect(multiAgentPicks(record)).toEqual([
			{
				agentId: "model:alpha",
				name: "Alpha",
				vendor: undefined,
				modelOverride: "alpha",
			},
			{
				agentId: "model:beta",
				name: "Beta",
				vendor: undefined,
				modelOverride: "beta",
			},
		]);
	});

	it("restores a plan model as this chat's pick and an agent by its id", () => {
		expect(
			multiAgentPicks({
				...record,
				agents: [
					{
						...record.agents[0],
						agentId: "plan-model:gamma",
						name: "Gamma",
						vendor: "OpenAI",
					},
					{
						...record.agents[1],
						agentId: "template-instance:one",
						name: "Researcher",
					},
				],
			}),
		).toEqual([
			{
				agentId: "plan-model:gamma",
				name: "Gamma",
				vendor: "OpenAI",
				modelOverride: "chatgpt-plan:gamma",
				chatOnly: true,
			},
			{
				agentId: "template-instance:one",
				name: "Researcher",
				vendor: undefined,
			},
		]);
	});
});
