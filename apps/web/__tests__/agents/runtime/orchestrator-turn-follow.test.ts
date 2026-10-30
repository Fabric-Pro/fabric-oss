// @vitest-environment node
/**
 * OrchestratorTurnFollow: one response following an Orchestrator turn, with
 * the stream route's observer, Redis and Temporal replaced by fakes.
 *
 *   - the run opens with RUN_STARTED, the state snapshot, the turn's ids and
 *     the billing notice, then the events that arrived before it opened;
 *   - a turn that ended is saved (with the thumbnails its start recorded)
 *     before its end is sent;
 *   - past the window the response ends at a quiet point with
 *     `fabric.reconnect`, never inside a burst of text;
 *   - an interrupt ends the response without a reconnect;
 *   - a run the caller may not observe is refused, and nothing opens.
 */
import { type AGUIEvent, EventType } from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StreamEvent = Record<string, unknown> & { type: string };

const m = vi.hoisted(() => ({
	polls: [] as Array<{ events: StreamEvent[]; complete?: boolean }>,
	redisEvent: null as null | ((event: StreamEvent) => void),
	unsubscribe: vi.fn(),
	authorizedRun: vi.fn(),
	save: vi.fn(),
	order: [] as string[],
}));

vi.mock("@repo/temporal", () => ({ getTemporalClient: async () => ({}) }));
vi.mock("@saas/agents/lib/server/chat-run-control", () => {
	class ChatRunAccessError extends Error {}
	return { ChatRunAccessError, getAuthorizedChatRun: m.authorizedRun };
});
vi.mock("@saas/agents/lib/server/conversation-turn-admission", () => ({
	isWorkflowNotFound: () => false,
}));
vi.mock("@saas/agents/lib/server/execution-event-subscriber", () => ({
	subscribeExecutionEvents: async (args: {
		onEvent: (event: StreamEvent) => void;
	}) => {
		m.redisEvent = args.onEvent;
		return m.unsubscribe;
	},
}));
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/execution-observer",
	() => ({
		createOrchestratorExecutionObserver: ({
			emit,
		}: {
			emit: (event: StreamEvent) => void;
		}) => ({
			// A Redis event here is already in the stream route's shape.
			onExecutionEvent: (event: StreamEvent) => emit(event),
			poll: async (handle: unknown) => {
				const next = m.polls.shift() ?? { events: [] };
				for (const event of next.events) {
					emit(event);
				}
				return { complete: next.complete ?? false, handle };
			},
		}),
	}),
);
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/turn-admission",
	() => ({ reconcileTurnWithWorkflow: async () => "running" }),
);
vi.mock("@saas/agents/runtime/orchestrator-turn-record", () => ({
	saveOrchestratorTurn: async (...args: unknown[]) => {
		m.order.push("save");
		m.save(...args);
	},
}));

const { OrchestratorTurnFollow } = await import(
	"@saas/agents/runtime/orchestrator-turn-follow"
);
const { ChatRunAccessError } = await import(
	"@saas/agents/lib/server/chat-run-control"
);

const EXECUTION = "orch-00000000-0000-4000-8000-000000000001";
const KEY = "turn-key-0001";

function turn(): ConversationTurn {
	const base = {
		id: "turn-1",
		userId: "user-1",
		organizationId: "org-1",
		conversationId: "thread-1",
		clientRequestKey: KEY,
		executionId: EXECUTION,
		generation: 3,
		questionText: "Question",
		createdAt: new Date("2026-10-01T10:00:00.000Z"),
	};
	// The row's remaining columns are not read by the follower.
	return base as ConversationTurn;
}

function follower(deadline = Number.POSITIVE_INFINITY) {
	const events: AGUIEvent[] = [];
	const follow = new OrchestratorTurnFollow({
		caller: { userId: "user-1", organizationId: "org-1" },
		turn: turn(),
		runId: "run-example-0001",
		stream: {
			emit: (event) => {
				events.push(event);
				m.order.push(event.type);
			},
			isClosed: () => false,
			deadline,
		},
	});
	return { follow, events };
}

const opening = {
	inputMessage: { id: `${KEY}:user`, content: "Question" },
	resumed: false,
	billing: { resetAt: null },
	announce: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	m.polls.length = 0;
	m.order.length = 0;
	m.redisEvent = null;
	m.authorizedRun.mockResolvedValue({
		handle: { id: "handle" },
		description: { memo: { displayImageUrls: ["uploads/one.png"] } },
		organizationId: "org-1",
	});
});

describe("OrchestratorTurnFollow", () => {
	it("opens the run, then sends what arrived before it opened", async () => {
		const { follow, events } = follower();
		await follow.subscribe();
		m.redisEvent?.({ type: "text_delta", content: "Early" });
		m.polls.push({
			events: [
				{ type: "completed", status: "completed", response: "Early" },
			],
			complete: true,
		});

		await follow.follow(opening);

		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.STATE_SNAPSHOT,
			EventType.CUSTOM,
			EventType.CUSTOM,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.RUN_FINISHED,
		]);
		expect(events[1]).toMatchObject({
			snapshot: {
				executionId: EXECUTION,
				turnId: "turn-1",
				turnGeneration: 3,
				phase: null,
			},
		});
		expect(events[2]).toMatchObject({
			name: "fabric.execution",
			value: {
				executionId: EXECUTION,
				turnGeneration: 3,
				resumed: false,
			},
		});
		expect(events[3]).toMatchObject({
			name: "fabric.billing",
			value: { resetAt: null },
		});
		expect(m.unsubscribe).toHaveBeenCalled();
	});

	it("saves a finished turn, with its thumbnails, before sending its end", async () => {
		const { follow } = follower();
		m.polls.push({
			events: [
				{ type: "completed", status: "completed", response: "Done" },
			],
			complete: true,
		});

		await follow.follow(opening);

		expect(m.order.indexOf("save")).toBeLessThan(
			m.order.indexOf(EventType.RUN_FINISHED),
		);
		expect(m.save).toHaveBeenCalledWith(
			expect.objectContaining({
				imageUrls: ["uploads/one.png"],
				billing: { resetAt: null },
			}),
			{ type: "completed", status: "completed", response: "Done" },
			expect.objectContaining({ answerText: "" }),
		);
	});

	it("ends past its window at a quiet point, not inside a burst of text", async () => {
		const { follow, events } = follower(Date.now() - 1);
		// Text keeps arriving on the first polls past the deadline...
		m.polls.push({ events: [{ type: "text_delta", content: "a" }] });
		m.polls.push({ events: [{ type: "text_delta", content: "b" }] });
		// ...then the answer pauses for a tool call.
		m.polls.push({ events: [{ type: "text_start" }] });

		await follow.follow(opening);

		const tail = events.slice(-2);
		expect(tail).toEqual([
			expect.objectContaining({ type: EventType.TEXT_MESSAGE_END }),
			{
				type: EventType.CUSTOM,
				name: "fabric.reconnect",
				value: { executionId: EXECUTION, runId: "run-example-0001" },
			},
		]);
		expect(
			events.filter(
				(event) => event.type === EventType.TEXT_MESSAGE_CONTENT,
			),
		).toHaveLength(2);
		expect(m.save).not.toHaveBeenCalled();
	});

	it("ends at an interrupt without a reconnect", async () => {
		const { follow, events } = follower();
		m.polls.push({
			events: [
				{
					type: "clarifying_question",
					clarificationId: "c-1",
					question: "Which?",
				},
			],
		});

		await follow.follow(opening);

		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_FINISHED,
			outcome: { type: "interrupt" },
		});
		expect(
			events.some(
				(event) =>
					event.type === EventType.CUSTOM &&
					event.name === "fabric.reconnect",
			),
		).toBe(false);
	});

	it("refuses a run the caller may not observe, and opens nothing", async () => {
		m.authorizedRun.mockRejectedValue(new ChatRunAccessError());
		const { follow, events } = follower();

		await follow.follow(opening);

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "FORBIDDEN",
			}),
		]);
	});
});
