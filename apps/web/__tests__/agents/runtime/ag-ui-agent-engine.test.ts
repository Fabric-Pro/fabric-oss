// @vitest-environment node
/**
 * The durable AG-UI engine (`ag-ui-agent-engine.ts`) against an in-memory run
 * store, a fake Temporal and a fake conversation table
 * (`_helpers/fake-ag-ui-runtime`). The test plays the worker: it appends a
 * run's events to its stream and settles its workflow.
 *
 *   - a run starts its workflow once, with a by-reference input that holds
 *     no secret (the request's AI token goes in the Redis input record), and
 *     streams the run's events verbatim up to the terminal one;
 *   - a retried run id attaches to its workflow; another caller's run id is
 *     refused; a second run while the thread's run is live is refused;
 *   - a closed response, or the stream window's end, leaves the workflow
 *     running (the window ends with `fabric.reconnect`);
 *   - a workflow that ends without a terminal event ends the response with
 *     `RUN_ENDED`;
 *   - connect replays and tails a live run, replays a finished run whose
 *     answer is not saved yet (without the saved messages), and replays
 *     nothing durable for a saved one;
 *   - someone else's thread is refused on run, connect and stop;
 *   - stop cancels the workflow of the caller's live run;
 *   - Redis unavailable, an input that cannot be parked, a workflow that
 *     cannot start, a run no worker picks up in time (terminated), or a run
 *     whose setup failed on the worker (`AGUI_RUN_SETUP_FAILED` right after
 *     the held-back `RUN_STARTED`) runs the request's agent in-process
 *     instead; a run that has emitted an event to the client never falls
 *     back; a thread with no durable run connects in-process.
 *
 * Every event the engine emits is checked against AG-UI's event schemas.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
} from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import {
	AgentRunner,
	type AgentRunnerConnectRequest,
	type AgentRunnerIsRunningRequest,
	type AgentRunnerRunRequest,
	type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import {
	AGUI_RUN_SETUP_FAILED_CODE,
	openAgUiRunStore,
} from "@repo/temporal/agui-run-stream";
import {
	AgUiAgentEngine,
	type AgUiRunSettings,
} from "@saas/agents/runtime/ag-ui-agent-engine";
import type { RunStream } from "@saas/agents/runtime/engine";
import { FabricRuntimeAgent } from "@saas/agents/runtime/fabric-temporal-runner";
import { type Observable, of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAgUiWorld as w } from "./_helpers/fake-ag-ui-runtime";

vi.mock(
	"@repo/temporal",
	async () =>
		(await import("./_helpers/fake-ag-ui-runtime")).fakeAgUiWorld.temporal,
);
vi.mock("@repo/temporal/agui-run-stream", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/temporal/agui-run-stream")>();
	const { fakeAgUiWorld } = await import("./_helpers/fake-ag-ui-runtime");
	return {
		...actual,
		openAgUiRunStore: vi.fn(fakeAgUiWorld.openAgUiRunStore),
	};
});
vi.mock(
	"@saas/agents/runtime/thread",
	async () =>
		(await import("./_helpers/fake-ag-ui-runtime")).fakeAgUiWorld.thread,
);

const USER = "user-example-1";
const OTHER_USER = "user-example-2";
const ORG = "org-example-1";
const OTHER_ORG = "org-example-2";
const THREAD = "thread-example-0001";
const RUN_1 = "run-example-0001";
const RUN_2 = "run-example-0002";
const WORKFLOW_1 = `agui-run-${RUN_1}`;

const me = { userId: USER, organizationId: ORG };

const SETTINGS: AgUiRunSettings = {
	modelHints: { model: "example-model", provider: "openai" },
	aiToken: "route-minted-ai-token",
};

/**
 * CopilotKit's in-process runner, as the fallback sees it: records what it
 * was asked to run or reattach, and answers with `inProcessEvents`.
 */
class FakeInProcessRunner extends AgentRunner {
	readonly runs: AgentRunnerRunRequest[] = [];
	readonly connects: AgentRunnerConnectRequest[] = [];
	run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
		this.runs.push(request);
		return of(...inProcessEvents(request.input.runId));
	}
	connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
		this.connects.push(request);
		return of(...connectEvents);
	}
	async isRunning(_request: AgentRunnerIsRunningRequest): Promise<boolean> {
		return false;
	}
	async stop(_request: AgentRunnerStopRequest): Promise<boolean> {
		return false;
	}
}

/** What the in-process runner answers a run with. */
function inProcessEvents(runId: string): BaseEvent[] {
	return runEvents(runId, "in-process-answer");
}

/** What the in-process runner replays on a connect. */
let connectEvents: BaseEvent[] = [];

let inProcess = new FakeInProcessRunner();

const AGENT = new FabricRuntimeAgent();
AGENT.agentId = "project_document_generator";

function engine(
	caller: { userId: string; organizationId: string } = me,
	pickupTimeoutMs = 2000,
) {
	return new AgUiAgentEngine(caller, SETTINGS, {
		inProcess,
		pickupTimeoutMs,
	});
}

function input(runId: string): RunAgentInput {
	return {
		threadId: THREAD,
		runId,
		messages: [
			{
				id: `${runId}:question`,
				role: "user",
				content: "Draft the scope",
			},
		],
		tools: [],
		context: [],
		state: { document: "The whole document, which never enters Temporal" },
		forwardedProps: {},
	};
}

/** One run's events as the worker writes them, ending with RUN_FINISHED. */
function runEvents(runId: string, answerId: string): BaseEvent[] {
	return [
		{
			type: EventType.RUN_STARTED,
			threadId: THREAD,
			runId,
			input: {
				threadId: THREAD,
				runId,
				messages: input(runId).messages,
				tools: [],
				context: [],
				state: {},
				forwardedProps: {},
			},
		},
		{
			type: EventType.TEXT_MESSAGE_START,
			messageId: answerId,
			role: "assistant",
		},
		{
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: answerId,
			delta: "Here is the scope.",
		},
		{ type: EventType.TEXT_MESSAGE_END, messageId: answerId },
		{ type: EventType.RUN_FINISHED, threadId: THREAD, runId },
	];
}

function seedEvents(runId: string, events: BaseEvent[]): void {
	for (const event of events) {
		w.appendEvent(runId, event);
	}
}

function isAguiEvent(event: AGUIEvent): boolean {
	return EventSchemas.safeParse(event).success;
}

/** A response: what was emitted, closing after `closeAfter` events if set. */
function response(options: { windowMs?: number; closeAfter?: number } = {}) {
	const emitted: AGUIEvent[] = [];
	const stream: RunStream = {
		emit: (event) => {
			emitted.push(event);
		},
		isClosed: () =>
			options.closeAfter !== undefined &&
			emitted.length >= options.closeAfter,
		deadline: Date.now() + (options.windowMs ?? 60_000),
	};
	return { stream, emitted };
}

function valid(emitted: AGUIEvent[]): AGUIEvent[] {
	expect(emitted.filter(isAguiEvent)).toHaveLength(emitted.length);
	return emitted;
}

const types = (list: AGUIEvent[]) => list.map((event) => event.type);

function errorCode(list: AGUIEvent[]) {
	const error = list.find((event) => event.type === EventType.RUN_ERROR);
	return error?.type === EventType.RUN_ERROR ? error.code : undefined;
}

async function runOnce(
	runId: string,
	options: {
		caller?: { userId: string; organizationId: string };
		windowMs?: number;
		closeAfter?: number;
		pickupTimeoutMs?: number;
	} = {},
): Promise<AGUIEvent[]> {
	const { stream, emitted } = response(options);
	await engine(options.caller, options.pickupTimeoutMs).run(
		{ threadId: THREAD, input: input(runId), agent: AGENT },
		stream,
	);
	return valid(emitted);
}

async function connectOnce(
	caller: { userId: string; organizationId: string } = me,
): Promise<AGUIEvent[]> {
	const { stream, emitted } = response();
	await engine(caller).connect(THREAD, stream);
	return valid(emitted);
}

/**
 * Start RUN_1 live: the response closes after its first events (the engine
 * holds a new run's RUN_STARTED until the event after it).
 */
async function startLiveRun(): Promise<void> {
	seedEvents(RUN_1, runEvents(RUN_1, "answer-1").slice(0, 2));
	await runOnce(RUN_1, { closeAfter: 1 });
	expect(w.state.workflows.get(WORKFLOW_1)?.status).toBe("RUNNING");
}

beforeEach(() => {
	w.reset();
	vi.mocked(openAgUiRunStore).mockClear();
	inProcess = new FakeInProcessRunner();
	connectEvents = [];
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgUiAgentEngine — run", () => {
	it("starts the run's workflow once, by reference, and streams its events verbatim to the terminal one", async () => {
		const events = runEvents(RUN_1, "answer-1");
		seedEvents(RUN_1, events);
		w.appendEvent(RUN_1, {
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "answer-1",
			delta: "after the terminal event",
		});

		const emitted = await runOnce(RUN_1);

		expect(emitted).toEqual(events);
		expect(w.state.starts).toHaveLength(1);
		const [{ workflowType, options }] = w.state.starts;
		expect(workflowType).toBe("agUiAgentRunWorkflow");
		expect(options).toMatchObject({
			taskQueue: "agui-runs",
			workflowId: WORKFLOW_1,
			memo: { userId: USER, organizationId: ORG, threadId: THREAD },
			retry: { maximumAttempts: 1 },
			workflowIdReusePolicy: "REJECT_DUPLICATE",
		});
		expect(options.args).toEqual([
			{
				runId: RUN_1,
				threadId: THREAD,
				agentName: "project_document_generator",
				userId: USER,
				organizationId: ORG,
				inputRef: `agui:run:${RUN_1}:input`,
				modelHints: SETTINGS.modelHints,
			},
		]);
		expect(JSON.stringify(options)).not.toContain("whole document");
		// The request's token goes to the worker in the input record only.
		expect(JSON.stringify(options)).not.toContain(SETTINGS.aiToken);
		expect(w.state.inputs.get(`agui:run:${RUN_1}:input`)).toEqual({
			input: input(RUN_1),
			aiToken: SETTINGS.aiToken,
		});
		expect(w.state.threads.get(THREAD)).toEqual({
			userId: USER,
			organizationId: ORG,
			latestRunId: RUN_1,
			workflowId: WORKFLOW_1,
		});
		expect(w.state.openStores).toBe(0);
	});

	it("tails events the worker appends while the response is open", async () => {
		const events = runEvents(RUN_1, "answer-1");
		const pending = runOnce(RUN_1);
		await vi.waitFor(() => expect(w.state.starts).toHaveLength(1));

		seedEvents(RUN_1, events);

		await expect(pending).resolves.toEqual(events);
	});

	it("attaches a retried run id to its workflow instead of running the agent again", async () => {
		const events = runEvents(RUN_1, "answer-1");
		seedEvents(RUN_1, events);
		await runOnce(RUN_1);

		const retried = await runOnce(RUN_1);

		expect(w.state.starts).toHaveLength(1);
		expect(retried).toEqual(events);
	});

	it("refuses a run id whose workflow is another caller's run", async () => {
		w.state.workflows.set(WORKFLOW_1, {
			status: "RUNNING",
			memo: {
				userId: OTHER_USER,
				organizationId: ORG,
				threadId: "thread-example-0009",
			},
			args: [],
		});
		seedEvents(RUN_1, runEvents(RUN_1, "their-answer"));

		const emitted = await runOnce(RUN_1);

		expect(emitted).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "FORBIDDEN",
			}),
		]);
		expect(w.state.starts).toHaveLength(0);
		expect(w.state.threads.has(THREAD)).toBe(false);
	});

	it("refuses a second run while the thread's run is still live", async () => {
		await startLiveRun();

		const emitted = await runOnce(RUN_2);

		expect(errorCode(emitted)).toBe("THREAD_ALREADY_RUNNING");
		expect(w.state.starts).toHaveLength(1);
		expect(w.state.threads.get(THREAD)?.latestRunId).toBe(RUN_1);
	});

	it("starts the next run once the thread's run has finished", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1"));
		await runOnce(RUN_1);
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");
		const events = runEvents(RUN_2, "answer-2");
		seedEvents(RUN_2, events);

		await expect(runOnce(RUN_2)).resolves.toEqual(events);
		expect(w.state.starts).toHaveLength(2);
		expect(w.state.threads.get(THREAD)?.latestRunId).toBe(RUN_2);
	});

	it("leaves the workflow running when the response closes", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1").slice(0, 2));

		const emitted = await runOnce(RUN_1, { closeAfter: 1 });

		expect(types(emitted)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
		]);
		expect(w.state.workflows.get(WORKFLOW_1)?.status).toBe("RUNNING");
		expect(w.state.cancels).toEqual([]);
	});

	it("ends a response at the window's end with fabric.reconnect and leaves the workflow running", async () => {
		w.appendEvent(RUN_1, runEvents(RUN_1, "answer-1")[0]);

		const emitted = await runOnce(RUN_1, { windowMs: 30 });

		expect(emitted.at(-1)).toEqual({
			type: EventType.CUSTOM,
			name: "fabric.reconnect",
			value: { runId: RUN_1 },
		});
		expect(types(emitted)).not.toContain(EventType.RUN_FINISHED);
		expect(w.state.workflows.get(WORKFLOW_1)?.status).toBe("RUNNING");
		expect(w.state.cancels).toEqual([]);
	});

	it("ends the response with RUN_ENDED when the workflow ends without a terminal event", async () => {
		w.appendEvent(RUN_1, runEvents(RUN_1, "answer-1")[0]);
		const pending = runOnce(RUN_1);
		await vi.waitFor(() => expect(w.state.starts).toHaveLength(1));

		w.settleWorkflow(WORKFLOW_1, "FAILED");

		const emitted = await pending;
		expect(types(emitted)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_ERROR,
		]);
		expect(errorCode(emitted)).toBe("RUN_ENDED");
	});

	it("refuses a run id that cannot name a workflow", async () => {
		const emitted = await runOnce("bad id");

		expect(errorCode(emitted)).toBe("INVALID_RUN");
		expect(w.state.starts).toHaveLength(0);
	});
});

describe("AgUiAgentEngine — in-process fallback", () => {
	/** The request's own agent and input went to the in-process runner. */
	function expectRanInProcess(emitted: AGUIEvent[], runId = RUN_1) {
		expect(inProcess.runs).toHaveLength(1);
		expect(inProcess.runs[0]).toEqual({
			threadId: THREAD,
			agent: AGENT,
			input: input(runId),
		});
		expect(emitted).toEqual(inProcessEvents(runId));
		expect(w.state.threads.has(THREAD)).toBe(false);
	}

	it("runs the agent in-process when Redis is unavailable", async () => {
		vi.mocked(openAgUiRunStore).mockRejectedValueOnce(
			new Error("Durable AG-UI runs need Redis"),
		);

		const emitted = await runOnce(RUN_1);

		expectRanInProcess(emitted);
		expect(w.state.starts).toHaveLength(0);
	});

	it("still refuses someone else's conversation when Redis is unavailable", async () => {
		vi.mocked(openAgUiRunStore).mockRejectedValueOnce(
			new Error("Durable AG-UI runs need Redis"),
		);
		w.state.conversations.set(THREAD, {
			userId: OTHER_USER,
			organizationId: ORG,
			messages: [],
		});

		expect(errorCode(await runOnce(RUN_1))).toBe("FORBIDDEN");
		expect(inProcess.runs).toHaveLength(0);
	});

	it("runs the agent in-process when the input cannot be parked", async () => {
		vi.mocked(openAgUiRunStore).mockResolvedValueOnce(
			w.storeWith({
				writeInput: async () => {
					throw new Error("OOM command not allowed");
				},
			}),
		);

		const emitted = await runOnce(RUN_1);

		expectRanInProcess(emitted);
		expect(w.state.starts).toHaveLength(0);
		expect(w.state.openStores).toBe(0);
	});

	it("runs the agent in-process when the workflow cannot be started", async () => {
		w.state.startError = new Error("14 UNAVAILABLE: connection refused");

		const emitted = await runOnce(RUN_1);

		expectRanInProcess(emitted);
		expect(w.state.workflows.size).toBe(0);
	});

	it("terminates a run no worker picked up in time and runs the agent in-process", async () => {
		const emitted = await runOnce(RUN_1, { pickupTimeoutMs: 30 });

		expect(w.state.starts).toHaveLength(1);
		expect(w.state.terminates).toEqual([WORKFLOW_1]);
		expect(w.state.workflows.get(WORKFLOW_1)?.status).toBe("TERMINATED");
		expectRanInProcess(emitted);
	});

	it("never falls back once the durable run has emitted an event", async () => {
		w.appendEvent(RUN_1, runEvents(RUN_1, "answer-1")[0]);
		const pending = runOnce(RUN_1, { pickupTimeoutMs: 30 });
		await vi.waitFor(() => expect(w.state.starts).toHaveLength(1));
		w.settleWorkflow(WORKFLOW_1, "FAILED");

		const emitted = await pending;

		expect(types(emitted)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_ERROR,
		]);
		expect(errorCode(emitted)).toBe("RUN_ENDED");
		expect(inProcess.runs).toHaveLength(0);
		expect(w.state.terminates).toEqual([]);
	});

	it("never falls back when Redis fails mid-stream", async () => {
		let reads = 0;
		const [started, answerStart] = runEvents(RUN_1, "answer-1");
		vi.mocked(openAgUiRunStore).mockResolvedValueOnce(
			w.storeWith({
				readEvents: async () => {
					reads += 1;
					// The pickup check, then the tail's first read.
					if (reads <= 2) {
						return [
							{ id: "1-0", event: started },
							{ id: "2-0", event: answerStart },
						];
					}
					throw new Error("Connection is closed.");
				},
			}),
		);
		const { stream, emitted } = response();

		await expect(
			engine().run(
				{ threadId: THREAD, input: input(RUN_1), agent: AGENT },
				stream,
			),
		).rejects.toThrow("Connection is closed.");

		expect(types(emitted)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
		]);
		expect(inProcess.runs).toHaveLength(0);
		expect(w.state.terminates).toEqual([]);
	});

	it("runs the turn in-process when the worker fails the run's setup, and the client sees only that run", async () => {
		const pending = runOnce(RUN_1);
		await vi.waitFor(() => expect(w.state.starts).toHaveLength(1));
		w.appendEvent(RUN_1, runEvents(RUN_1, "answer-1")[0]);
		w.appendEvent(RUN_1, {
			type: EventType.RUN_ERROR,
			message: "AGENT_API_KEY is not set on the worker",
			code: AGUI_RUN_SETUP_FAILED_CODE,
		});
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");

		const emitted = await pending;

		// Neither the held RUN_STARTED nor the setup failure reached the
		// client: one clean run, the in-process one.
		expect(emitted).toEqual(inProcessEvents(RUN_1));
		expect(inProcess.runs).toEqual([
			{ threadId: THREAD, agent: AGENT, input: input(RUN_1) },
		]);
		expect(console.warn).toHaveBeenCalledWith(
			"[Agent Runtime] Durable run unavailable; running the agent in-process",
			{
				runId: RUN_1,
				reason: "worker setup failed: AGENT_API_KEY is not set on the worker",
			},
		);
		expect(w.state.terminates).toEqual([]);
		// The failed durable run has nothing to replay: a reattach goes to
		// the in-process runner, which ran the turn.
		await connectOnce();
		expect(inProcess.connects).toHaveLength(1);
	});

	it("forwards an agent error after real output, and does not fall back", async () => {
		const [started, answerStart, answerContent] = runEvents(
			RUN_1,
			"answer-1",
		);
		const agentFailed: BaseEvent = {
			type: EventType.RUN_ERROR,
			message: "socket hang up",
			code: "AGENT_RUN_FAILED",
		};
		const events = [
			started,
			answerStart,
			answerContent,
			{ type: EventType.TEXT_MESSAGE_END, messageId: "answer-1" },
			agentFailed,
		];
		const pending = runOnce(RUN_1);
		await vi.waitFor(() => expect(w.state.starts).toHaveLength(1));
		seedEvents(RUN_1, events);

		await expect(pending).resolves.toEqual(events);
		expect(inProcess.runs).toHaveLength(0);
	});

	it("forwards an agent's own error that follows RUN_STARTED, and does not fall back", async () => {
		const events: BaseEvent[] = [
			runEvents(RUN_1, "answer-1")[0],
			{
				type: EventType.RUN_ERROR,
				message: "The model refused",
				code: "MODEL_ERROR",
			},
		];
		seedEvents(RUN_1, events);

		await expect(runOnce(RUN_1)).resolves.toEqual(events);
		expect(inProcess.runs).toHaveLength(0);
	});

	it("answers isRunning and stop with false when Redis is unavailable, leaving them to the in-process runner", async () => {
		vi.mocked(openAgUiRunStore)
			.mockRejectedValueOnce(new Error("Durable AG-UI runs need Redis"))
			.mockRejectedValueOnce(new Error("Durable AG-UI runs need Redis"));

		await expect(engine().isRunning(THREAD)).resolves.toBe(false);
		await expect(engine().stop(THREAD)).resolves.toBe(false);
	});
});

describe("AgUiAgentEngine — connect", () => {
	it("replays a live run from its start and tails it to the terminal event", async () => {
		const events = runEvents(RUN_1, "answer-1");
		seedEvents(RUN_1, events.slice(0, 2));
		await runOnce(RUN_1, { closeAfter: 1 });

		const { stream, emitted } = response();
		const pending = engine().connect(THREAD, stream);
		await vi.waitFor(() => expect(emitted).toHaveLength(2));
		seedEvents(RUN_1, events.slice(2));
		await pending;

		expect(valid(emitted)).toEqual(events);
	});

	it("replays a finished run whose answer is not saved yet, without the saved messages", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1"));
		await runOnce(RUN_1);
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");
		w.state.conversations.set(THREAD, {
			...me,
			messages: [{ id: `${RUN_1}:question` }],
		});

		const emitted = await connectOnce();

		expect(types(emitted)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		const [started] = emitted;
		expect(
			started.type === EventType.RUN_STARTED
				? started.input?.messages
				: null,
		).toEqual([]);
	});

	it("replays nothing durable for a finished run whose answer is saved", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1"));
		await runOnce(RUN_1);
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");
		w.state.conversations.set(THREAD, {
			...me,
			messages: [{ id: `${RUN_1}:question` }, { id: "answer-1" }],
		});

		await expect(connectOnce()).resolves.toEqual([]);
		// Whatever this thread ran in-process is the in-process runner's.
		expect(inProcess.connects).toEqual([
			{ threadId: THREAD, agentId: "project_document_generator" },
		]);
	});

	it("replays nothing durable when the answer was saved in a continuation after a spill", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1"));
		await runOnce(RUN_1);
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");
		// The thread's conversation hit the turn cap; the page went on saving
		// into its continuation, under the same thread id.
		w.state.conversations.set(THREAD, {
			...me,
			messages: [{ id: "earlier-turn" }],
		});
		w.state.conversations.set("conv-example-continuation", {
			...me,
			parentConversationId: THREAD,
			messages: [{ id: `${RUN_1}:question` }, { id: "answer-1" }],
		});

		await expect(connectOnce()).resolves.toEqual([]);
	});

	it("still replays a run whose answer only someone else's continuation holds", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1"));
		await runOnce(RUN_1);
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");
		w.state.conversations.set(THREAD, { ...me, messages: [] });
		w.state.conversations.set("conv-example-foreign", {
			userId: OTHER_USER,
			organizationId: ORG,
			parentConversationId: THREAD,
			messages: [{ id: "answer-1" }],
		});

		expect(types(await connectOnce())).toContain(EventType.RUN_FINISHED);
	});

	it("leaves a thread with no durable run to the in-process runner, as before", async () => {
		connectEvents = inProcessEvents(RUN_1);

		await expect(connectOnce()).resolves.toEqual(inProcessEvents(RUN_1));
		expect(inProcess.connects).toEqual([
			{ threadId: THREAD, agentId: "project_document_generator" },
		]);
	});

	it("leaves the connect to the in-process runner when Redis is unavailable", async () => {
		vi.mocked(openAgUiRunStore).mockRejectedValueOnce(
			new Error("Durable AG-UI runs need Redis"),
		);

		await expect(connectOnce()).resolves.toEqual([]);
		expect(inProcess.connects).toHaveLength(1);
	});

	it("does not ask the in-process runner while a durable run is replayed", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1"));
		await runOnce(RUN_1);
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");

		await connectOnce();

		expect(inProcess.connects).toEqual([]);
	});
});

describe("AgUiAgentEngine — someone else's thread", () => {
	const foreignCallers = [
		["another user", { userId: OTHER_USER, organizationId: ORG }],
		[
			"the caller in another organization",
			{ userId: USER, organizationId: OTHER_ORG },
		],
	] as const;

	describe.each(foreignCallers)("whose run record names %s", (_, owner) => {
		beforeEach(() => {
			w.state.threads.set(THREAD, {
				...owner,
				latestRunId: RUN_1,
				workflowId: WORKFLOW_1,
			});
			w.state.workflows.set(WORKFLOW_1, {
				status: "RUNNING",
				memo: { ...owner, threadId: THREAD },
				args: [],
			});
			w.appendEvent(RUN_1, runEvents(RUN_1, "their-answer")[0]);
		});

		it("refuses run, connect and stop, and the route guard refuses it", async () => {
			const ran = await runOnce(RUN_2);
			const connected = await connectOnce();
			const stopped = await engine().stop(THREAD);

			expect(errorCode(ran)).toBe("FORBIDDEN");
			expect(errorCode(connected)).toBe("FORBIDDEN");
			expect(types(connected)).toEqual([EventType.RUN_ERROR]);
			expect(stopped).toBe(false);
			await expect(engine().isRunning(THREAD)).resolves.toBe(false);
			await expect(engine().refusesThread(THREAD)).resolves.toBe(true);
			expect(w.state.starts).toHaveLength(0);
			expect(w.state.cancels).toEqual([]);
			expect(w.state.threads.get(THREAD)?.userId).toBe(owner.userId);
		});
	});

	it("refuses a thread that names another user's conversation", async () => {
		w.state.conversations.set(THREAD, {
			userId: OTHER_USER,
			organizationId: ORG,
			messages: [],
		});

		expect(errorCode(await runOnce(RUN_1))).toBe("FORBIDDEN");
		expect(errorCode(await connectOnce())).toBe("FORBIDDEN");
		await expect(engine().stop(THREAD)).resolves.toBe(false);
		await expect(engine().refusesThread(THREAD)).resolves.toBe(true);
		expect(w.state.starts).toHaveLength(0);
	});

	it("does not refuse the caller's own thread", async () => {
		w.state.conversations.set(THREAD, { ...me, messages: [] });
		await startLiveRun();

		await expect(engine().refusesThread(THREAD)).resolves.toBe(false);
		await expect(engine().isRunning(THREAD)).resolves.toBe(true);
	});
});

describe("AgUiAgentEngine — stop", () => {
	it("cancels the workflow of the caller's live run", async () => {
		await startLiveRun();

		await expect(engine().stop(THREAD, RUN_2)).resolves.toBe(false);
		await expect(engine().stop(THREAD, RUN_1)).resolves.toBe(true);

		expect(w.state.cancels).toEqual([WORKFLOW_1]);
		await expect(engine().isRunning(THREAD)).resolves.toBe(false);
	});

	it("does nothing for a run that has already finished", async () => {
		seedEvents(RUN_1, runEvents(RUN_1, "answer-1"));
		await runOnce(RUN_1);
		w.settleWorkflow(WORKFLOW_1, "COMPLETED");

		await expect(engine().stop(THREAD)).resolves.toBe(false);
		expect(w.state.cancels).toEqual([]);
	});
});
