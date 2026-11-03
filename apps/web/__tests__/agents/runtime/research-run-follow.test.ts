// @vitest-environment node
/**
 * observeResearchRun and the research settles, against the in-memory turn
 * table and fake Temporal (`_helpers/fake-direct-runtime`), on fake timers:
 * the stream route's 200 ms poll, the window's `fabric.reconnect`, and each
 * way a workflow ends, saved and finalized before the event that ends the
 * response.
 */
import { type AGUIEvent, EventType } from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import { getConversationTurnForExecution } from "@repo/database";
import {
	observeResearchRun,
	settleLatestResearchRun,
} from "@saas/agents/runtime/research-run-follow";
import { settleUnwatchedResearchRun } from "@saas/agents/runtime/research-run-record";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkflowErrorEvent } from "@/app/api/agents/fabric-ai/stream/turn-events";
import {
	type FakeTurn,
	type FakeWorkflow,
	fakeWorld as w,
} from "./_helpers/fake-direct-runtime";
import {
	awaitingClarification,
	researchOutput,
	researchProgress,
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
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

const USER = "user-example-1";
const ORG = "org-example-1";
const THREAD = "thread-example-0001";
const KEY = "run-example-0001";
const RUN = "run-example-0002";
const EXECUTION = "wf-user-example-1-deep-researcher-example";

const me = { userId: USER, organizationId: ORG };

/** The research turn, seeded with its conversation and its workflow. */
async function seedRun(
	workflow: Omit<FakeWorkflow, "memo" | "runId"> | null,
	turn: Partial<FakeTurn> = {},
) {
	w.state.conversations.set(THREAD, {
		id: THREAD,
		...me,
		agentId: "fabric-ai",
		metadata: { mode: "research" },
		messages: [],
	});
	const now = new Date();
	w.state.turns.push({
		id: "turn-research",
		...me,
		conversationId: THREAD,
		clientRequestKey: KEY,
		executionId: EXECUTION,
		executionMode: "research",
		status: "ACTIVE",
		startToken: null,
		questionText: "How did the market change?",
		createdAt: now,
		updatedAt: now,
		generation: 1,
		...turn,
	});
	if (workflow) {
		w.state.workflows.set(EXECUTION, {
			...workflow,
			memo: { ...me },
			runId: "temporal-run-1",
		});
	}
	const seeded = await getConversationTurnForExecution({
		executionId: EXECUTION,
		...me,
	});
	if (!seeded) {
		throw new Error("the seeded turn is not found");
	}
	return seeded;
}

function stream(windowMs = 60_000) {
	const events: AGUIEvent[] = [];
	/** The writes made by the time each event was emitted. */
	const writesAt: string[][] = [];
	let closed = false;
	return {
		events,
		writesAt,
		close: () => {
			closed = true;
		},
		stream: {
			emit: (event: AGUIEvent) => {
				expect(EventSchemas.safeParse(event).success).toBe(true);
				events.push(event);
				writesAt.push([...w.state.writeOrder]);
			},
			isClosed: () => closed,
			deadline: Date.now() + windowMs,
		},
	};
}

const typesOf = (events: AGUIEvent[]) => events.map((event) => event.type);

function savedAnswer() {
	return w.state.conversations
		.get(THREAD)
		?.messages.find((message) => message.id === `${KEY}:assistant`);
}

beforeEach(() => {
	vi.useFakeTimers();
	w.reset(me);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("observeResearchRun — polling and the window", () => {
	it("polls every 200 ms and sends fabric.reconnect at the deadline, leaving the run going", async () => {
		const turn = await seedRun({
			status: "RUNNING",
			progress: researchProgress(),
			queries: { subAgentResults: [] },
		});
		const s = stream(1_000);

		const done = observeResearchRun({ turn, runId: RUN, stream: s.stream });
		await vi.advanceTimersByTimeAsync(0);
		expect(w.state.describes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(200);
		expect(w.state.describes).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(800);
		await done;

		expect(w.state.describes).toHaveLength(6);
		expect(s.events.at(-1)).toEqual({
			type: EventType.CUSTOM,
			name: "fabric.reconnect",
			value: { executionId: EXECUTION, runId: RUN },
		});
		expect(w.state.writeOrder).toEqual([]);
		expect(w.state.turns[0]?.status).toBe("ACTIVE");
	});

	it("stops quietly when the stream closes", async () => {
		const turn = await seedRun({
			status: "RUNNING",
			progress: researchProgress(),
			queries: { subAgentResults: [] },
		});
		const s = stream();

		const done = observeResearchRun({ turn, runId: RUN, stream: s.stream });
		await vi.advanceTimersByTimeAsync(0);
		const sent = s.events.length;
		s.close();
		await vi.advanceTimersByTimeAsync(200);
		await done;

		expect(s.events).toHaveLength(sent);
		expect(w.state.describes).toHaveLength(1);
		expect(w.state.writeOrder).toEqual([]);
	});
});

describe("observeResearchRun — how a run ends", () => {
	it("COMPLETED is saved and finalized before RUN_FINISHED", async () => {
		const model = { id: "example-answer-served", viaPlan: true };
		const reportModel = { id: "example-report-served", viaPlan: false };
		const output = researchOutput({ model, reportModel });
		const turn = await seedRun({ status: "COMPLETED", result: output });
		const s = stream();

		await observeResearchRun({ turn, runId: RUN, stream: s.stream });

		expect(s.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: "success" },
		});
		expect(s.writesAt.at(-1)).toEqual(["save", "finalize"]);
		expect(w.state.saves).toHaveLength(1);
		expect(w.state.saves[0]).toMatchObject({
			id: THREAD,
			execution: { id: EXECUTION, mode: "research", status: "completed" },
		});
		expect(w.state.saves[0]?.messages.map((message) => message.id)).toEqual(
			[`${KEY}:user`, `${KEY}:assistant`],
		);
		expect(savedAnswer()).toMatchObject({
			streamStatus: "completed",
			metadata: {
				research: {
					status: "completed",
					executionId: EXECUTION,
					result: { model, reportModel },
				},
			},
		});
		expect(w.state.finalizes).toEqual([
			expect.objectContaining({
				outcome: "COMPLETED",
				terminalReason: "research: completed",
			}),
		]);
	});

	it("status failed after a recorded stop ends cancelled", async () => {
		const turn = await seedRun(
			{
				status: "COMPLETED",
				result: researchOutput({
					status: "failed",
					error: "Workflow was cancelled",
				}),
			},
			{ status: "CANCEL_REQUESTED" },
		);
		const s = stream();

		await observeResearchRun({ turn, runId: RUN, stream: s.stream });

		expect(s.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: "cancelled" },
		});
		expect(typesOf(s.events)).not.toContain(EventType.RUN_ERROR);
		expect(savedAnswer()).toMatchObject({ streamStatus: "cancelled" });
		expect(w.state.finalizes).toEqual([
			expect.objectContaining({ outcome: "CANCELLED" }),
		]);
	});

	it("FAILED and TIMED_OUT end with RUN_ERROR from buildWorkflowErrorEvent and a failed save and finalize", async () => {
		for (const status of ["FAILED", "TIMED_OUT"]) {
			w.reset(me);
			const turn = await seedRun({ status });
			const s = stream();

			await observeResearchRun({ turn, runId: RUN, stream: s.stream });

			const expected = buildWorkflowErrorEvent(
				new Error(`workflow ${status.toLowerCase()}`),
			);
			expect(s.events.at(-1)).toEqual({
				type: EventType.RUN_ERROR,
				message: expected.message,
				code: "RESEARCH_FAILED",
				metadata: { fabric: expected },
			});
			expect(s.writesAt.at(-1)).toEqual(["save", "finalize"]);
			expect(savedAnswer()).toMatchObject({
				streamStatus: "error",
				metadata: {
					research: { status: "failed", error: expected.message },
				},
			});
			expect(w.state.finalizes).toEqual([
				expect.objectContaining({ outcome: "FAILED" }),
			]);
		}
	});

	it("CANCELLED and TERMINATED end with a cancelled save and finalize and RUN_FINISHED cancelled last", async () => {
		for (const status of ["CANCELLED", "TERMINATED"]) {
			w.reset(me);
			const turn = await seedRun({ status });
			const s = stream();

			await observeResearchRun({ turn, runId: RUN, stream: s.stream });

			expect(s.events.at(-1)).toEqual({
				type: EventType.RUN_FINISHED,
				threadId: THREAD,
				runId: RUN,
				outcome: { type: "cancelled" },
			});
			expect(s.writesAt.at(-1)).toEqual(["save", "finalize"]);
			expect(savedAnswer()).toMatchObject({ streamStatus: "cancelled" });
			expect(w.state.finalizes).toEqual([
				expect.objectContaining({ outcome: "CANCELLED" }),
			]);
		}
	});

	it("an interrupt ends the response with RUN_FINISHED interrupt last, no save, no finalize and no subAgentResults query", async () => {
		let subAgentQueries = 0;
		const turn = await seedRun({
			status: "RUNNING",
			progress: awaitingClarification(),
			queries: {
				get subAgentResults() {
					subAgentQueries += 1;
					return [];
				},
			},
		});
		const s = stream();

		await observeResearchRun({ turn, runId: RUN, stream: s.stream });

		expect(s.events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: "interrupt" },
		});
		expect(w.state.writeOrder).toEqual([]);
		expect(subAgentQueries).toBe(0);
	});

	it("a workflow Temporal never started ends TURN_NOT_STARTED after the reconcile", async () => {
		const longAgo = new Date(Date.now() - 5 * 60_000);
		const turn = await seedRun(null, {
			status: "START_PENDING",
			createdAt: longAgo,
			updatedAt: longAgo,
		});
		const s = stream();

		await observeResearchRun({ turn, runId: RUN, stream: s.stream });

		expect(s.events.at(-1)).toEqual({
			type: EventType.RUN_ERROR,
			message: "This research did not start.",
			code: "TURN_NOT_STARTED",
		});
		expect(w.state.turns[0]?.status).toBe("FAILED");
	});
});

describe("the research settles", () => {
	it("settleUnwatchedResearchRun saves the run and returns its outcome", async () => {
		const turn = await seedRun({ status: "COMPLETED" });

		expect(
			await settleUnwatchedResearchRun(researchOutput(), turn),
		).toEqual({
			outcome: "COMPLETED",
			terminalReason: "research: completed",
		});
		expect(savedAnswer()).toMatchObject({
			metadata: { research: { status: "completed" } },
		});

		w.reset(me);
		const failed = await seedRun({ status: "COMPLETED" });
		expect(await settleUnwatchedResearchRun(undefined, failed)).toEqual({
			outcome: "FAILED",
			terminalReason: "research: failed",
		});
		expect(savedAnswer()).toMatchObject({
			content: "Research failed: The research failed",
			metadata: { research: { status: "failed" } },
		});
		// The reconcile writes the terminal state, not the settle.
		expect(w.state.finalizes).toEqual([]);
	});

	it("settleLatestResearchRun returns none when the latest turn is a Direct turn", async () => {
		await seedRun({ status: "COMPLETED", result: researchOutput() });
		const now = new Date();
		w.state.turns.push({
			id: "turn-direct",
			...me,
			conversationId: THREAD,
			clientRequestKey: "run-example-0003",
			executionId: "direct-chat-example",
			executionMode: "direct",
			status: "ACTIVE",
			startToken: null,
			questionText: "Follow-up",
			createdAt: now,
			updatedAt: now,
			generation: 2,
		});

		expect(await settleLatestResearchRun(me, THREAD)).toBe("none");
		expect(w.state.describes).toEqual([]);
		expect(w.state.writeOrder).toEqual([]);
	});

	it("settleLatestResearchRun saves a run that ended unwatched, and leaves a running one", async () => {
		await seedRun({ status: "RUNNING" });
		expect(await settleLatestResearchRun(me, THREAD)).toBe("running");
		expect(w.state.writeOrder).toEqual([]);

		const workflow = w.state.workflows.get(EXECUTION);
		if (workflow) {
			workflow.status = "COMPLETED";
			workflow.result = researchOutput();
		}
		expect(await settleLatestResearchRun(me, THREAD)).toBe("terminalized");
		expect(w.state.turns[0]?.status).toBe("COMPLETED");
		expect(savedAnswer()).toMatchObject({
			metadata: { research: { status: "completed" } },
		});
	});

	it("settleLatestResearchRun saves a FAILED or TIMED_OUT run that ended unwatched as failed, from buildWorkflowErrorEvent", async () => {
		for (const status of ["FAILED", "TIMED_OUT"]) {
			w.reset(me);
			await seedRun({ status });

			expect(await settleLatestResearchRun(me, THREAD)).toBe(
				"terminalized",
			);

			const expected = buildWorkflowErrorEvent(
				new Error(`workflow ${status.toLowerCase()}`),
			);
			expect(savedAnswer()).toMatchObject({
				content: `Research failed: ${expected.message}`,
				streamStatus: "error",
				metadata: {
					research: {
						status: "failed",
						executionId: EXECUTION,
						error: expected.message,
					},
				},
			});
			expect(w.state.writeOrder).toEqual(["save", "finalize"]);
			expect(w.state.finalizes).toEqual([
				expect.objectContaining({
					outcome: "FAILED",
					terminalReason: "research: failed",
				}),
			]);
		}
	});

	it("settleLatestResearchRun saves a CANCELLED run that ended unwatched as cancelled", async () => {
		await seedRun({ status: "CANCELLED" });

		expect(await settleLatestResearchRun(me, THREAD)).toBe("terminalized");

		expect(savedAnswer()).toMatchObject({
			content: "Research cancelled.",
			streamStatus: "cancelled",
			metadata: {
				research: { status: "cancelled", executionId: EXECUTION },
			},
		});
		expect(w.state.finalizes).toEqual([
			expect.objectContaining({
				outcome: "CANCELLED",
				terminalReason: "research: cancelled",
			}),
		]);
	});
});
