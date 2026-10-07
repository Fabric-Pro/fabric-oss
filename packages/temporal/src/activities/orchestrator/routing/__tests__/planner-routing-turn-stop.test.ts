/**
 * Advisor Stop on a Planner chat (`save_reuse`): the routing and planning
 * activities.
 *
 * In a turn (`turnScope`, run inside the turn's dispatch guard the way the
 * worker's interceptor runs it):
 *   - `analyzeAndRoute` and `createTaskPlan` heartbeat for their whole run, so
 *     Temporal can deliver a Stop to them (it only does so on a heartbeat);
 *   - `analyzeAndRoute` hands the scope to its tool, agent and integration
 *     lookups, and a stop from the agent-capability lookup leaves the
 *     activity instead of being logged and routed around;
 *   - the workflow lookup rethrows a stop from its embeddings instead of
 *     falling back to keyword scoring.
 * Without a turn each of these keeps its previous behaviour.
 */

import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	searchAvailableTools: vi.fn(),
	searchAvailableAgents: vi.fn(),
	searchAvailableIntegrations: vi.fn(),
	searchAvailableWorkflows: vi.fn(),
	getAgentCapabilities: vi.fn(),
	generateText: vi.fn(),
	generateEmbedding: vi.fn(),
	generateEmbeddings: vi.fn(),
	workflowFindMany: vi.fn(),
	registeredAgentFindMany: vi.fn(),
	checkDispatchable: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: h.checkDispatchable,
	db: {
		registeredAgent: {
			findFirst: vi.fn().mockResolvedValue(null),
			findMany: h.registeredAgentFindMany,
		},
		agent: { findMany: vi.fn(async () => []) },
		mCPConfig: { findMany: vi.fn().mockResolvedValue([]) },
		workflow: { findMany: h.workflowFindMany },
	},
}));

vi.mock("@repo/ai", () => ({
	generateText: h.generateText,
	getAIModelWithMetadata: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
}));

vi.mock("../../utils/model-selector", () => ({
	getAiModel: vi.fn(async () => ({ id: "example-model" })),
}));

vi.mock("../../utils", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getAiModel: vi.fn(async () => ({ id: "example-model" })),
}));

vi.mock("../../../prompts", () => ({
	getRoutingSystemPrompt: vi.fn(() => "Route the task."),
	getTaskPlanningSystemPrompt: vi.fn(() => "Plan the task."),
}));

vi.mock("../../delegation/agent-capabilities", () => ({
	getAgentCapabilities: h.getAgentCapabilities,
}));

vi.mock("../../tools", () => ({
	detectMissingIntegrations: vi.fn(async () => ({
		hasMissingIntegrations: false,
		missingIntegrations: [],
	})),
	detectRequiredConnectionsWithRegistrySearch: vi.fn(async () => ({
		requiredConnections: [],
		hasRequiredConnections: false,
	})),
	fetchToolsFromServerIds: vi.fn(async () => []),
	getFabricAiTools: vi.fn(() => []),
	searchAvailableAgents: h.searchAvailableAgents,
	searchAvailableIntegrations: h.searchAvailableIntegrations,
	searchAvailableTools: h.searchAvailableTools,
	searchAvailableWorkflows: h.searchAvailableWorkflows,
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: h.generateEmbedding,
	generateEmbeddings: h.generateEmbeddings,
}));

import { createTaskPlan } from "../../planning/create-task-plan";
import { searchAvailableWorkflows as realSearchAvailableWorkflows } from "../../tools/search-workflows";
import { runWithTurnDispatch } from "../../turn-dispatch";
import { analyzeAndRoute } from "../analyze-and-route";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

function turnStopped() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn turn-example-1 may not make another model request",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

/** Runs `fn` the way the worker runs a turn-scoped activity. */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
	return runWithTurnDispatch(TURN_SCOPE, fn);
}

function routingInput(withTurn: boolean) {
	return {
		message: "Summarize the launch plan",
		history: [],
		userId: TURN_SCOPE.userId,
		organizationId: TURN_SCOPE.organizationId,
		...(withTurn ? { turnScope: TURN_SCOPE } : {}),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	h.checkDispatchable.mockResolvedValue({ ok: true });
	h.searchAvailableTools.mockResolvedValue({
		results: [],
		totalToolsSearched: 0,
		durationMs: 1,
	});
	h.searchAvailableAgents.mockResolvedValue({
		results: [],
		totalAgentsSearched: 0,
		durationMs: 1,
	});
	h.searchAvailableIntegrations.mockResolvedValue({
		results: [],
		totalIntegrationsSearched: 0,
		durationMs: 1,
	});
	h.searchAvailableWorkflows.mockResolvedValue({
		results: [],
		totalWorkflowsSearched: 0,
		durationMs: 1,
	});
	h.generateText.mockResolvedValue({
		text: JSON.stringify({
			primaryAgent: "researcher",
			confidence: 0.8,
			reasoning: "A research task",
			riskLevel: "low",
			suggestedStrategy: "agent",
		}),
	});
	h.getAgentCapabilities.mockResolvedValue(null);
	h.registeredAgentFindMany.mockResolvedValue([]);
});

describe("analyzeAndRoute in a Planner turn", () => {
	it("hands the turn scope to the tool, agent and integration lookups", async () => {
		await inTurn(() => analyzeAndRoute(routingInput(true)));

		expect(h.searchAvailableTools).toHaveBeenCalledWith(
			expect.objectContaining({ turnScope: TURN_SCOPE }),
		);
		expect(h.searchAvailableAgents).toHaveBeenCalledWith(
			expect.objectContaining({ turnScope: TURN_SCOPE }),
		);
		expect(h.searchAvailableIntegrations).toHaveBeenCalledWith(
			expect.objectContaining({ turnScope: TURN_SCOPE }),
		);
	});

	it("sends no scope to the lookups without a turn", async () => {
		await analyzeAndRoute(routingInput(false));

		expect(h.searchAvailableTools.mock.calls[0]?.[0]).not.toHaveProperty(
			"turnScope",
		);
		expect(h.searchAvailableAgents.mock.calls[0]?.[0]).not.toHaveProperty(
			"turnScope",
		);
	});

	it("rethrows a stop from the agent-capability lookup instead of routing around it", async () => {
		const stop = turnStopped();
		h.getAgentCapabilities.mockRejectedValue(stop);

		await expect(
			inTurn(() => analyzeAndRoute(routingInput(true))),
		).rejects.toBe(stop);
	});

	it("still routes around a failed agent-capability lookup without a turn", async () => {
		h.getAgentCapabilities.mockRejectedValue(turnStopped());

		const decision = await analyzeAndRoute(routingInput(false));

		expect(decision.primaryAgent).toBe("researcher");
	});

	it("still routes around a non-stop capability failure in a turn", async () => {
		h.getAgentCapabilities.mockRejectedValue(new Error("card unavailable"));

		const decision = await inTurn(() =>
			analyzeAndRoute(routingInput(true)),
		);

		expect(decision.primaryAgent).toBe("researcher");
	});

	it("heartbeats in a turn, so a Stop can reach it, and not without one", async () => {
		const withTurn = new MockActivityEnvironment();
		let turnBeats = 0;
		withTurn.on("heartbeat", () => {
			turnBeats++;
		});
		await withTurn.run(() =>
			inTurn(() => analyzeAndRoute(routingInput(true))),
		);
		expect(turnBeats).toBeGreaterThan(0);

		const noTurn = new MockActivityEnvironment();
		let legacyBeats = 0;
		noTurn.on("heartbeat", () => {
			legacyBeats++;
		});
		await noTurn.run(() => analyzeAndRoute(routingInput(false)));
		expect(legacyBeats).toBe(0);
	});
});

describe("createTaskPlan in a Planner turn", () => {
	function planInput(withTurn: boolean) {
		return {
			message: "Summarize the launch plan",
			routingDecision: {
				primaryAgent: "researcher",
				secondaryAgents: [],
				suggestedStrategy: "agent" as const,
				riskLevel: "low" as const,
				riskFactors: [],
				confidence: 0.8,
				reasoning: "A research task",
				useMcpDirect: false,
				matchedMcpTools: [],
			},
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			executionMode: "save_reuse" as const,
			...(withTurn ? { turnScope: TURN_SCOPE } : {}),
		};
	}

	beforeEach(() => {
		h.generateText.mockResolvedValue({
			text: JSON.stringify([
				{
					id: "step-1",
					description: "Summarize the launch plan",
					capability: "llm",
				},
			]),
		});
	});

	it("heartbeats in a turn, so a Stop can reach it, and not without one", async () => {
		const withTurn = new MockActivityEnvironment();
		let turnBeats = 0;
		withTurn.on("heartbeat", () => {
			turnBeats++;
		});
		await withTurn.run(() => inTurn(() => createTaskPlan(planInput(true))));
		expect(turnBeats).toBeGreaterThan(0);

		const noTurn = new MockActivityEnvironment();
		let legacyBeats = 0;
		noTurn.on("heartbeat", () => {
			legacyBeats++;
		});
		await noTurn.run(() => createTaskPlan(planInput(false)));
		expect(legacyBeats).toBe(0);
	});

	it("leaves on a refused planning request rather than planning a fallback step", async () => {
		const stop = turnStopped();
		h.generateText.mockRejectedValue(stop);

		await expect(
			inTurn(() => createTaskPlan(planInput(true))),
		).rejects.toBe(stop);
	});
});

describe("searchAvailableWorkflows inside a turn's dispatch guard", () => {
	const WORKFLOW = {
		id: "wf-1",
		name: "Weekly report",
		description: "Builds the weekly report",
		triggerType: "MANUAL",
		status: "PUBLISHED",
	};

	beforeEach(() => {
		h.workflowFindMany.mockResolvedValue([WORKFLOW]);
		h.generateEmbeddings.mockResolvedValue({ embeddings: [[0.1, 0.2]] });
	});

	it("rethrows a stop from the query embedding instead of scoring by keywords", async () => {
		const stop = turnStopped();
		h.generateEmbedding.mockRejectedValue(stop);

		await expect(
			inTurn(() =>
				realSearchAvailableWorkflows({
					query: "run the weekly report",
					userId: TURN_SCOPE.userId,
					organizationId: TURN_SCOPE.organizationId,
				}),
			),
		).rejects.toBe(stop);
	});

	it("rethrows a stop from the workflow embeddings", async () => {
		const stop = turnStopped();
		h.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
		h.generateEmbeddings.mockRejectedValue(stop);

		await expect(
			inTurn(() =>
				realSearchAvailableWorkflows({
					query: "run the weekly report",
					userId: TURN_SCOPE.userId,
					organizationId: TURN_SCOPE.organizationId,
				}),
			),
		).rejects.toBe(stop);
	});

	it("still falls back to keyword scoring without a turn", async () => {
		h.generateEmbedding.mockRejectedValue(turnStopped());

		const result = await realSearchAvailableWorkflows({
			query: "run the weekly report",
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
		});

		expect(result.totalWorkflowsSearched).toBe(1);
	});
});
