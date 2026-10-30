// @vitest-environment node
/**
 * MultiAgentTurnFollow: each agent's Orchestrator turn, as the execution
 * observer reports it (faked here per execution), sent as that agent's AG-UI
 * subagent of one run:
 *
 *   - every agent's text, tool calls and state carry its `subagentRunId`,
 *     with tool-call ids and state paths made unique across the agents, and
 *     the whole run passes the AG-UI client's `verifyEvents`;
 *   - an agent that ends is saved into the turn's record before its
 *     `SUBAGENT_FINISHED`, and the run ends RUN_FINISHED success once every
 *     agent has ended, with the final record;
 *   - an agent's approval suspends only that agent (its interrupt id scoped
 *     to it); the run ends as an interrupt once every agent left waits;
 *   - an agent that ended before the response is sent again from the record.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	verifyEvents,
} from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import type { MultiAgentTurnRecord } from "@saas/agents/lib/multi-agent-runtime-protocol";
import { from, lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Script = Array<Record<string, unknown>>;

const m = vi.hoisted(() => ({
	scripts: new Map<string, Array<Record<string, unknown>>>(),
	saves: [] as Array<{
		agents: Array<{ index: number; status: string; answer?: string }>;
	}>,
	order: [] as string[],
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: {} }),
}));
vi.mock("@saas/agents/lib/server/chat-run-control", () => {
	class ChatRunAccessError extends Error {}
	return {
		ChatRunAccessError,
		getAuthorizedChatRun: async ({
			executionId,
		}: {
			executionId: string;
		}) => ({
			handle: { executionId },
			description: { status: { name: "RUNNING" } },
		}),
	};
});
vi.mock("@saas/agents/lib/server/conversation-turn-admission", () => ({
	isWorkflowNotFound: () => false,
}));
vi.mock("@saas/agents/lib/server/execution-event-subscriber", () => ({
	subscribeExecutionEvents: async () => () => {},
}));
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/turn-admission",
	() => ({ reconcileTurnWithWorkflow: async () => "running" }),
);
// One poll reports the whole script of the execution it polls.
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/execution-observer",
	() => ({
		createOrchestratorExecutionObserver: ({
			emit,
		}: {
			emit: (event: Record<string, unknown>) => void;
		}) => ({
			onExecutionEvent: () => {},
			poll: async (handle: { executionId: string }) => {
				const script = m.scripts.get(handle.executionId) ?? [];
				m.scripts.set(handle.executionId, []);
				for (const event of script) {
					emit(event);
				}
				return { handle, complete: false };
			},
		}),
	}),
);
vi.mock("@saas/agents/runtime/multi-agent-turn-record", () => {
	return {
		// Nothing saved before: the record is `next`, final once no agent runs.
		saveMultiAgentTurn: async (
			_caller: unknown,
			_lead: unknown,
			next: MultiAgentTurnRecord,
		) => {
			const merged = {
				version: 1,
				final: next.agents.every((agent) => agent.status !== "running"),
				agents: next.agents,
			};
			m.saves.push(merged);
			m.order.push("save");
			return merged;
		},
	};
});

const { MultiAgentTurnFollow } = await import(
	"@saas/agents/runtime/multi-agent-turn-follow"
);

const THREAD = "thread-example-0001";
const KEY = "ma_run-example-0001";
const SECOND = `${KEY}_a1`;

function turn(key: string): ConversationTurn {
	const base = {
		id: `turn-${key}`,
		organizationId: "org-1",
		userId: "user-1",
		conversationId: key === KEY ? THREAD : null,
		clientRequestKey: key,
		executionId: `orch-${key}`,
		generation: key === KEY ? 1 : null,
		status: "ACTIVE",
		questionText: "Compare the plans",
		createdAt: new Date("2026-10-01T10:00:00.000Z"),
	};
	// The row's remaining columns are not read by the follower.
	return { ...base } as ConversationTurn;
}

function group(
	statuses: Array<"running" | "complete"> = ["running", "running"],
) {
	const keys = [KEY, SECOND];
	return {
		lead: turn(KEY),
		members: keys.map((memberKey, index) => ({
			index,
			agentId: `model:agent-${index}`,
			name: `Agent ${index}`,
			memberKey,
			turn: turn(memberKey),
		})),
		record: {
			version: 1 as const,
			final: false,
			agents: keys.map((memberKey, index) => ({
				index,
				agentId: `model:agent-${index}`,
				name: `Agent ${index}`,
				memberKey,
				executionId: `orch-${memberKey}`,
				turnId: `turn-${memberKey}`,
				status: statuses[index] ?? "running",
				...(statuses[index] === "complete"
					? { answer: "Saved answer" }
					: {}),
			})),
		},
	};
}

function answer(text: string, toolCallId: string): Script {
	return [
		{ type: "phase", phase: "executing" },
		{ type: "text_delta", content: text },
		{ type: "tool_start", toolCallId, toolName: "search" },
		{ type: "tool_result", toolCallId, result: { ok: true } },
		{ type: "completed", status: "completed", response: text },
	];
}

async function follow(g: ReturnType<typeof group>) {
	const events: AGUIEvent[] = [];
	const follower = new MultiAgentTurnFollow({
		caller: { userId: "user-1", organizationId: "org-1" },
		group: g,
		runId: KEY,
		stream: {
			emit: (event) => {
				events.push(event);
				m.order.push(event.type);
			},
			isClosed: () => false,
			deadline: Date.now() + 60_000,
		},
	});
	await follower.subscribe();
	await follower.follow({
		inputMessage: { id: `${KEY}:user`, content: "Compare the plans" },
		resumed: false,
		billing: new Map(),
		announce: [],
	});
	return events;
}

function verified(events: AGUIEvent[]): Promise<BaseEvent[]> {
	return lastValueFrom(
		from(events as BaseEvent[]).pipe(verifyEvents(false), toArray()),
	);
}

beforeEach(() => {
	m.scripts.clear();
	m.saves.length = 0;
	m.order.length = 0;
});

describe("a multi-agent run", () => {
	it("sends each agent as its own subagent and ends once all have ended", async () => {
		m.scripts.set(`orch-${KEY}`, answer("Plan A", "call-1"));
		m.scripts.set(`orch-${SECOND}`, answer("Plan B", "call-1"));

		const events = await follow(group());

		await expect(verified(events)).resolves.toHaveLength(events.length);
		const started = events.filter(
			(event) => event.type === EventType.SUBAGENT_STARTED,
		);
		expect(
			started.map(
				(event) => "subagentRunId" in event && event.subagentRunId,
			),
		).toEqual([KEY, SECOND]);
		const toolStarts = events.filter(
			(event) => event.type === EventType.TOOL_CALL_START,
		);
		expect(toolStarts).toEqual([
			expect.objectContaining({
				toolCallId: `${KEY}:call-1`,
				subagentRunId: KEY,
			}),
			expect.objectContaining({
				toolCallId: `${SECOND}:call-1`,
				subagentRunId: SECOND,
			}),
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: EventType.STATE_DELTA,
				subagentRunId: SECOND,
				delta: [expect.objectContaining({ path: "/agents/1/phase" })],
			}),
		);
		// Each end is saved before it is sent; the last save is final.
		expect(
			m.order.filter(
				(entry) =>
					entry === "save" || entry === EventType.SUBAGENT_FINISHED,
			),
		).toEqual([
			"save",
			EventType.SUBAGENT_FINISHED,
			"save",
			EventType.SUBAGENT_FINISHED,
		]);
		expect(m.saves.at(-1)?.agents.map((agent) => agent.answer)).toEqual([
			"Plan A",
			"Plan B",
		]);
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: "success" },
			result: { multiAgent: { final: true } },
		});
	});

	it("suspends only the agent that asks, and ends as an interrupt once all left wait", async () => {
		m.scripts.set(`orch-${KEY}`, answer("Plan A", "call-1"));
		m.scripts.set(`orch-${SECOND}`, [
			{
				type: "approval_required",
				approvalId: "approval-1",
				stepId: "step-1",
				reason: "Send the email?",
			},
		]);

		const events = await follow(group());

		await expect(verified(events)).resolves.toHaveLength(events.length);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: EventType.SUBAGENT_FINISHED,
				subagentRunId: SECOND,
				outcome: {
					type: "suspended",
					interruptIds: [`${SECOND}:approval-1`],
				},
			}),
		);
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: {
				type: "interrupt",
				interrupts: [
					expect.objectContaining({
						id: `${SECOND}:approval-1`,
						subagentRunId: SECOND,
					}),
				],
			},
		});
		expect(m.saves.at(-1)?.agents.map((agent) => agent.status)).toEqual([
			"complete",
			"running",
		]);
	});

	it("sends an agent that ended before the response from the record", async () => {
		m.scripts.set(`orch-${SECOND}`, answer("Plan B", "call-1"));

		const events = await follow(group(["complete", "running"]));

		await expect(verified(events)).resolves.toHaveLength(events.length);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: EventType.SUBAGENT_FINISHED,
				subagentRunId: KEY,
				result: {
					recorded: expect.objectContaining({
						answer: "Saved answer",
					}),
				},
			}),
		);
		expect(m.saves).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: "success" },
		});
	});
});
