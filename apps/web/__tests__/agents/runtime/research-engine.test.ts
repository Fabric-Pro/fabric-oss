// @vitest-environment node
/**
 * The deep-researcher engine through FabricTemporalRunner, against the
 * in-memory turn table and fake Temporal (`_helpers/fake-direct-runtime`),
 * with the workflow-template run's admission and start faked and the run
 * record, follow, translator, thread and turn admission real:
 *
 *   - off for the organization, nothing is read or written;
 *   - a run's options and thread are checked before the stream route's
 *     checks, and those before anything is written;
 *   - a run is admitted, saved and started once, and every ending, an
 *     interrupt and a resume pass AG-UI's own event verification;
 *   - a run never settles another engine's live turn;
 *   - the clarifying question is answered once, with the route's checks;
 *   - stop records the cancel, signals the workflow, cancels it and audits,
 *     and never touches another engine's or another thread's turn.
 *
 * Every event the runner emits is checked against AG-UI's event schemas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventType } from "@ag-ui/client";
import { getTemplateWorkflow } from "@repo/database/src/workflow-templates";
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import {
	RESEARCH_CLARIFICATION_WINDOW_MS,
	RESEARCH_RUN_EVENT,
} from "@saas/agents/lib/research-runtime-protocol";
import {
	DIRECT_AGENT_ID,
	DirectEngine,
} from "@saas/agents/runtime/direct-engine";
import { FabricTemporalRunner } from "@saas/agents/runtime/fabric-temporal-runner";
import { RESEARCH_AGENT_ID } from "@saas/agents/runtime/research-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorld as w } from "./_helpers/fake-direct-runtime";
import {
	connect,
	DIRECT_ANSWER,
	EXECUTION_ID,
	engineFor,
	errorCode,
	errorOf,
	executionOf,
	FLAG,
	finishedOf,
	isEvent,
	isReconnect,
	liveRun,
	me,
	ORG,
	OTHER_THREAD,
	QUESTION,
	RUN_1,
	RUN_2,
	resume,
	run,
	runnerFor,
	savedMessages,
	seedConversation,
	seedLiveTurn,
	THREAD,
	turnByKey,
	types,
	USER,
	verified,
	workflowOf,
} from "./_helpers/research-engine-harness";
import {
	awaitingClarification,
	CLARIFICATION_PROMPT,
	researchOutput,
	researchProgress,
	SUB_AGENT_DONE,
	SUB_AGENT_FAILED,
} from "./_helpers/research-fixtures";

vi.mock(
	"@repo/database",
	async () =>
		(await import("./_helpers/fake-direct-runtime")).fakeWorld.database,
);
vi.mock(
	"@repo/temporal",
	async () =>
		(await import("./_helpers/fake-direct-runtime")).fakeWorld.temporal,
);
vi.mock(
	"@/app/api/agents/fabric-ai/stream/direct-turn",
	async () =>
		(await import("./_helpers/fake-direct-runtime")).fakeWorld.directTurn,
);
vi.mock(
	"@/app/api/agents/workflow-templates/workflow-template-run",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/app/api/agents/workflow-templates/workflow-template-run")
		>()),
		...(await import("./_helpers/fake-direct-runtime")).fakeWorld
			.researchRun,
	}),
);
vi.mock("@saas/agents/lib/server/chat-run-control", async () => {
	const { fakeWorld } = await import("./_helpers/fake-direct-runtime");
	class ChatRunAccessError extends Error {}
	return {
		ChatRunAccessError,
		recordChatRunControlAudit: vi.fn(),
		getAuthorizedChatRun: fakeWorld.authorizedChatRun(ChatRunAccessError),
	};
});
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));
vi.mock("@repo/ai/lib/chatgpt-plan/plan-spent-response", () => ({
	chatGptPlanApiBillingMarker: () => null,
}));
vi.mock(
	"@repo/api/modules/agents/procedures/conversations/update-conversation",
	() => ({ maybeStripReasoning: <T>(message: T) => message }),
);
vi.mock("@repo/api/orpc/procedures", () => ({
	authorizeInputOrganization: async () => undefined,
	Permissions: { AGENT_CREATE: "agent:create", AGENT_UPDATE: "agent:update" },
}));

const { recordChatRunControlAudit } = await import(
	"@saas/agents/lib/server/chat-run-control"
);

beforeEach(() => {
	w.reset(me);
	w.state.flags.add(FLAG);
	w.state.onStart = () => ({ status: "COMPLETED", result: researchOutput() });
	vi.mocked(recordChatRunControlAudit).mockClear();
});

describe("ResearchEngine — the flag", () => {
	it("with COPILOTKIT_RESEARCH_RUNS off, run, resume and connect end FEATURE_DISABLED, stop and isRunning are false, and nothing is read or written", async () => {
		seedConversation(me);
		const live = seedLiveTurn(RUN_1, "research");
		w.state.flags.clear();
		const reads = vi.spyOn(w.database.db.agentConversation, "findUnique");

		const ran = await run(RUN_2, QUESTION);
		const resumed = await resume(RUN_1, `${RUN_1}:clarification`, {
			response: "Europe",
		});
		const connected = await connect();

		for (const list of [ran, resumed, connected]) {
			expect(types(list)).toEqual([EventType.RUN_ERROR]);
			expect(errorCode(list)).toBe("FEATURE_DISABLED");
		}
		expect(await engineFor().stop(THREAD, RUN_1)).toBe(false);
		expect(await engineFor().stop(THREAD)).toBe(false);
		expect(await engineFor().isRunning(THREAD)).toBe(false);
		// The flag is read for the caller's organization, not globally.
		expect(w.state.flagChecks).toEqual(
			Array.from({ length: 6 }, () => ({
				flag: FLAG,
				organizationId: ORG,
			})),
		);
		expect(reads).not.toHaveBeenCalled();
		expect(w.state.calls).toEqual([]);
		expect(w.state.admittedBodies).toEqual([]);
		expect(w.state.turns).toEqual([live]);
		expect(live.status).toBe("ACTIVE");
		expect(w.state.starts).toEqual([]);
		expect(w.state.describes).toEqual([]);
		expect(w.state.signals).toEqual([]);
		expect(w.state.cancels).toEqual([]);
		expect(savedMessages()).toEqual([]);
		reads.mockRestore();
	});
});

describe("ResearchEngine — run validation and refusals", () => {
	it("refuses an invalid runId, forwardedProps with instanceId, organizationId or templateSlug, and maxSubAgents over 6 as INVALID_RUN_ID / INVALID_REQUEST, before any admission", async () => {
		expect(errorCode(await run("bad", QUESTION))).toBe("INVALID_RUN_ID");
		for (const forwardedProps of [
			{ instanceId: "instance-example-1" },
			{ organizationId: "org-example-2" },
			{ templateSlug: "another-template" },
			{ maxSubAgents: 7 },
		]) {
			const list = await run(RUN_1, QUESTION, {
				extra: { forwardedProps },
			});
			expect(errorCode(list)).toBe("INVALID_REQUEST");
		}
		expect(w.state.calls).toEqual([]);
		expect(w.state.conversations.size).toBe(0);
	});

	it("refuses a run without a user message (NO_MESSAGE)", async () => {
		expect(errorCode(await run(RUN_1, null))).toBe("NO_MESSAGE");
		expect(w.state.calls).toEqual([]);
	});

	it("refuses another person's thread (FORBIDDEN) with no admission, turn or start", async () => {
		seedConversation({ userId: "user-example-2", organizationId: ORG });

		expect(errorCode(await run(RUN_1, QUESTION))).toBe("FORBIDDEN");
		expect(w.state.calls).toEqual([]);
		expect(w.state.turns).toEqual([]);
		expect(w.state.starts).toEqual([]);
	});

	it("a membership refusal ends the run with FORBIDDEN, metadata.fabric.status 403, and leaves no conversation and no turn", async () => {
		w.state.refusal = () =>
			Response.json(
				{
					error: "You are not a member of this organization",
					code: "FORBIDDEN",
				},
				{ status: 403 },
			);

		const list = await run(RUN_1, QUESTION);

		expect(types(list)).toEqual([EventType.RUN_ERROR]);
		expect(errorOf(list)).toMatchObject({
			code: "FORBIDDEN",
			message: "You are not a member of this organization",
			metadata: { fabric: { status: 403 } },
		});
		expect(w.state.calls).toEqual(["admit"]);
		expect(w.state.conversations.size).toBe(0);
		expect(w.state.turns).toEqual([]);
		expect(w.state.starts).toEqual([]);
	});
});

describe("ResearchEngine — a run", () => {
	it("admits in order and starts once", async () => {
		const list = await run(RUN_1, QUESTION, {
			extra: {
				forwardedProps: { executionMode: "deep", maxSubAgents: 4 },
			},
		});

		expect(w.state.calls).toEqual([
			"admit",
			"conversation",
			"turn",
			"save",
			"start",
			"save",
		]);
		expect(w.state.admittedBodies).toEqual([
			{
				templateSlug: "deep-researcher",
				query: QUESTION,
				organizationId: ORG,
				maxSubAgents: 4,
			},
		]);
		expect(w.state.conversations.get(THREAD)).toMatchObject({
			userId: USER,
			organizationId: ORG,
			agentId: FABRIC_AGENT_ID,
			metadata: { mode: "research", executionMode: "deep" },
		});
		const turn = turnByKey(RUN_1);
		expect(turn).toMatchObject({
			executionMode: "research",
			conversationId: THREAD,
			questionText: QUESTION,
			status: "COMPLETED",
		});
		expect(turn?.executionId).toMatch(EXECUTION_ID);
		expect(w.state.saves[0]).toMatchObject({
			id: THREAD,
			execution: {
				id: turn?.executionId,
				mode: "research",
				status: "running",
			},
			messages: [
				{ id: `${RUN_1}:user`, role: "user", content: QUESTION },
			],
		});
		expect(w.state.starts).toEqual([
			{
				executionId: turn?.executionId,
				conversationId: null,
				message: QUESTION,
				approvedToolCall: null,
			},
		]);
		expect(finishedOf(list)?.outcome).toEqual({ type: "success" });
	});

	it("a full response passes verifyEvents", async () => {
		const output = researchOutput({
			subAgentResults: [SUB_AGENT_DONE, SUB_AGENT_FAILED],
		});
		w.state.onStart = (started) => {
			// One poll sees it running with a sub-agent done; the next, done.
			setTimeout(() => {
				const workflow = w.state.workflows.get(started.executionId);
				if (workflow) {
					workflow.status = "COMPLETED";
					workflow.result = output;
				}
			}, 50);
			return {
				status: "RUNNING",
				progress: researchProgress({ subAgentsCompleted: 1 }),
				queries: { subAgentResults: [SUB_AGENT_DONE] },
			};
		};

		const list = await run(RUN_1, QUESTION);
		const executionId = executionOf(RUN_1);

		expect(await verified(list)).toHaveLength(list.length);
		expect(types(list)).toEqual([
			EventType.RUN_STARTED,
			EventType.STATE_SNAPSHOT,
			EventType.CUSTOM,
			EventType.STATE_SNAPSHOT,
			EventType.SUBAGENT_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.SUBAGENT_FINISHED,
			EventType.SUBAGENT_STARTED,
			EventType.SUBAGENT_ERROR,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		expect(list[1]).toMatchObject({
			snapshot: { executionId, progress: null },
		});
		expect(list[2]).toMatchObject({
			name: RESEARCH_RUN_EVENT.execution,
			value: { executionId, templateSlug: "deep-researcher" },
		});
		expect(list[11]).toMatchObject({ messageId: `${RUN_1}:assistant` });
		expect(list.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN_1,
			outcome: { type: "success" },
		});
	});

	it("an interrupt, a cancelled and a failed ending each pass verifyEvents", async () => {
		w.state.onStart = () => ({
			status: "RUNNING",
			progress: awaitingClarification(),
		});
		const interrupted = await run(RUN_1, QUESTION);
		expect(finishedOf(interrupted)?.outcome).toMatchObject({
			type: "interrupt",
			interrupts: [
				{
					id: `${RUN_1}:clarification`,
					message: CLARIFICATION_PROMPT,
				},
			],
		});
		expect(interrupted.at(-1)?.type).toBe(EventType.RUN_FINISHED);
		expect(await verified(interrupted)).toHaveLength(interrupted.length);

		w.reset(me);
		w.state.flags.add(FLAG);
		w.state.onStart = () => ({ status: "CANCELLED" });
		const cancelled = await run(RUN_1, QUESTION);
		expect(cancelled.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: "cancelled" },
		});
		expect(await verified(cancelled)).toHaveLength(cancelled.length);

		w.reset(me);
		w.state.flags.add(FLAG);
		w.state.onStart = () => ({
			status: "COMPLETED",
			result: researchOutput({
				status: "failed",
				error: "The planner failed",
			}),
		});
		const failed = await run(RUN_1, QUESTION);
		expect(failed.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "RESEARCH_FAILED",
			message: "The planner failed",
		});
		expect(await verified(failed)).toHaveLength(failed.length);
	});
});

describe("ResearchEngine — retries and start errors", () => {
	it("a retried run attaches and starts nothing", async () => {
		await liveRun();
		const retry = await run(RUN_1, QUESTION, { window: 0 });

		expect(w.state.starts).toHaveLength(1);
		expect(w.state.admittedBodies).toHaveLength(1);
		expect(retry[0]).toMatchObject({
			type: EventType.RUN_STARTED,
			threadId: THREAD,
			runId: RUN_1,
		});
		expect(isReconnect(retry.at(-1))).toBe(true);
	});

	it("a run id a stop tombstoned before it started is TURN_CANCELLED, and nothing is admitted, saved or started", async () => {
		seedConversation(me);
		expect(await engineFor().stop(THREAD, RUN_2)).toBe(true);

		const list = await run(RUN_2, QUESTION);

		expect(types(list)).toEqual([EventType.RUN_ERROR]);
		expect(errorCode(list)).toBe("TURN_CANCELLED");
		expect(w.state.admittedBodies).toEqual([]);
		expect(w.state.saves).toEqual([]);
		expect(w.state.starts).toEqual([]);
		expect(turnByKey(RUN_2)).toMatchObject({
			executionId: null,
			status: "CANCELLED",
		});
	});

	it("a retried run whose research already completed replays its ending, without a second admission, start or answer", async () => {
		await run(RUN_1, QUESTION);
		const answers = savedMessages().map((message) => message.id);
		expect(answers).toEqual([`${RUN_1}:user`, `${RUN_1}:assistant`]);

		const retry = await run(RUN_1, QUESTION);

		expect(w.state.admittedBodies).toHaveLength(1);
		expect(w.state.starts).toHaveLength(1);
		expect(retry[0]).toMatchObject({
			type: EventType.RUN_STARTED,
			threadId: THREAD,
			runId: RUN_1,
		});
		expect(errorOf(retry)).toBeUndefined();
		expect(finishedOf(retry)?.outcome).toEqual({ type: "success" });
		expect(retry.at(-1)?.type).toBe(EventType.RUN_FINISHED);
		await verified(retry);
		expect(savedMessages().map((message) => message.id)).toEqual(answers);
		expect(turnByKey(RUN_1)?.status).toBe("COMPLETED");
	});

	it("a run id that names a Direct turn on this thread is RUN_ID_REUSED and never observed as research", async () => {
		seedConversation(me);
		const direct = seedLiveTurn(RUN_1, "direct");
		direct.status = "COMPLETED";

		const list = await run(RUN_1, QUESTION);

		expect(errorCode(list)).toBe("RUN_ID_REUSED");
		expect(w.state.admittedBodies).toEqual([]);
		expect(w.state.describes).toEqual([]);
		expect(w.state.saves).toEqual([]);
		expect(w.state.starts).toEqual([]);
	});

	it("another run while one is live is TURN_IN_PROGRESS", async () => {
		await liveRun();

		const second = await run(RUN_2, "Another question");

		expect(errorCode(second)).toBe("TURN_IN_PROGRESS");
		expect(w.state.starts).toHaveLength(1);
		expect(w.state.admittedBodies).toHaveLength(1);
	});

	it("a run on a thread whose live Direct turn's workflow completed is TURN_IN_PROGRESS, and that turn is left to the Direct engine", async () => {
		seedConversation(me);
		const direct = seedLiveTurn(RUN_1, "direct");
		workflowOf(RUN_1).status = "COMPLETED";
		workflowOf(RUN_1).result = DIRECT_ANSWER;

		const list = await run(RUN_2, QUESTION);

		expect(errorCode(list)).toBe("TURN_IN_PROGRESS");
		expect(direct.status).toBe("ACTIVE");
		// Never read, so never settled with the research settler.
		expect(w.state.describes).toEqual([]);
		expect(w.state.saves).toEqual([]);
		expect(w.state.finalizes).toEqual([]);
		expect(w.state.starts).toEqual([]);
	});

	it("maps a stop before start to a cancelled run, an ambiguous start to TURN_START_UNCONFIRMED, and a start error to TURN_START_FAILED with a failed save", async () => {
		// The stop lands while the question is being saved.
		w.state.onCall = (call) => {
			const turn = turnByKey(RUN_1);
			if (call === "save" && turn?.status === "START_PENDING") {
				turn.status = "CANCEL_REQUESTED";
			}
		};
		const stopped = await run(RUN_1, QUESTION);
		expect(types(stopped)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_FINISHED,
		]);
		expect(finishedOf(stopped)?.outcome).toEqual({ type: "cancelled" });
		expect(w.state.starts).toEqual([]);
		expect(turnByKey(RUN_1)?.status).toBe("CANCELLED");
		expect(savedMessages().at(-1)).toMatchObject({
			id: `${RUN_1}:assistant`,
			streamStatus: "cancelled",
			metadata: { research: { status: "cancelled" } },
		});

		w.reset(me);
		w.state.flags.add(FLAG);
		const unavailable = new Error("connection lost");
		unavailable.name = "ServiceError";
		w.state.startError = unavailable;
		const ambiguous = await run(RUN_1, QUESTION);
		expect(errorCode(ambiguous)).toBe("TURN_START_UNCONFIRMED");
		expect(turnByKey(RUN_1)?.status).toBe("START_PENDING");

		w.reset(me);
		w.state.flags.add(FLAG);
		w.state.startError = new Error("Temporal refused the start");
		const failed = await run(RUN_1, QUESTION);
		expect(errorCode(failed)).toBe("TURN_START_FAILED");
		expect(turnByKey(RUN_1)?.status).toBe("FAILED");
		expect(savedMessages()).toMatchObject([
			{ id: `${RUN_1}:user`, role: "user", content: QUESTION },
			{
				id: `${RUN_1}:assistant`,
				role: "assistant",
				streamStatus: "error",
				metadata: { research: { status: "failed" } },
			},
		]);
	});
});

describe("ResearchEngine — the clarifying question", () => {
	const answer = { response: "  Europe  " };

	it("a resume on a forbidden thread and on an absent thread is FORBIDDEN with no describe and no signal", async () => {
		const absent = await resume(RUN_1, `${RUN_1}:clarification`, answer);
		expect(errorCode(absent)).toBe("FORBIDDEN");

		seedConversation({ userId: "user-example-2", organizationId: ORG });
		const forbidden = await resume(RUN_1, `${RUN_1}:clarification`, answer);
		expect(errorCode(forbidden)).toBe("FORBIDDEN");

		expect(w.state.describes).toEqual([]);
		expect(w.state.signals).toEqual([]);
	});

	it("a wrong interrupt id, a phase past awaiting_clarification and a run whose workflow already ended are INTERRUPT_NOT_PENDING with no signal", async () => {
		await liveRun(awaitingClarification());
		expect(
			errorCode(await resume(RUN_2, `${RUN_2}:clarification`, answer)),
		).toBe("INTERRUPT_NOT_PENDING");

		workflowOf(RUN_1).progress = researchProgress({
			phase: "decomposing",
		});
		expect(
			errorCode(await resume(RUN_2, `${RUN_1}:clarification`, answer)),
		).toBe("INTERRUPT_NOT_PENDING");

		workflowOf(RUN_1).status = "CANCELLED";
		expect(
			errorCode(await resume(RUN_2, `${RUN_1}:clarification`, answer)),
		).toBe("INTERRUPT_NOT_PENDING");

		expect(w.state.signals).toEqual([]);
	});

	it("a workflow that stops after the live-run check is INTERRUPT_NOT_PENDING with no signal", async () => {
		await liveRun(awaitingClarification());
		const executionId = executionOf(RUN_1);
		workflowOf(RUN_1).status = "CANCELLED";
		// The live-run check reads it running; the resume's own read, stopped.
		w.state.describeStatuses.set(executionId, ["RUNNING"]);
		w.state.describes.length = 0;

		const list = await resume(RUN_2, `${RUN_1}:clarification`, answer);

		expect(errorCode(list)).toBe("INTERRUPT_NOT_PENDING");
		expect(w.state.describes).toEqual([executionId, executionId]);
		expect(w.state.signals).toEqual([]);
		expect(turnByKey(RUN_1)?.status).toBe("ACTIVE");
	});

	it("an empty response is INVALID_REQUEST", async () => {
		await liveRun(awaitingClarification());

		const list = await resume(RUN_2, `${RUN_1}:clarification`, {
			response: "   ",
		});

		expect(errorCode(list)).toBe("INVALID_REQUEST");
		expect(w.state.signals).toEqual([]);
	});

	it("a valid answer signals clarification once with the trimmed text, and the answered prompt is not raised again while the phase still reads awaiting_clarification", async () => {
		await liveRun(awaitingClarification());

		const list = await resume(RUN_2, `${RUN_1}:clarification`, answer);

		expect(w.state.signals).toEqual([
			{
				executionId: executionOf(RUN_1),
				name: "clarification",
				args: ["Europe"],
				turnStatus: "ACTIVE",
			},
		]);
		expect(list[0]).toMatchObject({
			type: EventType.RUN_STARTED,
			threadId: THREAD,
			runId: RUN_2,
		});
		const accepted = list.findIndex(
			isEvent(RESEARCH_RUN_EVENT.clarificationAccepted),
		);
		expect(accepted).toBeGreaterThan(0);
		expect(list[accepted]).toMatchObject({
			value: { interruptId: `${RUN_1}:clarification` },
		});
		expect(types(list)).not.toContain(EventType.RUN_FINISHED);
		expect(
			list.some(
				(event) =>
					event.type === EventType.STATE_SNAPSHOT &&
					JSON.stringify(event.snapshot).includes(
						"awaiting_clarification",
					),
			),
		).toBe(false);
		expect(isReconnect(list.at(-1))).toBe(true);
		expect(await verified(list)).toHaveLength(list.length);
	});
});

describe("ResearchEngine — stop", () => {
	it("records the cancel before signalling, signals cancel then cancels, and audits", async () => {
		await liveRun();
		const executionId = executionOf(RUN_1);

		const stopped = await runnerFor().stop({
			threadId: THREAD,
			runId: RUN_1,
		});

		expect(stopped).toBe(true);
		expect(w.state.signals).toEqual([
			{
				executionId,
				name: "cancel",
				args: [],
				turnStatus: "CANCEL_REQUESTED",
			},
		]);
		expect(w.state.controls).toEqual(["signal:cancel", "cancel"]);
		expect(recordChatRunControlAudit).toHaveBeenCalledWith(
			{ headers: expect.any(Headers) },
			{
				action: "cancel",
				organizationId: ORG,
				executionId,
				runId: "temporal-run-1",
			},
		);
	});

	it("a failing cancel signal still cancels", async () => {
		await liveRun();
		w.state.signalError = new Error("signal refused");

		expect(await engineFor().stop(THREAD, RUN_1)).toBe(true);
		expect(w.state.controls).toEqual(["signal:cancel", "cancel"]);
		expect(w.state.cancels).toEqual([executionOf(RUN_1)]);
	});

	it("a workflow not RUNNING is not cancelled", async () => {
		seedConversation(me);
		seedLiveTurn(RUN_1, "research");
		workflowOf(RUN_1).status = "COMPLETED";

		expect(await engineFor().stop(THREAD, RUN_1)).toBe(false);
		expect(w.state.controls).toEqual([]);
		expect(recordChatRunControlAudit).not.toHaveBeenCalled();
	});

	it("a run id with no turn is tombstoned", async () => {
		seedConversation(me);

		expect(await engineFor().stop(THREAD, RUN_2)).toBe(true);
		expect(turnByKey(RUN_2)).toMatchObject({
			conversationId: THREAD,
			executionId: null,
			status: "CANCELLED",
		});
		expect(w.state.controls).toEqual([]);
	});

	it("a run id naming another thread's research turn stops nothing", async () => {
		seedConversation(me);
		seedConversation(me, OTHER_THREAD);
		const elsewhere = seedLiveTurn(RUN_1, "research", OTHER_THREAD);

		expect(await engineFor().stop(THREAD, RUN_1)).toBe(false);
		expect(elsewhere.status).toBe("ACTIVE");
		expect(w.state.turns).toEqual([elsewhere]);
		expect(w.state.controls).toEqual([]);
	});

	it("a run id naming a Direct or Orchestrator turn writes no cancel and returns false", async () => {
		seedConversation(me);
		const direct = seedLiveTurn(RUN_1, "direct");
		const orchestrator = seedLiveTurn(RUN_2, "balanced");

		expect(await engineFor().stop(THREAD, RUN_1)).toBe(false);
		expect(await engineFor().stop(THREAD, RUN_2)).toBe(false);
		expect(direct.status).toBe("ACTIVE");
		expect(orchestrator.status).toBe("ACTIVE");
		expect(w.state.controls).toEqual([]);
		expect(w.state.describes).toEqual([]);
	});

	it("a stop with no run id (a reopened run) records the cancel, signals, cancels and audits the thread's live research run", async () => {
		await liveRun();
		const executionId = executionOf(RUN_1);

		expect(await engineFor().stop(THREAD)).toBe(true);

		expect(w.state.signals).toEqual([
			{
				executionId,
				name: "cancel",
				args: [],
				turnStatus: "CANCEL_REQUESTED",
			},
		]);
		expect(w.state.controls).toEqual(["signal:cancel", "cancel"]);
		expect(recordChatRunControlAudit).toHaveBeenCalledWith(
			{ headers: expect.any(Headers) },
			{
				action: "cancel",
				organizationId: ORG,
				executionId,
				runId: "temporal-run-1",
			},
		);
	});

	it("a stop with no run id whose thread's latest turn is a live Direct or Orchestrator turn stops nothing", async () => {
		seedConversation(me);
		const direct = seedLiveTurn(RUN_1, "direct");

		expect(await engineFor().stop(THREAD)).toBe(false);

		const orchestrator = seedLiveTurn(RUN_2, "balanced");

		expect(await engineFor().stop(THREAD)).toBe(false);
		expect(direct.status).toBe("ACTIVE");
		expect(orchestrator.status).toBe("ACTIVE");
		expect(w.state.controls).toEqual([]);
		expect(w.state.describes).toEqual([]);
		expect(recordChatRunControlAudit).not.toHaveBeenCalled();
	});

	it("the runtime's stop with no run id, Direct asked first as the route registers it, stops the live research run once", async () => {
		await liveRun();
		const runner = new FabricTemporalRunner(
			{
				[DIRECT_AGENT_ID]: new DirectEngine({
					...me,
					audit: { headers: new Headers() },
				}),
				[RESEARCH_AGENT_ID]: engineFor(),
			},
			60_000,
		);

		expect(await runner.stop({ threadId: THREAD })).toBe(true);
		expect(w.state.controls).toEqual(["signal:cancel", "cancel"]);
		expect(turnByKey(RUN_1)?.status).toBe("CANCEL_REQUESTED");
	});

	it("stop on a forbidden thread records no cancel", async () => {
		seedConversation({ userId: "user-example-2", organizationId: ORG });

		expect(await engineFor().stop(THREAD, RUN_1)).toBe(false);
		expect(await engineFor().stop(THREAD)).toBe(false);
		expect(w.state.turns).toEqual([]);
	});
});

describe("ResearchEngine — connect and isRunning", () => {
	it("connect on a forbidden thread is FORBIDDEN with no snapshot and no follow", async () => {
		seedConversation({ userId: "user-example-2", organizationId: ORG });

		const list = await connect();

		expect(types(list)).toEqual([EventType.RUN_ERROR]);
		expect(errorCode(list)).toBe("FORBIDDEN");
		expect(w.state.describes).toEqual([]);
	});

	it("a finished thread gets only MESSAGES_SNAPSHOT", async () => {
		await run(RUN_1, QUESTION);

		const list = await connect();

		expect(types(list)).toEqual([EventType.MESSAGES_SNAPSHOT]);
	});

	it("a live turn whose workflow ended unwatched is saved with metadata.research before the snapshot", async () => {
		await liveRun();
		const workflow = workflowOf(RUN_1);
		workflow.status = "COMPLETED";
		workflow.result = researchOutput();

		const list = await connect();

		expect(types(list)).toEqual([EventType.MESSAGES_SNAPSHOT]);
		expect(turnByKey(RUN_1)?.status).toBe("COMPLETED");
		const snapshot = list[0];
		expect(
			snapshot?.type === EventType.MESSAGES_SNAPSHOT
				? snapshot.messages.at(-1)
				: undefined,
		).toMatchObject({
			id: `${RUN_1}:assistant`,
			role: "assistant",
			metadata: {
				fabric: {
					metadata: {
						research: {
							status: "completed",
							executionId: executionOf(RUN_1),
						},
					},
				},
			},
		});
	});

	it("a live turn is followed under its own key", async () => {
		await liveRun();

		const list = await connect();

		expect(types(list).slice(0, 2)).toEqual([
			EventType.MESSAGES_SNAPSHOT,
			EventType.RUN_STARTED,
		]);
		expect(list[1]).toMatchObject({ threadId: THREAD, runId: RUN_1 });
		expect(isReconnect(list.at(-1))).toBe(true);
		expect(w.state.starts).toHaveLength(1);
	});

	it("isRunning is true for the caller's live research turn and false for a Direct turn", async () => {
		await liveRun();
		expect(await runnerFor().isRunning({ threadId: THREAD })).toBe(true);

		seedConversation(me, OTHER_THREAD);
		seedLiveTurn(RUN_2, "direct", OTHER_THREAD);
		expect(await engineFor().isRunning(OTHER_THREAD)).toBe(false);
	});
});

describe("ResearchEngine — drift", () => {
	it("RESEARCH_CLARIFICATION_WINDOW_MS equals the workflow's clarify timeout", () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"../../packages/temporal/src/workflows/deep-researcher.ts",
			),
			"utf-8",
		);
		const match =
			/condition\(\s*\(\) => !awaitingClarification \|\| state\.cancelled,\s*"(\d+) minutes"/.exec(
				source,
			);

		expect(match).not.toBeNull();
		expect(Number(match?.[1]) * 60_000).toBe(
			RESEARCH_CLARIFICATION_WINDOW_MS,
		);
	});

	it("RESEARCH_AGENT_ID names a template workflow", () => {
		expect(getTemplateWorkflow(RESEARCH_AGENT_ID)).toMatchObject({
			workflowName: "deepResearcherWorkflow",
			taskQueue: "fabric-worker",
		});
	});
});
