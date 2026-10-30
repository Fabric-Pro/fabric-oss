// @vitest-environment node
/**
 * FabricTemporalRunner with the Direct engine, against an in-memory turn
 * table and a fake Temporal (`_helpers/fake-direct-runtime`):
 *
 *   - a thread is the caller's conversation (created with id = threadId),
 *     and every turn of it carries that id as its workflow's
 *     `conversationId`, the prompt-cache session key;
 *   - someone else's thread (another user, or the caller in another
 *     organization) is refused on run, connect and stop;
 *   - one live turn per thread (`TURN_IN_PROGRESS`), and a retried run id
 *     attaches to its turn without starting a second workflow;
 *   - connect sends one MESSAGES_SNAPSHOT and replays no finished run, then
 *     tails a live one; the stream window ends a response with
 *     `fabric.reconnect` and leaves the workflow running;
 *   - an approval interrupt resumes once, with the recorded call; a replayed
 *     or declined one starts nothing;
 *   - stop records the cancel on the turn, cancels the workflow and writes
 *     the cancel route's audit;
 *   - a finished turn is saved with deterministic ids, then finalized.
 *
 * Every event the runner emits is checked against AG-UI's event schemas.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
} from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { DirectChatWorkflowOutput } from "@repo/temporal";
import { DirectEngine } from "@saas/agents/runtime/direct-engine";
import {
	FabricRuntimeAgent,
	FabricTemporalRunner,
	resolveStreamWindowMs,
} from "@saas/agents/runtime/fabric-temporal-runner";
import { lastValueFrom, type Observable, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorld as w } from "./_helpers/fake-direct-runtime";

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

const USER = "user-example-1";
const ORG = "org-example-1";
const OTHER_ORG = "org-example-2";
const THREAD = "thread-example-0001";
const RUN_1 = "run-example-0001";
const RUN_2 = "run-example-0002";
const AGENT_ID = "fabric-direct";

const ANSWERED: DirectChatWorkflowOutput = {
	success: true,
	responseText: "Here is the answer.",
	usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

const NEEDS_APPROVAL: DirectChatWorkflowOutput = {
	success: true,
	responseText: "I can create that story.",
	toolCalls: [
		{
			id: "tool-1",
			name: "create_story",
			args: { title: "From the model" },
			status: "pending",
		},
	],
	pendingConfirmation: {
		message: "Create the story?",
		toolName: "create_story",
		args: { title: "From the model" },
	},
};

const me = { userId: USER, organizationId: ORG };

function runnerFor(
	caller: { userId: string; organizationId: string },
	streamWindowMs = 60_000,
) {
	return new FabricTemporalRunner(
		{
			[AGENT_ID]: new DirectEngine({
				...caller,
				audit: { headers: new Headers() },
			}),
		},
		streamWindowMs,
	);
}

function agent() {
	const instance = new FabricRuntimeAgent();
	instance.agentId = AGENT_ID;
	return instance;
}

function input(
	runId: string,
	message: string | null,
	extra: Partial<RunAgentInput> = {},
): RunAgentInput {
	return {
		threadId: THREAD,
		runId,
		messages: message
			? [{ id: `${runId}:message`, role: "user", content: message }]
			: [],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
		...extra,
	};
}

function isAguiEvent(event: BaseEvent): event is AGUIEvent {
	return EventSchemas.safeParse(event).success;
}

/** A response's events, each one a valid AG-UI event. */
async function events(source: Observable<BaseEvent>): Promise<AGUIEvent[]> {
	const collected = await lastValueFrom(source.pipe(toArray()));
	const valid = collected.filter(isAguiEvent);
	expect(valid).toHaveLength(collected.length);
	return valid;
}

function run(
	runId: string,
	message: string | null,
	options: {
		caller?: { userId: string; organizationId: string };
		window?: number;
		extra?: Partial<RunAgentInput>;
	} = {},
) {
	return events(
		runnerFor(options.caller ?? me, options.window).run({
			threadId: THREAD,
			agent: agent(),
			input: input(runId, message, options.extra),
		}),
	);
}

function connect(
	options: {
		caller?: { userId: string; organizationId: string };
		window?: number;
	} = {},
) {
	return events(
		runnerFor(options.caller ?? me, options.window).connect({
			threadId: THREAD,
			agentId: AGENT_ID,
		}),
	);
}

const types = (list: AGUIEvent[]) => list.map((event) => event.type);

function errorCode(list: AGUIEvent[]) {
	const error = list.find((event) => event.type === EventType.RUN_ERROR);
	return error?.type === EventType.RUN_ERROR ? error.code : undefined;
}

function outcome(list: AGUIEvent[]) {
	const finished = list.find(
		(event) => event.type === EventType.RUN_FINISHED,
	);
	return finished?.type === EventType.RUN_FINISHED
		? finished.outcome
		: undefined;
}

function isReconnect(event: AGUIEvent | undefined) {
	return (
		event?.type === EventType.CUSTOM && event.name === "fabric.reconnect"
	);
}

function turnByKey(key: string) {
	return w.state.turns.find((turn) => turn.clientRequestKey === key);
}

function completeWorkflow(
	executionId: string,
	result: DirectChatWorkflowOutput,
) {
	const workflow = w.state.workflows.get(executionId);
	if (!workflow) {
		throw new Error(`no workflow ${executionId}`);
	}
	workflow.status = "COMPLETED";
	workflow.result = result;
}

function seedConversation(owner: { userId: string; organizationId: string }) {
	w.state.conversations.set(THREAD, {
		id: THREAD,
		...owner,
		agentId: "fabric-ai",
		metadata: { mode: "direct" },
		messages: [],
	});
}

beforeEach(() => {
	w.reset(me);
	w.state.onStart = () => ({ status: "COMPLETED", result: ANSWERED });
	vi.mocked(recordChatRunControlAudit).mockClear();
});

describe("FabricTemporalRunner — threads", () => {
	it("creates the thread as the caller's conversation and keys every turn's prompt cache on it", async () => {
		const first = await run(RUN_1, "First question");
		const second = await run(RUN_2, "Second question");

		expect(w.state.conversations.get(THREAD)).toMatchObject({
			id: THREAD,
			userId: USER,
			organizationId: ORG,
			metadata: { mode: "direct" },
		});
		expect(w.state.starts.map((start) => start.conversationId)).toEqual([
			THREAD,
			THREAD,
		]);
		expect(
			w.state.admittedBodies.map((body) => body.conversationId),
		).toEqual([THREAD, THREAD]);
		expect(outcome(first)).toEqual({ type: "success" });
		expect(outcome(second)).toEqual({ type: "success" });
	});

	it("refuses another user's thread on run, connect and stop", async () => {
		seedConversation({ userId: "user-example-2", organizationId: ORG });

		expect(errorCode(await run(RUN_1, "Hello"))).toBe("FORBIDDEN");
		const connected = await connect();
		expect(types(connected)).toEqual([EventType.RUN_ERROR]);
		expect(errorCode(connected)).toBe("FORBIDDEN");
		expect(
			await runnerFor(me).stop({ threadId: THREAD, runId: RUN_1 }),
		).toBe(false);
		expect(w.state.starts).toHaveLength(0);
		expect(w.state.conversations.get(THREAD)?.messages).toEqual([]);
	});

	it("refuses the caller's own thread from another organization", async () => {
		await run(RUN_1, "Hello");
		const elsewhere = { userId: USER, organizationId: OTHER_ORG };

		expect(
			errorCode(await run(RUN_2, "Hello again", { caller: elsewhere })),
		).toBe("FORBIDDEN");
		expect(errorCode(await connect({ caller: elsewhere }))).toBe(
			"FORBIDDEN",
		);
		expect(
			await runnerFor(elsewhere).stop({ threadId: THREAD, runId: RUN_1 }),
		).toBe(false);
		expect(w.state.starts).toHaveLength(1);
	});

	it("refuses an unknown agent", async () => {
		const unknown = new FabricRuntimeAgent();
		unknown.agentId = "not-an-agent";
		const list = await events(
			runnerFor(me).run({
				threadId: THREAD,
				agent: unknown,
				input: input(RUN_1, "Hello"),
			}),
		);
		expect(errorCode(list)).toBe("UNKNOWN_AGENT");
	});
});

describe("FabricTemporalRunner — turns", () => {
	it("refuses a second live run in the thread with TURN_IN_PROGRESS", async () => {
		w.state.onStart = () => ({ status: "RUNNING" });
		await run(RUN_1, "Long question", { window: 0 });

		const second = await run(RUN_2, "Another question");

		expect(errorCode(second)).toBe("TURN_IN_PROGRESS");
		expect(w.state.starts).toHaveLength(1);
	});

	it("attaches a retried run id to its turn and never starts a second workflow", async () => {
		w.state.onStart = () => ({
			status: "RUNNING",
			progress: { phase: "executing_ai", responseText: "Part" },
		});
		const first = await run(RUN_1, "Question", { window: 0 });
		const retry = await run(RUN_1, "Question", { window: 0 });

		expect(w.state.starts).toHaveLength(1);
		expect(w.state.admittedBodies).toHaveLength(1);
		for (const list of [first, retry]) {
			expect(list[0]).toMatchObject({
				type: EventType.RUN_STARTED,
				threadId: THREAD,
				runId: RUN_1,
			});
			expect(isReconnect(list.at(-1))).toBe(true);
		}
		expect(
			retry.some(
				(event) =>
					event.type === EventType.TEXT_MESSAGE_CONTENT &&
					event.delta === "Part",
			),
		).toBe(true);
	});

	it("ends a response at the stream window with fabric.reconnect and leaves the workflow running", async () => {
		w.state.onStart = () => ({ status: "RUNNING" });
		const list = await run(RUN_1, "Question", { window: 0 });

		const executionId = w.state.starts[0]?.executionId;
		expect(list.at(-1)).toEqual({
			type: EventType.CUSTOM,
			name: "fabric.reconnect",
			value: { executionId, runId: RUN_1 },
		});
		expect(types(list)).not.toContain(EventType.RUN_FINISHED);
		expect(w.state.cancels).toEqual([]);
		expect(w.state.workflows.get(executionId ?? "")?.status).toBe(
			"RUNNING",
		);
		expect(turnByKey(RUN_1)?.status).toBe("ACTIVE");
		expect(await runnerFor(me).isRunning({ threadId: THREAD })).toBe(true);
	});

	it("saves a turn cancelled while unwatched before admitting the next run", async () => {
		w.state.onStart = () => ({ status: "RUNNING" });
		await run(RUN_1, "Long question", { window: 0 });
		const first = w.state.workflows.get(
			w.state.starts[0]?.executionId ?? "",
		);
		if (first) {
			first.status = "CANCELLED";
		}
		w.state.onStart = () => ({ status: "COMPLETED", result: ANSWERED });

		const next = await run(RUN_2, "Next question");

		expect(errorCode(next)).toBeUndefined();
		expect(turnByKey(RUN_1)?.status).toBe("CANCELLED");
		expect(
			w.state.conversations
				.get(THREAD)
				?.messages.map((message) => message.id),
		).toEqual([
			`${RUN_1}:user`,
			`${RUN_1}:assistant`,
			`${RUN_2}:user`,
			`${RUN_2}:assistant`,
		]);
		expect(w.state.starts).toHaveLength(2);
	});

	it("saves a finished turn under deterministic ids, then finalizes it", async () => {
		await run(RUN_1, "What changed?");

		const executionId = w.state.starts[0]?.executionId;
		// The question when the turn was admitted, then the turn.
		expect(w.state.writeOrder).toEqual(["save", "save", "finalize"]);
		const [asked, save] = w.state.saves;
		expect(asked).toMatchObject({
			id: THREAD,
			execution: { id: executionId, mode: "direct", status: "running" },
			messages: [
				{ id: `${RUN_1}:user`, role: "user", content: "What changed?" },
			],
		});
		expect(save).toMatchObject({
			id: THREAD,
			userId: USER,
			organizationId: ORG,
			execution: { id: executionId, mode: "direct", status: "completed" },
		});
		expect(
			save?.messages.map((message) => [message.id, message.role]),
		).toEqual([
			[`${RUN_1}:user`, "user"],
			[`${RUN_1}:assistant`, "assistant"],
		]);
		expect(save?.messages[1]).toMatchObject({
			content: "Here is the answer.",
			streamStatus: "completed",
			metadata: { usage: ANSWERED.usage },
		});
		expect(w.state.finalizes[0]).toMatchObject({
			executionId,
			outcome: "COMPLETED",
			responseText: "Here is the answer.",
		});
		expect(turnByKey(RUN_1)?.status).toBe("COMPLETED");
	});
});

describe("FabricTemporalRunner — connect", () => {
	it("sends one MESSAGES_SNAPSHOT for a finished thread and replays no run", async () => {
		await run(RUN_1, "What changed?");

		const list = await connect();

		expect(types(list)).toEqual([EventType.MESSAGES_SNAPSHOT]);
		const [snapshot] = list;
		expect(
			snapshot?.type === EventType.MESSAGES_SNAPSHOT
				? snapshot.messages.map((message) => [message.id, message.role])
				: null,
		).toEqual([
			[`${RUN_1}:user`, "user"],
			[`${RUN_1}:assistant`, "assistant"],
		]);
	});

	it("sends the snapshot, then tails a live turn to its end", async () => {
		w.state.onStart = () => ({
			status: "RUNNING",
			progress: { phase: "executing_ai", responseText: "Partial" },
		});
		await run(RUN_1, "Long question", { window: 0 });

		const live = await connect({ window: 0 });
		expect(live[0]?.type).toBe(EventType.MESSAGES_SNAPSHOT);
		expect(live[1]).toMatchObject({
			type: EventType.RUN_STARTED,
			runId: RUN_1,
		});
		expect(
			live.some(
				(event) =>
					event.type === EventType.TEXT_MESSAGE_CONTENT &&
					event.delta === "Partial",
			),
		).toBe(true);
		expect(isReconnect(live.at(-1))).toBe(true);

		// The turn ends while a reconnect tails it.
		const tailing = connect();
		await new Promise((resolve) => setTimeout(resolve, 50));
		completeWorkflow(w.state.starts[0]?.executionId ?? "", {
			success: true,
			responseText: "Partial, then finished.",
		});
		const finished = await tailing;
		expect(finished[0]?.type).toBe(EventType.MESSAGES_SNAPSHOT);
		const deltas = finished.flatMap((event) =>
			event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
		);
		expect(deltas).toEqual(["Partial", ", then finished."]);
		expect(outcome(finished)).toEqual({ type: "success" });
		expect(turnByKey(RUN_1)?.status).toBe("COMPLETED");
		expect(w.state.starts).toHaveLength(1);
	});

	it("settles a turn that ended unwatched into the snapshot instead of replaying it", async () => {
		w.state.onStart = () => ({ status: "RUNNING" });
		await run(RUN_1, "Long question", { window: 0 });
		completeWorkflow(w.state.starts[0]?.executionId ?? "", ANSWERED);

		const list = await connect();

		expect(types(list)).toEqual([EventType.MESSAGES_SNAPSHOT]);
		const [snapshot] = list;
		expect(
			snapshot?.type === EventType.MESSAGES_SNAPSHOT
				? snapshot.messages.map((message) => message.id)
				: null,
		).toEqual([`${RUN_1}:user`, `${RUN_1}:assistant`]);
		expect(turnByKey(RUN_1)?.status).toBe("COMPLETED");
	});
});

describe("FabricTemporalRunner — approvals", () => {
	const interruptId = `${RUN_1}:approval`;

	function resume(
		runId: string,
		answer: { status: "resolved" | "cancelled"; payload?: unknown },
		forwardedProps: Record<string, unknown> = {},
	) {
		return run(runId, null, {
			extra: {
				resume: [{ interruptId, ...answer }],
				forwardedProps,
			},
		});
	}

	beforeEach(() => {
		w.state.onStart = (start) => ({
			status: "COMPLETED",
			result: start.approvedToolCall ? ANSWERED : NEEDS_APPROVAL,
		});
	});

	it("interrupts on an approval, resumes the recorded call once, and refuses a replay", async () => {
		const asked = await run(RUN_1, "Create a story");
		expect(outcome(asked)).toEqual({
			type: "interrupt",
			interrupts: [
				{
					id: interruptId,
					reason: "tool_approval",
					message: "Create the story?",
					toolCallId: "tool-1",
					metadata: {
						toolName: "create_story",
						args: { title: "From the model" },
					},
				},
			],
		});

		const resumed = await resume(
			RUN_2,
			{ status: "resolved", payload: { approved: true } },
			// A client cannot substitute the call that runs.
			{ approvedToolCall: { toolName: "delete_project", args: {} } },
		);

		expect(outcome(resumed)).toEqual({ type: "success" });
		expect(w.state.starts).toHaveLength(2);
		expect(w.state.starts[1]?.approvedToolCall).toEqual({
			toolName: "create_story",
			args: { title: "From the model" },
		});
		expect(w.state.starts[1]?.conversationId).toBe(THREAD);
		expect(turnByKey(`${interruptId}:resume`)?.status).toBe("COMPLETED");

		const replay = await resume("run-example-0003", {
			status: "resolved",
			payload: { approved: true },
		});
		expect(errorCode(replay)).toBe("APPROVAL_NOT_PENDING");
		expect(w.state.starts).toHaveLength(2);
	});

	it("re-raises an unanswered approval on connect", async () => {
		await run(RUN_1, "Create a story");

		const list = await connect();

		expect(types(list)).toEqual([
			EventType.MESSAGES_SNAPSHOT,
			EventType.RUN_STARTED,
			EventType.RUN_FINISHED,
		]);
		expect(outcome(list)).toMatchObject({
			type: "interrupt",
			interrupts: [{ id: interruptId }],
		});
	});

	it("declines without starting a workflow, and refuses a later approval", async () => {
		await run(RUN_1, "Create a story");

		const declined = await resume(RUN_2, { status: "cancelled" });
		expect(types(declined)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_FINISHED,
		]);
		expect(outcome(declined)).toEqual({ type: "success" });

		const approved = await resume("run-example-0003", {
			status: "resolved",
			payload: { approved: true },
		});
		expect(errorCode(approved)).toBe("APPROVAL_NOT_PENDING");
		expect(w.state.starts).toHaveLength(1);
	});
});

describe("FabricTemporalRunner — stop", () => {
	it("records the cancel on the turn, cancels the workflow and writes the audit", async () => {
		w.state.onStart = () => ({ status: "RUNNING" });
		await run(RUN_1, "Long question", { window: 0 });
		const executionId = w.state.starts[0]?.executionId;

		const stopped = await runnerFor(me).stop({
			threadId: THREAD,
			runId: RUN_1,
		});

		expect(stopped).toBe(true);
		expect(turnByKey(RUN_1)?.status).toBe("CANCEL_REQUESTED");
		expect(w.state.cancels).toEqual([executionId]);
		expect(recordChatRunControlAudit).toHaveBeenCalledWith(
			{ headers: expect.any(Headers) },
			{
				action: "cancel",
				organizationId: ORG,
				executionId,
				runId: "temporal-run-1",
			},
		);

		// Nobody watched it end: the reconnect settles it, saved as cancelled.
		const after = await connect();
		expect(types(after)).toEqual([EventType.MESSAGES_SNAPSHOT]);
		expect(turnByKey(RUN_1)?.status).toBe("CANCELLED");
		expect(
			w.state.conversations.get(THREAD)?.messages.at(-1),
		).toMatchObject({
			id: `${RUN_1}:assistant`,
			streamStatus: "cancelled",
		});
	});

	it("records a stop that arrives before the workflow starts, so it never starts", async () => {
		seedConversation(me);
		const now = new Date();
		w.state.turns.push({
			id: "turn-pending",
			userId: USER,
			organizationId: ORG,
			conversationId: THREAD,
			clientRequestKey: RUN_1,
			executionId: "direct-chat-not-started",
			executionMode: "direct",
			status: "START_PENDING",
			startToken: "start-token-pending",
			questionText: "Question",
			createdAt: now,
			updatedAt: now,
			generation: 1,
		});

		const stopped = await runnerFor(me).stop({
			threadId: THREAD,
			runId: RUN_1,
		});

		expect(stopped).toBe(true);
		expect(turnByKey(RUN_1)?.status).toBe("CANCEL_REQUESTED");
		expect(w.state.cancels).toEqual([]);
		expect(recordChatRunControlAudit).not.toHaveBeenCalled();
	});
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function savedMessages() {
	return w.state.conversations.get(THREAD)?.messages ?? [];
}

const TOOL_DONE = {
	id: "tool-1",
	name: "search_docs",
	args: { query: "release" },
	result: { hits: 2 },
	status: "complete" as const,
};

describe("FabricTemporalRunner — the question is saved when the turn is admitted", () => {
	it("saves the question before the workflow starts, and the answer right after it", async () => {
		let savedAtStart: string[] = [];
		w.state.onStart = () => {
			savedAtStart = savedMessages().map((message) => message.id);
			return { status: "RUNNING" };
		};
		await run(RUN_1, "Long question", { window: 0 });
		expect(savedAtStart).toEqual([`${RUN_1}:user`]);

		// The workflow appends its operation-result row while it runs.
		savedMessages().push({
			id: "op-1",
			role: "system",
			content: "SYSTEM\n\nsummary",
			timestamp: new Date().toISOString(),
		});
		completeWorkflow(w.state.starts[0]?.executionId ?? "", ANSWERED);
		await connect();

		expect(
			savedMessages().map((message) => [message.id, message.role]),
		).toEqual([
			[`${RUN_1}:user`, "user"],
			[`${RUN_1}:assistant`, "assistant"],
			["op-1", "system"],
		]);
		expect(savedMessages()[0]).toMatchObject({ content: "Long question" });
	});

	it("never saves the question twice: not for a retried run, not with the answer", async () => {
		w.state.onStart = () => ({ status: "RUNNING" });
		await run(RUN_1, "Question", { window: 0 });
		await run(RUN_1, "Question", { window: 0 });
		completeWorkflow(w.state.starts[0]?.executionId ?? "", ANSWERED);
		await connect();
		await connect();

		expect(
			savedMessages().filter((message) => message.role === "user"),
		).toHaveLength(1);
		expect(savedMessages().map((message) => message.id)).toEqual([
			`${RUN_1}:user`,
			`${RUN_1}:assistant`,
		]);
	});

	it("leaves no question behind for a turn refused at admission", async () => {
		w.state.refusal = () =>
			Response.json(
				{
					error: "Monthly AI limit reached",
					code: "AI_USAGE_LIMIT_EXCEEDED",
				},
				{ status: 429 },
			);
		const refused = await run(RUN_1, "Over the limit");
		expect(errorCode(refused)).toBe("AI_USAGE_LIMIT_EXCEEDED");

		w.state.refusal = null;
		w.state.onStart = () => ({ status: "RUNNING" });
		await run(RUN_2, "Long question", { window: 0 });
		const busy = await run("run-example-0003", "While it runs");
		expect(errorCode(busy)).toBe("TURN_IN_PROGRESS");

		expect(savedMessages().map((message) => message.id)).toEqual([
			`${RUN_2}:user`,
		]);
		expect(w.state.starts).toHaveLength(1);
	});

	it("saves a turn whose workflow failed to start with its failure, as the Direct chat saves a failed request", async () => {
		w.state.startError = new Error("Temporal refused the start");
		const list = await run(RUN_1, "Question");

		expect(errorCode(list)).toBe("TURN_START_FAILED");
		expect(turnByKey(RUN_1)?.status).toBe("FAILED");
		expect(savedMessages()).toMatchObject([
			{ id: `${RUN_1}:user`, role: "user", content: "Question" },
			{
				id: `${RUN_1}:assistant`,
				role: "assistant",
				streamStatus: "error",
				metadata: { errorMessage: expect.any(String) },
			},
		]);
	});
});

describe("FabricTemporalRunner — what a turn saves", () => {
	const streaming = {
		phase: "executing_ai",
		responseText: "Partial",
		reasoningText: "Check the pipeline",
		toolCalls: [TOOL_DONE],
	};

	it("saves a stopped turn as far as it streamed: text, tool calls and reasoning", async () => {
		w.state.onStart = () => ({ status: "RUNNING", progress: streaming });
		const running = run(RUN_1, "Long question");
		await sleep(50);

		expect(
			await runnerFor(me).stop({ threadId: THREAD, runId: RUN_1 }),
		).toBe(true);
		expect(outcome(await running)).toEqual({ type: "cancelled" });

		expect(savedMessages()[1]).toMatchObject({
			id: `${RUN_1}:assistant`,
			content: "Partial",
			reasoningText: "Check the pipeline",
			streamStatus: "cancelled",
			cancelledAt: expect.any(String),
			toolCalls: [
				{
					id: "tool-1",
					name: "search_docs",
					args: { query: "release" },
					result: JSON.stringify({ hits: 2 }),
					status: "success",
				},
			],
		});
	});

	it("saves a failed workflow's streamed answer and tool calls with its error", async () => {
		w.state.onStart = () => ({ status: "RUNNING", progress: streaming });
		const running = run(RUN_1, "Long question");
		await sleep(50);
		const workflow = w.state.workflows.get(
			w.state.starts[0]?.executionId ?? "",
		);
		if (workflow) {
			workflow.status = "FAILED";
		}
		await running;

		expect(savedMessages()[1]).toMatchObject({
			content: "Partial",
			reasoningText: "Check the pipeline",
			streamStatus: "error",
			metadata: { errorMessage: expect.any(String) },
			toolCalls: [{ id: "tool-1", status: "success" }],
		});
	});

	it("carries each saved answer's tool status, reasoning time and stop time in a connect's snapshot", async () => {
		w.state.onStart = () => ({
			status: "COMPLETED",
			result: {
				success: true,
				responseText: "Done.",
				reasoningText: "Because",
				reasoningDurationMs: 900,
				toolCalls: [
					TOOL_DONE,
					{
						...TOOL_DONE,
						id: "tool-2",
						status: "error",
						result: "boom",
					},
					{
						...TOOL_DONE,
						id: "tool-3",
						status: "pending",
						result: undefined,
					},
				],
			},
		});
		await run(RUN_1, "Question");

		const [snapshot] = await connect();
		const answer =
			snapshot?.type === EventType.MESSAGES_SNAPSHOT
				? snapshot.messages.find(
						(message) => message.id === `${RUN_1}:assistant`,
					)
				: undefined;
		expect(answer?.metadata).toMatchObject({
			fabric: {
				reasoningDurationMs: 900,
				toolStatus: {
					"tool-1": "success",
					"tool-2": "error",
					"tool-3": "pending",
				},
			},
		});

		// A stopped answer carries when it stopped.
		w.state.onStart = () => ({ status: "RUNNING" });
		const running = run(RUN_2, "Another");
		await sleep(50);
		await runnerFor(me).stop({ threadId: THREAD, runId: RUN_2 });
		await running;
		const [after] = await connect();
		const stopped =
			after?.type === EventType.MESSAGES_SNAPSHOT
				? after.messages.find(
						(message) => message.id === `${RUN_2}:assistant`,
					)
				: undefined;
		expect(stopped?.metadata).toMatchObject({
			fabric: {
				streamStatus: "cancelled",
				cancelledAt: expect.any(String),
			},
		});
	});
});

describe("FabricTemporalRunner — a client that goes away", () => {
	it("never cancels the turn: the workflow runs on and its whole answer is saved", async () => {
		w.state.onStart = () => ({
			status: "RUNNING",
			progress: { phase: "executing_ai", responseText: "Part" },
		});
		const seen: BaseEvent[] = [];
		const subscription = runnerFor(me)
			.run({
				threadId: THREAD,
				agent: agent(),
				input: input(RUN_1, "Question"),
			})
			.subscribe((event) => seen.push(event));
		await sleep(50);
		expect(seen.some((event) => event.type === EventType.RUN_STARTED)).toBe(
			true,
		);

		// The tab closes, or the chat switches conversation without a stop.
		subscription.unsubscribe();
		await sleep(400);

		const executionId = w.state.starts[0]?.executionId ?? "";
		expect(w.state.cancels).toEqual([]);
		expect(w.state.workflows.get(executionId)?.status).toBe("RUNNING");
		expect(turnByKey(RUN_1)?.status).toBe("ACTIVE");

		completeWorkflow(executionId, ANSWERED);
		await connect();

		expect(turnByKey(RUN_1)?.status).toBe("COMPLETED");
		expect(savedMessages()[1]).toMatchObject({
			id: `${RUN_1}:assistant`,
			content: "Here is the answer.",
			streamStatus: "completed",
		});
	});
});

describe("stream windows", () => {
	it("caps a window at the engine's ceiling, and a request may only shorten it", () => {
		expect(resolveStreamWindowMs(null)).toBe(60_000);
		expect(resolveStreamWindowMs(null, 240_000)).toBe(240_000);
		expect(resolveStreamWindowMs("5000", 240_000)).toBe(5_000);
		expect(resolveStreamWindowMs("900000", 240_000)).toBe(240_000);
	});

	it("gives an engine with its own window that window, and the others the runner's", async () => {
		const deadlines: Record<string, number> = {};
		const engineWith = (name: string, streamWindowMs?: number) => ({
			streamWindowMs,
			run: async (
				_request: unknown,
				stream: { deadline: number; emit: (event: AGUIEvent) => void },
			) => {
				deadlines[name] = stream.deadline - Date.now();
			},
			connect: async () => undefined,
			isRunning: async () => false,
			stop: async () => false,
		});
		const runner = new FabricTemporalRunner(
			{
				long: engineWith("long", 240_000),
				short: engineWith("short"),
			},
			60_000,
		);
		for (const agentId of ["long", "short"]) {
			const instance = new FabricRuntimeAgent();
			instance.agentId = agentId;
			await events(
				runner.run({
					threadId: THREAD,
					agent: instance,
					input: input(RUN_1, "Hello"),
				}),
			);
		}

		expect(deadlines.long).toBeGreaterThan(200_000);
		expect(deadlines.short).toBeLessThanOrEqual(60_000);
		expect(deadlines.short).toBeGreaterThan(50_000);
	});
});
