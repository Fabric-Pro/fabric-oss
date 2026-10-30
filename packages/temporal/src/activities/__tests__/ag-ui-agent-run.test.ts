/**
 * `runAgUiAgentActivity`: one durable AG-UI agent run on the worker.
 *
 *   - the `RunAgentInput` and the AI token the route minted are taken by
 *     reference from the run store, which deletes the record as it is read;
 *     the workflow input carries no secret at all (checked at the type level
 *     below), and the worker never mints a token;
 *   - the agent gets the headers `/api/copilotkit` sends: this worker's
 *     `AGENT_API_KEY`, the route's token, the tenant ids and the route's
 *     model hints;
 *   - the agent gets the run input as parked, server-only `forwardedProps`
 *     included; the stream, which the browser replays, carries none of them;
 *   - every event goes to the run's stream, and the stream ends with exactly
 *     one terminal event on success, on the agent's own error, on a thrown
 *     error and on a cancellation;
 *   - a failure before the agent's first event ends with
 *     `AGUI_RUN_SETUP_FAILED`, so the web runtime can still run the turn in
 *     the request.
 *
 * The run store and the agent are fakes; the store records what the activity
 * appended, in order.
 */
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";
import {
	AGUI_RUN_SETUP_FAILED_CODE,
	type AgUiAgentRunWorkflowInput,
	type AgUiRunInputRecord,
	type AgUiRunStore,
	type AgUiThreadRecord,
	type StoredRunEvent,
} from "../../lib/agui-run-stream";

interface Observer {
	next: (event: BaseEvent) => void;
	error: (error: unknown) => void;
	complete: () => void;
}

const h = vi.hoisted(() => ({
	issueAIToken: vi.fn(),
	openAgUiRunStore: vi.fn(),
	agents: [] as Array<{
		options: { url: string; headers: Record<string, string> };
		input?: unknown;
		observer?: Observer;
		unsubscribed: boolean;
		aborted: boolean;
	}>,
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	issueAIToken: h.issueAIToken,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/agui-run-stream", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/agui-run-stream")>()),
	openAgUiRunStore: h.openAgUiRunStore,
}));

/** The agent: records its options and hands the test its observer. */
vi.mock("@ag-ui/langgraph", () => ({
	LangGraphHttpAgent: class {
		private readonly record: (typeof h.agents)[number];
		constructor(options: { url: string; headers: Record<string, string> }) {
			this.record = { options, unsubscribed: false, aborted: false };
			h.agents.push(this.record);
		}
		run(input: unknown) {
			this.record.input = input;
			return {
				subscribe: (observer: Observer) => {
					this.record.observer = observer;
					return {
						unsubscribe: () => {
							this.record.unsubscribed = true;
						},
					};
				},
			};
		}
		abortRun() {
			this.record.aborted = true;
		}
	},
}));

const { runAgUiAgentActivity } = await import("../ag-ui-agent-run");

const RUN = "run-example-0001";
const THREAD = "thread-example-0001";
const INPUT_REF = `agui:run:${RUN}:input`;
const ROUTE_TOKEN = "route-minted-ai-token";

const RUN_INPUT: RunAgentInput = {
	threadId: THREAD,
	runId: RUN,
	protocolVersion: "1.0.0",
	state: { document: "# A long document the state carries" },
	messages: [{ id: "user-1", role: "user", content: "Tighten the intro" }],
	tools: [],
	context: [],
	forwardedProps: {},
};

const RECORD: AgUiRunInputRecord = { input: RUN_INPUT, aiToken: ROUTE_TOKEN };

const WORKFLOW_INPUT: AgUiAgentRunWorkflowInput = {
	runId: RUN,
	threadId: THREAD,
	agentName: "project_document_generator",
	userId: "user-example-1",
	organizationId: "org-example-1",
	inputRef: INPUT_REF,
	modelHints: {
		model: "example-model",
		provider: "OPENAI",
		baseUrl: "https://gateway.example.com/v1",
		isReasoning: false,
	},
};

/**
 * The run store, in memory: what the activity took and appended. `takeInput`
 * deletes the record as the Redis store does.
 */
function memoryStore(record: AgUiRunInputRecord | null) {
	const inputs = new Map<string, AgUiRunInputRecord>();
	if (record) {
		inputs.set(INPUT_REF, record);
	}
	const appended: BaseEvent[] = [];
	let closed = false;
	const store: AgUiRunStore = {
		writeInput: async () => INPUT_REF,
		takeInput: async (ref) => {
			const taken = inputs.get(ref) ?? null;
			inputs.delete(ref);
			return taken;
		},
		appendEvent: async (runId, event) => {
			expect(runId).toBe(RUN);
			appended.push(event);
		},
		readEvents: async (): Promise<StoredRunEvent[]> => [],
		readLastEvent: async () => null,
		writeThread: async (_threadId: string, _record: AgUiThreadRecord) =>
			undefined,
		readThread: async () => null,
		close: async () => {
			closed = true;
		},
	};
	return { store, inputs, appended, isClosed: () => closed };
}

function terminals(events: BaseEvent[]): BaseEvent[] {
	return events.filter(
		(event) =>
			event.type === EventType.RUN_FINISHED ||
			event.type === EventType.RUN_ERROR,
	);
}

/** Start the activity and wait for the agent to be subscribed to. */
async function startRun(
	record: AgUiRunInputRecord | null = RECORD,
	workflowInput: AgUiAgentRunWorkflowInput = WORKFLOW_INPUT,
) {
	const memory = memoryStore(record);
	h.openAgUiRunStore.mockResolvedValue(memory.store);
	const env = new MockActivityEnvironment();
	const settled = env.run(runAgUiAgentActivity, workflowInput).then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	return { env, settled, ...memory };
}

async function agentObserver(): Promise<Observer> {
	await vi.waitFor(() => expect(h.agents[0]?.observer).toBeDefined());
	const observer = h.agents[0]?.observer;
	if (!observer) {
		throw new Error("the agent was never subscribed to");
	}
	return observer;
}

const STARTED: BaseEvent = {
	type: EventType.RUN_STARTED,
	threadId: THREAD,
	runId: RUN,
};

function setupFailed(message: string): BaseEvent {
	return {
		type: EventType.RUN_ERROR,
		message,
		code: AGUI_RUN_SETUP_FAILED_CODE,
	};
}

beforeEach(() => {
	h.agents.length = 0;
	h.issueAIToken.mockReset().mockResolvedValue("worker-minted-ai-token");
	h.openAgUiRunStore.mockReset();
	vi.stubEnv("AGENT_API_KEY", "worker-agent-api-key");
	vi.stubEnv(
		"PROJECT_DOCUMENT_GENERATOR_URL",
		"http://project-document-generator.example:8125",
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the workflow input", () => {
	it("carries ids, a reference and hints — no token, key or document", () => {
		expectTypeOf<keyof AgUiAgentRunWorkflowInput>().toEqualTypeOf<
			| "runId"
			| "threadId"
			| "agentName"
			| "userId"
			| "organizationId"
			| "inputRef"
			| "modelHints"
		>();
		expectTypeOf<
			keyof AgUiAgentRunWorkflowInput["modelHints"]
		>().toEqualTypeOf<
			"model" | "provider" | "baseUrl" | "deploymentName" | "isReasoning"
		>();
	});
});

describe("runAgUiAgentActivity", () => {
	it("runs the agent on the record it takes by reference, with the route's token and headers", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		observer.complete();
		await run.settled;

		const agent = h.agents[0];
		expect(agent?.input).toEqual(RUN_INPUT);
		expect(agent?.options.url).toBe(
			"http://project-document-generator.example:8125",
		);
		expect(agent?.options.headers).toEqual({
			"X-AI-Is-Reasoning": "false",
			Authorization: "Bearer worker-agent-api-key",
			"X-Tenant-User-ID": "user-example-1",
			"X-Tenant-Organization-ID": "org-example-1",
			"X-AI-Token": ROUTE_TOKEN,
			"X-AI-Model": "example-model",
			"X-AI-Base-URL": "https://gateway.example.com/v1",
			"X-AI-Provider": "OPENAI",
		});
		// The worker holds no signing secret and mints nothing.
		expect(h.issueAIToken).not.toHaveBeenCalled();
		// The record (and its bearer token) left Redis on pickup.
		expect(run.inputs.size).toBe(0);
		expect(run.isClosed()).toBe(true);
	});

	it("hands the agent the server-only forwardedProps the route wrote, and stores none of them", async () => {
		// The Proposal chat's prompt and settled decisions, which the web route
		// writes into the run input and the browser must never read back.
		const prompt = "Write for the client reader and keep every heading.";
		const input: RunAgentInput = {
			...RUN_INPUT,
			forwardedProps: {
				proposal_mode: "artifact",
				proposal_client_prompt: prompt,
				proposal_settled_block: "- Hosting: the client hosts it",
				proposal_viewer: "member",
			},
		};
		const run = await startRun({ ...RECORD, input });
		const observer = await agentObserver();
		// An agent that echoes its run input on its own RUN_STARTED.
		observer.next({ ...STARTED, input });
		observer.next({
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
		});
		observer.complete();
		await run.settled;

		expect(h.agents[0]?.input).toEqual(input);
		const stored = JSON.stringify(run.appended);
		expect(stored).not.toContain(prompt);
		expect(stored).not.toContain("proposal_");
		expect(stored).not.toContain("the client hosts it");
	});

	it("stores the agent's events in order and ends on its RUN_FINISHED", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		const finished: BaseEvent = {
			type: EventType.RUN_FINISHED,
			threadId: THREAD,
			runId: RUN,
		};
		observer.next(STARTED);
		observer.next({
			type: EventType.TEXT_MESSAGE_START,
			messageId: "answer-1",
			role: "assistant",
		});
		observer.next({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "answer-1",
			delta: "Done.",
		});
		observer.next({
			type: EventType.TEXT_MESSAGE_END,
			messageId: "answer-1",
		});
		observer.next(finished);
		observer.complete();

		await expect(run.settled).resolves.toEqual({
			value: { outcome: "finished", events: 5 },
		});
		expect(run.appended.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		expect(run.appended.at(-1)).toEqual(finished);
		expect(terminals(run.appended)).toHaveLength(1);
		// A reattaching client learns the question from RUN_STARTED, as
		// CopilotKit's own runner sends it; the document state stays out.
		expect(run.appended[0]).toEqual({
			...STARTED,
			input: {
				threadId: THREAD,
				runId: RUN,
				state: {},
				messages: RUN_INPUT.messages,
				tools: [],
				context: [],
				forwardedProps: {},
			},
		});
	});

	it("keeps the agent's own RUN_ERROR as the one terminal event", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		const agentError: BaseEvent = {
			type: EventType.RUN_ERROR,
			message: "The model refused",
			code: "MODEL_ERROR",
		};
		observer.next(STARTED);
		observer.next(agentError);
		// Nothing after the terminal event reaches the stream.
		observer.next({
			type: EventType.TEXT_MESSAGE_START,
			messageId: "late",
			role: "assistant",
		});
		observer.complete();

		await expect(run.settled).resolves.toEqual({
			value: { outcome: "error", events: 2 },
		});
		expect(terminals(run.appended)).toEqual([agentError]);
		expect(run.appended.at(-1)).toEqual(agentError);
	});

	it("closes the open message and ends with AGENT_RUN_FAILED when the agent throws after its output", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		observer.next(STARTED);
		observer.next({
			type: EventType.TEXT_MESSAGE_START,
			messageId: "answer-1",
			role: "assistant",
		});
		observer.error(new Error("socket hang up"));

		await expect(run.settled).resolves.toEqual({
			value: { outcome: "error", events: 4 },
		});
		expect(run.appended.slice(2)).toEqual([
			{ type: EventType.TEXT_MESSAGE_END, messageId: "answer-1" },
			{
				type: EventType.RUN_ERROR,
				message: "socket hang up",
				code: "AGENT_RUN_FAILED",
			},
		]);
		expect(terminals(run.appended)).toHaveLength(1);
	});

	it("ends a stream that stopped without a terminal event with one RUN_ERROR", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		observer.next(STARTED);
		observer.complete();

		await run.settled;
		expect(terminals(run.appended)).toEqual([
			{
				type: EventType.RUN_ERROR,
				message: "Run ended without emitting a terminal event",
				code: "INCOMPLETE_STREAM",
			},
		]);
	});

	it("on cancellation aborts the agent, ends with a cancelled RUN_FINISHED and reports the cancellation", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		observer.next(STARTED);
		observer.next({
			type: EventType.TOOL_CALL_START,
			toolCallId: "call-1",
			toolCallName: "search_project_knowledge",
		});
		await vi.waitFor(() => expect(run.appended).toHaveLength(2));
		run.env.cancel();

		const settled = await run.settled;
		expect("error" in settled && settled.error).toBeInstanceOf(
			CancelledFailure,
		);
		expect(h.agents[0]?.unsubscribed).toBe(true);
		expect(h.agents[0]?.aborted).toBe(true);
		expect(run.appended.slice(2)).toEqual([
			{ type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
			{
				type: EventType.RUN_FINISHED,
				threadId: THREAD,
				runId: RUN,
				outcome: { type: "cancelled" },
			},
		]);
		expect(terminals(run.appended)).toHaveLength(1);
		expect(run.isClosed()).toBe(true);
	});

	it("opens the run with RUN_STARTED before calling the agent", async () => {
		const run = await startRun();
		await agentObserver();

		// The web runtime reads this first event as the worker's pickup.
		expect(run.appended).toHaveLength(1);
		expect(run.appended[0]).toMatchObject(STARTED);
		h.agents[0]?.observer?.complete();
		await run.settled;
	});
});

describe("runAgUiAgentActivity setup failures", () => {
	it("ends with AGUI_RUN_SETUP_FAILED and never calls the agent when the input record is gone", async () => {
		const run = await startRun(null);

		await expect(run.settled).resolves.toEqual({
			value: { outcome: "error", events: 2 },
		});
		expect(h.agents).toHaveLength(0);
		expect(h.issueAIToken).not.toHaveBeenCalled();
		expect(run.appended).toEqual([
			STARTED,
			setupFailed(
				"The run's input expired or was already taken before the run could start",
			),
		]);
	});

	it("treats another run's record as gone", async () => {
		const run = await startRun({
			...RECORD,
			input: { ...RUN_INPUT, runId: "run-example-0002" },
		});

		await run.settled;
		expect(h.agents).toHaveLength(0);
		expect(terminals(run.appended)).toEqual([
			setupFailed(
				"The run's input expired or was already taken before the run could start",
			),
		]);
	});

	it("ends with AGUI_RUN_SETUP_FAILED when the worker has no AGENT_API_KEY", async () => {
		vi.stubEnv("AGENT_API_KEY", "");
		const run = await startRun();

		await expect(run.settled).resolves.toEqual({
			value: { outcome: "error", events: 2 },
		});
		expect(h.agents).toHaveLength(0);
		expect(run.appended.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_ERROR,
		]);
		expect(terminals(run.appended)).toEqual([
			setupFailed("AGENT_API_KEY is not set on the worker"),
		]);
		// Taken all the same: the token does not wait out its TTL in Redis.
		expect(run.inputs.size).toBe(0);
	});

	it("ends with AGUI_RUN_SETUP_FAILED when no agent URL resolves", async () => {
		vi.stubEnv("DOCUMENT_GENERATOR_URL", "");
		const run = await startRun(RECORD, {
			...WORKFLOW_INPUT,
			agentName: "document_generator",
		});

		await run.settled;
		expect(h.agents).toHaveLength(0);
		expect(terminals(run.appended)).toEqual([
			setupFailed('No agent URL is configured for "document_generator"'),
		]);
	});

	it("ends with AGUI_RUN_SETUP_FAILED when the agent's request fails before its first event", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		observer.error(new Error("connect ECONNREFUSED"));

		await expect(run.settled).resolves.toEqual({
			value: { outcome: "error", events: 2 },
		});
		expect(run.appended).toEqual([
			expect.objectContaining(STARTED),
			setupFailed("connect ECONNREFUSED"),
		]);
	});

	it("ends with AGUI_RUN_SETUP_FAILED when the agent ends without sending anything", async () => {
		const run = await startRun();
		const observer = await agentObserver();
		observer.complete();

		await run.settled;
		expect(terminals(run.appended)).toEqual([
			setupFailed("The agent ended the run without a response"),
		]);
	});
});
