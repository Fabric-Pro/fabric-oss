/**
 * Deep Research's runtime events as the chat's state: each AG-UI event the
 * deep-researcher engine sends lands where the stream route's chat
 * (`useWorkflowTemplateStream`) keeps the same thing, and says what the hook
 * must do besides (its effect).
 */

import { type AGUIEvent, EventType } from "@ag-ui/client";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => vi.fn(),
}));

import type { WorkflowTemplateState } from "../../hooks/useWorkflowTemplateStream";
import { useWorkflowTemplateStream } from "../../hooks/useWorkflowTemplateStream";
import { applyResearchRuntimeEvent } from "../research-runtime-events";
import { INITIAL_WORKFLOW_TEMPLATE_STATE } from "../workflow-template-state";

const THREAD = "thread-example-0001";
const RUN = "run-example-0001";
const EXECUTION = "wf-user-example-1-deep-researcher-example";

const SUB_AGENT = {
	subTaskId: "task-1",
	title: "Market size",
	status: "completed" as const,
	findings: "The market grew.",
	sources: ["https://example.com/market"],
	confidence: 80,
	duration: 1200,
};

const RESULT = {
	status: "completed",
	result: "The full research text.",
	summary: "A short summary.",
	keyFindings: [{ theme: "Growth", findings: ["It grew."], confidence: 80 }],
	sources: ["https://example.com/market"],
	subAgentResults: [SUB_AGENT],
	iterations: 2,
	goalAchieved: true,
	duration: 4200,
	structuredReport: {
		title: "Market research",
		executiveSummary: "The market grew.",
		sections: [
			{
				heading: "Growth",
				content: "It grew [1].",
				citations: [
					{
						source: "https://example.com/market",
						sourceType: "web" as const,
						sourceNumber: 1,
						relevance: 0.9,
					},
				],
			},
		],
		methodology: "Two sub-agents searched the web.",
		citedSources: [
			{
				source: "https://example.com/market",
				sourceType: "web" as const,
				sourceNumber: 1,
				relevance: 0.9,
			},
		],
	},
};

const running: WorkflowTemplateState = {
	...INITIAL_WORKFLOW_TEMPLATE_STATE,
	status: "running",
	phase: "executing_subagents",
};

function apply(state: WorkflowTemplateState, event: AGUIEvent) {
	return applyResearchRuntimeEvent(state, event);
}

const progress = {
	executionId: EXECUTION,
	phase: "awaiting_clarification",
	message: "Waiting for your answer",
	complexity: "medium",
	currentIteration: 1,
	maxIterations: 3,
	subAgentsTotal: 3,
	subAgentsCompleted: 1,
	subAgentsFailed: 1,
	goalAchieved: false,
	timestamp: "2026-01-05T10:00:00.000Z",
	clarificationPrompt: "Which market?",
	subTaskTitles: ["Size", "Competitors", "Pricing"],
};

describe("applyResearchRuntimeEvent — a run's events", () => {
	it("RUN_STARTED runs the chat, names the question and starts the response", () => {
		const update = apply(INITIAL_WORKFLOW_TEMPLATE_STATE, {
			type: EventType.RUN_STARTED,
			threadId: THREAD,
			runId: RUN,
			input: {
				threadId: THREAD,
				runId: RUN,
				messages: [
					{
						id: `${RUN}:user`,
						role: "user",
						content: "What changed?",
					},
				],
				tools: [],
				context: [],
			},
		});

		expect(update.state).toMatchObject({
			status: "running",
			phase: "initializing",
		});
		expect(update.query).toBe("What changed?");
		expect(update.effect).toEqual({
			kind: "started",
			threadId: THREAD,
			runId: RUN,
		});
		// A resume or reattach keeps the phase the run is in.
		expect(
			apply(running, {
				type: EventType.RUN_STARTED,
				threadId: THREAD,
				runId: RUN,
			}).state.phase,
		).toBe("executing_subagents");
	});

	it("a progress snapshot fills the phase, counts, iteration and question", () => {
		const update = apply(running, {
			type: EventType.STATE_SNAPSHOT,
			snapshot: { executionId: EXECUTION, progress },
		});

		expect(update.state).toMatchObject({
			executionId: EXECUTION,
			phase: "awaiting_clarification",
			message: "Waiting for your answer",
			complexity: "medium",
			progress: {
				subAgentsTotal: 3,
				subAgentsCompleted: 1,
				subAgentsFailed: 1,
				clarificationPrompt: "Which market?",
				subTaskTitles: ["Size", "Competitors", "Pricing"],
			},
			iteration: { current: 1, max: 3 },
		});
		expect(update.effect).toBeUndefined();
		expect(
			apply(running, {
				type: EventType.STATE_SNAPSHOT,
				snapshot: { executionId: EXECUTION, progress: null },
			}).state,
		).toEqual({ ...running, executionId: EXECUTION });
	});

	it("the execution, an accepted answer and the window's end", () => {
		expect(
			apply(running, {
				type: EventType.CUSTOM,
				name: "fabric.deep-researcher.execution",
				value: {
					executionId: EXECUTION,
					templateSlug: "deep-researcher",
				},
			}),
		).toEqual({
			state: { ...running, executionId: EXECUTION },
			effect: { kind: "execution", executionId: EXECUTION },
		});

		const waiting = {
			...running,
			progress: {
				...running.progress,
				clarificationPrompt: "Which market?",
			},
		};
		const accepted = apply(waiting, {
			type: EventType.CUSTOM,
			name: "fabric.deep-researcher.clarification-accepted",
			value: { interruptId: `${RUN}:clarification` },
		});
		expect(accepted.state.message).toBe(
			"Clarification received. Continuing research...",
		);
		expect(accepted.state.progress.clarificationPrompt).toBeUndefined();
		expect(accepted.effect).toEqual({ kind: "clarificationAccepted" });

		expect(
			apply(running, {
				type: EventType.CUSTOM,
				name: "fabric.reconnect",
				value: { executionId: EXECUTION, runId: RUN },
			}),
		).toEqual({ state: running, effect: { kind: "reconnect" } });
	});

	it("upserts sub-agents by sub-task, so a replay adds none twice", () => {
		const finished: AGUIEvent = {
			type: EventType.SUBAGENT_FINISHED,
			subagentRunId: `${EXECUTION}:task-1`,
			result: SUB_AGENT,
			outcome: { type: "success" },
		};
		const once = apply(running, finished).state;
		const twice = apply(once, finished).state;
		const failedResult = {
			...SUB_AGENT,
			subTaskId: "task-2",
			status: "failed" as const,
			findings: "",
			error: "The search failed",
		};
		const failed = apply(twice, {
			type: EventType.SUBAGENT_ERROR,
			subagentRunId: `${EXECUTION}:task-2`,
			message: "The search failed",
			code: "SUBAGENT_FAILED",
			metadata: { fabric: { result: failedResult } },
		}).state;

		expect(once.subAgentResults).toEqual([SUB_AGENT]);
		expect(twice.subAgentResults).toEqual([SUB_AGENT]);
		expect(failed.subAgentResults).toEqual([SUB_AGENT, failedResult]);
	});

	it("ignores sub-agent starts and text", () => {
		for (const event of [
			{
				type: EventType.SUBAGENT_STARTED,
				subagentRunId: `${EXECUTION}:task-1`,
				name: "Market size",
			},
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: `${RUN}:assistant`,
				role: "assistant",
			},
			{
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${RUN}:assistant`,
				delta: "# Report",
			},
			{ type: EventType.TEXT_MESSAGE_END, messageId: `${RUN}:assistant` },
		] satisfies AGUIEvent[]) {
			expect(apply(running, event)).toEqual({ state: running });
		}
	});
});

describe("applyResearchRuntimeEvent — how a response ends", () => {
	it("RUN_FINISHED success completes the run with the result view", () => {
		const update = apply(running, {
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
			outcome: { type: "success" },
			result: RESULT,
		});

		expect(update.state).toMatchObject({
			status: "completed",
			phase: "completed",
			result: {
				text: RESULT.result,
				summary: RESULT.summary,
				iterations: 2,
				goalAchieved: true,
			},
			subAgentResults: [SUB_AGENT],
		});
		expect(update.effect).toEqual({ kind: "finished" });
	});

	it("RUN_FINISHED interrupt leaves the run running and asks the question", () => {
		const update = apply(running, {
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
			outcome: {
				type: "interrupt",
				interrupts: [
					{
						id: `${RUN}:clarification`,
						reason: "research_clarification",
						message: "Which market?",
						expiresAt: "2026-01-05T10:05:00.000Z",
					},
				],
			},
		});

		expect(update.state).toBe(running);
		expect(update.effect).toEqual({
			kind: "interrupt",
			interruptId: `${RUN}:clarification`,
			message: "Which market?",
			expiresAt: "2026-01-05T10:05:00.000Z",
		});
	});

	it("RUN_FINISHED cancelled shows the route's text, unless the person stopped it here", () => {
		const cancelled: AGUIEvent = {
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
			outcome: { type: "cancelled" },
		};
		expect(apply(running, cancelled)).toEqual({
			state: {
				...running,
				status: "cancelled",
				phase: "cancelled",
				error: "Workflow was cancelled",
			},
			effect: { kind: "finished" },
		});

		const stoppedHere = {
			...running,
			status: "cancelled" as const,
			phase: "cancelled" as const,
		};
		expect(apply(stoppedHere, cancelled).state).toBe(stoppedHere);
	});

	it("a usage-limit RUN_ERROR returns the chat to idle and hands over the limit", () => {
		const data = {
			limitId: "limit-example",
			dimension: "TOKENS",
			window: "DAILY",
			used: "10",
			max: "5",
			manageLimitsUrl: "",
		};
		const update = apply(running, {
			type: EventType.RUN_ERROR,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			message: "AI usage limit exceeded",
			metadata: { fabric: { code: "AI_USAGE_LIMIT_EXCEEDED", data } },
		});

		expect(update.state).toMatchObject({
			status: "idle",
			phase: "idle",
			error: null,
		});
		expect(update.effect).toEqual({ kind: "usageLimit", payload: data });
	});

	it("any other RUN_ERROR fails the run with its message", () => {
		expect(
			apply(running, {
				type: EventType.RUN_ERROR,
				code: "RESEARCH_FAILED",
				message: "The planner failed",
			}),
		).toEqual({
			state: {
				...running,
				status: "failed",
				phase: "failed",
				error: "The planner failed",
			},
			effect: {
				kind: "error",
				code: "RESEARCH_FAILED",
				message: "The planner failed",
			},
		});
	});
});

describe("applyResearchRuntimeEvent — a saved run", () => {
	const snapshot = (research: unknown): AGUIEvent => ({
		type: EventType.MESSAGES_SNAPSHOT,
		messages: [
			{ id: "earlier:user", role: "user", content: "Earlier question" },
			{ id: `${RUN}:user`, role: "user", content: "What changed?" },
			{
				id: `${RUN}:assistant`,
				role: "assistant",
				content: "The report",
				metadata: { fabric: { metadata: { research } } },
			},
		],
	});

	it("adopts a completed, failed or cancelled record with the question before it", () => {
		const completed = apply(
			INITIAL_WORKFLOW_TEMPLATE_STATE,
			snapshot({
				status: "completed",
				executionId: EXECUTION,
				result: RESULT,
			}),
		);
		expect(completed.query).toBe("What changed?");
		expect(completed.effect).toEqual({ kind: "restored" });
		expect(completed.state).toMatchObject({
			executionId: EXECUTION,
			status: "completed",
			result: { text: RESULT.result },
			subAgentResults: [SUB_AGENT],
		});

		expect(
			apply(
				INITIAL_WORKFLOW_TEMPLATE_STATE,
				snapshot({
					status: "failed",
					executionId: EXECUTION,
					error: "The planner failed",
				}),
			).state,
		).toMatchObject({ status: "failed", error: "The planner failed" });

		expect(
			apply(
				INITIAL_WORKFLOW_TEMPLATE_STATE,
				snapshot({ status: "cancelled", executionId: EXECUTION }),
			).state,
		).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			error: null,
		});
	});

	it("ignores a snapshot without a valid record", () => {
		expect(apply(running, snapshot(undefined))).toEqual({ state: running });
		expect(
			apply(
				running,
				snapshot({ status: "running", executionId: EXECUTION }),
			),
		).toEqual({ state: running });
	});
});

describe("the completed result, on both transports", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("matches the stream route chat's reading of its completed event", async () => {
		vi.spyOn(global, "fetch").mockImplementation(
			async () =>
				new Response(
					[
						{
							type: "started",
							executionId: EXECUTION,
							workflowId: EXECUTION,
							templateSlug: "deep-researcher",
						},
						{ type: "completed", ...RESULT },
					]
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join(""),
					{
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					},
				),
		);
		const { result } = renderHook(() =>
			useWorkflowTemplateStream({ templateSlug: "deep-researcher" }),
		);
		await act(async () => {
			await result.current.sendQuery("What changed?");
		});

		const runtime = apply(running, {
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
			outcome: { type: "success" },
			result: RESULT,
		}).state;

		expect(result.current.state.status).toBe("completed");
		expect(runtime.result).toEqual(result.current.state.result);
		expect(runtime.subAgentResults).toEqual(
			result.current.state.subAgentResults,
		);
	});
});
