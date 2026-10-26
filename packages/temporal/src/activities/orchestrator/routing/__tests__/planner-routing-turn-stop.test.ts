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
import {
	type AgentRow,
	agentRow,
	matchesAgentWhere,
} from "../../delegation/__tests__/registered-agent-fixtures";

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
	getRoutingSystemPrompt: vi.fn((input: unknown) => JSON.stringify(input)),
	getTaskPlanningSystemPrompt: vi.fn((input: unknown) =>
		JSON.stringify(input),
	),
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

	it("records its routing model call against the chat, and none without one", async () => {
		const { getAiModel } = await import("../../utils/model-selector");
		await analyzeAndRoute({
			...routingInput(false),
			conversationId: "conv-1",
			frameId: "frame-1",
		});
		await analyzeAndRoute(routingInput(false));

		const calls = vi.mocked(getAiModel).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[0][5]).toEqual({
			callPurpose: "routing",
			conversationId: "conv-1",
			frameId: "frame-1",
		});
		expect(calls[1][5]).toEqual({ callPurpose: "routing" });
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

	it("records its planning model call against the chat, and none without one", async () => {
		const { getAiModel } = await import("../../utils");
		await createTaskPlan({
			...planInput(false),
			conversationId: "conv-1",
			frameId: "frame-1",
		});
		await createTaskPlan(planInput(false));

		const calls = vi.mocked(getAiModel).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[0][5]).toEqual({
			callPurpose: "planning",
			conversationId: "conv-1",
			frameId: "frame-1",
		});
		expect(calls[1][5]).toEqual({ callPurpose: "planning" });
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

describe("explicit-agent database fallback precedence", () => {
	const system = agentRow();
	const org = agentRow({
		id: "example-org-row",
		agentId: "example-org-agent",
		scope: "ORGANIZATION",
		organizationId: TURN_SCOPE.organizationId,
	});
	const own = agentRow({
		id: "example-user-row",
		agentId: "example-user-agent",
		scope: "USER",
		userId: TURN_SCOPE.userId,
	});

	function setRows(rows: AgentRow[]) {
		h.registeredAgentFindMany.mockImplementation(
			async ({ where, select }) =>
				rows
					.filter((row) => matchesAgentWhere(row, where))
					.map((row) =>
						select
							? Object.fromEntries(
									Object.entries(row).filter(
										([key]) => select[key],
									),
								)
							: row,
					),
		);
	}
	async function route(
		organizationId: string | null = TURN_SCOPE.organizationId,
	) {
		return analyzeAndRoute({
			...routingInput(false),
			organizationId: organizationId ?? undefined,
			message: "Use example-generalist agent to summarize the plan",
		});
	}
	it.each([false, true])(
		"prefers SYSTEM for colliding names (org first=%s)",
		async (orgFirst) => {
			setRows(orgFirst ? [org, system] : [system, org]);
			expect(await route()).toHaveProperty(
				"primaryAgent",
				system.agentId,
			);
		},
	);
	it.each([
		{
			endpoint: { metadata: { protocols: [] } },
			scenario: "self workspace registration",
			agentId: "fabric-workspace-assistant",
			name: "example-self",
			displayName: "Fabric",
			requestedName: "fabric",
			enabledAgentIds: undefined,
			available: false,
		},
		{
			endpoint: { metadata: { protocols: [] } },
			scenario: "self legacy registration",
			agentId: "fabric-ai",
			name: "example-self",
			displayName: "Fabric",
			requestedName: "fabric",
			enabledAgentIds: undefined,
			available: false,
		},
		{
			scenario: "inline sidekick registration",
			agentId: "sidekick",
			name: "sidekick",
			displayName: "Sidekick",
			requestedName: "sidekick",
			endpoint: { deploymentUrl: "", metadata: { protocols: [] } },
			enabledAgentIds: undefined,
			available: false,
		},
		{
			scenario: "built-in without a URL",
			agentId: system.agentId,
			name: system.name,
			displayName: system.displayName,
			requestedName: system.name,
			endpoint: { deploymentUrl: "" },
			enabledAgentIds: undefined,
			available: false,
		},
		{
			scenario: "built-in without A2A",
			agentId: system.agentId,
			name: system.name,
			displayName: system.displayName,
			requestedName: system.name,
			endpoint: { metadata: { protocols: ["HTTP"] } },
			enabledAgentIds: undefined,
			available: false,
		},
		{
			scenario: "disabled built-in",
			agentId: system.agentId,
			name: system.name,
			displayName: system.displayName,
			requestedName: system.name,
			enabledAgentIds: [org.agentId],
			available: false,
		},
		{
			scenario: "empty enabled list",
			agentId: system.agentId,
			name: system.name,
			displayName: system.displayName,
			requestedName: system.name,
			enabledAgentIds: [],
			available: false,
		},
		{
			endpoint: { metadata: { protocols: ["a2A"] } },
			scenario: "active enabled built-in",
			agentId: system.agentId,
			name: system.name,
			displayName: system.displayName,
			requestedName: system.name,
			enabledAgentIds: [system.agentId, org.agentId],
			available: true,
		},
	])(
		"suppresses member look-alikes for an $scenario",
		async ({
			agentId,
			name,
			displayName,
			requestedName,
			enabledAgentIds,
			available,
			endpoint,
		}) => {
			const builtIn = {
				...system,
				agentId,
				name,
				displayName,
				...endpoint,
			};
			const lookAlike = {
				...org,
				name: requestedName,
				displayName: requestedName,
			};
			const unrelated = {
				...org,
				agentId: "example-unrelated-agent",
				name: "example-unrelated",
				displayName: "Example unrelated",
			};
			setRows([lookAlike, builtIn, unrelated]);
			h.searchAvailableAgents.mockResolvedValue({
				results: [
					lookAlike,
					...(available ? [builtIn] : []),
					unrelated,
				].map((row) => ({
					agentId: row.agentId,
					name: row.name,
					displayName: row.displayName,
					description: `Example description for ${row.agentId}`,
					confidence: 0.99,
					matchReason: "Example semantic match",
					skills: [],
				})),
				totalAgentsSearched: 3,
				durationMs: 1,
			});
			const message = `Use ${requestedName} agent to summarize the plan`;
			const decision = await analyzeAndRoute({
				...routingInput(false),
				message,
				enabledAgentIds,
				prioritizedAgentIds: [lookAlike.agentId],
			});
			expect(decision.primaryAgent).toBe(
				available ? builtIn.agentId : "researcher",
			);
			expect(
				decision.matchedAgents?.map((agent) => agent.agentId),
			).toEqual([
				...(available ? [builtIn.agentId] : []),
				unrelated.agentId,
			]);
			const routerCall = h.generateText.mock.calls[0][0];
			expect(routerCall.instructions).not.toContain(lookAlike.agentId);
			expect(routerCall.prompt).not.toContain(lookAlike.agentId);
			if (!available) {
				expect(routerCall.instructions).not.toContain(
					"USER REQUESTED AGENT",
				);
			}
			h.generateText.mockResolvedValue({
				text: JSON.stringify([
					{
						id: "step-1",
						description: "Summarize the plan",
						capability: "llm",
					},
				]),
			});
			await createTaskPlan({
				message,
				routingDecision: decision,
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				executionMode: "save_reuse",
			});
			const plannerCall = h.generateText.mock.calls[1][0];
			expect(plannerCall.instructions).not.toContain(lookAlike.agentId);
			expect(plannerCall.prompt).not.toContain(lookAlike.agentId);
			expect(plannerCall.instructions).toContain(unrelated.agentId);
		},
	);
	it.each([false, true])(
		"uses only exact matches for a two-character request (exact SYSTEM=%s)",
		async (exactSystem) => {
			const builtIn = {
				...system,
				name: exactSystem ? "qa" : "example-qa-helper",
				displayName: "Example QA helper",
			};
			const member = {
				...org,
				name: "example-qa-member",
				displayName: "Example QA member",
			};
			setRows([member, builtIn]);
			h.searchAvailableAgents.mockResolvedValue({
				results: [member, builtIn].map((row) => ({
					agentId: row.agentId,
					name: row.name,
					displayName: row.displayName,
					description: "Example agent",
					confidence: 0.99,
					matchReason: "Example match",
					skills: [],
				})),
				totalAgentsSearched: 2,
				durationMs: 1,
			});
			const decision = await analyzeAndRoute({
				...routingInput(false),
				message: "Use qa agent to summarize the plan",
			});
			expect(decision.primaryAgent).toBe(
				exactSystem ? system.agentId : "researcher",
			);
			expect(
				decision.matchedAgents?.map((agent) => agent.agentId),
			).toEqual([org.agentId, system.agentId]);
			expect(h.generateText.mock.calls[0][0].instructions).toContain(
				org.agentId,
			);
		},
	);
	it("prefers an exact two-character member name over a SYSTEM substring", async () => {
		const builtIn = {
			...system,
			name: "example-qa-helper",
			displayName: "Example QA helper",
		};
		const member = { ...org, name: "qa", displayName: "Example QA member" };
		setRows([builtIn, member]);
		const decision = await analyzeAndRoute({
			...routingInput(false),
			message: "Use qa agent to summarize the plan",
		});
		expect(decision.primaryAgent).toBe(member.agentId);
	});
	it("prefers SYSTEM name over a member exact agentId", async () => {
		setRows([system, { ...org, agentId: system.name }]);
		expect(await route()).toHaveProperty("primaryAgent", system.agentId);
	});
	it("prefers the DB SYSTEM winner over the first semantic name match", async () => {
		setRows([org, system]);
		h.searchAvailableAgents.mockResolvedValue({
			results: [org, system].map((row) => ({
				agentId: row.agentId,
				name: row.name,
				displayName: row.displayName,
				description: "Example agent",
				confidence: row.scope === "SYSTEM" ? 0.8 : 0.99,
				matchReason: "Example semantic match",
				skills: [],
			})),
			totalAgentsSearched: 2,
			durationMs: 1,
		});
		expect(await route()).toHaveProperty("primaryAgent", system.agentId);
		expect(h.registeredAgentFindMany).toHaveBeenCalled();
	});
	it("does not force a semantic USER row excluded by the authoritative non-org DB query", async () => {
		setRows([
			{
				...own,
				agentId: system.name,
				organizationId: "example-org",
			},
		]);
		h.searchAvailableAgents.mockResolvedValue({
			results: [
				{
					agentId: system.name,
					name: system.name,
					displayName: system.displayName,
					description: "Example agent",
					confidence: 0.99,
					matchReason: "Example semantic match",
					skills: [],
				},
			],
			totalAgentsSearched: 1,
			durationMs: 1,
		});
		expect(await route(null)).toHaveProperty("primaryAgent", "researcher");
	});

	it.each([false, true])(
		"suppresses semantic look-alikes of a STALE SYSTEM cuga_generalist (prioritized=%s)",
		async (prioritized) => {
			const staleSystem = {
				...system,
				agentId: "cuga_generalist",
				name: "cuga_generalist",
				status: "STALE",
			};
			const lookAlikes = [
				{ ...org, name: "cuga_generalist" },
				{
					...org,
					agentId: "example-display-agent",
					name: "example-other",
					displayName: "Prefix CUGA_GENERALIST agent",
				},
				{
					...org,
					agentId: "example-cuga_generalist-member",
					name: "example-other",
				},
			];
			const activeSystem = {
				...system,
				id: "example-active-system-row",
				agentId: "example-cuga_generalist-system",
				name: "example-system-substring",
				displayName: "Example SYSTEM substring",
			};
			setRows([staleSystem, activeSystem, ...lookAlikes]);
			h.searchAvailableAgents.mockResolvedValue({
				results: [
					...lookAlikes,
					activeSystem,
					{
						...org,
						agentId: "example-unrelated-agent",
						name: "example-unrelated",
						displayName: "Example unrelated",
					},
				].map((row) => ({
					agentId: row.agentId,
					name: row.name,
					displayName: row.displayName,
					description: "Example agent",
					confidence: 0.99,
					matchReason: "Example semantic match",
					skills: [],
				})),
				totalAgentsSearched: 5,
				durationMs: 1,
			});
			const decision = await analyzeAndRoute({
				...routingInput(false),
				message: "Use cuga_generalist agent to summarize the plan",
				...(prioritized
					? {
							prioritizedAgentIds: lookAlikes.map(
								(row) => row.agentId,
							),
						}
					: {}),
			});
			expect(decision.primaryAgent).toBe("researcher");
			expect(
				decision.matchedAgents?.map((agent) => agent.agentId),
			).toEqual([activeSystem.agentId, "example-unrelated-agent"]);
			const modelCall = h.generateText.mock.calls[0][0];
			for (const row of lookAlikes) {
				expect(modelCall.instructions).not.toContain(row.agentId);
				expect(modelCall.prompt).not.toContain(row.agentId);
			}
			expect(modelCall.instructions).toContain("example-unrelated-agent");
			expect(modelCall.instructions).not.toContain(
				"USER REQUESTED AGENT",
			);
		},
	);
	it("prefers SYSTEM cuga_generalist over an exact ORGANIZATION cuga name", async () => {
		setRows([
			{ ...org, name: "cuga" },
			{ ...system, agentId: "cuga_generalist", name: "cuga_generalist" },
		]);
		expect(
			await analyzeAndRoute({
				...routingInput(false),
				message: "Use cuga agent to summarize the plan",
			}),
		).toHaveProperty("primaryAgent", "cuga_generalist");
	});

	it("prefers SYSTEM displayName over a member exact agentId", async () => {
		setRows([
			{ ...org, agentId: system.name },
			{ ...system, name: "example-other-name", displayName: system.name },
		]);
		expect(await route()).toHaveProperty("primaryAgent", system.agentId);
	});
	it("prefers SYSTEM task_planner substring over exact member planner", async () => {
		setRows([
			{ ...system, name: "task_planner", displayName: "Task Planner" },
			{ ...org, name: "planner" },
		]);
		expect(
			await analyzeAndRoute({
				...routingInput(false),
				message: "Use planner agent to summarize the plan",
			}),
		).toHaveProperty("primaryAgent", system.agentId);
	});
	it("breaks exact agentId and name ties within SYSTEM by age", async () => {
		setRows([
			system,
			{
				...system,
				id: "example-newer-row",
				agentId: system.name,
				createdAt: new Date("2026-02-01"),
			},
		]);
		expect(await route()).toHaveProperty("primaryAgent", system.agentId);
	});

	it("prefers a SYSTEM substring over an exact member name", async () => {
		setRows([
			{
				...system,
				name: "prefix-example-generalist",
				displayName: "A generalist",
			},
			org,
		]);
		expect(await route()).toHaveProperty("primaryAgent", system.agentId);
	});
	it("prefers SYSTEM among substring matches", async () => {
		setRows([
			{ ...org, name: "prefix-example-generalist" },
			{ ...system, name: "prefix-example-generalist" },
		]);
		expect(await route()).toHaveProperty("primaryAgent", system.agentId);
	});
	it("breaks name ties by oldest createdAt then id", async () => {
		setRows([
			{
				...system,
				id: "example-0",
				agentId: "example-newer",
				createdAt: new Date("2026-02-01"),
			},
			{ ...system, id: "example-z", agentId: "example-oldest-z" },
			{ ...system, id: "example-a", agentId: "example-oldest-a" },
		]);
		expect(await route()).toHaveProperty(
			"primaryAgent",
			"example-oldest-a",
		);
	});
	it("keeps the organization tenant arm exclusive when only members match", async () => {
		setRows([
			own,
			{
				...own,
				id: "example-foreign-user-row",
				agentId: "example-foreign-user-agent",
				userId: "example-other-user",
			},
			{
				...org,
				id: "example-foreign-org-row",
				agentId: "example-foreign-org-agent",
				organizationId: "example-other-org",
				createdAt: new Date("2025-01-01"),
			},
			org,
		]);
		expect(await route()).toHaveProperty("primaryAgent", org.agentId);
	});
	it("keeps the no-organization USER arm restricted to the caller with organizationId null", async () => {
		setRows([
			org,
			{
				...own,
				id: "example-foreign-user-row",
				agentId: "example-foreign-user-agent",
				userId: "example-other-user",
				createdAt: new Date("2025-01-01"),
			},
			{
				...own,
				id: "example-org-user-row",
				agentId: "example-org-user-agent",
				organizationId: "example-org",
				createdAt: new Date("2025-02-01"),
			},
			own,
		]);
		expect(await route(null)).toHaveProperty("primaryAgent", own.agentId);
	});
});
