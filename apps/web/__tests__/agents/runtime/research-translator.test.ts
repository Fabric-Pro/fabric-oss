// @vitest-environment node
/**
 * ResearchRunTranslator: one response's AG-UI events for a Deep Research run,
 * from the workflow's cumulative progress, sub-agent results and output.
 * Every event it emits is checked against AG-UI's event schemas.
 */
import { type AGUIEvent, type BaseEvent, EventType } from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import { researchProgressSchema } from "@saas/agents/lib/research-runtime-protocol";
import {
	RESEARCH_PHASES,
	RESEARCH_PROGRESS_MAPPING,
	RESEARCH_RESULT_MAPPING,
	ResearchRunTranslator,
} from "@saas/agents/runtime/research-translator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	awaitingClarification,
	CLARIFICATION_PROMPT,
	PROGRESS_TIME,
	researchOutput,
	researchProgress,
	SUB_AGENT_DONE,
	SUB_AGENT_FAILED,
	SUB_AGENT_TIMED_OUT,
	USAGE_LIMIT_MESSAGE,
} from "./_helpers/research-fixtures";

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

const THREAD = "thread-example-0001";
const RUN = "run-example-0002";
const KEY = "run-example-0001";
const EXECUTION = "wf-user-example-1-deep-researcher-example";

let emitted: AGUIEvent[] = [];

function isAguiEvent(event: BaseEvent): event is AGUIEvent {
	return EventSchemas.safeParse(event).success;
}

function translator(answered?: ReadonlySet<string>) {
	return new ResearchRunTranslator({
		threadId: THREAD,
		runId: RUN,
		key: KEY,
		executionId: EXECUTION,
		emit: (event) => {
			expect(isAguiEvent(event)).toBe(true);
			emitted.push(event);
		},
		answered,
	});
}

const types = () => emitted.map((event) => event.type);

beforeEach(() => {
	emitted = [];
});

describe("ResearchRunTranslator — progress", () => {
	it("sends a snapshot only when something but the timestamp changed", () => {
		const t = translator();

		expect(t.progress(researchProgress())).toBe("following");
		t.progress(researchProgress({ timestamp: "2026-01-05T10:00:05.000Z" }));
		t.progress(researchProgress({ subAgentsCompleted: 1 }));

		expect(types()).toEqual([
			EventType.STATE_SNAPSHOT,
			EventType.STATE_SNAPSHOT,
		]);
		expect(emitted[1]).toMatchObject({
			snapshot: {
				executionId: EXECUTION,
				progress: { subAgentsCompleted: 1 },
			},
		});
	});

	it("raises the clarifying question as an interrupt that ends the response", () => {
		const t = translator();

		expect(t.progress(awaitingClarification())).toBe("interrupted");

		expect(types()).toEqual([
			EventType.STATE_SNAPSHOT,
			EventType.RUN_FINISHED,
		]);
		expect(emitted[1]).toEqual({
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
			outcome: {
				type: "interrupt",
				interrupts: [
					{
						id: `${KEY}:clarification`,
						reason: "research_clarification",
						message: CLARIFICATION_PROMPT,
						expiresAt: new Date(
							Date.parse(PROGRESS_TIME) + 5 * 60_000,
						).toISOString(),
						responseSchema: {
							type: "object",
							properties: {
								response: { type: "string", minLength: 1 },
							},
							required: ["response"],
						},
					},
				],
			},
		});
	});

	it("raises no interrupt without a prompt, none and no snapshot once answered, and none for a stale prompt in a later phase", () => {
		expect(
			translator().progress(
				awaitingClarification({ clarificationPrompt: undefined }),
			),
		).toBe("following");
		expect(types()).toEqual([EventType.STATE_SNAPSHOT]);

		emitted = [];
		const answered = translator(new Set([`${KEY}:clarification`]));
		expect(answered.progress(awaitingClarification())).toBe("following");
		expect(emitted).toEqual([]);

		expect(
			translator().progress(
				researchProgress({
					phase: "decomposing",
					clarificationPrompt: CLARIFICATION_PROMPT,
				}),
			),
		).toBe("following");
		expect(types()).toEqual([EventType.STATE_SNAPSHOT]);
	});
});

describe("ResearchRunTranslator — sub-agents", () => {
	it("sends each sub-agent once: its findings as scoped text, then FINISHED or ERROR", () => {
		const t = translator();

		t.subAgents([SUB_AGENT_DONE]);
		t.subAgents([SUB_AGENT_DONE, SUB_AGENT_FAILED, SUB_AGENT_TIMED_OUT]);

		const done = `${EXECUTION}:task-1`;
		const timedOut = `${EXECUTION}:task-3`;
		expect(types()).toEqual([
			EventType.SUBAGENT_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.SUBAGENT_FINISHED,
			// The failed one has no findings: no text.
			EventType.SUBAGENT_STARTED,
			EventType.SUBAGENT_ERROR,
			EventType.SUBAGENT_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.SUBAGENT_ERROR,
		]);
		expect(emitted[0]).toMatchObject({
			subagentRunId: done,
			name: "Market size",
		});
		expect(emitted[2]).toMatchObject({
			messageId: `${done}:findings`,
			subagentRunId: done,
			delta: SUB_AGENT_DONE.findings,
		});
		expect(emitted[4]).toMatchObject({
			subagentRunId: done,
			result: SUB_AGENT_DONE,
			outcome: { type: "success" },
		});
		expect(emitted[6]).toMatchObject({
			subagentRunId: `${EXECUTION}:task-2`,
			code: "SUBAGENT_FAILED",
			message: "The search failed",
			metadata: { fabric: { result: SUB_AGENT_FAILED } },
		});
		expect(emitted[11]).toMatchObject({
			subagentRunId: timedOut,
			code: "SUBAGENT_TIMEOUT",
			metadata: { fabric: { result: SUB_AGENT_TIMED_OUT } },
		});
	});
});

describe("ResearchRunTranslator — the end", () => {
	it("a completed run sends the report, then RUN_FINISHED whose result is the stream route's completed fields", () => {
		const output = researchOutput();

		translator().finish({ kind: "completed", output });

		expect(types()).toEqual([
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		expect(emitted[0]).toMatchObject({ messageId: `${KEY}:assistant` });
		const content = emitted[1];
		expect(
			content?.type === EventType.TEXT_MESSAGE_CONTENT
				? content.delta
				: "",
		).toContain("Market research");
		// The stream route's `completed` event, without its `type`.
		const legacyCompleted = {
			status: output.status,
			result: output.result,
			summary: output.summary,
			keyFindings: output.keyFindings,
			sources: output.sources,
			subAgentResults: output.subAgentResults,
			iterations: output.iterations,
			goalAchieved: output.goalAchieved,
			duration: output.duration,
			structuredReport: output.structuredReport,
		};
		expect(emitted[3]).toEqual({
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
			outcome: { type: "success" },
			result: legacyCompleted,
		});
	});

	it("a cancelled run finishes cancelled, and a failed one is RESEARCH_FAILED", () => {
		translator().finish({ kind: "cancelled" });
		translator().finish({ kind: "failed", message: "The planner failed" });

		expect(emitted).toEqual([
			{
				type: EventType.RUN_FINISHED,
				threadId: THREAD,
				runId: RUN,
				outcome: { type: "cancelled" },
			},
			{
				type: EventType.RUN_ERROR,
				message: "The planner failed",
				code: "RESEARCH_FAILED",
				metadata: {
					fabric: { type: "error", message: "The planner failed" },
				},
			},
		]);
	});

	it("a run an activity's usage limit refused is AI_USAGE_LIMIT_EXCEEDED with the limit", () => {
		translator().finish({ kind: "failed", message: USAGE_LIMIT_MESSAGE });

		expect(emitted).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "AI_USAGE_LIMIT_EXCEEDED",
				message: USAGE_LIMIT_MESSAGE,
				metadata: {
					fabric: expect.objectContaining({
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: expect.objectContaining({
							limitId: "limit-example",
							dimension: "TOKENS",
							window: "DAILY",
							used: "10",
							max: "5",
						}),
					}),
				},
			}),
		]);
	});
});

describe("ResearchRunTranslator — mapping tables", () => {
	it("maps every output field, progress field and phase", () => {
		const outputKeys = Object.keys({
			...researchOutput(),
			error: "x",
			model: undefined,
			summaryModel: undefined,
			reportModel: undefined,
		}).sort();
		const progressKeys = Object.keys(
			researchProgress({
				clarificationPrompt: "x",
				subTaskTitles: [],
			}),
		).sort();

		expect(Object.keys(RESEARCH_RESULT_MAPPING).sort()).toEqual(outputKeys);
		expect(Object.keys(RESEARCH_PROGRESS_MAPPING).sort()).toEqual(
			progressKeys,
		);
		expect(Object.keys(RESEARCH_PHASES).sort()).toEqual(
			[...researchProgressSchema.shape.phase.options].sort(),
		);
		for (const where of [
			...Object.values(RESEARCH_RESULT_MAPPING),
			...Object.values(RESEARCH_PROGRESS_MAPPING),
		]) {
			expect(where.length).toBeGreaterThan(0);
		}
	});
});
