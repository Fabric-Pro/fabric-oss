/**
 * MultiAgentRuntimeTurn, with the runtime transport faked per request:
 *
 *   - a send carries only the picked agents' ids (`forwardedProps.multiAgent`)
 *     under the turn's own key, and the chat's shared options;
 *   - a response that ends at its window is followed by a connect, until
 *     the run ends; a connect with no run (the turn is saved) ends it;
 *   - an approval is answered by a resume run naming the agent's scoped
 *     interrupt id, with the card's feedback;
 *   - an agent's text is applied in 50 ms batches; its default-MCP events
 *     reach analytics, and a usage-limit end reaches the toast;
 *   - a stop shows every agent still answering as stopped at once.
 */
import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MultiAgentTurnView } from "../multi-agent-turn";

const m = vi.hoisted(() => ({
	requests: [] as Array<{ url: string; input: RunAgentInput }>,
	responses: [] as AGUIEvent[][],
}));

vi.mock("../direct-runtime-transport", () => ({
	connectInput: (threadId: string) => ({
		threadId,
		runId: "connect",
		messages: [],
		tools: [],
		context: [],
		state: {},
	}),
	errorMessageOf: (error: unknown) => String(error),
	isAbortError: () => false,
	runtimeHeaders: () => ({}),
	runtimePaths: (agentId: string) => ({
		run: `/run/${agentId}`,
		connect: `/connect/${agentId}`,
		stop: (threadId: string) => `/stop/${threadId}`,
	}),
	streamRuntime: async (args: {
		url: string;
		input: RunAgentInput;
		onEvent: (event: AGUIEvent) => void;
	}) => {
		m.requests.push({ url: args.url, input: args.input });
		for (const event of m.responses.shift() ?? []) {
			args.onEvent(event);
		}
	},
}));

const { MultiAgentRuntimeTurn } = await import("../multi-agent-runtime-turn");
const { pendingMultiAgentTurn } = await import("../multi-agent-turn");

const KEY = "ma_run-example-0001";
const SECOND = `${KEY}_a1`;
const started: AGUIEvent = {
	type: EventType.RUN_STARTED,
	threadId: "thread-1",
	runId: KEY,
};

function turn() {
	const views: MultiAgentTurnView[] = [];
	const runtimeTurn = new MultiAgentRuntimeTurn(
		"thread-1",
		pendingMultiAgentTurn(KEY, "Compare the plans", [
			{ agentId: "model:alpha", name: "Alpha" },
			{ agentId: "model:beta", name: "Beta" },
		]),
		{ organizationId: "org-1", onView: (view) => views.push(view) },
	);
	return { runtimeTurn, views };
}

beforeEach(() => {
	m.requests.length = 0;
	m.responses.length = 0;
});

describe("a multi-agent turn over the runtime", () => {
	it("sends only the agents' ids, then connects until the run ends", async () => {
		m.responses.push(
			[
				started,
				{ type: EventType.CUSTOM, name: "fabric.reconnect", value: {} },
			],
			[
				started,
				{
					type: EventType.RUN_FINISHED,
					threadId: "thread-1",
					runId: KEY,
					outcome: { type: "success" },
				},
			],
		);
		const { runtimeTurn } = turn();

		await runtimeTurn.send({
			messages: [{ id: "q", role: "user", content: "Compare the plans" }],
			agentIds: ["model:alpha", "model:beta"],
			forwardedProps: { executionMode: "balanced" },
		});

		expect(m.requests.map((request) => request.url)).toEqual([
			"/run/fabric-orchestrator",
			"/connect/fabric-orchestrator",
		]);
		expect(m.requests[0]?.input).toMatchObject({
			runId: KEY,
			forwardedProps: {
				executionMode: "balanced",
				multiAgent: {
					agents: [
						{ agentId: "model:alpha" },
						{ agentId: "model:beta" },
					],
				},
			},
		});
		expect(runtimeTurn.current.status).toBe("ended");
	});

	it("ends when a connect finds no run (the turn is saved)", async () => {
		m.responses.push([]);
		const { runtimeTurn } = turn();

		await runtimeTurn.attach();

		expect(m.requests).toHaveLength(1);
		expect(runtimeTurn.current.status).toBe("ended");
	});

	it("answers an approval with the agent's scoped interrupt id", async () => {
		m.responses.push([
			started,
			{
				type: EventType.RUN_FINISHED,
				threadId: "thread-1",
				runId: "resume",
				outcome: {
					type: "interrupt",
					interrupts: [
						{ id: `${SECOND}:approval-2`, reason: "approval" },
					],
				},
			},
		]);
		const { runtimeTurn } = turn();

		await runtimeTurn.answer(`${SECOND}:approval-1`, {
			approved: true,
			feedback: "Send it today.",
		});

		expect(m.requests[0]?.input.resume).toEqual([
			{
				interruptId: `${SECOND}:approval-1`,
				status: "resolved",
				payload: { approved: true, feedback: "Send it today." },
			},
		]);
		expect(m.requests).toHaveLength(1);
		expect(runtimeTurn.current.status).toBe("waiting");
	});

	it("applies an agent's streamed text in batches, as Nexus does", async () => {
		m.responses.push(
			[
				started,
				{
					type: EventType.TEXT_MESSAGE_START,
					messageId: `${KEY}:text:1:n`,
					role: "assistant",
					subagentRunId: KEY,
				},
				...["Hel", "lo"].map(
					(delta): AGUIEvent => ({
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId: `${KEY}:text:1:n`,
						delta,
						subagentRunId: KEY,
					}),
				),
				{ type: EventType.CUSTOM, name: "fabric.reconnect", value: {} },
			],
			[],
		);
		const { runtimeTurn, views } = turn();

		await runtimeTurn.attach();

		const contents = views.map((view) => view.agents[0]?.content);
		expect(contents).not.toContain("Hel");
		expect(contents).toContain("Hello");
		expect(runtimeTurn.current.agents[0]?.content).toBe("Hello");
	});

	it("passes an agent's default-MCP events to analytics and the usage limit to its toast", async () => {
		m.responses.push([
			started,
			{
				type: EventType.CUSTOM,
				name: "fabric.orchestrator.event",
				value: {
					type: "mcp_default_tool_invoked",
					payload: { server: "excalidraw" },
				},
				subagentRunId: KEY,
			},
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
			{
				type: EventType.RUN_FINISHED,
				threadId: "thread-1",
				runId: KEY,
				outcome: { type: "success" },
			},
		]);
		const onAnalyticsEvent = vi.fn();
		const onUsageLimit = vi.fn();
		const runtimeTurn = new MultiAgentRuntimeTurn(
			"thread-1",
			pendingMultiAgentTurn(KEY, "Compare the plans", [
				{ agentId: "model:alpha", name: "Alpha" },
				{ agentId: "model:beta", name: "Beta" },
			]),
			{
				organizationId: "org-1",
				onView: () => {},
				onAnalyticsEvent,
				onUsageLimit,
			},
		);

		await runtimeTurn.attach();

		expect(onAnalyticsEvent).toHaveBeenCalledWith(
			"mcp_default_tool_invoked",
			{ server: "excalidraw" },
		);
		expect(onUsageLimit).toHaveBeenCalledWith({ scope: "organization" });
	});

	it("shows every agent still answering as stopped at once, then asks the runtime to stop", async () => {
		const fetchMock = vi.fn(
			async () => new Response(null, { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const { runtimeTurn, views } = turn();

			await expect(runtimeTurn.stop()).resolves.toBe(true);

			expect(views[0]).toMatchObject({
				agents: [{ status: "cancelled" }, { status: "cancelled" }],
			});
			expect(fetchMock).toHaveBeenCalledWith(
				"/stop/thread-1",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ runId: KEY }),
				}),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
