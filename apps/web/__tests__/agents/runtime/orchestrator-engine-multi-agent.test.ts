// @vitest-environment node
/**
 * OrchestratorEngine's multi-agent turns (`multi-agent-turns.ts`), with the
 * group follower, the agent resolver, the stream route's turn builder and
 * Temporal replaced by fakes:
 *
 *   - a multi-agent message is refused while `COPILOTKIT_MULTI_AGENT_CHAT`
 *     is off, above four agents (`MULTI_AGENT_LIMIT`), and for an agent the
 *     caller cannot use (`AGENT_NOT_AVAILABLE`);
 *   - it resolves one Nexus-surface turn request per agent (each with that
 *     agent's prompt, the thread's conversation and its own key), admits
 *     the first agent into the conversation and the rest into none, names
 *     the agents in the conversation before any start, bills each agent,
 *     and starts them after the subscription;
 *   - the turn stays live until every agent has ended: with the first
 *     agent done and another running, a new message is refused
 *     `TURN_IN_PROGRESS`, the thread is running, and a stop cancels only the
 *     agent still running; once all have ended a new message starts a turn;
 *   - a resume answers the agent its interrupt id names, with that agent's
 *     own id.
 */
import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	flags: new Map<string, boolean>(),
	latestTurn: vi.fn(),
	turnByKey: vi.fn(),
	turnsByKeys: vi.fn(async (): Promise<unknown[]> => []),
	conversation: vi.fn(async (): Promise<unknown> => null),
	save: vi.fn(async () => ({ addedMessages: 0, removedMessages: 0 })),
	cancel: vi.fn(async () => ({ outcome: "recorded" })),
	abandon: vi.fn(async () => true),
	rateLimit: vi.fn(async () => ({ allowed: true, resetInSeconds: 0 })),
	authorizedRun: vi.fn(),
	reconcile: vi.fn(async (_args: { turn: { id: string } }) => "running"),
	resolvePicks: vi.fn(),
	resolve: vi.fn(),
	admit: vi.fn(),
	bill: vi.fn(async () => ({ planPreflight: null })),
	build: vi.fn(async () => ({ message: "input" })),
	start: vi.fn(async () => ({ handle: {}, attached: false })),
	answer: vi.fn(),
	follows: [] as Array<{
		args: {
			group: { members: Array<{ memberKey: string }> };
			runId: string;
			decided?: Map<string, Set<string>>;
		};
		opening?: { billing: Map<string, unknown>; resumed: boolean };
	}>,
	order: [] as string[],
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async (flag: string) => m.flags.get(flag) ?? false,
	getLatestConversationTurn: m.latestTurn,
	getConversationTurnByClientKey: m.turnByKey,
	getConversationTurnsByClientKeys: m.turnsByKeys,
	getAgentConversationById: m.conversation,
	saveConversationTurn: async (args: unknown) => {
		m.order.push("save");
		return m.save(args);
	},
	requestConversationTurnCancel: m.cancel,
	abandonConversationTurnStart: m.abandon,
	db: {
		organization: { findUnique: async () => ({ slug: "example-org" }) },
	},
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: {} }),
}));
vi.mock("@repo/api/lib/rate-limit", () => ({ checkRateLimit: m.rateLimit }));
vi.mock("@repo/api/lib/redis-client", () => ({ getRedisClient: () => null }));
vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	enterAiInteractiveContext: vi.fn(),
}));
vi.mock("@saas/auth/lib/server", () => ({
	getSession: async () => ({
		user: { id: "user-1" },
		session: { impersonatedBy: null },
	}),
}));
vi.mock("@saas/agents/lib/server/chat-run-control", () => {
	class ChatRunAccessError extends Error {}
	return {
		ChatRunAccessError,
		getAuthorizedChatRun: m.authorizedRun,
		recordChatRunControlAudit: vi.fn(),
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
	readThreadAccess: async () => ({ kind: "owned" }),
	ensureThread: async () => true,
	readThreadMessages: async () => [],
	threadSnapshotMessages: () => [],
	threadTitle: (question: string) => question.slice(0, 40),
}));
vi.mock("@saas/agents/runtime/orchestrator-interrupt-answer", () => ({
	answerOrchestratorInterrupt: m.answer,
}));
vi.mock("@saas/agents/runtime/orchestrator-turn-follow", () => ({
	OrchestratorTurnFollow: class {
		async subscribe() {
			m.order.push("subscribe-single");
		}
		async follow() {
			m.order.push("follow-single");
		}
		close() {}
	},
}));
vi.mock("@saas/agents/runtime/multi-agent-agents", () => ({
	resolveMultiAgentPicks: m.resolvePicks,
}));
vi.mock("@saas/agents/runtime/multi-agent-turn-follow", () => ({
	MultiAgentTurnFollow: class {
		private readonly entry: (typeof m.follows)[number];
		constructor(args: (typeof m.follows)[number]["args"]) {
			this.entry = { args };
			m.follows.push(this.entry);
		}
		async subscribe() {
			m.order.push("subscribe");
		}
		async follow(opening: (typeof m.follows)[number]["opening"]) {
			this.entry.opening = opening;
			m.order.push("follow");
		}
		close() {
			m.order.push("close");
		}
	},
	multiAgentQuestion: () => ({ id: "q", content: "question" }),
}));
vi.mock(
	"@/app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn",
	() => ({
		resolveOrchestratorTurnRequest: m.resolve,
		filterOrchestratorTurnWorkspaces: async () => [],
		billOrchestratorTurn: async () => {
			m.order.push("bill");
			return m.bill();
		},
		buildOrchestratorWorkflowInput: m.build,
		refuseOversizedOrchestratorInput: () => null,
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
		isCancelledBeforeStart: () => false,
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
const KEY = "ma_run-example-0001";
const AGENTS = ["model:alpha", "model:beta"];

function turn(
	key: string,
	overrides: Partial<ConversationTurn> = {},
): ConversationTurn {
	const base = {
		id: `turn-${key}`,
		organizationId: "org-1",
		userId: "user-1",
		conversationId: key === KEY ? THREAD : null,
		clientRequestKey: key,
		executionId: `orch-${key}`,
		generation: key === KEY ? 1 : null,
		executionMode: "balanced",
		status: "ACTIVE",
		startToken: "token-1",
		terminalAt: null,
		questionText: "Compare the plans",
		createdAt: new Date("2026-10-01T10:00:00.000Z"),
	};
	// The row's remaining columns are not read by the engine.
	return { ...base, ...overrides } as ConversationTurn;
}

/** The record the admission save leaves, as the conversation returns it. */
function savedRecord(statuses: string[] = ["running", "running"]) {
	return {
		metadata: {
			executions: [
				{
					id: `orch-${KEY}`,
					multiAgent: {
						version: 1,
						final: false,
						agents: statuses.map((status, index) => ({
							index,
							agentId: AGENTS[index],
							name: `Agent ${index}`,
							memberKey: index === 0 ? KEY : `${KEY}_a${index}`,
							executionId: `orch-${index === 0 ? KEY : `${KEY}_a${index}`}`,
							turnId: `turn-${index}`,
							status,
						})),
					},
				},
			],
		},
	};
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
	agentIds: string[] | null,
	extra: Record<string, unknown> = {},
): RunAgentInput {
	return {
		threadId: THREAD,
		runId,
		messages: [
			{ id: `${runId}:m`, role: "user", content: "Compare the plans" },
		],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {
			...(agentIds
				? {
						multiAgent: {
							agents: agentIds.map((agentId) => ({ agentId })),
						},
					}
				: {}),
			...extra,
		},
	};
}

async function run(runInput: RunAgentInput) {
	const { events, stream: s } = stream();
	await engine().run({ threadId: THREAD, input: runInput }, s);
	return events;
}

const codeOf = (events: AGUIEvent[]) =>
	events.find((event) => event.type === EventType.RUN_ERROR);

beforeEach(() => {
	vi.clearAllMocks();
	m.follows.length = 0;
	m.order.length = 0;
	m.flags.clear();
	m.flags.set("COPILOTKIT_ORCHESTRATOR_CHAT", true);
	m.flags.set("COPILOTKIT_MULTI_AGENT_CHAT", true);
	m.latestTurn.mockResolvedValue(null);
	m.turnByKey.mockResolvedValue(null);
	m.turnsByKeys.mockResolvedValue([]);
	m.conversation.mockResolvedValue(null);
	m.reconcile.mockResolvedValue("running");
	m.resolvePicks.mockImplementation(async (_caller, agentIds: string[]) => ({
		kind: "resolved",
		agents: agentIds.map((agentId, index) => ({
			agentId,
			name: `Agent ${index}`,
			profile: {
				agentId,
				name: `Agent ${index}`,
				instructions: `Prompt of ${agentId}`,
			},
		})),
	}));
	m.resolve.mockImplementation(
		async ({ body }: { body: { clientRequestKey: string } }) => ({
			executionMode: "balanced",
			workspaceIds: [],
			projectId: null,
			clientRequestKey: body.clientRequestKey,
		}),
	);
	m.admit.mockImplementation(
		async (args: {
			clientRequestKey: string;
			conversationId: string | null;
		}) => {
			m.order.push(`admit:${args.clientRequestKey}`);
			return {
				kind: "created",
				turn: turn(args.clientRequestKey, { status: "START_PENDING" }),
			};
		},
	);
});

describe("a multi-agent message", () => {
	it("is refused while COPILOTKIT_MULTI_AGENT_CHAT is off", async () => {
		m.flags.set("COPILOTKIT_MULTI_AGENT_CHAT", false);

		const events = await run(input(KEY, AGENTS));

		expect(codeOf(events)).toMatchObject({ code: "FEATURE_DISABLED" });
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("is refused above four agents with a typed error", async () => {
		const events = await run(
			input(KEY, ["model:a", "model:b", "model:c", "model:d", "model:e"]),
		);

		expect(codeOf(events)).toMatchObject({ code: "MULTI_AGENT_LIMIT" });
		expect(m.resolvePicks).not.toHaveBeenCalled();
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("is refused when the caller cannot use one of the agents", async () => {
		m.resolvePicks.mockResolvedValue({
			kind: "refused",
			agentId: "template-instance:other-org",
			message: "not available",
		});

		const events = await run(input(KEY, AGENTS));

		expect(codeOf(events)).toMatchObject({ code: "AGENT_NOT_AVAILABLE" });
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("starts one Nexus-surface turn per agent, the first in the conversation", async () => {
		await run(
			input(KEY, AGENTS, {
				projectId: "project-1",
				// The chat's shared fields, as a single turn's run carries them.
				enabledFabricToolIds: ["web_search"],
				enabledIntegrationIds: ["integration-1"],
				attachedDocumentIds: ["document-1"],
				inlineAttachmentContexts: ["inline context"],
				attachedImageUrls: ["uploads/one.png"],
				organizationSlug: "slug-from-client",
				modelOverride: "model-from-chat",
			}),
		);

		expect(m.resolve).toHaveBeenCalledTimes(2);
		for (const [index, key] of [KEY, `${KEY}_a1`].entries()) {
			expect(m.resolve).toHaveBeenNthCalledWith(
				index + 1,
				expect.objectContaining({
					body: expect.objectContaining({
						surface: "nexus",
						conversationId: THREAD,
						clientRequestKey: key,
						systemPrompt: `Prompt of ${AGENTS[index]}`,
						projectId: "project-1",
						enabledFabricToolIds: ["web_search"],
						enabledIntegrationIds: ["integration-1"],
						attachedDocumentIds: ["document-1"],
						inlineAttachmentContexts: ["inline context"],
						attachedImageUrls: ["uploads/one.png"],
						organizationSlug: "example-org",
						// The agent's own model (none here), never the chat's.
						modelOverride: undefined,
					}),
				}),
			);
		}
		expect(m.admit).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				conversationId: THREAD,
				clientRequestKey: KEY,
			}),
		);
		expect(m.admit).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				conversationId: null,
				clientRequestKey: `${KEY}_a1`,
			}),
		);
		expect(m.order).toEqual([
			`admit:${KEY}`,
			`admit:${KEY}_a1`,
			"save",
			"bill",
			"bill",
			"subscribe",
			"start",
			"start",
			"follow",
		]);
		const saved = m.save.mock.calls[0]?.[0] as unknown as {
			id: string;
			execution: {
				id: string;
				mode: string;
				multiAgent: { agents: unknown[] };
			};
		};
		expect(saved.id).toBe(THREAD);
		expect(saved.execution).toMatchObject({
			id: `orch-${KEY}`,
			mode: "multi-agent",
			multiAgent: { final: false },
		});
		expect(saved.execution.multiAgent.agents).toHaveLength(2);
		expect([...(m.follows[0]?.opening?.billing.keys() ?? [])]).toEqual([
			KEY,
			`${KEY}_a1`,
		]);
	});
});

describe("a running multi-agent turn", () => {
	beforeEach(() => {
		// The first agent has ended; the second still runs.
		m.latestTurn.mockResolvedValue(
			turn(KEY, { status: "COMPLETED", terminalAt: new Date() }),
		);
		m.turnsByKeys.mockResolvedValue([turn(`${KEY}_a1`)]);
		m.conversation.mockResolvedValue(savedRecord(["complete", "running"]));
	});

	it("stays live until every agent has ended: a new message is refused", async () => {
		const single = await run(input("run-example-0002", null));
		const multi = await run(input("ma_run-example-0002", AGENTS));

		expect(codeOf(single)).toMatchObject({ code: "TURN_IN_PROGRESS" });
		expect(codeOf(multi)).toMatchObject({ code: "TURN_IN_PROGRESS" });
		expect(await engine().isRunning(THREAD)).toBe(true);
		expect(m.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: expect.objectContaining({
					clientRequestKey: `${KEY}_a1`,
				}),
			}),
		);
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("attaches the retried run that started it", async () => {
		await run(input(KEY, AGENTS));

		expect(m.follows).toHaveLength(1);
		expect(m.follows[0]?.args.runId).toBe(KEY);
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("stops only the agents still running", async () => {
		m.authorizedRun.mockRejectedValue(new Error("workflow not found"));

		await engine()
			.stop(THREAD)
			.catch(() => undefined);

		expect(m.authorizedRun).toHaveBeenCalledTimes(1);
		expect(m.authorizedRun).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: `orch-${KEY}_a1` }),
		);
	});

	it("answers the agent the interrupt id names, with its own id", async () => {
		const handle = { signal: vi.fn(), query: vi.fn() };
		m.authorizedRun.mockResolvedValue({
			handle,
			description: { status: { name: "RUNNING" }, runId: "r" },
			organizationId: "org-1",
		});
		m.answer.mockResolvedValue({
			kind: "resolved",
			event: { type: EventType.CUSTOM, name: "resolved", value: {} },
		});

		await run({
			...input("run-example-0003", null),
			resume: [
				{ interruptId: `${KEY}_a1:approval-1`, status: "resolved" },
			],
		});

		expect(m.answer).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: expect.objectContaining({
					clientRequestKey: `${KEY}_a1`,
				}),
				answer: expect.objectContaining({ interruptId: "approval-1" }),
			}),
		);
		expect(m.follows[0]?.args.decided?.get(`${KEY}_a1`)).toEqual(
			new Set(["approval-1"]),
		);
	});

	it("takes a new message once every agent has ended", async () => {
		m.turnsByKeys.mockResolvedValue([
			turn(`${KEY}_a1`, { status: "COMPLETED", terminalAt: new Date() }),
		]);

		await run(input("run-example-0004", null));

		expect(await engine().isRunning(THREAD)).toBe(false);
		expect(m.admit).toHaveBeenCalledWith(
			expect.objectContaining({ clientRequestKey: "run-example-0004" }),
		);
	});
});
