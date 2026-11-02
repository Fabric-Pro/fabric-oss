// @vitest-environment node
/**
 * A Direct message on a Deep Research thread (the drawer and simple mode
 * continue a Research conversation on Direct), through FabricTemporalRunner
 * against the in-memory turn table and fake Temporal: a research run that
 * ended while nobody watched is saved with its answer by the research
 * settle first, and a research run still running (or one that completes
 * right after that settle read it) is never settled with the Direct settler.
 *
 * Kept apart from `fabric-temporal-runner.test.ts` (Direct alone), which is
 * at its size limit.
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
} from "@saas/agents/runtime/fabric-temporal-runner";
import { lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorld as w } from "./_helpers/fake-direct-runtime";
import { researchOutput } from "./_helpers/research-fixtures";

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

const USER = "user-example-1";
const ORG = "org-example-1";
const THREAD = "thread-example-0001";
const RESEARCH_RUN = "run-example-0001";
const DIRECT_RUN = "run-example-0002";
const RESEARCH_EXECUTION = "wf-user-example-1-deep-researcher-example";
const AGENT_ID = "fabric-direct";

const me = { userId: USER, organizationId: ORG };

const ANSWERED: DirectChatWorkflowOutput = {
	success: true,
	responseText: "Here is the follow-up.",
	usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

function isAguiEvent(event: BaseEvent): event is AGUIEvent {
	return EventSchemas.safeParse(event).success;
}

async function directRun(message: string, runId = DIRECT_RUN) {
	const agent = new FabricRuntimeAgent();
	agent.agentId = AGENT_ID;
	const input: RunAgentInput = {
		threadId: THREAD,
		runId,
		messages: [{ id: `${runId}:message`, role: "user", content: message }],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
	};
	const runner = new FabricTemporalRunner(
		{
			[AGENT_ID]: new DirectEngine({
				...me,
				audit: { headers: new Headers() },
			}),
		},
		60_000,
	);
	const collected = await lastValueFrom(
		runner.run({ threadId: THREAD, agent, input }).pipe(toArray()),
	);
	const valid = collected.filter(isAguiEvent);
	expect(valid).toHaveLength(collected.length);
	return valid;
}

function errorCode(list: AGUIEvent[]) {
	const error = list.find((event) => event.type === EventType.RUN_ERROR);
	return error?.type === EventType.RUN_ERROR ? error.code : undefined;
}

/** A Research conversation whose run is live on its turn row. */
function seedResearchRun(workflowStatus: string) {
	w.state.conversations.set(THREAD, {
		id: THREAD,
		...me,
		agentId: "fabric-ai",
		metadata: { mode: "research" },
		messages: [],
	});
	const now = new Date();
	w.state.turns.push({
		id: "turn-research",
		...me,
		conversationId: THREAD,
		clientRequestKey: RESEARCH_RUN,
		executionId: RESEARCH_EXECUTION,
		executionMode: "research",
		status: "ACTIVE",
		startToken: null,
		questionText: "How did the market change?",
		createdAt: now,
		updatedAt: now,
		generation: 1,
	});
	w.state.workflows.set(RESEARCH_EXECUTION, {
		status: workflowStatus,
		result: researchOutput(),
		memo: { ...me },
		runId: "temporal-run-research",
	});
}

const researchTurn = () =>
	w.state.turns.find((turn) => turn.clientRequestKey === RESEARCH_RUN);

beforeEach(() => {
	w.reset(me);
	w.state.onStart = () => ({ status: "COMPLETED", result: ANSWERED });
});

describe("a Direct message on a Deep Research thread", () => {
	it.each(["research", "balanced"])(
		"refuses an existing %s run id instead of following it as a Direct turn",
		async (executionMode) => {
			seedResearchRun("COMPLETED");
			const turn = researchTurn();
			if (!turn) {
				throw new Error("Expected the seeded turn");
			}
			turn.executionMode = executionMode;
			const list = await directRun("Tell me more", RESEARCH_RUN);
			expect(errorCode(list)).toBe("RUN_ID_REUSED");
			expect(w.state.starts).toEqual([]);
			expect(
				w.state.saves.every(
					(save) => save.execution.mode === "research",
				),
			).toBe(true);
		},
	);

	it("a Direct message on a thread whose research run ended unwatched saves the research answer (metadata.research) first, then runs", async () => {
		seedResearchRun("COMPLETED");

		const list = await directRun("Tell me more");

		expect(errorCode(list)).toBeUndefined();
		expect(researchTurn()?.status).toBe("COMPLETED");
		expect(w.state.saves[0]).toMatchObject({
			execution: {
				id: RESEARCH_EXECUTION,
				mode: "research",
				status: "completed",
			},
		});
		const messages = w.state.conversations.get(THREAD)?.messages ?? [];
		expect(messages.map((message) => message.id)).toEqual([
			`${RESEARCH_RUN}:user`,
			`${RESEARCH_RUN}:assistant`,
			`${DIRECT_RUN}:user`,
			`${DIRECT_RUN}:assistant`,
		]);
		expect(messages[1]).toMatchObject({
			metadata: {
				research: {
					status: "completed",
					executionId: RESEARCH_EXECUTION,
				},
			},
		});
		expect(w.state.starts).toHaveLength(1);
	});

	it("a Direct message while a research run is still running is TURN_IN_PROGRESS and does not settle it", async () => {
		seedResearchRun("RUNNING");

		const list = await directRun("Tell me more");

		expect(errorCode(list)).toBe("TURN_IN_PROGRESS");
		expect(researchTurn()?.status).toBe("ACTIVE");
		// Read once, by the research settle; admission leaves it alone.
		expect(w.state.describes).toEqual([RESEARCH_EXECUTION]);
		expect(w.state.saves).toEqual([]);
		expect(w.state.finalizes).toEqual([]);
		expect(w.state.starts).toEqual([]);
	});

	it("a Direct message on a thread whose live Orchestrator turn's workflow was cancelled reconciles that turn and runs", async () => {
		seedResearchRun("COMPLETED");
		const orchestratorExecution = "orchestrator-example-execution";
		const now = new Date();
		w.state.turns.push({
			id: "turn-orchestrator",
			...me,
			conversationId: THREAD,
			clientRequestKey: "run-example-0003",
			executionId: orchestratorExecution,
			executionMode: "balanced",
			status: "ACTIVE",
			startToken: null,
			questionText: "Plan the release",
			createdAt: now,
			updatedAt: now,
			generation: 2,
		});
		// The research run ended long ago; the Orchestrator's turn is the latest.
		const research = researchTurn();
		if (research) {
			research.status = "COMPLETED";
		}
		w.state.workflows.set(orchestratorExecution, {
			status: "CANCELLED",
			memo: { ...me },
			runId: "temporal-run-orchestrator",
		});

		const list = await directRun("Tell me more");

		expect(errorCode(list)).toBeUndefined();
		expect(
			w.state.turns.find((turn) => turn.id === "turn-orchestrator")
				?.status,
		).toBe("CANCELLED");
		expect(w.state.starts).toHaveLength(1);
		expect(
			w.state.turns.find((turn) => turn.clientRequestKey === DIRECT_RUN),
		).toMatchObject({ executionMode: "direct", status: "COMPLETED" });
	});

	it("a research run that completes between the research settle and admission is TURN_IN_PROGRESS and never saved as a Direct answer", async () => {
		seedResearchRun("COMPLETED");
		// The research settle still reads it running.
		w.state.describeStatuses.set(RESEARCH_EXECUTION, ["RUNNING"]);

		const list = await directRun("Tell me more");

		expect(errorCode(list)).toBe("TURN_IN_PROGRESS");
		expect(researchTurn()?.status).toBe("ACTIVE");
		expect(w.state.describes).toEqual([RESEARCH_EXECUTION]);
		expect(w.state.saves).toEqual([]);
		expect(w.state.finalizes).toEqual([]);
		expect(w.state.starts).toEqual([]);
	});
});
