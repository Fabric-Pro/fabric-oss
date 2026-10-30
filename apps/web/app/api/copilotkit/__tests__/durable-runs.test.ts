// @vitest-environment node
/**
 * `/api/copilotkit`'s durable-run wiring (`durable-runs.ts`):
 *
 *   - nothing durable is built while `COPILOTKIT_DURABLE_ASSISTANTS` is off
 *     for the caller's organization (the route keeps its in-memory runner
 *     and no hook);
 *   - the guard refuses a run, connect or stop of the durable agent on a
 *     thread the engine refuses, with a 403, before the runtime sees it, and
 *     leaves every other agent and route alone;
 *   - the runner sends the durable agent to the engine and every other agent
 *     to the in-memory runner the route hands it, as before; the engine falls
 *     back to that same runner; a stop no engine answers goes to it last;
 *   - the route's AI token, which the worker uses, outlives the run's
 *     pickup and its Temporal timeout, and the response window ends before
 *     the route's `maxDuration`.
 */
import { type BaseEvent, EventType } from "@ag-ui/client";
import {
	type AgentRunner,
	InMemoryAgentRunner,
	type RouteInfo,
} from "@copilotkit/runtime/v2";
import {
	AGUI_RUN_MAX_DURATION_SECONDS,
	AGUI_RUN_TOKEN_PICKUP_SLACK_SECONDS,
	AGUI_RUN_TOKEN_TTL_SECONDS,
} from "@repo/temporal/agui-run-stream";
import { FabricRuntimeAgent } from "@saas/agents/runtime/fabric-temporal-runner";
import { lastValueFrom, of, toArray } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AI_TOKEN_TTL_SECONDS,
	COPILOTKIT_MAX_DURATION_SECONDS,
	COPILOTKIT_RUN_STREAM_WINDOW_MS,
} from "../config";
import { copilotDurableRuntime } from "../durable-runs";

const h = vi.hoisted(() => ({
	constructed: [] as unknown[][],
	refusesThread: vi.fn<(threadId: string) => Promise<boolean>>(),
	run: vi.fn(),
	connect: vi.fn(),
	stop: vi.fn<(threadId: string, runId?: string) => Promise<boolean>>(),
	isRunning: vi.fn<(threadId: string) => Promise<boolean>>(),
	isFeatureEnabled:
		vi.fn<(key: string, organizationId?: string) => Promise<boolean>>(),
}));

vi.mock("@repo/database", () => ({ isFeatureEnabled: h.isFeatureEnabled }));

vi.mock("@saas/agents/runtime/ag-ui-agent-engine", () => ({
	AG_UI_DURABLE_AGENT_ID: "project_document_generator",
	AgUiAgentEngine: class {
		refusesThread = h.refusesThread;
		run = h.run;
		connect = h.connect;
		stop = h.stop;
		isRunning = h.isRunning;
		constructor(...args: unknown[]) {
			h.constructed.push(args);
		}
	},
}));

const DURABLE = "project_document_generator";
const OTHER_AGENT = "data_analyst";
const THREAD = "thread-example-0001";
const FOREIGN_THREAD = "thread-example-0009";
const caller = { userId: "user-example-1", organizationId: "org-example-1" };
const settings = {
	modelHints: { model: "example-model" },
	aiToken: "route-minted-ai-token",
};

function envelope(method: string, threadId?: string): Request {
	return new Request("https://app.example.com/api/copilotkit", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			method,
			params: {},
			body: threadId === undefined ? {} : { threadId },
		}),
	});
}

/**
 * The durable runtime, with the organization's flag on, over `inProcess`:
 * CopilotKit's own in-memory runner unless a case hands it another.
 */
async function durableRuntime(
	inProcess: AgentRunner = new InMemoryAgentRunner(),
) {
	const durable = await copilotDurableRuntime(caller, settings, inProcess);
	if (!durable) {
		throw new Error("durable runs are off for the organization");
	}
	return durable;
}

async function guard(route: RouteInfo, request: Request): Promise<unknown> {
	const { onBeforeHandler } = await durableRuntime();
	try {
		await onBeforeHandler({ route, request });
		return undefined;
	} catch (thrown) {
		return thrown;
	}
}

function agent(agentId: string) {
	const instance = new FabricRuntimeAgent();
	instance.agentId = agentId;
	return instance;
}

const runInput = {
	threadId: THREAD,
	runId: "run-example-0001",
	messages: [],
	tools: [],
	context: [],
	state: {},
	forwardedProps: {},
};

beforeEach(() => {
	h.constructed.length = 0;
	h.isFeatureEnabled.mockReset().mockResolvedValue(true);
	h.refusesThread
		.mockReset()
		.mockImplementation(async (threadId) => threadId !== THREAD);
	h.run.mockReset();
	h.connect.mockReset();
	h.stop.mockReset().mockResolvedValue(false);
	h.isRunning.mockReset().mockResolvedValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("copilotDurableRuntime — per-organization switch", () => {
	it("builds nothing while the organization's flag is off, leaving the route's runner", async () => {
		h.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			copilotDurableRuntime(caller, settings, new InMemoryAgentRunner()),
		).resolves.toBeNull();

		expect(h.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_DURABLE_ASSISTANTS",
			"org-example-1",
		);
		expect(h.constructed).toEqual([]);
	});

	it("builds the durable engine for the organization whose flag is on", async () => {
		const durable = await copilotDurableRuntime(
			caller,
			settings,
			new InMemoryAgentRunner(),
		);

		expect(durable).not.toBeNull();
		expect(h.constructed).toHaveLength(1);
		expect(h.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_DURABLE_ASSISTANTS",
			"org-example-1",
		);
	});
});

describe("copilotDurableRuntime — guard", () => {
	it.each([
		["agent/run", "run"],
		["agent/connect", "connect"],
	] as const)(
		"refuses %s of the durable agent on someone else's thread with a 403",
		async (method) => {
			const thrown = await guard(
				{ method, agentId: DURABLE },
				envelope(method, FOREIGN_THREAD),
			);

			expect(thrown).toBeInstanceOf(Response);
			const response = thrown instanceof Response ? thrown : null;
			expect(response?.status).toBe(403);
			await expect(response?.json()).resolves.toEqual({
				error: "Forbidden",
				message: "This thread is not accessible.",
			});
			expect(h.refusesThread).toHaveBeenCalledWith(FOREIGN_THREAD);
		},
	);

	it("refuses agent/stop of the durable agent on someone else's thread with a 403", async () => {
		const thrown = await guard(
			{
				method: "agent/stop",
				agentId: DURABLE,
				threadId: FOREIGN_THREAD,
			},
			envelope("agent/stop"),
		);

		expect(thrown instanceof Response ? thrown.status : thrown).toBe(403);
		expect(h.refusesThread).toHaveBeenCalledWith(FOREIGN_THREAD);
	});

	it("lets the caller's own thread through, with its body still readable", async () => {
		const request = envelope("agent/run", THREAD);

		await expect(
			guard({ method: "agent/run", agentId: DURABLE }, request),
		).resolves.toBeUndefined();
		await expect(request.json()).resolves.toMatchObject({
			body: { threadId: THREAD },
		});
	});

	it("checks an envelope without a thread id as the empty thread", async () => {
		const thrown = await guard(
			{ method: "agent/connect", agentId: DURABLE },
			envelope("agent/connect"),
		);

		expect(thrown instanceof Response ? thrown.status : thrown).toBe(403);
		expect(h.refusesThread).toHaveBeenCalledWith("");
	});

	it("leaves other agents and routes alone", async () => {
		await expect(
			guard(
				{ method: "agent/run", agentId: OTHER_AGENT },
				envelope("agent/run", FOREIGN_THREAD),
			),
		).resolves.toBeUndefined();
		await expect(
			guard(
				{
					method: "agent/stop",
					agentId: OTHER_AGENT,
					threadId: FOREIGN_THREAD,
				},
				envelope("agent/stop"),
			),
		).resolves.toBeUndefined();
		await expect(
			guard({ method: "info" }, envelope("info")),
		).resolves.toBeUndefined();
		expect(h.refusesThread).not.toHaveBeenCalled();
	});
});

describe("copilotDurableRuntime — runner", () => {
	it("builds the engine for the caller with the route's settings and token", async () => {
		const inProcess = new InMemoryAgentRunner();
		await durableRuntime(inProcess);

		expect(h.constructed).toEqual([[caller, settings, { inProcess }]]);
	});

	it("falls back to, and serves the other agents on, the in-memory runner the route hands it", async () => {
		// The route's runner keeps the Proposal chat's server-only
		// `forwardedProps` out of what it stores and streams; a bare
		// in-memory runner built here would not.
		const answered: BaseEvent[] = [
			{
				type: EventType.RUN_STARTED,
				threadId: THREAD,
				runId: "run-example-0001",
			},
		];
		const routeRunner: AgentRunner = {
			run: vi.fn(() => of(...answered)),
			connect: vi.fn(() => of(...answered)),
			isRunning: vi.fn(async () => false),
			stop: vi.fn(async () => true),
		};
		const { runner } = await durableRuntime(routeRunner);

		const ran = await lastValueFrom(
			runner
				.run({
					threadId: THREAD,
					agent: agent(OTHER_AGENT),
					input: runInput,
				})
				.pipe(toArray()),
		);

		expect(ran).toEqual(answered);
		expect(routeRunner.run).toHaveBeenCalledTimes(1);
		await expect(runner.stop({ threadId: THREAD })).resolves.toBe(true);
		expect(routeRunner.stop).toHaveBeenCalledTimes(1);
		const [[, , engineOptions]] = h.constructed;
		expect(engineOptions).toEqual({ inProcess: routeRunner });
		expect((engineOptions as { inProcess: unknown }).inProcess).toBe(
			routeRunner,
		);
	});

	it("runs and connects other agents on CopilotKit's in-memory runner", async () => {
		const answered: BaseEvent[] = [
			{
				type: EventType.RUN_STARTED,
				threadId: THREAD,
				runId: "run-example-0001",
			},
		];
		const run = vi
			.spyOn(InMemoryAgentRunner.prototype, "run")
			.mockReturnValue(of(...answered));
		const connect = vi
			.spyOn(InMemoryAgentRunner.prototype, "connect")
			.mockReturnValue(of(...answered));
		const { runner } = await durableRuntime();

		const ran = await lastValueFrom(
			runner
				.run({
					threadId: THREAD,
					agent: agent(OTHER_AGENT),
					input: runInput,
				})
				.pipe(toArray()),
		);
		const connected = await lastValueFrom(
			runner
				.connect({ threadId: THREAD, agentId: OTHER_AGENT })
				.pipe(toArray()),
		);

		expect(ran).toEqual(answered);
		expect(connected).toEqual(answered);
		expect(run).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(h.run).not.toHaveBeenCalled();
		expect(h.connect).not.toHaveBeenCalled();
	});

	it("runs the durable agent on the engine, not the in-memory runner", async () => {
		const run = vi.spyOn(InMemoryAgentRunner.prototype, "run");
		h.run.mockImplementation(
			async (
				_request: unknown,
				stream: { emit: (event: BaseEvent) => void },
			) => {
				stream.emit({
					type: EventType.RUN_FINISHED,
					threadId: THREAD,
					runId: "run-example-0001",
				});
			},
		);
		const { runner } = await durableRuntime();
		const durableAgent = agent(DURABLE);

		const ran = await lastValueFrom(
			runner
				.run({
					threadId: THREAD,
					agent: durableAgent,
					input: runInput,
				})
				.pipe(toArray()),
		);

		expect(ran.map((event) => event.type)).toEqual([
			EventType.RUN_FINISHED,
		]);
		// The engine gets the request's agent, for its in-process fallback.
		expect(h.run).toHaveBeenCalledWith(
			{ threadId: THREAD, input: runInput, agent: durableAgent },
			expect.objectContaining({ deadline: expect.any(Number) }),
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("stops on the engine first and on the in-memory runner only when the engine has nothing", async () => {
		const stop = vi
			.spyOn(InMemoryAgentRunner.prototype, "stop")
			.mockResolvedValue(true);
		const { runner } = await durableRuntime();

		h.stop.mockResolvedValueOnce(true);
		await expect(runner.stop({ threadId: THREAD })).resolves.toBe(true);
		expect(stop).not.toHaveBeenCalled();

		await expect(runner.stop({ threadId: THREAD })).resolves.toBe(true);
		expect(stop).toHaveBeenCalledTimes(1);
		// The same in-memory runner the engine falls back to, so a run that
		// went in-process is stopped where it runs.
		const [[, , engineOptions]] = h.constructed;
		expect(stop.mock.contexts[0]).toBe(
			typeof engineOptions === "object" &&
				engineOptions !== null &&
				"inProcess" in engineOptions
				? engineOptions.inProcess
				: null,
		);
	});
});

describe("durable-run timing", () => {
	it("hands the worker a token that outlives the run's mint-to-pickup and its whole activity", () => {
		// The worker uses the route's token, so the run contract states its
		// lifetime; the two must not drift apart.
		expect(AGUI_RUN_TOKEN_TTL_SECONDS).toBe(AI_TOKEN_TTL_SECONDS);
		expect(
			AGUI_RUN_MAX_DURATION_SECONDS + AGUI_RUN_TOKEN_PICKUP_SLACK_SECONDS,
		).toBe(AI_TOKEN_TTL_SECONDS);
		// The slack covers the engine's 15 s pickup timeout, with room for the
		// request's setup and the workflow start.
		expect(AGUI_RUN_TOKEN_PICKUP_SLACK_SECONDS).toBeGreaterThan(15);
	});

	it("ends a response's tail before the route's maxDuration", () => {
		expect(COPILOTKIT_RUN_STREAM_WINDOW_MS).toBeLessThan(
			COPILOTKIT_MAX_DURATION_SECONDS * 1000,
		);
		expect(COPILOTKIT_RUN_STREAM_WINDOW_MS).toBeGreaterThan(0);
	});
});
