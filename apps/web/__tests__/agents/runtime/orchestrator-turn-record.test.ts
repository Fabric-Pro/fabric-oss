// @vitest-environment node
/**
 * What the Orchestrator engine saves into a conversation, read back through
 * the conversation's read projection (`hydrateConversationTurnResults`), as
 * a reload shows it:
 *
 *   - mid-turn, the question shows exactly once: as the running record the
 *     projection makes from the turn row, or, once a clarification was
 *     answered and saved, as the saved question the running record names;
 *   - a finished turn reopened shows its question, its clarification and
 *     its answer once each, and a second save of the same turn adds
 *     nothing;
 *   - the record is the one the chat's own save writes: routing, plan,
 *     steps (without truncation sentinels), billing, thumbnails, and the
 *     chat's fallback answers; a usage-limit refusal saves nothing.
 *
 * `saveConversationTurn` is replaced by its contract: messages stamped with
 * the execution, a message or a record with a known id replaced in place.
 */
import type { ConversationTurn } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateConversationTurnResults } from "../../../../../packages/database/prisma/queries/conversation-turn-results";

type Stored = {
	messages: Array<Record<string, unknown> & { id: string }>;
	metadata: { executions: Array<Record<string, unknown> & { id: string }> };
};

const store = vi.hoisted(() => ({
	conversation: {
		messages: [],
		metadata: { executions: [] },
	} as {
		messages: Array<Record<string, unknown> & { id: string }>;
		metadata: {
			executions: Array<Record<string, unknown> & { id: string }>;
		};
	},
	saves: 0,
}));

vi.mock("../../../../../packages/database/prisma/client", () => ({ db: {} }));
vi.mock("@repo/database", () => ({
	getAgentConversationById: async () => store.conversation,
	saveConversationTurn: async (args: {
		messages: Array<Record<string, unknown> & { id: string }>;
		execution: Record<string, unknown> & { id: string };
	}) => {
		store.saves += 1;
		const { conversation } = store;
		for (const message of args.messages) {
			const stamped = {
				...message,
				metadata: {
					...(message.metadata as
						| Record<string, unknown>
						| undefined),
					executionId: args.execution.id,
				},
			};
			const index = conversation.messages.findIndex(
				(stored) => stored.id === message.id,
			);
			if (index === -1) {
				conversation.messages.push(stamped);
			} else {
				conversation.messages[index] = stamped;
			}
		}
		const executions = conversation.metadata.executions;
		const at = executions.findIndex(
			(execution) => execution.id === args.execution.id,
		);
		if (at === -1) {
			executions.push(args.execution);
		} else {
			executions[at] = args.execution;
		}
		return { addedMessages: args.messages.length, removedMessages: 0 };
	},
}));

const { saveAnsweredClarification, saveOrchestratorTurn } = await import(
	"@saas/agents/runtime/orchestrator-turn-record"
);

const KEY = "turn-key-0001";
const EXECUTION = "orch-00000000-0000-4000-8000-000000000001";
const QUESTION = "Summarize the project risks";
const ANSWER = "The main risk is the migration.";
const started = new Date("2026-10-01T10:00:00.000Z");
const ended = new Date("2026-10-01T10:05:00.000Z");

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
	const base = {
		id: "turn-1",
		organizationId: "example-org",
		userId: "user-1",
		conversationId: "conversation-1",
		scopeConversationId: "conversation-1",
		clientRequestKey: KEY,
		executionId: EXECUTION,
		generation: 1,
		executionMode: "balanced",
		status: "ACTIVE",
		startToken: null,
		cancelRequestedAt: null,
		cancelRequestedByUserId: null,
		cancelSource: null,
		terminalAt: null,
		terminalReason: null,
		questionText: QUESTION,
		responseText: null,
		limitSignalSummary: null,
		budgetStop: null,
		tokenAllowance: null,
		createdAt: started,
		updatedAt: started,
	};
	// The row's remaining columns are not read here.
	return { ...base, ...overrides } as ConversationTurn;
}

function terminalTurn(): ConversationTurn {
	return turn({
		status: "COMPLETED",
		terminalAt: ended,
		terminalReason: "completed",
		responseText: ANSWER,
	});
}

function facts() {
	return {
		routing: null,
		plan: null,
		answerText: "",
		steps: new Map(),
	};
}

function hydrate(row: ConversationTurn) {
	const hydrated = hydrateConversationTurnResults(
		structuredClone(store.conversation),
		[row],
	) as unknown as Stored;
	return {
		messages: hydrated.messages,
		executions: hydrated.metadata.executions.filter(
			(execution) => execution.id === EXECUTION,
		),
	};
}

const completed = {
	type: "completed" as const,
	status: "completed",
	response: ANSWER,
};

beforeEach(() => {
	store.conversation.messages = [];
	store.conversation.metadata = { executions: [] };
	store.saves = 0;
});

describe("reloading while the turn runs", () => {
	it("shows the question once, from the turn row, before anything is saved", () => {
		const { messages, executions } = hydrate(turn());

		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({
			userMessage: QUESTION,
			status: "running",
			inProgress: true,
		});
		expect(
			messages.filter((message) => message.content === QUESTION),
		).toEqual([]);
	});

	it("shows the question once after a clarification was saved, with the clarification", async () => {
		await saveAnsweredClarification(turn(), "clarification-1", {
			question: "Which project?",
			answer: "The web app",
		});

		const { messages, executions } = hydrate(turn());

		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({
			userMessage: QUESTION,
			status: "running",
			inProgress: true,
			questionMessageId: `${KEY}:user`,
			clarifications: [
				{ question: "Which project?", answer: "The web app" },
			],
		});
		const questions = messages.filter(
			(message) => message.content === QUESTION,
		);
		expect(questions).toHaveLength(1);
		expect(questions[0]?.id).toBe(`${KEY}:user`);
		expect(
			messages.filter(
				(message) =>
					message.id === `${KEY}:clarification:clarification-1`,
			),
		).toHaveLength(1);
	});
});

describe("reopening a finished turn", () => {
	it("shows the question, the clarification and the answer once each, however often it is saved", async () => {
		await saveAnsweredClarification(turn(), "clarification-1", {
			question: "Which project?",
			answer: "The web app",
		});
		await saveOrchestratorTurn(
			{ turn: turn(), imageUrls: undefined, billing: null },
			completed,
			facts(),
		);
		await saveOrchestratorTurn(
			{ turn: turn(), imageUrls: undefined, billing: null },
			completed,
			facts(),
		);

		const { messages, executions } = hydrate(terminalTurn());

		expect(store.saves).toBe(3);
		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({
			userMessage: QUESTION,
			finalResponse: ANSWER,
			status: "complete",
			clarifications: [
				{ question: "Which project?", answer: "The web app" },
			],
		});
		expect(executions[0]).not.toHaveProperty("inProgress");
		expect(
			messages.filter((message) => message.content === QUESTION),
		).toHaveLength(1);
		expect(
			messages.filter(
				(message) =>
					message.role === "assistant" && message.content === ANSWER,
			),
		).toHaveLength(1);
		expect(messages.map((message) => message.id)).toEqual([
			`${KEY}:user`,
			`${KEY}:clarification:clarification-1`,
			`${KEY}:assistant`,
		]);
	});
});

describe("the saved record", () => {
	const save = (
		terminal: Parameters<typeof saveOrchestratorTurn>[1],
		turnFacts: Parameters<typeof saveOrchestratorTurn>[2] = facts(),
	) =>
		saveOrchestratorTurn(
			{
				turn: turn(),
				imageUrls: ["uploads/example.png"],
				billing: { resetAt: null },
			},
			terminal,
			turnFacts,
		);
	const record = () => store.conversation.metadata.executions[0];
	const answer = () =>
		store.conversation.messages.find(
			(message) => message.id === `${KEY}:assistant`,
		);

	it("is the chat's record: routing, plan, steps without sentinels, billing and thumbnails", async () => {
		const turnFacts = facts();
		turnFacts.routing = {
			type: "routing",
			primaryAgent: "task_planner",
			agentName: "ignored",
			confidence: 0.8,
		};
		await save(
			{
				...completed,
				plan: {
					id: "plan-1",
					description: "",
					riskLevel: "low",
					steps: [{ id: "step-1", description: "One", order: 1 }],
				},
				stepResults: [
					{
						stepId: "step-1",
						stepDescription: "One",
						response: "Done",
						toolCalls: [
							{
								name: "draw",
								args: "[Object truncated, 90000 chars]",
								result: { ok: true },
								mcpAppResourceUri: "ui://example/app",
							},
						],
					},
				],
				planningAudit: {
					headline: "h",
					keyFactors: [],
					sourcesUsed: ["doc-1"],
					usedMemory: false,
					usedResearch: false,
					totalSourcesConsulted: 1,
					totalDecisions: 1,
				},
				truncated: "output_limit",
			},
			turnFacts,
		);

		expect(record()).toMatchObject({
			id: EXECUTION,
			workflowId: EXECUTION,
			userMessage: QUESTION,
			imageUrls: ["uploads/example.png"],
			routingDecision: {
				primaryAgent: "task_planner",
				agentName: "Task Planner",
				confidence: 0.8,
				riskLevel: "low",
			},
			plan: {
				id: "plan-1",
				description: "",
				steps: [{ id: "step-1", status: "pending", order: 1 }],
			},
			stepResults: [
				{
					stepId: "step-1",
					status: "complete",
					response: "Done",
					toolCalls: [
						{
							id: "tc-step-1-0",
							name: "draw",
							args: undefined,
							result: { ok: true },
							status: "success",
							durationMs: 0,
							mcpAppResourceUri: "ui://example/app",
						},
					],
					durationMs: 0,
				},
			],
			approvalHistory: [],
			variables: {},
			status: "complete",
			startedAt: started.toISOString(),
			finalResponse: ANSWER,
			truncated: "output_limit",
			apiBilling: { resetAt: null },
			sourcesUsed: ["doc-1"],
		});
		expect(answer()).toMatchObject({
			role: "assistant",
			content: ANSWER,
			streamStatus: "completed",
		});
	});

	it("saves a stopped turn with the text it had shown", async () => {
		const turnFacts = facts();
		turnFacts.answerText = "Partial answer";
		await save({ type: "completed", status: "cancelled" }, turnFacts);
		expect(record()).toMatchObject({
			status: "cancelled",
			finalResponse: "Partial answer",
		});
		expect(answer()).toMatchObject({
			streamStatus: "cancelled",
			cancelledAt: expect.any(String),
		});
	});

	it("saves a stopped turn with nothing shown as the chat's stop wording", async () => {
		await save({ type: "completed", status: "cancelled" });
		expect(record()?.finalResponse).toBe("Workflow was cancelled by user.");
	});

	it("saves a failed turn as its error", async () => {
		await save({ type: "error", message: "The model failed" });
		expect(record()).toMatchObject({
			status: "error",
			error: "The model failed",
			finalResponse: "Error: The model failed",
		});
		expect(answer()).toMatchObject({ streamStatus: "error" });
	});

	it("saves a rejected turn as the chat's stop wording", async () => {
		await save({ type: "error", error: "The plan was rejected" });
		expect(record()?.finalResponse).toBe(
			"Workflow stopped before any steps were completed.",
		);
	});

	it("saves nothing for a usage-limit refusal, as the chat saves nothing", async () => {
		await save({
			type: "error",
			message: "Limit reached",
			code: "AI_USAGE_LIMIT_EXCEEDED",
		});
		expect(store.saves).toBe(0);
	});

	it("saves an empty success as the chat's completion wording", async () => {
		await save({ type: "completed", status: "completed" });
		expect(record()?.finalResponse).toBe("Execution completed.");
	});
});
