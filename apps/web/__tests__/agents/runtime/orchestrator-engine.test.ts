// @vitest-environment node
/**
 * OrchestratorEngine's decisions, with the turn follower, the stream route's
 * turn builder and Temporal replaced by fakes:
 *
 *   - `COPILOTKIT_ORCHESTRATOR_CHAT` off for the organization: every run and
 *     connect is refused `FEATURE_DISABLED`, and stop / isRunning do nothing;
 *   - a new message on a thread with no live turn is resolved, admitted,
 *     billed and built in the stream route's order, subscribed before its
 *     start, and started with the thumbnails in the memo; a refusal after
 *     admission abandons the turn; a Weave run is refused;
 *   - a new message while a turn runs is a follow-up signalled into it
 *     (once per run id), and the run tails the same turn; the run that
 *     admitted the turn, retried, attaches without a signal; a follow-up for
 *     a turn that ended is `TURN_NOT_RUNNING`;
 *   - a resume answers the pending approval (decided by the server with the
 *     pending approval's id, audited) or clarification (signalled, saved);
 *     an interrupt no longer pending decides nothing and says so;
 *   - stop cancels the turn its run id names, the live turn without one, and
 *     tombstones a run id no turn has yet.
 */
import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	flag: vi.fn(async () => true),
	latestTurn: vi.fn(),
	turnByKey: vi.fn(),
	cancel: vi.fn(),
	abandon: vi.fn(async () => true),
	rateLimit: vi.fn(async () => ({ allowed: true, resetInSeconds: 0 })),
	redisSet: vi.fn(async () => "OK"),
	authorizedRun: vi.fn(),
	decide: vi.fn(),
	audit: vi.fn(),
	reconcile: vi.fn(async () => "running"),
	threadAccess: vi.fn(async () => ({ kind: "owned" })),
	ensureThread: vi.fn(async () => true),
	threadMessages: vi.fn(async () => []),
	session: vi.fn(async () => ({
		user: { id: "user-1" },
		session: { impersonatedBy: null },
	})),
	resolve: vi.fn(),
	admit: vi.fn(),
	filter: vi.fn(async () => ["workspace-1"]),
	bill: vi.fn(async () => ({ planPreflight: null })),
	build: vi.fn(async () => ({ message: "input" })),
	oversized: vi.fn(() => null),
	start: vi.fn(async () => ({ handle: {}, attached: false })),
	saveClarification: vi.fn(async () => undefined),
	follows: [] as Array<{
		args: { turn: ConversationTurn; runId: string; decided?: Set<string> };
		opening?: { announce: AGUIEvent[]; resumed: boolean };
		order: string[];
	}>,
	order: [] as string[],
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: m.flag,
	getLatestConversationTurn: m.latestTurn,
	getConversationTurnByClientKey: m.turnByKey,
	requestConversationTurnCancel: m.cancel,
	abandonConversationTurnStart: m.abandon,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: {} }),
}));
vi.mock("@repo/api/lib/rate-limit", () => ({ checkRateLimit: m.rateLimit }));
vi.mock("@repo/api/lib/redis-client", () => ({
	getRedisClient: () => ({ set: m.redisSet }),
}));
vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	enterAiInteractiveContext: vi.fn(),
}));
vi.mock("@saas/auth/lib/server", () => ({ getSession: m.session }));
vi.mock("@saas/agents/lib/server/chat-run-control", () => {
	class ChatRunAccessError extends Error {}
	return {
		ChatRunAccessError,
		getAuthorizedChatRun: m.authorizedRun,
		decideChatRunApproval: m.decide,
		recordChatRunControlAudit: m.audit,
	};
});
vi.mock("@saas/agents/lib/server/conversation-turn-admission", () => ({
	isTerminalTurnStatus: (status: string) =>
		["COMPLETED", "FAILED", "LIMITED", "CANCELLED"].includes(status),
	isWorkflowNotFound: () => false,
}));
vi.mock("@saas/agents/runtime/direct-engine", () => ({
	RUN_ID_PATTERN: /^[A-Za-z0-9_-]{8,128}$/,
}));
vi.mock("@saas/agents/runtime/direct-turn-record", () => ({
	DIRECT_EXECUTION_MODE: "direct",
	apiBillingNotice: () => null,
}));
vi.mock("@saas/agents/runtime/thread", () => ({
	readThreadAccess: m.threadAccess,
	ensureThread: m.ensureThread,
	readThreadMessages: m.threadMessages,
	threadSnapshotMessages: () => [],
	threadTitle: (question: string) => question.slice(0, 40),
}));
// Multi-agent turns have their own test (`orchestrator-engine-multi-agent.test.ts`).
vi.mock("@saas/agents/runtime/multi-agent-agents", () => ({
	resolveMultiAgentPicks: vi.fn(),
}));
vi.mock("@saas/agents/runtime/orchestrator-turn-record", () => ({
	saveAnsweredClarification: m.saveClarification,
}));
vi.mock("@saas/agents/runtime/orchestrator-turn-follow", () => ({
	OrchestratorTurnFollow: class {
		private readonly entry: (typeof m.follows)[number];
		constructor(args: (typeof m.follows)[number]["args"]) {
			this.entry = { args, order: m.order };
			m.follows.push(this.entry);
		}
		async subscribe() {
			m.order.push("subscribe");
		}
		async follow(opening: { announce: AGUIEvent[]; resumed: boolean }) {
			this.entry.opening = opening;
			m.order.push("follow");
		}
		close() {
			m.order.push("close");
		}
	},
}));
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn",
	() => ({
		resolveOrchestratorTurnRequest: m.resolve,
		filterOrchestratorTurnWorkspaces: m.filter,
		billOrchestratorTurn: m.bill,
		buildOrchestratorWorkflowInput: m.build,
		refuseOversizedOrchestratorInput: m.oversized,
	}),
);
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/budget-continuation",
	() => ({ InvalidBudgetContinuationError: class extends Error {} }),
);
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/turn-admission",
	() => ({
		admitChatTurn: m.admit,
		isCancelledBeforeStart: (turn: ConversationTurn) =>
			turn.executionId === null,
		reconcileTurnWithWorkflow: m.reconcile,
		startTurnWorkflow: async (args: unknown) => {
			m.order.push("start");
			return m.start(args);
		},
		TurnStoppedBeforeStartError: class extends Error {},
		TurnStartAmbiguousError: class extends Error {},
	}),
);
vi.mock("@/app/api/agents/fabric-ai/stream/turn-events", () => ({
	buildWorkflowErrorEvent: (error: unknown) => ({
		type: "error",
		message: error instanceof Error ? error.message : String(error),
	}),
}));

const { OrchestratorEngine } = await import(
	"@saas/agents/runtime/orchestrator-engine"
);

const THREAD = "thread-example-0001";
const RUN = "run-example-0001";
const OTHER_RUN = "run-example-0002";
const EXECUTION = "orch-00000000-0000-4000-8000-000000000001";

function liveTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
	const base = {
		id: "turn-1",
		organizationId: "org-1",
		userId: "user-1",
		conversationId: THREAD,
		clientRequestKey: RUN,
		executionId: EXECUTION,
		generation: 1,
		executionMode: "balanced",
		status: "ACTIVE",
		startToken: "token-1",
		terminalAt: null,
		questionText: "First question",
		createdAt: new Date("2026-10-01T10:00:00.000Z"),
	};
	// The row's remaining columns are not read by the engine.
	return { ...base, ...overrides } as ConversationTurn;
}

function engine() {
	return new OrchestratorEngine({
		userId: "user-1",
		organizationId: "org-1",
		audit: { headers: new Headers() },
	});
}

function stream() {
	const events: AGUIEvent[] = [];
	return {
		events,
		stream: {
			emit: (event: AGUIEvent) => events.push(event),
			isClosed: () => false,
			deadline: Date.now() + 60_000,
		},
	};
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
			? [{ id: `${runId}:m`, role: "user", content: message }]
			: [],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
		...extra,
	};
}

async function run(runInput: RunAgentInput) {
	const { events, stream: s } = stream();
	await engine().run({ threadId: THREAD, input: runInput }, s);
	return events;
}

function controlRun(queries: Record<string, unknown> = {}) {
	const handle = {
		signal: vi.fn(async () => undefined),
		cancel: vi.fn(async () => undefined),
		query: vi.fn(async (name: string) => queries[name] ?? null),
	};
	m.authorizedRun.mockResolvedValue({
		handle,
		description: {
			status: { name: "RUNNING" },
			runId: "temporal-run-1",
			workflowId: EXECUTION,
		},
		organizationId: "org-1",
	});
	return handle;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.follows.length = 0;
	m.order.length = 0;
	m.flag.mockResolvedValue(true);
	m.latestTurn.mockResolvedValue(null);
	m.threadAccess.mockResolvedValue({ kind: "owned" });
	m.reconcile.mockResolvedValue("running");
	m.rateLimit.mockResolvedValue({ allowed: true, resetInSeconds: 0 });
	m.redisSet.mockResolvedValue("OK");
	m.resolve.mockResolvedValue({
		executionMode: "balanced",
		workspaceIds: ["workspace-1"],
		projectId: "project-1",
		continueFromTurnId: undefined,
	});
	m.admit.mockResolvedValue({
		kind: "created",
		turn: liveTurn({ status: "START_PENDING" }),
	});
});

describe("the rollout flag", () => {
	it("refuses runs and connects, and stops nothing, while the flag is off", async () => {
		m.flag.mockResolvedValue(false);
		const s = stream();
		const e = engine();

		await e.run({ threadId: THREAD, input: input(RUN, "Hi") }, s.stream);
		await e.connect(THREAD, s.stream);

		expect(s.events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "FEATURE_DISABLED",
			}),
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "FEATURE_DISABLED",
			}),
		]);
		expect(await e.stop(THREAD, RUN)).toBe(false);
		expect(await e.isRunning(THREAD)).toBe(false);
		expect(m.flag).toHaveBeenCalledWith(
			"COPILOTKIT_ORCHESTRATOR_CHAT",
			"org-1",
		);
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.cancel).not.toHaveBeenCalled();
	});
});

describe("a new turn", () => {
	it("is resolved, admitted, billed and built in order, and started after the subscription", async () => {
		await run(
			input(RUN, "Plan the release", {
				forwardedProps: {
					executionMode: "balanced",
					displayImageUrls: ["uploads/one.png"],
					organizationId: "org-from-client",
					conversationId: "another-thread",
					executionId: "orch-from-client",
				},
			}),
		);

		expect(m.resolve).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					message: "Plan the release",
					organizationId: "org-1",
					conversationId: THREAD,
					clientRequestKey: RUN,
					executionId: undefined,
				}),
			}),
		);
		expect(m.admit).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: THREAD,
				clientRequestKey: RUN,
				executionMode: "balanced",
				question: "Plan the release",
			}),
		);
		expect(m.order).toEqual(["subscribe", "start", "follow"]);
		expect(m.start).toHaveBeenCalledWith(
			expect.objectContaining({
				memo: {
					userId: "user-1",
					organizationId: "org-1",
					projectId: "project-1",
					displayImageUrls: ["uploads/one.png"],
				},
			}),
		);
		expect(m.follows[0]?.opening?.resumed).toBe(false);
	});

	it("abandons an admitted turn its billing refuses, and reports the refusal", async () => {
		m.bill.mockResolvedValueOnce(
			Response.json(
				{ error: "Limit", code: "AI_USAGE_LIMIT_EXCEEDED" },
				{ status: 429 },
			),
		);
		const events = await run(input(RUN, "Plan the release"));

		expect(m.abandon).toHaveBeenCalledWith(
			expect.objectContaining({ turnId: "turn-1", cancelled: false }),
		);
		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "AI_USAGE_LIMIT_EXCEEDED",
			}),
		]);
		expect(m.start).not.toHaveBeenCalled();
	});

	it("refuses a Weave run before anything is admitted", async () => {
		const events = await run(
			input(RUN, "Weave it", {
				forwardedProps: { executionMode: "weave" },
			}),
		);
		expect(events).toEqual([
			expect.objectContaining({ code: "UNSUPPORTED_EXECUTION_MODE" }),
		]);
		expect(m.ensureThread).not.toHaveBeenCalled();
	});

	it("refuses a follow-up when no turn is running", async () => {
		const events = await run(
			input(OTHER_RUN, "And also this", {
				forwardedProps: { followUp: { isModification: false } },
			}),
		);
		expect(events).toEqual([
			expect.objectContaining({ code: "TURN_NOT_RUNNING" }),
		]);
		expect(m.admit).not.toHaveBeenCalled();
	});
});

describe("a message while a turn runs", () => {
	beforeEach(() => {
		m.latestTurn.mockResolvedValue(liveTurn());
	});

	it("is a follow-up signalled into the running turn, which the run then tails", async () => {
		const handle = controlRun();
		await run(
			input(OTHER_RUN, "Use the staging data", {
				forwardedProps: { followUp: { isModification: true } },
			}),
		);

		expect(handle.signal).toHaveBeenCalledWith("followUp", {
			message: "Use the staging data",
			isModification: true,
		});
		expect(m.rateLimit).toHaveBeenCalledWith(
			"orchestrator:follow-up:user-1",
			20,
			60_000,
		);
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.follows[0]?.args.runId).toBe(OTHER_RUN);
		expect(m.follows[0]?.opening?.announce).toEqual([
			{
				type: EventType.CUSTOM,
				name: "fabric.orchestrator.follow-up",
				value: {
					executionId: EXECUTION,
					messageId: `${OTHER_RUN}:user`,
					isModification: true,
				},
			},
		]);
	});

	it("signals a retried follow-up run once", async () => {
		const handle = controlRun();
		m.redisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
		await run(input(OTHER_RUN, "Again"));
		await run(input(OTHER_RUN, "Again"));
		expect(handle.signal).toHaveBeenCalledTimes(1);
		expect(m.follows).toHaveLength(2);
	});

	it("attaches the retried run that admitted the turn, without a signal", async () => {
		const handle = controlRun();
		await run(input(RUN, "First question"));
		expect(handle.signal).not.toHaveBeenCalled();
		expect(m.follows[0]?.opening?.announce).toEqual([]);
	});

	it("never signals a message into a turn that was stopped and is still ending", async () => {
		m.latestTurn.mockResolvedValue(
			liveTurn({ cancelRequestedAt: new Date("2026-10-01T10:01:00Z") }),
		);
		const handle = controlRun();

		const plain = await run(input(OTHER_RUN, "Next question"));
		const followUp = await run(
			input("run-example-0003", "And also", {
				forwardedProps: { followUp: { isModification: false } },
			}),
		);

		expect(plain).toEqual([
			expect.objectContaining({ code: "TURN_STOPPING" }),
		]);
		expect(followUp).toEqual([
			expect.objectContaining({ code: "TURN_NOT_RUNNING" }),
		]);
		expect(handle.signal).not.toHaveBeenCalled();
		expect(m.follows).toEqual([]);
	});

	it("refuses a follow-up for a turn whose workflow is no longer running", async () => {
		controlRun();
		m.authorizedRun.mockResolvedValueOnce({
			handle: { signal: vi.fn() },
			description: { status: { name: "COMPLETED" } },
			organizationId: "org-1",
		});
		const events = await run(input(OTHER_RUN, "Too late"));
		expect(events).toEqual([
			expect.objectContaining({ code: "TURN_NOT_RUNNING" }),
		]);
		expect(m.follows).toEqual([]);
	});
});

describe("answering an interrupt", () => {
	beforeEach(() => {
		m.latestTurn.mockResolvedValue(liveTurn());
	});

	it("decides the pending approval with its own id, audits it, and tails the turn", async () => {
		controlRun({
			pendingApproval: {
				approvalId: "approval-1",
				stepId: "step-1",
				reason: "Writes",
			},
		});
		m.decide.mockResolvedValue({ kind: "decided" });

		await run(
			input(OTHER_RUN, null, {
				resume: [
					{
						interruptId: "approval-1",
						status: "resolved",
						payload: { approved: true, feedback: "Go" },
					},
				],
			}),
		);

		expect(m.decide).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalId: "approval-1",
				approved: true,
				feedback: "Go",
			}),
		);
		expect(m.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "approve",
				approvalId: "approval-1",
				approved: true,
			}),
		);
		expect(m.follows[0]?.args.decided).toEqual(new Set(["approval-1"]));
		expect(m.follows[0]?.opening?.announce).toEqual([
			{
				type: EventType.CUSTOM,
				name: "fabric.orchestrator.event",
				value: {
					type: "approval_resolved",
					approvalId: "approval-1",
					stepId: "step-1",
					message: "Approval resolved",
				},
			},
		]);
	});

	it("rejects when the answer is cancelled", async () => {
		controlRun({
			pendingApproval: {
				approvalId: "approval-1",
				stepId: "s",
				reason: "r",
			},
		});
		m.decide.mockResolvedValue({ kind: "decided" });
		await run(
			input(OTHER_RUN, null, {
				resume: [{ interruptId: "approval-1", status: "cancelled" }],
			}),
		);
		expect(m.decide).toHaveBeenCalledWith(
			expect.objectContaining({ approved: false }),
		);
	});

	it("signals and saves a clarification answer", async () => {
		const handle = controlRun({
			pendingClarification: {
				clarificationId: "clarification-1",
				question: "Which project?",
			},
		});
		await run(
			input(OTHER_RUN, null, {
				resume: [
					{
						interruptId: "clarification-1",
						status: "resolved",
						payload: { answer: " The web app " },
					},
				],
			}),
		);
		expect(handle.signal).toHaveBeenCalledWith("clarification", {
			answer: " The web app ",
			dismissed: false,
		});
		expect(m.saveClarification).toHaveBeenCalledWith(
			expect.objectContaining({ id: "turn-1" }),
			"clarification-1",
			{ question: "Which project?", answer: "The web app" },
		);
		expect(m.follows[0]?.args.decided).toEqual(
			new Set(["clarification-1"]),
		);
	});

	it("refuses an empty clarification answer", async () => {
		const handle = controlRun({
			pendingClarification: { clarificationId: "c-1", question: "Q?" },
		});
		const events = await run(
			input(OTHER_RUN, null, {
				resume: [
					{
						interruptId: "c-1",
						status: "resolved",
						payload: { answer: " " },
					},
				],
			}),
		);
		expect(events).toEqual([
			expect.objectContaining({ code: "INVALID_ANSWER" }),
		]);
		expect(handle.signal).not.toHaveBeenCalled();
	});

	it("decides nothing for an interrupt no longer pending, says so, and tails the turn", async () => {
		const handle = controlRun({
			pendingApproval: {
				approvalId: "approval-2",
				stepId: "s",
				reason: "r",
			},
		});
		await run(
			input(OTHER_RUN, null, {
				resume: [
					{
						interruptId: "approval-1",
						status: "resolved",
						payload: { approved: true },
					},
				],
			}),
		);
		expect(m.decide).not.toHaveBeenCalled();
		expect(handle.signal).not.toHaveBeenCalled();
		expect(m.follows[0]?.args.decided).toBeUndefined();
		expect(m.follows[0]?.opening?.announce).toEqual([
			{
				type: EventType.CUSTOM,
				name: "fabric.orchestrator.interrupt-stale",
				value: { interruptId: "approval-1" },
			},
		]);
	});
});

describe("stop", () => {
	it("tombstones a run id no turn has yet", async () => {
		m.turnByKey.mockResolvedValue(null);
		m.cancel.mockResolvedValue({ outcome: "tombstoned" });
		expect(await engine().stop(THREAD, OTHER_RUN)).toBe(true);
		expect(m.cancel).toHaveBeenCalledWith(
			expect.objectContaining({
				clientRequestKey: OTHER_RUN,
				conversationId: THREAD,
				source: "USER_STOP",
			}),
		);
	});

	it("cancels the live turn its run id names, recording the cancel first", async () => {
		m.turnByKey.mockResolvedValue(liveTurn());
		m.cancel.mockResolvedValue({ outcome: "recorded" });
		const handle = controlRun();
		expect(await engine().stop(THREAD, RUN)).toBe(true);
		expect(m.cancel).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: EXECUTION }),
		);
		expect(handle.cancel).toHaveBeenCalled();
		expect(m.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "cancel",
				executionId: EXECUTION,
			}),
		);
	});

	it("never cancels a Direct turn by its run id", async () => {
		m.turnByKey.mockResolvedValue(liveTurn({ executionMode: "direct" }));
		expect(await engine().stop(THREAD, RUN)).toBe(false);
		expect(m.cancel).not.toHaveBeenCalled();
	});

	it("cancels the thread's live turn when no run id is named", async () => {
		m.latestTurn.mockResolvedValue(liveTurn());
		const handle = controlRun();
		expect(await engine().stop(THREAD)).toBe(true);
		expect(handle.cancel).toHaveBeenCalled();
	});
});
