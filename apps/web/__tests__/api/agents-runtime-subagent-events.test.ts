// @vitest-environment node
/**
 * The multi-agent Orchestrator turn attributes each picked agent's work to an
 * AG-UI subagent (`SUBAGENT_STARTED` / `SUBAGENT_FINISHED` / `SUBAGENT_ERROR`
 * and `subagentRunId` on the attributed events). This drives the real
 * CopilotKit runtime endpoint with an engine that emits such a run and checks
 * the browser's stream carries every event intact, in order, and passes the
 * AG-UI client's own `verifyEvents`.
 */
import { type BaseEvent, EventType, verifyEvents } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getSession: vi.fn(),
	hasOrganizationTie: vi.fn(),
	findConversation: vi.fn(),
	orchestratorRun: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: () => m.getSession() }));
vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	enterAiInteractiveContext: () => undefined,
}));
vi.mock("@repo/database", () => ({
	hasOrganizationTie: (...args: unknown[]) => m.hasOrganizationTie(...args),
	db: {
		agentConversation: {
			findUnique: (...args: unknown[]) => m.findConversation(...args),
		},
	},
}));
vi.mock("@repo/api/orpc/procedures", () => ({
	authorizeInputOrganization: async () => undefined,
	Permissions: { AGENT_CREATE: "agent:create", AGENT_UPDATE: "agent:update" },
}));
vi.mock("@saas/agents/runtime/direct-engine", () => ({
	DIRECT_AGENT_ID: "fabric-direct",
	DirectEngine: class {
		run = async () => undefined;
		connect = async () => undefined;
		isRunning = async () => false;
		stop = async () => false;
	},
}));
vi.mock("@saas/agents/runtime/orchestrator-engine", () => ({
	ORCHESTRATOR_AGENT_ID: "fabric-orchestrator",
	ORCHESTRATOR_STREAM_WINDOW_MS: 240000,
	OrchestratorEngine: class {
		run = (...args: unknown[]) => m.orchestratorRun(...args);
		connect = async () => undefined;
		isRunning = async () => false;
		stop = async () => false;
	},
}));

const { POST } = await import("@/app/api/agents/runtime/[[...path]]/route");

const USER = "user-example-1";
const ORG = "org-example-1";
const THREAD = "thread-example-0001";
const RUN = "ma_run-example-0001";
const AGENT_A = RUN;
const AGENT_B = `${RUN}_a1`;

/** A multi-agent response: two subagents, one ends, one fails, the run ends. */
const EMITTED: BaseEvent[] = [
	{ type: EventType.RUN_STARTED, threadId: THREAD, runId: RUN },
	{
		type: EventType.STATE_SNAPSHOT,
		snapshot: { mode: "multi-agent", agents: [{ index: 0 }, { index: 1 }] },
	},
	{
		type: EventType.SUBAGENT_STARTED,
		subagentRunId: AGENT_A,
		name: "Research agent",
		metadata: { fabric: { agentIndex: 0 } },
	},
	{
		type: EventType.SUBAGENT_STARTED,
		subagentRunId: AGENT_B,
		name: "Model example",
		metadata: { fabric: { agentIndex: 1 } },
	},
	{
		type: EventType.TEXT_MESSAGE_START,
		messageId: `${AGENT_A}:text:1:w`,
		role: "assistant",
		subagentRunId: AGENT_A,
	},
	{
		type: EventType.TEXT_MESSAGE_START,
		messageId: `${AGENT_B}:text:1:w`,
		role: "assistant",
		subagentRunId: AGENT_B,
	},
	{
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: `${AGENT_A}:text:1:w`,
		delta: "Answer A",
		subagentRunId: AGENT_A,
	},
	{
		type: EventType.TOOL_CALL_START,
		toolCallId: `${AGENT_B}:call-1`,
		toolCallName: "fabric_web_search",
		parentMessageId: `${AGENT_B}:text:1:w`,
		subagentRunId: AGENT_B,
		metadata: { fabric: { serverName: "fabric" } },
	},
	{
		type: EventType.STATE_DELTA,
		delta: [{ op: "replace", path: "/agents/1/phase", value: "executing" }],
		subagentRunId: AGENT_B,
	},
	{
		type: EventType.TOOL_CALL_END,
		toolCallId: `${AGENT_B}:call-1`,
		subagentRunId: AGENT_B,
	},
	{
		type: EventType.CUSTOM,
		name: "fabric.orchestrator.event",
		value: { type: "limit_signal" },
		subagentRunId: AGENT_A,
	},
	{
		type: EventType.TEXT_MESSAGE_END,
		messageId: `${AGENT_A}:text:1:w`,
		subagentRunId: AGENT_A,
	},
	{
		type: EventType.SUBAGENT_FINISHED,
		subagentRunId: AGENT_A,
		outcome: { type: "success" },
		result: { status: "completed", response: "Answer A" },
	},
	{
		type: EventType.TEXT_MESSAGE_END,
		messageId: `${AGENT_B}:text:1:w`,
		subagentRunId: AGENT_B,
	},
	{
		type: EventType.SUBAGENT_ERROR,
		subagentRunId: AGENT_B,
		message: "Workflow execution failed",
		code: "WORKFLOW_FAILED",
	},
	{
		type: EventType.RUN_FINISHED,
		threadId: THREAD,
		runId: RUN,
		result: { mode: "multi-agent" },
		outcome: { type: "success" },
	},
] as BaseEvent[];

/** A response that ends with one subagent waiting on an approval. */
const SUSPENDED: BaseEvent[] = [
	{ type: EventType.RUN_STARTED, threadId: THREAD, runId: RUN },
	{
		type: EventType.SUBAGENT_STARTED,
		subagentRunId: AGENT_A,
		name: "Research agent",
	},
	{
		type: EventType.CUSTOM,
		name: "fabric.multi-agent.interrupt",
		value: { id: "approval-1" },
		subagentRunId: AGENT_A,
	},
	{
		type: EventType.SUBAGENT_FINISHED,
		subagentRunId: AGENT_A,
		outcome: { type: "suspended", interruptIds: ["approval-1"] },
	},
	{
		type: EventType.RUN_FINISHED,
		threadId: THREAD,
		runId: RUN,
		outcome: {
			type: "interrupt",
			interrupts: [
				{
					id: "approval-1",
					reason: "orchestrator_approval",
					message: "Approve the write",
					subagentRunId: AGENT_A,
				},
			],
		},
	},
] as BaseEvent[];

function runRequest(): Request {
	return new Request(
		"http://localhost/api/agents/runtime/agent/fabric-orchestrator/run",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-fabric-organization-id": ORG,
			},
			body: JSON.stringify({
				threadId: THREAD,
				runId: RUN,
				messages: [{ id: `${RUN}:user`, role: "user", content: "Hi" }],
				tools: [],
				context: [],
				state: {},
				forwardedProps: {},
			}),
		},
	);
}

/** The SSE body's events, as the browser reads them. */
async function streamedEvents(response: Response): Promise<BaseEvent[]> {
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5).trim()) as BaseEvent);
}

function verified(events: BaseEvent[]): Promise<BaseEvent[]> {
	return lastValueFrom(from(events).pipe(verifyEvents(false), toArray()));
}

/** What the engine emitted, without the fields the runtime may add (timestamps). */
function comparable(event: BaseEvent): Record<string, unknown> {
	const { timestamp: _timestamp, ...rest } = event as BaseEvent & {
		timestamp?: number;
	};
	return rest;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.getSession.mockResolvedValue({
		user: { id: USER, email: "dev@example.com" },
		session: { id: "session-1", activeOrganizationId: ORG },
	});
	m.hasOrganizationTie.mockResolvedValue(true);
	m.findConversation.mockResolvedValue({ userId: USER, organizationId: ORG });
});

describe("/api/agents/runtime carries a multi-agent run's subagent events", () => {
	it.each([
		["two subagents that end and fail", EMITTED],
		["a subagent suspended on an approval", SUSPENDED],
	])("streams %s intact and valid", async (_label, emitted) => {
		m.orchestratorRun.mockImplementation(
			async (
				_request: unknown,
				stream: { emit: (event: BaseEvent) => void },
			) => {
				for (const event of emitted) {
					stream.emit(event);
				}
			},
		);

		const response = await POST(runRequest());
		expect(response.status).toBe(200);
		const events = await streamedEvents(response);

		expect(events.map(comparable)).toEqual(emitted.map(comparable));
		await expect(verified(events)).resolves.toHaveLength(emitted.length);
	});

	it("is the run the client's verifier refuses when a subagent is left open", async () => {
		const open = EMITTED.filter(
			(event) => event.type !== EventType.SUBAGENT_ERROR,
		);
		await expect(verified(open)).rejects.toThrow(/subagent/i);
	});
});
